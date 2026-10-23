; The app remains asInvoker. Only the installer requests elevation, before
; Start-Process returns to the updater; cancelling UAC never creates a process.
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!define /ifndef ANUBIS_MACHINE_SCRIPT "${__FILEDIR__}\windows-machine-install.ps1"
!define /ifndef ANUBIS_MACHINE_LEAF "Anubis-Security-Tool"
!define ANUBIS_MACHINE_SUPPORT "${__FILEDIR__}"

!ifmacrondef AnubisMachineAction
!macro AnubisMachineAction ACTION
  InitPluginsDir
  File /oname=$PLUGINSDIR\windows-machine-install.ps1 "${ANUBIS_MACHINE_SCRIPT}"
  File /oname=$PLUGINSDIR\windows-user-migration.ps1 "${ANUBIS_MACHINE_SUPPORT}\windows-user-migration.ps1"
  File /oname=$PLUGINSDIR\windows-user-migration.cs "${ANUBIS_MACHINE_SUPPORT}\windows-user-migration.cs"
  !ifndef BUILD_UNINSTALLER
    ClearErrors
    FileOpen $R3 "$PLUGINSDIR\allowed-user-sids.txt" w
    FileWrite $R3 "$AnubisAllowedUserSids"
    FileClose $R3
    ${If} ${Errors}
      SetErrorLevel 5
      StrCpy $AnubisMessage "Cannot stage explicit user authorization. Setup stopped. Exit code: 5."
      Call AnubisFail
    ${EndIf}
    nsExec::ExecToLog '"$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\windows-machine-install.ps1" -Action ${ACTION} -InstallDir "$INSTDIR" -SidListFile "$PLUGINSDIR\allowed-user-sids.txt" -MigrationRequested "$AnubisMigratePerUser"'
  !else
    nsExec::ExecToLog '"$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\windows-machine-install.ps1" -Action ${ACTION} -InstallDir "$INSTDIR"'
  !endif
  Pop $R0
  ${If} $R0 != 0
    SetErrorLevel 5
    !ifndef BUILD_UNINSTALLER
      StrCpy $AnubisMessage "Machine service ${ACTION} failed. Setup is incomplete; profiles and host data were retained. Exit code: 5."
      Call AnubisFail
    !else
      MessageBox MB_OK|MB_ICONSTOP "Machine service ${ACTION} failed. Uninstall stopped; profiles and host data were retained. Exit code: 5." /SD IDOK
    !endif
    Quit
  ${EndIf}
!macroend
!endif

!macro customHeader
  !ifdef APP_32
    !error "The native machine installer supports x64 only; use standalone archives for ia32."
  !endif
  !ifdef APP_ARM64
    !error "The native machine installer supports x64 only; use standalone archives for ARM64."
  !endif
  !ifdef BUILD_UNINSTALLER
    RequestExecutionLevel admin
  !endif
  !ifndef BUILD_UNINSTALLER
    RequestExecutionLevel admin
    SilentInstall silent
  !endif
!macroend

!ifndef BUILD_UNINSTALLER
  Var AnubisConsole
  Var AnubisConsoleMode
  Var AnubisMessage
  Var AnubisAllowedUserSids
  Var AnubisMigratePerUser

  Function AnubisPrint
    DetailPrint "$AnubisMessage"
    ${If} $AnubisConsole != 0
      StrCpy $AnubisMessage "$AnubisMessage$\r$\n"
      System::Call 'kernel32::lstrlenW(w "$AnubisMessage") i.r0'
      System::Call 'kernel32::WriteConsoleW(p $AnubisConsole, w "$AnubisMessage", i r0, *i .r1, p 0) i.r1'
      ${If} $1 == 0
        System::Alloc 4096
        Pop $2
        System::Call 'kernel32::WideCharToMultiByte(i 65001, i 0, w "$AnubisMessage", i -1, p r2, i 4096, p 0, p 0) i.r0'
        ${If} $0 > 0
          IntOp $0 $0 - 1
          System::Call 'kernel32::WriteFile(p $AnubisConsole, p r2, i r0, *i .r1, p 0)'
        ${EndIf}
        System::Free $2
      ${EndIf}
    ${EndIf}
  FunctionEnd

  Function AnubisFail
    Call AnubisPrint
    ${If} $AnubisConsoleMode == 0
      MessageBox MB_OK|MB_ICONSTOP "$AnubisMessage" /SD IDOK
    ${EndIf}
    Quit
  FunctionEnd

  !macro preInit
    SetSilent silent
    SetErrorLevel 1
    StrCpy $AnubisConsole 0
    StrCpy $AnubisConsoleMode 0
    ${GetParameters} $R0
    ClearErrors
    ${GetOptions} $R0 "--console" $R1
    ${IfNot} ${Errors}
      StrCpy $AnubisConsoleMode 1
      System::Call 'kernel32::GetStdHandle(i -11) p.s'
      Pop $AnubisConsole
      ${If} $AnubisConsole == 0
      ${OrIf} $AnubisConsole == -1
        System::Call 'kernel32::AttachConsole(i -1) i.r0'
        ${If} $0 == 0
          System::Call 'kernel32::AllocConsole()'
        ${EndIf}
        System::Call 'kernel32::GetStdHandle(i -11) p.s'
        Pop $AnubisConsole
      ${EndIf}
    ${EndIf}
    StrCpy $AnubisMessage "Anubis ${VERSION}: installer started with administrator approval."
    Call AnubisPrint
  !macroend

  !macro customInit
    ${If} ${isDeleteAppData}
      SetErrorLevel 87
      StrCpy $AnubisMessage "The installer does not accept --delete-app-data. User data must be preserved. Exit code: 87."
      Call AnubisFail
    ${EndIf}
    ${GetParameters} $R0
    StrCpy $AnubisAllowedUserSids ""
    ${GetOptions} $R0 "/ALLOWUSERSIDS=" $AnubisAllowedUserSids
    StrCpy $AnubisMigratePerUser "0"
    ClearErrors
    ${GetOptions} $R0 "/MIGRATEPERUSER" $R1
    ${IfNot} ${Errors}
      ${If} $R1 != ""
        SetErrorLevel 87
        StrCpy $AnubisMessage "Use the exact /MIGRATEPERUSER switch without a value. Exit code: 87."
        Call AnubisFail
      ${EndIf}
      StrCpy $AnubisMigratePerUser "1"
    ${EndIf}
    ClearErrors
    ${GetOptions} $R0 "/currentuser" $R1
    ${IfNot} ${Errors}
      SetErrorLevel 87
      StrCpy $AnubisMessage "This installer is machine-only. Per-user migration is not supported. Exit code: 87."
      Call AnubisFail
    ${EndIf}
    ReadRegStr $0 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
    ${If} $0 != ""
    ${AndIf} $AnubisMigratePerUser != "1"
      SetErrorLevel 87
      StrCpy $AnubisMessage "A per-user installation exists. Use explicit /MIGRATEPERUSER as its owning interactive account, or remove that application separately while retaining its data. Exit code: 87."
      Call AnubisFail
    ${EndIf}
    ReadRegStr $0 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
    ${If} $0 != ""
    ${AndIf} $0 != "$PROGRAMFILES64\${ANUBIS_MACHINE_LEAF}"
      SetErrorLevel 87
      StrCpy $AnubisMessage "Existing installation is not the canonical machine package. Automatic migration is refused. Exit code: 87."
      Call AnubisFail
    ${EndIf}
    !insertmacro GetDParameter $R0
    ${If} $R0 != ""
    ${AndIf} $R0 != "$PROGRAMFILES64\${ANUBIS_MACHINE_LEAF}"
      SetErrorLevel 87
      StrCpy $AnubisMessage "Custom installation paths are not supported by the protected machine host. Exit code: 87."
      Call AnubisFail
    ${EndIf}
    StrCpy $INSTDIR "$PROGRAMFILES64\${ANUBIS_MACHINE_LEAF}"
    !insertmacro AnubisMachineAction Prepare
    StrCpy $AnubisMessage "Selected scope: $installMode. Destination: $INSTDIR"
    Call AnubisPrint
  !macroend

  !macro AnubisCheckUninstallResult
    ${If} ${Errors}
      SetErrorLevel 2
      StrCpy $AnubisMessage "Could not start the previous uninstaller. Installation stopped. Exit code: 2."
      Call AnubisFail
    ${EndIf}
    ${If} $R0 != 0
      SetErrorLevel $R0
      StrCpy $AnubisMessage "The previous uninstaller failed. Installation stopped. Exit code: $R0."
      Call AnubisFail
    ${EndIf}
    StrCpy $AnubisMessage "Previous version check complete; extracting application files."
    Call AnubisPrint
  !macroend

  !macro customUnInstallCheck
    !insertmacro AnubisCheckUninstallResult
  !macroend

  !macro customUnInstallCheckCurrentUser
    !insertmacro AnubisCheckUninstallResult
  !macroend

  !macro AnubisCheckCopiedFiles
    ${If} ${Errors}
      SetErrorLevel 5
      StrCpy $AnubisMessage "Application extraction/copy failed. Installation is incomplete. Exit code: 5."
      Call AnubisFail
    ${EndIf}
    ; The normal electron-builder 7z path retains this staging directory.
    ; Its last-resort unchecked overwrite removes it: fail closed instead of
    ; reporting success after a failed copy or a locked previous executable.
    !insertmacro AnubisVerifyCopiedFile "${APP_EXECUTABLE_FILENAME}"
    !insertmacro AnubisVerifyCopiedFile "resources\app.asar"
    !insertmacro AnubisVerifyCopiedFile "anubis-host.exe"
    StrCpy $AnubisMessage "Application files verified; registering shortcuts and uninstall information."
    Call AnubisPrint
  !macroend

  !macro AnubisVerifyCopiedFile FILE
    ${IfNot} ${FileExists} "$PLUGINSDIR\7z-out\${FILE}"
    ${OrIfNot} ${FileExists} "$INSTDIR\${FILE}"
      SetErrorLevel 5
      StrCpy $AnubisMessage "Missing extracted ${FILE}. Installation is incomplete. Exit code: 5."
      Call AnubisFail
    ${EndIf}
    ${StdUtils.HashFile} $0 "SHA2-256" "$PLUGINSDIR\7z-out\${FILE}"
    ${StdUtils.HashFile} $1 "SHA2-256" "$INSTDIR\${FILE}"
    StrLen $2 $0
    ${If} $2 != 64
    ${OrIf} $0 != $1
      SetErrorLevel 5
      StrCpy $AnubisMessage "Cannot verify installed ${FILE}. Installation is incomplete. Exit code: 5."
      Call AnubisFail
    ${EndIf}
  !macroend

  !macro customFiles_x64
    !insertmacro AnubisCheckCopiedFiles
  !macroend
  !macro customFiles_ia32
    !insertmacro AnubisCheckCopiedFiles
  !macroend
  !macro customFiles_arm64
    !insertmacro AnubisCheckCopiedFiles
  !macroend

  !macro customInstall
    !ifndef ANUBIS_MACHINE_UNINSTALL_GUARDED
      !error "Machine setup must bypass user-writable legacy uninstallers before old-version removal."
    !endif
    ${IfNot} ${FileExists} "$INSTDIR\${UNINSTALL_FILENAME}"
      SetErrorLevel 5
      StrCpy $AnubisMessage "The installed uninstaller is missing. Installation is incomplete. Exit code: 5."
      Call AnubisFail
    ${EndIf}
    ClearErrors
    ReadRegStr $0 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallLocation
    ${If} ${Errors}
    ${OrIf} $0 != $INSTDIR
      SetErrorLevel 5
      StrCpy $AnubisMessage "Installation registration failed. Exit code: 5."
      Call AnubisFail
    ${EndIf}
    !insertmacro AnubisMachineAction Finish
    StrCpy $AnubisMessage "SYSTEM machine engine is ready. User settings and credentials were preserved."
    Call AnubisPrint
  !macroend

  Function .onInstSuccess
    SetErrorLevel 0
    StrCpy $AnubisMessage "Anubis installation complete. Exit code: 0."
    Call AnubisPrint
  FunctionEnd

  Function .onInstFailed
    SetErrorLevel 1
    StrCpy $AnubisMessage "Anubis installation failed. Exit code: 1."
    Call AnubisFail
  FunctionEnd
!endif

!ifdef BUILD_UNINSTALLER
  !macro customUnInit
    ${GetParameters} $R0
    ClearErrors
    ${GetOptions} $R0 "--delete-app-data" $R1
    ${IfNot} ${Errors}
      SetErrorLevel 87
      MessageBox MB_OK|MB_ICONSTOP "Data deletion is not supported. Uninstall stopped; profiles and host data were retained." /SD IDOK
      Quit
    ${EndIf}
  !macroend
  !macro customUnInstall
    ${IfNot} ${isUpdated}
      !insertmacro AnubisMachineAction Remove
    ${EndIf}
  !macroend
  !macro customRemoveFiles
    ${If} ${isUpdated}
      ; Keep the protected root/ACL while upstream atomically moves old files.
      CreateDirectory "$PLUGINSDIR\old-install"
      Push ""
      Call un.atomicRMDir
      Pop $R0
      ${If} $R0 != 0
        Push ""
        Call un.restoreFiles
        Pop $R0
        SetErrorLevel 5
        Abort "Could not remove the old protected package; update stopped."
      ${EndIf}
    ${Else}
      SetOutPath $TEMP
      RMDir /r "$INSTDIR"
      ${If} ${FileExists} "$INSTDIR\*.*"
        SetErrorLevel 5
        Abort "Could not remove the protected package. Host data was retained."
      ${EndIf}
    ${EndIf}
  !macroend
!endif

; Never use upstream's force-close behavior (including during old-version
; removal). A same-name process in another session may conservatively block us,
; but is never terminated. The updater receives time to close normally.
!macro customCheckAppRunning
  !ifndef BUILD_UNINSTALLER
    !ifmacrodef uninstallOldVersion
      !include "${ANUBIS_MACHINE_SUPPORT}\windows-machine-uninstall-guard.nsh"
    !endif
  !endif
  ; Stop only the native helper's verified service/jobs before checking for GUI
  ; processes. Otherwise its headless anubis.exe would block every update.
  !insertmacro AnubisMachineAction Stop
  !ifdef BUILD_UNINSTALLER
    nsProcess::_FindProcess "${APP_EXECUTABLE_FILENAME}"
    Pop $R0
    ${If} $R0 == 0
      SetErrorLevel 1618
      MessageBox MB_OK|MB_ICONSTOP "Anubis is running. Close it normally before uninstalling. Exit code: 1618." /SD IDOK
      Quit
    ${EndIf}
    ${If} $R0 != 603
      SetErrorLevel 5
      MessageBox MB_OK|MB_ICONSTOP "Cannot inspect running application processes. Uninstallation stopped. Exit code: 5." /SD IDOK
      Quit
    ${EndIf}
  !else
    StrCpy $AnubisMessage "Waiting up to 60 seconds for Anubis to exit normally; no sessions will be terminated."
    Call AnubisPrint
    StrCpy $R2 120
    ${Do}
      nsProcess::_FindProcess "${APP_EXECUTABLE_FILENAME}"
      Pop $R0
      ${If} $R0 == 603
        ${Break}
      ${EndIf}
      ${If} $R0 != 0
        SetErrorLevel 5
        StrCpy $AnubisMessage "Cannot inspect running application processes. Exit code: 5."
        Call AnubisFail
      ${EndIf}
      ${If} $R2 == 0
        SetErrorLevel 1618
        StrCpy $AnubisMessage "Anubis is still running. Close it normally and retry setup. No sessions were terminated. Exit code: 1618."
        Call AnubisFail
      ${EndIf}
      Sleep 500
      IntOp $R2 $R2 - 1
    ${Loop}
    ClearErrors
  !endif
!macroend
