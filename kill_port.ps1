$pids = @(Get-NetTCPConnection -LocalPort 8000 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess)
if ($pids.Count -gt 0) {
  foreach ($pid in $pids) {
    try {
      Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue
      Write-Output "Stopped $pid"
    } catch {
      Write-Output "Failed to stop $pid: $_"
    }
  }
} else {
  Write-Output 'No process listening on port 8000'
}
