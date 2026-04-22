VPS Toolkit (Portable)

Copy this whole folder (vps-toolkit) into any project folder.

First time (once per folder):
  powershell -ExecutionPolicy Bypass -File .\vps-toolkit\vps.ps1 -Action init

This will create:
  .\vps-toolkit\.vps.local.json

Notes:
- .vps.local.json stores your VPS password encrypted using Windows DPAPI.
- DPAPI means only the SAME Windows user on the SAME PC can decrypt it.
- Do not commit .vps.local.json into git.

Common commands:
  powershell -ExecutionPolicy Bypass -File .\vps-toolkit\vps.ps1 -Action whoami
  powershell -ExecutionPolicy Bypass -File .\vps-toolkit\vps.ps1 -Action ssh
  powershell -ExecutionPolicy Bypass -File .\vps-toolkit\vps.ps1 -Action exec -Cmd "ls -la /opt"
  powershell -ExecutionPolicy Bypass -File .\vps-toolkit\vps.ps1 -Action upload -Local ".\a.txt" -Remote "/root/a.txt"
  powershell -ExecutionPolicy Bypass -File .\vps-toolkit\vps.ps1 -Action download -Remote "/root/a.txt" -Local ".\\a.txt"

