package commands

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
	"valkey/reconciler/internal/utils"
	"valkey/reconciler/internal/valkey"

	valkeygo "github.com/valkey-io/valkey-go"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

const appliedAdminPasswordKey = "adminPassword"

func ApplyConfig(env utils.Env, config utils.ConfigEnv) error {
	fmt.Println("=== Valkey Config Apply ===")

	timeoutCtx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	kubernetesClient, err := utils.NewKubernetesClient()
	if err != nil {
		return err
	}

	// NOTE: before an upgrade, the StatefulSet still has the previous release's pods
	statefulSet, err := kubernetesClient.AppsV1().StatefulSets(env.Namespace).Get(timeoutCtx, utils.GetStatefulsetName(env.ClusterName), metav1.GetOptions{})
	if err != nil {
		return err
	}
	hostnames := make([]string, *statefulSet.Spec.Replicas)
	for i := range hostnames {
		hostnames[i] = fmt.Sprintf("%s:%d", utils.GetPodHeadlessServiceFQDN(env.ClusterName, env.Namespace, i), 6379)
	}

	secrets := kubernetesClient.CoreV1().Secrets(env.Namespace)
	appliedSecretName := utils.GetAppliedSecretName(env.ClusterName)
	appliedSecret, err := secrets.Get(timeoutCtx, appliedSecretName, metav1.GetOptions{})
	appliedSecretExists := !apierrors.IsNotFound(err)
	if err != nil && appliedSecretExists {
		return err
	}
	var appliedAdminPassword string
	if appliedSecretExists {
		appliedAdminPassword = string(appliedSecret.Data[appliedAdminPasswordKey])
	}
	rotating := appliedSecretExists && appliedAdminPassword != env.AdminPassword
	newAdminClient := func(hostname string) (*valkey.ValkeyClient, error) {
		nodeClient, err := newNodeClient(hostname, env.AdminPassword)
		if isWrongPass(err) && rotating {
			nodeClient, err = newNodeClient(hostname, appliedAdminPassword)
		}
		if isWrongPass(err) {
			return nil, fmt.Errorf("the node accepts neither the admin password nor a last-applied one in the %s Secret: %w", appliedSecretName, err)
		}
		return nodeClient, err
	}

	if rotating {
		fmt.Println("Adding the new admin password next to the last-applied one...")
		err := forEachNode(timeoutCtx, hostnames, func(hostname string) error {
			nodeClient, err := newAdminClient(hostname)
			if err != nil {
				return err
			}
			defer nodeClient.Close()
			return valkey.AddAdminPassword(timeoutCtx, nodeClient, env.AdminPassword)
		})
		if err != nil {
			return err
		}
	}

	fmt.Println("Applying parameters and users.acl, which drops any other admin password...")
	err = forEachNode(timeoutCtx, hostnames, func(hostname string) error {
		nodeClient, err := newAdminClient(hostname)
		if err != nil {
			return err
		}
		defer nodeClient.Close()
		if err := valkey.SetParameters(timeoutCtx, nodeClient, config.Parameters); err != nil {
			return err
		}
		// NOTE: every run, since a pod restarted mid-rotation starts with the last-applied password
		if err := valkey.SetPrimaryAuth(timeoutCtx, nodeClient, env.AdminPassword); err != nil {
			return err
		}
		return valkey.SetUsers(timeoutCtx, nodeClient, config.UsersACL)
	})
	if err != nil {
		return err
	}

	if !appliedSecretExists {
		appliedSecret = &corev1.Secret{
			ObjectMeta: metav1.ObjectMeta{Name: appliedSecretName},
			StringData: map[string]string{appliedAdminPasswordKey: env.AdminPassword},
		}
		if _, err := secrets.Create(timeoutCtx, appliedSecret, metav1.CreateOptions{}); err != nil {
			return err
		}
		fmt.Printf("✓ Created %s\n", appliedSecretName)
	} else if rotating {
		appliedSecret.StringData = map[string]string{appliedAdminPasswordKey: env.AdminPassword}
		if _, err := secrets.Update(timeoutCtx, appliedSecret, metav1.UpdateOptions{}); err != nil {
			return err
		}
		fmt.Printf("✓ Updated %s\n", appliedSecretName)
	}

	fmt.Println("=== Config Apply Complete ===")
	return nil
}

func forEachNode(ctx context.Context, hostnames []string, applyNode func(hostname string) error) error {
	for _, hostname := range hostnames {
		for {
			err := applyNode(hostname)
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
			case <-ctx.Done():
				return fmt.Errorf("%s: %w", hostname, ctx.Err())
			case <-time.After(2 * time.Second):
			}
		}
		fmt.Printf("✓ %s\n", hostname)
	}
	return nil
}

func newNodeClient(hostname, adminPassword string) (*valkey.ValkeyClient, error) {
	return valkey.NewClient(valkeygo.ClientOption{
		InitAddress:       []string{hostname},
		Username:          valkey.AdminUser,
		Password:          adminPassword,
		ForceSingleClient: true,
	})
}

func isWrongPass(err error) bool {
	var valkeyErr *valkeygo.ValkeyError
	return errors.As(err, &valkeyErr) && strings.HasPrefix(valkeyErr.Error(), "WRONGPASS")
}
