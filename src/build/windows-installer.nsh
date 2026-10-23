; The app remains asInvoker. Only the installer requests elevation, before
; Start-Process returns to the updater; cancelling UAC never creates a process.
!include "LogicLib.nsh"
!include "FileFunc.nsh"

!macro customHeader
  !ifndef BUILD_UNINSTALLER
    RequestExecutionLevel admin
    SilentInstall silent
  !endif
!macroend

!ifndef BUILD_UNINSTALLER
  Var AnubisConsole
  Var AnubisConsoleMode
  Var AnubisMessage

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
      MessageBox MB_OK|MB_ICONSTOP "$AnubisMessage"
    ${EndIf}
    Quit
  FunctionEnd

  ; Compare the elevated token with Explorer's token. An over-the-shoulder UAC
  ; login changes HKCU and known folders: never silently upgrade that profile.
  Function AnubisCheckInstallIdentity
    System::Call 'user32::GetShellWindow() p.r0'
    ${If} $0 == 0
      Return
    ${EndIf}
    System::Call 'user32::GetWindowThreadProcessId(p r0, *i .r1)'
    System::Call 'kernel32::OpenProcess(i 0x1000, i 0, i r1) p.r2'
    StrCpy $3 0
    System::Call 'advapi32::OpenProcessToken(p r2, i 8, *p .r3) i.r0'
    System::Call 'kernel32::CloseHandle(p r2)'
    ${If} $0 == 0
      Goto identity_unknown
    ${EndIf}
    System::Alloc 512
    Pop $4
    System::Call 'advapi32::GetTokenInformation(p r3, i 1, p r4, i 512, *i .r5) i.r0'
    System::Call 'kernel32::CloseHandle(p r3)'
    ${If} $0 == 0
      System::Free $4
      Goto identity_unknown
    ${EndIf}
    System::Call '*$4(p .r6)'
    System::Call 'kernel32::GetCurrentProcess() p.r2'
    System::Call 'advapi32::OpenProcessToken(p r2, i 8, *p .r3) i.r0'
    ${If} $0 == 0
      System::Free $4
      Goto identity_unknown
    ${EndIf}
    System::Alloc 512
    Pop $7
    System::Call 'advapi32::GetTokenInformation(p r3, i 1, p r7, i 512, *i .r5) i.r0'
    System::Call 'kernel32::CloseHandle(p r3)'
    ${If} $0 == 0
      System::Free $4
      System::Free $7
      Goto identity_unknown
    ${EndIf}
    System::Call '*$7(p .r8)'
    System::Call 'advapi32::EqualSid(p r6, p r8) i.r0'
    System::Free $4
    System::Free $7
    ${If} $0 == 0
      SetErrorLevel 1307
      StrCpy $AnubisMessage "Installation refused: UAC used another account. Run setup as the signed-in installation owner; no profile or install-scope migration was performed. Exit code: 1307."
      Call AnubisFail
    ${EndIf}
    Return
    identity_unknown:
      SetErrorLevel 5
      StrCpy $AnubisMessage "Cannot verify the installation owner's Windows token. Installation stopped without changing the existing installation. Exit code: 5."
      Call AnubisFail
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
    Call AnubisCheckInstallIdentity
  !macroend

  !macro customInit
    ; initMultiUser selected the previous scope/path. The upstream silent
    ; section otherwise switches to HKLM merely because *any* HKLM install exists.
    ${If} $installMode == "CurrentUser"
      StrCpy $hasPerMachineInstallation "0"
    ${EndIf}
    ${If} ${isDeleteAppData}
      SetErrorLevel 87
      StrCpy $AnubisMessage "The installer does not accept --delete-app-data. User data must be preserved. Exit code: 87."
      Call AnubisFail
    ${EndIf}
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
    StrCpy $AnubisMessage "Installation configuration complete. User settings and credentials were preserved."
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

; Never use upstream's force-close behavior (including during old-version
; removal). A same-name process in another session may conservatively block us,
; but is never terminated. The updater receives time to close normally.
!macro customCheckAppRunning
  !ifdef BUILD_UNINSTALLER
    nsProcess::_FindProcess "${APP_EXECUTABLE_FILENAME}"
    Pop $R0
    ${If} $R0 == 0
      SetErrorLevel 1618
      MessageBox MB_OK|MB_ICONSTOP "Anubis is running. Close it normally before uninstalling. Exit code: 1618."
      Quit
    ${EndIf}
    ${If} $R0 != 603
      SetErrorLevel 5
      MessageBox MB_OK|MB_ICONSTOP "Cannot inspect running application processes. Uninstallation stopped. Exit code: 5."
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
