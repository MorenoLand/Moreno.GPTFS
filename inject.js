(() => {
"use strict"

if (!/(^|\.)chatgpt\.com$/i.test(location.hostname)) return

const cfg = window.__CHATGPT_GPTFS__
if (!cfg?.token) return
if (window.__CHATGPT_GPTFS_ACTIVE__ && document.getElementById("gptfs-agent-button")) return

try { delete window.__CHATGPT_GPTFS__ } catch {}

const TOKEN = cfg.token

// Unlock Wails v3 ExecJS. Remote pages never load the Wails runtime bundle,
// so "wails:runtime:ready" is never sent natively and every ExecJS call
// (including Go-side responses and reinjection) is queued in pendingJS forever.
try {
    if (window.chrome?.webview?.postMessage) window.chrome.webview.postMessage("wails:runtime:ready")
    else if (window.webkit?.messageHandlers?.external?.postMessage) window.webkit.messageHandlers.external.postMessage("wails:runtime:ready")
} catch {}
const POLL_MS = 300
const STABLE_MS = 1400
const pending = new Map()
const seen = new Set(JSON.parse(localStorage.getItem("gptfs.desktop.processed") || "[]"))
const states = new Map()

let armed = localStorage.getItem("gptfs.desktop.armed") === "1"
let showProtocol = localStorage.getItem("gptfs.desktop.showProtocol") === "1"
let route = location.pathname
let busy = false
let pendingDelivery = null
let baseline = new Set()
let hydrating = true
let hydrateCount = -1
let hydrateChangedAt = Date.now()
let button, panel, armButton, protocolButton

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

window.__CHATGPT_GPTFS_RECEIVE__ = payload => {
const p = pending.get(payload?.id)

try {
    const ack = JSON.stringify({
        type: "chatgpt-gptfs-ack",
        token: TOKEN,
        id: String(payload?.id || ""),
        stage: p ? "pending-hit" : "pending-miss"
    })

    if (window._wails?.invoke) window._wails.invoke(ack)
    else if (window.chrome?.webview?.postMessage) window.chrome.webview.postMessage(ack)
} catch {}

if (!p) return
pending.delete(payload.id)
clearTimeout(p.timer)
p.resolve(payload.result || { ok: false, error: "invalid native response" })

}

function native(body) {
    return new Promise((resolve, reject) => {
        const id = crypto.randomUUID()
        const timer = setTimeout(() => {
            pending.delete(id)
            reject(new Error("GPTFS request timed out"))
        }, 60000)

        pending.set(id, { resolve, reject, timer })
        const msg = JSON.stringify({ type: "chatgpt-gptfs", token: TOKEN, id, request: body })

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
        if (i < 1) throw new Error(`invalid header line: ${line}`)
        const key = line.slice(0, i).trim()
        let value = line.slice(i + 1).trim()
        if (/^(true|false)$/i.test(value)) value = value.toLowerCase() === "true"
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
        return JSON.parse(text.replace(/"(path|new_path)"\s*:\s*"([^"\n]*)"/g, (_, k, v) => `"${k}":${JSON.stringify(v.replace(/\\/g, "/"))}`))
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
const start = /^@@GPTFS:([A-Za-z0-9._-]+)[ \t]*$/gm
let m

while ((m = start.exec(text))) {
    const tag = m[1]
    const tail = text.slice(start.lastIndex)
    const endRe = new RegExp("(?:\\r?\\n|[ \\t]+)@@END:" + tag + "\\b")
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
let pos = 0

while (true) {
    const begin = text.indexOf("@@GPTFS", pos)
    if (begin < 0) break

    if (begin > 0 && text[begin - 1] !== "\n") {
        pos = begin + 9
        continue
    }

    const afterToken = begin + 9
    const lineEnd = text.indexOf("\n", afterToken)
    if (lineEnd < 0) break

    const suffix = text.slice(afterToken, lineEnd).replace(/\r/g, "")
    if (suffix.trim() !== "") {
        pos = lineEnd + 1
        continue
    }

    let end = text.indexOf("@@END", lineEnd + 1)

    while (end >= 0) {
        const before = end > 0 ? text[end - 1] : ""
        const after = text[end + 5] || ""
        const beforeOK = before === " " || before === "\t" || before === "\n" || before === "\r"
        const afterOK = after === "" || after === " " || after === "\t" || after === "\n" || after === "\r"

        if (beforeOK && afterOK) break
        end = text.indexOf("@@END", end + 5)
    }

    if (end < 0) break

    const rawEnd = end + 5
    const body = text.slice(lineEnd + 1, end).replace(/\r/g, "")
    const raw = text.slice(begin, rawEnd)

    try { out.push({ req: parseBody(body), raw }) }
    catch (e) { out.push({ req: { __parse_error: e.message, __raw: body }, raw }) }

    pos = rawEnd
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
    const t = tokens(line.trim())
    const cmd = t.shift()
    if (!cmd?.startsWith("@fs-")) return null
    if (cmd === "@fs-ping") return { op: "ping" }
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
        .map(x => x.trim())
        .filter(x => /^@fs-(ping|read|context|ls|tree|grep|glob|find|stat)\b/.test(x))
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
    const name = x.path ? String(x.path).replace(/\\/g, "/").split("/").filter(Boolean).at(-1) : ""
    return { label: `FS ${x.ok ? "✓" : "✕"} ${x.op || "result"}${name ? " · " + name : ""}`, ok: !!x.ok }
}

function decorate(el, label, ok = true) {
    if (!el.__gptfsRawText) el.__gptfsRawText = el.innerText || el.textContent || ""
    let chip = el.querySelector(':scope > [data-gptfs-chip="1"]')
    if (!chip) {
        chip = document.createElement("div")
        chip.dataset.gptfsChip = "1"
        chip.style.cssText = "align-self:flex-start;display:inline-flex;align-items:center;padding:4px 8px;margin:2px 0;border:1px solid #383838;border-radius:7px;background:#171717;font:11px ui-monospace,SFMono-Regular,Consolas,monospace;cursor:pointer;user-select:none"
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
    chip.textContent = label
    chip.style.color = ok ? "#91a89a" : "#d88"
    applyVisibility(el)
}

function applyVisibility(el) {
    const chip = el.querySelector(':scope > [data-gptfs-chip="1"]')
    if (!chip) return
    const reveal = showProtocol || el.dataset.gptfsReveal === "1"
    for (const child of [...el.children]) {
        if (child.dataset.gptfsOriginal === "1") child.style.display = reveal ? (child.dataset.gptfsOldDisplay || "") : "none"
    }
    chip.style.display = "inline-flex"
    chip.title = reveal ? "Click to collapse GPTFS protocol" : "Click to reveal GPTFS protocol"
}

function decorateMessages() {
    if (isGenerating()) return
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
    const meta = { id, op: req.op, path: req.path || undefined, ok: !!res.ok, sha256: res.sha256 || undefined, truncated: !!res.truncated, error: res.error || undefined }
    const data = res.data || (Array.isArray(res.items) ? res.items.join("\n") : "") || "(empty)"
    return { id, text: `@@GPTFS_RESULT:${id}\n${JSON.stringify(meta)}\n@@DATA\n${data}\n@@END_RESULT:${id}` }
}

function formatParseError(req) {
    const id = crypto.randomUUID()
    const meta = { id, op: "parse_error", ok: false, error: req.__parse_error }
    return { id, text: `@@GPTFS_RESULT:${id}\n${JSON.stringify(meta)}\n@@DATA\n${req.__raw || ""}\n@@END_RESULT:${id}` }
}

function composer() {
    return document.querySelector('#prompt-textarea[contenteditable="true"]')
}

function composerText() {
    const el = composer()
    return (el?.innerText || el?.textContent || "").replace(/\u00a0/g, " ").trim()
}

function setComposer(text) {
    const el = composer()
    if (!el) throw new Error("ChatGPT composer not found")
    el.focus()
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
    return document.querySelector('[data-testid="send-button"]') || document.querySelector('#composer-submit-button[aria-label*="Send" i]')
}

function isGenerating() {
    return !!document.querySelector('button[data-testid="stop-button"],button[aria-label*="Stop generating" i],button[aria-label*="Stop response" i],[data-message-streaming="true"]')
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
    if (!ids.length) return false
    const text = userMessages().map(rawText).join("\n")
    return ids.some(id => text.includes(id))
}

async function sendPrompt(text, ids = []) {
    if (!await waitUntil(() => !isGenerating(), 30000, 150)) throw new Error("assistant generation did not finish")
    if (resultVisible(ids)) return true

    const before = userMessages().length
    setComposer(text)
    if (!await waitUntil(() => composerText(), 2500)) throw new Error("could not fill ChatGPT composer")
    if (!await waitUntil(() => {
        const b = sendButton()
        return b && !b.disabled && b.getAttribute("aria-disabled") !== "true" && !isGenerating()
    }, 8000)) throw new Error("ChatGPT send button did not become ready")

    renderStatus("SEND")
    sendButton().click()

    if (await waitUntil(() => resultVisible(ids) || userMessages().length > before || composerText() === "", 4000)) return true

    if (composerText()) {
        composer()?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }))
        if (await waitUntil(() => resultVisible(ids) || userMessages().length > before || composerText() === "", 5000)) return true
    }

    throw new Error("ChatGPT did not accept the generated prompt")
}

async function execute(items) {
    const results = []
    for (const item of items) {
        if (item.req.__parse_error) { results.push(formatParseError(item.req)); continue }
        try { results.push(formatResult(item.req, await native(item.req))) }
        catch (e) { results.push(formatResult(item.req, { ok: false, error: e.message || String(e) })) }
    }
    return results
}

function messageKey(el) {
    return el?.dataset?.messageId || el?.getAttribute("data-message-id") || `anon:${hash(rawText(el))}`
}

function stableText(el) {
    const id = messageKey(el), text = rawText(el), now = Date.now(), prev = states.get(id)
    if (!prev || prev.text !== text) {
        states.set(id, { text, changedAt: now })
        return null
    }
    if (now - prev.changedAt < STABLE_MS || isGenerating()) return null
    return text
}

async function deliver() {
    if (!pendingDelivery) return
    if (!resultVisible(pendingDelivery.ids)) await sendPrompt(pendingDelivery.text, pendingDelivery.ids)
    for (const key of pendingDelivery.keys) seen.add(key)
    saveSeen()
    pendingDelivery = null
    renderStatus()
}

async function scan() {
if (!armed || busy || hydrating) return
    busy = true
    try {
        if (pendingDelivery) return await deliver()
        const list = assistantMessages()
        for (let i = list.length - 1; i >= 0; i--) {
            const el = list[i], text = stableText(el)
            if (text == null) continue
            const mid = messageKey(el)
            if (baseline.has(mid)) continue
            const fresh = parseRequests(text)
                .map(x => ({ ...x, key: `${mid}:${hash(x.raw)}` }))
                .filter(x => !seen.has(x.key))
            if (!fresh.length) continue
            renderStatus("WORK")
            const results = await execute(fresh)
            pendingDelivery = { keys: fresh.map(x => x.key), ids: results.map(x => x.id), text: results.map(x => x.text).join("\n\n") }
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
    "GPTFS Desktop is available in this chat. Use it whenever local filesystem context or edits would help.",
    "For filesystem calls, prefer ONLY request blocks in that assistant response.",
    "Use tagged fences so file content may safely contain GPTFS markers.",
    "Read example:",
    `${OPEN}:${tag}`,
    "op=read",
    "path=G:/Dev/project/main.go",
    "start=1",
    "end=200",
    `${CLOSE}:${tag}`,
    "For write/edit requests use the same unique tag on OPEN and END.",
    `Put raw replacement text after ${CONTENT}, or use ${OLD} and ${NEW} for exact replacement.`,
    "Supported ops: ping, read, context, ls, tree, grep, glob, find, stat, write, replace_range, replace_text, mkdir, rename, delete.",
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

function setArmed(value) {
armed = !!value
localStorage.setItem("gptfs.desktop.armed", armed ? "1" : "0")
baseline = new Set(assistantMessages().map(messageKey))
hydrating = false
hydrateCount = assistantMessages().length
hydrateChangedAt = Date.now()
if (armButton) armButton.textContent = armed ? "Disarm" : "Arm"
renderStatus()
if (armed) scan()
}

function buildUI() {
    button = document.createElement("button")
    button.id = "gptfs-agent-button"
    button.style.cssText = "position:fixed;right:12px;bottom:12px;z-index:2147483647;padding:6px 9px;border:1px solid #444;border-radius:8px;background:#111;color:#aaa;cursor:pointer;font:bold 12px monospace"

    panel = document.createElement("div")
    panel.id = "gptfs-agent-panel"
    panel.style.cssText = "position:fixed;right:12px;bottom:48px;z-index:2147483647;width:200px;padding:8px;border:1px solid #444;border-radius:8px;background:#111;box-shadow:0 8px 30px rgba(0,0,0,.35);display:none"

    armButton = makeButton(armed ? "Disarm" : "Arm", () => { setArmed(!armed); panel.style.display = "none" })
    panel.appendChild(armButton)

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
        try { const r = await native({ op: "ping" }); alert(r.ok ? "GPTFS native bridge: pong" : `GPTFS: ${r.error}`) }
        catch (e) { alert(`GPTFS: ${e.message || e}`) }
    }))

    panel.appendChild(makeButton("Forget handled requests", () => {
        seen.clear(); saveSeen(); states.clear(); panel.style.display = "none"
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
    return messageKey(x) + ":" + hash(rawText(x))
}).join("|")

if (signature !== hydrateCount) {
    hydrateCount = signature
    hydrateChangedAt = Date.now()
    baseline = new Set(list.map(messageKey))
    return
}

baseline = new Set(list.map(messageKey))

if (!isGenerating() && Date.now() - hydrateChangedAt >= 1800) {
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

console.log("[GPTFS] desktop wrapper loaded")

}

if (document.body) start()
else addEventListener("DOMContentLoaded", start, { once: true })

})()