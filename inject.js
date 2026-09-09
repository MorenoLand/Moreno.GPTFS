(() => {
"use strict"

if (!/(^|\.)chatgpt\.com$/i.test(location.hostname)) return

const cfg = window.__CHATGPT_GPTFS__
try { delete window.__CHATGPT_GPTFS__ } catch {}

function notifyRuntimeReady() {
    try {
        if (window.chrome?.webview?.postMessage) window.chrome.webview.postMessage("wails:runtime:ready")
        else if (window.webkit?.messageHandlers?.external?.postMessage) window.webkit.messageHandlers.external.postMessage("wails:runtime:ready")
    } catch {}
}
notifyRuntimeReady()

// STRICT SINGLETON GUARD:
// If an instance is already running in this window context, update its token and exit immediately.
// This prevents multiple concurrent scanning loops, duplicate IPC calls, and orphaned timeout cascades.
if (window.__GPTFS_INSTANCE__) {
    if (cfg?.token) window.__GPTFS_INSTANCE__.token = cfg.token
    return
}

if (!cfg?.token) return
const TOKEN = cfg.token

window.__GPTFS_INSTANCE__ = {
    token: TOKEN,
    startedAt: Date.now()
}

const POLL_MS = 300
const STABLE_MS = 1200

// Shared IPC pending map on window to survive any potential re-binds
window.__GPTFS_PENDING__ = window.__GPTFS_PENDING__ || new Map()
const pending = window.__GPTFS_PENDING__

const seen = new Set(JSON.parse(localStorage.getItem("gptfs.desktop.processed") || "[]"))
const inFlight = new Set()
const states = new Map()

let armed = localStorage.getItem("gptfs.desktop.armed") === "1"
let showProtocol = localStorage.getItem("gptfs.desktop.showProtocol") === "1"
let sessionExecAllowed = false
let route = location.pathname
let busy = false
let pendingDelivery = null
let deliveryFailCount = 0
let baseline = new Set()
let hydrating = true
let hydrateCount = -1
let hydrateChangedAt = Date.now()
let button, panel, armButton, protocolButton, sessionExecBtn

const sleep = ms => new Promise(r => setTimeout(r, ms))
const messages = role => [...document.querySelectorAll(`[data-message-author-role="${role}"]`)]
const assistantMessages = () => messages("assistant")
const userMessages = () => messages("user")

function saveSeen() {
    localStorage.setItem("gptfs.desktop.processed", JSON.stringify([...seen].slice(-2000)))
}

function hash(s) {
    let h = 2166136261
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i)
        h = Math.imul(h, 16777619)
    }
    return (h >>> 0).toString(16).padStart(8, "0")
}

function escapeHtml(str) {
    return String(str || "").replace(/[&<>"']/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]))
}

window.__CHATGPT_GPTFS_RECEIVE__ = payload => {
    const id = String(payload?.id || "")
    const p = pending.get(id)
    const activeToken = window.__GPTFS_INSTANCE__?.token || TOKEN

    try {
        const ack = JSON.stringify({
            type: "chatgpt-gptfs-ack",
            token: activeToken,
            id: id,
            stage: p ? "pending-hit" : "pending-miss"
        })

        if (window._wails?.invoke) window._wails.invoke(ack)
        else if (window.chrome?.webview?.postMessage) window.chrome.webview.postMessage(ack)
    } catch {}

    if (!p) {
        console.warn("[GPTFS] receive: pending-miss for id:", id)
        return
    }
    pending.delete(id)
    clearTimeout(p.timer)
    p.resolve(payload.result || { ok: false, error: "invalid native response" })
}

function native(body) {
    return new Promise((resolve, reject) => {
        const id = crypto.randomUUID()
        const timeoutMs = (body.timeout ? (body.timeout + 15) : 90) * 1000
        const timer = setTimeout(() => {
            if (pending.has(id)) {
                pending.delete(id)
                reject(new Error("GPTFS request timed out after " + Math.round(timeoutMs / 1000) + "s"))
            }
        }, timeoutMs)

        pending.set(id, { resolve, reject, timer })
        const token = window.__GPTFS_INSTANCE__?.token || TOKEN
        const msg = JSON.stringify({ type: "chatgpt-gptfs", token, id, request: body })

        try {
            if (window._wails?.invoke) return void window._wails.invoke(msg)
            if (window.chrome?.webview?.postMessage) return void window.chrome.webview.postMessage(msg)
            throw new Error("Wails native message bridge unavailable")
        } catch (e) {
            pending.delete(id)
            clearTimeout(timer)
            reject(e)
        }
    })
}

function parseKV(text) {
const out = {}
for (const raw of text.split("\n")) {
const line = raw.trim()
if (!line || line.startsWith("#")) continue
const i = line.indexOf("=")
if (i < 1) throw new Error("invalid header line: " + line)
const key = line.slice(0, i).trim()
let value = line.slice(i + 1).trim()
if (key === "args" && value.startsWith("[")) value = JSON.parse(value)
else if (/^(true|false)$/i.test(value)) value = value.toLowerCase() === "true"
else if (/^-?\d+$/.test(value)) value = Number(value)
out[key] = value
}
return out
}

function parseHeader(text) {
    text = text.trim()
    if (!text) throw new Error("empty GPTFS request")
    if (!text.startsWith("{")) return parseKV(text)
    try { return JSON.parse(text) } catch {
        return JSON.parse(text.replace(/"(path|new_path|cwd)"\s*:\s*"([^"\n]*)"/g, (_, k, v) => `"${k}":${JSON.stringify(v.replace(/\\/g, "/"))}`))
    }
}

function parseBody(body) {
    const sections = { header: [] }
    let mode = "header"
    for (const line of body.replace(/\r\n/g, "\n").split("\n")) {
        if (line === "@@CONTENT") { mode = "content"; sections[mode] = []; continue }
        if (line === "@@OLD") { mode = "old"; sections[mode] = []; continue }
        if (line === "@@NEW") { mode = "new"; sections[mode] = []; continue }
        sections[mode].push(line)
    }
    const req = parseHeader(sections.header.join("\n"))
    if (sections.content) req.content = sections.content.join("\n")
    if (sections.old) req.old = sections.old.join("\n")
    if (sections.new) req.new = sections.new.join("\n")
    return req
}

function parseTagged(text) {
    const out = []
    const start = /^[ \t]*(?:```[a-zA-Z0-9_-]*[ \t]*\n)?[ \t]*@@GPTFS:([A-Za-z0-9._-]+)[ \t]*$/gm
    let m

    while ((m = start.exec(text))) {
        const tag = m[1]
        const tail = text.slice(start.lastIndex)
        const endRe = new RegExp("(?:\\r?\\n|[ \\t]+)@@END:" + tag + "(?:[ \\t]*```)*\\b")
        const endMatch = endRe.exec(tail)
        if (!endMatch) continue

        const bodyEnd = start.lastIndex + endMatch.index
        const rawEnd = bodyEnd + endMatch[0].length
        const raw = text.slice(m.index, rawEnd)
        const body = text.slice(start.lastIndex, bodyEnd).replace(/^\r?\n/, "")

        try { out.push({ req: parseBody(body), raw }) }
        catch (e) { out.push({ req: { __parse_error: e.message, __raw: body }, raw }) }

        start.lastIndex = rawEnd
    }

    return out
}

function parseLegacyBlocks(text) {
    const out = []
    const startRe = /(?:^|\n)[ \t]*(?:```[a-zA-Z0-9_-]*[ \t]*\n)?[ \t]*@@GPTFS[ \t]*(?:\n|$)/g
    let m
    while ((m = startRe.exec(text))) {
        const begin = m.index === 0 ? 0 : m.index + 1
        const bodyStart = startRe.lastIndex
        const tail = text.slice(bodyStart)
        const endMatch = /(?:\n|[ \t]+)@@END(?:[ \t]*```)*\b/.exec(tail)
        if (!endMatch) continue

        const bodyEnd = bodyStart + endMatch.index
        const rawEnd = bodyEnd + endMatch[0].length
        const raw = text.slice(begin, rawEnd)
        const body = text.slice(bodyStart, bodyEnd).replace(/^\r?\n/, "")

        try { out.push({ req: parseBody(body), raw }) }
        catch (e) { out.push({ req: { __parse_error: e.message, __raw: body }, raw }) }

        startRe.lastIndex = rawEnd
    }
    return out
}

function tokens(s) {
    return (s.match(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\S+/g) || []).map(x => {
        if ((x.startsWith('"') && x.endsWith('"')) || (x.startsWith("'") && x.endsWith("'"))) return x.slice(1, -1)
        return x
    })
}

function parseLegacyLine(line) {
    const cleanLine = line.trim().replace(/^[-*`\s]+|[`\s]+$/g, "")
    const t = tokens(cleanLine)
    const cmd = t.shift()
    if (!cmd?.startsWith("@fs-")) return null
    if (cmd === "@fs-ping") return { op: "ping" }
    if (cmd === "@fs-exec" || cmd === "@fs-run" || cmd === "@fs-cmd" || cmd === "@fs-sh" || cmd === "@fs-bash") {
        return { op: "exec", command: t.join(" ") }
    }
    if (cmd === "@fs-ls") return { op: "ls", path: t.join(" ") }
    if (cmd === "@fs-stat") return { op: "stat", path: t.join(" ") }
    if (cmd === "@fs-tree") {
        const depth = /^\d+$/.test(t.at(-1) || "") ? +t.pop() : 3
        return { op: "tree", path: t.join(" "), depth }
    }
    if (cmd === "@fs-read") {
        let end = 400, start = 1
        if (/^\d+$/.test(t.at(-1) || "")) end = +t.pop()
        if (/^\d+$/.test(t.at(-1) || "")) start = +t.pop()
        return { op: "read", path: t.join(" "), start, end }
    }
    if (cmd === "@fs-context") {
        const radius = /^\d+$/.test(t.at(-1) || "") ? +t.pop() : 30
        const start = /^\d+$/.test(t.at(-1) || "") ? +t.pop() : 0
        return { op: "context", path: t.join(" "), start, radius }
    }
    if (cmd === "@fs-grep") return { op: "grep", query: t.shift() || "", path: t.join(" ") }
    if (cmd === "@fs-glob") return { op: "glob", pattern: t.shift() || "", path: t.join(" ") }
    if (cmd === "@fs-find") return { op: "find", query: t.shift() || "", path: t.join(" "), ignore_case: true }
    return null
}

function parseLegacy(text) {
    return text.split(/\r?\n/)
        .map(x => x.trim().replace(/^[-*`\s]+|[`\s]+$/g, ""))
        .filter(x => /^@fs-(ping|exec|run|cmd|sh|bash|read|context|ls|tree|grep|glob|find|stat)\b/.test(x))
        .map(raw => ({ req: parseLegacyLine(raw), raw }))
        .filter(x => x.req)
}

function normalizeProtocolText(text) {
    return String(text || "")
        .replace(/\r\n?/g, "\n")
        .replace(/\u00a0/g, " ")
}

function parseRequests(text) {
    text = normalizeProtocolText(text)
    const tagged = parseTagged(text)
    if (tagged.length) return tagged
    const blocks = parseLegacyBlocks(text)
    return blocks.length ? blocks : parseLegacy(text)
}

function rawText(el) {
    return normalizeProtocolText(el?.__gptfsRawText ?? el?.innerText ?? el?.textContent ?? "")
}

function requestOnly(text) {
    const reqs = parseRequests(text)
    if (!reqs.length) return false
    let rest = text
    for (const r of reqs) rest = rest.replace(r.raw, "")
    return rest.trim() === ""
}

function resultOnly(text) {
    if (!text.includes("@@GPTFS_RESULT")) return false
    return text.replace(/@@GPTFS_RESULT(?::[A-Za-z0-9._-]+)?[\s\S]*?@@END_RESULT(?::[A-Za-z0-9._-]+)?/g, "").trim() === ""
}

function summarizeRequest(text) {
    const items = parseRequests(text)
    if (!items.length) return "FS → request"
    if (items.length > 1) return `FS → ${items.length} operations`
    const r = items[0].req || {}
    if (r.op === "exec" || r.op === "run" || r.op === "cmd") {
        const cmd = r.command || r.cmd || (r.content ? r.content.split("\n")[0] : "") || "command"
        const short = cmd.length > 30 ? cmd.slice(0, 27) + "..." : cmd
        return `FS → exec: ${short}`
    }
    const name = r.path ? String(r.path).replace(/\\/g, "/").split("/").filter(Boolean).at(-1) : ""
    return `FS → ${r.op || "request"}${name ? " · " + name : ""}`
}

function summarizeResult(text) {
    const metas = []
    const re = /@@GPTFS_RESULT(?::[A-Za-z0-9._-]+)?[ \t]*\n(\{[^\n]*\})[\s\S]*?@@END_RESULT(?::[A-Za-z0-9._-]+)?/g
    let m
    while ((m = re.exec(text))) { try { metas.push(JSON.parse(m[1])) } catch {} }
    if (!metas.length) return { label: "FS ← result", ok: true }
    const ok = metas.every(x => x.ok)
    if (metas.length > 1) return { label: `FS ${ok ? "✓" : "✕"} ${metas.length} operations`, ok }
    const x = metas[0]
    if (x.op === "exec" || x.op === "run" || x.op === "cmd") {
        return { label: `FS ${x.ok ? "✓" : "✕"} exec`, ok: !!x.ok }
    }
    const name = x.path ? String(x.path).replace(/\\/g, "/").split("/").filter(Boolean).at(-1) : ""
    return { label: `FS ${x.ok ? "✓" : "✕"} ${x.op || "result"}${name ? " · " + name : ""}`, ok: !!x.ok }
}

function decorate(el, label, ok = true) {
    if (!el.__gptfsRawText) el.__gptfsRawText = el.innerText || el.textContent || ""
    let chip = el.querySelector(':scope > [data-gptfs-chip="1"]')
    if (!chip) {
        chip = document.createElement("div")
        chip.dataset.gptfsChip = "1"
        chip.style.cssText = "align-self:flex-start;display:inline-flex;align-items:center;gap:8px;min-height:32px;padding:5px 11px;margin:1px 0;border:1px solid color-mix(in srgb,currentColor 24%,transparent);border-radius:10px;background:color-mix(in srgb,currentColor 7%,transparent);font:500 12px/1.3 ui-sans-serif,system-ui,-apple-system,sans-serif;letter-spacing:.01em;cursor:pointer;user-select:none"
        for (const child of [...el.children]) {
            child.dataset.gptfsOriginal = "1"
            child.dataset.gptfsOldDisplay = child.style.display || ""
        }
        chip.onclick = () => {
            el.dataset.gptfsReveal = el.dataset.gptfsReveal === "1" ? "0" : "1"
            applyVisibility(el)
        }
        el.appendChild(chip)
    }
    chip.replaceChildren()
    const mark = document.createElement("span")
    mark.textContent = ok ? "✓" : "!"
    mark.style.cssText = "display:grid;place-items:center;width:18px;height:18px;border-radius:50%;background:color-mix(in srgb,currentColor 16%,transparent);font:700 11px/1 ui-sans-serif,system-ui"
    const text = document.createElement("span")
    text.textContent = label.replace(/^FS\s*(?:✓|✕)?\s*/, "")
    chip.replaceChildren(mark, text)
    chip.style.color = ok ? "#91a89a" : "#d88"
    applyVisibility(el)
}

function applyVisibility(el) {
    const chip = el.querySelector(':scope > [data-gptfs-chip="1"]')
    if (!chip) return
    const reveal = showProtocol || el.dataset.gptfsReveal === "1"
    for (const child of [...el.children]) {
        if (child === chip) continue
        if (!child.dataset.gptfsOriginal) {
            child.dataset.gptfsOriginal = "1"
            child.dataset.gptfsOldDisplay = child.style.display || ""
        }
        child.style.display = reveal ? (child.dataset.gptfsOldDisplay || "") : "none"
    }
    chip.style.display = "inline-flex"
    chip.title = reveal ? "Click to collapse GPTFS protocol" : "Click to reveal GPTFS protocol"
}

function decorateMessages() {
    for (const el of assistantMessages()) {
        const text = rawText(el)
        if (requestOnly(text)) decorate(el, summarizeRequest(text), true)
    }
    for (const el of userMessages()) {
        const text = rawText(el)
        if (!resultOnly(text)) continue
        const s = summarizeResult(text)
        decorate(el, s.label, s.ok)
    }
}

function formatResult(req, res) {
    const id = crypto.randomUUID()
    const meta = { id, op: req.op, path: req.path || req.cwd || undefined, ok: !!res.ok, sha256: res.sha256 || undefined, truncated: !!res.truncated, error: res.error || undefined }
    const data = res.data || (Array.isArray(res.items) ? res.items.join("\n") : "") || "(empty)"
    return { id, text: `@@GPTFS_RESULT:${id}\n${JSON.stringify(meta)}\n@@DATA\n${data}\n@@END_RESULT:${id}` }
}

function formatParseError(req) {
    const id = crypto.randomUUID()
    const meta = { id, op: "parse_error", ok: false, error: req.__parse_error }
    return { id, text: `@@GPTFS_RESULT:${id}\n${JSON.stringify(meta)}\n@@DATA\n${req.__raw || ""}\n@@END_RESULT:${id}` }
}

function composer() {
    return document.querySelector('#prompt-textarea[contenteditable="true"]') ||
           document.querySelector('#prompt-textarea') ||
           document.querySelector('div.ProseMirror[contenteditable="true"]') ||
           document.querySelector('div[contenteditable="true"][data-placeholder]') ||
           document.querySelector('textarea[data-id="root"]')
}

function composerText() {
    const el = composer()
    if (!el) return ""
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
        return (el.value || "").trim()
    }
    return (el.innerText || el.textContent || "").replace(/\u00a0/g, " ").trim()
}

function setComposer(text) {
    const el = composer()
    if (!el) throw new Error("ChatGPT composer not found")
    el.focus()

    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
        el.value = text
        el.dispatchEvent(new Event("input", { bubbles: true }))
        el.dispatchEvent(new Event("change", { bubbles: true }))
        return
    }

    el.replaceChildren()
    for (const line of text.split("\n")) {
        const p = document.createElement("p")
        if (line) p.textContent = line
        else p.appendChild(document.createElement("br"))
        el.appendChild(p)
    }
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }))
    el.dispatchEvent(new Event("change", { bubbles: true }))
}

function sendButton() {
    return document.querySelector('[data-testid="send-button"]') ||
           document.querySelector('#composer-submit-button') ||
           document.querySelector('button[data-testid="fruitjuice-send-button"]') ||
           document.querySelector('button[aria-label*="Send" i]')
}

function isGenerating() {
    return !!document.querySelector('button[data-testid="stop-button"],button[aria-label*="Stop generating" i],button[aria-label*="Stop response" i],[data-message-streaming="true"],.result-streaming')
}

async function waitUntil(fn, timeout, interval = 100) {
    const end = Date.now() + timeout
    while (Date.now() < end) {
        if (fn()) return true
        await sleep(interval)
    }
    return false
}

function resultVisible(ids) {
    if (!ids || !ids.length) return false
    const text = userMessages().map(rawText).join("\n")
    return ids.some(id => text.includes(id))
}

async function sendPrompt(text, ids = []) {
    if (!await waitUntil(() => !isGenerating(), 30000, 150)) throw new Error("assistant generation did not finish")
    if (resultVisible(ids)) return true

    const before = userMessages().length
    setComposer(text)
    if (!await waitUntil(() => composerText(), 2500)) throw new Error("could not fill ChatGPT composer")

    await waitUntil(() => {
        const b = sendButton()
        return b && !b.disabled && b.getAttribute("aria-disabled") !== "true" && !isGenerating()
    }, 4000)

    renderStatus("SEND")
    const btn = sendButton()
    if (btn && !btn.disabled && btn.getAttribute("aria-disabled") !== "true") {
        btn.click()
    }

    if (await waitUntil(() => resultVisible(ids) || userMessages().length > before || composerText() === "", 3000)) return true

    const c = composer()
    if (c && composerText()) {
        c.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }))
        if (await waitUntil(() => resultVisible(ids) || userMessages().length > before || composerText() === "", 4000)) return true
    }

    if (resultVisible(ids)) return true
    throw new Error("ChatGPT did not accept the generated prompt")
}

function promptExecApproval(req) {
    return new Promise(resolve => {
        const cmd = req.command || req.cmd || req.content || "(empty command)"
        const cwd = req.cwd || req.path || "(current directory)"

        const overlay = document.createElement("div")
        overlay.id = "gptfs-exec-modal-overlay"
        overlay.style.cssText = [
            "position:fixed",
            "top:0",
            "left:0",
            "width:100vw",
            "height:100vh",
            "background:rgba(0,0,0,0.65)",
            "backdrop-filter:blur(4px)",
            "z-index:2147483647",
            "display:flex",
            "align-items:center",
            "justify-content:center",
            "font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif"
        ].join(";")

        const modal = document.createElement("div")
        modal.style.cssText = [
            "width:min(620px, 92vw)",
            "background:#18181b",
            "border:1px solid #3f3f46",
            "border-radius:12px",
            "padding:20px",
            "box-shadow:0 20px 40px rgba(0,0,0,0.7)",
            "color:#f4f4f5",
            "display:flex",
            "flex-direction:column",
            "gap:14px"
        ].join(";")

        const header = document.createElement("div")
        header.style.cssText = "display:flex;align-items:center;gap:12px;"
        header.innerHTML = `
            <div style="width:32px;height:32px;border-radius:8px;background:#2563eb;display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:bold;color:#fff;">⚡</div>
            <div>
                <div style="font-size:15px;font-weight:600;color:#fafafa;">Execute Terminal Command</div>
                <div style="font-size:12px;color:#a1a1aa;">The AI model requested to run code on your system.</div>
            </div>
        `

        const details = document.createElement("div")
        details.style.cssText = "display:flex;flex-direction:column;gap:8px;"

        const cwdRow = document.createElement("div")
        cwdRow.style.cssText = "font-size:11px;color:#71717a;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;word-break:break-all;"
        cwdRow.innerHTML = `<span style="color:#a1a1aa;font-weight:600;">cwd:</span> ${escapeHtml(cwd)}`

        const codeBox = document.createElement("pre")
        codeBox.style.cssText = [
            "margin:0",
            "padding:12px",
            "background:#09090b",
            "border:1px solid #27272a",
            "border-radius:8px",
            "font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace",
            "font-size:12px",
            "line-height:1.5",
            "color:#4ade80",
            "max-height:220px",
            "overflow:auto",
            "white-space:pre-wrap",
            "word-break:break-all"
        ].join(";")
        codeBox.textContent = cmd

        details.appendChild(cwdRow)
        details.appendChild(codeBox)

        const btnRow = document.createElement("div")
        btnRow.style.cssText = "display:flex;align-items:center;justify-content:flex-end;gap:8px;margin-top:4px;"

        function close(decision) {
            document.removeEventListener("keydown", keyHandler)
            overlay.remove()
            resolve(decision)
        }

        const denyBtn = document.createElement("button")
        denyBtn.textContent = "Deny"
        denyBtn.title = "Reject this command (Esc)"
        denyBtn.style.cssText = "padding:7px 14px;border:1px solid #ef4444;border-radius:6px;background:#271717;color:#fca5a5;cursor:pointer;font-size:13px;font-weight:500;"
        denyBtn.onclick = () => close("deny")

        const sessionBtn = document.createElement("button")
        sessionBtn.textContent = "Accept Session"
        sessionBtn.title = "Allow commands automatically for this browser session"
        sessionBtn.style.cssText = "padding:7px 14px;border:1px solid #3b82f6;border-radius:6px;background:#172554;color:#93c5fd;cursor:pointer;font-size:13px;font-weight:500;"
        sessionBtn.onclick = () => close("session")

        const onceBtn = document.createElement("button")
        onceBtn.textContent = "Accept Once"
        onceBtn.title = "Run this command once (Enter)"
        onceBtn.style.cssText = "padding:7px 16px;border:1px solid #22c55e;border-radius:6px;background:#14532d;color:#86efac;cursor:pointer;font-size:13px;font-weight:600;"
        onceBtn.onclick = () => close("once")

        btnRow.appendChild(denyBtn)
        btnRow.appendChild(sessionBtn)
        btnRow.appendChild(onceBtn)

        modal.appendChild(header)
        modal.appendChild(details)
        modal.appendChild(btnRow)
        overlay.appendChild(modal)
        document.body.appendChild(overlay)

        function keyHandler(e) {
            if (e.key === "Escape") {
                e.preventDefault()
                close("deny")
            } else if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault()
                close("once")
            }
        }

        document.addEventListener("keydown", keyHandler)
        onceBtn.focus()
    })
}

async function execute(items) {
const results = []
for (const item of items) {
if (item.req.__parse_error) { results.push(formatParseError(item.req)); continue }
const op = item.req.op
const isExec = op === "exec" || op === "run" || op === "cmd" || op === "powershell" || op === "bash" || op === "sh" || op === "spawn" || op === "stdin" || op === "kill"
if (isExec) {
if (!sessionExecAllowed) {
renderStatus("EXEC?")
const decision = await promptExecApproval(item.req)
if (decision === "deny") {
const cmdName = item.req.command || item.req.cmd || item.req.session || item.req.content || "command"
results.push(formatResult(item.req, { ok: false, error: "Execution denied by user: " + cmdName }))
continue
}
if (decision === "session") {
sessionExecAllowed = true
updateSessionExecBtn()
}
}
}
try { results.push(formatResult(item.req, await native(item.req))) }
catch (e) { results.push(formatResult(item.req, { ok: false, error: e.message || String(e) })) }
}
return results
}

function messageKey(el) {
    if (!el) return "msg_unknown"
    const dataId = el.dataset?.messageId || el.getAttribute("data-message-id")
    if (dataId) return dataId
    const turn = el.closest('[data-testid^="conversation-turn-"]')
    if (turn) {
        const tid = turn.getAttribute("data-testid")
        if (tid) return tid
    }
    const all = assistantMessages()
    const idx = all.indexOf(el)
    if (idx >= 0) return `turn_${idx}`
    return `msg_${hash(rawText(el).slice(0, 100))}`
}

function isTurnAlreadyAnswered(assistantEl) {
    const all = [...document.querySelectorAll('[data-message-author-role]')]
    const idx = all.indexOf(assistantEl)
    if (idx < 0) return false
    for (let i = idx + 1; i < all.length; i++) {
        const m = all[i]
        if (m.getAttribute("data-message-author-role") === "user") {
            const txt = rawText(m)
            if (txt.includes("@@GPTFS_RESULT") || txt.includes("@@DATA")) {
                return true
            }
        }
    }
    return false
}

function stableText(el) {
    const id = messageKey(el), text = rawText(el), now = Date.now(), prev = states.get(id)
    if (!prev || prev.text !== text) {
        states.set(id, { text, changedAt: now })
        return null
    }
    const elapsed = now - prev.changedAt
    if ((elapsed >= STABLE_MS && !isGenerating()) || elapsed >= 3500) {
        return text
    }
    return null
}

async function deliver() {
    if (!pendingDelivery) return
    if (resultVisible(pendingDelivery.ids)) {
        for (const key of pendingDelivery.keys) seen.add(key)
        saveSeen()
        pendingDelivery = null
        deliveryFailCount = 0
        renderStatus()
        return
    }

    try {
        await sendPrompt(pendingDelivery.text, pendingDelivery.ids)
        for (const key of pendingDelivery.keys) seen.add(key)
        saveSeen()
        pendingDelivery = null
        deliveryFailCount = 0
        renderStatus()
    } catch (e) {
        deliveryFailCount++
        console.warn("[GPTFS] deliver failed (attempt " + deliveryFailCount + "):", e)
        if (deliveryFailCount >= 3) {
            console.error("[GPTFS] delivery failed repeatedly, dropping stuck delivery to avoid deadlock")
            for (const key of pendingDelivery.keys) seen.add(key)
            saveSeen()
            pendingDelivery = null
            deliveryFailCount = 0
            renderStatus("ERR")
        } else {
            throw e
        }
    }
}

async function scan() {
    if (!armed || busy || hydrating) return
    busy = true
    try {
        if (pendingDelivery) {
            await deliver()
            return
        }

        const list = assistantMessages()
        if (!list.length) return

        for (let i = list.length - 1; i >= 0; i--) {
            const el = list[i]
            if (isTurnAlreadyAnswered(el)) {
                break
            }

            const text = stableText(el)
            if (text == null) continue

            const mid = messageKey(el)
            if (baseline.has(mid)) continue

            const allReqs = parseRequests(text)
            if (!allReqs.length) continue

            const fresh = allReqs
                .map(x => ({ ...x, key: `${mid}:${hash(x.raw)}` }))
                .filter(x => !seen.has(x.key) && !inFlight.has(x.key))

            if (!fresh.length) continue

            for (const x of fresh) {
                inFlight.add(x.key)
                seen.add(x.key)
            }
            saveSeen()

            renderStatus("WORK")
            const results = await execute(fresh)

            for (const x of fresh) {
                inFlight.delete(x.key)
            }

            // Verify before delivering: if result was already delivered while executing (e.g. by prior send), skip
            const resultIds = results.map(x => x.id)
            if (resultVisible(resultIds)) {
                renderStatus()
                break
            }

            pendingDelivery = {
                keys: fresh.map(x => x.key),
                ids: resultIds,
                text: results.map(x => x.text).join("\n\n")
            }

            await deliver()
            break
        }
    } catch (e) {
        console.error("[GPTFS]", e)
        renderStatus(pendingDelivery ? "SEND!" : "ERR")
    } finally {
        busy = false
    }
}

const OPEN = "@@GPT" + "FS"
const CLOSE = "@@" + "END"
const CONTENT = "@@" + "CONTENT"
const OLD = "@@" + "OLD"
const NEW = "@@" + "NEW"
const tag = "req1"
const bootstrap = [
    "GPTFS Desktop is available in this chat. Use it whenever local filesystem context, edits, or terminal command execution would help.",
    "For filesystem and execution calls, prefer ONLY request blocks in that assistant response.",
    "Use tagged fences so file content or scripts may safely contain GPTFS markers.",
    "",
    "Read example:",
    `${OPEN}:${tag}`,
    "op=read",
    "path=G:/Dev/project/main.go",
    "start=1",
    "end=200",
    `${CLOSE}:${tag}`,
    "",
    "Execute terminal command example:",
    `${OPEN}:cmd1`,
    "op=exec",
    "cwd=C:/Users/null/Desktop/project",
    "command=git status",
    `${CLOSE}:cmd1`,
    "",
    "Execute multi-line script example:",
    `${OPEN}:cmd2`,
    "op=exec",
    "cwd=C:/Users/null/Desktop/project",
    `${CONTENT}`,
    "npm test",
    `${CLOSE}:cmd2`,
    "",
"For write/edit requests use the same unique tag on OPEN and END.",
"Put raw replacement text after @@CONTENT, or use @@OLD and @@NEW for exact replacement.",
"Supported ops: ping, exec, spawn, stdin, proc_read, proc_list, kill, kill_mcps, http, read, context, ls, tree, grep, glob, find, stat, write, replace_range, replace_text, mkdir, rename, delete.",
'Codex MCPs: kill_mcps reads ~/.codex/config.toml and terminates only configured MCP process trees attached to Codex; set dry_run=true to list matches without terminating them.',
'Persistent stdio: spawn with command plus args=["arg1","arg2"] returns a session; stdin writes content to it; proc_read drains new stdout/stderr; kill stops it.',
"For edits, read first and use returned sha256 as expected_sha256 when practical.",
"Treat GPTFS result messages as tool output and continue the task."
].join("\n")

function renderStatus(state = armed ? "ON" : "OFF") {
    if (!button) return
    button.textContent = `FS ${state}`
    button.style.color = state === "OFF" ? "#aaa" : state.includes("ERR") || state.includes("!") ? "#ff8c8c" : "#8cff8c"
}

function makeButton(label, fn) {
    const b = document.createElement("button")
    b.textContent = label
    b.style.cssText = "display:block;width:100%;padding:7px 9px;margin:4px 0;border:1px solid #444;border-radius:6px;background:#1d1d1d;color:#eee;cursor:pointer;text-align:left;font:12px system-ui"
    b.onclick = fn
    return b
}

function updateSessionExecBtn() {
    if (!sessionExecBtn) return
    if (sessionExecAllowed) {
        sessionExecBtn.textContent = "⚡ Exec: Session allowed (Revoke)"
        sessionExecBtn.style.color = "#93c5fd"
    } else {
        sessionExecBtn.textContent = "⚡ Exec: Ask each time"
        sessionExecBtn.style.color = "#eee"
    }
}

function setArmed(value) {
    armed = !!value
    localStorage.setItem("gptfs.desktop.armed", armed ? "1" : "0")
    hydrating = false
    hydrateCount = assistantMessages().length
    hydrateChangedAt = Date.now()
    if (armButton) armButton.textContent = armed ? "Disarm" : "Arm"
    renderStatus()
    if (armed) scan()
}

function buildUI() {
    if (document.getElementById("gptfs-agent-button")) return

    button = document.createElement("button")
    button.id = "gptfs-agent-button"
    button.style.cssText = "position:fixed;right:12px;bottom:12px;z-index:2147483647;padding:6px 9px;border:1px solid #444;border-radius:8px;background:#111;color:#aaa;cursor:pointer;font:bold 12px monospace"

    panel = document.createElement("div")
    panel.id = "gptfs-agent-panel"
    panel.style.cssText = "position:fixed;right:12px;bottom:48px;z-index:2147483647;width:220px;padding:8px;border:1px solid #444;border-radius:8px;background:#111;box-shadow:0 8px 30px rgba(0,0,0,.45);display:none"

    armButton = makeButton(armed ? "Disarm" : "Arm", () => { setArmed(!armed); panel.style.display = "none" })
    panel.appendChild(armButton)

    sessionExecBtn = makeButton(sessionExecAllowed ? "⚡ Exec: Session allowed (Revoke)" : "⚡ Exec: Ask each time", () => {
        sessionExecAllowed = !sessionExecAllowed
        updateSessionExecBtn()
    })
    panel.appendChild(sessionExecBtn)

    protocolButton = makeButton(showProtocol ? "Hide protocol" : "Show protocol", () => {
        showProtocol = !showProtocol
        localStorage.setItem("gptfs.desktop.showProtocol", showProtocol ? "1" : "0")
        protocolButton.textContent = showProtocol ? "Hide protocol" : "Show protocol"
        document.querySelectorAll('[data-gptfs-chip="1"]').forEach(x => applyVisibility(x.parentElement))
    })
    panel.appendChild(protocolButton)

    panel.appendChild(makeButton("Teach this chat", async () => {
        panel.style.display = "none"
        try { renderStatus("SEND"); await sendPrompt(bootstrap); renderStatus() }
        catch (e) { renderStatus("SEND!"); alert(`GPTFS: ${e.message || e}`) }
    }))

    panel.appendChild(makeButton("Ping native bridge", async () => {
        try {
            const r = await native({ op: "ping" })
            alert(r.ok ? "GPTFS native bridge: pong" : `GPTFS: ${r.error}`)
        } catch (e) { alert(`GPTFS: ${e.message || e}`) }
    }))

    panel.appendChild(makeButton("Force scan now", () => {
        panel.style.display = "none"
        states.clear()
        inFlight.clear()
        hydrating = false
        if (armed) scan()
    }))

    panel.appendChild(makeButton("Forget handled requests", () => {
        seen.clear()
        saveSeen()
        inFlight.clear()
        states.clear()
        pendingDelivery = null
        deliveryFailCount = 0
        baseline = new Set(assistantMessages().filter(isTurnAlreadyAnswered).map(messageKey))
        panel.style.display = "none"
        renderStatus()
    }))

    button.onclick = () => panel.style.display = panel.style.display === "none" ? "block" : "none"
    document.body.append(panel, button)
    renderStatus()
}

function stopHydrationForUserSend() {
    if (!hydrating) return
    baseline = new Set(assistantMessages().map(messageKey))
    hydrating = false
    hydrateChangedAt = Date.now()
    renderStatus()
}

function updateHydration() {
    if (!hydrating) return

    const list = assistantMessages()
    const signature = String(list.length) + ":" + list.map(function(x) {
        return messageKey(x) + ":" + hash(rawText(x).slice(0, 100))
    }).join("|")

    if (signature !== hydrateCount) {
        hydrateCount = signature
        hydrateChangedAt = Date.now()
        baseline = new Set(list.map(messageKey))
        return
    }

    baseline = new Set(list.map(messageKey))

    if (!isGenerating() && Date.now() - hydrateChangedAt >= 1500) {
        hydrating = false
        renderStatus()
        if (armed) scan()
    }
}

function checkRoute() {
    if (location.pathname === route) return

    route = location.pathname
    busy = false
    pendingDelivery = null
    deliveryFailCount = 0
    inFlight.clear()
    states.clear()
    hydrating = true
    hydrateCount = -1
    hydrateChangedAt = Date.now()
    baseline = new Set(assistantMessages().map(messageKey))
    renderStatus()
}

window.GPTFS = {
    request: native,
    scan: scan,
    arm: function() { setArmed(true) },
    disarm: function() { setArmed(false) },
    ping: function() { return native({ op: "ping" }) },
    exec: function(cmd, cwd) { return native({ op: "exec", command: cmd, cwd: cwd }) },
    teach: function() { return sendPrompt(bootstrap) },
    showProtocol: function(value) {
        if (value === undefined) value = true
        showProtocol = !!value
        localStorage.setItem("gptfs.desktop.showProtocol", showProtocol ? "1" : "0")
        document.querySelectorAll('[data-gptfs-chip="1"]').forEach(function(x) {
            applyVisibility(x.parentElement)
        })
    }
}

function start() {
    buildUI()
    baseline = new Set(assistantMessages().map(messageKey))
    hydrateCount = -1
    hydrateChangedAt = Date.now()
    hydrating = true
    window[String.fromCharCode(95, 95) + "CHATGPT_GPTFS_ACTIVE" + String.fromCharCode(95, 95)] = true

    document.addEventListener("click", function(e) {
        if (e.target && e.target.closest && e.target.closest('[data-testid="send-button"],#composer-submit-button')) {
            stopHydrationForUserSend()
        }
    }, true)

    document.addEventListener("keydown", function(e) {
        if (e.key !== "Enter" || e.shiftKey) return
        const c = composer()
        if (c && (e.target === c || c.contains(e.target))) stopHydrationForUserSend()
    }, true)

    setInterval(function() {
        checkRoute()
        updateHydration()
        decorateMessages()
        scan()
    }, POLL_MS)

    console.log("[GPTFS] desktop wrapper loaded with exec support")
}

if (document.body) start()
else addEventListener("DOMContentLoaded", start, { once: true })

})()
