$ErrorActionPreference = "Stop"

go mod tidy
$root = Split-Path -Parent $PSScriptRoot
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
    go build -tags production -trimpath -ldflags="-s -w -H windowsgui" -o (Join-Path $root "Moreno.GPTFS.exe") $root
    if ($LASTEXITCODE -ne 0) { throw "go build failed with exit code $LASTEXITCODE" }
    & upx --best --lzma (Join-Path $root "Moreno.GPTFS.exe")
    if ($LASTEXITCODE -ne 0) { throw "UPX failed with exit code $LASTEXITCODE" }
} finally {
    Remove-Item -LiteralPath $ico,$rc,$syso -Force -ErrorAction SilentlyContinue
}
Write-Host "Built: $root\Moreno.GPTFS.exe"
