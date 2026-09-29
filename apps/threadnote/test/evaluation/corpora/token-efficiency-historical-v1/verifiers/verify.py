#!/usr/bin/env python3
"""Hidden offline behavior checks for the historical token-efficiency corpus."""

from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Callable


def use_source(repository: Path, root_package: bool = False) -> None:
    source = repository if root_package else repository / "src"
    sys.path.insert(0, str(source))


def verify_h11(repository: Path) -> None:
    use_source(repository, root_package=True)
    import h11

    state = h11.Connection(h11.CLIENT)
    state.send(h11.Request(method=b"GET", target=b"/", headers=[(b"Host", b"example.com")]))
    state.send(h11.EndOfMessage())
    state.receive_data(
        b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n"
        b"1  \r\nx\r\n0\r\n\r\n"
    )
    assert isinstance(state.next_event(), h11.Response)
    data = state.next_event()
    assert isinstance(data, h11.Data) and bytes(data.data) == b"x"
    assert isinstance(state.next_event(), h11.EndOfMessage)


def verify_hpack(repository: Path) -> None:
    use_source(repository)
    from hpack import Decoder, Encoder

    def headers():
        return ((f"k{index}", f"v{index}") for index in range(3))

    encoded = Encoder().encode(headers())
    assert Decoder().decode(encoded) == list(headers())


def verify_attrs(repository: Path) -> None:
    use_source(repository)
    import attr

    original = (attr.evolve.__doc__, attr.evolve.__name__, attr.evolve.__qualname__, str(attr.evolve))
    cls = attr.make_class("CorpusRecord", {"value": attr.ib()})
    instance = cls(1)
    assert cls.__replace__ is not attr.evolve
    assert (attr.evolve.__doc__, attr.evolve.__name__, attr.evolve.__qualname__, str(attr.evolve)) == original
    assert instance.__replace__(value=2).value == 2


def verify_click(repository: Path) -> None:
    use_source(repository)
    import click
    from semver import Version

    option = click.Option(["--version"], default=Version(1, 0, 0), show_default=True)
    help_text = option.get_help_record(click.Context(click.Command("cli")))[1]
    assert "[default: 1.0.0]" in help_text

    empty = click.Option(["--empty"], default="", show_default=True)
    empty_help = empty.get_help_record(click.Context(click.Command("cli")))[1]
    assert '[default: ""]' in empty_help


def verify_werkzeug(repository: Path) -> None:
    from mypy import api as mypy_api

    program = """\
from werkzeug import Request, Response

@Request.application
def standalone(request: Request) -> Response:
    return Response()

class Application:
    @Request.application
    def bound(self, request: Request) -> Response:
        return Response()
"""
    previous = os.environ.get("MYPYPATH")
    os.environ["MYPYPATH"] = str(repository / "src")
    try:
        stdout, stderr, status = mypy_api.run(
            [
                "--strict",
                "--config-file=/dev/null",
                "--no-incremental",
                "--cache-dir=/dev/null",
                "--ignore-missing-imports",
                "--disable-error-code=import-untyped",
                "--disable-error-code=override",
                "--disable-error-code=unused-ignore",
                "--disable-error-code=misc",
                "-c",
                program,
            ]
        )
    finally:
        if previous is None:
            os.environ.pop("MYPYPATH", None)
        else:
            os.environ["MYPYPATH"] = previous
    assert status == 0, f"{stdout}\n{stderr}"


def verify_packaging(repository: Path) -> None:
    use_source(repository)
    from packaging.markers import Marker

    expressions = [
        'python_version < "3.10" and ((sys_platform == "linux" or sys_platform == "darwin"))',
        'os_name == "posix" or ((python_version >= "3.12" and platform_machine == "arm64"))',
    ]
    environments = [
        {"python_version": "3.9", "sys_platform": "linux", "os_name": "posix", "platform_machine": "x86_64"},
        {"python_version": "3.12", "sys_platform": "darwin", "os_name": "posix", "platform_machine": "arm64"},
        {"python_version": "3.12", "sys_platform": "linux", "os_name": "nt", "platform_machine": "x86_64"},
    ]
    for expression in expressions:
        marker = Marker(expression)
        reparsed = Marker(str(marker))
        for environment in environments:
            assert reparsed.evaluate(environment) == marker.evaluate(environment)


VERIFIERS: dict[str, Callable[[Path], None]] = {
    "attrs": verify_attrs,
    "click": verify_click,
    "h11": verify_h11,
    "hpack": verify_hpack,
    "packaging": verify_packaging,
    "werkzeug": verify_werkzeug,
}


def main() -> int:
    if len(sys.argv) != 3 or sys.argv[1] not in VERIFIERS:
        print("usage: verify.py <attrs|click|h11|hpack|packaging|werkzeug> <repository>", file=sys.stderr)
        return 2
    repository = Path(sys.argv[2]).resolve()
    if not repository.is_dir():
        print("repository must be an existing directory", file=sys.stderr)
        return 2
    try:
        VERIFIERS[sys.argv[1]](repository)
    except Exception as error:
        print(f"{sys.argv[1]} verifier failed: {error}", file=sys.stderr)
        return 1
    print(f"{sys.argv[1]} verifier passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
