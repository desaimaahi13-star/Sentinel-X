param(
    [string]$ProjectId = '',
    [string]$Service = '',
    [string]$Environment = '',
    [string]$OutDir = (Join-Path $env:TEMP 'sentinel-x-railway-deploy')
)

$ErrorActionPreference = 'Stop'

function Copy-IfExists {
    param([string]$Path, [string]$DestDir)
    if (Test-Path $Path) {
        Copy-Item -Force $Path -Destination (Join-Path $DestDir (Split-Path $Path -Leaf))
    }
}

$ProjectRoot = $PSScriptRoot

Write-Host "Preparing clean deploy folder:" $OutDir
if (Test-Path $OutDir) {
    Remove-Item -Recurse -Force $OutDir
}
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

# Copy only the source + manifests needed for Railway build (avoids OneDrive/SQLite lock issues)
Copy-IfExists (Join-Path $ProjectRoot 'package.json') $OutDir
Copy-IfExists (Join-Path $ProjectRoot 'package-lock.json') $OutDir
Copy-IfExists (Join-Path $ProjectRoot 'server.js') $OutDir
Copy-IfExists (Join-Path $ProjectRoot 'index.html') $OutDir
Copy-IfExists (Join-Path $ProjectRoot 'script.js') $OutDir
Copy-IfExists (Join-Path $ProjectRoot 'style.css') $OutDir
Copy-IfExists (Join-Path $ProjectRoot 'README.md') $OutDir
Copy-IfExists (Join-Path $ProjectRoot '.railwayignore') $OutDir
Copy-IfExists (Join-Path $ProjectRoot '.gitignore') $OutDir

Write-Host "Deploying from:" $OutDir
Push-Location $OutDir
try {
    $upArgs = @()
    if ($ProjectId) { $upArgs += @('--project', $ProjectId) }
    if ($Service) { $upArgs += @('--service', $Service) }
    if ($Environment) { $upArgs += @('--environment', $Environment) }
    $upArgs += '--detach'

    railway.cmd up @upArgs
} finally {
    Pop-Location
}
