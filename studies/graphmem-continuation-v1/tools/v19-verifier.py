#!/usr/bin/python3
"""Sealed, network-free verifier for the five v19 continuation tasks."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import textwrap


ROOT = Path(__file__).resolve().parents[1]
GO = Path("/opt/homebrew/bin/go")
PYTHONS = {
    "click": ROOT / "verifier" / "environment" / "python" / "bin" / "python",
    "pluggy": ROOT / "verifier" / "environment" / "python" / "bin" / "python",
}
GO_MOD_CACHE = {
    "chi": ROOT / "verifier" / "environment" / "go-mod-cache" / "chi",
    "gin": ROOT / "verifier" / "environment" / "go-mod-cache" / "gin",
    "echo": ROOT / "verifier" / "environment" / "go-mod-cache" / "echo",
}
CLICK_BASE_TEST_SHA256 = "98d79c0e96752d593c76862a23f7ed6e250c3d368fb668e70266f23c542a1785"


def go_command(selector: str) -> Path:
    if selector == "gin":
        return (
            GO_MOD_CACHE[selector]
            / "golang.org"
            / "toolchain@v0.0.1-go1.26.0.darwin-arm64"
            / "bin"
            / "go"
        )
    return GO


def run(command: list[str], cwd: Path, env: dict[str, str]) -> tuple[int, str]:
    completed = subprocess.run(
        command,
        cwd=cwd,
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        timeout=180,
        check=False,
    )
    return completed.returncode, completed.stdout[-4000:]


def python_env(repository: Path) -> dict[str, str]:
    return {
        "HOME": os.environ.get("HOME", "/nonexistent"),
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "NO_COLOR": "1",
        "PATH": "/usr/bin:/bin",
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONNOUSERSITE": "1",
        "PYTHONPATH": str(repository / "src"),
        "TMPDIR": os.environ.get("TMPDIR", "/tmp"),
    }


def go_env(selector: str, temporary: Path) -> dict[str, str]:
    return {
        "CI": "1",
        "GOCACHE": str(temporary / "go-build"),
        "GOMODCACHE": str(GO_MOD_CACHE[selector]),
        "GOPROXY": "off",
        "GOSUMDB": "off",
        "GOTOOLCHAIN": "auto",
        "HOME": str(temporary / "home"),
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "NO_COLOR": "1",
        "PATH": "/opt/homebrew/bin:/usr/bin:/bin",
        "TMPDIR": str(temporary),
    }


def phase_one_check(selector: str, repository: Path, temporary: Path) -> tuple[int, str]:
    if selector == "click":
        test_path = repository / "tests" / "test_utils" / "test_make_default_short_help.py"
        if hashlib.sha256(test_path.read_bytes()).hexdigest() == CLICK_BASE_TEST_SHA256:
            return 0, "phase-one regression not present during calibration"
        return run(
            [
                str(PYTHONS[selector]),
                "-m",
                "pytest",
                "-q",
                "-p",
                "no:cacheprovider",
                "tests/test_utils/test_make_default_short_help.py",
            ],
            repository,
            python_env(repository),
        )
    if selector == "pluggy":
        test_path = repository / "testing" / "test_pluginmanager.py"
        source = test_path.read_text(encoding="utf-8")
        if "test_unregister_plugin_with_multi_hookimpls" not in source:
            return 0, "phase-one regression not present during calibration"
        return run(
            [
                str(PYTHONS[selector]),
                "-m",
                "pytest",
                "-q",
                "-p",
                "no:cacheprovider",
                "testing/test_pluginmanager.py::test_unregister_plugin_with_multi_hookimpls",
            ],
            repository,
            python_env(repository),
        )
    names = {
        "chi": "TestWalkRouteWithHandlerAndSubrouter|TestRoutesHidesMountStub|TestWalkMiddlewaresAcrossGroupAndRoute",
        "gin": "TestIssue4818_",
        "echo": "TestProblemDetailsHTTPErrorHandler_DoesNotMutateSharedProblem",
    }[selector]
    test_file = {
        "chi": repository / "tree_test.go",
        "gin": repository / "routes_test.go",
        "echo": repository / "rfc9457_test.go",
    }[selector]
    marker = names.split("|")[0].rstrip("_")
    if marker not in test_file.read_text(encoding="utf-8"):
        return 0, "phase-one regression not present during calibration"
    return run(
        [str(go_command(selector)), "test", ".", "-run", names, "-count=1"],
        repository,
        go_env(selector, temporary),
    )


def python_hidden(selector: str, repository: Path) -> tuple[int, str]:
    if selector == "click":
        program = r'''
from click.utils import _make_default_short_help as short
cases = [
    ("Compare red vs. blue and green.", 18, "Compare red vs...."),
    ("First sentence. second clause continues", 18, "First sentence...."),
    ("First sentence. Next sentence", 40, "First sentence."),
    ("well-behaved-example", 8, "..."),
    ("alpha beta", 2, "..."),
]
for value, width, expected in cases:
    actual = short(value, width)
    if actual != expected:
        raise AssertionError((value, width, expected, actual))
'''
    else:
        program = r'''
import pluggy
hookspec = pluggy.HookspecMarker("v19")
hookimpl = pluggy.HookimplMarker("v19")
class Spec:
    @hookspec
    def value(self, item): ...
    @hookspec
    def other(self, item): ...
class First:
    @hookimpl
    def value(self, item): return item + 1
    @hookimpl(specname="value")
    def value_alias(self, item): return item + 2
    @hookimpl(specname="value")
    def value_third(self, item): return item + 3
    @hookimpl
    def other(self, item): return item + 4
class Second:
    @hookimpl
    def value(self, item): return item + 10
pm = pluggy.PluginManager("v19")
pm.add_hookspecs(Spec)
first, second = First(), Second()
pm.register(first)
pm.register(second)
callers = pm.get_hookcallers(first)
if callers is None or sorted(c.name for c in callers) != ["other", "value"]:
    raise AssertionError([c.name for c in callers or []])
pm.unregister(first)
if pm.hook.value(item=1) != [11]:
    raise AssertionError(pm.hook.value(item=1))
if pm.hook.other(item=1) != []:
    raise AssertionError(pm.hook.other(item=1))
'''
    return run([str(PYTHONS[selector]), "-c", program], repository, python_env(repository))


GO_PROGRAMS = {
    "chi": r'''
package main
import (
  "fmt"
  "net/http"
  chi "github.com/go-chi/chi/v5"
)
func main() {
  r := chi.NewRouter()
  h := http.HandlerFunc(func(http.ResponseWriter, *http.Request) {})
  r.Route("/catalog", func(cr chi.Router) {
    cr.Route("/items", func(ir chi.Router) { ir.Get("/{sku}", h) })
    cr.Get("/items", h)
  })
  seen := map[string]bool{}
  if err := chi.Walk(r, func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
    seen[method+" "+route] = true
    return nil
  }); err != nil { panic(err) }
  for _, want := range []string{"GET /catalog/items", "GET /catalog/items/{sku}"} {
    if !seen[want] { panic(fmt.Sprintf("missing %s in %#v", want, seen)) }
  }
}
''',
    "gin": r'''
package main
import (
  "net/http"
  "net/http/httptest"
  gin "github.com/gin-gonic/gin"
)
func main() {
  gin.SetMode(gin.TestMode)
  r := gin.New()
  r.HandleMethodNotAllowed = true
  h := func(*gin.Context) {}
  r.OPTIONS("/:x/:y/a/:z", h)
  r.GET("/:x/:y/a/:z", h)
  r.PATCH("/b/:x/:y/c", h)
  r.DELETE("/b/:x/:y/d/:z", h)
  r.GET("/b/:x/:y/e/f", h)
  r.POST("/b/:x/:y/g/:z/h", h)
  r.OPTIONS("/b/:x/:y/g/:z/h", h)
  r.DELETE("/b/cache", h)
  r.GET("/b/customers/:id/g", h)
  r.POST("/b/customers/:id/g", h)
  r.PATCH("/b/customers/:id/g/:leaf", h)
  r.OPTIONS("/b/customers/:id/g/:leaf", h)
  w := httptest.NewRecorder()
  r.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/b/customers/17", nil))
  if w.Code != http.StatusNotFound { panic(w.Code) }
  w = httptest.NewRecorder()
  r.ServeHTTP(w, httptest.NewRequest(http.MethodPatch, "/b/customers/17/g", nil))
  if w.Code != http.StatusMethodNotAllowed || w.Header().Get("Allow") == "" { panic(w.Code) }
}
''',
    "echo": r'''
package main
import (
  "log/slog"
  "net/http"
  "net/http/httptest"
  echo "github.com/labstack/echo/v5"
)
func main() {
  sentinel := &echo.ProblemError{Status: http.StatusConflict, Detail: "duplicate"}
  original := *sentinel
  e := echo.New()
  e.Logger = slog.New(slog.DiscardHandler)
  e.Any("/item", func(c *echo.Context) error { return sentinel })
  e.HTTPErrorHandler = echo.ProblemDetailsHTTPErrorHandler(false)
  for _, method := range []string{http.MethodGet, http.MethodHead, http.MethodGet} {
    rec := httptest.NewRecorder()
    e.ServeHTTP(rec, httptest.NewRequest(method, "/item", nil))
    if rec.Code != http.StatusConflict { panic(rec.Code) }
    if *sentinel != original { panic("shared problem mutated") }
  }
}
''',
}


def go_hidden(selector: str, repository: Path, temporary: Path) -> tuple[int, str]:
    if selector == "gin":
        hidden_repository = temporary / "hidden-gin"
        shutil.copytree(
            repository,
            hidden_repository,
            ignore=shutil.ignore_patterns(".git", ".threadnote-verifier-tmp-*"),
        )
        test_source = textwrap.dedent(GO_PROGRAMS[selector]).lstrip()
        test_source = test_source.replace("package main\nimport (", 'package gin_test\nimport (\n  "testing"', 1)
        test_source = test_source.replace("func main() {", "func TestV19Hidden(t *testing.T) {\n  _ = t", 1)
        (hidden_repository / "v19_hidden_test.go").write_text(test_source, encoding="utf-8")
        return run(
            [str(go_command(selector)), "test", ".", "-run", "^TestV19Hidden$", "-count=1"],
            hidden_repository,
            go_env(selector, temporary),
        )
    module = {
        "chi": ("github.com/go-chi/chi/v5", "v5.0.0"),
        "echo": ("github.com/labstack/echo/v5", "v5.0.0"),
    }[selector]
    hidden = temporary / "hidden"
    hidden.mkdir(parents=True, exist_ok=True)
    (hidden / "go.mod").write_text(
        f"module threadnote-v19-hidden\n\ngo 1.25\n\nrequire {module[0]} {module[1]}\n\nreplace {module[0]} => {repository}\n",
        encoding="utf-8",
    )
    (hidden / "main.go").write_text(textwrap.dedent(GO_PROGRAMS[selector]).lstrip(), encoding="utf-8")
    return run([str(go_command(selector)), "run", "-mod=mod", "."], hidden, go_env(selector, temporary))


def main() -> int:
    if len(sys.argv) not in (2, 3):
        return 2
    selector = sys.argv[1]
    if selector not in {"click", "pluggy", "chi", "gin", "echo"}:
        return 2
    repository = Path(sys.argv[2] if len(sys.argv) == 3 else os.getcwd()).resolve()
    temporary = Path(tempfile.mkdtemp(prefix=f"v19-{selector}-", dir=os.environ.get("TMPDIR", "/tmp")))
    failures: list[str] = []
    try:
        phase_code, phase_output = phase_one_check(selector, repository, temporary)
        if phase_code != 0:
            failures.append(f"phase-one-regression exited {phase_code}: {phase_output[-1000:]}")
        if selector in {"click", "pluggy"}:
            hidden_code, hidden_output = python_hidden(selector, repository)
        else:
            hidden_code, hidden_output = go_hidden(selector, repository, temporary)
        if hidden_code != 0:
            failures.append(f"held-out-contract exited {hidden_code}: {hidden_output[-1000:]}")
    except Exception as exc:
        failures.append(f"verifier exception: {type(exc).__name__}: {exc}")
    finally:
        shutil.rmtree(temporary, ignore_errors=True)
    if failures:
        diagnostic = json.dumps({"completed": True, "failures": failures}, separators=(",", ":"))
        print(f"{selector} verifier failed: {diagnostic}", file=sys.stderr)
        return 1
    print(f"{selector} verifier passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
