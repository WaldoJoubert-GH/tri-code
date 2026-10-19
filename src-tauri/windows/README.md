ConPTY from Windows Terminal: `conpty.dll` and `OpenConsole.exe` (x64) from the
[Microsoft.Windows.Console.ConPTY](https://www.nuget.org/packages/Microsoft.Windows.Console.ConPTY)
NuGet package, version 1.24.261001001, MIT licensed (`LICENSE-conpty.txt`).

`tauri.windows.conf.json` installs them next to `tri-code.exe`, where portable-pty loads
`conpty.dll` in preference to the one built into Windows. The built-in ConPTY re-renders program
output and drops escape sequences it doesn't know, such as OSC 7501 (agent signals); this one
passes them through to xterm.

To update: download the `.nupkg` (a zip), copy `runtimes/win-x64/native/conpty.dll` and
`build/native/runtimes/x64/OpenConsole.exe` here, and change the version above.
