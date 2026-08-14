package main

import (
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"

	collectortracepb "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	commonpb "go.opentelemetry.io/proto/otlp/common/v1"
	resourcepb "go.opentelemetry.io/proto/otlp/resource/v1"
	tracepb "go.opentelemetry.io/proto/otlp/trace/v1"
	"google.golang.org/protobuf/encoding/protowire"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
)

//go:embed telemetry-schema-v1.json
var telemetrySchemaV1JSON []byte

//go:embed telemetry-schema-v2.json
var telemetrySchemaV2JSON []byte

type telemetrySchema struct {
	SchemaVersion int `json:"schemaVersion"`
	Limits        struct {
		MaxSpansPerRequest int   `json:"maxSpansPerRequest"`
		MaxSafeInteger     int64 `json:"maxSafeInteger"`
		MaxVersionBytes    int   `json:"maxVersionBytes"`
	} `json:"limits"`
	Patterns struct {
		InvocationID   string `json:"invocationId"`
		QuantityBucket string `json:"quantityBucket"`
		RuntimeLabel   string `json:"runtimeLabel"`
		ServiceVersion string `json:"serviceVersion"`
		SessionID      string `json:"sessionId"`
	} `json:"patterns"`
	AttributeContract struct {
		BooleanSpan        []string `json:"booleanSpan"`
		IntegerSpan        []string `json:"integerSpan"`
		MemoryBucketSpan   []string `json:"memoryBucketSpan"`
		QuantityBucketSpan []string `json:"quantityBucketSpan"`
		RequiredSpan       []string `json:"requiredSpan"`
		Resource           []string `json:"resource"`
		Span               []string `json:"span"`
	} `json:"attributeContract"`
	Registries map[string][]string `json:"registries"`
}

type compiledTelemetrySchema struct {
	telemetrySchema
	booleanSpan        map[string]struct{}
	integerSpan        map[string]struct{}
	memoryBucketSpan   map[string]struct{}
	patterns           map[string]*regexp.Regexp
	quantityBucketSpan map[string]struct{}
	registries         map[string]map[string]struct{}
	requiredSpan       map[string]struct{}
	resourceAttributes map[string]struct{}
	spanAttributes     map[string]struct{}
}

type compiledTelemetrySchemas struct {
	byVersion map[int]*compiledTelemetrySchema
}

var graphRegistrySpanAttributes = map[string]string{
	"threadnote.graph.build_kind":           "buildKind",
	"threadnote.graph.efficiency_class":     "efficiencyClass",
	"threadnote.graph.fallback_reason":      "fallbackReason",
	"threadnote.graph.materialization_mode": "materializationMode",
	"threadnote.graph.resolution_closure":   "resolutionClosure",
}

var terminalGraphSpanAttributes = []string{
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
}

func loadTelemetrySchemas() (*compiledTelemetrySchemas, error) {
	result := &compiledTelemetrySchemas{byVersion: make(map[int]*compiledTelemetrySchema, 2)}
	for version, data := range map[int][]byte{1: telemetrySchemaV1JSON, 2: telemetrySchemaV2JSON} {
		compiled, err := compileTelemetrySchema(data, version)
		if err != nil {
			return nil, err
		}
		result.byVersion[version] = compiled
	}
	return result, nil
}

func compileTelemetrySchema(data []byte, expectedVersion int) (*compiledTelemetrySchema, error) {
	var raw telemetrySchema
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, fmt.Errorf("decode telemetry schema: %w", err)
	}
	if raw.SchemaVersion != expectedVersion || raw.Limits.MaxSpansPerRequest < 1 || raw.Limits.MaxSafeInteger != 9007199254740991 || raw.Limits.MaxVersionBytes < 1 {
		return nil, errors.New("invalid telemetry schema version or limits")
	}
	compiled := &compiledTelemetrySchema{
		telemetrySchema:    raw,
		booleanSpan:        stringSet(raw.AttributeContract.BooleanSpan),
		integerSpan:        stringSet(raw.AttributeContract.IntegerSpan),
		memoryBucketSpan:   stringSet(raw.AttributeContract.MemoryBucketSpan),
		quantityBucketSpan: stringSet(raw.AttributeContract.QuantityBucketSpan),
		registries:         make(map[string]map[string]struct{}, len(raw.Registries)),
		requiredSpan:       stringSet(raw.AttributeContract.RequiredSpan),
		resourceAttributes: stringSet(raw.AttributeContract.Resource),
		spanAttributes:     stringSet(raw.AttributeContract.Span),
		patterns:           make(map[string]*regexp.Regexp, 5),
	}
	for name, values := range raw.Registries {
		compiled.registries[name] = stringSet(values)
	}
	for name, pattern := range map[string]string{
		"invocationId": raw.Patterns.InvocationID, "quantityBucket": raw.Patterns.QuantityBucket,
		"runtimeLabel": raw.Patterns.RuntimeLabel, "serviceVersion": raw.Patterns.ServiceVersion,
		"sessionId": raw.Patterns.SessionID,
	} {
		value, err := regexp.Compile(pattern)
		if err != nil {
			return nil, fmt.Errorf("compile telemetry schema pattern %s: %w", name, err)
		}
		compiled.patterns[name] = value
	}
	requiredRegistries := []string{"component", "correlationScope", "degradationReason", "errorType", "event", "failureCode", "failureDomain", "failureOperation", "failureReason", "failureRecovery", "memoryBucket", "modelWorkerOperation", "operation", "outcome", "phase", "stage", "subphase", "waitingReason"}
	if expectedVersion == 2 {
		requiredRegistries = append(requiredRegistries, "buildKind", "efficiencyClass", "fallbackReason", "materializationMode", "resolutionClosure")
	}
	for _, registry := range requiredRegistries {
		if len(compiled.registries[registry]) == 0 {
			return nil, fmt.Errorf("empty telemetry schema registry %s", registry)
		}
	}
	return compiled, nil
}

func stringSet(values []string) map[string]struct{} {
	result := make(map[string]struct{}, len(values))
	for _, value := range values {
		if value == "" {
			continue
		}
		result[value] = struct{}{}
	}
	return result
}

func canonicalTelemetryPayload(payload []byte, schemas *compiledTelemetrySchemas) ([]byte, error) {
	if err := validateTelemetryWire(payload); err != nil {
		return nil, err
	}
	request := &collectortracepb.ExportTraceServiceRequest{}
	if err := (proto.UnmarshalOptions{DiscardUnknown: false}).Unmarshal(payload, request); err != nil {
		return nil, errors.New("invalid OTLP protobuf")
	}
	if err := rejectUnknownProto(request.ProtoReflect()); err != nil {
		return nil, err
	}
	schema, err := selectTelemetrySchema(request, schemas)
	if err != nil {
		return nil, err
	}
	if err := validateTelemetryRequest(request, schema); err != nil {
		return nil, err
	}
	clean := freshTelemetryRequest(request)
	canonical, err := (proto.MarshalOptions{Deterministic: true}).Marshal(clean)
	if err != nil {
		return nil, errors.New("marshal canonical OTLP protobuf")
	}
	return canonical, nil
}

func selectTelemetrySchema(request *collectortracepb.ExportTraceServiceRequest, schemas *compiledTelemetrySchemas) (*compiledTelemetrySchema, error) {
	if schemas == nil || len(request.ResourceSpans) != 1 || request.ResourceSpans[0] == nil || request.ResourceSpans[0].Resource == nil {
		return nil, errors.New("invalid telemetry schema envelope")
	}
	var version int64
	found := false
	for _, attribute := range request.ResourceSpans[0].Resource.Attributes {
		if attribute == nil || attribute.Key != "threadnote.telemetry.schema_version" {
			continue
		}
		if found || attribute.Value == nil {
			return nil, errors.New("invalid telemetry schema version")
		}
		var ok bool
		version, ok = anyInt(attribute.Value)
		if !ok {
			return nil, errors.New("invalid telemetry schema version")
		}
		found = true
	}
	if !found {
		return nil, errors.New("missing telemetry schema version")
	}
	schema, admitted := schemas.byVersion[int(version)]
	if !admitted {
		return nil, errors.New("unsupported telemetry schema version")
	}
	return schema, nil
}

type wireMessageKind uint8

const (
	wireExport wireMessageKind = iota
	wireResourceSpans
	wireResource
	wireScopeSpans
	wireScope
	wireSpan
	wireStatus
	wireKeyValue
	wireAnyValue
)

var wireContracts = map[wireMessageKind]map[protowire.Number]struct {
	kind     wireMessageKind
	repeated bool
	wireType protowire.Type
}{
	wireExport:        {1: {kind: wireResourceSpans, repeated: true, wireType: protowire.BytesType}},
	wireResourceSpans: {1: {kind: wireResource, wireType: protowire.BytesType}, 2: {kind: wireScopeSpans, repeated: true, wireType: protowire.BytesType}, 3: {wireType: protowire.BytesType}},
	wireResource:      {1: {kind: wireKeyValue, repeated: true, wireType: protowire.BytesType}, 2: {wireType: protowire.VarintType}},
	wireScopeSpans:    {1: {kind: wireScope, wireType: protowire.BytesType}, 2: {kind: wireSpan, repeated: true, wireType: protowire.BytesType}, 3: {wireType: protowire.BytesType}},
	wireScope:         {1: {wireType: protowire.BytesType}, 2: {wireType: protowire.BytesType}, 3: {kind: wireKeyValue, repeated: true, wireType: protowire.BytesType}, 4: {wireType: protowire.VarintType}},
	wireSpan: {
		1: {wireType: protowire.BytesType}, 2: {wireType: protowire.BytesType}, 3: {wireType: protowire.BytesType}, 4: {wireType: protowire.BytesType},
		5: {wireType: protowire.BytesType}, 6: {wireType: protowire.VarintType}, 7: {wireType: protowire.Fixed64Type}, 8: {wireType: protowire.Fixed64Type},
		9: {kind: wireKeyValue, repeated: true, wireType: protowire.BytesType}, 10: {wireType: protowire.VarintType}, 11: {repeated: true, wireType: protowire.BytesType},
		12: {wireType: protowire.VarintType}, 13: {repeated: true, wireType: protowire.BytesType}, 14: {wireType: protowire.VarintType},
		15: {kind: wireStatus, wireType: protowire.BytesType}, 16: {wireType: protowire.Fixed32Type},
	},
	wireStatus:   {2: {wireType: protowire.BytesType}, 3: {wireType: protowire.VarintType}},
	wireKeyValue: {1: {wireType: protowire.BytesType}, 2: {kind: wireAnyValue, wireType: protowire.BytesType}},
	wireAnyValue: {
		1: {wireType: protowire.BytesType}, 2: {wireType: protowire.VarintType}, 3: {wireType: protowire.VarintType}, 4: {wireType: protowire.Fixed64Type},
		5: {wireType: protowire.BytesType}, 6: {wireType: protowire.BytesType}, 7: {wireType: protowire.BytesType},
	},
}

func validateTelemetryWire(payload []byte) error {
	return validateWireMessage(payload, wireExport)
}

func validateWireMessage(payload []byte, kind wireMessageKind) error {
	seen := make(map[protowire.Number]struct{})
	contract := wireContracts[kind]
	for len(payload) > 0 {
		number, wireType, tagLength := protowire.ConsumeTag(payload)
		if tagLength < 0 {
			return errors.New("invalid OTLP protobuf tag")
		}
		field, admitted := contract[number]
		if !admitted || field.wireType != wireType {
			return errors.New("invalid OTLP protobuf field")
		}
		if _, duplicate := seen[number]; duplicate && !field.repeated {
			return errors.New("duplicate OTLP protobuf singular field")
		}
		if kind == wireAnyValue && len(seen) != 0 {
			return errors.New("OTLP AnyValue contains multiple oneof fields")
		}
		seen[number] = struct{}{}
		payload = payload[tagLength:]
		var value []byte
		var consumed int
		switch wireType {
		case protowire.VarintType:
			_, consumed = protowire.ConsumeVarint(payload)
		case protowire.Fixed32Type:
			_, consumed = protowire.ConsumeFixed32(payload)
		case protowire.Fixed64Type:
			_, consumed = protowire.ConsumeFixed64(payload)
		case protowire.BytesType:
			value, consumed = protowire.ConsumeBytes(payload)
		default:
			return errors.New("unsupported OTLP protobuf wire type")
		}
		if consumed < 0 {
			return errors.New("invalid OTLP protobuf field value")
		}
		if wireType == protowire.BytesType && field.kind != 0 {
			if err := validateWireMessage(value, field.kind); err != nil {
				return err
			}
		}
		payload = payload[consumed:]
	}
	return nil
}

func freshTelemetryRequest(request *collectortracepb.ExportTraceServiceRequest) *collectortracepb.ExportTraceServiceRequest {
	resourceSpans := request.ResourceSpans[0]
	scopeSpans := resourceSpans.ScopeSpans[0]
	spans := make([]*tracepb.Span, len(scopeSpans.Spans))
	for index, span := range scopeSpans.Spans {
		spans[index] = &tracepb.Span{
			TraceId: append([]byte(nil), span.TraceId...), SpanId: append([]byte(nil), span.SpanId...), Name: span.Name,
			Kind: span.Kind, StartTimeUnixNano: span.StartTimeUnixNano, EndTimeUnixNano: span.EndTimeUnixNano,
			Attributes: freshAttributes(span.Attributes), Status: &tracepb.Status{Code: span.Status.Code},
		}
	}
	return &collectortracepb.ExportTraceServiceRequest{ResourceSpans: []*tracepb.ResourceSpans{{
		Resource:   &resourcepb.Resource{Attributes: freshAttributes(resourceSpans.Resource.Attributes)},
		ScopeSpans: []*tracepb.ScopeSpans{{Scope: &commonpb.InstrumentationScope{Name: scopeSpans.Scope.Name}, Spans: spans}},
	}}}
}

func freshAttributes(attributes []*commonpb.KeyValue) []*commonpb.KeyValue {
	result := make([]*commonpb.KeyValue, len(attributes))
	for index, attribute := range attributes {
		value := &commonpb.AnyValue{}
		switch typed := attribute.Value.Value.(type) {
		case *commonpb.AnyValue_StringValue:
			value.Value = &commonpb.AnyValue_StringValue{StringValue: typed.StringValue}
		case *commonpb.AnyValue_BoolValue:
			value.Value = &commonpb.AnyValue_BoolValue{BoolValue: typed.BoolValue}
		case *commonpb.AnyValue_IntValue:
			value.Value = &commonpb.AnyValue_IntValue{IntValue: typed.IntValue}
		}
		result[index] = &commonpb.KeyValue{Key: attribute.Key, Value: value}
	}
	return result
}

func rejectUnknownProto(message protoreflect.Message) error {
	if len(message.GetUnknown()) != 0 {
		return errors.New("OTLP protobuf contains unknown fields")
	}
	var nestedError error
	message.Range(func(descriptor protoreflect.FieldDescriptor, value protoreflect.Value) bool {
		if descriptor.IsMap() {
			if descriptor.MapValue().Kind() == protoreflect.MessageKind {
				value.Map().Range(func(_ protoreflect.MapKey, mapped protoreflect.Value) bool {
					nestedError = rejectUnknownProto(mapped.Message())
					return nestedError == nil
				})
			}
			return nestedError == nil
		}
		if descriptor.IsList() && descriptor.Kind() == protoreflect.MessageKind {
			list := value.List()
			for index := 0; index < list.Len(); index++ {
				if nestedError = rejectUnknownProto(list.Get(index).Message()); nestedError != nil {
					return false
				}
			}
			return true
		}
		if descriptor.Kind() == protoreflect.MessageKind {
			nestedError = rejectUnknownProto(value.Message())
			return nestedError == nil
		}
		return true
	})
	return nestedError
}

func validateTelemetryRequest(request *collectortracepb.ExportTraceServiceRequest, schema *compiledTelemetrySchema) error {
	if len(request.ResourceSpans) != 1 || request.ResourceSpans[0] == nil {
		return errors.New("telemetry request must contain one resource span group")
	}
	resourceSpans := request.ResourceSpans[0]
	if resourceSpans.SchemaUrl != "" || resourceSpans.Resource == nil || resourceSpans.Resource.DroppedAttributesCount != 0 {
		return errors.New("invalid telemetry resource envelope")
	}
	resource, err := attributesByKey(resourceSpans.Resource.Attributes, schema.resourceAttributes)
	if err != nil || len(resource) != len(schema.resourceAttributes) {
		return errors.New("invalid telemetry resource attributes")
	}
	if !stringAttributeEquals(resource, "service.name", "threadnote") ||
		!stringAttributeMatchesBounded(resource, "service.version", schema.patterns["serviceVersion"], schema.Limits.MaxVersionBytes) ||
		!stringAttributeMatches(resource, "session.id", schema.patterns["sessionId"]) ||
		!stringAttributeIn(resource, "threadnote.session.scope", schema.registries["correlationScope"]) ||
		!intAttributeEquals(resource, "threadnote.telemetry.schema_version", int64(schema.SchemaVersion)) {
		return errors.New("invalid telemetry resource values")
	}
	if len(resourceSpans.ScopeSpans) != 1 || resourceSpans.ScopeSpans[0] == nil {
		return errors.New("telemetry request must contain one scope span group")
	}
	scopeSpans := resourceSpans.ScopeSpans[0]
	if scopeSpans.SchemaUrl != "" || scopeSpans.Scope == nil || scopeSpans.Scope.Name != "threadnote" ||
		scopeSpans.Scope.Version != "" || len(scopeSpans.Scope.Attributes) != 0 || scopeSpans.Scope.DroppedAttributesCount != 0 ||
		len(scopeSpans.Spans) == 0 || len(scopeSpans.Spans) > schema.Limits.MaxSpansPerRequest {
		return errors.New("invalid telemetry scope envelope")
	}
	traceIDs := make(map[string]struct{}, len(scopeSpans.Spans))
	spanIDs := make(map[string]struct{}, len(scopeSpans.Spans))
	for _, span := range scopeSpans.Spans {
		if err := validateTelemetrySpan(span, schema, traceIDs, spanIDs); err != nil {
			return err
		}
	}
	return nil
}

func validateTelemetrySpan(span *tracepb.Span, schema *compiledTelemetrySchema, traceIDs, spanIDs map[string]struct{}) error {
	if span == nil || !nonzeroID(span.TraceId, 16) || !nonzeroID(span.SpanId, 8) || len(span.ParentSpanId) != 0 ||
		span.TraceState != "" || span.Name != "threadnote.anonymous-diagnostic" || span.Kind != tracepb.Span_SPAN_KIND_INTERNAL ||
		span.StartTimeUnixNano == 0 || span.EndTimeUnixNano < span.StartTimeUnixNano || span.Flags != 0 ||
		span.DroppedAttributesCount != 0 || len(span.Events) != 0 || span.DroppedEventsCount != 0 || len(span.Links) != 0 || span.DroppedLinksCount != 0 ||
		span.Status == nil || span.Status.Code != tracepb.Status_STATUS_CODE_OK || span.Status.Message != "" {
		return errors.New("invalid telemetry span envelope")
	}
	traceID, spanID := string(span.TraceId), string(span.SpanId)
	if _, exists := traceIDs[traceID]; exists {
		return errors.New("duplicate telemetry trace id")
	}
	if _, exists := spanIDs[spanID]; exists {
		return errors.New("duplicate telemetry span id")
	}
	traceIDs[traceID], spanIDs[spanID] = struct{}{}, struct{}{}
	attributes, err := attributesByKey(span.Attributes, schema.spanAttributes)
	if err != nil {
		return err
	}
	for key := range schema.requiredSpan {
		if _, exists := attributes[key]; !exists {
			return errors.New("missing required telemetry span attribute")
		}
	}
	if err := validateSpanAttributeValues(attributes, schema); err != nil {
		return err
	}
	return validateSpanAttributeShape(attributes, schema)
}

func attributesByKey(attributes []*commonpb.KeyValue, allowed map[string]struct{}) (map[string]*commonpb.AnyValue, error) {
	result := make(map[string]*commonpb.AnyValue, len(attributes))
	for _, attribute := range attributes {
		if attribute == nil || attribute.Key == "" || attribute.Value == nil {
			return nil, errors.New("invalid telemetry attribute")
		}
		if _, admitted := allowed[attribute.Key]; !admitted {
			return nil, errors.New("unknown telemetry attribute")
		}
		if _, duplicate := result[attribute.Key]; duplicate {
			return nil, errors.New("duplicate telemetry attribute")
		}
		result[attribute.Key] = attribute.Value
	}
	return result, nil
}

func validateSpanAttributeValues(attributes map[string]*commonpb.AnyValue, schema *compiledTelemetrySchema) error {
	for key, value := range attributes {
		switch {
		case key == "threadnote.component":
			if !valueStringIn(value, schema.registries["component"]) {
				return errors.New("invalid telemetry component")
			}
		case key == "threadnote.event":
			if !valueStringIn(value, schema.registries["event"]) {
				return errors.New("invalid telemetry event")
			}
		case key == "threadnote.operation":
			if !valueStringIn(value, schema.registries["operation"]) {
				return errors.New("invalid telemetry operation")
			}
		case key == "threadnote.runtime.architecture" || key == "threadnote.runtime.platform":
			if !valueStringMatches(value, schema.patterns["runtimeLabel"]) {
				return errors.New("invalid telemetry runtime label")
			}
		case key == "threadnote.runtime.version":
			if !valueStringMatchesBounded(value, schema.patterns["serviceVersion"], schema.Limits.MaxVersionBytes) {
				return errors.New("invalid telemetry runtime version")
			}
		case key == "threadnote.invocation.id":
			if !valueStringMatches(value, schema.patterns["invocationId"]) {
				return errors.New("invalid telemetry invocation id")
			}
		case key == "threadnote.outcome" || key == "threadnote.phase.outcome":
			if !valueStringIn(value, schema.registries["outcome"]) {
				return errors.New("invalid telemetry outcome")
			}
		case key == "threadnote.phase":
			if !valueStringIn(value, schema.registries["phase"]) {
				return errors.New("invalid telemetry phase")
			}
		case key == "threadnote.stage":
			if !valueStringIn(value, schema.registries["stage"]) {
				return errors.New("invalid telemetry stage")
			}
		case key == "threadnote.subphase":
			if !valueStringIn(value, schema.registries["subphase"]) {
				return errors.New("invalid telemetry subphase")
			}
		case key == "threadnote.waiting_reason":
			if !valueStringIn(value, schema.registries["waitingReason"]) {
				return errors.New("invalid telemetry waiting reason")
			}
		case key == "threadnote.graph.degradation_reason":
			if !valueStringIn(value, schema.registries["degradationReason"]) {
				return errors.New("invalid telemetry degradation reason")
			}
		case key == "error.type":
			if !valueStringIn(value, schema.registries["errorType"]) {
				return errors.New("invalid telemetry error type")
			}
		case key == "threadnote.failure.domain":
			if !valueStringIn(value, schema.registries["failureDomain"]) {
				return errors.New("invalid telemetry failure domain")
			}
		case key == "threadnote.failure.code":
			if !valueStringIn(value, schema.registries["failureCode"]) {
				return errors.New("invalid telemetry failure code")
			}
		case key == "threadnote.failure.operation":
			if !valueStringIn(value, schema.registries["failureOperation"]) && !valueStringIn(value, schema.registries["modelWorkerOperation"]) {
				return errors.New("invalid telemetry failure operation")
			}
		case key == "threadnote.failure.reason":
			if !valueStringIn(value, schema.registries["failureReason"]) {
				return errors.New("invalid telemetry failure reason")
			}
		case key == "threadnote.failure.recovery":
			if !valueStringIn(value, schema.registries["failureRecovery"]) {
				return errors.New("invalid telemetry failure recovery")
			}
		case graphRegistrySpanAttributes[key] != "":
			if !valueStringIn(value, schema.registries[graphRegistrySpanAttributes[key]]) {
				return errors.New("invalid telemetry graph classification")
			}
		case contains(schema.booleanSpan, key):
			if _, ok := value.Value.(*commonpb.AnyValue_BoolValue); !ok {
				return errors.New("invalid telemetry boolean attribute")
			}
		case contains(schema.integerSpan, key):
			integer, ok := anyInt(value)
			if !ok || integer < 0 || integer > schema.Limits.MaxSafeInteger {
				return errors.New("invalid telemetry integer attribute")
			}
		case contains(schema.memoryBucketSpan, key):
			if !valueStringIn(value, schema.registries["memoryBucket"]) {
				return errors.New("invalid telemetry memory bucket")
			}
		case contains(schema.quantityBucketSpan, key):
			if !valueStringMatches(value, schema.patterns["quantityBucket"]) {
				return errors.New("invalid telemetry quantity bucket")
			}
		default:
			return errors.New("unvalidated telemetry attribute")
		}
	}
	return nil
}

func validateSpanAttributeShape(attributes map[string]*commonpb.AnyValue, schema *compiledTelemetrySchema) error {
	event, _ := anyString(attributes["threadnote.event"])
	_, duration := attributes["threadnote.duration_ms"]
	_, outcome := attributes["threadnote.outcome"]
	if event == "completion" && (!duration || !outcome) {
		return errors.New("telemetry completion requires duration and outcome")
	}
	if event != "completion" && duration != outcome {
		return errors.New("telemetry event duration and outcome must be paired")
	}
	current, start, end := memoryGroups(attributes)
	if event == "completion" {
		if current != 0 || (start != 0 && start != 4) || (end != 0 && end != 4) || (end == 4 && start != 4) {
			return errors.New("invalid telemetry completion memory shape")
		}
	} else if start != 0 || end != 0 || (current != 0 && current != 4) {
		return errors.New("invalid telemetry event memory shape")
	}
	domain, hasDomain := anyString(attributes["threadnote.failure.domain"])
	failureKeys := 0
	for _, key := range []string{"threadnote.failure.code", "threadnote.failure.operation", "threadnote.failure.reason", "threadnote.failure.recovery", "threadnote.failure.retryable"} {
		if _, exists := attributes[key]; exists {
			failureKeys++
		}
	}
	if !hasDomain && failureKeys != 0 {
		return errors.New("failure details require a domain")
	}
	if domain == "model-worker" {
		operation, exists := anyString(attributes["threadnote.failure.operation"])
		if !exists || !contains(schema.registries["modelWorkerOperation"], operation) {
			return errors.New("model failure requires a model operation")
		}
		if _, exists := attributes["threadnote.failure.reason"]; !exists {
			return errors.New("model failure requires reason")
		}
		for _, key := range []string{"threadnote.failure.code", "threadnote.failure.recovery", "threadnote.failure.retryable"} {
			if _, exists := attributes[key]; exists {
				return errors.New("invalid model failure shape")
			}
		}
	}
	if domain == "code-graph-storage" {
		if _, exists := attributes["threadnote.failure.reason"]; exists {
			return errors.New("invalid storage failure shape")
		}
		if operation, exists := anyString(attributes["threadnote.failure.operation"]); exists && !contains(schema.registries["failureOperation"], operation) {
			return errors.New("invalid storage failure operation")
		}
	}
	if _, exists := attributes["threadnote.phase.outcome"]; exists {
		if _, phase := attributes["threadnote.phase"]; !phase {
			return errors.New("phase outcome requires phase")
		}
		if _, elapsed := attributes["threadnote.phase.elapsed_ms"]; !elapsed {
			return errors.New("phase outcome requires elapsed time")
		}
	}
	operation, _ := anyString(attributes["threadnote.operation"])
	graphAttributeCount := 0
	for _, key := range terminalGraphSpanAttributes {
		if _, exists := attributes[key]; exists {
			graphAttributeCount++
		}
	}
	if graphAttributeCount != 0 && (schema.SchemaVersion != 2 || event != "lifecycle" || operation != "graph-build") {
		return errors.New("graph build attributes require a version 2 graph lifecycle event")
	}
	if event == "lifecycle" {
		outcomeValue, _ := anyString(attributes["threadnote.outcome"])
		if schema.SchemaVersion == 2 && operation == "graph-build" {
			if outcomeValue != "success" && outcomeValue != "failure" && outcomeValue != "interrupted" {
				return errors.New("graph build lifecycle event requires a terminal outcome")
			}
			if outcomeValue == "success" && graphAttributeCount != len(terminalGraphSpanAttributes) {
				return errors.New("successful graph build lifecycle event requires the complete graph surface")
			}
			if outcomeValue != "success" && graphAttributeCount != 0 {
				return errors.New("non-successful graph build lifecycle event cannot include a partial graph surface")
			}
			if outcomeValue == "failure" {
				if _, exists := attributes["error.type"]; !exists {
					return errors.New("failed graph build lifecycle event requires error type")
				}
			}
			if outcomeValue == "interrupted" {
				if _, exists := attributes["error.type"]; exists {
					return errors.New("interrupted graph build lifecycle event cannot include error type")
				}
			}
		} else {
			if outcomeValue != "failure" {
				return errors.New("lifecycle event requires failure outcome")
			}
			if _, exists := attributes["error.type"]; !exists {
				return errors.New("lifecycle event requires error type")
			}
		}
	}
	return nil
}

func memoryGroups(attributes map[string]*commonpb.AnyValue) (current, start, end int) {
	for key := range attributes {
		if len(key) < len("threadnote.memory.") || key[:len("threadnote.memory.")] != "threadnote.memory." {
			continue
		}
		switch {
		case len(key) >= len(".current_bucket") && key[len(key)-len(".current_bucket"):] == ".current_bucket":
			current++
		case len(key) >= len(".start_bucket") && key[len(key)-len(".start_bucket"):] == ".start_bucket":
			start++
		case len(key) >= len(".end_bucket") && key[len(key)-len(".end_bucket"):] == ".end_bucket":
			end++
		}
	}
	return
}

func nonzeroID(value []byte, length int) bool {
	if len(value) != length {
		return false
	}
	for _, b := range value {
		if b != 0 {
			return true
		}
	}
	return false
}
func contains(values map[string]struct{}, value string) bool { _, ok := values[value]; return ok }
func anyString(value *commonpb.AnyValue) (string, bool) {
	if value == nil {
		return "", false
	}
	typed, ok := value.Value.(*commonpb.AnyValue_StringValue)
	if !ok {
		return "", false
	}
	return typed.StringValue, true
}
func anyInt(value *commonpb.AnyValue) (int64, bool) {
	if value == nil {
		return 0, false
	}
	typed, ok := value.Value.(*commonpb.AnyValue_IntValue)
	if !ok {
		return 0, false
	}
	return typed.IntValue, true
}
func valueStringIn(value *commonpb.AnyValue, values map[string]struct{}) bool {
	text, ok := anyString(value)
	return ok && contains(values, text)
}
func valueStringMatches(value *commonpb.AnyValue, pattern *regexp.Regexp) bool {
	text, ok := anyString(value)
	return ok && pattern.MatchString(text)
}
func valueStringMatchesBounded(value *commonpb.AnyValue, pattern *regexp.Regexp, maxBytes int) bool {
	text, ok := anyString(value)
	return ok && len(text) <= maxBytes && pattern.MatchString(text)
}
func stringAttributeEquals(values map[string]*commonpb.AnyValue, key, expected string) bool {
	text, ok := anyString(values[key])
	return ok && text == expected
}
func stringAttributeMatches(values map[string]*commonpb.AnyValue, key string, pattern *regexp.Regexp) bool {
	return valueStringMatches(values[key], pattern)
}
func stringAttributeMatchesBounded(values map[string]*commonpb.AnyValue, key string, pattern *regexp.Regexp, maxBytes int) bool {
	return valueStringMatchesBounded(values[key], pattern, maxBytes)
}
func stringAttributeIn(values map[string]*commonpb.AnyValue, key string, registry map[string]struct{}) bool {
	return valueStringIn(values[key], registry)
}
func intAttributeEquals(values map[string]*commonpb.AnyValue, key string, expected int64) bool {
	value, ok := anyInt(values[key])
	return ok && value == expected
}
