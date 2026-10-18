param(
    [string]$ApiBaseUrl = "http://localhost:3000",
    [string]$ApiKey = $env:PAYMENTS_API_KEY,
    [string]$PrinterName = "",
    [int]$PollSeconds = 2
)

$ErrorActionPreference = "Stop"
$logName = "Microsoft-Windows-PrintService/Operational"
$stateDirectory = Join-Path $env:LOCALAPPDATA "PagosLoterias"
$stateFile = Join-Path $stateDirectory "last-print-record.txt"

if ([string]::IsNullOrWhiteSpace($ApiKey) -or $ApiKey.Length -lt 32) {
    throw "Define PAYMENTS_API_KEY con la misma clave API del backend (mínimo 32 caracteres)."
}
if ($PollSeconds -lt 1) {
    throw "PollSeconds debe ser al menos 1."
}

$log = Get-WinEvent -ListLog $logName
if (-not $log.IsEnabled) {
    throw "El registro $logName está deshabilitado. Habilítalo como administrador según README.md."
}
if (-not (Test-Path $stateDirectory)) {
    New-Item -Path $stateDirectory -ItemType Directory -Force | Out-Null
}

if (Test-Path $stateFile) {
    $lastRecordId = [long](Get-Content -Path $stateFile -Raw)
} else {
    $latestEvent = Get-WinEvent -LogName $logName -MaxEvents 1 -ErrorAction SilentlyContinue
    $lastRecordId = if ($latestEvent) { [long]$latestEvent.RecordId } else { 0 }
    Set-Content -Path $stateFile -Value $lastRecordId
}

$ApiBaseUrl = $ApiBaseUrl.TrimEnd("/")
$headers = @{ "x-api-key" = $ApiKey }
Write-Host "Monitoreando trabajos impresos en $env:COMPUTERNAME. Ctrl+C para salir."
if ($PrinterName) {
    Write-Host "Impresora filtrada: $PrinterName"
}

while ($true) {
    $xpath = "*[System[(EventID=307) and (EventRecordID > $lastRecordId)]]"
    $events = @(Get-WinEvent -LogName $logName -FilterXPath $xpath -ErrorAction SilentlyContinue |
        Sort-Object RecordId)

    foreach ($printEvent in $events) {
        $values = @($printEvent.Properties | ForEach-Object { [string]$_.Value })
        $documentName = if ($values.Count -gt 0) { $values[0] } else { "" }
        $printer = if ($values.Count -gt 3) { $values[3] } else { "" }
        $recordId = [long]$printEvent.RecordId

        if ($PrinterName -and $printer -ne $PrinterName) {
            $lastRecordId = $recordId
            Set-Content -Path $stateFile -Value $lastRecordId
            continue
        }

        $payload = @{
            eventKey = "$env:COMPUTERNAME`:$recordId"
            printerName = if ($printer) { $printer } else { "Impresora Windows" }
            documentName = $documentName
            workstation = $env:COMPUTERNAME
        } | ConvertTo-Json

        try {
            $result = Invoke-RestMethod -Method Post `
                -Uri "$ApiBaseUrl/api/impresiones" `
                -Headers $headers `
                -ContentType "application/json" `
                -Body $payload `
                -TimeoutSec 10

            if ($result.status -eq "pending") {
                Start-Process $result.formUrl
                Write-Host "Formulario abierto para '$documentName' (trabajo $recordId)."
            } elseif ($result.status -eq "registered") {
                Write-Host "El trabajo $recordId ya estaba registrado."
            } else {
                Write-Warning "El enlace del trabajo $recordId venció; imprime un nuevo ticket."
            }

            $lastRecordId = $recordId
            Set-Content -Path $stateFile -Value $lastRecordId
        } catch {
            Write-Warning "No se pudo notificar el trabajo $recordId; se reintentará: $_"
            break
        }
    }

    Start-Sleep -Seconds $PollSeconds
}
