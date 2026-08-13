package main

import (
	"bytes"
	"context"
	"encoding/hex"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestCanaryPostsExactTraceThenProvesStorage(t *testing.T) {
	ids := fixedIDs()
	storedResponse := tempoResponse(buildEnvelope(ids, time.Unix(1_700_000_000, 0)))
	var mu sync.Mutex
	queryCount := 0
	server := httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		switch {
		case request.URL.Path == "/v1/traces":
			if request.Method != http.MethodPost || request.Header.Get("Content-Type") != "application/x-protobuf" {
				t.Fatalf("invalid gateway request")
			}
			body, _ := io.ReadAll(request.Body)
			if !bytes.Equal(body, buildEnvelope(ids, time.Unix(1_700_000_000, 0))) {
				t.Fatal("unexpected canary envelope")
			}
			response.WriteHeader(http.StatusOK)
		case strings.HasPrefix(request.URL.Path, "/tempo/api/v2/traces/"):
			user, token, ok := request.BasicAuth()
			if !ok || user != "12345" || token != "read-only" || request.Header.Get("Accept") != "application/protobuf" {
				t.Fatal("invalid Tempo authentication or content negotiation")
			}
			if !strings.HasSuffix(request.URL.Path, hex.EncodeToString(ids.traceID)) {
				t.Fatal("query did not use the generated trace ID")
			}
			mu.Lock()
			queryCount++
			current := queryCount
			mu.Unlock()
			if current == 1 {
				response.WriteHeader(http.StatusNotFound)
				return
			}
			response.Header().Set("Content-Type", "application/protobuf")
			_, _ = response.Write(storedResponse)
		default:
			t.Fatalf("unexpected request path %s", request.URL.Path)
		}
	}))
	defer server.Close()

	base, _ := url.Parse(server.URL)
	gateway := *base
	gateway.Path = "/v1/traces"
	tempo := *base
	tempo.Path = "/tempo"
	now := time.Unix(1_700_000_000, 0)
	configuration := config{
		gatewayURL: &gateway, tempoURL: &tempo, tempoUser: "12345", tempoToken: "read-only",
		pollInterval: time.Millisecond, queryDeadline: time.Second, requestTimeout: time.Second,
	}
	if err := run(context.Background(), configuration, server.Client(), func() time.Time { return now }, func() (canaryIDs, error) { return ids, nil }); err != nil {
		t.Fatal(err)
	}
	if queryCount != 2 {
		t.Fatalf("queries = %d, want 2", queryCount)
	}
}

func TestCanaryFailsClosedOnAcceptedButMissingOrWrongTrace(t *testing.T) {
	ids := fixedIDs()
	tests := []struct {
		name      string
		queryBody []byte
		queryCode int
		wantError string
	}{
		{name: "missing", queryCode: http.StatusNotFound, wantError: "did not become queryable"},
		{name: "wrong payload", queryCode: http.StatusOK, queryBody: tempoResponse(buildEnvelope(canaryIDs{traceID: bytes.Repeat([]byte{9}, 16), spanID: ids.spanID, sessionID: ids.sessionID}, time.Now())), wantError: "outside the canary contract"},
		{name: "unauthorized", queryCode: http.StatusUnauthorized, wantError: "Tempo returned status 401"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
				if request.URL.Path == "/v1/traces" {
					response.WriteHeader(http.StatusOK)
					return
				}
				response.WriteHeader(test.queryCode)
				_, _ = response.Write(test.queryBody)
			}))
			defer server.Close()
			base, _ := url.Parse(server.URL)
			gateway, tempo := *base, *base
			gateway.Path, tempo.Path = "/v1/traces", "/tempo"
			now := time.Now()
			queryDeadline := 2 * time.Millisecond
			if test.name == "missing" {
				queryDeadline = 0
			}
			configuration := config{
				gatewayURL: &gateway, tempoURL: &tempo, tempoUser: "12345", tempoToken: "read-only",
				pollInterval: time.Millisecond, queryDeadline: queryDeadline, requestTimeout: time.Second,
			}
			err := run(context.Background(), configuration, server.Client(), func() time.Time { return now }, func() (canaryIDs, error) { return ids, nil })
			if err == nil || !strings.Contains(err.Error(), test.wantError) {
				t.Fatalf("error = %v, want %q", err, test.wantError)
			}
		})
	}
}

func TestEnvironmentRejectsNonProductionOrCredentialBearingURLs(t *testing.T) {
	t.Setenv("THREADNOTE_TELEMETRY_CANARY_TEMPO_USER", "12345")
	t.Setenv("THREADNOTE_TELEMETRY_CANARY_TEMPO_TOKEN", "read-only")
	t.Setenv("THREADNOTE_TELEMETRY_CANARY_TEMPO_URL", "https://tempo-prod-eu-west-0.grafana.net/tempo")
	for _, gateway := range []string{
		"http://telemetry.threadnote.io/v1/traces",
		"https://user:password@telemetry.threadnote.io/v1/traces",
		"https://telemetry.threadnote.io/other",
		"https://telemetry.threadnote.io/v1/traces?private=value",
		"https://example.com/v1/traces",
		"https://telemetry.threadnote.io:8443/v1/traces",
	} {
		t.Setenv("THREADNOTE_TELEMETRY_CANARY_GATEWAY_URL", gateway)
		if _, err := configFromEnvironment(); err == nil {
			t.Fatalf("accepted %s", gateway)
		}
	}

	t.Setenv("THREADNOTE_TELEMETRY_CANARY_GATEWAY_URL", "https://telemetry.threadnote.io/v1/traces")
	for _, tempo := range []string{
		"https://example.com/tempo",
		"https://grafana.net/tempo",
		"https://tempo-prod-eu-west-0.grafana.net:8443/tempo",
	} {
		t.Setenv("THREADNOTE_TELEMETRY_CANARY_TEMPO_URL", tempo)
		if _, err := configFromEnvironment(); err == nil {
			t.Fatalf("accepted %s", tempo)
		}
	}
}

func TestStoredTraceParserRejectsMalformedProtobuf(t *testing.T) {
	ids := fixedIDs()
	for _, body := range [][]byte{{0xff}, {0x0a, 0xff}, message(1, []byte{0xff})} {
		if validStoredTrace(body, ids) {
			t.Fatalf("accepted malformed response %x", body)
		}
	}
}

func fixedIDs() canaryIDs {
	return canaryIDs{
		traceID:   bytes.Repeat([]byte{1}, 16),
		spanID:    bytes.Repeat([]byte{2}, 8),
		sessionID: "tns_000102030405060708090a0b0c0d0e0f",
	}
}

func tempoResponse(exportEnvelope []byte) []byte {
	request, err := parseMessage(exportEnvelope)
	if err != nil || len(request[1]) != 1 {
		panic("invalid fixture")
	}
	// ExportTraceServiceRequest and Tempo's Trace both encode ResourceSpans as
	// field 1, so the complete export envelope is the Trace message body.
	return message(1, exportEnvelope)
}
