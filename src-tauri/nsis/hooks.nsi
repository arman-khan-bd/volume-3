; VolZone Custom NSIS Installer & Uninstaller Hooks
; Implements in-place upgrade handling, desktop shortcut, autostart, and settings removal on uninstall.

!macro NSIS_HOOK_PREINSTALL
  ; Terminate running VolZone instances so in-place upgrades can overwrite binaries cleanly
  DetailPrint "Checking for running instances of VolZone..."
  nsExec::Exec 'taskkill /F /IM volzone.exe'
  Sleep 600
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; Create Desktop Shortcut for current user
  DetailPrint "Creating Desktop Shortcut..."
  CreateShortcut "$DESKTOP\VolZone.lnk" "$INSTDIR\volzone.exe" "" "$INSTDIR\volzone.exe" 0

  ; Create Start Menu Shortcut
  CreateDirectory "$SMPROGRAMS\VolZone"
  CreateShortcut "$SMPROGRAMS\VolZone\VolZone.lnk" "$INSTDIR\volzone.exe" "" "$INSTDIR\volzone.exe" 0
  CreateShortcut "$SMPROGRAMS\VolZone\Uninstall VolZone.lnk" "$INSTDIR\uninstall.exe" "" "$INSTDIR\uninstall.exe" 0

  ; Register HKCU run key for optional autostart
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "VolZone" '"$INSTDIR\volzone.exe" --minimized'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; Terminate running instance prior to uninstall
  DetailPrint "Closing active VolZone process..."
  nsExec::Exec 'taskkill /F /IM volzone.exe'
  Sleep 600

  ; Ask user if they wish to purge configuration files, profiles, and log history
  MessageBox MB_YESNO|MB_ICONQUESTION "Do you want to delete all VolZone settings, custom zone profiles, and rotating log files?" IDNO keep_user_settings
    RMDir /r "$APPDATA\VolZone"
    RMDir /r "$LOCALAPPDATA\VolZone"
    DetailPrint "Removed user configuration and log directories."
  keep_user_settings:
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; Clean up desktop and start menu shortcuts
  Delete "$DESKTOP\VolZone.lnk"
  RMDir /r "$SMPROGRAMS\VolZone"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "VolZone"
!macroend
