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
)

// timeLayout is RFC 3339 in UTC with milliseconds, which Go, Python, and JS all write the same way.
const timeLayout = "2006-01-02T15:04:05.000Z07:00"

var (
	extensionName = regexp.MustCompile(`^[a-z0-9]{1,20}$`)
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
		if !json.Valid(message.Data) {
			return nil, fmt.Errorf("encode message %s: data is not valid JSON", event["id"])
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

// decode reads an envelope into the delivery's message and send time.
func decode(body []byte, delivery *Delivery) error {
	var event map[string]json.RawMessage
	if err := json.Unmarshal(body, &event); err != nil {
		return fmt.Errorf("decode envelope: %w", err)
	}
	members := map[string]string{}
	for name, raw := range event {
		if name == "data" || name == "data_base64" {
			continue
		}
		var value string
		if err := json.Unmarshal(raw, &value); err != nil {
			return fmt.Errorf("decode envelope: %s is not a string", name)
		}
		members[name] = value
	}
	if members["specversion"] != "1.0" || members["id"] == "" || members["source"] == "" || members["type"] == "" {
		return errors.New("decode envelope: specversion 1.0, id, source, and type are required")
	}
	sentAt, err := time.Parse(time.RFC3339Nano, members["time"])
	if err != nil {
		return fmt.Errorf("decode envelope %s: %w", members["id"], err)
	}
	message := Message{ID: members["id"], Source: members["source"], Type: members["type"], ContentType: members["datacontenttype"]}
	if message.ContentType == "" {
		message.ContentType = "application/json"
	}
	if raw, ok := event["data_base64"]; ok {
		var encoded string
		if err := json.Unmarshal(raw, &encoded); err != nil {
			return fmt.Errorf("decode envelope %s: data_base64 is not a string", message.ID)
		}
		if message.Data, err = base64.StdEncoding.DecodeString(encoded); err != nil {
			return fmt.Errorf("decode envelope %s: %w", message.ID, err)
		}
	} else if raw, ok := event["data"]; ok {
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
