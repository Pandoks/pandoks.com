package utils

import (
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"strings"
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

type ConfigEnv struct {
	Parameters map[string]string
	UsersACL   string
}

func LoadConfig() (ConfigEnv, error) {
	var parameters map[string]string
	if err := json.Unmarshal([]byte(os.Getenv("PARAMETERS")), &parameters); err != nil {
		return ConfigEnv{}, fmt.Errorf("PARAMETERS environment variable is not a JSON object of strings: %w", err)
	}

	usersACLTemplate := os.Getenv("USERS_ACL")
	if usersACLTemplate == "" {
		return ConfigEnv{}, fmt.Errorf("USERS_ACL environment variable is not set")
	}
	// NOTE: expanded like entrypoint.sh's envsubst. An empty ${CLIENT_PASSWORD} would turn ">${CLIENT_PASSWORD}" into
	// a valid empty password, a space or newline would split its line after the lines before it already applied, and
	// a restarted pod's aclfile load trims a leading or trailing tab or CR that ACL SETUSER keeps
	var unsetVariables, unsplittableVariables []string
	usersACL := os.Expand(usersACLTemplate, func(name string) string {
		value := os.Getenv(name)
		if value == "" {
			unsetVariables = append(unsetVariables, name)
		}
		if strings.ContainsAny(value, " \t\r\n") {
			unsplittableVariables = append(unsplittableVariables, name)
		}
		return value
	})
	if len(unsetVariables) > 0 {
		return ConfigEnv{}, fmt.Errorf("USERS_ACL uses unset environment variables: %v", unsetVariables)
	}
	if len(unsplittableVariables) > 0 {
		return ConfigEnv{}, fmt.Errorf("USERS_ACL uses environment variables with a space, tab, carriage return or newline: %v", unsplittableVariables)
	}

	return ConfigEnv{
		Parameters: parameters,
		UsersACL:   usersACL,
	}, nil
}
