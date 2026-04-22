# ADB Helper (localhost only)

SAFE Windows helper module that exposes a single local HTTP endpoint for ADB screenshots.

## Security notes
- Binds to 127.0.0.1 only.
- Requires `X-API-KEY` for every request.
- Allows only a fixed allowlist of ADB commands with explicit args.
- Validates `job_id` (letters/numbers/_/- only).
- No arbitrary command execution.

## Setup (Windows PowerShell)
1) `cd C:\Users\pro_x\bot-onexox-QRcode\adb-helper`
2) `npm init -y`
3) `npm install express`
4) Set env vars:
   - `$env:API_KEY = "your-secret-key"`
   - `$env:ANDROID_TARGET = "192.168.1.109:5555"`
   - `$env:OUTPUT_DIR = "C:\\qrpay\\screens"`
   - Optional: `$env:ADB_PATH = "C:\\Android\\platform-tools\\adb.exe"`
5) `node server.js`

## Endpoint
POST `/adb/screenshot`
Body: `{ "job_id": "abc123" }`

Response:
`{ "ok": true, "file": "C:\\qrpay\\screens\\qrpay_abc123_p1.png" }`

## Example requests
### curl
```
curl -X POST http://127.0.0.1:3010/adb/screenshot \
  -H "X-API-KEY: your-secret-key" \
  -H "Content-Type: application/json" \
  -d "{\"job_id\":\"abc123\"}"
```

### PowerShell
```
$headers = @{ "X-API-KEY" = "your-secret-key" }
$body = @{ job_id = "abc123" } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:3010/adb/screenshot" -Headers $headers -Body $body -ContentType "application/json"
```

## Config
Config lives in `config.js` and reads environment variables:
- `API_KEY`
- `ANDROID_TARGET`
- `OUTPUT_DIR`
- `ADB_PATH`
- `ADB_HELPER_PORT`

Logs: `logs\adb-helper.log`
