package main

import (
	"bytes"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
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
	payload := []byte{10, 0}
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

func TestHealthChecksDoNotExhaustThePerSourceBudget(t *testing.T) {
	limiter := &requestLimiter{sources: make(map[string]windowCounter)}
	now := time.Unix(0, 0)
	for index := 0; index < globalRequestsPerMin; index++ {
		if !limiter.allow("health-checker", now, false) {
			t.Fatalf("health check %d was rejected before the global limit", index+1)
		}
	}
	if limiter.allow("health-checker", now, false) {
		t.Fatal("health check was accepted after the global limit")
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
