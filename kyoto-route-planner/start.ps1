$ErrorActionPreference = "Stop"

$root = $PSScriptRoot
$backend = Join-Path $root "backend"
$frontend = Join-Path $root "frontend"
$python = Join-Path $backend ".venv\Scripts\python.exe"
$dist = Join-Path $frontend "dist"
$distIndex = Join-Path $dist "index.html"
$frontendSource = Join-Path $frontend "src"
$healthUrl = "http://127.0.0.1:8000/api/health"
$appUrl = "http://127.0.0.1:8000/"

if (-not (Test-Path $python)) {
    throw "Backend Python environment is missing. See README.md for setup instructions."
}
if (-not (Test-Path $distIndex)) {
    $frontendNeedsBuild = $true
}
else {
    $latestSource = Get-ChildItem -LiteralPath $frontendSource -Recurse -File |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1
    $frontendNeedsBuild = $latestSource -and $latestSource.LastWriteTime -gt (Get-Item $distIndex).LastWriteTime
}
if ($frontendNeedsBuild) {
    if (-not (Test-Path (Join-Path $frontend "node_modules"))) {
        throw "Frontend dependencies are missing. Run 'npm.cmd ci' in the frontend folder."
    }
    $npm = Get-Command "npm.cmd" -ErrorAction SilentlyContinue
    if (-not $npm) {
        throw "Node.js and npm are required to build the updated frontend."
    }
    Push-Location $frontend
    try {
        & $npm.Source run build
        if ($LASTEXITCODE -ne 0) {
            throw "Frontend build failed with exit code $LASTEXITCODE."
        }
    }
    finally {
        Pop-Location
    }
}
if (-not (Test-Path $distIndex)) {
    throw "Built frontend is missing. Run 'npm.cmd ci' and 'npm.cmd run build' in the frontend folder."
}
if (-not (Test-Path (Join-Path $backend ".env"))) {
    throw "backend\.env is missing. Copy backend\.env.example and configure the API key."
}

$health = $null
try {
    $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 2
}
catch {
}
if ($health -and $health.status -eq "ok") {
    if ($health.route_timeline_version -ne "1") {
        throw "An outdated API server is already using port 8000. Close its server window and run this shortcut again."
    }
    Write-Host "The Kyoto route planner is already running."
}
elseif ($health) {
    throw "An unexpected service is already using port 8000."
}
else {
    $backendLiteral = $backend.Replace("'", "''")
    $pythonLiteral = $python.Replace("'", "''")
    $command = "Set-Location -LiteralPath '$backendLiteral'; & '$pythonLiteral' -X utf8 -m uvicorn app.main:app --host 127.0.0.1 --port 8000"
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
    Start-Process -FilePath "powershell.exe" `
        -ArgumentList @("-NoLogo", "-NoExit", "-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", $encoded) `
        -WorkingDirectory $backend | Out-Null

    $ready = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        Start-Sleep -Seconds 1
        $health = $null
        try {
            $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 2
        }
        catch {
        }
        if ($health -and $health.status -eq "ok") {
            if ($health.route_timeline_version -ne "1") {
                throw "An outdated API server is responding on port 8000. Close its server window and run this shortcut again."
            }
            $ready = $true
            break
        }
    }
    if (-not $ready) {
        throw "The API server did not become ready. Check the API server window for errors."
    }
}

Start-Process $appUrl
Write-Host "Kyoto route planner is ready at $appUrl"
