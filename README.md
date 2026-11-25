# magpie-agent-lingxi

WPS 灵犀 (Lingxi) on magpie's **Agents** page. magpie's models appear in 灵犀's
「自定义模型」 menu as `magpie/<model>`, served through magpie's gateway and
routing groups.

> **Unofficial.** Not affiliated with Kingsoft / WPS. Windows only.

## What it does

- Adds **WPS 灵犀** to magpie's Agents page, so you can pick one of magpie's
  models for it.
- A small detached daemon syncs magpie's model list into 灵犀's own
  custom-model storage over the Chrome DevTools Protocol. 灵犀 keeps that list
  in its renderer's localStorage, so CDP is the only way in, and CDP only
  exists when 灵犀 starts with `--remote-debugging-port`; when the port is
  missing and there is something to sync, the daemon restarts 灵犀 with it
  itself. Turning the agent on in magpie is the whole setup.
- A local proxy on `127.0.0.1` keeps the display name `magpie/<model>` while
  forwarding `<model>` to magpie (the gateway does not accept the prefix).
- Models from the `wps-lingxi/*` provider are excluded, so 灵犀 does not call
  itself through magpie (which would loop and spend credits twice).

## Requirements

- Windows 10/11.
- magpie with agent-plugin support (0.1.x).
- WPS 灵犀 installed. It is detected from the Windows uninstall registry or
  common install paths; `LINGXI_EXE` / `LINGXI_HOME` override the detection.
- No Node install is needed: magpie's Bun runs the daemon.

## Install

- From magpie → 插件 → 发现: search `magpie-agent-lingxi` and install.
- Or: `magpie plugin add github:dongv88/magpie-agent-lingxi`
- Or local: `magpie plugin add C:\path\to\magpie-agent-lingxi`

After installing, if **WPS 灵犀** does not appear on the Agents page, restart
magpie once: the plugin creates its detection marker on first run.

## Use

1. In magpie: **Agent → WPS 灵犀 → switch it on, pick a model**.
2. That is all. In 灵犀: **选择其他模型 → 自定义模型 → `magpie/<model>`**.

On the first sync the plugin has to give 灵犀 the debug port, which can only be
passed at startup, so 灵犀 is closed and reopened **once** at that moment (a
WM_CLOSE, not a kill: a dialog or unsaved work is left alone and the sync waits).
After that the list is in 灵犀's own storage and later syncs — a model picked
again in magpie — cost another such restart only when the list actually changes.

`launch-lingxi.cmd` is still there for starting 灵犀 with the port yourself, and
`LINGXI_NO_RESTART=1` turns the restart off: 灵犀 is then left alone and the
models are synced the next time it happens to run with the port.

The debug port is needed **for syncing only**. The local proxy keeps working
without it, and `launch-lingxi.cmd` reopens 灵犀 with the port whenever you want
to refresh the list by hand.

## Enable / disable

- magpie → 插件 → `magpie-agent-lingxi` → toggle.
- CLI (use the folder path the plugin was installed from):

```bat
magpie plugin off C:\path\to\magpie-agent-lingxi
magpie plugin on  C:\path\to\magpie-agent-lingxi
```

Turning it off disconnects the agent. The daemon notices the switch in
`~/.config/magpie/plugins.json` within about 15 seconds, removes the `magpie/*`
entries from 灵犀, restores the model 灵犀 had before, and exits. Turning it on
again requires reconnecting the agent (Agent page) or
`magpie lingxi deepseek/deepseek-flash`.

The daemon stays up while magpie runs, not just for the moment the plugin host
happens to be alive: the plugin host is recycled right after magpie loads it, and
the `magpie/*` entries in 灵犀 point at this daemon's proxy, so a daemon that
quits early takes the models with it. It exits on its own only when the plugin is
off or removed, or when the magpie gateway has been unreachable for 10 minutes.

## Data and privacy

- Data dir: `%USERPROFILE%\.config\magpie\lingxi-agent`
  (`daemon.log`, `host.log`, `heartbeat`, `daemon.lock`, `install.json`,
  `installed/` marker).
- The proxy listens on `127.0.0.1:3426` (falls back to 3427-3435).
- The plugin writes only 灵犀's `claw_custom_model_configs` and
  `cowork_model_option_v2` in its own storage.
- It does **not** read or store your WPS credentials. Requests use magpie's
  per-agent gateway key (`magpie-lingxi`).
- While 灵犀 is open with the debug port, a local process can control its
  renderer. Close 灵犀 or restart it normally when you are not syncing if that
  matters to you.

## Troubleshooting

- **Agent missing**: restart magpie once; check that 灵犀 is installed.
- **Models missing in 灵犀**: 灵犀 must run with `--remote-debugging-port=9222`
  for a sync; check `daemon.log`. Since 0.1.3 the log says so directly:
  `Lingxi has no page on CDP port 9222 (...)`. Earlier versions reported the
  same condition as a bare `ECONNREFUSED`, which reads like the magpie gateway
  is down even though it is not.
- **灵犀 closed and reopened by itself**: that is the sync giving it the debug
  port, and it happens once per change of model list. `daemon.log` says
  `restarting Lingxi with --remote-debugging-port=9222 to sync (pid …)`. If it
  says `Lingxi did not close`, a dialog or the tray icon held it; close it by
  hand and the next daemon start syncs.
- **Plugin is on but nothing ever syncs**: the plugin host only runs when magpie
  loads it, so switching the plugin on (or picking a model on the Agent page)
  does not by itself perform a sync while 灵犀 is already running without the
  debug port. Start 灵犀 with `launch-lingxi.cmd` first, then toggle the plugin
  off/on (or `magpie lingxi <model>`) to give the daemon a chance to sync.
- **Models show but fail**: check the proxy port in `daemon.log` and that the
  magpie gateway is at `127.0.0.1:3425`.
- **After a 灵犀 update**: the app may restart without the debug port; run
  `launch-lingxi.cmd` again.
- **Nothing starts after a magpie restart**: `host.log` used to show
  `spawn via wmi status=null err=Executable not found in $PATH: "powershell.exe"`
  because the plugin host does not always get System32\WindowsPowerShell on its
  PATH. The host resolves `powershell.exe` by absolute path now, and falls back
  to starting the daemon with Bun itself (logged as
  `started the daemon with bun directly`) when that is not possible either.
- **A command window on every magpie start**: fixed in 0.1.1. The daemon used to
  be created by WMI as a console program, which got a visible console window
  for as long as it ran. It is now created through `spawn-daemon.vbs`
  (`wscript.exe`, a GUI program with no console), which starts Bun with its
  window hidden. On an older version, run `magpie plugin update`. If a window
  still shows, `spawn-error.log` in the data dir says whether the launcher was
  skipped and the direct spawn used (Windows Script Host disabled, for example).

## Disclaimer

Unofficial integration. "WPS" and "WPS 灵犀" are trademarks of Kingsoft. Use at
your own risk.

## License

MIT
