// The WPS Lingxi bridge: a local proxy, and the writes into Lingxi's own model
// store that a sync makes.
//
// magpie's plugin host loads this file in its own process (main.js imports it
// without starting a child), so the proxy and everything the sync starts run
// inside the host and nothing outlives it: turning the plugin off, updating
// it or quitting magpie ends all of it.
//
// The proxy is the endpoint every `magpie/<model>` entry in Lingxi points at.
// It only forwards, and upstream it sends the request's own model name, so
// what magpie picks spreads to Lingxi without the model list being rewritten.
//
// The model list itself is written only when the user presses Sync on the
// plugin's page: Lingxi holds it in its page's localStorage, which has no file
// and no import, so the only way in is CDP, and CDP only exists in a Lingxi
// started with --remote-debugging-port. That one start is the user's: the
// plugin asks before closing Lingxi, never forces it closed, and after the
// write Lingxi is started again the way it was (its Run entry, or plain), so
// the debug port is gone.
import { createServer } from "node:http"
import { spawn, spawnSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = fileURLToPath(new URL(".", import.meta.url))
const HOME = homedir()
const CONFIG = join(HOME, ".config", "magpie", "lingxi.json")
const DATA = join(HOME, ".config", "magpie", "lingxi-agent")
const INSTALL = join(DATA, "install.json")
const SETTINGS = join(DATA, "settings.json")
const PROXY_PORT = Number(process.env.LINGXI_PROXY_PORT || 3426)
const DEFAULT_GATEWAY = "http://127.0.0.1:3425/v1"
const DEFAULT_KEY = "magpie"
const PREFIX = "magpie/"
const EXCLUDE = ["wps-lingxi/"]
// The key Lingxi's entries carry. The proxy sends its own (the agent's
// gateway key) upstream either way, and the gateway takes a caller from this
// computer without one ("Agents on this computer need none"), so it is a
// placeholder.
const ENTRY_KEY = DEFAULT_KEY
// The port Lingxi's one sync start opens its debug port on, wherever the
// proxy ends up (an entry holds the endpoint it was written with).
const CDP_PORT = 3477
const CDP_WAIT_MS = 20 * 1000
const CLOSE_WAIT_MS = 8 * 1000
const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run"

let upstreamBase = DEFAULT_GATEWAY.replace(/\/+$/, "").replace(/\/v1$/, "")
let upstreamKey = DEFAULT_KEY
let proxyPort = 0

function log(line) {
  try { console.log(`[${new Date().toISOString()}] ${line}`) } catch {}
}

function readJSON(path) {
  try { return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")) } catch { return null }
}

function writeJSON(path, v) {
  try { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(v, null, 2)) } catch {}
}

async function readConfig() {
  const j = readJSON(CONFIG) || {}
  const gateway = typeof j.gateway === "string" && j.gateway.trim() ? j.gateway.trim() : DEFAULT_GATEWAY
  return {
    model: typeof j.model === "string" && j.model.trim() ? j.model.trim() : "",
    gateway,
    key: typeof j.key === "string" && j.key ? j.key : DEFAULT_KEY,
  }
}

function settings() {
  const s = readJSON(SETTINGS) || {}
  return { autoStart: s.autoStart !== false }
}

// Windows helpers. PowerShell is run with -EncodedCommand so a path with
// non-ASCII in it never goes through a command line's code page.
function powershellPath() {
  const root = process.env.SystemRoot || process.env.windir || "C:\\Windows"
  const candidates = [
    join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    join(root, "SysWOW64", "WindowsPowerShell", "v1.0", "powershell.exe"),
  ]
  return candidates.find((p) => existsSync(p)) || "powershell.exe"
}

function psRun(script, env, timeout = 30000) {
  const encoded = Buffer.from(script, "utf16le").toString("base64")
  return spawnSync(powershellPath(), ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
    encoding: "utf8", timeout, windowsHide: true,
    env: env ? { ...process.env, ...env } : undefined,
  })
}

// ── Lingxi: finding it, closing it, starting it ─────────────────────────────
function detectExe() {
  const env = process.env.LINGXI_EXE || process.env.LINGXI_HOME
  if (env) {
    const p = /\.exe$/i.test(env) ? env : join(env, "WPS 灵犀.exe")
    if (existsSync(p)) return p
  }
  const ps = `$d = Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match '灵犀|lingxi' } | Select-Object -First 1; if ($d) { if ($d.DisplayIcon) { ($d.DisplayIcon -split ',')[0] } elseif ($d.InstallLocation) { Join-Path $d.InstallLocation 'WPS 灵犀.exe' } }`
  try {
    const r = psRun(ps, null, 10000)
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

function lingxiExe() {
  const j = readJSON(INSTALL)
  if (j?.exe && existsSync(j.exe)) return j.exe
  const exe = detectExe()
  if (exe) writeJSON(INSTALL, { exe, dir: dirname(exe), detectedAt: new Date().toISOString() })
  return exe
}

function lingxiPids(exe) {
  const quoted = String(exe).replace(/'/g, "''")
  const r = psRun(`Get-Process -ErrorAction SilentlyContinue | Where-Object { try { $_.Path -eq '${quoted}' } catch { $false } } | ForEach-Object { [string]$_.Id }`, null, 15000)
  return (r.stdout || "").split(/\r?\n/).map((s) => s.trim()).filter((s) => /^\d+$/.test(s)).map(Number)
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

// The app's own Quit entry, when it has one: what the tray's Quit runs.
function runEntry(exe) {
  const ps = `$p = Get-ItemProperty '${RUN_KEY}' -ErrorAction SilentlyContinue; if ($p) { foreach ($n in $p.PSObject.Properties) { if ($n.Name -notlike 'PS*' -and [string]$n.Value -match 'lingxi|灵犀') { $n.Value; break } } }`
  const r = psRun(ps, null, 15000)
  const v = (r.stdout || "").trim().split(/\r?\n/).filter(Boolean).pop() || ""
  return v && exe && v.toLowerCase().includes(exe.toLowerCase()) ? v : ""
}

// WM_CLOSE asks Lingxi to quit as its own Quit does; it is never ended. The
// processes the close was sent to are followed: a Lingxi showing a window that
// stays open is what to retry, and one that closed its windows and stays
// running (it holds its tray icon) is why there is nothing more to wait for.
// Either way the sync is given up rather than forcing it.
async function askToClose(exe, pids) {
  psRun(`foreach ($id in @(${pids.join(",")})) { $p = Get-Process -Id $id -ErrorAction SilentlyContinue; if ($p) { [void]$p.CloseMainWindow() } }`, null, 15000)
  // a window that closes at once was asked; one that is still there a few
  // seconds on is showing the user something (Save?, a dialog) and is left to
  const until = Date.now() + CLOSE_WAIT_MS
  for (;;) {
    const still = lingxiPids(exe)
    if (!still.length) return { ok: true }
    if (Date.now() >= until) break
    await sleep(300)
  }
  return {
    ok: false,
    why: lingxiShown(pids)
      ? "Lingxi is still running. It may be asking something in its window: answer it there, then Sync again."
      : "Lingxi closed its window but is still in the tray. Quit it from the tray, then Sync again.",
  }
}

// lingxiShown: any of pids still has a visible main window.
function lingxiShown(pids) {
  if (!pids.length) return false
  const n = psRun(`@(${pids.join(",")}) | ForEach-Object { $p = Get-Process -Id $_ -ErrorAction SilentlyContinue; if ($p -and $p.MainWindowHandle -ne 0) { 1 } }`, null, 15000)
  return (n.stdout || "").includes("1")
}

async function startWithPortOrExplain(exe) {
  await launchLingxi(exe, CDP_PORT)
  if (await waitForCdp(CDP_PORT, CDP_WAIT_MS)) return { ok: true }
  await launchLingxi(exe, 0)
  return { ok: false, why: "Lingxi didn't open its debug port: try Sync again." }
}

function startLingxi(exe, args) {
  try {
    spawn(exe, args, { detached: true, stdio: "ignore", windowsHide: false }).unref()
    return true
  } catch (e) {
    log("could not start Lingxi: " + e.message)
    return false
  }
}

// Lingxi started afresh the way the user's own start would: with the debug
// port for the sync, or without it.
async function launchLingxi(exe, cdpPort) {
  return cdpPort ? startLingxi(exe, [`--remote-debugging-port=${cdpPort}`]) : startLingxi(exe, [])
}

async function waitForCdp(port, ms) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (await cdpTarget(port)) return true
    await sleep(500)
  }
  return false
}

// ── CDP ─────────────────────────────────────────────────────────────────────
async function cdpTarget(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(1500) })
    if (!r.ok) return null
    const list = await r.json()
    return (
      list.find((t) => t.type === "page" && /lingxi\.wps\.cn/.test(t.url || "")) ||
      list.find((t) => t.type === "page" && t.webSocketDebuggerUrl) ||
      null
    )
  } catch {
    return null
  }
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

// ── the proxy: magpie/<id> on the wire, <id> upstream ───────────────────────
function stripPrefix(model) {
  return typeof model === "string" && model.startsWith(PREFIX) ? model.slice(PREFIX.length) : model
}

async function handleProxy(req, res) {
  try {
    // A web page reaching this port from a browser names its own site as
    // Origin (another program sends none): only 灵犀, whose entry calls
    // without one, and a page with no origin at all, are forwarded.
    const o = req.headers.origin
    if (o && o !== "null") { res.writeHead(403); res.end(); return }
    const path = (req.url || "/").split("?")[0]
    const allowed =
      path === "/v1/chat/completions" || path === "/chat/completions" ||
      path === "/v1/models" || path === "/models" ||
      path === "/v1/messages" || path === "/messages"
    if (!allowed) { res.writeHead(404); res.end(); return }

    if ((path === "/v1/models" || path === "/models") && req.method === "GET") {
      const models = await magpieModels(upstreamBase, upstreamKey)
      const payload = { object: "list", data: models.map((id) => ({ id: PREFIX + id, object: "model", owned_by: "magpie" })) }
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

    res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") || "application/json", "cache-control": "no-cache" })
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
    let port = PROXY_PORT
    const tryListen = () => {
      const server = createServer((req, res) => {
        applyConfig()
        handleProxy(req, res)
      })
      server.once("error", () => {
        if (port >= PROXY_PORT + 9) { resolve(0); return }
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

// ── magpie's models ─────────────────────────────────────────────────────────
async function magpieModels(gateway, key) {
  const url = `${gateway.replace(/\/+$/, "")}/models`
  const r = await fetch(url, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(4000) })
  if (!r.ok) throw new Error(`GET ${url} -> ${r.status}`)
  const j = await r.json()
  return (j.data || []).map((m) => m.id).filter((id) => !EXCLUDE.some((p) => id === p || id.startsWith(p)))
}

async function applyConfig() {
  try {
    const cfg = await readConfig()
    upstreamBase = cfg.gateway.replace(/\/+$/, "").replace(/\/v1$/, "")
    upstreamKey = cfg.key
  } catch {}
}

// ── the sync ────────────────────────────────────────────────────────────────
let syncing = null

// The page's write: Lingxi's own custom models and the model its home screen
// has picked. `magpie_prev_model_option` keeps the pick that was there before.
function syncExpr(entries, wantedSel, cfgModel) {
  return `(() => {
    const KEY = 'claw_custom_model_configs';
    const SEL = 'cowork_model_option_v2';
    const PREV = 'magpie_prev_model_option';
    const APPLIED = 'magpie_applied_model';
    const MAGPIE_ID = 'magpie_';
    const entries = ${JSON.stringify(entries)};
    const wantedSel = ${JSON.stringify(wantedSel)};
    const cfgModel = ${JSON.stringify(cfgModel)};
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
}

// What Lingxi holds now, read over CDP while it runs on the sync's port, so
// the page can say whether a sync would change anything.
const STATE_EXPR = `(() => {
  const KEY = 'claw_custom_model_configs';
  const SEL = 'cowork_model_option_v2';
  let cur = [];
  try { cur = JSON.parse(localStorage.getItem(KEY) || '[]') } catch (e) {}
  if (!Array.isArray(cur)) cur = [];
  const mine = cur.filter(e => e && String(e.id || '').startsWith('magpie_'));
  return { running: true, models: mine.map(e => e.model_name), selected: localStorage.getItem(SEL) || '' };
})()`

async function lingxiState() {
  const exe = lingxiExe()
  if (!exe || !lingxiPids(exe).length) return { running: false }
  const page = await cdpTarget(CDP_PORT)
  if (!page) return { running: true, cdp: false }
  const cdp = new CDP(page.webSocketDebuggerUrl)
  try {
    await cdp.open()
    const out = await cdp.send("Runtime.evaluate", { expression: STATE_EXPR, returnByValue: true })
    return { ...(out.result?.value || {}), cdp: true }
  } catch {
    return { running: true, cdp: false }
  } finally {
    cdp.close()
  }
}

function encKey(k) {
  return "__CLAW_ENC__" + Buffer.from(encodeURIComponent(k), "utf8").toString("base64")
}

function entriesFor(models, endpoint) {
  return models.map((id) => ({
    id: "magpie_" + id.replace(/[^a-zA-Z0-9._-]+/g, "_"),
    provider_id: "custom",
    endpoint,
    model_name: PREFIX + id,
    api_key: encKey(ENTRY_KEY),
    api_format: "chat_completions",
    reasoning: false,
  }))
}

// With Lingxi running on the debug port: write the list, refresh the page
// so it reads it, then start Lingxi again the way it normally starts.
async function writeThroughCdp(port, entries, wantedSel, cfgModel) {
  const page = await cdpTarget(port)
  if (!page) return { ok: false, why: "Lingxi didn't open a page on its debug port" }
  const cdp = new CDP(page.webSocketDebuggerUrl)
  await cdp.open()
  try {
    const out = await cdp.send("Runtime.evaluate", { expression: syncExpr(entries, wantedSel, cfgModel), returnByValue: true })
    const val = out.result?.value || {}
    await cdp.send("Runtime.evaluate", { expression: "setTimeout(() => location.reload(), 600); true", returnByValue: true }).catch(() => {})
    return { ok: true, value: val }
  } finally {
    cdp.close()
  }
}

// Everything a sync is made of, once the user has said yes.
async function doSync() {
  const cfg = await readConfig()
  upstreamBase = cfg.gateway.replace(/\/+$/, "").replace(/\/v1$/, "")
  upstreamKey = cfg.key
  if (!proxyPort) return { ok: false, why: "the proxy isn't listening" }
  const models = await magpieModels(cfg.gateway, cfg.key)
  if (!models.length) return { ok: false, why: "magpie has no models to sync" }

  const endpoint = `http://127.0.0.1:${proxyPort}/v1`
  const entries = entriesFor(models, endpoint)
  const idByModel = new Map(models.map((id, i) => [id, entries[i].id]))
  const wantedSel = cfg.model && idByModel.has(cfg.model) ? "custom_model_" + idByModel.get(cfg.model) : ""

  const exe = lingxiExe()
  if (!exe) return { ok: false, why: "WPS Lingxi isn't installed" }

  const autoStart = settings().autoStart
  const quit = runEntry(exe)
  const running = lingxiPids(exe)
  if (running.length) {
    const closed = await askToClose(exe, running)
    if (!closed.ok) return { ok: false, why: closed.why }
  }
  const started = await startWithPortOrExplain(exe)
  if (!started.ok) return started

  const out = await writeThroughCdp(CDP_PORT, entries, wantedSel, cfg.model)
  await sleep(700)

  // back to a normal start. With Lingxi starting at sign-in, the app's own
  // Quit entry runs again (a second plain start would only focus it); a
  // user who turned that off gets it plain.
  await askToClose(exe, lingxiPids(exe))
  if (autoStart && quit) {
    try { spawn("cmd.exe", ["/d", "/c", quit], { detached: true, stdio: "ignore", windowsHide: true }).unref() } catch {}
  } else {
    await launchLingxi(exe, 0)
  }

  if (!out.ok) return out
  log(`synced ${out.value.count} models, selected=${out.value.selected || "(none)"}`)
  return { ok: true, value: out.value }
}

// One sync at a time; a second ask waits for the first.
function sync() {
  if (!syncing) syncing = doSync().finally(() => { syncing = null })
  return syncing
}

// What a sync would write, without touching Lingxi: magpie's models, and
// what Lingxi holds now when it runs on the sync's port.
async function preview() {
  await applyConfig()
  let models = []
  try {
    models = await magpieModels(`${upstreamBase}/v1`, upstreamKey)
  } catch (e) {
    return { ok: false, why: `magpie's gateway didn't answer: ${e.message}` }
  }
  const exe = lingxiExe()
  const running = !!exe && lingxiPids(exe).length > 0
  const lingxi = running ? await lingxiState() : { running: false }
  return { ok: true, value: { models: models.map((id) => PREFIX + id), lingxi } }
}

// ── main ────────────────────────────────────────────────────────────────────
try { mkdirSync(DATA, { recursive: true }) } catch {}

// What main.js has of the bridge: answers come back to onMessage, and an ask
// is answer(type, id). A sync answers when it has finished, which is soon
// after the Lingxi it told to close has closed (it may be asking the user
// something, and is then left to them).
let notify = () => {}
const handlers = {
  sync: () => sync(),
  state: () => lingxiState().then((value) => ({ value })),
  preview: () => preview(),
}

export function onMessage(handler) {
  notify = typeof handler === "function" ? handler : () => {}
}

export function answer(type, id) {
  const run = handlers[type]
  if (!run) return
  const send = (r) => { try { notify({ type, id, ok: r?.ok !== false, why: r?.why || "", value: r?.value || null }) } catch {} }
  Promise.resolve().then(run).then(send).catch((e) => send({ ok: false, why: String(e?.message || e) }))
}

applyConfig().then(() => startProxy().then((p) => { if (!p) log("proxy: no free port") }))
log(`bridge loaded in the plugin host (pid ${process.pid})`)
