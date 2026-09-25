# scripts/monitor_2min.ps1: 2-minute benchmark & telemetry logger
$durationSec = 120
$intervalSec = 2
$steps = [int]($durationSec / $intervalSec)

Write-Host "=========================================================="
Write-Host " Starting 2-minute resource benchmark..."
Write-Host " You can actively skip tracks, like, search, and browse!"
Write-Host " Monitoring: musik-player, deno, python, yt-dlp, ffmpeg"
Write-Host " Duration: $durationSec seconds (sampling every $intervalSec s)"
Write-Host "=========================================================="

$samples = @()

for ($i = 1; $i -le $steps; $i++) {
    Start-Sleep -Seconds $intervalSec
    
    $procs = Get-CimInstance Win32_PerfFormattedData_PerfProc_Process -ErrorAction SilentlyContinue | 
             Where-Object { $_.Name -match 'musik-player|deno|python|yt-dlp|ffmpeg' }
    
    $timestamp = (Get-Date).ToString("HH:mm:ss")
    
    foreach ($p in $procs) {
        $name = $p.Name
        # Group instances like deno#1 -> deno
        if ($name -match '^(musik-player|deno|python|yt-dlp|ffmpeg)') {
            $baseName = $matches[1]
            $samples += [PSCustomObject]@{
                Time = $timestamp
                Name = $baseName
                CPU  = [int]$p.PercentProcessorTime
                RAM  = [int]($p.WorkingSetPrivate / 1MB)
            }
        }
    }
}

Write-Host "`n================ BENCHMARK REPORT (2 MINUTES) ================"

$grouped = $samples | Group-Object Name

$report = foreach ($g in $grouped) {
    $cpuStats = $g.Group | Measure-Object -Property CPU -Average -Maximum -Minimum
    $ramStats = $g.Group | Measure-Object -Property RAM -Average -Maximum -Minimum
    
    [PSCustomObject]@{
        Process      = $g.Name
        'Avg CPU %'  = [math]::Round($cpuStats.Average, 1)
        'Peak CPU %' = [math]::Round($cpuStats.Maximum, 1)
        'Min RAM MB' = [int]$ramStats.Minimum
        'Max RAM MB' = [int]$ramStats.Maximum
        'Samples'    = $g.Count
    }
}

$report | Format-Table -AutoSize
Write-Host "==============================================================`n"
