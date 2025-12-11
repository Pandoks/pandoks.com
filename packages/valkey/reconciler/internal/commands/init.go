package commands

import (
	"context"
	"fmt"
	"strings"
	"time"
	"valkey/reconciler/internal/utils"
	"valkey/reconciler/internal/valkey"

	valkeygo "github.com/valkey-io/valkey-go"
)

func Init(env utils.Env) error {
	fmt.Println("=== Valkey Cluster Initialization ===")

	totalNodes := env.Masters + env.Masters*env.ReplicasPerMaster

	fmt.Printf("Configuration:\n")
	fmt.Printf("  Masters: %d\n", env.Masters)
	fmt.Printf("  Replicas per master: %d\n", env.ReplicasPerMaster)
	fmt.Printf("  Total nodes: %d\n", totalNodes)
	fmt.Printf("  Cluster name: %s\n", env.ClusterName)
	fmt.Printf("  Namespace: %s\n", env.Namespace)
	fmt.Println()

	timeoutCtx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	statefulSetName := utils.GetStatefulsetName(env.ClusterName)
	err := utils.WaitForStatefulSetReady(timeoutCtx, env.Namespace, statefulSetName, totalNodes)
	if err != nil {
		return err
	}

	fmt.Println("Building node list...")
	nodeList := make([]string, 0, totalNodes)
	for i := range totalNodes {
		nodeList = append(nodeList, fmt.Sprintf("%s:%d", utils.GetPodHeadlessServiceFQDN(env.ClusterName, env.Namespace, i), 6379))
	}

	fmt.Println("Nodes:", nodeList)
	fmt.Println()

	clusterClient, err := valkey.NewClient(valkeygo.ClientOption{
		InitAddress: []string{nodeList[0]},
		Username:    valkey.AdminUser,
		Password:    env.AdminPassword,
	})
	if err != nil {
		return err
	}
	defer clusterClient.Close()

	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	infoCmd := clusterClient.B().ClusterInfo().Build()
	infoResponse := clusterClient.Do(ctx, infoCmd)
	cancel()

	info, err := infoResponse.ToString()
	if err == nil && strings.Contains(info, "cluster_state:ok") {
		fmt.Println("Cluster already initialized; skipping initialization.")
		return nil
	}

	fmt.Println("Creating Valkey cluster...")
	createClusterOptions := valkey.CreateClusterOptions{
		CliBaseOptions: valkey.CliBaseOptions{
			Auth: valkey.Auth{
				Username: valkey.AdminUser,
				Password: env.AdminPassword,
			},
		},
		Nodes:             nodeList,
		ReplicasPerMaster: env.ReplicasPerMaster,
	}
	if err := valkey.CreateCluster(createClusterOptions); err != nil {
		fmt.Println("ERROR: Failed to create cluster")
		return err
	}

	fmt.Println()
	fmt.Println("✓ Cluster created successfully!")
	fmt.Println()

	valkey.PrintClusterInfo(clusterClient)
	fmt.Println()

	valkey.PrintClusterNodes(clusterClient)

	fmt.Println("=== Initialization Complete ===")
	return nil
}
