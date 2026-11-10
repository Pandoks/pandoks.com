package commands

import (
	"context"
	"errors"
	"fmt"
	"time"
	"valkey/reconciler/internal/utils"
	"valkey/reconciler/internal/valkey"

	valkeygo "github.com/valkey-io/valkey-go"
)

func ApplyConfig(env utils.Env, config utils.ConfigEnv) error {
	fmt.Println("=== Valkey Config Apply ===")

	totalNodes := env.Masters + env.Masters*env.ReplicasPerMaster

	timeoutCtx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	for i := range totalNodes {
		hostname := fmt.Sprintf("%s:%d", utils.GetPodHeadlessServiceFQDN(env.ClusterName, env.Namespace, i), 6379)
		fmt.Printf("Applying config to %s...\n", hostname)
		for {
			err := applyNodeConfig(timeoutCtx, env, config, hostname)
			if err == nil {
				break
			}
			// NOTE: only a node that doesn't answer yet (not started, unreachable, loading its dataset) is worth waiting for
			var valkeyErr *valkeygo.ValkeyError
			if errors.As(err, &valkeyErr) && !valkeyErr.IsLoading() {
				return fmt.Errorf("%s: %w", hostname, err)
			}
			fmt.Printf("%s: %v, retrying\n", hostname, err)
			select {
			case <-timeoutCtx.Done():
				return fmt.Errorf("%s: %w", hostname, timeoutCtx.Err())
			case <-time.After(2 * time.Second):
			}
		}
		fmt.Printf("✓ %s applied\n", hostname)
	}

	fmt.Println("=== Config Apply Complete ===")
	return nil
}

func applyNodeConfig(ctx context.Context, env utils.Env, config utils.ConfigEnv, hostname string) error {
	nodeClient, err := valkey.NewClient(valkeygo.ClientOption{
		InitAddress:       []string{hostname},
		Username:          valkey.AdminUser,
		Password:          env.AdminPassword,
		ForceSingleClient: true,
	})
	if err != nil {
		return err
	}
	defer nodeClient.Close()

	if err := valkey.SetParameters(ctx, nodeClient, config.Parameters); err != nil {
		return err
	}
	return valkey.SetUsers(ctx, nodeClient, config.UsersACL)
}
