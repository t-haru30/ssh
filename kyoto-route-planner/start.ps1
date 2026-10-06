$ErrorActionPreference = "Stop"

$root = $PSScriptRoot
$backend = Join-Path $root "backend"
$python = Join-Path $backend ".venv\Scripts\python.exe"
$dist = Join-Path $root "frontend\dist"
$healthUrl = "http://127.0.0.1:8000/api/health"
$appUrl = "http://127.0.0.1:8000/"

if (-not (Test-Path $python)) {
    throw "Backend Python environment is missing. See README.md for setup instructions."
}
if (-not (Test-Path (Join-Path $dist "index.html"))) {
    throw "Built frontend is missing. Run 'npm.cmd ci' and 'npm.cmd run build' in the frontend folder."
}
if (-not (Test-Path (Join-Path $backend ".env"))) {
    throw "backend\.env is missing. Copy backend\.env.example and configure the API key."
}

try {
    $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 2
    if ($health.status -ne "ok") {
        throw "An unexpected service is already using port 8000."
    }
    Write-Host "The Kyoto route planner is already running."
}
catch {
    if ($_.Exception.Message -like "An unexpected service*") {
        throw
    }

    $backendLiteral = $backend.Replace("'", "''")
    $pythonLiteral = $python.Replace("'", "''")
    $command = "Set-Location -LiteralPath '$backendLiteral'; & '$pythonLiteral' -m uvicorn app.main:app --host 127.0.0.1 --port 8000"
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
    Start-Process -FilePath "powershell.exe" `
        -ArgumentList @("-NoLogo", "-NoExit", "-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", $encoded) `
        -WorkingDirectory $backend | Out-Null

    $ready = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        Start-Sleep -Seconds 1
        try {
            $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 2
            if ($health.status -eq "ok") {
                $ready = $true
                break
            }
        }
        catch {
        }
    }
    if (-not $ready) {
        throw "The API server did not become ready. Check the API server window for errors."
    }
}

Start-Process $appUrl
Write-Host "Kyoto route planner is ready at $appUrl"
