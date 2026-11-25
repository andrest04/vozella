; Custom steps for the Vozella NSIS installer (electron-builder `nsis.include`).

; "Open Vozella when Windows starts" is a value under HKCU\...\Run that Electron's
; app.setLoginItemSettings writes: named after the app user model id, with the data
; `"<install dir>\Vozella.exe" --vozella-hidden`. Task Manager may add a value with the same
; name under StartupApproved\Run. Uninstalling removes both, so Windows is not left starting
; an exe that no longer exists. An update also runs the old uninstaller; it keeps them,
; because the new version installs to the same path and keeps the setting.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    !insertmacro vozellaRemoveLoginItems
  ${endIf}
!macroend

; Deletes every Run value whose command starts with this install's quoted exe path.
; Matching on the path, not the value name, finds the entry whatever name Electron chose.
!macro vozellaRemoveLoginItems
  Push $R0
  Push $R1
  Push $R2
  Push $R3
  Push $R4

  StrCpy $R3 '"$INSTDIR\${APP_EXECUTABLE_FILENAME}"'
  StrLen $R4 $R3
  StrCpy $R0 0

  vozellaLoginItemLoop:
    ClearErrors
    EnumRegValue $R1 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" $R0
    StrCmp $R1 "" vozellaLoginItemDone
    ReadRegStr $R2 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" $R1
    StrCpy $R2 $R2 $R4
    ; StrCmp ignores case, as Windows paths do.
    StrCmp $R2 $R3 0 vozellaLoginItemNext
      DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" $R1
      DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" $R1
      ; The next value now sits at the same index.
      Goto vozellaLoginItemLoop
    vozellaLoginItemNext:
    IntOp $R0 $R0 + 1
    Goto vozellaLoginItemLoop
  vozellaLoginItemDone:

  Pop $R4
  Pop $R3
  Pop $R2
  Pop $R1
  Pop $R0
!macroend
