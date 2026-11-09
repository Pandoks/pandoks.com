package commands

import (
	"fmt"
	"postgres/reconciler/internal/patroni"
	"postgres/reconciler/internal/utils"
	"time"
)

func ApplyParameters(env utils.Env) error {
	for group := range env.Workers + 1 {
		configURL := patroni.GetGroupConfigURL(env.DB, group)
		for {
			retry, err := patroni.PatchConfig(configURL, env.PatroniPassword, env.Parameters)
			if err == nil {
				break
			}
			if !retry {
				return fmt.Errorf("group %d: %w", group, err)
			}
			fmt.Printf("group %d: %s, retrying\n", group, err)
			time.Sleep(5 * time.Second)
		}
		fmt.Printf("group %d: updated\n", group)
	}
	return nil
}
