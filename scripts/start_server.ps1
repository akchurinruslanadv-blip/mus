$projectRoot = (Resolve-Path "$PSScriptRoot\..").Path
$deno = "$projectRoot\bin\deno.exe"
$serverScript = "$projectRoot\extensions\fetcher\src\server.ts"

Write-Host "========================================="
Write-Host " Starting modular musik-fetcher Sidecar..."
Write-Host " URL: http://0.0.0.0:8787"
Write-Host "========================================="

& $deno run --allow-net --allow-read --allow-write --allow-run --allow-env --allow-ffi $serverScript

