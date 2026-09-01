package main

import (
"crypto/rand"
"embed"
"encoding/hex"
"encoding/json"
"log"
"net/url"
"os"
"path/filepath"
"strings"
"time"

"github.com/wailsapp/wails/v3/pkg/application"
"github.com/wailsapp/wails/v3/pkg/events"

)

//go:embed inject.js
var embedded embed.FS

type nativeRequest struct {
Type string
Token string
ID string
Stage string
Request Req
}

type nativeResponse struct {
	ID     string `json:"id"`
	Result Res    `json:"result"`
}

func main() {
	injector, err := embedded.ReadFile("inject.js")
	if err != nil {
		log.Fatal(err)
	}

	token := randomToken()
	config, _ := json.Marshal(map[string]string{"token": token})
	injectedJS := "window.__CHATGPT_GPTFS__=" + string(config) + ";\n" + string(injector)

	dataDir := webviewDataDir()
	_ = os.MkdirAll(dataDir, 0700)

	app := application.New(application.Options{
		Name:        "Moreno.GPTFS",
		Description: "ChatGPT desktop wrapper with local filesystem tools",
		Windows: application.WindowsOptions{
			WebviewUserDataPath: dataDir,
		},
RawMessageHandler: func(window application.Window, message string, originInfo *application.OriginInfo) {
if !trustedOrigin(originInfo) {
if strings.Contains(message, "chatgpt-gptfs") {
log.Printf("GPTFS RX rejected: untrusted origin")
}
return
}

		var req nativeRequest
		if err := json.Unmarshal([]byte(message), &req); err != nil {
			if strings.Contains(message, "chatgpt-gptfs") {
				log.Printf("GPTFS RX rejected: invalid JSON: %v", err)
			}
			return
		}

		if req.Type == "chatgpt-gptfs-ack" {
			if req.Token != token || req.ID == "" {
				log.Println("GPTFS ACK rejected")
				return
			}
			log.Printf("GPTFS ACK id=%s stage=%s", req.ID, req.Stage)
			return
		}

		if req.Type != "chatgpt-gptfs" || req.Token != token || req.ID == "" {
			if strings.HasPrefix(req.Type, "chatgpt-gptfs") {
				log.Printf("GPTFS RX rejected: type=%q id=%q", req.Type, req.ID)
			}
			return
		}

		go func(req nativeRequest) {
			started := time.Now()
			log.Printf("GPTFS RX id=%s op=%s path=%q", req.ID, req.Request.Op, req.Request.Path)

			result := dispatch(req.Request)

			log.Printf(
				"GPTFS DONE id=%s op=%s ok=%v elapsed=%s error=%q",
				req.ID,
				req.Request.Op,
				result.OK,
				time.Since(started).Round(time.Millisecond),
				result.Error,
			)

			res := nativeResponse{ID: req.ID, Result: result}
			payload, err := json.Marshal(res)
			if err != nil {
				log.Printf("GPTFS TX marshal failed id=%s: %v", req.ID, err)
				return
			}

			log.Printf("GPTFS TX id=%s bytes=%d", req.ID, len(payload))
			window.ExecJS("window.__CHATGPT_GPTFS_RECEIVE__&&window.__CHATGPT_GPTFS_RECEIVE__(" + string(payload) + ")")
			log.Printf("GPTFS TX queued id=%s", req.ID)
		}(req)
	},
	})

chatURL := "https:" + "//chatgpt.com/"
encodedURL, _ := json.Marshal(chatURL)
bootstrapHTML := "<!doctype html><html><head><meta charset='utf-8'></head><body><script>location.replace(" + string(encodedURL) + ")</script></body></html>"

window := app.Window.NewWithOptions(application.WebviewWindowOptions{
	Name:               "chatgpt",
	Title:              "Moreno.GPTFS",
	HTML:               bootstrapHTML,
	JS:                 injectedJS,
	Width:              1500,
	Height:             950,
	MinWidth:           900,
	MinHeight:          650,
	BackgroundColour:   application.NewRGB(13, 13, 13),
	DevToolsEnabled:    true,
	ZoomControlEnabled: true,
	Windows: application.WindowsWindow{
		GeneralAutofillEnabled:  true,
		PasswordAutosaveEnabled: true,
	},
	KeyBindings: map[string]func(application.Window){
		"F12": func(w application.Window) { w.OpenDevTools() },
	},
})

window.OnWindowEvent(events.Windows.WebViewNavigationCompleted, func(_ *application.WindowEvent) {
	log.Println("GPTFS: navigation completed; reinjecting")
	window.ExecJS(injectedJS)
})

	window.Show()
	if err := app.Run(); err != nil {
		log.Fatal(err)
	}
}

func randomToken() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

func trustedOrigin(info *application.OriginInfo) bool {
	if info == nil || !isChatGPTOrigin(info.Origin) {
		return false
	}
	if info.TopOrigin != "" && !isChatGPTOrigin(info.TopOrigin) {
		return false
	}
	return true
}

func isChatGPTOrigin(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil || !strings.EqualFold(u.Scheme, "https") {
		return false
	}
	host := strings.ToLower(u.Hostname())
	return host == "chatgpt.com" || host == "www.chatgpt.com"
}

func webviewDataDir() string {
	base, err := os.UserConfigDir()
	if err != nil {
		base = "."
	}
	return filepath.Join(base, "Moreno.GPTFS", "WebView2")
}
