$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$exe = Join-Path $root "Moreno.GPTFS.dev.exe"

Push-Location $root
try {
go mod tidy
if ($LASTEXITCODE -ne 0) { throw "go mod tidy failed" }

go build -tags production -ldflags="-H windowsgui" -o $exe .
if ($LASTEXITCODE -ne 0) { throw "go build failed" }

Start-Process -FilePath $exe -WorkingDirectory $root

} finally {
Pop-Location
}
