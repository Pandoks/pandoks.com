package queue

import (
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"mime"
	"regexp"
	"slices"
	"strings"
	"time"
	"unicode/utf8"
)

// timeLayout is RFC 3339 in UTC with milliseconds, which Go, Python, and JS all write the same way.
const timeLayout = "2006-01-02T15:04:05.000Z07:00"

var (
	extensionName = regexp.MustCompile(`^[a-z0-9]{1,20}$`)
	rfc3339       = regexp.MustCompile(`^\d{4}-\d\d-\d\dT([01]\d|2[0-3]):\d\d:\d\d(\.\d+)?(Z|[+-]([01]\d|2[0-3]):[0-5]\d)$`)
	attributes    = []string{"specversion", "id", "source", "type", "time", "datacontenttype", "data", "data_base64"}
)

func isJSON(contentType string) bool {
	mediaType, _, err := mime.ParseMediaType(contentType)
	return err == nil && (mediaType == "application/json" || strings.HasSuffix(mediaType, "+json"))
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
		event["data"] = json.RawMessage(message.Data)
	default:
		event["data_base64"] = message.Data
	}
	// NOTE: unescaped <, >, and & keep the size the same as Python's and TS's encoders
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(event); err != nil {
		return nil, fmt.Errorf("encode message %s: %w", event["id"], err)
	}
	body := bytes.TrimSuffix(buffer.Bytes(), []byte("\n"))
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

// decode reads an envelope into the delivery's message and send time.
func decode(body []byte, delivery *Delivery) error {
	if !utf8.Valid(body) {
		return errors.New("decode envelope: not valid UTF-8")
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
	_, hasData := event["data"]
	_, hasBase64 := event["data_base64"]
	if hasData && hasBase64 {
		return fmt.Errorf("decode envelope %s: data and data_base64 are mutually exclusive", message.ID)
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
