# Moreno.GPTFS

A Wails v3 desktop wrapper around `chatgpt.com` with GPTFS injected directly into the WebView — the model gets a real local filesystem bridge without any localhost HTTP server.

## Run

Requires Go 1.24+ and the Microsoft WebView2 Runtime.

```powershell
./scripts/run.ps1
```

Or:

```powershell
go mod tidy
go run .
```

Your ChatGPT login/profile is persisted under:

```text
%APPDATA%\Moreno.GPTFS\WebView2
```

## Build EXE

```powershell
./scripts/build.ps1
```

This produces `Moreno.GPTFS.exe`.

## GPTFS

The `FS OFF` button is injected in the lower-right corner of ChatGPT.

- **Arm / Disarm**: Controls filesystem and code execution automation.
- **Teach this chat**: Sends the GPTFS protocol instructions to the current conversation.
- **Ping native bridge**: Verifies Go ↔ WebView IPC.
- **⚡ Exec Permissions**: Configure command execution behavior (Ask each time / Allowed for session).
- **F12**: Opens WebView DevTools.

The backend supports: `ping`, `exec`, `read`, `context`, `ls`, `tree`, `grep`, `glob`, `find`, `stat`, `write`, `replace_range`, `replace_text`, `mkdir`, `rename`, and `delete`.

### Command Execution (`exec`)

When the AI model requests terminal command execution, an interactive confirmation dialog is presented:
- **Accept Once**: Allows this single command execution.
- **Accept Session**: Automatically allows all commands for the remainder of this session.
- **Deny**: Rejects the command and sends an error back to the model.

#### Example single-line command:
```text
@@GPTFS:cmd1
op=exec
cwd=C:/Users/null/Desktop/project
command=git status
@@END:cmd1
```

#### Example multi-line script:
```text
@@GPTFS:cmd2
op=exec
cwd=C:/Users/null/Desktop/project
@@CONTENT
npm test
@@END:cmd2
```

#### Example file read:
```text
@@GPTFS:req1
op=read
path=C:/Users/null/Desktop/project/main.go
start=1
end=200
@@END:req1
```

Results are returned to the model as `@@GPTFS_RESULT` blocks and treated as tool output.

The bridge uses Wails raw WebView messages, not an exposed localhost HTTP server. Requests are accepted only when Wails reports the sending origin/top-origin as `https://chatgpt.com` or `https://www.chatgpt.com`, and each app launch uses a random session token.
