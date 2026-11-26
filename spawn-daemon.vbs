' Start the magpie-agent-lingxi daemon without a console window.
'
' WMI creates this script's host (wscript.exe) outside magpie's plugin-host job,
' and wscript is a GUI-subsystem program, so it is given no console to show.
' Bun is then started with window style 0 (hidden), so the console it allocates
' stays hidden too. A console program created by WMI directly would get a
' visible console window -- the stray "command window" on every magpie start.
'
' Arguments: <bun exe> <daemon.mjs> <work dir>
Option Explicit

Dim bun, daemon, workDir, sh

If WScript.Arguments.Count < 3 Then WScript.Quit 2

bun = WScript.Arguments(0)
daemon = WScript.Arguments(1)
workDir = WScript.Arguments(2)

Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = workDir
sh.Run """" & bun & """ """ & daemon & """", 0, False
