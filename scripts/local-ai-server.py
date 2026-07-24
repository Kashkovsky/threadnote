#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import re
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Lock
from typing import Any
from urllib.parse import parse_qs, urlsplit


MAX_REQUEST_BYTES = 1_048_576
MAX_OUTPUT_TOKENS = 512
SERVICE_ID = "threadnote-local-ai"
inference_lock = Lock()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Threadnote loopback llama.cpp adapter")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--launch-id", required=True)
    parser.add_argument("--log", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--model-id", required=True)
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--token-file", required=True)
    return parser.parse_args()


args = parse_args()
if args.host not in {"127.0.0.1", "::1", "localhost"}:
    raise SystemExit("Threadnote local AI only binds to an explicit loopback host.")

log_file = open(args.log, "a", encoding="utf-8", buffering=1)
sys.stdout = log_file
sys.stderr = log_file

with open(args.token_file, encoding="utf-8") as token_file:
    access_token = token_file.read().strip()
if not re.fullmatch(r"[A-Za-z0-9_-]{43}", access_token):
    raise SystemExit("Threadnote local AI access token has an unsupported shape.")

from llama_cpp import Llama


class Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        parsed_url = urlsplit(self.path)
        if parsed_url.path == "/health":
            challenge = parse_qs(parsed_url.query).get("challenge", [""])[0]
            if not re.fullmatch(r"[A-Za-z0-9_-]{16,128}", challenge):
                self.respond(
                    {"error": {"message": "A valid health challenge is required.", "type": "invalid_request"}},
                    status=400,
                )
                return
            pid = os.getpid()
            self.respond(
                {
                    "model": args.model_id,
                    "launchId": args.launch_id,
                    "pid": pid,
                    "proof": health_proof(challenge, pid),
                    "service": SERVICE_ID,
                    "status": "ok",
                }
            )
            return
        if parsed_url.path == "/v1/models":
            if not self.authorized():
                return
            self.respond(
                {
                    "data": [{"id": args.model_id, "object": "model", "owned_by": "threadnote-local"}],
                    "object": "list",
                }
            )
            return
        self.send_error(404)

    def do_POST(self) -> None:
        if self.path != "/v1/chat/completions":
            self.send_error(404)
            return
        if not self.authorized():
            return
        try:
            request = self.read_request()
            response_format = request.get("response_format")
            if isinstance(response_format, dict) and response_format.get("type") == "json_schema":
                json_schema = response_format.get("json_schema")
                if isinstance(json_schema, dict) and isinstance(json_schema.get("schema"), dict):
                    response_format = {"schema": json_schema["schema"], "type": "json_object"}
            messages = request.get("messages")
            if not isinstance(messages, list):
                raise ValueError("messages must be an array")
            requested_tokens = request.get(
                "max_tokens",
                request.get("max_completion_tokens", request.get("max_output_tokens", 256)),
            )
            with inference_lock:
                completion = model.create_chat_completion(
                    messages=messages,
                    max_tokens=min(max(1, int(requested_tokens)), MAX_OUTPUT_TOKENS),
                    response_format=response_format,
                    temperature=0,
                )
            self.respond(completion)
        except Exception as error:
            self.respond(
                {
                    "error": {
                        "message": str(error),
                        "type": "threadnote_local_ai_error",
                    }
                },
                status=500,
            )

    def read_request(self) -> dict[str, Any]:
        content_length = int(self.headers.get("content-length", "0"))
        if content_length <= 0 or content_length > MAX_REQUEST_BYTES:
            raise ValueError(f"request body must be between 1 and {MAX_REQUEST_BYTES} bytes")
        parsed = json.loads(self.rfile.read(content_length))
        if not isinstance(parsed, dict):
            raise ValueError("request body must be a JSON object")
        return parsed

    def log_message(self, format: str, *values: object) -> None:
        return

    def authorized(self) -> bool:
        supplied = self.headers.get("authorization", "")
        expected = f"Bearer {access_token}"
        if hmac.compare_digest(supplied, expected):
            return True
        self.respond(
            {"error": {"message": "Authentication is required.", "type": "authentication_error"}},
            status=401,
        )
        return False

    def respond(self, body: object, status: int = 200) -> None:
        payload = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


def health_proof(challenge: str, pid: int) -> str:
    payload = "\0".join(
        [challenge, SERVICE_ID, args.model_id, str(pid), args.launch_id, access_token]
    ).encode()
    return hashlib.sha256(payload).hexdigest()


# Bind before loading the model. This reserves the port when multiple agent
# processes notice a stopped service at the same time; the winner loads Gemma,
# while the others observe the listener and wait for /health.
server = ThreadingHTTPServer((args.host, args.port), Handler)
model = Llama(model_path=args.model, n_ctx=4096, n_gpu_layers=-1, verbose=False)
print(f"Threadnote local AI ready at http://{args.host}:{args.port}/v1", flush=True)
server.serve_forever()
