package controller

import (
	"context"
	"fmt"
	"slices"
	"strconv"
	"strings"

	"github.com/valkey-io/valkey-go"
)

func (r *ValkeyClusterReconciler) connectToValkeyNode(ctx context.Context, fqdn string) (valkey.Client, error) {
	client, err := valkey.NewClient(valkey.ClientOption{InitAddress: []string{fqdn}})
	if err != nil {
		return nil, fmt.Errorf("failed to create client for %s: %w", fqdn, err)
	}

	if err := client.Do(ctx, client.B().Ping().Build()).Error(); err != nil {
		client.Close()
		return nil, fmt.Errorf("failed to ping client for %s: %w", fqdn, err)
	}

	return client, nil
}
