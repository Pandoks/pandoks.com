package main

import (
	"fmt"
	"os"
	"valkey/reconciler/internal/commands"
	"valkey/reconciler/internal/utils"
)

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: valkey-reconciler <init|scale-up|scale-down>")
		os.Exit(2)
	}

	subcommand := os.Args[1]

	env, err := utils.Load()
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}

	switch subcommand {
	case "scale-up":
		if err := commands.ScaleUp(env); err != nil {
			fmt.Fprintln(os.Stderr, "error:", err)
			os.Exit(1)
		}

	case "scale-down":
		if err := commands.ScaleDown(env); err != nil {
			fmt.Fprintln(os.Stderr, "error:", err)
			os.Exit(1)
		}

	case "init":
		if err := commands.Init(env); err != nil {
			fmt.Fprintln(os.Stderr, "error:", err)
			os.Exit(1)
		}

	default:
		fmt.Fprintf(os.Stderr, "unknown command: %s\n", subcommand)
		fmt.Fprintln(os.Stderr, "available commands: init, scale-up, scale-down")
		os.Exit(2)
	}
}
