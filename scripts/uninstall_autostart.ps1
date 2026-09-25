# scripts/uninstall_autostart.ps1
# Removes Musik autostart from HKCU registry — no admin rights needed.

$regPath = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
Remove-ItemProperty -Path $regPath -Name "MusikStack" -ErrorAction SilentlyContinue
Write-Host "[removed] HKCU\...\Run\MusikStack"
Write-Host "Musik will no longer start automatically at logon."
