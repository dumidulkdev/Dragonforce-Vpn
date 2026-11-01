!macro customCheckAppRunning
  InitPluginsDir
  File /oname=$PLUGINSDIR\dragonforce-cleanup.ps1 "${BUILD_RESOURCES_DIR}\installer-cleanup.ps1"
  dragonforce_retry_cleanup:
    nsExec::ExecToLog '"$PowerShellPath" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\dragonforce-cleanup.ps1" -InstallDir "$INSTDIR"'
    Pop $R0
    ${if} $R0 != 0
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY dragonforce_retry_cleanup
      Quit
    ${endif}
!macroend
