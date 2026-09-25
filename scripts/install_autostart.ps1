# scripts/install_autostart.ps1
# Registers Musik services in HKCU Run registry key — no admin rights needed.
# Run once:  powershell -ExecutionPolicy Bypass -File scripts\install_autostart.ps1

$projectRoot = (Resolve-Path "$PSScriptRoot\..").Path
$vbs = "$projectRoot\scripts\run_background.vbs"

Write-Host "Project root: $projectRoot"

# ─── Registry key (current user, no elevation needed) ────────────────────────
$regPath = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"

# Single entry: launches the VBS helper that starts all three services hidden
$cmd = "wscript.exe `"$vbs`""

Set-ItemProperty -Path $regPath -Name "MusikStack" -Value $cmd
Write-Host "[registered] HKCU\...\Run -> MusikStack"

Write-Host ""
Write-Host "================================================="
Write-Host " [musik] Autostart registered!"
Write-Host ""
Write-Host " On every user logon, all services start silently:"
Write-Host "   Go Core Player    -> http://127.0.0.1:8786"
Write-Host "   CLAP Embedder     -> http://127.0.0.1:8790"
Write-Host "   Sidecar Gateway   -> http://0.0.0.0:8787"
Write-Host "   Browser opens     -> http://127.0.0.1:8787"
Write-Host ""
Write-Host " To remove autostart:"
Write-Host "   powershell -File scripts\uninstall_autostart.ps1"
Write-Host ""
Write-Host " To start services NOW without rebooting:"
Write-Host "   wscript.exe `"$vbs`""
Write-Host "================================================="
