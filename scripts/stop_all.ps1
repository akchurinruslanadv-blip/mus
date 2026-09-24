# Stop Musik services cleanly
Write-Host "Stopping Musik services..." -ForegroundColor Cyan

Get-CimInstance Win32_Process | Where-Object { 
    $_.Name -eq "musik-player.exe" -or 
    ($_.Name -eq "deno.exe" -and $_.CommandLine -like "*server.ts*") -or 
    ($_.Name -eq "python.exe" -and $_.CommandLine -like "*embedder.py*")
} | ForEach-Object {
    Write-Host "Stopping process: $($_.Name) (PID: $($_.ProcessId))" -ForegroundColor Yellow
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}

Write-Host "All Musik services stopped successfully." -ForegroundColor Green
