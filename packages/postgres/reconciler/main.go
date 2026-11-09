package main

import (
	"fmt"
	"os"
	"postgres/reconciler/internal/commands"
	"postgres/reconciler/internal/utils"
)

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: postgres-reconciler <apply-parameters>")
		os.Exit(2)
	}

	subcommand := os.Args[1]

	env, err := utils.Load()
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}

	switch subcommand {
	case "apply-parameters":
		if err := commands.ApplyParameters(env); err != nil {
			fmt.Fprintln(os.Stderr, "error:", err)
			os.Exit(1)
		}

	default:
		fmt.Fprintf(os.Stderr, "unknown command: %s\n", subcommand)
		fmt.Fprintln(os.Stderr, "available commands: apply-parameters")
		os.Exit(2)
	}
}
