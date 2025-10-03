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

// returns the string output of the CLUSTER NODES command
//
// example output:
//
//	07c37dfeb235213a872192d05877c5d02d9a7e1f 10.1.0.2:6379@16379 master - 0 1538428698000 1 connected 0-5460
//	67ed2db8d677e59ec4a4cefb06858cf2a1a89fa1 10.1.0.3:6379@16379 master - 0 1538428699000 2 connected 5461-10922
//	292f8b365bb7edb5e285caf0b7e6ddc7265d2f4f 10.1.0.4:6379@16379 master - 0 1538428697000 3 connected 10923-16383
//	e7d1eecce10fd6bb5eb35b9f99a514335d9ba9ca 10.1.0.5:6379@16379 slave 07c37dfeb235213a872192d05877c5d02d9a7e1f 0 1538428699000 4 connected
//	c8e7e5c5e6a7c5e6b7e8d9e0f1a2b3c4d5e6f7a8 10.1.0.6:6379@16379 slave 67ed2db8d677e59ec4a4cefb06858cf2a1a89fa1 0 1538428698000 5 connected
//	a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0 10.1.0.7:6379@16379 slave 292f8b365bb7edb5e285caf0b7e6ddc7265d2f4f 0 1538428698000 6 connected
func (r *ValkeyClusterReconciler) queryClusterNodes(ctx context.Context, client valkey.Client) (string, error) {
	resp := client.Do(ctx, client.B().ClusterNodes().Build())
	if resp.Error() != nil {
		return "", resp.Error()
	}

	output, err := resp.ToString()
	if err != nil {
		return "", err
	}

	return output, nil
}
