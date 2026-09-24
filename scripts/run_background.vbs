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

WshShell.CurrentDirectory = strProjectRoot

' 1. Start Go Core Player (hidden)
WshShell.Run "powershell.exe -WindowStyle Hidden -ExecutionPolicy Bypass -File """ & strProjectRoot & "\scripts\start_player.ps1""", 0, False

' 2. Start CLAP Embedder Daemon (hidden)
WshShell.Run "powershell.exe -WindowStyle Hidden -ExecutionPolicy Bypass -File """ & strProjectRoot & "\scripts\start_embedder.ps1""", 0, False

' Wait 2.5 seconds for core services to bind
WScript.Sleep 2500

' 3. Start Deno Sidecar Gateway (hidden)
WshShell.Run "powershell.exe -WindowStyle Hidden -ExecutionPolicy Bypass -File """ & strProjectRoot & "\scripts\start_server.ps1""", 0, False

' Wait 2 seconds and open browser
WScript.Sleep 2000
WshShell.Run "http://127.0.0.1:8787", 1, False
