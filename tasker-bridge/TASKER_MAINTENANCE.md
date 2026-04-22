# Tasker Maintenance Reference (QRPayBiz)

Last updated: 2026-03-03
Location: `tasker-bridge/`

## Current Task (from screenshot)
Task name: `SendQrpayNotif`

Action 1: `HTTP Request`
- Method: `POST`
- URL: `http://72.60.198.106:13005/qrpaybiz/notify`
- Header: `X-API-KEY: <configured-in-tasker>`
- Body:
```json
{"notification_text":"%evtprm3","source_app":"qrpaybiz"}
```

Action 2: `Flash`
- Text: `%http_response_code | %http_data`
- Continue Task Immediately: `ON`

## What this task does
- Receives notification text from Tasker event variable `%evtprm3`.
- Sends it to bridge endpoint `/qrpaybiz/notify`.
- Shows HTTP result on screen using `Flash` for quick debug.

## Recommended baseline profile
Profile: `Event -> Notification`
- Owner Application: `qrpaybiz`
- Task attached: `SendQrpayNotif`

## Response check (expected)
- Success status: HTTP `200`
- `%http_data` should contain `ok=true` (or equivalent success JSON from bridge)

## Maintenance checklist
1. Verify API key is valid and matches bridge server key.
2. Verify URL and port are reachable from phone.
3. Keep battery optimization OFF for Tasker.
4. Test by generating 3-5 notifications in a row.
5. Confirm server logs received all notifications.

## Troubleshooting quick guide
Issue: delayed or missed notification delivery
1. Ensure Tasker has Notification Access permission.
2. Ensure background restrictions are disabled for Tasker.
3. Add small delay before heavy follow-up actions (500-1000 ms).
4. Avoid clearing all notifications globally.
5. Process only QRPayBiz notification, and clear by specific ID/package only.

Issue: HTTP failure
1. Check `%http_response_code` in Flash.
2. If `401/403`: API key mismatch.
3. If `404`: wrong endpoint/path.
4. If timeout/no response: network, IP, or port issue.

## Security note
The screenshot shows a visible API key. Rotate/regenerate the key and update:
- Tasker header `X-API-KEY`
- Bridge env/config `BRIDGE_API_KEY`

## Suggested next improvement (optional)
Add a safer post-send flow in Tasker:
1. Save `notification id/title/text/time` to local log.
2. Dedupe by key (`id|title|text`).
3. Send HTTP request.
4. Clear original QRPayBiz notification by specific ID only.

## Change log
- 2026-03-03: Initial documentation created from user screenshots.
