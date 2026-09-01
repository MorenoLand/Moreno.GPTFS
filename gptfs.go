package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"time"
)

const (
	maxFile    = 8 << 20
	maxResults = 750
	maxItems   = 3000
)

type Req struct {
	Op             string   `json:"op"`
	Path           string   `json:"path,omitempty"`
	Cwd            string   `json:"cwd,omitempty"`
	NewPath        string   `json:"new_path,omitempty"`
	Command        string   `json:"command,omitempty"`
	Cmd            string   `json:"cmd,omitempty"`
	Args           []string `json:"args,omitempty"`
	Query          string   `json:"query,omitempty"`
	Pattern        string   `json:"pattern,omitempty"`
	Start          int      `json:"start,omitempty"`
	End            int      `json:"end,omitempty"`
	Radius         int      `json:"radius,omitempty"`
	Depth          int      `json:"depth,omitempty"`
	Timeout        int      `json:"timeout,omitempty"`
	Content        string   `json:"content,omitempty"`
	Old            string   `json:"old,omitempty"`
	New            string   `json:"new,omitempty"`
	ExpectedSHA256 string   `json:"expected_sha256,omitempty"`
	IgnoreCase     bool     `json:"ignore_case,omitempty"`
	Recursive      bool     `json:"recursive,omitempty"`
}

type Res struct {
	OK        bool     `json:"ok"`
	Data      string   `json:"data,omitempty"`
	Items     []string `json:"items,omitempty"`
	Error     string   `json:"error,omitempty"`
	Truncated bool     `json:"truncated,omitempty"`
	SHA256    string   `json:"sha256,omitempty"`
}

func dispatch(q Req) Res {
	var res Res
	switch q.Op {
	case "ping":
		res = Res{Data: "pong"}
	case "exec", "run", "cmd", "powershell", "bash", "sh":
		res = execCmd(q)
	case "read":
		res = read(q)
	case "context":
		res = readContext(q)
	case "ls":
		res = ls(q)
	case "tree":
		res = tree(q)
	case "grep":
		res = grep(q)
	case "glob":
		res = glob(q)
	case "find":
		res = find(q)
	case "stat":
		res = stat(q)
	case "write":
		res = writeFile(q)
	case "replace_range":
		res = replaceRange(q)
	case "replace_text":
		res = replaceText(q)
	case "mkdir":
		res = mkdir(q)
	case "rename":
		res = renamePath(q)
	case "delete":
		res = deletePath(q)
	default:
		res = Res{Error: "unknown op: " + q.Op}
	}
	res.OK = res.Error == ""
	return res
}

func clean(p string) string {
	p = strings.TrimSpace(p)
	p = os.ExpandEnv(p)
	if strings.HasPrefix(p, "~/") || strings.HasPrefix(p, `~\`) {
		if home, err := os.UserHomeDir(); err == nil {
			p = filepath.Join(home, p[2:])
		}
	}
	return filepath.Clean(p)
}

func mustAbs(p string) string {
	a, err := filepath.Abs(p)
	if err != nil {
		return p
	}
	return a
}

func hashBytes(b []byte) string {
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

func checkExpected(path, expected string) error {
	if expected == "" {
		return nil
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	actual := hashBytes(b)
	if !strings.EqualFold(actual, expected) {
		return fmt.Errorf("sha256 mismatch: expected %s, got %s", expected, actual)
	}
	return nil
}

func read(q Req) Res {
	p := clean(q.Path)
	f, err := os.Open(p)
	if err != nil {
		return Res{Error: err.Error()}
	}
	defer f.Close()

	start := q.Start
	end := q.End
	if start <= 0 {
		start = 1
	}
	if end <= 0 {
		end = start + 399
	}
	if end < start {
		end = start
	}

	s := bufio.NewScanner(f)
	s.Buffer(make([]byte, 64*1024), maxFile)
	var b strings.Builder
	line := 0
	truncated := false
	for s.Scan() {
		line++
		if line < start {
			continue
		}
		if line > end {
			truncated = true
			break
		}
		fmt.Fprintf(&b, "%d| %s\n", line, s.Text())
	}
	if err := s.Err(); err != nil {
		return Res{Error: err.Error()}
	}

	raw, err := os.ReadFile(p)
	if err != nil {
		return Res{Error: err.Error()}
	}
	return Res{Data: b.String(), Truncated: truncated, SHA256: hashBytes(raw)}
}

func readContext(q Req) Res {
	if q.Start <= 0 {
		return Res{Error: "line required in start"}
	}
	r := q.Radius
	if r <= 0 {
		r = 30
	}
	q.End = q.Start + r
	q.Start -= r
	if q.Start < 1 {
		q.Start = 1
	}
	return read(q)
}

func ls(q Req) Res {
	entries, err := os.ReadDir(clean(q.Path))
	if err != nil {
		return Res{Error: err.Error()}
	}
	items := make([]string, 0, len(entries))
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() {
			name += "/"
		}
		items = append(items, name)
	}
	sort.Strings(items)
	return Res{Items: items}
}

func skipDir(name string) bool {
	switch strings.ToLower(name) {
	case ".git", ".svn", ".hg", "node_modules", "vendor", ".idea", ".vs", ".next", "dist", "build":
		return true
	}
	return false
}

func tree(q Req) Res {
	root := clean(q.Path)
	depth := q.Depth
	if depth <= 0 {
		depth = 3
	}
	baseDepth := strings.Count(filepath.Clean(root), string(os.PathSeparator))
	var items []string
	truncated := false

	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if path == root {
			return nil
		}
		if d.IsDir() && skipDir(d.Name()) {
			return fs.SkipDir
		}
		currentDepth := strings.Count(filepath.Clean(path), string(os.PathSeparator)) - baseDepth
		if currentDepth > depth {
			if d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		rel, _ := filepath.Rel(root, path)
		s := filepath.ToSlash(rel)
		if d.IsDir() {
			s += "/"
		}
		items = append(items, s)
		if len(items) >= maxItems {
			truncated = true
			return fs.SkipAll
		}
		return nil
	})
	if err != nil {
		return Res{Error: err.Error()}
	}
	return Res{Items: items, Truncated: truncated}
}

func grep(q Req) Res {
	root := clean(q.Path)
	pattern := q.Query
	if q.IgnoreCase {
		pattern = "(?i)" + pattern
	}
	re, err := regexp.Compile(pattern)
	if err != nil {
		return Res{Error: err.Error()}
	}
	var results []string
	truncated := false

	err = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			if path != root && skipDir(d.Name()) {
				return fs.SkipDir
			}
			return nil
		}
		info, err := d.Info()
		if err != nil || info.Size() > maxFile {
			return nil
		}
		f, err := os.Open(path)
		if err != nil {
			return nil
		}
		s := bufio.NewScanner(f)
		s.Buffer(make([]byte, 64*1024), maxFile)
		line := 0
		for s.Scan() {
			line++
			text := s.Text()
			if strings.IndexByte(text, 0) >= 0 {
				_ = f.Close()
				return nil
			}
			if re.MatchString(text) {
				results = append(results, fmt.Sprintf("%s:%d: %s", path, line, strings.TrimSpace(text)))
				if len(results) >= maxResults {
					truncated = true
					_ = f.Close()
					return fs.SkipAll
				}
			}
		}
		_ = f.Close()
		return nil
	})
	if err != nil {
		return Res{Error: err.Error()}
	}
	return Res{Data: strings.Join(results, "\n"), Truncated: truncated}
}

func glob(q Req) Res {
	root := clean(q.Path)
	pattern := filepath.ToSlash(q.Pattern)
	var items []string
	truncated := false

	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			if path != root && skipDir(d.Name()) {
				return fs.SkipDir
			}
			return nil
		}
		rel, _ := filepath.Rel(root, path)
		rel = filepath.ToSlash(rel)
		if globMatch(pattern, rel) {
			items = append(items, path)
			if len(items) >= maxItems {
				truncated = true
				return fs.SkipAll
			}
		}
		return nil
	})
	if err != nil {
		return Res{Error: err.Error()}
	}
	return Res{Items: items, Truncated: truncated}
}

func globMatch(pattern, path string) bool {
	if strings.HasPrefix(pattern, "**/") {
		short := strings.TrimPrefix(pattern, "**/")
		if ok, _ := filepath.Match(filepath.FromSlash(short), filepath.Base(path)); ok {
			return true
		}
	}
	ok, _ := filepath.Match(filepath.FromSlash(pattern), filepath.FromSlash(path))
	return ok
}

func find(q Req) Res {
	root := clean(q.Path)
	needle := q.Query
	if q.IgnoreCase {
		needle = strings.ToLower(needle)
	}
	var items []string
	truncated := false

	_ = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() && path != root && skipDir(d.Name()) {
			return fs.SkipDir
		}
		name := d.Name()
		cmp := name
		if q.IgnoreCase {
			cmp = strings.ToLower(cmp)
		}
		if strings.Contains(cmp, needle) {
			items = append(items, path)
			if len(items) >= maxResults {
				truncated = true
				return fs.SkipAll
			}
		}
		return nil
	})
	return Res{Items: items, Truncated: truncated}
}

func stat(q Req) Res {
	p := clean(q.Path)
	s, err := os.Stat(p)
	if err != nil {
		return Res{Error: err.Error()}
	}
	data := fmt.Sprintf("path: %s\nname: %s\nsize: %d\ndir: %t\nmodified: %s", p, s.Name(), s.Size(), s.IsDir(), s.ModTime().Format("2006-01-02 15:04:05"))
	res := Res{Data: data}
	if !s.IsDir() && s.Size() <= maxFile {
		if b, err := os.ReadFile(p); err == nil {
			res.SHA256 = hashBytes(b)
		}
	}
	return res
}

func writeFile(q Req) Res {
	p := clean(q.Path)
	if err := checkExpected(p, q.ExpectedSHA256); err != nil {
		if !os.IsNotExist(err) || q.ExpectedSHA256 != "" {
			return Res{Error: err.Error()}
		}
	}
	if err := os.MkdirAll(filepath.Dir(p), 0755); err != nil {
		return Res{Error: err.Error()}
	}
	mode := os.FileMode(0644)
	if s, err := os.Stat(p); err == nil {
		mode = s.Mode()
	}
	if err := os.WriteFile(p, []byte(q.Content), mode); err != nil {
		return Res{Error: err.Error()}
	}
	b := []byte(q.Content)
	return Res{Data: fmt.Sprintf("wrote %d bytes to %s", len(b), p), SHA256: hashBytes(b)}
}

func replaceRange(q Req) Res {
	p := clean(q.Path)
	if q.Start <= 0 || q.End < q.Start {
		return Res{Error: "replace_range requires start >= 1 and end >= start"}
	}
	if err := checkExpected(p, q.ExpectedSHA256); err != nil {
		return Res{Error: err.Error()}
	}
	b, err := os.ReadFile(p)
	if err != nil {
		return Res{Error: err.Error()}
	}
	sep := "\n"
	if strings.Contains(string(b), "\r\n") {
		sep = "\r\n"
	}
	norm := strings.ReplaceAll(string(b), "\r\n", "\n")
	hadTrailing := strings.HasSuffix(norm, "\n")
	lines := strings.Split(strings.TrimSuffix(norm, "\n"), "\n")
	if q.Start > len(lines) || q.End > len(lines) {
		return Res{Error: fmt.Sprintf("line range %d-%d exceeds file length %d", q.Start, q.End, len(lines))}
	}
	content := strings.ReplaceAll(q.Content, "\r\n", "\n")
	content = strings.TrimSuffix(content, "\n")
	var repl []string
	if content != "" {
		repl = strings.Split(content, "\n")
	}
	outLines := append([]string{}, lines[:q.Start-1]...)
	outLines = append(outLines, repl...)
	outLines = append(outLines, lines[q.End:]...)
	outText := strings.Join(outLines, "\n")
	if hadTrailing {
		outText += "\n"
	}
	if sep == "\r\n" {
		outText = strings.ReplaceAll(outText, "\n", "\r\n")
	}
	if err := os.WriteFile(p, []byte(outText), fileMode(p)); err != nil {
		return Res{Error: err.Error()}
	}
	return Res{Data: fmt.Sprintf("replaced lines %d-%d in %s", q.Start, q.End, p), SHA256: hashBytes([]byte(outText))}
}

func replaceText(q Req) Res {
	p := clean(q.Path)
	if q.Old == "" {
		return Res{Error: "replace_text requires old"}
	}
	if err := checkExpected(p, q.ExpectedSHA256); err != nil {
		return Res{Error: err.Error()}
	}
	b, err := os.ReadFile(p)
	if err != nil {
		return Res{Error: err.Error()}
	}
	text := string(b)
	count := strings.Count(text, q.Old)
	if count == 0 {
		return Res{Error: "old text not found"}
	}
	if count != 1 {
		return Res{Error: fmt.Sprintf("old text matched %d times; refusing ambiguous replacement", count)}
	}
	outText := strings.Replace(text, q.Old, q.New, 1)
	if err := os.WriteFile(p, []byte(outText), fileMode(p)); err != nil {
		return Res{Error: err.Error()}
	}
	return Res{Data: "replaced exact text in " + p, SHA256: hashBytes([]byte(outText))}
}

func mkdir(q Req) Res {
	p := clean(q.Path)
	if err := os.MkdirAll(p, 0755); err != nil {
		return Res{Error: err.Error()}
	}
	return Res{Data: "created " + p}
}

func renamePath(q Req) Res {
	from := clean(q.Path)
	to := clean(q.NewPath)
	if to == "." || q.NewPath == "" {
		return Res{Error: "rename requires new_path"}
	}
	if err := os.MkdirAll(filepath.Dir(to), 0755); err != nil {
		return Res{Error: err.Error()}
	}
	if err := os.Rename(from, to); err != nil {
		return Res{Error: err.Error()}
	}
	return Res{Data: from + " -> " + to}
}

func deletePath(q Req) Res {
	p := clean(q.Path)
	if q.Recursive {
		if err := os.RemoveAll(p); err != nil {
			return Res{Error: err.Error()}
		}
		return Res{Data: "deleted recursively " + p}
	}
	if err := os.Remove(p); err != nil {
		return Res{Error: err.Error()}
	}
	return Res{Data: "deleted " + p}
}

func fileMode(p string) os.FileMode {
	if s, err := os.Stat(p); err == nil {
		return s.Mode()
	}
	return 0644
}

func execCmd(q Req) Res {
	cmdStr := q.Command
	if cmdStr == "" {
		cmdStr = q.Cmd
	}
	if cmdStr == "" {
		cmdStr = q.Content
	}
	cmdStr = strings.TrimSpace(cmdStr)
	if cmdStr == "" {
		return Res{Error: "exec requires a command"}
	}

	cwd := q.Cwd
	if cwd == "" {
		cwd = q.Path
	}
	if cwd != "" {
		cwd = clean(cwd)
	} else {
		cwd = "."
	}

	timeoutSec := q.Timeout
	if timeoutSec <= 0 {
		timeoutSec = 60
	}
	if timeoutSec > 600 {
		timeoutSec = 600
	}

	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeoutSec)*time.Second)
	defer cancel()

	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		cmd = exec.CommandContext(ctx, "powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", cmdStr)
	} else {
		cmd = exec.CommandContext(ctx, "sh", "-c", cmdStr)
	}

	if cwd != "" && cwd != "." {
		cmd.Dir = cwd
	}

	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0", "CI=true", "TERM=dumb")

	var buf bytes.Buffer
	cmd.Stdout = &buf
	cmd.Stderr = &buf

	err := cmd.Run()

	outBytes := buf.Bytes()
	truncated := false
	const maxExecOutput = 512 * 1024 // 512KB
	if len(outBytes) > maxExecOutput {
		outBytes = outBytes[:maxExecOutput]
		truncated = true
	}

	outStr := strings.TrimRight(string(outBytes), "\r\n")

	if ctx.Err() == context.DeadlineExceeded {
		return Res{
			OK:        false,
			Data:      outStr,
			Error:     fmt.Sprintf("command timed out after %d seconds", timeoutSec),
			Truncated: truncated,
		}
	}

	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			errMsg := fmt.Sprintf("exit code %d", exitErr.ExitCode())
			if outStr == "" {
				outStr = errMsg
			}
			return Res{
				OK:        false,
				Data:      outStr,
				Error:     errMsg,
				Truncated: truncated,
			}
		}
		return Res{
			OK:        false,
			Data:      outStr,
			Error:     err.Error(),
			Truncated: truncated,
		}
	}

	if outStr == "" {
		outStr = "(command finished with no output)"
	}

	return Res{
		OK:        true,
		Data:      outStr,
		Truncated: truncated,
	}
}

