// Command canary proves that one privacy-safe synthetic trace traverses the
// public Threadnote gateway and becomes queryable in Grafana Cloud Tempo.
package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
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
	_, _ = fmt.Fprintln(os.Stdout, "threadnote-telemetry-canary: trace stored")
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
	ids, err := newIDs()
	if err != nil {
		return errors.New("generate random identifiers")
	}
	started := now().UTC()
	payload := buildEnvelope(ids, started)
	if err := postTrace(ctx, configuration, client, payload); err != nil {
		return err
	}
	deadline := started.Add(configuration.queryDeadline)
	for {
		stored, err := queryTrace(ctx, configuration, client, ids, started, now().UTC())
		if err != nil {
			return err
		}
		if stored {
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
	ids canaryIDs,
	started time.Time,
	now time.Time,
) (bool, error) {
	queryURL := *configuration.tempoURL
	queryURL.Path = strings.TrimSuffix(queryURL.Path, "/") + "/api/v2/traces/" + hex.EncodeToString(ids.traceID)
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
	if !validStoredTrace(body, ids) {
		return false, errors.New("Tempo returned a trace outside the canary contract")
	}
	return true, nil
}

func validStoredTrace(body []byte, ids canaryIDs) bool {
	response, err := parseMessage(body)
	if err != nil {
		return false
	}
	for _, trace := range response.messages(1) {
		for _, resourceSpans := range trace.messages(1) {
			resources := resourceSpans.messages(1)
			if len(resources) != 1 {
				continue
			}
			resource, valid := protoAttributes(resources[0].messages(1))
			if !valid || resource["service.name"] != "threadnote" || resource["service.version"] != canaryVersion || resource["session.id"] != ids.sessionID {
				continue
			}
			for _, scopeSpans := range resourceSpans.messages(2) {
				for _, span := range scopeSpans.messages(2) {
					attributes, valid := protoAttributes(span.messages(9))
					if valid && bytes.Equal(span.firstBytes(1), ids.traceID) && string(span.firstBytes(5)) == "threadnote.anonymous-diagnostic" &&
						attributes["threadnote.component"] == "cli" && attributes["threadnote.operation"] == "health" &&
						attributes["threadnote.event"] == "completion" && attributes["threadnote.outcome"] == "success" {
						return true
					}
				}
			}
		}
	}
	return false
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

func buildEnvelope(ids canaryIDs, timestamp time.Time) []byte {
	resource := message(1, keyValue("service.name", stringValue("threadnote")))
	resource = append(resource, message(1, keyValue("service.version", stringValue(canaryVersion)))...)
	resource = append(resource, message(1, keyValue("session.id", stringValue(ids.sessionID)))...)
	resource = append(resource, message(1, keyValue("threadnote.session.scope", stringValue("invocation")))...)
	resource = append(resource, message(1, keyValue("threadnote.telemetry.schema_version", intValue(1)))...)
	scope := message(1, []byte("threadnote"))
	span := bytesField(1, ids.traceID)
	span = append(span, bytesField(2, ids.spanID)...)
	span = append(span, message(5, []byte("threadnote.anonymous-diagnostic"))...)
	span = append(span, varintField(6, 1)...)
	nanoseconds := uint64(timestamp.UnixNano())
	span = append(span, fixed64Field(7, nanoseconds)...)
	span = append(span, fixed64Field(8, nanoseconds+1_000_000)...)
	for _, attribute := range []struct{ key, value string }{
		{"threadnote.component", "cli"},
		{"threadnote.event", "completion"},
		{"threadnote.operation", "health"},
		{"threadnote.runtime.architecture", "synthetic"},
		{"threadnote.runtime.platform", "synthetic"},
		{"threadnote.runtime.version", canaryVersion},
		{"threadnote.outcome", "success"},
	} {
		span = append(span, message(9, keyValue(attribute.key, stringValue(attribute.value)))...)
	}
	span = append(span, message(9, keyValue("threadnote.duration_ms", intValue(1)))...)
	span = append(span, message(15, varintField(3, 1))...)
	scopeSpans := message(1, scope)
	scopeSpans = append(scopeSpans, message(2, span)...)
	resourceSpans := message(1, resource)
	resourceSpans = append(resourceSpans, message(2, scopeSpans)...)
	return message(1, resourceSpans)
}

type protoMessage map[uint64][][]byte

func parseMessage(payload []byte) (protoMessage, error) {
	message := make(protoMessage)
	for len(payload) > 0 {
		key, consumed, ok := readVarint(payload)
		if !ok || key == 0 {
			return nil, errors.New("invalid protobuf key")
		}
		payload = payload[consumed:]
		field := key >> 3
		switch key & 7 {
		case 0:
			_, consumed, ok = readVarint(payload)
			if !ok {
				return nil, errors.New("invalid protobuf varint")
			}
			payload = payload[consumed:]
		case 1:
			if len(payload) < 8 {
				return nil, errors.New("invalid protobuf fixed64")
			}
			payload = payload[8:]
		case 2:
			length, lengthBytes, lengthOK := readVarint(payload)
			if !lengthOK || length > uint64(len(payload)-lengthBytes) {
				return nil, errors.New("invalid protobuf bytes")
			}
			start, end := lengthBytes, lengthBytes+int(length)
			message[field] = append(message[field], payload[start:end])
			payload = payload[end:]
		case 5:
			if len(payload) < 4 {
				return nil, errors.New("invalid protobuf fixed32")
			}
			payload = payload[4:]
		default:
			return nil, errors.New("unsupported protobuf wire type")
		}
	}
	return message, nil
}

func (message protoMessage) messages(field uint64) []protoMessage {
	result := make([]protoMessage, 0, len(message[field]))
	for _, payload := range message[field] {
		parsed, err := parseMessage(payload)
		if err == nil {
			result = append(result, parsed)
		}
	}
	return result
}

func (message protoMessage) firstBytes(field uint64) []byte {
	if len(message[field]) == 0 {
		return nil
	}
	return message[field][0]
}

func protoAttributes(attributes []protoMessage) (map[string]string, bool) {
	values := make(map[string]string, len(attributes))
	for _, attribute := range attributes {
		key := string(attribute.firstBytes(1))
		anyValues := attribute.messages(2)
		if key == "" || len(anyValues) != 1 {
			return nil, false
		}
		// The canary's identity fields are strings. Numeric attributes such as
		// schema_version and duration_ms are valid but irrelevant to this readback.
		if len(anyValues[0][1]) == 1 {
			values[key] = string(anyValues[0][1][0])
		}
	}
	return values, true
}

func readVarint(payload []byte) (uint64, int, bool) {
	var value uint64
	for index, current := range payload {
		if index == 10 || (index == 9 && current > 1) {
			return 0, 0, false
		}
		value |= uint64(current&0x7f) << (7 * index)
		if current&0x80 == 0 {
			return value, index + 1, true
		}
	}
	return 0, 0, false
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
