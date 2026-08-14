package main

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/Kashkovsky/threadnote/infra/telemetry-gateway/internal/budget"
)

const (
	acceptedBytesPerMin       = budget.AcceptedBytesPerMachinePerMinute
	acceptedBytesPerSourceMin = budget.AcceptedBytesPerSourcePerMinute
	collectorConfigPath       = "/etc/otelcol-contrib/config.yaml"
	collectorHealthURL        = "http://127.0.0.1:13133/healthz"
	collectorTracesURL        = "http://127.0.0.1:4318/v1/traces"
	globalRequestsPerMin      = 300
	listenAddress             = "0.0.0.0:8080"
	maxConcurrent             = 4
	maxHealthConcurrent       = 1
	maxRequestBytes           = 256 * 1024
	maxSources                = 1024
	perSourceRequestsMin      = 60
	publicIngestionEnv        = "THREADNOTE_TELEMETRY_PUBLIC_INGESTION"
	trustedHealthHeader       = "X-Threadnote-Internal-Health"
	trustedHealthValue        = "fly-service-check-v1"
)

type windowCounter struct {
	bytes int
	count int
	start time.Time
}

type requestLimiter struct {
	global  windowCounter
	mu      sync.Mutex
	sources map[string]windowCounter
}

func main() {
	if validateConfiguration() != nil {
		fixedError("gateway-configuration-invalid")
		os.Exit(1)
	}
	handler, handlerError := newGatewayHandler()
	if handlerError != nil {
		fixedError("gateway-initialization-failed")
		os.Exit(1)
	}
	collector := exec.Command("/otelcol-contrib", "--config="+collectorConfigPath)
	collector.Stdout = os.Stdout
	collector.Stderr = os.Stderr
	collector.Env = os.Environ()
	if collector.Start() != nil {
		fixedError("collector-start-failed")
		os.Exit(1)
	}

	collectorDone := make(chan error, 1)
	go func() { collectorDone <- collector.Wait() }()

	server := &http.Server{
		Addr:              listenAddress,
		ErrorLog:          log.New(io.Discard, "", 0),
		Handler:           handler,
		IdleTimeout:       30 * time.Second,
		MaxHeaderBytes:    8 * 1024,
		ReadHeaderTimeout: 2 * time.Second,
		ReadTimeout:       7 * time.Second,
		WriteTimeout:      10 * time.Second,
	}
	serverDone := make(chan error, 1)
	go func() { serverDone <- server.ListenAndServe() }()

	signalContext, stopSignals := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stopSignals()
	exitCode := 0
	collectorRunning := true
	select {
	case <-signalContext.Done():
	case <-collectorDone:
		collectorRunning = false
		exitCode = 1
		fixedError("collector-exited")
	case serverError := <-serverDone:
		if !errors.Is(serverError, http.ErrServerClosed) {
			exitCode = 1
			fixedError("gateway-exited")
		}
	}

	shutdownContext, cancelShutdown := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancelShutdown()
	_ = server.Shutdown(shutdownContext)
	if collectorRunning {
		_ = collector.Process.Signal(syscall.SIGTERM)
		select {
		case <-collectorDone:
		case <-shutdownContext.Done():
			_ = collector.Process.Kill()
		}
	}
	os.Exit(exitCode)
}

func newGatewayHandler() (http.Handler, error) {
	schemas, schemaError := loadTelemetrySchemas()
	if schemaError != nil {
		return nil, schemaError
	}
	sourceHashKey := make([]byte, 32)
	if _, randomError := rand.Read(sourceHashKey); randomError != nil {
		return nil, randomError
	}
	transport := &http.Transport{
		DisableCompression:    true,
		IdleConnTimeout:       30 * time.Second,
		MaxIdleConns:          maxConcurrent,
		MaxIdleConnsPerHost:   maxConcurrent,
		ResponseHeaderTimeout: 5 * time.Second,
	}
	client := &http.Client{
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse },
		Timeout:       7 * time.Second,
		Transport:     transport,
	}
	concurrency := make(chan struct{}, maxConcurrent)
	healthConcurrency := make(chan struct{}, maxHealthConcurrent)
	limiter := &requestLimiter{sources: make(map[string]windowCounter)}
	publicIngestionEnabled := os.Getenv(publicIngestionEnv) != "disabled"

	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("Cache-Control", "no-store")
		response.Header().Set("Strict-Transport-Security", "max-age=31536000")
		response.Header().Set("X-Content-Type-Options", "nosniff")
		trustedHealth := isTrustedHealthCheck(request)
		source := requestSource(request, sourceHashKey)
		if !trustedHealth && !limiter.allow(source, time.Now()) {
			response.Header().Set("Retry-After", "60")
			writeStatus(response, http.StatusTooManyRequests)
			return
		}
		requestConcurrency := concurrency
		if trustedHealth {
			requestConcurrency = healthConcurrency
		}
		select {
		case requestConcurrency <- struct{}{}:
			defer func() { <-requestConcurrency }()
		default:
			response.Header().Set("Retry-After", "1")
			writeStatus(response, http.StatusTooManyRequests)
			return
		}
		if request.URL.Path == "/healthz" && request.URL.RawQuery == "" {
			handleHealth(response, request, client)
			return
		}
		if request.URL.Path != "/v1/traces" || request.URL.RawQuery != "" {
			writeStatus(response, http.StatusNotFound)
			return
		}
		if request.Method != http.MethodPost {
			response.Header().Set("Allow", http.MethodPost)
			writeStatus(response, http.StatusMethodNotAllowed)
			return
		}
		if request.Header.Get("Content-Type") != "application/x-protobuf" || request.Header.Get("Content-Encoding") != "" {
			writeStatus(response, http.StatusUnsupportedMediaType)
			return
		}
		if !publicIngestionEnabled {
			response.Header().Set("Retry-After", "3600")
			writeStatus(response, http.StatusServiceUnavailable)
			return
		}
		if request.ContentLength > maxRequestBytes {
			writeStatus(response, http.StatusRequestEntityTooLarge)
			return
		}
		limitedBody := http.MaxBytesReader(response, request.Body, maxRequestBytes)
		payload, readError := io.ReadAll(limitedBody)
		_ = limitedBody.Close()
		if readError != nil {
			var maxBytesError *http.MaxBytesError
			if errors.As(readError, &maxBytesError) {
				writeStatus(response, http.StatusRequestEntityTooLarge)
			} else {
				writeStatus(response, http.StatusBadRequest)
			}
			return
		}
		if len(payload) == 0 {
			writeStatus(response, http.StatusBadRequest)
			return
		}
		canonical, validationError := canonicalTelemetryPayload(payload, schemas)
		if validationError != nil {
			writeStatus(response, http.StatusBadRequest)
			return
		}
		if !limiter.allowBytes(source, len(canonical), time.Now()) {
			response.Header().Set("Retry-After", "60")
			writeStatus(response, http.StatusTooManyRequests)
			return
		}
		forwardTraces(response, request, client, canonical)
	}), nil
}

func handleHealth(response http.ResponseWriter, request *http.Request, client *http.Client) {
	if request.Method != http.MethodGet {
		response.Header().Set("Allow", http.MethodGet)
		writeStatus(response, http.StatusMethodNotAllowed)
		return
	}
	probe, probeError := http.NewRequestWithContext(request.Context(), http.MethodGet, collectorHealthURL, nil)
	if probeError != nil {
		writeStatus(response, http.StatusServiceUnavailable)
		return
	}
	result, requestError := client.Do(probe)
	if requestError != nil {
		writeStatus(response, http.StatusServiceUnavailable)
		return
	}
	defer result.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(result.Body, 4096))
	if result.StatusCode < 200 || result.StatusCode >= 300 {
		writeStatus(response, http.StatusServiceUnavailable)
		return
	}
	writeStatus(response, http.StatusNoContent)
}

func forwardTraces(response http.ResponseWriter, request *http.Request, client *http.Client, payload []byte) {
	forward, buildError := http.NewRequestWithContext(
		request.Context(),
		http.MethodPost,
		collectorTracesURL,
		bytes.NewReader(payload),
	)
	if buildError != nil {
		writeStatus(response, http.StatusServiceUnavailable)
		return
	}
	forward.Header.Set("Content-Type", "application/x-protobuf")
	result, requestError := client.Do(forward)
	if requestError != nil {
		writeStatus(response, http.StatusServiceUnavailable)
		return
	}
	defer result.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(result.Body, 64*1024))
	if result.StatusCode >= 300 && result.StatusCode < 400 {
		writeStatus(response, http.StatusBadGateway)
		return
	}
	if result.StatusCode >= 200 && result.StatusCode < 300 {
		response.Header().Set("Content-Type", "application/x-protobuf")
		response.WriteHeader(http.StatusOK)
		return
	}
	response.WriteHeader(result.StatusCode)
}

// Fly service checks reach the Machine over its private network and omit the
// public Fly-Client-IP header. The fixed check header is an additional marker,
// not a secret; public requests remain on the bounded ingestion budget.
func isTrustedHealthCheck(request *http.Request) bool {
	if request.Method != http.MethodGet || request.URL.Path != "/healthz" || request.URL.RawQuery != "" ||
		request.Header.Get(trustedHealthHeader) != trustedHealthValue || len(request.Header.Values("Fly-Client-IP")) != 0 {
		return false
	}
	host, _, splitError := net.SplitHostPort(request.RemoteAddr)
	if splitError != nil {
		return false
	}
	address := net.ParseIP(host)
	return address != nil && (address.IsPrivate() || address.IsLoopback())
}

func (limiter *requestLimiter) allow(source string, now time.Time) bool {
	limiter.mu.Lock()
	defer limiter.mu.Unlock()
	limiter.resetWindow(now)
	if limiter.global.count >= globalRequestsPerMin {
		return false
	}
	counter, admitted := limiter.sourceCounter(source)
	if !admitted || counter.count >= perSourceRequestsMin {
		return false
	}
	counter.count++
	limiter.sources[source] = counter
	limiter.global.count++
	return true
}

// allowBytes bounds accepted telemetry independently of provider billing. The
// production Machine inventory and this per-Machine limit are verified against
// the shared budget contract by CI and the scheduled storage canary.
func (limiter *requestLimiter) allowBytes(source string, size int, now time.Time) bool {
	limiter.mu.Lock()
	defer limiter.mu.Unlock()
	limiter.resetWindow(now)
	counter, admitted := limiter.sourceCounter(source)
	if !admitted || size < 0 || limiter.global.bytes+size > acceptedBytesPerMin ||
		counter.bytes+size > acceptedBytesPerSourceMin {
		return false
	}
	counter.bytes += size
	limiter.sources[source] = counter
	limiter.global.bytes += size
	return true
}

func (limiter *requestLimiter) resetWindow(now time.Time) {
	window := now.Truncate(time.Minute)
	if !limiter.global.start.Equal(window) {
		limiter.global = windowCounter{start: window}
		for key, counter := range limiter.sources {
			if counter.start.Before(window.Add(-time.Minute)) {
				delete(limiter.sources, key)
			}
		}
	}
}

func (limiter *requestLimiter) sourceCounter(source string) (windowCounter, bool) {
	window := limiter.global.start
	counter, exists := limiter.sources[source]
	if !exists && len(limiter.sources) >= maxSources {
		return windowCounter{}, false
	}
	if !counter.start.Equal(window) {
		counter = windowCounter{start: window}
	}
	return counter, true
}

func requestSource(request *http.Request, hashKey []byte) string {
	sourceValue := "unknown"
	values := request.Header.Values("Fly-Client-IP")
	if len(values) == 1 {
		if source := net.ParseIP(strings.TrimSpace(values[0])); source != nil {
			sourceValue = source.String()
		}
	}
	if sourceValue == "unknown" && len(values) == 0 {
		host, _, splitError := net.SplitHostPort(request.RemoteAddr)
		if splitError == nil {
			if source := net.ParseIP(host); source != nil {
				sourceValue = source.String()
			}
		}
	}
	mac := hmac.New(sha256.New, hashKey)
	_, _ = mac.Write([]byte(sourceValue))
	return hex.EncodeToString(mac.Sum(nil)[:16])
}

func writeStatus(response http.ResponseWriter, status int) {
	response.WriteHeader(status)
}

func validateConfiguration() error {
	if ingestion := os.Getenv(publicIngestionEnv); ingestion != "enabled" && ingestion != "disabled" {
		return errors.New("invalid public ingestion switch")
	}
	endpoint, parseError := url.ParseRequestURI(os.Getenv("GRAFANA_CLOUD_OTLP_ENDPOINT"))
	if parseError != nil || endpoint.Scheme != "https" || endpoint.User != nil || endpoint.RawQuery != "" || endpoint.Fragment != "" {
		return errors.New("invalid Grafana endpoint")
	}
	hostname := strings.ToLower(endpoint.Hostname())
	if !strings.HasSuffix(hostname, ".grafana.net") || (endpoint.Port() != "" && endpoint.Port() != "443") {
		return errors.New("invalid Grafana host")
	}
	if endpoint.EscapedPath() != "/otlp" {
		return errors.New("invalid Grafana OTLP path")
	}
	authorization := os.Getenv("GRAFANA_CLOUD_AUTHORIZATION")
	if len(authorization) > 4096 || !strings.HasPrefix(authorization, "Basic ") || strings.ContainsAny(authorization, "\r\n") {
		return errors.New("invalid Grafana authorization")
	}
	credentials, decodeError := base64.StdEncoding.DecodeString(strings.TrimPrefix(authorization, "Basic "))
	separator := bytes.IndexByte(credentials, ':')
	if decodeError != nil || separator <= 0 || separator == len(credentials)-1 {
		return errors.New("invalid Grafana credentials")
	}
	for _, character := range credentials[:separator] {
		if character < '0' || character > '9' {
			return errors.New("invalid Grafana instance ID")
		}
	}
	return nil
}

func fixedError(code string) {
	_, _ = os.Stderr.WriteString("threadnote-telemetry-gateway: " + code + "\n")
}
