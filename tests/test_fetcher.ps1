# Automated test suite for musik-fetcher prototype

$projectRoot = Resolve-Path "$PSScriptRoot\.."
$binDir = Join-Path $projectRoot "bin"
$dynamicDir = Join-Path $projectRoot "dynamic"
$scriptsDir = Join-Path $projectRoot "scripts"

$env:PATH = "$binDir;$env:PATH"
$ytdlp = Join-Path $binDir "yt-dlp.exe"
$deno = Join-Path $binDir "deno.exe"

$passCount = 0
$failCount = 0

function Assert-Step($name, [scriptblock]$condition) {
    Write-Host -NoNewline "[TEST] $name ... "
    try {
        $result = & $condition
        if ($result) {
            Write-Host "PASS" -ForegroundColor Green
            $script:passCount++
        } else {
            Write-Host "FAIL" -ForegroundColor Red
            $script:failCount++
        }
    } catch {
        Write-Host "ERROR: $_" -ForegroundColor Red
        $script:failCount++
    }
}

Write-Host "========================================="
Write-Host " Running test suite for musik-fetcher"
Write-Host "========================================="

# 1. Test binaries existence
Assert-Step "Binary yt-dlp.exe exists" { Test-Path $ytdlp }
Assert-Step "Binary deno.exe exists" { Test-Path $deno }

# 2. Test binary executions
Assert-Step "yt-dlp responds with version" {
    $ver = & $ytdlp --version
    return ($LASTEXITCODE -eq 0 -and $ver.Length -gt 0)
}

Assert-Step "deno responds with version" {
    $ver = & $deno --version
    return ($LASTEXITCODE -eq 0 -and $ver.Length -gt 0)
}

# 3. Test YouTube Music stream resolution (dry-run without downloading full file)
Assert-Step "YouTube stream URL extraction works (InnerTube + Deno)" {
    $url = & $ytdlp -f 251 -g --no-warnings "ytsearch1:Queen Bohemian Rhapsody"
    return ($LASTEXITCODE -eq 0 -and $url -match "googlevideo\.com")
}

# 4. Test dynamic folder files
Assert-Step "Downloaded audio files exist in /dynamic" {
    $files = Get-ChildItem -Path $dynamicDir -File
    return ($files.Count -ge 1)
}

Assert-Step "Downloaded files have non-zero size (> 1MB)" {
    $files = Get-ChildItem -Path $dynamicDir -File
    $valid = $true
    foreach ($f in $files) {
        if ($f.Length -lt 1000000) { $valid = $false }
    }
    return $valid
}

Write-Host "========================================="
Write-Host "Results: $passCount passed, $failCount failed."
if ($failCount -eq 0) {
    Write-Host "ALL TESTS PASSED!" -ForegroundColor Green
} else {
    Write-Host "SOME TESTS FAILED!" -ForegroundColor Red
}
Write-Host "========================================="
