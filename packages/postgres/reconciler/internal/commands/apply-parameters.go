package commands

import (
	"fmt"
	"postgres/reconciler/internal/patroni"
	"postgres/reconciler/internal/utils"
	"time"
)

func ApplyParameters(env utils.Env) error {
	for shard := range env.Shards {
		configURL := patroni.GetShardConfigURL(env.DB, shard)
		for {
			retry, err := patroni.PatchConfig(configURL, env.PatroniPassword, env.Parameters)
			if err == nil {
				break
			}
			if !retry {
				return fmt.Errorf("shard %d: %w", shard, err)
			}
			fmt.Printf("shard %d: %s, retrying\n", shard, err)
			time.Sleep(5 * time.Second)
		}
		fmt.Printf("shard %d: updated\n", shard)
	}
	return nil
}
