$ErrorActionPreference = "Stop"

go mod tidy
go build -o Moreno.GPTFS.exe .
Write-Host "Built: $PWD\Moreno.GPTFS.exe"
