package adapter

import (
	"context"
	"fmt"
	"queueworker"
	"queueworker/cloudflare"
	"queueworker/sqs"
	"queueworker/valkey"

	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	awssqs "github.com/aws/aws-sdk-go-v2/service/sqs"
	valkeygo "github.com/valkey-io/valkey-go"
)

type Adapter interface {
	queueworker.Queue
	queueworker.Publisher
	Close() error
}

func Open(ctx context.Context, config Config) (Adapter, error) {
	switch config.Transport {
	case TransportSQS:
		loadOptions := make([]func(*awsconfig.LoadOptions) error, 0, 2)
		if config.SQS.Region != "" {
			loadOptions = append(loadOptions, awsconfig.WithRegion(config.SQS.Region))
		}
		if config.SQS.EndpointURL != "" {
			loadOptions = append(
				loadOptions,
				awsconfig.WithBaseEndpoint(config.SQS.EndpointURL),
			)
		}
		awsConfig, err := awsconfig.LoadDefaultConfig(ctx, loadOptions...)
		if err != nil {
			return nil, fmt.Errorf("load AWS configuration: %w", err)
		}
		return sqs.NewAdapter(
			awssqs.NewFromConfig(awsConfig),
			config.SQS.QueueURL,
			config.SQS.Options,
			config.SQS.PublisherOptions,
		)
	case TransportValkey:
		client, err := valkeygo.NewClient(valkeygo.ClientOption{
			InitAddress: config.Valkey.Addresses,
			Username:    config.Valkey.Username,
			Password:    config.Valkey.Password,
			ShuffleInit: true,
		})
		if err != nil {
			return nil, fmt.Errorf("connect to Valkey: %w", err)
		}
		queue, err := valkey.New(client, config.Valkey.Options)
		if err != nil {
			client.Close()
			return nil, err
		}
		return queue, nil
	case TransportCloudflare:
		return cloudflare.New(config.Cloudflare)
	default:
		return nil, fmt.Errorf("queue transport %q is not supported", config.Transport)
	}
}
