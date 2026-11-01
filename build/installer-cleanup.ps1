param([Parameter(Mandatory = $true)][string]$InstallDir)

$ErrorActionPreference = 'Stop'
$executable = Join-Path $InstallDir 'DragonForce-VPN.exe'

function Get-InstalledAppProcesses {
  @(Get-CimInstance Win32_Process -Filter "Name = 'DragonForce-VPN.exe'" | Where-Object {
    # An inaccessible executable path can belong to an elevated copy. Wait for
    # that copy to exit rather than removing files under an active controller.
    $_.ExecutablePath -ieq $executable -or -not $_.ExecutablePath
  })
}

try {
  $deadline = [DateTime]::UtcNow.AddSeconds(45)
  do {
    $running = @(Get-InstalledAppProcesses)
    if ($running.Count -eq 0) { exit 0 }
    foreach ($item in $running) {
      try {
        $process = Get-Process -Id $item.ProcessId -ErrorAction Stop
        if ($process.MainWindowHandle -ne 0) {
          # Electron's close handler waits for Xray, TUN and Windows restoration.
          [void]$process.CloseMainWindow()
        }
      } catch { # A process may have exited between enumeration and this call.
      }
    }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $deadline)
  exit 1
} catch {
  Write-Output $_.Exception.Message
  exit 1
}
