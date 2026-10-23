!ifndef ANUBIS_MACHINE_UNINSTALL_GUARDED
!define ANUBIS_MACHINE_UNINSTALL_GUARDED
!macroundef uninstallOldVersion
; The upstream registry-command launcher is deliberately unreachable.
!pragma warning disable 6010
!macro uninstallOldVersion ROOT_KEY
  !if "${ROOT_KEY}" == "HKEY_CURRENT_USER"
    ; User-writable uninstall commands must never run under setup's admin token.
    ClearErrors
    StrCpy $R0 0
  !else if "${ROOT_KEY}" == "SHELL_CONTEXT"
    ClearErrors
    StrCpy $R0 0
    ${If} ${FileExists} "$INSTDIR\anubis-machine-install.json"
      !insertmacro AnubisMachineAction UninstallPrevious
    ${EndIf}
  !else
    !error "Unexpected old-uninstaller registry scope."
  !endif
!macroend
!endif
