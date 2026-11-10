package queue

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"os"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/sns"
	"github.com/aws/aws-sdk-go-v2/service/sqs"
	sqstypes "github.com/aws/aws-sdk-go-v2/service/sqs/types"
	"github.com/valkey-io/valkey-go"
)

// The brokers come from compose.yaml; Cloudflare has no emulator, so CI creates its queues.
const (
	valkeyAddress = "127.0.0.1:16379"
	motoEndpoint  = "http://127.0.0.1:15000"
	motoAccount   = "123456789012"
	region        = "us-west-1"
)

// broker is one adapter's queue, its dead letters, and a topic with two subscriptions.
type broker struct {
	lease         time.Duration
	maxAttempts   int
	queue         Queue
	deadLetters   func(t *testing.T) []string
	topic         Topic
	subscriptions []Queue
}

func TestValkeyContract(t *testing.T) {
	suffix := strings.ToLower(rand.Text()[:10])
	base := "valkey://client:client@" + valkeyAddress + "/"
	client := valkeyTestClient(t)
	runContract(t, broker{
		lease:       500 * time.Millisecond,
		maxAttempts: 3,
		queue:       openQueue(t, base+"q"+suffix+"?lease=500ms&max_attempts=3"),
		deadLetters: func(t *testing.T) []string {
			entries, err := client.Do(t.Context(), client.B().Xrange().Key("{q"+suffix+"}:dlq").Start("-").End("+").Build()).AsXRange()
			if err != nil {
				t.Fatal(err)
			}
			var ids []string
			for _, entry := range entries {
				var delivery Delivery
				if err := decode([]byte(entry.FieldValues["envelope"]), &delivery); err != nil {
					t.Fatal(err)
				}
				ids = append(ids, delivery.ID)
			}
			return ids
		},
		topic: openTopic(t, base+"t"+suffix),
		subscriptions: []Queue{
			openQueue(t, base+"t"+suffix+"?subscription=a&lease=500ms&max_attempts=3"),
			openQueue(t, base+"t"+suffix+"?subscription=b&lease=500ms&max_attempts=3"),
		},
	})
}

func valkeyTestClient(t *testing.T) valkey.Client {
	t.Helper()
	client, err := valkey.NewClient(valkey.ClientOption{InitAddress: []string{valkeyAddress}, Username: "client", Password: "client", DisableCache: true})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(client.Close)
	return client
}

func TestSQSContract(t *testing.T) {
	t.Setenv("AWS_ACCESS_KEY_ID", "test")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "test")
	cfg := aws.Config{Region: region, BaseEndpoint: aws.String(motoEndpoint), Credentials: credentials.NewStaticCredentialsProvider("test", "test", "")}
	sqsClient, snsClient := sqs.NewFromConfig(cfg), sns.NewFromConfig(cfg)
	suffix := strings.ToLower(rand.Text()[:10])
	queueURL := func(name string) string {
		return "awssqs://sqs." + region + ".amazonaws.com/" + motoAccount + "/" + name + "?lease=1s&endpoint=" + motoEndpoint
	}
	createQueue := func(name string, attributes map[string]string) string {
		output, err := sqsClient.CreateQueue(t.Context(), &sqs.CreateQueueInput{QueueName: aws.String(name), Attributes: attributes})
		if err != nil {
			t.Fatal(err)
		}
		attributesOutput, err := sqsClient.GetQueueAttributes(t.Context(), &sqs.GetQueueAttributesInput{QueueUrl: output.QueueUrl, AttributeNames: []sqstypes.QueueAttributeName{sqstypes.QueueAttributeNameQueueArn}})
		if err != nil {
			t.Fatal(err)
		}
		return attributesOutput.Attributes["QueueArn"]
	}

	dlqARN := createQueue("dlq-"+suffix, nil)
	createQueue("q-"+suffix, map[string]string{"RedrivePolicy": `{"deadLetterTargetArn":"` + dlqARN + `","maxReceiveCount":"3"}`})
	topic, err := snsClient.CreateTopic(t.Context(), &sns.CreateTopicInput{Name: aws.String("t-" + suffix)})
	if err != nil {
		t.Fatal(err)
	}
	var subscriptions []Queue
	for _, name := range []string{"a", "b"} {
		arn := createQueue("t-"+suffix+"-"+name, nil)
		if _, err := snsClient.Subscribe(t.Context(), &sns.SubscribeInput{
			TopicArn: topic.TopicArn, Protocol: aws.String("sqs"), Endpoint: aws.String(arn),
			Attributes: map[string]string{"RawMessageDelivery": "true"},
		}); err != nil {
			t.Fatal(err)
		}
		subscriptions = append(subscriptions, openQueue(t, queueURL("t-"+suffix+"-"+name)))
	}

	dlq := openQueue(t, queueURL("dlq-"+suffix))
	runContract(t, broker{
		lease:         time.Second,
		maxAttempts:   3,
		queue:         openQueue(t, queueURL("q-"+suffix)),
		deadLetters:   func(t *testing.T) []string { return receivedIDs(t, dlq) },
		topic:         openTopic(t, "awssns:///"+aws.ToString(topic.TopicArn)+"?endpoint="+motoEndpoint),
		subscriptions: subscriptions,
	})
}

// TestCloudflareContract runs against queues the CI job creates, each with an HTTP pull
// consumer; the main queue dead-letters to the second after max_retries 2.
func TestCloudflareContract(t *testing.T) {
	account := os.Getenv("CLOUDFLARE_ACCOUNT_ID")
	queueID, dlqID, subscriptionID := os.Getenv("QUEUE_TEST_CLOUDFLARE_QUEUE"), os.Getenv("QUEUE_TEST_CLOUDFLARE_DLQ"), os.Getenv("QUEUE_TEST_CLOUDFLARE_SUBSCRIPTION")
	if queueID == "" {
		t.Skip("QUEUE_TEST_CLOUDFLARE_QUEUE is not set; the tests.yaml Cloudflare job sets it")
	}
	base := "cloudflare://" + account + "/"
	dlq := openQueue(t, base+dlqID+"?lease=5s")
	runContract(t, broker{
		lease:         5 * time.Second,
		maxAttempts:   3,
		queue:         openQueue(t, base+queueID+"?lease=5s"),
		deadLetters:   func(t *testing.T) []string { return receivedIDs(t, dlq) },
		topic:         openTopic(t, base+queueID+","+subscriptionID),
		subscriptions: []Queue{openQueue(t, base+queueID+"?lease=5s"), openQueue(t, base+subscriptionID+"?lease=5s")},
	})
}

func openQueue(t *testing.T, rawURL string) Queue {
	t.Helper()
	queue, err := Open(t.Context(), rawURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = queue.Close() })
	return queue
}

func openTopic(t *testing.T, rawURL string) Topic {
	t.Helper()
	topic, err := OpenTopic(t.Context(), rawURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = topic.Close() })
	return topic
}

// receive collects deliveries of the wanted ids until all arrive or timeout passes, acking any
// other message (a leftover from an earlier run). It returns what arrived.
func receive(t *testing.T, queue Queue, timeout time.Duration, ids ...string) map[string]*Delivery {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), timeout)
	defer cancel()
	got := map[string]*Delivery{}
	for len(got) < len(ids) {
		deliveries, err := queue.Receive(ctx, 10)
		if ctx.Err() != nil {
			return got
		}
		if err != nil {
			t.Fatal(err)
		}
		for _, delivery := range deliveries {
			if !slices.Contains(ids, delivery.ID) {
				if err := queue.Ack(t.Context(), delivery); err != nil {
					t.Fatal(err)
				}
				continue
			}
			got[delivery.ID] = delivery
		}
	}
	return got
}

func receivedIDs(t *testing.T, queue Queue) []string {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	deliveries, err := queue.Receive(ctx, 10)
	if err != nil && !errors.Is(ctx.Err(), context.DeadlineExceeded) {
		t.Fatal(err)
	}
	var ids []string
	for _, delivery := range deliveries {
		ids = append(ids, delivery.ID)
		if err := queue.Ack(t.Context(), delivery); err != nil {
			t.Fatal(err)
		}
	}
	return ids
}

func testMessage(name string) Message {
	return Message{ID: name + "-" + rand.Text(), Source: "//pandoks.com/queue/test", Type: "com.pandoks.queue.test", Data: []byte(`{"case":"` + name + `"}`)}
}

func runContract(t *testing.T, broker broker) {
	wait := 30 * time.Second

	t.Run("sends, receives, and acks golden envelopes", func(t *testing.T) {
		sent := map[string]Message{}
		for name, body := range fixtures(t) {
			var fixture Delivery
			if err := decode(body, &fixture); err != nil {
				t.Fatal(err)
			}
			fixture.ID += "-" + rand.Text()
			sent[fixture.ID] = fixture.Message
			t.Logf("%s as %s", name, fixture.ID)
		}
		var messages []Message
		var ids []string
		for id, message := range sent {
			messages, ids = append(messages, message), append(ids, id)
		}
		if err := broker.queue.Send(t.Context(), messages...); err != nil {
			t.Fatal(err)
		}
		got := receive(t, broker.queue, wait, ids...)
		for id, message := range sent {
			delivery := got[id]
			if delivery == nil {
				t.Fatalf("%s never arrived", id)
			}
			if delivery.Attempt != 1 || time.Since(delivery.Time) > time.Minute || time.Until(delivery.Deadline) > broker.lease {
				t.Errorf("%s: attempt %d, time %v, deadline %v", id, delivery.Attempt, delivery.Time, delivery.Deadline)
			}
			gotEnvelope, err := encode(delivery.Message, delivery.Time)
			if err != nil {
				t.Fatal(err)
			}
			wantEnvelope, err := encode(message, delivery.Time)
			if err != nil {
				t.Fatal(err)
			}
			jsonEqual(t, gotEnvelope, wantEnvelope)
			if err := broker.queue.Ack(t.Context(), delivery); err != nil {
				t.Fatal(err)
			}
		}
		if again := receive(t, broker.queue, 2*broker.lease+time.Second, ids...); len(again) > 0 {
			t.Errorf("acked messages came back: %v", again)
		}
	})

	t.Run("retry comes back after its delay as the next attempt", func(t *testing.T) {
		message := testMessage("retry")
		if err := broker.queue.Send(t.Context(), message); err != nil {
			t.Fatal(err)
		}
		first := receive(t, broker.queue, wait, message.ID)[message.ID]
		if first == nil {
			t.Fatal("never arrived")
		}
		retriedAt := time.Now()
		if err := broker.queue.Retry(t.Context(), 2*time.Second, first); err != nil {
			t.Fatal(err)
		}
		second := receive(t, broker.queue, wait, message.ID)[message.ID]
		// NOTE: relative, since an SQS long poll cancelled by an earlier check can still take it once
		if second == nil || second.Attempt != first.Attempt+1 || time.Since(retriedAt) < 2*time.Second {
			t.Fatalf("got %+v after %v, want attempt %d after 2s", second, time.Since(retriedAt), first.Attempt+1)
		}
		if err := broker.queue.Ack(t.Context(), second); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("an expired lease redelivers as the next attempt", func(t *testing.T) {
		message := testMessage("lease")
		message.Delay = time.Second
		sentAt := time.Now()
		if err := broker.queue.Send(t.Context(), message); err != nil {
			t.Fatal(err)
		}
		first := receive(t, broker.queue, wait, message.ID)[message.ID]
		if first == nil || time.Since(sentAt) < time.Second {
			t.Fatalf("got %+v after %v, want it after its 1s delay", first, time.Since(sentAt))
		}
		second := receive(t, broker.queue, wait, message.ID)[message.ID]
		if second == nil || second.Attempt != first.Attempt+1 || time.Since(sentAt) < time.Second+broker.lease {
			t.Fatalf("got %+v, want attempt %d after the lease", second, first.Attempt+1)
		}
		if err := broker.queue.Ack(t.Context(), second); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("dead-letters after the last attempt", func(t *testing.T) {
		message := testMessage("dead")
		if err := broker.queue.Send(t.Context(), message); err != nil {
			t.Fatal(err)
		}
		for attempt := 1; attempt <= broker.maxAttempts; attempt++ {
			delivery := receive(t, broker.queue, wait, message.ID)[message.ID]
			if delivery == nil || delivery.Attempt != attempt {
				t.Fatalf("attempt %d: got %+v", attempt, delivery)
			}
			if err := broker.queue.Retry(t.Context(), 0, delivery); err != nil {
				t.Fatal(err)
			}
		}
		if again := receive(t, broker.queue, 2*broker.lease+time.Second, message.ID); len(again) > 0 {
			t.Fatalf("delivered past %d attempts: %v", broker.maxAttempts, again)
		}
		if ids := broker.deadLetters(t); !slices.Contains(ids, message.ID) {
			t.Fatalf("dead letters %v miss %s", ids, message.ID)
		}
	})

	t.Run("a topic reaches every subscription", func(t *testing.T) {
		message := testMessage("topic")
		delayed := message
		delayed.Delay = time.Second
		if err := broker.topic.Publish(t.Context(), delayed); err == nil {
			t.Fatal("topic accepted a delay")
		}
		if err := broker.topic.Publish(t.Context(), message); err != nil {
			t.Fatal(err)
		}
		for index, subscription := range broker.subscriptions {
			delivery := receive(t, subscription, wait, message.ID)[message.ID]
			if delivery == nil {
				t.Fatalf("subscription %d never got it", index)
			}
			if err := subscription.Ack(t.Context(), delivery); err != nil {
				t.Fatal(err)
			}
		}
	})
}

func TestWorkerRunsAgainstValkey(t *testing.T) {
	queue := openQueue(t, "valkey://client:client@"+valkeyAddress+"/w"+strings.ToLower(rand.Text()[:10])+"?lease=1m&max_attempts=3")
	ids := []string{}
	var messages []Message
	for index := range 5 {
		message := testMessage("worker" + string(rune('a'+index)))
		messages, ids = append(messages, message), append(ids, message.ID)
	}
	if err := queue.Send(t.Context(), messages...); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	handled := make(chan string, len(ids))
	worker := Worker{Queue: queue, Concurrency: 2, Handle: func(_ context.Context, delivery *Delivery) error {
		var data map[string]string
		if err := json.Unmarshal(delivery.Data, &data); err != nil {
			return Permanent(err)
		}
		if delivery.Attempt == 1 && data["case"] == "workera" {
			return errors.New("first attempt fails")
		}
		handled <- delivery.ID
		if len(handled) == len(ids) {
			cancel()
		}
		return nil
	}}
	if err := worker.Run(ctx); err != nil {
		t.Fatal(err)
	}
	if len(handled) != len(ids) {
		t.Fatalf("handled %d of %d", len(handled), len(ids))
	}
}

func TestValkeyLateRetryLeavesAReclaimedEntry(t *testing.T) {
	rawURL := "valkey://client:client@" + valkeyAddress + "/r" + strings.ToLower(rand.Text()[:10]) + "?lease=500ms&max_attempts=5"
	slow, reclaimer := openQueue(t, rawURL), openQueue(t, rawURL)
	message := testMessage("late")
	if err := slow.Send(t.Context(), message); err != nil {
		t.Fatal(err)
	}
	late := receive(t, slow, 30*time.Second, message.ID)[message.ID]
	reclaimed := receive(t, reclaimer, 30*time.Second, message.ID)[message.ID]
	if late == nil || reclaimed == nil {
		t.Fatalf("got %+v and %+v", late, reclaimed)
	}
	if err := slow.Retry(t.Context(), 0, late); err != nil {
		t.Fatal(err)
	}
	if err := reclaimer.Ack(t.Context(), reclaimed); err != nil {
		t.Fatal(err)
	}
	if again := receive(t, slow, 2*time.Second, message.ID); len(again) > 0 {
		t.Fatalf("the late retry re-queued it: %+v", again[message.ID])
	}
}

func TestValkeyReclaimsALeaseBehindFreshOnes(t *testing.T) {
	name := "c" + strings.ToLower(rand.Text()[:10])
	rawURL := "valkey://client:client@" + valkeyAddress + "/" + name + "?lease=500ms&max_attempts=5"
	leaser, reclaimer, client := openQueue(t, rawURL), openQueue(t, rawURL), valkeyTestClient(t)
	messages := make([]Message, 11)
	for index := range messages {
		messages[index] = testMessage("cursor")
	}
	if err := leaser.Send(t.Context(), messages...); err != nil {
		t.Fatal(err)
	}
	deliveries, err := leaser.Receive(t.Context(), len(messages))
	if err != nil || len(deliveries) != len(messages) {
		t.Fatalf("got %d deliveries, %v", len(deliveries), err)
	}
	time.Sleep(time.Second)
	var renewed []string
	for _, delivery := range deliveries {
		if delivery.ID != messages[10].ID {
			renewed = append(renewed, delivery.handle.(string))
		}
	}
	if err := client.Do(t.Context(), client.B().Xclaim().Key("{"+name+"}:stream").Group(valkeyGroup).Consumer("renewer").
		MinIdleTime("0").Id(renewed...).Justid().Build()).Error(); err != nil {
		t.Fatal(err)
	}
	// NOTE: one XAUTOCLAIM COUNT 1 scans only the 10 renewed leases, and the next resumes after them
	if first, err := reclaimer.Receive(t.Context(), 1); err != nil || len(first) != 0 {
		t.Fatalf("first receive got %+v, %v; want nothing past a 10-entry scan", first, err)
	}
	second, err := reclaimer.Receive(t.Context(), 1)
	if err != nil || len(second) != 1 || second[0].ID != messages[10].ID {
		t.Fatalf("second receive got %+v, %v, want %s", second, err, messages[10].ID)
	}
}

func TestValkeyCloseRemovesOnlySettledConsumers(t *testing.T) {
	name := "x" + strings.ToLower(rand.Text()[:10])
	rawURL := "valkey://client:client@" + valkeyAddress + "/" + name + "?lease=500ms&max_attempts=5"
	settled, holding, client := openQueue(t, rawURL), openQueue(t, rawURL), valkeyTestClient(t)
	message := testMessage("close")
	if err := holding.Send(t.Context(), message); err != nil {
		t.Fatal(err)
	}
	if held := receive(t, holding, 30*time.Second, message.ID); held[message.ID] == nil {
		t.Fatal("holding never received the message")
	}
	if _, err := settled.Receive(t.Context(), 1); err != nil {
		t.Fatal(err)
	}
	for _, queue := range []Queue{settled, holding} {
		if err := queue.Close(); err != nil {
			t.Fatal(err)
		}
	}
	consumers, err := client.Do(t.Context(), client.B().XinfoConsumers().Key("{"+name+"}:stream").Group(valkeyGroup).Build()).ToArray()
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, consumer := range consumers {
		fields, err := consumer.AsMap()
		if err != nil {
			t.Fatal(err)
		}
		nameField := fields["name"]
		consumerName, err := nameField.ToString()
		if err != nil {
			t.Fatal(err)
		}
		names = append(names, consumerName)
	}
	if want := []string{holding.(*valkeyQueue).consumer}; !slices.Equal(names, want) {
		t.Fatalf("consumers %v, want only the one holding a lease %v", names, want)
	}
	if reclaimed := receive(t, openQueue(t, rawURL), 30*time.Second, message.ID)[message.ID]; reclaimed == nil || reclaimed.Attempt != 2 {
		t.Fatalf("reclaimed %+v, want the held message's attempt 2", reclaimed)
	}
}
