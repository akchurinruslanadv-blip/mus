# scripts/start_player.ps1: Launch Go core player with portable relative paths
$projectRoot = (Resolve-Path "$PSScriptRoot\..").Path

$env:MUSIK_ROOT = $projectRoot
$env:MUSIK_LIBRARY = "$projectRoot\dynamic"
$env:MUSIK_DB_PATH = "$projectRoot\data\db\musik.db"
$env:MUSIK_PLAYER_ADDR = "127.0.0.1:8786"
$env:MUSIK_AUTH_DISABLED = "1"
$env:MUSIK_WORKER_AUTOSTART = "0"
$env:PATH = "$projectRoot\bin;$env:PATH"

Write-Host "[musik-player] Starting on http://127.0.0.1:8786..."
& "$projectRoot\bin\musik-player.exe"
