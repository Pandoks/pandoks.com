package queue

import (
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"regexp"
	"slices"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	// timeLayout is RFC 3339 in UTC with milliseconds, which Go, Python, and JS all write the same way.
	timeLayout = "2006-01-02T15:04:05.000Z07:00"
	// maxDepth is how deeply an envelope, itself one level, may nest arrays and objects.
	maxDepth = 64
)

var (
	extensionName = regexp.MustCompile(`^[a-z0-9]{1,20}$`)
	rfc3339       = regexp.MustCompile(`^\d{4}-\d\d-\d\dT([01]\d|2[0-3]):\d\d:\d\d(\.\d+)?(Z|[+-]([01]\d|2[0-3]):[0-5]\d)$`)
	attributes    = []string{"specversion", "id", "source", "type", "time", "datacontenttype", "data", "data_base64"}
	// jsonEscape matches one escape in a JSON string, capturing a lone UTF-16 surrogate half
	jsonEscape = regexp.MustCompile(`\\(?:u[dD][89abAB][[:xdigit:]]{2}\\u[dD][c-fC-F][[:xdigit:]]{2}|(u[dD][89a-fA-F][[:xdigit:]]{2})|[^u]|u[[:xdigit:]]{4})`)
	// rewrites matches the \u2028 and \u2029 escapes encoding/json always writes, an escaped
	// backslash so the u after one isn't read as an escape, and the U+FFFE and U+FFFF it writes raw
	rewrites = regexp.MustCompile(`\\\\|\\u202[89]|[\x{FFFE}\x{FFFF}]`)
)

// isJSON trims only spaces and tabs and lowercases only ASCII, since Go, Python, and JS each trim
// and lowercase Unicode differently.
func isJSON(contentType string) bool {
	mediaType, _, _ := strings.Cut(contentType, ";")
	mediaType = strings.Map(func(character rune) rune {
		if 'A' <= character && character <= 'Z' {
			return character + 'a' - 'A'
		}
		return character
	}, strings.Trim(mediaType, " \t"))
	return mediaType == "application/json" || strings.HasSuffix(mediaType, "+json")
}

// encode writes message as a CloudEvents 1.0 structured JSON envelope sent at sentAt.
func encode(message Message, sentAt time.Time) ([]byte, error) {
	if message.Source == "" || message.Type == "" {
		return nil, errors.New("encode message: source and type are required")
	}
	for _, value := range append([]string{message.ID, message.Source, message.Type, message.ContentType}, slices.Collect(maps.Values(message.Extensions))...) {
		if !utf8.ValidString(value) {
			return nil, errors.New("encode message: id, source, type, content type, and extension values must be valid UTF-8")
		}
	}
	if err := checkDelay(message.Delay); err != nil {
		return nil, fmt.Errorf("encode message %s: %w", message.ID, err)
	}
	event := map[string]any{}
	for name, value := range message.Extensions {
		if !extensionName.MatchString(name) || slices.Contains(attributes, name) {
			return nil, fmt.Errorf("encode message: extension name %q must be [a-z0-9]{1,20} and not an attribute", name)
		}
		event[name] = value
	}
	maps.Copy(event, map[string]any{
		"specversion":     "1.0",
		"id":              message.ID,
		"source":          message.Source,
		"type":            message.Type,
		"time":            sentAt.UTC().Format(timeLayout),
		"datacontenttype": message.ContentType,
	})
	if message.ID == "" {
		event["id"] = rand.Text()
	}
	if message.ContentType == "" {
		event["datacontenttype"] = "application/json"
	}
	switch {
	case message.Data == nil:
	case isJSON(event["datacontenttype"].(string)):
		if !utf8.Valid(message.Data) || !finiteJSON(message.Data) {
			return nil, fmt.Errorf("encode message %s: data is not valid UTF-8 JSON with finite numbers", event["id"])
		}
		if 1+jsonDepth(message.Data) > maxDepth {
			return nil, fmt.Errorf("encode message %s: envelope nests over %d levels", event["id"], maxDepth)
		}
		event["data"] = json.RawMessage(message.Data)
	default:
		event["data_base64"] = message.Data
	}
	// NOTE: Python and TS write <, >, and & unescaped
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(event); err != nil {
		return nil, fmt.Errorf("encode message %s: %w", event["id"], err)
	}
	// NOTE: Python and TS write U+2028 and U+2029 unescaped, and SQS rejects U+FFFE and U+FFFF raw
	body := rewrites.ReplaceAllFunc(bytes.TrimSuffix(buffer.Bytes(), []byte("\n")), func(match []byte) []byte {
		switch string(match) {
		case `\u2028`:
			return []byte("\u2028")
		case `\u2029`:
			return []byte("\u2029")
		case "\uFFFE":
			return []byte(`\ufffe`)
		case "\uFFFF":
			return []byte(`\uffff`)
		}
		return match
	})
	if len(body) > MaxEnvelopeBytes {
		return nil, fmt.Errorf("encode message %s: envelope is %d bytes, over %d", event["id"], len(body), MaxEnvelopeBytes)
	}
	return body, nil
}

// finiteJSON reports whether data is valid JSON whose numbers all fit a float64, as Python and TS
// require.
func finiteJSON(data []byte) bool {
	return json.Unmarshal(data, new(any)) == nil
}

// jsonDepth returns how deeply valid JSON nests arrays and objects.
func jsonDepth(data []byte) int {
	depth, deepest, inString := 0, 0, false
	for index := 0; index < len(data); index++ {
		switch character := data[index]; {
		case inString && character == '\\':
			index++
		case character == '"':
			inString = !inString
		case inString:
		case character == '[' || character == '{':
			depth++
			deepest = max(deepest, depth)
		case character == ']' || character == '}':
			depth--
		}
	}
	return deepest
}

// hasLoneSurrogate reports whether a JSON string escapes half a surrogate pair, which encoding/json
// reads as U+FFFD while Python and TS keep it.
func hasLoneSurrogate(raw []byte) bool {
	for _, match := range jsonEscape.FindAllSubmatchIndex(raw, -1) {
		if match[2] >= 0 {
			return true
		}
	}
	return false
}

// decode reads an envelope into the delivery's message and send time.
func decode(body []byte, delivery *Delivery) error {
	if !utf8.Valid(body) {
		return errors.New("decode envelope: not valid UTF-8")
	}
	if jsonDepth(body) > maxDepth {
		return fmt.Errorf("decode envelope: nests over %d levels", maxDepth)
	}
	var event map[string]json.RawMessage
	if err := json.Unmarshal(body, &event); err != nil {
		return fmt.Errorf("decode envelope: %w", err)
	}
	members := map[string]string{}
	for name, raw := range event {
		if name == "data" {
			continue
		}
		var value *string
		if err := json.Unmarshal(raw, &value); err != nil || value == nil {
			return fmt.Errorf("decode envelope: %s is not a string", name)
		}
		if hasLoneSurrogate(raw) {
			return fmt.Errorf("decode envelope: %s escapes half a UTF-16 surrogate pair", name)
		}
		if !slices.Contains(attributes, name) && !extensionName.MatchString(name) {
			return fmt.Errorf("decode envelope: extension name %q is not [a-z0-9]{1,20}", name)
		}
		members[name] = *value
	}
	if members["specversion"] != "1.0" || members["id"] == "" || members["source"] == "" || members["type"] == "" {
		return errors.New("decode envelope: specversion 1.0, id, source, and type are required")
	}
	// NOTE: time.Parse also takes offsets like +24:00, comma fractions, and year 0000, which Python rejects
	if !rfc3339.MatchString(members["time"]) || strings.HasPrefix(members["time"], "0000") {
		return fmt.Errorf("decode envelope %s: time %q is not RFC 3339", members["id"], members["time"])
	}
	sentAt, err := time.Parse(time.RFC3339Nano, members["time"])
	if err != nil {
		return fmt.Errorf("decode envelope %s: %w", members["id"], err)
	}
	message := Message{ID: members["id"], Source: members["source"], Type: members["type"], ContentType: "application/json"}
	if contentType, ok := members["datacontenttype"]; ok {
		message.ContentType = contentType
	}
	contradicting := "data_base64"
	if !isJSON(message.ContentType) {
		contradicting = "data"
	}
	if _, ok := event[contradicting]; ok {
		return fmt.Errorf("decode envelope %s: %s contradicts datacontenttype %q", message.ID, contradicting, message.ContentType)
	}
	if encoded, ok := members["data_base64"]; ok {
		// NOTE: DecodeString skips CR and LF, so only canonical base64 round-trips
		message.Data, err = base64.StdEncoding.DecodeString(encoded)
		if err != nil || base64.StdEncoding.EncodeToString(message.Data) != encoded {
			return fmt.Errorf("decode envelope %s: data_base64 is not canonical base64", message.ID)
		}
	} else if raw, ok := event["data"]; ok {
		if !finiteJSON(raw) {
			return fmt.Errorf("decode envelope %s: data has a number past float64's range", message.ID)
		}
		message.Data = raw
	}
	for name, value := range members {
		if !slices.Contains(attributes, name) {
			if message.Extensions == nil {
				message.Extensions = map[string]string{}
			}
			message.Extensions[name] = value
		}
	}
	delivery.Message, delivery.Time = message, sentAt
	return nil
}
