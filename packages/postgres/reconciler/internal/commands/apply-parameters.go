package commands

import (
	"encoding/json"
	"fmt"
	"postgres/reconciler/internal/patroni"
	"postgres/reconciler/internal/utils"
	"time"
)

func ApplyParameters(env utils.Env) error {
	body, err := json.Marshal(map[string]any{"postgresql": map[string]any{"parameters": env.Parameters}})
	if err != nil {
		return err
	}

	for shard := range env.Shards {
		configURL := patroni.GetShardConfigURL(env.DB, shard)
		for {
			err := patroni.PatchConfig(configURL, env.PatroniPassword, body)
			if err == nil {
				break
			}
			if !patroni.IsRetryable(err) {
				return fmt.Errorf("shard %d: %w", shard, err)
			}
			fmt.Printf("shard %d: %s, retrying\n", shard, err)
			time.Sleep(5 * time.Second)
		}
		fmt.Printf("shard %d: updated\n", shard)
	}
	return nil
}
