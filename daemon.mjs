// Detached daemon for the WPS Lingxi agent plugin.
//
// magpie's plugin host is short-lived (it is started and recycled), so the
// long-running work lives here instead: a local proxy and the CDP sync loop.
// main.js spawns this once; a lock keeps it single. It stops when the plugin
// host has not written a heartbeat for a few minutes (plugin off/removed).
import { createServer } from "node:http"
import { spawnSync } from "node:child_process"
import { readFile, appendFile } from "node:fs/promises"
import { readFileSync, writeSync, writeFileSync, openSync, closeSync, unlinkSync, statSync, existsSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const HOME = homedir()
const HERE = fileURLToPath(new URL(".", import.meta.url))
const CONFIG = join(HOME, ".config", "magpie", "lingxi.json")
const PLUGINS = join(HOME, ".config", "magpie", "plugins.json")
const DATA = join(HOME, ".config", "magpie", "lingxi-agent")
const MARKER = join(DATA, "installed")
const INSTALL = join(DATA, "install.json")
const LOG = join(DATA, "daemon.log")
const LOCK = join(DATA, "daemon.lock")
const HEARTBEAT = join(DATA, "heartbeat")
const CDP_PORT = Number(process.env.LINGXI_CDP_PORT || 9222)
const PROXY_FIRST_PORT = Number(process.env.LINGXI_PROXY_PORT || 3426)
const DEFAULT_GATEWAY = "http://127.0.0.1:3425/v1"
const DEFAULT_KEY = "magpie"
const PREFIX = "magpie/"
const EXCLUDE = ["wps-lingxi/"]
const INTERVAL_MS = 5000
// The plugin host is short-lived: magpie loads it, runs it and recycles it, so a
// stale heartbeat does not mean the plugin is off. Liveness comes from the
// signals that do mean stop: the plugin turned off or removed in magpie, or the
// magpie gateway gone for good. Staying alive matters beyond syncing: the
// magpie/* entries in Lingxi point at this proxy, so a daemon that exits takes
// the models with it.
const PLUGIN_SPEC = "magpie-agent-lingxi"
const GATEWAY_DOWN_GRACE_MS = 10 * 60 * 1000

let running = false
let lastErrAt = 0
let lastOkAt = 0
let gatewayDownSince = 0
let cdpError = ""
const logAt = new Map()
let proxyPort = 0
let upstreamBase = DEFAULT_GATEWAY.replace(/\/+$/, "").replace(/\/v1$/, "")
let upstreamKey = DEFAULT_KEY

async function log(line) {
  try { await appendFile(LOG, `[${new Date().toISOString()}] ${line}\n`) } catch {}
}

function logThrottled(key, line) {
  const now = Date.now()
  if (now - (logAt.get(key) || 0) > 60_000) { logAt.set(key, now); log(line) }
}

function acquireLock() {
  try {
    const fd = openSync(LOCK, "wx")
    writeSync(fd, String(process.pid))
    closeSync(fd)
    return true
  } catch (e) {
    if (e.code !== "EEXIST") return false
  }
  try {
    const pid = Number(readFileSync(LOCK, "utf8").trim())
    if (pid && pid !== process.pid) {
      try { process.kill(pid, 0); return false } catch {}
    }
  } catch {}
  try { unlinkSync(LOCK) } catch {}
  try {
    const fd = openSync(LOCK, "wx")
    writeSync(fd, String(process.pid))
    closeSync(fd)
    return true
  } catch { return false }
}

function releaseLock() {
  try {
    const pid = Number(readFileSync(LOCK, "utf8").trim())
    if (pid === process.pid) unlinkSync(LOCK)
  } catch {}
}

function heartbeatAge() {
  try { return Date.now() - statSync(HEARTBEAT).mtimeMs } catch { return Infinity }
}

// `magpie plugin off <spec>` keeps the plugin installed and only records
// `off: true` in plugins.json, so read the switch instead of inferring it from
// the heartbeat (which is stale whenever magpie simply is not calling the host).
async function pluginEnabled() {
  try {
    const j = JSON.parse(await readFile(PLUGINS, "utf8"))
    const list = Array.isArray(j?.plugins) ? j.plugins : null
    if (!list) return true
    const mine = list.filter((p) => typeof p?.spec === "string" && p.spec.includes(PLUGIN_SPEC))
    if (!mine.length) return false
    return !mine.some((p) => p.off === true)
  } catch {
    return true
  }
}

// Find WPS Lingxi and leave a marker the agent plugin's `dir` points at, so the
// agent is detected wherever the user installed it.
function detectExe() {
  const env = process.env.LINGXI_EXE || process.env.LINGXI_HOME
  if (env) {
    const p = /\.exe$/i.test(env) ? env : join(env, "WPS 灵犀.exe")
    if (existsSync(p)) return p
  }
  const ps = `$d = Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match '灵犀|lingxi' } | Select-Object -First 1; if ($d) { if ($d.DisplayIcon) { ($d.DisplayIcon -split ',')[0] } elseif ($d.InstallLocation) { Join-Path $d.InstallLocation 'WPS 灵犀.exe' } }`
  try {
    const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8", timeout: 10000, windowsHide: true })
    const out = (r.stdout || "").trim().split(/\r?\n/).filter(Boolean).pop()
    if (out && existsSync(out)) return out
  } catch {}
  const local = process.env.LOCALAPPDATA || ""
  const candidates = [
    local && join(local, "Programs", "lingxi-desktop", "WPS 灵犀.exe"),
    local && join(local, "Programs", "WPS 灵犀", "WPS 灵犀.exe"),
    "C:\\Program Files\\WPS 灵犀\\WPS 灵犀.exe",
    "C:\\Program Files (x86)\\WPS 灵犀\\WPS 灵犀.exe",
    "D:\\Install file\\lingxi\\lingxi-desktop\\WPS 灵犀.exe",
  ].filter(Boolean)
  return candidates.find((p) => existsSync(p)) || ""
}

function ensureInstall() {
  try { mkdirSync(DATA, { recursive: true }) } catch {}
  const exe = detectExe()
  if (!exe) return ""
  try {
    mkdirSync(MARKER, { recursive: true })
    writeFileSync(join(MARKER, "installed.txt"), exe)
    writeFileSync(INSTALL, JSON.stringify({ exe, dir: dirname(exe), detectedAt: new Date().toISOString() }, null, 2))
  } catch {}
  return exe
}

async function readConfig() {
  try {
    const j = JSON.parse(await readFile(CONFIG, "utf8"))
    const gateway = typeof j.gateway === "string" && j.gateway.trim() ? j.gateway.trim() : DEFAULT_GATEWAY
    return {
      model: typeof j.model === "string" && j.model.trim() ? j.model.trim() : "",
      gateway,
      key: typeof j.key === "string" && j.key ? j.key : DEFAULT_KEY,
    }
  } catch {
    return { model: "", gateway: DEFAULT_GATEWAY, key: DEFAULT_KEY }
  }
}

function upstreamOf(gateway) {
  return gateway.replace(/\/+$/, "").replace(/\/v1$/, "")
}

async function magpieModels(gateway, key) {
  const url = `${gateway.replace(/\/+$/, "")}/models`
  const r = await fetch(url, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(4000) })
  if (!r.ok) throw new Error(`GET ${url} -> ${r.status}`)
  const j = await r.json()
  return (j.data || []).map((m) => m.id).filter((id) => !EXCLUDE.some((p) => id === p || id.startsWith(p)))
}

function encKey(k) {
  return "__CLAW_ENC__" + Buffer.from(encodeURIComponent(k), "utf8").toString("base64")
}

// ── local proxy: magpie/<id> on the wire, <id> upstream ──────────────────────
function stripPrefix(model) {
  return typeof model === "string" && model.startsWith(PREFIX) ? model.slice(PREFIX.length) : model
}

async function handleProxy(req, res) {
  try {
    const path = (req.url || "/").split("?")[0]
    const allowed =
      path === "/v1/chat/completions" || path === "/chat/completions" ||
      path === "/v1/models" || path === "/models" ||
      path === "/v1/messages" || path === "/messages"
    if (!allowed) { res.writeHead(404); res.end(); return }

    if ((path === "/v1/models" || path === "/models") && req.method === "GET") {
      const cfg = await readConfig()
      const models = await magpieModels(cfg.gateway, cfg.key)
      const payload = {
        object: "list",
        data: models.map((id) => ({ id: PREFIX + id, object: "model", owned_by: "magpie" })),
      }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify(payload))
      return
    }

    const chunks = []
    for await (const c of req) chunks.push(c)
    let body = Buffer.concat(chunks).toString("utf8")
    if (body) {
      try {
        const j = JSON.parse(body)
        if (j && typeof j === "object" && "model" in j) j.model = stripPrefix(j.model)
        body = JSON.stringify(j)
      } catch {}
    }

    const upstreamPath = path.startsWith("/v1/") ? path : "/v1" + path
    const upstream = await fetch(`${upstreamBase}${upstreamPath}`, {
      method: req.method,
      headers: {
        "content-type": req.headers["content-type"] || "application/json",
        accept: req.headers["accept"] || "application/json",
        authorization: `Bearer ${upstreamKey}`,
      },
      body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
    })

    const headers = { "content-type": upstream.headers.get("content-type") || "application/json", "cache-control": "no-cache" }
    res.writeHead(upstream.status, headers)
    if (upstream.body) {
      const reader = upstream.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        res.write(Buffer.from(value))
      }
    }
    res.end()
  } catch (e) {
    try { res.writeHead(502, { "content-type": "text/plain" }); res.end("lingxi proxy: " + e.message) } catch {}
  }
}

function startProxy() {
  return new Promise((resolve) => {
    let port = PROXY_FIRST_PORT
    const tryListen = () => {
      const server = createServer(handleProxy)
      server.once("error", () => {
        if (port >= PROXY_FIRST_PORT + 9) { resolve(0); return }
        port++
        tryListen()
      })
      server.listen(port, "127.0.0.1", () => {
        proxyPort = port
        log(`proxy on 127.0.0.1:${port} -> ${upstreamBase}`)
        resolve(port)
      })
    }
    tryListen()
  })
}

// ── CDP ─────────────────────────────────────────────────────────────────────
async function cdpPage() {
  cdpError = ""
  let list
  try {
    const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json`, { signal: AbortSignal.timeout(1500) })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    list = await r.json()
  } catch (e) {
    cdpError = e.message
    return null
  }
  return (
    list.find((t) => t.type === "page" && /lingxi\.wps\.cn/.test(t.url || "")) ||
    list.find((t) => t.type === "page" && t.webSocketDebuggerUrl) ||
    null
  )
}

class CDP {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map() }
  async open() {
    this.ws = new WebSocket(this.url)
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error("CDP connect timeout")), 4000)
      this.ws.addEventListener("open", () => { clearTimeout(t); res() }, { once: true })
      this.ws.addEventListener("error", (e) => { clearTimeout(t); rej(new Error(e.message || "CDP error")) }, { once: true })
    })
    this.ws.addEventListener("message", (ev) => {
      let m
      try { m = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString()) } catch { return }
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id); this.pending.delete(m.id); clearTimeout(p.t)
        m.error ? p.j(new Error(m.error.message || "CDP error")) : p.r(m.result)
      }
    })
  }
  send(method, params = {}, timeout = 8000) {
    const id = ++this.id
    return new Promise((r, j) => {
      const t = setTimeout(() => { this.pending.delete(id); j(new Error("CDP timeout " + method)) }, timeout)
      this.pending.set(id, { r, j, t })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  close() { try { this.ws.close() } catch {} }
}

async function syncOnce() {
  if (running) return
  running = true
  try {
    const cfg = await readConfig()
    upstreamBase = upstreamOf(cfg.gateway)
    upstreamKey = cfg.key
    let models
    try {
      models = await magpieModels(cfg.gateway, cfg.key)
      gatewayDownSince = 0
    } catch (e) {
      if (!gatewayDownSince) gatewayDownSince = Date.now()
      logThrottled("gateway", `magpie gateway ${cfg.gateway} unreachable: ${e.message}`)
      return
    }
    if (!models.length) { logThrottled("empty", "no magpie models to sync"); return }
    if (!proxyPort) { logThrottled("proxy", "proxy not listening yet"); return }

    const endpoint = `http://127.0.0.1:${proxyPort}/v1`
    const entries = models.map((id) => ({
      id: "magpie_" + id.replace(/[^a-zA-Z0-9._-]+/g, "_"),
      provider_id: "custom",
      endpoint,
      model_name: PREFIX + id,
      api_key: encKey(cfg.key),
      api_format: "chat_completions",
      reasoning: false,
    }))
    const idByModel = new Map(models.map((id, i) => [id, entries[i].id]))
    const wantedSel = cfg.model && idByModel.has(cfg.model) ? "custom_model_" + idByModel.get(cfg.model) : ""

    const page = await cdpPage()
    if (!page) {
      logThrottled("cdp", `Lingxi has no page on CDP port ${CDP_PORT} (${cdpError || "no matching target"}); models are not synced - start Lingxi with launch-lingxi.cmd`)
      return
    }

    const cdp = new CDP(page.webSocketDebuggerUrl)
    await cdp.open()
    const expr = `(() => {
      const KEY = 'claw_custom_model_configs';
      const SEL = 'cowork_model_option_v2';
      const PREV = 'magpie_prev_model_option';
      const APPLIED = 'magpie_applied_model';
      const MAGPIE_ID = 'magpie_';
      const entries = ${JSON.stringify(entries)};
      const wantedSel = ${JSON.stringify(wantedSel)};
      const cfgModel = ${JSON.stringify(cfg.model)};
      let cur = [];
      try { cur = JSON.parse(localStorage.getItem(KEY) || '[]') } catch (e) {}
      if (!Array.isArray(cur)) cur = [];
      const kept = cur.filter(e => !(e && String(e.id || '').startsWith(MAGPIE_ID)));
      const next = kept.concat(entries);
      let changed = false;
      if (JSON.stringify(next) !== JSON.stringify(cur)) { localStorage.setItem(KEY, JSON.stringify(next)); changed = true; }
      const nowSel = localStorage.getItem(SEL) || '';
      let applied = localStorage.getItem(APPLIED) || '';
      if (!applied && nowSel.startsWith('custom_model_magpie_')) {
        applied = cfgModel;
        localStorage.setItem(APPLIED, applied);
      }
      if (wantedSel) {
        if (applied !== cfgModel) {
          if (nowSel && !nowSel.startsWith('custom_model_magpie_') && !localStorage.getItem(PREV)) {
            localStorage.setItem(PREV, nowSel);
          }
          if (nowSel !== wantedSel) { localStorage.setItem(SEL, wantedSel); changed = true; }
          localStorage.setItem(APPLIED, cfgModel);
        }
      } else if (applied) {
        if (localStorage.getItem(PREV)) { localStorage.setItem(SEL, localStorage.getItem(PREV)); localStorage.removeItem(PREV); }
        localStorage.removeItem(APPLIED);
        changed = true;
      }
      return { changed, count: next.length, selected: localStorage.getItem(SEL) || '', models: entries.map(e => e.model_name) };
    })()`
    const out = await cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true })
    const val = out.result?.value || {}
    if (val.changed) {
      await log(`synced ${val.count} models, selected=${val.selected || "(none)"}`)
      await cdp.send("Runtime.evaluate", { expression: "setTimeout(() => location.reload(), 600); true", returnByValue: true }).catch(() => {})
    } else if (Date.now() - lastOkAt > 60 * 60 * 1000) {
      lastOkAt = Date.now()
      await log(`ok, ${val.count} models in Lingxi, selected=${val.selected || "(none)"}`)
    }
    cdp.close()
  } catch (e) {
    const now = Date.now()
    if (now - lastErrAt > 60_000) { lastErrAt = now; await log("sync error: " + e.message) }
  } finally {
    running = false
  }
}

async function cleanupLingxi() {
  const page = await cdpPage().catch(() => null)
  if (!page) return null
  const cdp = new CDP(page.webSocketDebuggerUrl)
  await cdp.open()
  const expr = `(() => {
    const KEY = 'claw_custom_model_configs';
    const SEL = 'cowork_model_option_v2';
    const PREV = 'magpie_prev_model_option';
    const APPLIED = 'magpie_applied_model';
    let cur = [];
    try { cur = JSON.parse(localStorage.getItem(KEY) || '[]') } catch (e) {}
    if (!Array.isArray(cur)) cur = [];
    const kept = cur.filter(e => !(e && String(e.id || '').startsWith('magpie_')));
    localStorage.setItem(KEY, JSON.stringify(kept));
    if (localStorage.getItem(PREV)) { localStorage.setItem(SEL, localStorage.getItem(PREV)); localStorage.removeItem(PREV); }
    localStorage.removeItem(APPLIED);
    return { removed: cur.length - kept.length, selected: localStorage.getItem(SEL) || '' };
  })()`
  const out = await cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true })
  await cdp.send("Runtime.evaluate", { expression: "setTimeout(() => location.reload(), 400); true", returnByValue: true }).catch(() => {})
  cdp.close()
  return out.result?.value || null
}

// ── main ────────────────────────────────────────────────────────────────────
try { mkdirSync(DATA, { recursive: true }) } catch {}
if (!acquireLock()) {
  // Another daemon is already running.
  process.exit(0)
}
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { releaseLock(); process.exit(0) })
process.on("exit", releaseLock)

log(`daemon started pid=${process.pid} host-heartbeat-age=${Math.round(heartbeatAge() / 1000)}s`)
let lastExe = ""
const found = ensureInstall()
if (found) { lastExe = found; log(`lingxi at ${found}`) }
startProxy().then((p) => { if (!p) log("proxy: no free port"); else syncOnce() })
setInterval(syncOnce, INTERVAL_MS)
setInterval(() => {
  const exe = ensureInstall()
  if (exe && exe !== lastExe) { lastExe = exe; log(`lingxi at ${exe}`) }
}, 10 * 60 * 1000)
setInterval(async () => {
  if (!(await pluginEnabled())) {
    log("plugin turned off or removed, cleaning up and stopping")
    try { await cleanupLingxi() } catch (e) { await log("cleanup error: " + e.message) }
    releaseLock()
    process.exit(0)
    return
  }
  if (gatewayDownSince && Date.now() - gatewayDownSince > GATEWAY_DOWN_GRACE_MS) {
    log(`magpie gateway gone for ${Math.round((Date.now() - gatewayDownSince) / 60000)} min, cleaning up and stopping`)
    try { await cleanupLingxi() } catch (e) { await log("cleanup error: " + e.message) }
    releaseLock()
    process.exit(0)
  }
}, 15_000)
