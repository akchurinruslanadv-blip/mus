# scripts/start_all.ps1: Single-command launcher for both Core and Fetcher Sidecar
$projectRoot = (Resolve-Path "$PSScriptRoot\..").Path

Write-Host "================================================="
Write-Host " [musik] Starting Complete Streaming Stack..."
Write-Host " Public Web Player: http://0.0.0.0:8787"
Write-Host " Internal Go Core:  http://127.0.0.1:8786"
Write-Host "================================================="

# 1. Start Core Go Player in background
Start-Process powershell -ArgumentList "-ExecutionPolicy Bypass -File `"$projectRoot\scripts\start_player.ps1`"" -WindowStyle Minimized

# 2. Start CLAP 512D Embedder Daemon in background
Start-Process powershell -ArgumentList "-ExecutionPolicy Bypass -File `"$projectRoot\scripts\start_embedder.ps1`"" -WindowStyle Minimized

Start-Sleep -Seconds 3

# 3. Start Sidecar Gateway
powershell -ExecutionPolicy Bypass -File "$projectRoot\scripts\start_server.ps1"
