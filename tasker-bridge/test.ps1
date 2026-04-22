param(
  [string]$BaseUrl = "http://127.0.0.1:3005",
  [string]$ApiKey = "change-me",
  [string]$JobId = ("job-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
)

$headers = @{ "X-API-KEY" = $ApiKey }

$job = @{
  job_id = $JobId
  ref = "REF-01"
  amount = 12.34
  date = "2026-02-01"
  time = "12:30"
} | ConvertTo-Json

Write-Host "Submitting job $JobId" -ForegroundColor Cyan
Invoke-RestMethod -Method Post -Uri "$BaseUrl/job/submit" -Headers $headers -Body $job -ContentType "application/json"

for ($i = 0; $i -lt 10; $i++) {
  Start-Sleep -Seconds 2
  $status = Invoke-RestMethod -Method Get -Uri "$BaseUrl/job/status/$JobId" -Headers $headers
  Write-Host "Status poll $($i + 1):" -ForegroundColor Yellow
  $status | ConvertTo-Json -Depth 6
}
