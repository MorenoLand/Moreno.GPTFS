//go:build !windows

package main

import (
	"context"
	"os/exec"
)

func configureCommand(cmd *exec.Cmd) {}

func commandForScript(ctx context.Context, script string) (*exec.Cmd, error) {
	return exec.CommandContext(ctx, "sh", "-c", script), nil
}
