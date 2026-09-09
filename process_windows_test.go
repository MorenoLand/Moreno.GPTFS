//go:build windows

package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/sys/windows"
)

func TestExplicitPowerShellRunsDirectAndHidden(t *testing.T) {
	cmd, err := commandForScript(context.Background(), `powershell -NoProfile -NonInteractive -Command "Write-Output hidden"`)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.EqualFold(filepath.Base(cmd.Path), "powershell.exe") {
		t.Fatalf("unexpected executable: %s", cmd.Path)
	}
	if cmd.SysProcAttr == nil || !cmd.SysProcAttr.HideWindow || cmd.SysProcAttr.CreationFlags&windows.CREATE_NO_WINDOW == 0 {
		t.Fatal("PowerShell process is not hidden")
	}
	output, err := cmd.Output()
	if err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(string(output)) != "hidden" {
		t.Fatalf("unexpected output: %q", output)
	}
}

func TestKillMCPsDryRun(t *testing.T) {
	home, err := os.UserHomeDir()
	if err != nil {
		t.Skip(err)
	}
	config := filepath.Join(home, ".codex", "config.toml")
	if _, err := os.Stat(config); err != nil {
		t.Skip(err)
	}
	if result := killMCPs(Req{Path: config, DryRun: true}); result.Error != "" {
		t.Fatal(result.Error)
	}
}
