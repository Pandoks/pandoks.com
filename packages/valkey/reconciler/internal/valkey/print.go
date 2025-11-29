package valkey

import (
	"fmt"

	valkeygo "github.com/valkey-io/valkey-go"
)

func PrintClusterInfo(client valkeygo.Client) {
	fmt.Println("Cluster information:")
	info, err := GetClusterInfo(client)
	if err != nil {
		fmt.Printf("ERROR: %s\n", err)
		return
	}
	fmt.Println(info)
}

func PrintClusterNodes(client valkeygo.Client) {
	fmt.Println("Cluster nodes:")

	clusterNodes, err := GetClusterNodes(client)
	if err != nil {
		fmt.Printf("ERROR: %s\n", err)
		return
	}
	fmt.Println(clusterNodes)
}
