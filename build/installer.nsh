!macro backupStoragePointer registryRoot backupDir
  ReadRegStr $0 ${registryRoot} "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${If} $0 != ""
  ${AndIf} ${FileExists} "$0\launcher-storage.json"
    CreateDirectory "$PLUGINSDIR\${backupDir}"
    ClearErrors
    CopyFiles /SILENT "$0\launcher-storage.json" "$PLUGINSDIR\${backupDir}"
    IfErrors storagePointerBackupFailed
  ${EndIf}
!macroend

!macro customInit
  InitPluginsDir
  !insertmacro backupStoragePointer HKCU storage-pointer-user
  !insertmacro backupStoragePointer HKLM storage-pointer-machine
  Goto storagePointerBackupDone

  storagePointerBackupFailed:
    DetailPrint "Could not back up launcher-storage.json."
    SetErrorLevel 2
    Quit

  storagePointerBackupDone:
!macroend

!macro customInstall
  StrCpy $0 "$PLUGINSDIR\storage-pointer-user\launcher-storage.json"
  ${If} $installMode == "all"
    StrCpy $0 "$PLUGINSDIR\storage-pointer-machine\launcher-storage.json"
    ${IfNot} ${FileExists} "$0"
      StrCpy $0 "$PLUGINSDIR\storage-pointer-user\launcher-storage.json"
    ${EndIf}
  ${EndIf}
  ${If} ${FileExists} "$0"
    ClearErrors
    CopyFiles /SILENT "$0" "$INSTDIR"
    IfErrors 0 storagePointerRestoreDone
    DetailPrint "Could not restore launcher-storage.json."
    SetErrorLevel 2
    Quit
  ${EndIf}

  storagePointerRestoreDone:
!macroend
