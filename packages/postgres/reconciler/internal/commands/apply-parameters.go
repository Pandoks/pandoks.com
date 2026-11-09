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

	for group := range env.Groups {
		configURL := patroni.GetGroupConfigURL(env.DB, group)
		for {
			err := patroni.PatchConfig(configURL, env.PatroniPassword, body)
			if err == nil {
				break
			}
			if !patroni.IsRetryable(err) {
				return fmt.Errorf("group %d: %w", group, err)
			}
			fmt.Printf("group %d: %s, retrying\n", group, err)
			time.Sleep(5 * time.Second)
		}
		fmt.Printf("group %d: updated\n", group)
	}
	return nil
}
