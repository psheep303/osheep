; Capture this while NSIS is parsing the hook include. Macro expansion later
; happens from installer.nsi, where __FILEDIR__ points somewhere else.
!define OSHEEP_NSIS_HOOK_DIR "${__FILEDIR__}"

!macro StopLegacyService
  ; Releases the Rust service shipped by older Osheep versions before NSIS replaces it.
  InitPluginsDir
  File /oname=$PLUGINSDIR\osheep-stop-legacy-service.ps1 "${OSHEEP_NSIS_HOOK_DIR}\stop-legacy-service.ps1"
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\osheep-stop-legacy-service.ps1" "$INSTDIR\sidecar\osheep-server.exe"'
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro StopLegacyService
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro StopLegacyService
  ; Rust data is per-user and intentionally survives updates/uninstall hooks.
!macroend
