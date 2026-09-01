package rtcsidecar

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/pion/webrtc/v4"
)

const (
	defaultConnectTimeout = 30 * time.Second
	defaultDialTimeout    = 10 * time.Second
	defaultIOTimeout      = 120 * time.Second
	maxMappingBytes       = 64
	maxLabelBytes         = 256
	maxProtocolBytes      = 256
	maxICEServers         = 16
	maxURLsPerServer      = 8
	maxURLBytes           = 2048
	maxUsernameBytes      = 512
	maxCredentialBytes    = 2048
	maxSCTPReceiveBuffer  = 4 << 20
)

type stringList []string

func (values *stringList) UnmarshalJSON(raw []byte) error {
	var one string
	if err := json.Unmarshal(raw, &one); err == nil {
		*values = stringList{one}
		return nil
	}
	var many []string
	decoder := json.NewDecoder(bytes.NewReader(raw))
	if err := decoder.Decode(&many); err != nil {
		return errorsWithMessage("urls must be a string or string array", err)
	}
	*values = stringList(many)
	return nil
}

type iceServerWire struct {
	URLs           stringList `json:"urls"`
	Username       string     `json:"username,omitempty"`
	Credential     *string    `json:"credential,omitempty"`
	CredentialType string     `json:"credentialType,omitempty"`
}

type rtcConfigurationWire struct {
	ICEServers         []iceServerWire `json:"iceServers,omitempty"`
	ICETransportPolicy string          `json:"iceTransportPolicy,omitempty"`
}

type localConfiguration struct {
	Mode                 string `json:"mode"`
	Host                 string `json:"host,omitempty"`
	Port                 int    `json:"port"`
	ConnectOn            string `json:"connectOn,omitempty"`
	ConnectTimeoutMillis *int64 `json:"connectTimeoutMs,omitempty"`
}

type channelConfiguration struct {
	Mapping  string             `json:"mapping"`
	Label    string             `json:"label"`
	Protocol string             `json:"protocol"`
	Local    localConfiguration `json:"local"`
}

type validatedStart struct {
	role           string
	rtc            webrtc.Configuration
	connectTimeout time.Duration
	channels       []validatedChannel
}

type validatedChannel struct {
	mapping     string
	label       string
	protocol    string
	mode        string
	host        string
	port        int
	connectOn   string
	dialTimeout time.Duration
}

func validateStart(request *startRequest) (*validatedStart, *protocolError) {
	if request.Role != "offerer" && request.Role != "answerer" {
		return nil, invalidStart("role must be offerer or answerer")
	}
	if len(request.Channels) < 1 || len(request.Channels) > MaxChannels {
		return nil, invalidStart(fmt.Sprintf("channels must contain 1..%d mappings", MaxChannels))
	}
	connectTimeout, err := durationMillis(
		request.ConnectTimeoutMillis,
		defaultConnectTimeout,
		"connectTimeoutMs",
		true,
	)
	if err != nil {
		return nil, invalidStart(err.Error())
	}
	rtc, err := validateRTCConfiguration(request.RTCConfiguration)
	if err != nil {
		return nil, invalidStart(err.Error())
	}
	validated := &validatedStart{
		role:           request.Role,
		rtc:            rtc,
		connectTimeout: connectTimeout,
		channels:       make([]validatedChannel, 0, len(request.Channels)),
	}
	mappings := make(map[string]struct{}, len(request.Channels))
	labels := make(map[string]struct{}, len(request.Channels))
	for index, channel := range request.Channels {
		entry, err := validateChannel(channel)
		if err != nil {
			return nil, invalidStart(fmt.Sprintf("channels[%d]: %s", index, err))
		}
		if _, exists := mappings[entry.mapping]; exists {
			return nil, invalidStart(fmt.Sprintf("duplicate mapping %q", entry.mapping))
		}
		if _, exists := labels[entry.label]; exists {
			return nil, invalidStart(fmt.Sprintf("duplicate DataChannel label %q", entry.label))
		}
		mappings[entry.mapping] = struct{}{}
		labels[entry.label] = struct{}{}
		validated.channels = append(validated.channels, entry)
	}
	return validated, nil
}

func validateChannel(channel channelConfiguration) (validatedChannel, error) {
	if !requestIDPattern.MatchString(channel.Mapping) || len(channel.Mapping) > maxMappingBytes {
		return validatedChannel{}, fmt.Errorf("mapping must be 1..%d safe ASCII characters", maxMappingBytes)
	}
	if channel.Label == "" || !utf8.ValidString(channel.Label) || len([]byte(channel.Label)) > maxLabelBytes {
		return validatedChannel{}, fmt.Errorf("label must be valid UTF-8 and 1..%d bytes", maxLabelBytes)
	}
	if !utf8.ValidString(channel.Protocol) || len([]byte(channel.Protocol)) > maxProtocolBytes {
		return validatedChannel{}, fmt.Errorf("protocol must be valid UTF-8 and at most %d bytes", maxProtocolBytes)
	}
	if channel.Local.Mode != "listen" && channel.Local.Mode != "dial" {
		return validatedChannel{}, errorsWithMessage("local.mode must be listen or dial", nil)
	}
	host := channel.Local.Host
	if host == "" {
		host = "127.0.0.1"
	}
	ip := net.ParseIP(host)
	if ip == nil || !ip.IsLoopback() {
		return validatedChannel{}, errorsWithMessage("local.host must be a literal loopback IP address", nil)
	}
	if channel.Local.Mode == "listen" {
		if channel.Local.ConnectOn != "" {
			return validatedChannel{}, errorsWithMessage("local.connectOn is valid only for dial mappings", nil)
		}
		if channel.Local.ConnectTimeoutMillis != nil {
			return validatedChannel{}, errorsWithMessage("local.connectTimeoutMs is valid only for dial mappings", nil)
		}
		if channel.Local.Port < 0 || channel.Local.Port > 65535 {
			return validatedChannel{}, errorsWithMessage("listen port must be between 0 and 65535", nil)
		}
	} else if channel.Local.Port < 1 || channel.Local.Port > 65535 {
		return validatedChannel{}, errorsWithMessage("dial port must be between 1 and 65535", nil)
	}
	connectOn := ""
	if channel.Local.Mode == "dial" {
		connectOn = channel.Local.ConnectOn
		if connectOn == "" {
			connectOn = "open"
		}
		if connectOn != "open" && connectOn != "first-data" {
			return validatedChannel{}, errorsWithMessage("local.connectOn must be open or first-data", nil)
		}
	}
	dialTimeout, err := durationMillis(
		channel.Local.ConnectTimeoutMillis,
		defaultDialTimeout,
		"local.connectTimeoutMs",
		false,
	)
	if err != nil {
		return validatedChannel{}, err
	}
	return validatedChannel{
		mapping:     channel.Mapping,
		label:       channel.Label,
		protocol:    channel.Protocol,
		mode:        channel.Local.Mode,
		host:        ip.String(),
		port:        channel.Local.Port,
		connectOn:   connectOn,
		dialTimeout: dialTimeout,
	}, nil
}

func validateRTCConfiguration(configuration rtcConfigurationWire) (webrtc.Configuration, error) {
	if len(configuration.ICEServers) > maxICEServers {
		return webrtc.Configuration{}, fmt.Errorf("iceServers exceeds %d entries", maxICEServers)
	}
	policy := webrtc.ICETransportPolicyAll
	switch configuration.ICETransportPolicy {
	case "", "all":
	case "relay":
		policy = webrtc.ICETransportPolicyRelay
	default:
		return webrtc.Configuration{}, errorsWithMessage("iceTransportPolicy must be all or relay", nil)
	}
	result := webrtc.Configuration{ICETransportPolicy: policy}
	for index, server := range configuration.ICEServers {
		if len(server.URLs) < 1 || len(server.URLs) > maxURLsPerServer {
			return webrtc.Configuration{}, fmt.Errorf(
				"iceServers[%d].urls must contain 1..%d entries",
				index,
				maxURLsPerServer,
			)
		}
		for _, rawURL := range server.URLs {
			if len(rawURL) == 0 || len(rawURL) > maxURLBytes {
				return webrtc.Configuration{}, fmt.Errorf("iceServers[%d] contains an invalid URL length", index)
			}
			lower := strings.ToLower(rawURL)
			if !strings.HasPrefix(lower, "stun:") &&
				!strings.HasPrefix(lower, "stuns:") &&
				!strings.HasPrefix(lower, "turn:") &&
				!strings.HasPrefix(lower, "turns:") {
				return webrtc.Configuration{}, fmt.Errorf("iceServers[%d] contains an unsupported URL scheme", index)
			}
		}
		if len(server.Username) > maxUsernameBytes {
			return webrtc.Configuration{}, fmt.Errorf("iceServers[%d].username is too large", index)
		}
		if server.Credential != nil && len(*server.Credential) > maxCredentialBytes {
			return webrtc.Configuration{}, fmt.Errorf("iceServers[%d].credential is too large", index)
		}
		if server.CredentialType != "" && server.CredentialType != "password" {
			return webrtc.Configuration{}, fmt.Errorf("iceServers[%d] supports only password credentials", index)
		}
		pionServer := webrtc.ICEServer{
			URLs:           []string(server.URLs),
			Username:       server.Username,
			CredentialType: webrtc.ICECredentialTypePassword,
		}
		if server.Credential != nil {
			pionServer.Credential = *server.Credential
		}
		result.ICEServers = append(result.ICEServers, pionServer)
	}
	return result, nil
}

func durationMillis(raw *int64, fallback time.Duration, name string, allowZero bool) (time.Duration, error) {
	if raw == nil {
		return fallback, nil
	}
	if *raw < 0 || (!allowZero && *raw == 0) {
		if allowZero {
			return 0, fmt.Errorf("%s must be a non-negative integer", name)
		}
		return 0, fmt.Errorf("%s must be a positive integer", name)
	}
	maximumMillis := int64((24 * time.Hour) / time.Millisecond)
	if *raw > maximumMillis {
		return 0, fmt.Errorf("%s exceeds the 24 hour maximum", name)
	}
	return time.Duration(*raw) * time.Millisecond, nil
}

func invalidStart(message string) *protocolError {
	return newProtocolError("invalid-message", message, false, nil)
}

func errorsWithMessage(message string, cause error) error {
	if cause == nil {
		return fmt.Errorf("%s", message)
	}
	return fmt.Errorf("%s: %w", message, cause)
}
