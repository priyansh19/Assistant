; Included by electron-builder's NSIS installer (resources/ is buildResources).
;
; Upgrades: installing a new build removes the old program files but always keeps the user's
; settings, keys, history and models in %APPDATA%\Clicky (deleteAppDataOnUninstall: false).
;
; Uninstall from Windows Settings: ask whether to delete that data too. Never asked during an
; upgrade (the old uninstaller runs with --updated) or a silent uninstall.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    IfSilent clicky_keep_data
    MessageBox MB_YESNO|MB_ICONQUESTION "Also delete your Clicky settings, history, playbooks, downloaded voices and saved keys?$\r$\n$\r$\nChoose No to keep them for next time." /SD IDNO IDNO clicky_keep_data
    RMDir /r "$APPDATA\Clicky"
    clicky_keep_data:
  ${endIf}
!macroend
