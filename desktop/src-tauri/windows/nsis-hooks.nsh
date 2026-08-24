; Capture this while NSIS is parsing the hook include. Macro expansion later
; happens from installer.nsi, where __FILEDIR__ points somewhere else.
!define OSHEEP_NSIS_HOOK_DIR "${__FILEDIR__}"

!macro StopLegacyBundledNode
  ; Releases the executable shipped by older Osheep versions before NSIS
  ; replaces it. Match the full path so unrelated Node processes are untouched.
  InitPluginsDir
  File /oname=$PLUGINSDIR\osheep-stop-legacy-node.ps1 "${OSHEEP_NSIS_HOOK_DIR}\stop-legacy-node.ps1"
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\osheep-stop-legacy-node.ps1" "$INSTDIR\sidecar\node.exe"'
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro StopLegacyBundledNode
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro StopLegacyBundledNode
  ; Persistent Osheep data now lives under the installed backend. Keep it when
  ; the user chooses to preserve application data, and never remove it during
  ; an update. Tauri's checkbox state is available before this hook runs.
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    RMDir /r "$INSTDIR\backend\.osheep"
  ${EndIf}
!macroend
