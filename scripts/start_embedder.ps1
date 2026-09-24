# scripts/start_embedder.ps1: Persistent CLAP 512D Embedder Daemon
$projectRoot = (Resolve-Path "$PSScriptRoot\..").Path
$python = "$projectRoot\bin\python\python.exe"
$embedderScript = "$projectRoot\extensions\fetcher\scripts\embedder.py"

Write-Host "========================================="
Write-Host " Starting CLAP 512D Embedder Daemon..."
Write-Host " URL: http://127.0.0.1:8790"
Write-Host "========================================="

& $python $embedderScript --server --port 8790
