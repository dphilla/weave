package rtcsidecar

import (
	"fmt"
	"testing"
	"time"
)

func validStartRequest() *startRequest {
	return &startRequest{
		Version: 1,
		ID:      "start-1",
		Command: "start",
		Role:    "offerer",
		Channels: []channelConfiguration{
			{
				Mapping:  "out",
				Label:    "files",
				Protocol: "example.files.v1",
				Local: localConfiguration{
					Mode: "listen",
					Host: "127.0.0.1",
					Port: 0,
				},
			},
		},
	}
}

func TestValidateStartDefaultsAndBounds(t *testing.T) {
	request := validStartRequest()
	validated, protocolErr := validateStart(request)
	if protocolErr != nil {
		t.Fatalf("validate: %v", protocolErr)
	}
	if validated.connectTimeout != defaultConnectTimeout {
		t.Fatalf("connect timeout = %s, want %s", validated.connectTimeout, defaultConnectTimeout)
	}
	if validated.channels[0].host != "127.0.0.1" || validated.channels[0].mode != "listen" {
		t.Fatalf("validated channel = %#v", validated.channels[0])
	}

	request.Channels = nil
	if _, err := validateStart(request); err == nil {
		t.Fatal("zero channels accepted")
	}
	request = validStartRequest()
	request.Channels = make([]channelConfiguration, MaxChannels)
	for index := range request.Channels {
		request.Channels[index] = channelConfiguration{
			Mapping:  fmt.Sprintf("m-%d", index),
			Label:    fmt.Sprintf("label-%d", index),
			Protocol: "p",
			Local:    localConfiguration{Mode: "listen", Host: "127.0.0.1"},
		}
	}
	if _, err := validateStart(request); err != nil {
		t.Fatalf("exact channel maximum rejected: %v", err)
	}
	request.Channels = append(request.Channels, channelConfiguration{
		Mapping:  "overflow",
		Label:    "overflow",
		Protocol: "p",
		Local:    localConfiguration{Mode: "listen", Host: "127.0.0.1"},
	})
	if _, err := validateStart(request); err == nil {
		t.Fatal("too many channels accepted")
	}
}

func TestValidateDialConnectTriggers(t *testing.T) {
	for _, test := range []struct {
		name       string
		configured string
		expected   string
	}{
		{name: "default open", expected: "open"},
		{name: "explicit open", configured: "open", expected: "open"},
		{name: "first data", configured: "first-data", expected: "first-data"},
	} {
		t.Run(test.name, func(t *testing.T) {
			request := validStartRequest()
			request.Channels[0].Local = localConfiguration{
				Mode:      "dial",
				Host:      "::1",
				Port:      9000,
				ConnectOn: test.configured,
			}
			validated, err := validateStart(request)
			if err != nil {
				t.Fatalf("validate: %v", err)
			}
			if validated.channels[0].connectOn != test.expected {
				t.Fatalf("connectOn = %q, want %q", validated.channels[0].connectOn, test.expected)
			}
		})
	}

	request := validStartRequest()
	request.Channels[0].Local.ConnectOn = "first-data"
	if _, err := validateStart(request); err == nil {
		t.Fatal("connectOn accepted for listen mapping")
	}
	request = validStartRequest()
	timeout := int64(time.Second / time.Millisecond)
	request.Channels[0].Local.ConnectTimeoutMillis = &timeout
	if _, err := validateStart(request); err == nil {
		t.Fatal("connectTimeoutMs accepted for listen mapping")
	}
	request = validStartRequest()
	request.Channels[0].Local = localConfiguration{Mode: "dial", Host: "127.0.0.1", Port: 9000, ConnectOn: "later"}
	if _, err := validateStart(request); err == nil {
		t.Fatal("unknown dial connectOn accepted")
	}
}

func TestValidateStartRejectsAmbiguousOrUnsafeConfiguration(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*startRequest)
	}{
		{
			name: "non-loopback target",
			mutate: func(request *startRequest) {
				request.Channels[0].Local.Host = "192.0.2.1"
			},
		},
		{
			name: "hostname target",
			mutate: func(request *startRequest) {
				request.Channels[0].Local.Host = "localhost"
			},
		},
		{
			name: "duplicate mapping",
			mutate: func(request *startRequest) {
				request.Channels = append(request.Channels, request.Channels[0])
				request.Channels[1].Label = "another"
			},
		},
		{
			name: "duplicate label",
			mutate: func(request *startRequest) {
				request.Channels = append(request.Channels, request.Channels[0])
				request.Channels[1].Mapping = "another"
			},
		},
		{
			name: "unsupported ICE URL",
			mutate: func(request *startRequest) {
				request.RTCConfiguration.ICEServers = []iceServerWire{{URLs: stringList{"https://example.test"}}}
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := validStartRequest()
			test.mutate(request)
			if _, err := validateStart(request); err == nil {
				t.Fatal("unsafe configuration accepted")
			}
		})
	}
}
