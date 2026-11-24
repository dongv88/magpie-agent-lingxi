// magpie plugin host entry. It is short-lived, so it only makes sure the
// detached daemon is running and writes a heartbeat for it.
import { spawnSync } from "node:child_process"
import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { homedir } from "node:os"

const HERE = fileURLToPath(new URL(".", import.meta.url))
const DATA = join(homedir(), ".config", "magpie", "lingxi-agent")
const HEARTBEAT = join(DATA, "heartbeat")
const LOCK = join(DATA, "daemon.lock")
const DAEMON = join(HERE, "daemon.mjs")
const SPAWN = join(HERE, "spawn-daemon.ps1")
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

try { mkdirSync(DATA, { recursive: true }) } catch {}
heartbeat()
if (!daemonAlive()) {
  // WMI creates the process outside this host's job object, so it survives the
  // host being recycled.
  const r = spawnSync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", SPAWN,
    "-Bun", process.execPath,
    "-Daemon", DAEMON,
    "-WorkDir", HERE,
    "-DataDir", DATA,
  ], { timeout: 15000, stdio: "ignore", windowsHide: true })
  note(`spawn via wmi status=${r.status} err=${r.error ? r.error.message : ""}`)
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
