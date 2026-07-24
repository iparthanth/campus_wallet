# Starts the local development stack: PostgreSQL, API, and web.
#   .\dev.ps1          start everything
#   .\dev.ps1 -Stop    stop everything
#
# The portable Postgres lives on D: and needs no admin rights. It does NOT survive a
# reboot or a terminal being closed, which is why this script exists — restarting it by
# hand every session is exactly the kind of friction that makes a project feel broken.
param([switch]$Stop)

$PGBIN = "D:\devtools\pgsql\bin"
$PGDATA = "D:\devtools\pgdata_wallet"
$ROOT = $PSScriptRoot

function Stop-Port($port) {
  $p = (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue).OwningProcess
  if ($p) { Stop-Process -Id $p -Force; "  stopped process on :$port" }
}

if ($Stop) {
  Stop-Port 3000; Stop-Port 5173
  & "$PGBIN\pg_ctl.exe" -D $PGDATA stop 2>&1 | Out-Null
  Write-Output "stack stopped."
  return
}

# --- PostgreSQL ---
$running = (& "$PGBIN\pg_ctl.exe" -D $PGDATA status 2>&1) -match "server is running"
if (-not $running) {
  # No pipe here. The server pg_ctl spawns inherits stdout, so "| Out-Null" never sees
  # end-of-stream and the script hangs forever with Postgres up but nothing else started.
  # -l already sends the server's own output to the log; pg_ctl's few lines can print.
  & "$PGBIN\pg_ctl.exe" -D $PGDATA -o "-p 5433 -c listen_addresses=127.0.0.1" -l "$PGDATA\server.log" -w start
  Start-Sleep -Seconds 3
}
Write-Output "postgres  : :5433"

# --- API ---
Stop-Port 3000
# npm.cmd, not npm: Start-Process resolves executables, not shell shims, so plain
# "npm" silently fails to launch and the stack comes up with Postgres only.
Start-Process -FilePath "npm.cmd" -ArgumentList "start" -WorkingDirectory "$ROOT\api" -WindowStyle Hidden
Start-Sleep -Seconds 4
try { $h = Invoke-RestMethod "http://localhost:3000/ready" -TimeoutSec 5; Write-Output "api       : :3000  ($($h.status), db $($h.database))" }
catch { Write-Output "api       : :3000  (not ready yet - check api\ logs)" }

# --- Web ---
Stop-Port 5173
Start-Process -FilePath "npm.cmd" -ArgumentList "run dev" -WorkingDirectory "$ROOT\web" -WindowStyle Hidden
Start-Sleep -Seconds 4
Write-Output "web       : http://localhost:5173"
Write-Output ""
Write-Output "Sign in: partha@puc.ac.bd / password123   (admin@puc.ac.bd for the dashboard)"
