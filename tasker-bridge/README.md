# Tasker Bridge (LAN only)

This is a SAFE local staging server on Windows for a WhatsApp bot + Android Tasker agent integration.

## Folder structure
- server.js
- config.js
- README.md
- test.ps1
- logs/bridge.log

## Setup (Windows PowerShell)
1) Open PowerShell and go to the folder:
   `cd C:\Users\pro_x\bot-onexox-QRcode\tasker-bridge`

2) Install dependencies:
   `npm install`

3) Set the API key for this session:
   ` $env:BRIDGE_API_KEY = "your-secret-key" `

4) Start the server:
   `node server.js`

The server binds to `0.0.0.0` and is intended only for private LAN testing.

## Configuration
You can override defaults using environment variables:
- `BRIDGE_BIND` (default: 0.0.0.0)
- `BRIDGE_PORT` (default: 3005)
- `BRIDGE_API_KEY` (default: change-me)

## Endpoints
All endpoints require header `X-API-KEY`.

1) POST /job/submit
Body:
```
{ "job_id": "abc123", "ref": "INV-01", "amount": 10.5, "date": "2026-02-01", "time": "12:30" }
```

2) GET /job/next?device=android1
Response (empty):
```
{ "ok": true, "has_job": false }
```
Response (job):
```
{ "ok": true, "has_job": true, "job": { ... } }
```

3) GET /tasker/job/next_id?device=android1
Response text (plain):
- `NOJOB`
- atau `job-xxxx...`
Endpoint ini khas untuk Tasker supaya tak perlu parse JSON.

4) POST /job/result
Body:
```
{ "job_id": "abc123", "stage": "done", "match": true, "reason": "ok", "best_row": { "row": 1 } }
```

5) GET /job/status/:jobid
Returns status + result if done.

6) POST /job/result_from_notification
Body:
```
{ "job_id": "abc123", "notification_text": "teks notifikasi dari app qrpaybiz" }
```
Server akan parse teks notifikasi, cocokkan dengan data job (`ref`, `amount`, `time`), lalu auto-mark job sebagai `done`.
Request format boleh:
- JSON (`application/json`)
- Form (`application/x-www-form-urlencoded` atau multipart/form-data) dengan field yang sama
- Opsyenal: guna `notification_text_b64` (base64 utf-8) jika teks notifikasi ada karakter yang sukar di-escape

7) POST /qrpaybiz/notify
Body:
```
{ "notification_text": "teks notifikasi qrpaybiz" }
```
Bridge akan:
- simpan notifikasi ke fail harian
- parse `ref/amount/time`
- cuba auto-match dengan job yang sedang menunggu
- tandakan notifikasi `used` bila berjaya dipadankan

7) POST /ocr/qrpay
Accepts an image screenshot and runs OCR on Windows.
Supported bodies:
- `multipart/form-data` (Tasker HTTP Request "Form" or "Multipart") with any file field
- raw file body (`image/png`, `image/jpeg`, or `application/octet-stream`)
Optional query/body params: `amount`, `time` (e.g., `time=12:30`)

8) POST /ocr/qrpay_base64
Body:
```
{ "image_base64": "<base64>", "amount": 10.5, "time": "12:30" }
```

## Retry-safe behavior
If a job stays `in_flight` for more than 120 seconds without result, it is returned to the queue.

## PowerShell test script
Run:
`powershell -ExecutionPolicy Bypass -File .\test.ps1 -BaseUrl http://127.0.0.1:3005 -ApiKey your-secret-key`

## Tasker notes
- Use GET `http://<server-ip>:3005/job/next?device=android1`
- Use POST `http://<server-ip>:3005/job/result`
- Atau pakai POST `http://<server-ip>:3005/job/result_from_notification` jika sumber data dari teks notifikasi `qrpaybiz`
- Disyorkan (alur baharu): POST semua notifikasi ke `http://<server-ip>:3005/qrpaybiz/notify`
- For screenshot OCR, use POST `http://<server-ip>:3005/ocr/qrpay`
- If Tasker only sends raw file, set Body type = File and Content-Type = `image/png` (or leave default `application/octet-stream`)
- Add header `X-API-KEY: your-secret-key`
- Set Tasker to poll every few seconds (e.g., 3-5s) on LAN

## Tasker flow (notification from qrpaybiz)
### Cara lama (polling job)
1) Task `PollJob`
- HTTP Request (GET): `http://<server-ip>:3005/job/next?device=android1`
- Header: `X-API-KEY: your-secret-key`
- If `%http_data` contains `"has_job":true`, extract `job_id` and simpan ke global var (contoh `%JOB_ID`).

2) Profile `Event -> Notification`
- Owner Application: `qrpaybiz`
- Trigger saat notifikasi masuk.

3) Task `SendNotifToBridge`
- If `%JOB_ID` not empty:
- HTTP Request (POST): `http://<server-ip>:3005/job/result_from_notification`
- Header:
  - `X-API-KEY: your-secret-key`
  - `Content-Type: application/json`
- Body (raw JSON):
```
{
  "job_id": "%JOB_ID",
  "notification_text": "%evtprm3"
}
```
- Jika response `ok=true`, kosongkan `%JOB_ID`.

### Cara baharu (disyorkan, no PollLoop)
Tasker tak perlu tunggu `job_id`. Hantar setiap notifikasi `qrpaybiz` terus ke bridge.

1) Profile `Event -> Notification`
- Owner Application: `qrpaybiz`

2) Task `SendNotifToStore`
- HTTP Request (POST): `http://<server-ip>:3005/qrpaybiz/notify`
- Header:
  - `X-API-KEY: your-secret-key`
- Body (raw JSON):
```
{
  "notification_text": "%evtprm3",
  "source_app": "qrpaybiz"
}
```
- Bridge akan simpan noti dan auto-match dengan job jika ada.

## Simpanan notifikasi harian
- Fail: `tasker-bridge/data/qrpaybiz_notifications.json`
- Struktur: `{ date, items[] }`
- Reset harian automatik (hari baru = fail harian dikosongkan)
- Setiap item ada `used: true/false` dan `used_by_job_id`
