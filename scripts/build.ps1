$ErrorActionPreference = "Stop"

go mod tidy
$root = Split-Path -Parent $PSScriptRoot
$output = Join-Path $root "Moreno.GPTFS.exe"
$destinationDir = "G:\Software"
$destination = Join-Path $destinationDir "Moreno.GPTFS.exe"
if (!(Test-Path -LiteralPath $destinationDir -PathType Container)) { throw "Missing deployment directory: $destinationDir" }
$running = @(Get-CimInstance Win32_Process -Filter "Name='Moreno.GPTFS.exe'" | Where-Object {
    [String]::Equals($_.ExecutablePath, $output, [StringComparison]::OrdinalIgnoreCase) -or
    [String]::Equals($_.ExecutablePath, $destination, [StringComparison]::OrdinalIgnoreCase)
})
foreach ($process in $running) { Stop-Process -Id $process.ProcessId -Force }
foreach ($process in $running) { Wait-Process -Id $process.ProcessId -Timeout 10 -ErrorAction SilentlyContinue }
$png = Join-Path $root "appicon.png"
$ico = Join-Path $PSScriptRoot "appicon.ico"
$rc = Join-Path $PSScriptRoot "appicon.rc"
$syso = Join-Path $root "resource_windows.syso"
$bytes = [IO.File]::ReadAllBytes($png)
$stream = [IO.File]::Create($ico)
$writer = [IO.BinaryWriter]::new($stream)
try {
    $writer.Write([UInt16]0); $writer.Write([UInt16]1); $writer.Write([UInt16]1)
    $writer.Write([Byte]0); $writer.Write([Byte]0); $writer.Write([Byte]0); $writer.Write([Byte]0)
    $writer.Write([UInt16]1); $writer.Write([UInt16]32); $writer.Write([UInt32]$bytes.Length); $writer.Write([UInt32]22)
    $writer.Write($bytes)
} finally { $writer.Dispose(); $stream.Dispose() }
Set-Content -LiteralPath $rc -Value 'IDI_ICON1 ICON "appicon.ico"' -Encoding ascii
try {
    & windres -i $rc -o $syso -O coff
    if ($LASTEXITCODE -ne 0) { throw "windres failed with exit code $LASTEXITCODE" }
    go build -tags production -trimpath -ldflags="-s -w -H windowsgui" -o $output $root
    if ($LASTEXITCODE -ne 0) { throw "go build failed with exit code $LASTEXITCODE" }
    & upx --best --lzma $output
    if ($LASTEXITCODE -ne 0) { throw "UPX failed with exit code $LASTEXITCODE" }
} finally {
    Remove-Item -LiteralPath $ico,$rc,$syso -Force -ErrorAction SilentlyContinue
}
Copy-Item -LiteralPath $output -Destination $destination -Force
$sourceHash = (Get-FileHash -LiteralPath $output -Algorithm SHA256).Hash
$destinationHash = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash
if ($sourceHash -ne $destinationHash) { throw "Deployment hash mismatch: $destination" }
Write-Host "Built: $output"
Write-Host "Deployed: $destination"
