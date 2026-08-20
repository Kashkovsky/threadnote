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

	collectortracepb "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	"google.golang.org/protobuf/proto"
)

func TestCanaryPostsAndProvesFrozenV1V2AndCurrentV3(t *testing.T) {
	started := time.Unix(1_700_000_000, 0)
	traces := canaryTestTraces()
	byTraceID := make(map[string]canaryTrace, len(traces))
	for _, trace := range traces {
		byTraceID[hex.EncodeToString(trace.ids.traceID)] = trace
	}
	var mu sync.Mutex
	postCount, queryCount := 0, 0
	server := httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		switch {
		case request.URL.Path == "/v1/traces":
			if request.Method != http.MethodPost || request.Header.Get("Content-Type") != "application/x-protobuf" {
				t.Fatalf("invalid gateway request")
			}
			body, _ := io.ReadAll(request.Body)
			mu.Lock()
			current := postCount
			postCount++
			mu.Unlock()
			if current >= len(traces) || !bytes.Equal(body, buildEnvelope(traces[current], started)) {
				t.Fatal("unexpected canary envelope")
			}
			response.WriteHeader(http.StatusOK)
		case strings.HasPrefix(request.URL.Path, "/tempo/api/v2/traces/"):
			user, token, ok := request.BasicAuth()
			if !ok || user != "12345" || token != "read-only" || request.Header.Get("Accept") != "application/protobuf" {
				t.Fatal("invalid Tempo authentication or content negotiation")
			}
			traceID := strings.TrimPrefix(request.URL.Path, "/tempo/api/v2/traces/")
			trace, exists := byTraceID[traceID]
			if !exists {
				t.Fatal("query did not use a generated trace ID")
			}
			mu.Lock()
			queryCount++
			mu.Unlock()
			response.Header().Set("Content-Type", "application/protobuf")
			_, _ = response.Write(tempoResponse(buildEnvelope(trace, started)))
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
	configuration := config{
		gatewayURL: &gateway, tempoURL: &tempo, tempoUser: "12345", tempoToken: "read-only",
		pollInterval: time.Millisecond, queryDeadline: time.Second, requestTimeout: time.Second,
	}
	if err := run(context.Background(), configuration, server.Client(), func() time.Time { return started }, idSequence(traces)); err != nil {
		t.Fatal(err)
	}
	if postCount != 4 || queryCount != 4 {
		t.Fatalf("posts = %d, queries = %d, want 4 each", postCount, queryCount)
	}
}

func TestGraphCanaryEnvelopesCarryTheCompleteTerminalSurface(t *testing.T) {
	for _, schemaVersion := range []uint64{2, 3} {
		trace := fixedTrace(schemaVersion, canaryTraceGraph)
		request := decodeCanaryEnvelope(t, trace)
		resource := request.ResourceSpans[0].Resource
		if resource == nil || !hasIntAttribute(resource.Attributes, "threadnote.telemetry.schema_version", schemaVersion) {
			t.Fatalf("v%d canary resource did not declare its schema version", schemaVersion)
		}
		span := request.ResourceSpans[0].ScopeSpans[0].Spans[0]
		for _, key := range []string{
			"threadnote.graph.build_kind",
			"threadnote.graph.cached_fact_replay_bytes_bucket",
			"threadnote.graph.changed_fact_bytes_bucket",
			"threadnote.graph.changed_files_bucket",
			"threadnote.graph.deleted_files_bucket",
			"threadnote.graph.delta_files_bucket",
			"threadnote.graph.efficiency_class",
			"threadnote.graph.extracted_files_bucket",
			"threadnote.graph.fact_replay_amplification_bucket",
			"threadnote.graph.fallback_reason",
			"threadnote.graph.final_fact_bytes_bucket",
			"threadnote.graph.materialization_mode",
			"threadnote.graph.resolution_closure",
			"threadnote.graph.reused_files_bucket",
			"threadnote.graph.rewrite_amplification_bucket",
			"threadnote.graph.staged_files_bucket",
			"threadnote.graph.total_files_bucket",
		} {
			if !hasAttribute(span.Attributes, key) {
				t.Fatalf("v%d graph canary is missing %s", schemaVersion, key)
			}
		}
	}
}

func TestV3CanaryEnvelopeCarriesTheAutomaticUpdateSurface(t *testing.T) {
	request := decodeCanaryEnvelope(t, fixedTrace(3, canaryTraceAutoUpdate))
	span := request.ResourceSpans[0].ScopeSpans[0].Spans[0]
	if !hasStringAttribute(span.Attributes, "threadnote.operation", "auto-update-worker") ||
		!hasStringAttribute(span.Attributes, "threadnote.auto_update.result", "updated") ||
		!hasBoolAttribute(span.Attributes, "threadnote.auto_update.repair_required", false) {
		t.Fatal("v3 canary is missing the automatic update result surface")
	}
}

func decodeCanaryEnvelope(t *testing.T, trace canaryTrace) *collectortracepb.ExportTraceServiceRequest {
	t.Helper()
	request := &collectortracepb.ExportTraceServiceRequest{}
	if err := proto.Unmarshal(buildEnvelope(trace, time.Unix(1_700_000_000, 0)), request); err != nil {
		t.Fatal(err)
	}
	if len(request.ResourceSpans) != 1 || len(request.ResourceSpans[0].ScopeSpans) != 1 ||
		len(request.ResourceSpans[0].ScopeSpans[0].Spans) != 1 {
		t.Fatal("canary did not contain exactly one span")
	}
	return request
}

func TestCanaryFailsClosedOnAcceptedButMissingOrWrongTrace(t *testing.T) {
	traces := canaryTestTraces()
	v1 := traces[0]
	tests := []struct {
		name      string
		queryBody []byte
		queryCode int
		wantError string
	}{
		{name: "missing", queryCode: http.StatusNotFound, wantError: "did not become queryable"},
		{name: "empty while pending", queryCode: http.StatusOK, wantError: "did not become queryable"},
		{name: "wrong payload", queryCode: http.StatusOK, queryBody: tempoResponse(buildEnvelope(canaryTrace{ids: canaryIDs{traceID: bytes.Repeat([]byte{9}, 16), spanID: v1.ids.spanID, sessionID: v1.ids.sessionID}, kind: canaryTraceCompletion, schemaVersion: 1}, time.Now())), wantError: "outside the canary contract"},
		{name: "wrong span", queryCode: http.StatusOK, queryBody: tempoResponse(buildEnvelope(canaryTrace{ids: canaryIDs{traceID: v1.ids.traceID, spanID: bytes.Repeat([]byte{9}, 8), sessionID: v1.ids.sessionID}, kind: canaryTraceCompletion, schemaVersion: 1}, time.Now())), wantError: "outside the canary contract"},
		{name: "wrong media type", queryCode: http.StatusOK, queryBody: tempoResponse(buildEnvelope(v1, time.Now())), wantError: "unexpected media type"},
		{name: "unauthorized", queryCode: http.StatusUnauthorized, wantError: "Tempo returned status 401"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
				if request.URL.Path == "/v1/traces" {
					response.WriteHeader(http.StatusOK)
					return
				}
				if test.name != "wrong media type" && test.queryCode == http.StatusOK {
					response.Header().Set("Content-Type", "application/protobuf")
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
			if test.name == "missing" || test.name == "empty while pending" {
				queryDeadline = 0
			}
			configuration := config{
				gatewayURL: &gateway, tempoURL: &tempo, tempoUser: "12345", tempoToken: "read-only",
				pollInterval: time.Millisecond, queryDeadline: queryDeadline, requestTimeout: time.Second,
			}
			err := run(context.Background(), configuration, server.Client(), func() time.Time { return now }, idSequence(traces))
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
	trace := fixedTrace(1, canaryTraceCompletion)
	for _, body := range [][]byte{{0xff}, {0x0a, 0xff}, message(1, []byte{0xff})} {
		if _, err := inspectStoredTrace(body, trace); err == nil {
			t.Fatalf("accepted malformed response %x", body)
		}
	}
}

func TestStoredTraceParserTreatsOnlyAnEmptyTraceAsPending(t *testing.T) {
	trace := fixedTrace(1, canaryTraceCompletion)
	for _, body := range [][]byte{nil, message(1, nil)} {
		state, err := inspectStoredTrace(body, trace)
		if err != nil || state != storedTracePending {
			t.Fatalf("state = %d, error = %v, want pending", state, err)
		}
	}
	state, err := inspectStoredTrace(tempoResponse(buildEnvelope(trace, time.Now())), trace)
	if err != nil || state != storedTraceMatched {
		t.Fatalf("state = %d, error = %v, want matched", state, err)
	}
}

func fixedTrace(schemaVersion uint64, kind canaryTraceKind) canaryTrace {
	marker := byte(schemaVersion)
	if kind == canaryTraceAutoUpdate {
		marker = 4
	}
	sessionID := "tns_000102030405060708090a0b0c0d0e0f"
	if schemaVersion == 2 {
		sessionID = "tns_101112131415161718191a1b1c1d1e1f"
	} else if schemaVersion == 3 && kind == canaryTraceGraph {
		sessionID = "tns_202122232425262728292a2b2c2d2e2f"
	} else if schemaVersion == 3 {
		sessionID = "tns_303132333435363738393a3b3c3d3e3f"
	}
	return canaryTrace{
		ids: canaryIDs{
			traceID:   bytes.Repeat([]byte{marker}, 16),
			spanID:    bytes.Repeat([]byte{marker + 2}, 8),
			sessionID: sessionID,
		},
		kind:          kind,
		schemaVersion: schemaVersion,
	}
}

func canaryTestTraces() []canaryTrace {
	return []canaryTrace{
		fixedTrace(1, canaryTraceCompletion),
		fixedTrace(2, canaryTraceGraph),
		fixedTrace(3, canaryTraceGraph),
		fixedTrace(3, canaryTraceAutoUpdate),
	}
}

func idSequence(traces []canaryTrace) func() (canaryIDs, error) {
	index := 0
	return func() (canaryIDs, error) {
		if index >= len(traces) {
			return canaryIDs{}, io.EOF
		}
		ids := traces[index].ids
		index++
		return ids, nil
	}
}

func tempoResponse(exportEnvelope []byte) []byte {
	// ExportTraceServiceRequest and Tempo's Trace both encode ResourceSpans as
	// field 1, so the complete export envelope is the Trace message body.
	return message(1, exportEnvelope)
}
