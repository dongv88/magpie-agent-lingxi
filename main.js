// magpie plugin host entry. It is short-lived, so it only makes sure the
// detached daemon is running and writes a heartbeat for it.
import { spawn, spawnSync } from "node:child_process"
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { homedir } from "node:os"

const HERE = fileURLToPath(new URL(".", import.meta.url))
const DATA = join(homedir(), ".config", "magpie", "lingxi-agent")
const HEARTBEAT = join(DATA, "heartbeat")
const LOCK = join(DATA, "daemon.lock")
const DAEMON = join(HERE, "daemon.mjs")
const SPAWN = join(HERE, "spawn-daemon.ps1")
const LAUNCHER = join(HERE, "spawn-daemon.vbs")
const LOG = join(DATA, "host.log")

function note(line) {
  try { appendFileSync(LOG, `[${new Date().toISOString()}] ${line}\n`) } catch {}
}

function heartbeat() {
  try { writeFileSync(HEARTBEAT, String(Date.now())) } catch {}
}

function daemonAlive() {
  try {
    const pid = Number(readFileSync(LOCK, "utf8").trim())
    if (!pid) return false
    try { process.kill(pid, 0); return true } catch { return false }
  } catch { return false }
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

// magpie's plugin host does not always get System32\WindowsPowerShell on its
// PATH; a bare "powershell.exe" then fails with ENOENT and no daemon ever
// starts (host.log: `Executable not found in $PATH: "powershell.exe"`). Resolve
// it by absolute path.
function powershellPath() {
  const root = process.env.SystemRoot || process.env.windir || "C:\\Windows"
  const candidates = [
    join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    join(root, "SysWOW64", "WindowsPowerShell", "v1.0", "powershell.exe"),
  ]
  return candidates.find((p) => existsSync(p)) || "powershell.exe"
}

function spawnDaemon(extra) {
  return spawnSync(powershellPath(), [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", SPAWN,
    "-Bun", process.execPath,
    "-Daemon", DAEMON,
    "-WorkDir", HERE,
    "-DataDir", DATA,
    ...extra,
  ], { timeout: 15000, stdio: "ignore", windowsHide: true })
}

try { mkdirSync(DATA, { recursive: true }) } catch {}
heartbeat()
if (!daemonAlive()) {
  // WMI creates the process outside this host's job object, so it survives the
  // host being recycled. spawn-daemon.ps1 starts it through wscript, so no
  // console window is created.
  const r = spawnDaemon(["-Launcher", LAUNCHER])
  note(`spawn via wmi status=${r.status} err=${r.error ? r.error.message : ""}`)
  // wscript returns at once; the daemon's lock file is what says it is up.
  const until = Date.now() + 3000
  while (Date.now() < until && !daemonAlive()) sleep(120)
  if (!daemonAlive()) {
    const r2 = spawnDaemon(["-NoLauncher"])
    note(`launcher did not start it, spawn without launcher status=${r2.status}`)
    const until2 = Date.now() + 3000
    while (Date.now() < until2 && !daemonAlive()) sleep(120)
  }
  if (!daemonAlive()) {
    // No usable powershell at all: let Bun run the daemon itself, detached, so
    // it survives this host being recycled. This may flash a console window,
    // which is still better than a plugin that never syncs.
    try {
      spawn(process.execPath, [DAEMON], { cwd: HERE, detached: true, stdio: "ignore", windowsHide: true }).unref()
      note("started the daemon with bun directly")
      const until3 = Date.now() + 3000
      while (Date.now() < until3 && !daemonAlive()) sleep(120)
    } catch (e) {
      note(`bun spawn failed: ${e.message}`)
    }
  }
} else {
  note("daemon already running")
}

// A provider is what makes magpie's Bun host (and its CLI) consider this
// plugin ready. It serves no models; the daemon does the work.
export default function LingxiSyncPlugin() {
  return {
    provider: {
      id: "lingxi-sync",
      name: "WPS 灵犀 同步",
      async models() { return {} },
    },
  }
}
