package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/quick"
	"time"

	collectortracepb "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	commonpb "go.opentelemetry.io/proto/otlp/common/v1"
	resourcepb "go.opentelemetry.io/proto/otlp/resource/v1"
	tracepb "go.opentelemetry.io/proto/otlp/trace/v1"
	"google.golang.org/protobuf/encoding/protowire"
	"google.golang.org/protobuf/proto"
)

func TestIngressRejectsRequestsOutsideTheContract(t *testing.T) {
	tests := []struct {
		body        []byte
		contentType string
		encoding    string
		method      string
		target      string
		wantStatus  int
	}{
		{method: http.MethodGet, target: "/other", wantStatus: http.StatusNotFound},
		{method: http.MethodGet, target: "/v1/traces?private=value", wantStatus: http.StatusNotFound},
		{method: http.MethodGet, target: "/v1/traces", wantStatus: http.StatusMethodNotAllowed},
		{body: []byte("{}"), contentType: "application/json", method: http.MethodPost, target: "/v1/traces", wantStatus: http.StatusUnsupportedMediaType},
		{body: []byte{1}, contentType: "application/x-protobuf; charset=binary", method: http.MethodPost, target: "/v1/traces", wantStatus: http.StatusUnsupportedMediaType},
		{body: []byte{1}, contentType: "application/x-protobuf", encoding: "gzip", method: http.MethodPost, target: "/v1/traces", wantStatus: http.StatusUnsupportedMediaType},
		{contentType: "application/x-protobuf", method: http.MethodPost, target: "/v1/traces", wantStatus: http.StatusBadRequest},
	}

	for _, test := range tests {
		handler, handlerError := newGatewayHandler()
		if handlerError != nil {
			t.Fatal(handlerError)
		}
		request := httptest.NewRequest(test.method, test.target, bytes.NewReader(test.body))
		if test.contentType != "" {
			request.Header.Set("Content-Type", test.contentType)
		}
		if test.encoding != "" {
			request.Header.Set("Content-Encoding", test.encoding)
		}
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != test.wantStatus {
			t.Fatalf("%s %s returned %d, want %d", test.method, test.target, response.Code, test.wantStatus)
		}
	}
}

func TestIngressCapsBodiesBeforeCollectorParsing(t *testing.T) {
	handler, handlerError := newGatewayHandler()
	if handlerError != nil {
		t.Fatal(handlerError)
	}
	request := httptest.NewRequest(http.MethodPost, "/v1/traces", bytes.NewReader(make([]byte, maxRequestBytes+1)))
	request.Header.Set("Content-Type", "application/x-protobuf")
	request.ContentLength = -1
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized request returned %d, want %d", response.Code, http.StatusRequestEntityTooLarge)
	}
}

func TestIngressForwardsOnlyProtobufAndStripsInboundMetadata(t *testing.T) {
	type capture struct {
		authorization string
		baggage       string
		body          []byte
		clientIP      string
		traceparent   string
	}
	captured := make(chan capture, 1)
	listener, listenError := net.Listen("tcp", "127.0.0.1:4318")
	if listenError != nil {
		t.Fatal(listenError)
	}
	backend := &http.Server{Handler: http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		body, _ := io.ReadAll(request.Body)
		captured <- capture{
			authorization: request.Header.Get("Authorization"),
			baggage:       request.Header.Get("Baggage"),
			body:          body,
			clientIP:      request.Header.Get("Fly-Client-IP"),
			traceparent:   request.Header.Get("Traceparent"),
		}
		response.Header().Set("Content-Type", "application/x-protobuf")
		response.WriteHeader(http.StatusOK)
	})}
	go func() { _ = backend.Serve(listener) }()
	t.Cleanup(func() { _ = backend.Close() })

	handler, handlerError := newGatewayHandler()
	if handlerError != nil {
		t.Fatal(handlerError)
	}
	payload := validTelemetryPayload(t)
	request := httptest.NewRequest(http.MethodPost, "/v1/traces", bytes.NewReader(payload))
	request.Header.Set("Authorization", "Bearer private")
	request.Header.Set("Baggage", "private=value")
	request.Header.Set("Content-Type", "application/x-protobuf")
	request.Header.Set("Fly-Client-IP", "192.0.2.42")
	request.Header.Set("Traceparent", "00-private")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("valid request returned %d, want %d", response.Code, http.StatusOK)
	}
	if response.Header().Get("Content-Type") != "application/x-protobuf" {
		t.Fatalf("valid response content type = %q", response.Header().Get("Content-Type"))
	}
	if response.Header().Get("Strict-Transport-Security") != "max-age=31536000" || response.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatal("fixed security response headers were not set")
	}

	select {
	case result := <-captured:
		if result.authorization != "" || result.baggage != "" || result.clientIP != "" || result.traceparent != "" {
			t.Fatalf("private inbound headers reached Collector: %#v", result)
		}
		if !bytes.Equal(result.body, payload) {
			t.Fatalf("forwarded payload = %v, want %v", result.body, payload)
		}
	case <-time.After(time.Second):
		t.Fatal("Collector did not receive the request")
	}
}

func validTelemetryPayload(t *testing.T) []byte {
	t.Helper()
	request := validTelemetryRequest()
	payload, err := (proto.MarshalOptions{Deterministic: true}).Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	return payload
}

func validTelemetryRequest() *collectortracepb.ExportTraceServiceRequest {
	intValue := func(value int64) *commonpb.AnyValue {
		return &commonpb.AnyValue{Value: &commonpb.AnyValue_IntValue{IntValue: value}}
	}
	attribute := func(key string, value *commonpb.AnyValue) *commonpb.KeyValue {
		return &commonpb.KeyValue{Key: key, Value: value}
	}
	request := &collectortracepb.ExportTraceServiceRequest{ResourceSpans: []*tracepb.ResourceSpans{{
		Resource: &resourcepb.Resource{Attributes: []*commonpb.KeyValue{
			attribute("service.name", stringAnyValue("threadnote")),
			attribute("service.version", stringAnyValue("4.2.2")),
			attribute("session.id", stringAnyValue("tns_000102030405060708090a0b0c0d0e0f")),
			attribute("threadnote.session.scope", stringAnyValue("invocation")),
			attribute("threadnote.telemetry.schema_version", intValue(1)),
		}},
		ScopeSpans: []*tracepb.ScopeSpans{{
			Scope: &commonpb.InstrumentationScope{Name: "threadnote"},
			Spans: []*tracepb.Span{{
				TraceId: bytes.Repeat([]byte{1}, 16), SpanId: bytes.Repeat([]byte{2}, 8),
				Name: "threadnote.anonymous-diagnostic", Kind: tracepb.Span_SPAN_KIND_INTERNAL,
				StartTimeUnixNano: 1, EndTimeUnixNano: 2,
				Attributes: []*commonpb.KeyValue{
					attribute("threadnote.component", stringAnyValue("cli")),
					attribute("threadnote.event", stringAnyValue("completion")),
					attribute("threadnote.operation", stringAnyValue("health")),
					attribute("threadnote.runtime.architecture", stringAnyValue("arm64")),
					attribute("threadnote.runtime.platform", stringAnyValue("darwin")),
					attribute("threadnote.runtime.version", stringAnyValue("1.3.14")),
					attribute("threadnote.duration_ms", intValue(1)),
					attribute("threadnote.outcome", stringAnyValue("success")),
				},
				Status: &tracepb.Status{Code: tracepb.Status_STATUS_CODE_OK},
			}},
		}},
	}}}
	return request
}

func TestIngressRejectsAdversarialTelemetryAtomically(t *testing.T) {
	schema, err := loadTelemetrySchema()
	if err != nil {
		t.Fatal(err)
	}
	valid := validTelemetryRequest()
	tests := []struct {
		name   string
		mutate func(*collectortracepb.ExportTraceServiceRequest)
	}{
		{name: "unknown protobuf field", mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			request.ProtoReflect().SetUnknown([]byte{0x10, 0x01})
		}},
		{name: "multiple resources", mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			request.ResourceSpans = append(request.ResourceSpans, proto.Clone(request.ResourceSpans[0]).(*tracepb.ResourceSpans))
		}},
		{name: "unknown resource attribute", mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			request.ResourceSpans[0].Resource.Attributes = append(request.ResourceSpans[0].Resource.Attributes, stringKeyValue("private.path", "/Users/private"))
		}},
		{name: "invalid sibling span", mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			invalid := proto.Clone(request.ResourceSpans[0].ScopeSpans[0].Spans[0]).(*tracepb.Span)
			invalid.TraceId, invalid.SpanId = bytes.Repeat([]byte{3}, 16), bytes.Repeat([]byte{4}, 8)
			invalid.Attributes = append(invalid.Attributes, stringKeyValue("private.path", "/Users/private"))
			request.ResourceSpans[0].ScopeSpans[0].Spans = append(
				request.ResourceSpans[0].ScopeSpans[0].Spans,
				invalid,
			)
		}},
		{name: "wrong resource type", mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			request.ResourceSpans[0].Resource.Attributes[1].Value = &commonpb.AnyValue{Value: &commonpb.AnyValue_IntValue{IntValue: 42}}
		}},
		{name: "unbounded service version", mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			request.ResourceSpans[0].Resource.Attributes[1].Value = stringAnyValue(strings.Repeat("1", schema.Limits.MaxVersionBytes+1))
		}},
		{name: "private operation", mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			spanAttribute(request, "threadnote.operation").Value = stringAnyValue("/Users/private/repository")
		}},
		{name: "array value", mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			spanAttribute(request, "threadnote.operation").Value = &commonpb.AnyValue{Value: &commonpb.AnyValue_ArrayValue{ArrayValue: &commonpb.ArrayValue{}}}
		}},
		{name: "event", mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			request.ResourceSpans[0].ScopeSpans[0].Spans[0].Events = []*tracepb.Span_Event{{Name: "private"}}
		}},
		{name: "link", mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			request.ResourceSpans[0].ScopeSpans[0].Spans[0].Links = []*tracepb.Span_Link{{TraceId: bytes.Repeat([]byte{3}, 16), SpanId: bytes.Repeat([]byte{4}, 8)}}
		}},
		{name: "status message", mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			request.ResourceSpans[0].ScopeSpans[0].Spans[0].Status.Message = "private"
		}},
		{name: "partial memory buckets", mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			span := request.ResourceSpans[0].ScopeSpans[0].Spans[0]
			span.Attributes = append(span.Attributes, stringKeyValue("threadnote.memory.rss.start_bucket", "<32MiB"))
		}},
		{name: "cross-domain operation", mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			span := request.ResourceSpans[0].ScopeSpans[0].Spans[0]
			span.Attributes = append(span.Attributes,
				stringKeyValue("threadnote.failure.domain", "model-worker"),
				stringKeyValue("threadnote.failure.operation", "load-code-graph-adjacency"),
				stringKeyValue("threadnote.failure.reason", "crash"))
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := proto.Clone(valid).(*collectortracepb.ExportTraceServiceRequest)
			test.mutate(request)
			payload, marshalError := (proto.MarshalOptions{Deterministic: true}).Marshal(request)
			if marshalError != nil {
				t.Fatal(marshalError)
			}
			if _, validationError := canonicalTelemetryPayload(payload, schema); validationError == nil {
				t.Fatal("adversarial telemetry was accepted")
			}
		})
	}
}

func TestCanonicalTelemetryPayloadRejectsDuplicateSingularWireFields(t *testing.T) {
	schema, err := loadTelemetrySchema()
	if err != nil {
		t.Fatal(err)
	}
	valid := validTelemetryPayload(t)
	request := validTelemetryRequest()
	resourceSpans, marshalError := proto.Marshal(request.ResourceSpans[0])
	if marshalError != nil {
		t.Fatal(marshalError)
	}
	duplicateTopLevel := append(append([]byte(nil), valid...), protowire.AppendBytes(protowire.AppendTag(nil, 1, protowire.BytesType), resourceSpans)...)
	if _, validationError := canonicalTelemetryPayload(duplicateTopLevel, schema); validationError == nil {
		t.Fatal("duplicate top-level resource_spans was accepted")
	}

	span := request.ResourceSpans[0].ScopeSpans[0].Spans[0]
	spanWire, marshalError := proto.Marshal(span)
	if marshalError != nil {
		t.Fatal(marshalError)
	}
	duplicateName := protowire.AppendBytes(protowire.AppendTag(append([]byte(nil), spanWire...), 5, protowire.BytesType), []byte("threadnote.anonymous-diagnostic"))
	if err := validateWireMessage(duplicateName, wireSpan); err == nil {
		t.Fatal("duplicate span name was accepted")
	}

	attribute := span.Attributes[0]
	attributeWire, marshalError := proto.Marshal(attribute)
	if marshalError != nil {
		t.Fatal(marshalError)
	}
	duplicateAttributeKey := protowire.AppendBytes(protowire.AppendTag(append([]byte(nil), attributeWire...), 1, protowire.BytesType), []byte(attribute.Key))
	if err := validateWireMessage(duplicateAttributeKey, wireKeyValue); err == nil {
		t.Fatal("duplicate attribute key was accepted")
	}

	anyValueWire, marshalError := proto.Marshal(attribute.Value)
	if marshalError != nil {
		t.Fatal(marshalError)
	}
	multipleOneofValues := protowire.AppendVarint(protowire.AppendTag(append([]byte(nil), anyValueWire...), 2, protowire.VarintType), 1)
	if err := validateWireMessage(multipleOneofValues, wireAnyValue); err == nil {
		t.Fatal("multiple AnyValue oneof fields were accepted")
	}
}

func TestIngressRejectsAdversarialTelemetryWithoutContactingCollector(t *testing.T) {
	listener, listenError := net.Listen("tcp", "127.0.0.1:4318")
	if listenError != nil {
		t.Fatal(listenError)
	}
	requests := make(chan struct{}, 1)
	backend := &http.Server{Handler: http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		requests <- struct{}{}
		response.WriteHeader(http.StatusOK)
	})}
	go func() { _ = backend.Serve(listener) }()
	t.Cleanup(func() { _ = backend.Close() })

	invalid := validTelemetryRequest()
	invalid.ResourceSpans[0].ScopeSpans[0].Spans[0].Attributes = append(
		invalid.ResourceSpans[0].ScopeSpans[0].Spans[0].Attributes,
		stringKeyValue("private.path", "/Users/private/repository"),
	)
	payload, marshalError := proto.Marshal(invalid)
	if marshalError != nil {
		t.Fatal(marshalError)
	}
	handler, handlerError := newGatewayHandler()
	if handlerError != nil {
		t.Fatal(handlerError)
	}
	request := httptest.NewRequest(http.MethodPost, "/v1/traces", bytes.NewReader(payload))
	request.Header.Set("Content-Type", "application/x-protobuf")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("invalid request returned %d, want %d", response.Code, http.StatusBadRequest)
	}
	select {
	case <-requests:
		t.Fatal("invalid telemetry reached Collector")
	case <-time.After(50 * time.Millisecond):
	}
}

func TestIngressRejectsArbitraryPrivateOperationValues(t *testing.T) {
	handler, handlerError := newGatewayHandler()
	if handlerError != nil {
		t.Fatal(handlerError)
	}
	property := func(value string) bool {
		digest := sha256.Sum256([]byte(value))
		invalid := validTelemetryRequest()
		spanAttribute(invalid, "threadnote.operation").Value = stringAnyValue("private-" + hex.EncodeToString(digest[:]))
		payload, marshalError := proto.Marshal(invalid)
		if marshalError != nil {
			return false
		}
		request := httptest.NewRequest(http.MethodPost, "/v1/traces", bytes.NewReader(payload))
		request.Header.Set("Content-Type", "application/x-protobuf")
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		return response.Code == http.StatusBadRequest
	}
	if propertyError := quick.Check(property, &quick.Config{MaxCount: 32}); propertyError != nil {
		t.Fatal(propertyError)
	}
}

func stringAnyValue(value string) *commonpb.AnyValue {
	return &commonpb.AnyValue{Value: &commonpb.AnyValue_StringValue{StringValue: value}}
}

func stringKeyValue(key, value string) *commonpb.KeyValue {
	return &commonpb.KeyValue{Key: key, Value: stringAnyValue(value)}
}

func spanAttribute(request *collectortracepb.ExportTraceServiceRequest, key string) *commonpb.KeyValue {
	for _, attribute := range request.ResourceSpans[0].ScopeSpans[0].Spans[0].Attributes {
		if attribute.Key == key {
			return attribute
		}
	}
	panic("missing fixture attribute")
}

func TestConfigurationAcceptsOnlyGrafanaHTTPSOTLP(t *testing.T) {
	t.Setenv("GRAFANA_CLOUD_OTLP_ENDPOINT", "https://otlp-gateway-prod-eu-west-2.grafana.net/otlp")
	t.Setenv("GRAFANA_CLOUD_AUTHORIZATION", "Basic MTIzNDU2OnRva2Vu")
	if validationError := validateConfiguration(); validationError != nil {
		t.Fatalf("valid configuration failed: %v", validationError)
	}

	invalidEndpoints := []string{
		"http://otlp-gateway-prod-eu-west-2.grafana.net/otlp",
		"https://example.com/otlp",
		"https://otlp-gateway-prod-eu-west-2.grafana.net/v1/traces",
		"https://otlp-gateway-prod-eu-west-2.grafana.net/otlp?private=value",
	}
	for _, endpoint := range invalidEndpoints {
		t.Setenv("GRAFANA_CLOUD_OTLP_ENDPOINT", endpoint)
		if validateConfiguration() == nil {
			t.Fatalf("invalid endpoint was accepted: %s", endpoint)
		}
	}
}

func TestIngressRateLimitsAllRoutes(t *testing.T) {
	handler, handlerError := newGatewayHandler()
	if handlerError != nil {
		t.Fatal(handlerError)
	}
	for index := 0; index < perSourceRequestsMin+1; index++ {
		request := httptest.NewRequest(http.MethodGet, "/invalid", nil)
		request.Header.Set("Fly-Client-IP", "192.0.2.42")
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		want := http.StatusNotFound
		if index == perSourceRequestsMin {
			want = http.StatusTooManyRequests
		}
		if response.Code != want {
			t.Fatalf("request %d returned %d, want %d", index+1, response.Code, want)
		}
	}
}

func TestAcceptedByteBudgetStaysInsideTheFreeTierEnvelope(t *testing.T) {
	limiter := &requestLimiter{sources: make(map[string]windowCounter)}
	now := time.Unix(1_700_000_000, 0)
	if !limiter.allowBytes("first", acceptedBytesPerMin/2, now) ||
		!limiter.allowBytes("second", acceptedBytesPerMin/2, now) {
		t.Fatal("admitted byte budget was rejected")
	}
	if limiter.allowBytes("third", 1, now) {
		t.Fatal("global accepted byte budget was exceeded")
	}
	if !limiter.allowBytes("third", acceptedBytesPerMin, now.Add(time.Minute)) {
		t.Fatal("accepted byte budget did not reset for the next minute")
	}
	const machines = 2
	const minutesIn31Days = 31 * 24 * 60
	if maximum := int64(acceptedBytesPerMin * machines * minutesIn31Days); maximum >= 3_000_000_000 {
		t.Fatalf("two-Machine monthly cap = %d bytes, want less than 3 GB canonical input", maximum)
	}
}

func TestRejectedTelemetryDoesNotConsumeTheAcceptedByteBudget(t *testing.T) {
	schema, schemaError := loadTelemetrySchema()
	if schemaError != nil {
		t.Fatal(schemaError)
	}
	limiter := &requestLimiter{sources: make(map[string]windowCounter)}
	now := time.Unix(1_700_000_000, 0)
	for index := 0; index < 32; index++ {
		invalid := validTelemetryRequest()
		spanAttribute(invalid, "threadnote.operation").Value = stringAnyValue("private-operation")
		payload, marshalError := proto.Marshal(invalid)
		if marshalError != nil {
			t.Fatal(marshalError)
		}
		if canonical, validationError := canonicalTelemetryPayload(payload, schema); validationError == nil {
			if !limiter.allowBytes("source", len(canonical), now) {
				t.Fatal("unexpected byte-budget rejection")
			}
		}
	}
	if limiter.global.bytes != 0 {
		t.Fatalf("rejected telemetry consumed %d accepted bytes", limiter.global.bytes)
	}
}

func TestOnlyPrivateMarkedHealthChecksUseDedicatedCapacity(t *testing.T) {
	private := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	private.RemoteAddr = "172.16.0.2:43123"
	private.Header.Set(trustedHealthHeader, trustedHealthValue)
	if !isTrustedHealthCheck(private) {
		t.Fatal("private Fly service check was not recognized")
	}

	public := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	public.RemoteAddr = "172.16.0.2:43123"
	public.Header.Set(trustedHealthHeader, trustedHealthValue)
	public.Header.Set("Fly-Client-IP", "192.0.2.42")
	if isTrustedHealthCheck(public) {
		t.Fatal("public health request escaped the public budget")
	}

	forged := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	forged.RemoteAddr = "192.0.2.42:43123"
	forged.Header.Set(trustedHealthHeader, trustedHealthValue)
	if isTrustedHealthCheck(forged) {
		t.Fatal("non-private marked request escaped the public budget")
	}
}

func TestRequestSourceIsEphemerallyPseudonymized(t *testing.T) {
	request := httptest.NewRequest(http.MethodGet, "/", nil)
	request.Header.Set("Fly-Client-IP", "192.0.2.42")
	value := requestSource(request, bytes.Repeat([]byte{7}, 32))
	if strings.Contains(value, "192.0.2.42") || len(value) != 32 {
		t.Fatalf("source key is not a bounded pseudonym: %q", value)
	}
}
