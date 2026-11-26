; Volume 3 Custom NSIS Installer & Uninstaller Hooks
; Implements in-place upgrade handling, desktop shortcut, autostart, and settings cleanup on uninstall.

!macro NSIS_HOOK_PREINSTALL
  ; Terminate running Volume 3 or legacy VolZone instances so upgrades overwrite binaries cleanly
  DetailPrint "Checking for running instances of Volume 3..."
  nsExec::Exec 'taskkill /F /IM volume-3.exe'
  nsExec::Exec 'taskkill /F /IM volzone.exe'
  Sleep 600
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; Create Desktop Shortcut for current user
  DetailPrint "Creating Desktop Shortcut..."
  CreateShortcut "$DESKTOP\Volume 3.lnk" "$INSTDIR\volume-3.exe" "" "$INSTDIR\volume-3.exe" 0

  ; Create Start Menu Shortcut
  CreateDirectory "$SMPROGRAMS\Volume 3"
  CreateShortcut "$SMPROGRAMS\Volume 3\Volume 3.lnk" "$INSTDIR\volume-3.exe" "" "$INSTDIR\volume-3.exe" 0
  CreateShortcut "$SMPROGRAMS\Volume 3\Uninstall Volume 3.lnk" "$INSTDIR\uninstall.exe" "" "$INSTDIR\uninstall.exe" 0

  ; Remove legacy autostart value if upgrading and register Volume 3 autostart
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "VolZone"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Volume 3" '"$INSTDIR\volume-3.exe" --minimized'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; Terminate running instance prior to uninstall
  DetailPrint "Closing active Volume 3 process..."
  nsExec::Exec 'taskkill /F /IM volume-3.exe'
  Sleep 600

  ; Ask user if they wish to purge configuration files, profiles, and log history
  MessageBox MB_YESNO|MB_ICONQUESTION "Do you want to delete all Volume 3 settings, custom zone profiles, and rotating log files?" IDNO keep_user_settings
    RMDir /r "$APPDATA\Volume 3"
    RMDir /r "$LOCALAPPDATA\Volume 3"
    DetailPrint "Removed user configuration and log directories."
  keep_user_settings:
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; Clean up desktop and start menu shortcuts
  Delete "$DESKTOP\Volume 3.lnk"
  RMDir /r "$SMPROGRAMS\Volume 3"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Volume 3"
!macroend
