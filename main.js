// magpie's entry for this plugin: the Lingxi bridge, and the page that syncs.
//
// The bridge (bridge.js) is loaded here, in magpie's plugin host itself, so
// the proxy and everything a sync runs live and die with the host: turning
// the plugin off, updating it or quitting magpie ends all of it. The proxy is
// what Lingxi's `magpie/<model>` entries call; bridge's sync writes the model
// list into Lingxi when the user presses Sync on the plugin's page. Lingxi is
// only ever closed by asking its windows to close, and only after that press.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { homedir } from "node:os"

const HERE = fileURLToPath(new URL(".", import.meta.url))
const DATA = join(homedir(), ".config", "magpie", "lingxi-agent")
const BRIDGE = join(HERE, "bridge.js")
const PAGE = join(HERE, "page.html")
const LOG = join(DATA, "host.log")
// The page's service's port (page.html asks nothing else).
const SERVICE_PORT = 3477

try { mkdirSync(DATA, { recursive: true }) } catch {}

function note(line) {
  try { appendFileSync(LOG, `[${new Date().toISOString()}] ${line}\n`) } catch {}
}

// The bridge's own answers: {type, id} out, {type, id, ok, why, value} back.
let bridge = null
const waiting = new Map()

async function theBridge() {
  if (!bridge) {
    bridge = await import(pathToFileURL(BRIDGE).href)
    bridge.onMessage((m) => {
      const done = m && waiting.get(`${m.type}:${m.id}`)
      if (done) done({ ok: m.ok !== false, why: m.why || "", value: m.value || null })
    })
    note("bridge loaded")
  }
  return bridge
}

async function ask(type, timeout) {
  let b
  try { b = await theBridge() } catch (e) { return { ok: false, why: String(e?.message || e) } }
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  return new Promise((resolve) => {
    const t = setTimeout(() => { waiting.delete(`${type}:${id}`); resolve({ ok: false, why: "the bridge didn't answer in time" }) }, timeout)
    waiting.set(`${type}:${id}`, (r) => { clearTimeout(t); waiting.delete(`${type}:${id}`); resolve(r) })
    try { b.answer(type, id) } catch (e) { clearTimeout(t); waiting.delete(`${type}:${id}`); resolve({ ok: false, why: String(e?.message || e) }) }
  })
}

// Lingxi started at sign-in, again, after a sync put it back without the
// debug port (a user's choice on the page).
function settings() {
  try { return { autoStart: true, ...JSON.parse(readFileSync(join(DATA, "settings.json"), "utf8")) } } catch { return { autoStart: true } }
}

function writeSettings(s) {
  try { writeFileSync(join(DATA, "settings.json"), JSON.stringify(s, null, 2)) } catch {}
}

function readBody(req) {
  return new Promise((resolve) => {
    let s = ""
    req.on("data", (c) => { s += c; if (s.length > 1 << 16) req.destroy() })
    req.on("end", () => resolve(s))
    req.on("error", () => resolve(""))
  })
}

// ── the Sync page's service ─────────────────────────────────────────────────
// The desktop window's page reaches this on 127.0.0.1 itself (a page served
// to a browser goes through magpie's own route). It serves its page, which
// has no other origin to load from, and what the page asks: what a sync would
// write, a sync, the setting.
function startService(port, preview) {
  const origin = `http://127.0.0.1:${port}`
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1")
    const reply = (code, v) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(v)) }
    // another site's page (a sandboxed one sends Origin: null) is no business here
    const o = req.headers.origin
    if (o && o !== "null" && o !== origin) { res.writeHead(403); res.end(); return }
    const p = url.pathname
    if (p === "/" || p === "/index.html") {
      try {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
        res.end(readFileSync(PAGE))
      } catch {
        res.writeHead(500, { "content-type": "text/plain; charset=utf-8" }); res.end("page.html is missing from this plugin")
      }
      return
    }
    if (p === "/status") {
      // what a sync would write, and how many magpie has to give
      const left = await preview()
      return reply(200, { bridge: { up: !!bridge }, settings: settings(), sync: left.ok ? left.value : { error: left.why } })
    }
    if (p === "/sync" && req.method === "POST") return reply(200, await ask("sync", 150000))
    if (p === "/settings" && req.method === "POST") {
      let j = {}
      try { j = JSON.parse(await readBody(req)) } catch {}
      const s = settings()
      if (typeof j.autoStart === "boolean") s.autoStart = j.autoStart
      writeSettings(s)
      return reply(200, s)
    }
    res.writeHead(404); res.end()
  })
  return new Promise((resolve) => {
    server.once("error", (e) => { note(`service on ${port}: ${e.message}`); resolve(null) })
    server.listen(port, "127.0.0.1", () => { note(`service on ${origin}`); resolve(server) })
  })
}

// ── the plugin host's part ──────────────────────────────────────────────────
// The page's `sync` ask. Every plugin loaded when the host starts gets one,
// so the host stays up for it (host.js's run holds it) and the bridge, which
// serves Lingxi's models, is there between magpie's own calls.
function holdBySync() {
  return {
    async sync() {
      const r = await ask("sync", 150000)
      return r.ok ? (r.value || {}) : { error: r.why || "the sync didn't finish" }
    },
  }
}

export default async function LingxiPlugin() {
  // The bridge, in this host: it holds no timer of its own, so only a plugin
  // that loads keeps the host (and with it the proxy) from ending. The page's
  // service does hold one, started here and not before, so a host loading no
  // plugin (a disabled one) ends what it found here rather than living on it.
  await theBridge()
  startService(SERVICE_PORT, () => ask("preview", 12000))
  note("plugin loaded")
  return holdBySync()
}
