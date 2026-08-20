// Command canary proves that frozen-v1, terminal-v2, and query-v3 privacy-safe synthetic
// traces traverse the public gateway and become queryable in Grafana Cloud Tempo.
package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	commonpb "go.opentelemetry.io/proto/otlp/common/v1"
	tracepb "go.opentelemetry.io/proto/otlp/trace/v1"
	"google.golang.org/protobuf/encoding/protowire"
	"google.golang.org/protobuf/proto"
)

const (
	canaryVersion  = "0.0.0-canary"
	defaultTimeout = 75 * time.Second
	maxResponse    = 1 << 20
)

type config struct {
	gatewayURL     *url.URL
	tempoURL       *url.URL
	tempoUser      string
	tempoToken     string
	pollInterval   time.Duration
	queryDeadline  time.Duration
	requestTimeout time.Duration
}

type canaryIDs struct {
	traceID   []byte
	spanID    []byte
	sessionID string
}

type canaryTrace struct {
	ids           canaryIDs
	queryEvent    string
	schemaVersion uint64
}

type canaryStringAttribute struct {
	key   string
	value string
}

func main() {
	ctx, cancel := context.WithTimeout(context.Background(), defaultTimeout)
	defer cancel()
	configuration, err := configFromEnvironment()
	if err == nil {
		client := &http.Client{CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		}}
		err = run(ctx, configuration, client, time.Now, randomIDs)
	}
	if err != nil {
		_, _ = fmt.Fprintln(os.Stderr, "threadnote-telemetry-canary:", err)
		os.Exit(1)
	}
	_, _ = fmt.Fprintln(os.Stdout, "threadnote-telemetry-canary: v1, v2, and v3 checkpoint/completion traces stored")
}

func configFromEnvironment() (config, error) {
	gatewayURL, err := productionURL("THREADNOTE_TELEMETRY_CANARY_GATEWAY_URL", "/v1/traces")
	if err != nil {
		return config{}, err
	}
	tempoURL, err := productionURL("THREADNOTE_TELEMETRY_CANARY_TEMPO_URL", "/tempo")
	if err != nil {
		return config{}, err
	}
	tempoUser := os.Getenv("THREADNOTE_TELEMETRY_CANARY_TEMPO_USER")
	if tempoUser == "" {
		return config{}, errors.New("THREADNOTE_TELEMETRY_CANARY_TEMPO_USER is required")
	}
	for _, character := range tempoUser {
		if character < '0' || character > '9' {
			return config{}, errors.New("Tempo user must be the numeric instance ID")
		}
	}
	tempoToken := os.Getenv("THREADNOTE_TELEMETRY_CANARY_TEMPO_TOKEN")
	if tempoToken == "" || strings.ContainsAny(tempoToken, "\r\n") {
		return config{}, errors.New("THREADNOTE_TELEMETRY_CANARY_TEMPO_TOKEN is required")
	}
	return config{
		gatewayURL:     gatewayURL,
		tempoURL:       tempoURL,
		tempoUser:      tempoUser,
		tempoToken:     tempoToken,
		pollInterval:   3 * time.Second,
		queryDeadline:  60 * time.Second,
		requestTimeout: 10 * time.Second,
	}, nil
}

func productionURL(environment, requiredPath string) (*url.URL, error) {
	value := os.Getenv(environment)
	parsed, err := url.ParseRequestURI(value)
	if err != nil || parsed.Scheme != "https" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || parsed.Host == "" {
		return nil, fmt.Errorf("%s must be an HTTPS URL without credentials, query, or fragment", environment)
	}
	if parsed.EscapedPath() != requiredPath {
		return nil, fmt.Errorf("%s must end at %s", environment, requiredPath)
	}
	hostname := strings.ToLower(parsed.Hostname())
	if parsed.Port() != "" && parsed.Port() != "443" {
		return nil, fmt.Errorf("%s must use the default HTTPS port", environment)
	}
	switch environment {
	case "THREADNOTE_TELEMETRY_CANARY_GATEWAY_URL":
		if hostname != "telemetry.threadnote.io" && hostname != "threadnote-telemetry.fly.dev" {
			return nil, errors.New("gateway URL must use the Threadnote production or Fly preflight host")
		}
	case "THREADNOTE_TELEMETRY_CANARY_TEMPO_URL":
		if hostname == "grafana.net" || !strings.HasSuffix(hostname, ".grafana.net") {
			return nil, errors.New("Tempo URL must use the stack's grafana.net host")
		}
	}
	return parsed, nil
}

func run(
	ctx context.Context,
	configuration config,
	client *http.Client,
	now func() time.Time,
	newIDs func() (canaryIDs, error),
) error {
	started := now().UTC()
	traces := make([]canaryTrace, 0, 4)
	for _, target := range []struct {
		queryEvent    string
		schemaVersion uint64
	}{
		{schemaVersion: 1},
		{schemaVersion: 2},
		{queryEvent: "checkpoint", schemaVersion: 3},
		{queryEvent: "completion", schemaVersion: 3},
	} {
		ids, err := newIDs()
		if err != nil {
			return errors.New("generate random identifiers")
		}
		trace := canaryTrace{ids: ids, queryEvent: target.queryEvent, schemaVersion: target.schemaVersion}
		if err := postTrace(ctx, configuration, client, buildEnvelope(trace, started)); err != nil {
			return fmt.Errorf("schema v%d: %w", target.schemaVersion, err)
		}
		traces = append(traces, trace)
	}
	deadline := started.Add(configuration.queryDeadline)
	pending := append([]canaryTrace(nil), traces...)
	for {
		nextPending := pending[:0]
		for _, trace := range pending {
			stored, err := queryTrace(ctx, configuration, client, trace, started, now().UTC())
			if err != nil {
				return fmt.Errorf("schema v%d: %w", trace.schemaVersion, err)
			}
			if !stored {
				nextPending = append(nextPending, trace)
			}
		}
		pending = nextPending
		if len(pending) == 0 {
			return nil
		}
		if !now().Before(deadline) {
			return errors.New("trace was accepted but did not become queryable before the deadline")
		}
		timer := time.NewTimer(configuration.pollInterval)
		select {
		case <-ctx.Done():
			timer.Stop()
			return errors.New("canary deadline exceeded")
		case <-timer.C:
		}
	}
}

func postTrace(ctx context.Context, configuration config, client *http.Client, payload []byte) error {
	requestContext, cancel := context.WithTimeout(ctx, configuration.requestTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(requestContext, http.MethodPost, configuration.gatewayURL.String(), bytes.NewReader(payload))
	if err != nil {
		return errors.New("build gateway request")
	}
	request.Header.Set("Content-Type", "application/x-protobuf")
	response, err := client.Do(request)
	if err != nil {
		return errors.New("gateway request failed")
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, maxResponse))
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("gateway returned status %d", response.StatusCode)
	}
	return nil
}

func queryTrace(
	ctx context.Context,
	configuration config,
	client *http.Client,
	trace canaryTrace,
	started time.Time,
	now time.Time,
) (bool, error) {
	queryURL := *configuration.tempoURL
	queryURL.Path = strings.TrimSuffix(queryURL.Path, "/") + "/api/v2/traces/" + hex.EncodeToString(trace.ids.traceID)
	parameters := queryURL.Query()
	parameters.Set("start", strconv.FormatInt(started.Add(-time.Minute).Unix(), 10))
	parameters.Set("end", strconv.FormatInt(now.Add(time.Minute).Unix(), 10))
	queryURL.RawQuery = parameters.Encode()
	requestContext, cancel := context.WithTimeout(ctx, configuration.requestTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(requestContext, http.MethodGet, queryURL.String(), nil)
	if err != nil {
		return false, errors.New("build Tempo query")
	}
	request.Header.Set("Accept", "application/protobuf")
	request.SetBasicAuth(configuration.tempoUser, configuration.tempoToken)
	response, err := client.Do(request)
	if err != nil {
		return false, errors.New("Tempo query failed")
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNotFound {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, maxResponse))
		return false, nil
	}
	if response.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, maxResponse))
		return false, fmt.Errorf("Tempo returned status %d", response.StatusCode)
	}
	limited := io.LimitReader(response.Body, maxResponse+1)
	body, err := io.ReadAll(limited)
	if err != nil || len(body) > maxResponse {
		return false, errors.New("invalid Tempo response")
	}
	mediaType, _, err := mime.ParseMediaType(response.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/protobuf" {
		return false, errors.New("Tempo returned an unexpected media type")
	}
	state, err := inspectStoredTrace(body, trace)
	if err != nil {
		return false, errors.New("Tempo returned a trace outside the canary contract")
	}
	return state == storedTraceMatched, nil
}

type storedTraceState uint8

const (
	storedTracePending storedTraceState = iota
	storedTraceMatched
)

func inspectStoredTrace(body []byte, canary canaryTrace) (storedTraceState, error) {
	ids := canary.ids
	tracePayload, present, err := tempoTracePayload(body)
	if err != nil {
		return storedTracePending, err
	}
	if !present {
		return storedTracePending, nil
	}
	trace := &tracepb.TracesData{}
	if err := (proto.UnmarshalOptions{DiscardUnknown: false}).Unmarshal(tracePayload, trace); err != nil {
		return storedTracePending, errors.New("invalid Tempo trace protobuf")
	}
	if len(trace.ResourceSpans) == 0 {
		return storedTracePending, nil
	}
	for _, resourceSpans := range trace.ResourceSpans {
		if resourceSpans == nil {
			continue
		}
		resource := resourceSpans.GetResource()
		if resource == nil || !hasStringAttribute(resource.Attributes, "service.name", "threadnote") ||
			!hasStringAttribute(resource.Attributes, "service.version", canaryVersion) ||
			!hasStringAttribute(resource.Attributes, "session.id", ids.sessionID) ||
			!hasIntAttribute(resource.Attributes, "threadnote.telemetry.schema_version", canary.schemaVersion) {
			continue
		}
		for _, scopeSpans := range resourceSpans.ScopeSpans {
			if scopeSpans == nil {
				continue
			}
			for _, span := range scopeSpans.Spans {
				if span == nil {
					continue
				}
				if bytes.Equal(span.TraceId, ids.traceID) && bytes.Equal(span.SpanId, ids.spanID) &&
					span.Name == "threadnote.anonymous-diagnostic" && storedSpanMatchesVersion(span, canary) {
					return storedTraceMatched, nil
				}
			}
		}
	}
	return storedTracePending, errors.New("stored trace does not match the canary")
}

func tempoTracePayload(payload []byte) ([]byte, bool, error) {
	var tracePayload []byte
	seen := make(map[protowire.Number]struct{}, 4)
	for len(payload) > 0 {
		number, wireType, tagLength := protowire.ConsumeTag(payload)
		if tagLength < 0 {
			return nil, false, errors.New("invalid Tempo response tag")
		}
		expectedType, admitted := map[protowire.Number]protowire.Type{
			1: protowire.BytesType,
			2: protowire.BytesType,
			3: protowire.VarintType,
			4: protowire.BytesType,
		}[number]
		if !admitted || wireType != expectedType {
			return nil, false, errors.New("invalid Tempo response field")
		}
		if _, duplicate := seen[number]; duplicate {
			return nil, false, errors.New("duplicate Tempo response field")
		}
		seen[number] = struct{}{}
		payload = payload[tagLength:]

		var consumed int
		switch wireType {
		case protowire.BytesType:
			value, length := protowire.ConsumeBytes(payload)
			consumed = length
			if number == 1 && length >= 0 {
				tracePayload = append([]byte(nil), value...)
			}
		case protowire.VarintType:
			_, consumed = protowire.ConsumeVarint(payload)
		}
		if consumed < 0 {
			return nil, false, errors.New("invalid Tempo response value")
		}
		payload = payload[consumed:]
	}
	_, present := seen[1]
	return tracePayload, present, nil
}

func hasStringAttribute(attributes []*commonpb.KeyValue, key string, expected string) bool {
	for _, attribute := range attributes {
		if attribute == nil || attribute.GetKey() != key || attribute.Value == nil {
			continue
		}
		value, ok := attribute.Value.Value.(*commonpb.AnyValue_StringValue)
		if ok {
			return value.StringValue == expected
		}
	}
	return false
}

func hasAttribute(attributes []*commonpb.KeyValue, key string) bool {
	for _, attribute := range attributes {
		if attribute != nil && attribute.Key == key && attribute.Value != nil {
			return true
		}
	}
	return false
}

func hasIntAttribute(attributes []*commonpb.KeyValue, key string, expected uint64) bool {
	for _, attribute := range attributes {
		if attribute == nil || attribute.GetKey() != key || attribute.Value == nil {
			continue
		}
		value, ok := attribute.Value.Value.(*commonpb.AnyValue_IntValue)
		if ok {
			return value.IntValue >= 0 && uint64(value.IntValue) == expected
		}
	}
	return false
}

func storedSpanMatchesVersion(span *tracepb.Span, canary canaryTrace) bool {
	if !hasIntAttribute(span.Attributes, "threadnote.duration_ms", 1) {
		return false
	}
	if canary.schemaVersion == 3 && !hasIntAttribute(span.Attributes, "threadnote.phase.elapsed_ms", 1) {
		return false
	}
	for _, expected := range canaryStringAttributes(canary) {
		if !hasStringAttribute(span.Attributes, expected.key, expected.value) {
			return false
		}
	}
	return canary.schemaVersion == 1 || canary.schemaVersion == 2 || canary.schemaVersion == 3
}

func randomIDs() (canaryIDs, error) {
	traceID, err := randomNonzeroBytes(16)
	if err != nil {
		return canaryIDs{}, err
	}
	spanID, err := randomNonzeroBytes(8)
	if err != nil {
		return canaryIDs{}, err
	}
	session := make([]byte, 16)
	if _, err := rand.Read(session); err != nil {
		return canaryIDs{}, err
	}
	return canaryIDs{traceID: traceID, spanID: spanID, sessionID: "tns_" + hex.EncodeToString(session)}, nil
}

func randomNonzeroBytes(length int) ([]byte, error) {
	for attempt := 0; attempt < 3; attempt++ {
		value := make([]byte, length)
		if _, err := rand.Read(value); err != nil {
			return nil, err
		}
		if !bytes.Equal(value, make([]byte, length)) {
			return value, nil
		}
	}
	return nil, errors.New("random source returned an invalid zero identifier")
}

func buildEnvelope(canary canaryTrace, timestamp time.Time) []byte {
	ids := canary.ids
	resource := message(1, keyValue("service.name", stringValue("threadnote")))
	resource = append(resource, message(1, keyValue("service.version", stringValue(canaryVersion)))...)
	resource = append(resource, message(1, keyValue("session.id", stringValue(ids.sessionID)))...)
	resource = append(resource, message(1, keyValue("threadnote.session.scope", stringValue("invocation")))...)
	resource = append(resource, message(1, keyValue("threadnote.telemetry.schema_version", intValue(canary.schemaVersion)))...)
	scope := message(1, []byte("threadnote"))
	span := bytesField(1, ids.traceID)
	span = append(span, bytesField(2, ids.spanID)...)
	span = append(span, message(5, []byte("threadnote.anonymous-diagnostic"))...)
	span = append(span, varintField(6, 1)...)
	nanoseconds := uint64(timestamp.UnixNano())
	span = append(span, fixed64Field(7, nanoseconds)...)
	span = append(span, fixed64Field(8, nanoseconds+1_000_000)...)
	for _, attribute := range canaryStringAttributes(canary) {
		span = append(span, message(9, keyValue(attribute.key, stringValue(attribute.value)))...)
	}
	span = append(span, message(9, keyValue("threadnote.duration_ms", intValue(1)))...)
	if canary.schemaVersion == 3 {
		span = append(span, message(9, keyValue("threadnote.phase.elapsed_ms", intValue(1)))...)
	}
	span = append(span, message(15, varintField(3, 1))...)
	scopeSpans := message(1, scope)
	scopeSpans = append(scopeSpans, message(2, span)...)
	resourceSpans := message(1, resource)
	resourceSpans = append(resourceSpans, message(2, scopeSpans)...)
	return message(1, resourceSpans)
}

func canaryStringAttributes(canary canaryTrace) []canaryStringAttribute {
	schemaVersion := canary.schemaVersion
	attributes := []canaryStringAttribute{
		{"threadnote.component", "cli"},
		{"threadnote.runtime.architecture", "synthetic"},
		{"threadnote.runtime.platform", "synthetic"},
		{"threadnote.runtime.version", canaryVersion},
		{"threadnote.outcome", "success"},
	}
	if schemaVersion == 1 {
		attributes = append(attributes,
			canaryStringAttribute{"threadnote.event", "completion"},
			canaryStringAttribute{"threadnote.operation", "health"},
		)
	} else if schemaVersion == 2 {
		attributes = append(attributes,
			canaryStringAttribute{"threadnote.event", "lifecycle"},
			canaryStringAttribute{"threadnote.operation", "graph-build"},
			canaryStringAttribute{"threadnote.graph.build_kind", "dirty"},
			canaryStringAttribute{"threadnote.graph.materialization_mode", "full"},
			canaryStringAttribute{"threadnote.graph.fallback_reason", "resolution-surface-changed"},
			canaryStringAttribute{"threadnote.graph.resolution_closure", "full"},
			canaryStringAttribute{"threadnote.graph.efficiency_class", "critical-amplification-full"},
		)
		attributes = append(attributes, []canaryStringAttribute{
			{"threadnote.graph.changed_files_bucket", "2^1"},
			{"threadnote.graph.deleted_files_bucket", "0"},
			{"threadnote.graph.delta_files_bucket", "2^1"},
			{"threadnote.graph.extracted_files_bucket", "2^1"},
			{"threadnote.graph.reused_files_bucket", "2^10"},
			{"threadnote.graph.staged_files_bucket", "2^10"},
			{"threadnote.graph.total_files_bucket", "2^10"},
			{"threadnote.graph.cached_fact_replay_bytes_bucket", "2^30"},
			{"threadnote.graph.changed_fact_bytes_bucket", "2^10"},
			{"threadnote.graph.final_fact_bytes_bucket", "2^30"},
			{"threadnote.graph.rewrite_amplification_bucket", "2^9"},
			{"threadnote.graph.fact_replay_amplification_bucket", "2^20"},
		}...)
	} else if schemaVersion == 3 {
		event := "completion"
		if canary.queryEvent == "checkpoint" {
			event = "checkpoint"
		}
		attributes = append(attributes, []canaryStringAttribute{
			{"threadnote.event", event},
			{"threadnote.operation", "inspect_code_graph"},
			{"threadnote.phase", "graph.query.execute"},
			{"threadnote.phase.outcome", "success"},
			{"threadnote.graph.request_kind", "inspect.query"},
			{"threadnote.graph.request_scope", "local"},
			{"threadnote.graph.snapshot_selection", "active"},
			{"threadnote.graph.snapshot_freshness", "deferred"},
			{"threadnote.graph.snapshot_files_bucket", "2^10"},
			{"threadnote.graph.snapshot_symbols_bucket", "2^12"},
			{"threadnote.graph.snapshot_edges_bucket", "2^13"},
		}...)
	}
	return attributes
}

func keyValue(key string, anyValue []byte) []byte {
	result := message(1, []byte(key))
	return append(result, message(2, anyValue)...)
}

func stringValue(value string) []byte { return message(1, []byte(value)) }
func intValue(value uint64) []byte    { return varintField(3, value) }
func message(field uint64, value []byte) []byte {
	result := varint((field << 3) | 2)
	result = append(result, varint(uint64(len(value)))...)
	return append(result, value...)
}
func bytesField(field uint64, value []byte) []byte { return message(field, value) }
func varintField(field, value uint64) []byte {
	return append(varint(field<<3), varint(value)...)
}
func fixed64Field(field, value uint64) []byte {
	result := varint((field << 3) | 1)
	for shift := uint(0); shift < 64; shift += 8 {
		result = append(result, byte(value>>shift))
	}
	return result
}
func varint(value uint64) []byte {
	result := make([]byte, 0, 10)
	for value >= 0x80 {
		result = append(result, byte(value)|0x80)
		value >>= 7
	}
	return append(result, byte(value))
}
