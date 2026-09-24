Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

' Get project root (parent directory of scripts\)
strScriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
strProjectRoot = fso.GetParentFolderName(strScriptDir)

Set WshEnv = WshShell.Environment("PROCESS")
WshEnv("MUSIK_ROOT") = strProjectRoot
WshEnv("MUSIK_LIBRARY") = strProjectRoot & "\dynamic"
WshEnv("MUSIK_DB_PATH") = strProjectRoot & "\data\db\musik.db"
WshEnv("MUSIK_PLAYER_ADDR") = "127.0.0.1:8786"
WshEnv("MUSIK_AUTH_DISABLED") = "1"
WshEnv("MUSIK_WORKER_AUTOSTART") = "0"
WshEnv("PATH") = strProjectRoot & "\bin;" & WshEnv("PATH")

' 1. Start Go Core Player (hidden = 0)
WshShell.Run """" & strProjectRoot & "\bin\musik-player.exe""", 0, False

' 2. Start CLAP Embedder Daemon (hidden = 0)
WshShell.Run """" & strProjectRoot & "\bin\python\python.exe"" """ & strProjectRoot & "\extensions\fetcher\scripts\embedder.py"" --server --port 8790", 0, False

' Wait 2 seconds for core services to bind
WScript.Sleep 2000

' 3. Start Deno Sidecar Gateway (hidden = 0)
WshShell.Run """" & strProjectRoot & "\bin\deno.exe"" run --allow-net --allow-read --allow-write --allow-run --allow-env --allow-ffi """ & strProjectRoot & "\extensions\fetcher\src\server.ts""", 0, False

' Wait 2 seconds and open browser
WScript.Sleep 2000
WshShell.Run "http://127.0.0.1:8787", 1, False
