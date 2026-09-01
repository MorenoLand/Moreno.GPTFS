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

- Arm / Disarm controls filesystem automation.
- Teach this chat sends the GPTFS protocol to a new conversation.
- Ping native bridge verifies Go ↔ WebView IPC.
- F12 opens WebView devtools.

The filesystem backend has the permissions of the desktop app process. It supports `ping`, `read`, `context`, `ls`, `tree`, `grep`, `glob`, `find`, `stat`, `write`, `replace_range`, `replace_text`, `mkdir`, `rename`, and `delete`.

Requests use tagged blocks so file content can safely contain GPTFS markers:

```text
@@GPTFS:req1
op=read
path=G:/Dev/project/main.go
start=1
end=200
@@END:req1
```

Results are returned to the model as `@@GPTFS_RESULT` blocks and treated as tool output.

The bridge uses Wails raw WebView messages, not an exposed localhost HTTP server. Requests are accepted only when Wails reports the sending origin/top-origin as `https://chatgpt.com` or `https://www.chatgpt.com`, and each app launch uses a random session token.
