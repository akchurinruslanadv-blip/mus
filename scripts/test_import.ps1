$body = @{
    tracks = @("Daft Punk - Harder, Better, Faster, Stronger", "M83 - Midnight City")
    addToFavorites = $true
    pinForever = $false
    autoEmbed512 = $true
} | ConvertTo-Json

$res = Invoke-RestMethod -Uri "http://localhost:8795/api/v1/import/playlist" -Method Post -Body $body -ContentType "application/json"
$res | ConvertTo-Json
