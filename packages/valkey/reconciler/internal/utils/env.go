package utils

import (
	"fmt"
	"os"
	"strconv"
)

type Env struct {
	ClusterName       string
	Namespace         string
	Masters           int
	ReplicasPerMaster int
	AdminPassword     string
}

func Load() (Env, error) {
	clusterName := os.Getenv("CLUSTER_NAME")
	if clusterName == "" {
		return Env{}, fmt.Errorf("CLUSTER_NAME environment variable is not set")
	}

	namespace := os.Getenv("NAMESPACE")
	if namespace == "" {
		return Env{}, fmt.Errorf("NAMESPACE environment variable is not set")
	}

	masters, err := strconv.Atoi(os.Getenv("MASTERS"))
	if err != nil {
		return Env{}, fmt.Errorf("MASTERS environment variable is not set")
	}

	replicasPerMaster, err := strconv.Atoi(os.Getenv("REPLICAS_PER_MASTER"))
	if err != nil {
		return Env{}, fmt.Errorf("REPLICAS_PER_MASTER environment variable is not set")
	}

	adminPassword := os.Getenv("ADMIN_PASSWORD")
	if adminPassword == "" {
		return Env{}, fmt.Errorf("ADMIN_PASSWORD environment variable is not set")
	}

	return Env{
		ClusterName:       clusterName,
		Namespace:         namespace,
		Masters:           masters,
		ReplicasPerMaster: replicasPerMaster,
		AdminPassword:     adminPassword,
	}, nil
}
