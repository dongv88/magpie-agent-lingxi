# Changelog

## 0.2.0

Fixes the four things the market review of 0.1.4 asked for.

- **No edits to shortcuts or Run entries.** 0.1.x appended
  `--remote-debugging-port=9222` to every Lingxi shortcut and Run value. 0.2.0
  never touches them; a port is opened only for the one start a sync makes.
- **No force-kill.** 0.1.x ran `taskkill /F`. 0.2.0 asks Lingxi's windows to
  close (WM_CLOSE, as Lingxi's Quit does) and, if that does not end it, says
  so and asks you to quit it yourself.
- **Nothing outlives the plugin host.** 0.1.x started a detached daemon
  through PowerShell, WMI and `wscript`. 0.2.0's bridge is loaded in magpie's
  plugin host itself: turning the plugin off, updating it or quitting magpie
  ends the proxy and the sync with it.
- **A sync only when asked.** The model list is written into Lingxi when you
  press **同步** on the plugin's page, not from a loop. For that one start,
  Lingxi opens a debug port, the list is written and the page refreshed, then
  Lingxi is started again the normal way and the port is gone.

The local proxy now always sends the agent's gateway key upstream, and
refuses requests from web pages (an `Origin` header), so nothing that only
reaches the port stands in for this computer.

Upgrading from 0.1.x on Windows restores what 0.1.x changed with
`tools/restore-local.ps1` (see the README's Upgrade section).
