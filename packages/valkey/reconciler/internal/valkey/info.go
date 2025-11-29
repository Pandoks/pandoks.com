package valkey

import (
	"context"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"
	"valkey/reconciler/internal/utils"

	valkeygo "github.com/valkey-io/valkey-go"
)

func GetClusterInfo(client valkeygo.Client) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	infoCmd := client.B().ClusterInfo().Build()
	infoResponse := client.Do(ctx, infoCmd)
	cancel()

	info, err := infoResponse.ToString()
	if err != nil {
		return "", err
	}
	return info, nil
}

func GetClusterNodes(client valkeygo.Client) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()

	cmd := client.B().ClusterNodes().Build()
	reponse := client.Do(ctx, cmd)
	if reponse.Error() != nil {
		return "", reponse.Error()
	}

	output, err := reponse.ToString()
	if err != nil {
		return "", err
	}

	cleansedOutput := strings.TrimPrefix(output, "txt:")
	return cleansedOutput, nil
}

// includes port in hostnames
func GetClusterConnectionInfo(serviceName string, env utils.Env) (orderedClusterHostnames []string, err error) {
	_, hostnames, err := utils.GetAllServicePods(serviceName)
	if err != nil {
		return nil, err
	}

	clientHostnames, err := filterClientHostnames(hostnames)
	if err != nil {
		return nil, err
	}

	sort.Slice(clientHostnames, func(i, j int) bool {
		hostnameI, hostnameJ := clientHostnames[i], clientHostnames[j]
		lastColonIIndex, lastColonJIndex := strings.LastIndex(hostnameI, ":"), strings.LastIndex(hostnameJ, ":")
		hostI, hostJ := hostnameI[:lastColonIIndex], hostnameJ[:lastColonJIndex]
		podnameI, podnameJ := strings.Split(hostI, ".")[0], strings.Split(hostJ, ".")[0]
		partsI, partsJ := strings.Split(podnameI, "-"), strings.Split(podnameJ, "-")
		indexI, _ := strconv.Atoi(partsI[len(partsI)-1])
		indexJ, _ := strconv.Atoi(partsJ[len(partsJ)-1])
		return indexI < indexJ
	})

	orderedClusterHostnames = make([]string, 0, len(hostnames)/2) // NOTE: hostnames treats busport and client port as different so there are 2x the node amount
	for _, hostname := range clientHostnames {
		nodeClient, err := NewClient(valkeygo.ClientOption{
			InitAddress:       []string{hostname},
			Username:          AdminUser,
			Password:          env.AdminPassword,
			ForceSingleClient: true,
		})
		if err != nil {
			continue
		}

		clusterInfo, err := GetClusterInfo(nodeClient)
		if err != nil {
			continue
		}
		nodeClient.Close()
		if strings.Contains(clusterInfo, "cluster_size:0") {
			continue
		}

		orderedClusterHostnames = append(orderedClusterHostnames, hostname)
	}

	return orderedClusterHostnames, nil
}

func WaitForClusterInfoState(ctx context.Context, client *ValkeyClient, state string) error {
	fmt.Println()
	fmt.Println("Waiting for cluster to update info...")

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		client.Refresh()

		clusterInfo, err := GetClusterInfo(client)
		if err != nil {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(2 * time.Second):
			}
			continue
		}
		if strings.Contains(clusterInfo, state) {
			break
		}

		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(2 * time.Second):
		}
	}

	fmt.Println("✓ Cluster updated info")
	fmt.Println()

	return nil
}

func WaitForAllNodesClusterInfoState(ctx context.Context, env utils.Env, hostnames []string, state string) error {
	fmt.Println("Waiting for cluster state in the cluster to be consistent across all nodes...")
	fmt.Println("Pods to check:")
	fmt.Println(hostnames)
	fmt.Println("State to check:")
	fmt.Println(state)

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	semaphore := make(chan struct{}, 10)
	errChan := make(chan error, len(hostnames))
	for _, hostname := range hostnames {
		semaphore <- struct{}{}

		fmt.Printf("Checking state for %s...\n", hostname)
		go func(hostname string) {
			defer func() { <-semaphore }()

			nodeClient, err := NewClient(valkeygo.ClientOption{
				InitAddress:       []string{hostname},
				Username:          AdminUser,
				Password:          env.AdminPassword,
				ForceSingleClient: true,
			})
			if err != nil {
				errChan <- err
				return
			}
			defer nodeClient.Close()

			if err = WaitForClusterInfoState(ctx, nodeClient, state); err != nil {
				errChan <- err
				return
			}

			fmt.Printf("✓ %s correct\n", hostname)
			errChan <- nil
		}(hostname)
	}

	for range hostnames {
		if err := <-errChan; err != nil {
			cancel()
			return err
		}
	}

	fmt.Println()
	fmt.Println("✓ All nodes are consistent and are in the desired cluster info state")
	fmt.Println()

	return nil
}

// nodeIds is a list of lists of node ids. ids in the same list are "or" matched while ids in different lists are "and" matched
func WaitForClusterNodeContains(ctx context.Context, client *ValkeyClient, matchingStrings ...[]string) error {
	fmt.Println("Waiting for matching strings in the cluster...")

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		client.Refresh()
		clusterNodes, err := GetClusterNodes(client)
		if err != nil {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(2 * time.Second):
			}
			continue
		}

		failed := false
		for _, nodeIdList := range matchingStrings {
			exists := false
			for _, nodeId := range nodeIdList {
				if strings.Contains(clusterNodes, nodeId) {
					exists = true
					break
				}
			}
			if !exists {
				failed = true
				break
			}
		}
		if !failed {
			break
		}

		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(2 * time.Second):
		}
	}

	fmt.Println("✓ Node has matching strings")
	fmt.Println()

	return nil
}

// each node in the cluster needs to update its info via the bus. this function waits for all nodes to
// contain the matching strings using WaitForEntireClusterConsistencyClusterNodeContains(). a node may
// not have the same data as the rest of the cluster. this causes bugs when using a cluster client
// because it will send the request to a random node that might not have the proper data. this function
// will wait for all nodes to have the same data.
//
// NOTE: hostnames need port number
func WaitForAllNodesClusterNodeContains(ctx context.Context, env utils.Env, hostnames []string, matchingStrings ...[]string) error {
	fmt.Println("Waiting for matching strings in the cluster across all given nodes...")
	fmt.Println("Pods to check:")
	fmt.Println(hostnames)
	fmt.Println("Matching strings:")
	for _, matchingStringList := range matchingStrings {
		fmt.Printf("  %s\n", matchingStringList)
	}

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	semaphore := make(chan struct{}, 10)
	errChan := make(chan error, len(hostnames))
	for _, hostname := range hostnames {
		semaphore <- struct{}{}

		fmt.Printf("Matching %s...\n", hostname)
		go func(hostname string) {
			defer func() { <-semaphore }()

			nodeClient, err := NewClient(valkeygo.ClientOption{
				InitAddress:       []string{hostname},
				Username:          AdminUser,
				Password:          env.AdminPassword,
				ForceSingleClient: true,
			})
			if err != nil {
				errChan <- err
				return
			}
			defer nodeClient.Close()

			if err = WaitForClusterNodeContains(ctx, nodeClient, matchingStrings...); err != nil {
				errChan <- err
				return
			}

			fmt.Printf("✓ %s correct\n", hostname)
			errChan <- nil
		}(hostname)
	}

	for range hostnames {
		if err := <-errChan; err != nil {
			cancel()
			return err
		}
	}

	fmt.Println()
	fmt.Println("✓ All nodes have matching strings and are consistent")
	fmt.Println()

	return nil
}

func WaitForEntireClusterConsistencyClusterNodeContains(ctx context.Context, env utils.Env, matchingStrings ...[]string) error {
	_, hostnames, err := utils.GetAllServicePods(utils.GetHeadlessServiceFQDN(env.ClusterName, env.Namespace))
	if err != nil {
		return err
	}
	clientHostnames, err := filterClientHostnames(hostnames)
	if err != nil {
		return err
	}

	return WaitForAllNodesClusterNodeContains(ctx, env, clientHostnames, matchingStrings...)
}

func filterClientHostnames(hostnames []string) (filteredHostnames []string, err error) {
	filteredHostnames = make([]string, 0, len(hostnames))
	for _, hostnames := range hostnames {
		lastColonIndex := strings.LastIndex(hostnames, ":")
		if lastColonIndex == -1 {
			return nil, fmt.Errorf("invalid hostname: %s", hostnames)
		}

		port := hostnames[lastColonIndex+1:]
		if port != "6379" {
			continue
		}

		filteredHostnames = append(filteredHostnames, hostnames)
	}

	return filteredHostnames, nil
}
