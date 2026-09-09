//go:build windows

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/pelletier/go-toml/v2"
)

type mcpServerConfig struct {
	Command string   `toml:"command"`
	Args    []string `toml:"args"`
	Enabled *bool    `toml:"enabled"`
}

type codexMCPConfig struct {
	Servers map[string]mcpServerConfig `toml:"mcp_servers"`
}

type windowsProcess struct {
	ProcessID       uint32
	ParentProcessID uint32
	Name            string
	ExecutablePath  string
	CommandLine     string
}

func killMCPs(q Req) Res {
	configPath := strings.TrimSpace(q.Path)
	if configPath == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return Res{Error: err.Error()}
		}
		configPath = filepath.Join(home, ".codex", "config.toml")
	}
	data, err := os.ReadFile(configPath)
	if err != nil {
		return Res{Error: err.Error()}
	}
	var config codexMCPConfig
	if err := toml.Unmarshal(data, &config); err != nil {
		return Res{Error: err.Error()}
	}
	processes, err := runningWindowsProcesses()
	if err != nil {
		return Res{Error: err.Error()}
	}
	byParent := map[uint32][]uint32{}
	byID := map[uint32]windowsProcess{}
	codex := map[uint32]bool{}
	for _, process := range processes {
		byID[process.ProcessID] = process
		byParent[process.ParentProcessID] = append(byParent[process.ParentProcessID], process.ProcessID)
		if strings.EqualFold(process.Name, "codex.exe") {
			codex[process.ProcessID] = true
		}
	}
	descendants := map[uint32]bool{}
	var addDescendants func(uint32)
	addDescendants = func(parent uint32) {
		for _, child := range byParent[parent] {
			if descendants[child] {
				continue
			}
			descendants[child] = true
			addDescendants(child)
		}
	}
	for pid := range codex {
		addDescendants(pid)
	}
	targets := map[uint32]string{}
	for name, server := range config.Servers {
		if server.Enabled != nil && !*server.Enabled || strings.TrimSpace(server.Command) == "" {
			continue
		}
		for pid := range descendants {
			if matchesMCPProcess(byID[pid], server) {
				targets[pid] = name
			}
		}
	}
	for pid, name := range targets {
		var addChildren func(uint32)
		addChildren = func(parent uint32) {
			for _, child := range byParent[parent] {
				if !descendants[child] {
					continue
				}
				targets[child] = name
				addChildren(child)
			}
		}
		addChildren(pid)
	}
	pids := make([]uint32, 0, len(targets))
	for pid := range targets {
		pids = append(pids, pid)
	}
	sort.Slice(pids, func(i, j int) bool { return processDepth(pids[i], byID) > processDepth(pids[j], byID) })
	items := make([]string, 0, len(pids))
	for _, pid := range pids {
		process := byID[pid]
		label := fmt.Sprintf("%s pid=%d %s", targets[pid], pid, process.Name)
		if q.DryRun {
			items = append(items, "would terminate "+label)
			continue
		}
		handle, err := os.FindProcess(int(pid))
		if err != nil {
			return Res{Items: items, Error: err.Error()}
		}
		if err := handle.Kill(); err != nil {
			return Res{Items: items, Error: fmt.Sprintf("%s: %v", label, err)}
		}
		items = append(items, "terminated "+label)
	}
	if len(items) == 0 {
		return Res{Data: "no configured MCP processes attached to Codex"}
	}
	return Res{Items: items}
}

func runningWindowsProcesses() ([]windowsProcess, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	script := "$p=Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine; ConvertTo-Json -Compress -Depth 3 -InputObject @($p)"
	cmd, err := commandForScript(ctx, script)
	if err != nil {
		return nil, err
	}
	output, err := cmd.Output()
	if err != nil {
		return nil, err
	}
	var processes []windowsProcess
	if err := json.Unmarshal(output, &processes); err != nil {
		return nil, err
	}
	return processes, nil
}

func matchesMCPProcess(process windowsProcess, server mcpServerConfig) bool {
	configured := normalizeProcessText(server.Command)
	configuredBase := strings.TrimSuffix(strings.ToLower(filepath.Base(server.Command)), ".exe")
	processBase := strings.TrimSuffix(strings.ToLower(process.Name), ".exe")
	commandLine := normalizeProcessText(process.CommandLine)
	executable := normalizeProcessText(process.ExecutablePath)
	if filepath.IsAbs(server.Command) {
		if executable != configured && !strings.Contains(commandLine, configured) {
			return false
		}
	} else if configuredBase != processBase {
		return false
	}
	for _, arg := range server.Args {
		if !strings.Contains(commandLine, normalizeProcessText(arg)) {
			return false
		}
	}
	return true
}

func normalizeProcessText(value string) string {
	value = strings.Trim(strings.ToLower(strings.ReplaceAll(value, "\\", "/")), " \t\r\n\"")
	return strings.ReplaceAll(value, "//", "/")
}

func processDepth(pid uint32, processes map[uint32]windowsProcess) int {
	depth := 0
	seen := map[uint32]bool{}
	for pid != 0 && !seen[pid] {
		seen[pid] = true
		process, ok := processes[pid]
		if !ok {
			break
		}
		pid = process.ParentProcessID
		depth++
	}
	return depth
}
