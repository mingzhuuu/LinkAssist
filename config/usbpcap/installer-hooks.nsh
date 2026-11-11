; USBPcap remains a separately licensed, independently signed system component.
; Never silently install a USB filter or reboot the user's computer.
!macro NSIS_HOOK_POSTINSTALL
  ; Keep the installer optional and silent-install safe. Existing installations
  ; belong to the user/Wireshark; LinkAssist never upgrades or removes them.
  IfSilent usbpcap_done
  Push $R0
  SetRegView 64
  ReadRegStr $R0 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\USBPcap" "UninstallString"
  StrCmp $R0 "" 0 usbpcap_existing64
  ReadRegStr $R0 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\USBPcap" "InstallLocation"
  StrCmp $R0 "" 0 usbpcap_existing64
  SetRegView 32
  ReadRegStr $R0 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\USBPcap" "UninstallString"
  StrCmp $R0 "" 0 usbpcap_existing32
  ReadRegStr $R0 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\USBPcap" "InstallLocation"
  StrCmp $R0 "" 0 usbpcap_existing32
  ReadRegStr $R0 HKLM "SYSTEM\CurrentControlSet\Services\USBPcap" "ImagePath"
  StrCmp $R0 "" 0 usbpcap_existing32
  IfFileExists "$PROGRAMFILES64\USBPcap\USBPcapCMD.exe" usbpcap_existing32
  IfFileExists "$PROGRAMFILES32\USBPcap\USBPcapCMD.exe" usbpcap_existing32
  IfFileExists "$PROGRAMFILES64\Wireshark\extcap\USBPcapCMD.exe" usbpcap_existing32
  IfFileExists "$PROGRAMFILES32\Wireshark\extcap\USBPcapCMD.exe" usbpcap_existing32
  MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "Optional USB serial monitoring requires USBPcap. Open its official installation page? Normal serial communication works without it. Administrator approval and a restart may be required." IDNO usbpcap_restore
  ExecShell "open" "https://desowin.org/usbpcap/"
  Goto usbpcap_restore
  usbpcap_existing64:
  SetRegView 32
  usbpcap_existing32:
  DetailPrint "Existing USBPcap components detected; keeping them. LinkAssist will check capture readiness when monitoring is selected."
  usbpcap_restore:
  ; Tauri's Windows installer uses the target architecture's registry view.
  !if "${ARCH}" == "x64"
    SetRegView 64
  !else if "${ARCH}" == "arm64"
    SetRegView 64
  !else
    SetRegView 32
  !endif
  Pop $R0
  usbpcap_done:
!macroend
