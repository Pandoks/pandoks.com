package utils

import (
	"encoding/json"
	"fmt"
	"os"
	"strconv"
)

type Env struct {
	DB              string
	Shards          int
	Parameters      map[string]any
	PatroniPassword string
}

func Load() (Env, error) {
	db := os.Getenv("DB")
	if db == "" {
		return Env{}, fmt.Errorf("DB environment variable is not set")
	}

	shards, err := strconv.Atoi(os.Getenv("SHARDS"))
	if err != nil {
		return Env{}, fmt.Errorf("SHARDS environment variable is not set")
	}

	var parameters map[string]any
	if err := json.Unmarshal([]byte(os.Getenv("PARAMETERS")), &parameters); err != nil {
		return Env{}, fmt.Errorf("PARAMETERS environment variable is not a JSON object: %w", err)
	}

	patroniPassword := os.Getenv("PATRONI_PASSWORD")
	if patroniPassword == "" {
		return Env{}, fmt.Errorf("PATRONI_PASSWORD environment variable is not set")
	}

	return Env{
		DB:              db,
		Shards:          shards,
		Parameters:      parameters,
		PatroniPassword: patroniPassword,
	}, nil
}
