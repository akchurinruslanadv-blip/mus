param (
    [Parameter(Mandatory=$true)]
    [string]$Query,
    [string]$OutputDir = ""
)

$binDir = (Resolve-Path "$PSScriptRoot\..\bin").Path
$env:PATH = "$binDir;$env:PATH"
$ytdlp = "$binDir\yt-dlp.exe"

if ([string]::IsNullOrWhiteSpace($OutputDir)) {
    $OutputDir = Join-Path (Split-Path $PSScriptRoot -Parent) "dynamic"
}

if (-not (Test-Path $OutputDir)) {
    New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
}

Write-Host "========================================="
Write-Host "Searching and downloading: $Query"
Write-Host "Target folder: $OutputDir"
Write-Host "========================================="

$outputTemplate = "$OutputDir\%(artist,creator,uploader)s - %(title)s [%(id)s].%(ext)s"
$stopwatch = [System.Diagnostics.Stopwatch]::StartNew()

$argsList = @(
    "--no-playlist",
    "-f", "251/ba",
    "--no-warnings",
    "ytsearch1:$Query",
    "-o", $outputTemplate
)

& $ytdlp $argsList

$stopwatch.Stop()
$elapsed = [Math]::Round($stopwatch.Elapsed.TotalSeconds, 2)

Write-Host ""
Write-Host "Done! Download time: $elapsed s"
Write-Host "Saved to: $OutputDir"
