//go:build windows

package main

import (
	"context"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"

	"golang.org/x/sys/windows"
)

func configureCommand(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: windows.CREATE_NO_WINDOW}
}

func commandForScript(ctx context.Context, script string) (*exec.Cmd, error) {
	args, err := windows.DecomposeCommandLine(script)
	if err != nil {
		return nil, err
	}
	name := strings.ToLower(filepath.Base(args[0]))
	var cmd *exec.Cmd
	if name == "powershell" || name == "powershell.exe" || name == "pwsh" || name == "pwsh.exe" || name == "cmd" || name == "cmd.exe" {
		cmd = exec.CommandContext(ctx, args[0])
		configureCommand(cmd)
		cmd.SysProcAttr.CmdLine = script
	} else {
		cmd = exec.CommandContext(ctx, "powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script)
		configureCommand(cmd)
	}
	return cmd, nil
}
