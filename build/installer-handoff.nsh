!include "LogicLib.nsh"
!include "FileFunc.nsh"

Var dshHandoffPid
Var dshHandoffContinuation
Var dshHandoffArgs
Var dshHandoffToken

Function DshHandoffLog
  Exch $0
  Push $1
  Push $2
  ClearErrors
  FileOpen $1 "$EXEDIR\handoff-$dshHandoffPid.log" a
  IfErrors logDone
  FileSeek $1 0 END $2
  StrCmp $2 -1 logClose
  FileWrite $1 "$0$\r$\n"
  logClose:
  FileClose $1
  logDone:
  ClearErrors
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

Function DshHandoffInit
  StrCpy $dshHandoffPid ""
  StrCpy $dshHandoffContinuation ""
  StrCpy $dshHandoffArgs ""
  StrCpy $R0 0 ; Explicit handoff switch seen
  StrCpy $R1 0 ; Expected position in the handoff command
  StrCpy $R2 0 ; Cache-root marker
  StrCpy $R4 0
  ${If} ${UAC_IsInnerInstance}
    StrCpy $R4 2
  ${EndIf}

  System::Call 'kernel32::GetCommandLineW() p.r0'
  System::Call 'shell32::CommandLineToArgvW(p r0, *i .r1) p.r2'
  StrCmp $2 0 invalidHandoff
  StrCpy $R3 $2

  ; /D= consumes the rest of the raw command line, including spaces.
  nextOption:
  IntOp $1 $1 - 1
  IntCmp $1 0 parsed
  IntOp $2 $2 + ${NSIS_PTR_SIZE}
  System::Call '*$2(p .r3)'
  System::Call 'kernel32::lstrcpynW(w .r4, p r3, i ${NSIS_MAX_STRLEN}) p'
  ; UAC prepends these switches when the template starts the elevated copy.
  StrCmp $R4 2 0 checkUacCrc
  StrCpy $5 $4 5
  StrCpy $R4 1
  StrCmpS $5 "/UAC:" nextOption unexpectedOption
  checkUacCrc:
  StrCmp $R4 1 0 checkOption
  StrCpy $R4 0
  StrCmpS $4 "/NCRC" nextOption unexpectedOption
  checkOption:
  StrCpy $5 $4 3
  StrCmp $5 "/D=" installDirectory
  StrCpy $5 $4 14
  StrCmp $4 "--dsh-handoff" handoffOption
  StrCmp $5 "--dsh-handoff=" handoffOption
  StrCmpS $4 "/S" silentOption
  StrCpy $5 $4 15
  StrCmpS $5 "--dsh-continue=" continuationOption
  StrCmpS $4 "--dsh-use-cache-root=1" cacheRootOption
  Goto unexpectedOption

  silentOption:
  StrCmp $R1 0 0 unexpectedOption
  StrCpy $R1 1
  Goto nextOption

  handoffOption:
  StrCpy $R0 1
  StrCmp $R1 1 0 unexpectedOption
  StrCmpS $5 "--dsh-handoff=" 0 unexpectedOption
  StrCpy $dshHandoffPid $4 "" 14
  StrCpy $R1 2
  Goto nextOption

  continuationOption:
  StrCmp $R1 2 0 unexpectedOption
  StrCpy $dshHandoffContinuation $4 "" 15
  StrCmp $dshHandoffContinuation "" unexpectedOption
  StrCpy $R1 3
  Goto nextOption

  cacheRootOption:
  StrCmp $R1 2 setCacheRoot
  StrCmp $R1 3 0 unexpectedOption
  setCacheRoot:
  StrCpy $R2 1
  StrCpy $R1 4
  Goto nextOption

  unexpectedOption:
  StrCpy $R1 -1
  Goto nextOption

  installDirectory:
  StrCmp $R1 2 pathOption
  StrCmp $R1 3 pathOption
  StrCmp $R1 4 0 parsed
  pathOption:
  StrCmpS $5 "/D=" 0 parsed
  StrCpy $5 $4 2 3
  StrCmp $5 "\\" validPathOption
  StrCpy $5 $4 2 4
  StrCmp $5 ":\" 0 parsed
  validPathOption:
  StrCpy $R1 5

  parsed:
  System::Call 'kernel32::LocalFree(p R3) p'
  StrCmp $R0 1 0 done
  StrCmp $R1 5 0 invalidHandoff
  IfSilent 0 invalidHandoff
  ${StdUtils.GetAllParameters} $0 "0"
  StrCmp $0 "too_long" invalidHandoff
  System::Call 'shlwapi::PathIsRelativeW(w "$INSTDIR") i.r0'
  StrCmp $0 0 0 invalidHandoff

  StrLen $0 $dshHandoffPid
  IntCmp $0 0 invalidHandoff invalidHandoff
  IntCmp $0 10 0 0 invalidHandoff
  StrCpy $1 $dshHandoffPid 1
  StrCmp $1 0 invalidHandoff
  StrCpy $1 0
  pidDigit:
  StrCpy $2 $dshHandoffPid 1 $1
  StrCmp $2 "" pidRange
  StrCmp $2 0 nextPidDigit
  StrCmp $2 1 nextPidDigit
  StrCmp $2 2 nextPidDigit
  StrCmp $2 3 nextPidDigit
  StrCmp $2 4 nextPidDigit
  StrCmp $2 5 nextPidDigit
  StrCmp $2 6 nextPidDigit
  StrCmp $2 7 nextPidDigit
  StrCmp $2 8 nextPidDigit
  StrCmp $2 9 nextPidDigit invalidHandoff
  nextPidDigit:
  IntOp $1 $1 + 1
  Goto pidDigit
  pidRange:
  System::Int64Op $dshHandoffPid > 4294967295
  Pop $0
  StrCmp $0 0 0 invalidHandoff

  StrCpy $dshHandoffArgs "--adopt-running-packs"
  StrCmp $dshHandoffContinuation "" cacheRoot
  StrLen $0 $dshHandoffContinuation
  StrCmp $0 36 0 invalidHandoff
  StrCpy $1 0
  uuidChar:
  StrCpy $2 $dshHandoffContinuation 1 $1
  StrCmp $2 "" uuidValid
  StrCmp $1 8 uuidHyphen
  StrCmp $1 13 uuidHyphen
  StrCmp $1 18 uuidHyphen
  StrCmp $1 23 uuidHyphen
  StrCmp $1 14 uuidVersion
  StrCmp $1 19 uuidVariant
  StrCpy $3 "0123456789abcdef"
  Goto uuidAllowedChar
  uuidHyphen:
  StrCpy $3 "-"
  Goto uuidAllowedChar
  uuidVersion:
  StrCpy $3 "4"
  Goto uuidAllowedChar
  uuidVariant:
  StrCpy $3 "89ab"
  uuidAllowedChar:
  StrCpy $4 0
  matchChar:
  StrCpy $5 $3 1 $4
  StrCmp $5 "" invalidHandoff
  StrCmpS $5 $2 nextUuidChar
  IntOp $4 $4 + 1
  Goto matchChar
  nextUuidChar:
  IntOp $1 $1 + 1
  Goto uuidChar
  uuidValid:
  StrCpy $dshHandoffArgs "$dshHandoffArgs --update-continuation=$dshHandoffContinuation"

  cacheRoot:
  StrCmp $R2 1 0 waitForLauncher
  ${GetParent} $EXEDIR $0
  StrCmp $0 "" invalidHandoff
  StrCpy $1 $0 1 -1
  StrCmp $1 ":" 0 +2
  StrCpy $0 "$0\"
  StrCpy $1 $0 1 -1
  StrCmp $1 "\" 0 +2
  StrCpy $0 "$0\"
  StrLen $1 $0
  StrLen $2 $dshHandoffArgs
  IntOp $1 $1 + $2
  IntOp $1 $1 + 14 ; Space, quotes, and --data-dir=
  IntCmp $1 ${NSIS_MAX_STRLEN} invalidHandoff 0 invalidHandoff
  StrCpy $dshHandoffArgs '$dshHandoffArgs "--data-dir=$0"'

  waitForLauncher:
  StrLen $0 "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  StrLen $1 $dshHandoffArgs
  IntOp $0 $0 + $1
  IntOp $0 $0 + 3
  IntCmp $0 ${NSIS_MAX_STRLEN} invalidHandoff 0 invalidHandoff
  Push "waiting-for-old-launcher"
  Call DshHandoffLog
  ; ?e captures the native error before NSIS runs another instruction.
  System::Call 'kernel32::OpenProcess(i 0x00100000, i 0, i "$dshHandoffPid") p.r0 ?e'
  Pop $1
  StrCmp $0 0 openFailed
  System::Call 'kernel32::WaitForSingleObject(p r0, i 60000) i.r2 ?e'
  Pop $3
  System::Call 'kernel32::CloseHandle(p r0) i.r4 ?e'
  Pop $5
  StrCmp $4 0 0 waitResult
  Push "close-handle-failed error=$5"
  Goto waitFailed
  waitResult:
  StrCmp $2 0 launcherExited
  StrCmp $2 258 0 +3
  Push "wait-timeout"
  Goto waitFailed
  Push "wait-failed result=$2 error=$3"
  Goto waitFailed

  openFailed:
  ; ERROR_INVALID_PARAMETER means no process for the validated nonzero PID.
  StrCmp $1 87 0 +3
  Push "old-launcher-already-absent"
  Goto waitPassed
  Push "open-process-failed error=$1"
  Goto waitFailed
  launcherExited:
  Push "old-launcher-exited"
  waitPassed:
  Call DshHandoffLog
  Call DshHandoffPrepareRelaunch
  Return

  waitFailed:
  Call DshHandoffLog
  invalidHandoff:
  DetailPrint "Invalid or unsuccessful launcher update handoff."
  SetErrorLevel 2
  Quit

  done:
FunctionEnd

Function DshHandoffPrepareRelaunch
  StrCpy $dshHandoffToken 0
  ${If} ${UAC_IsAdmin}
    ; The desktop shell still runs as the interactive user after UAC starts Setup.
    System::Call 'user32::GetShellWindow() p.r0'
    StrCmp $0 0 tokenFailed
    System::Call 'user32::GetWindowThreadProcessId(p r0, *i .r1) i.r0'
    StrCmp $0 0 tokenFailed
    System::Call 'kernel32::OpenProcess(i 0x1000, i 0, i r1) p.r0'
    StrCmp $0 0 tokenFailed
    System::Call 'advapi32::OpenProcessToken(p r0, i 0xA, *p .r1) i.r2'
    System::Call 'kernel32::CloseHandle(p r0)'
    StrCmp $2 0 tokenFailed
    System::Call 'advapi32::GetTokenInformation(p r1, i 20, *i .r0, i 4, *i .r2) i.r3'
    StrCmp $3 0 closeShellToken
    StrCmp $0 0 0 closeShellToken
    System::Call 'advapi32::DuplicateTokenEx(p r1, i 0xB, p 0, i 2, i 1, *p .r2) i.r3'
    StrCmp $3 0 closeShellToken
    StrCpy $dshHandoffToken $2
    closeShellToken:
    System::Call 'kernel32::CloseHandle(p r1)'
    StrCmp $dshHandoffToken 0 tokenFailed
  ${EndIf}
  Return

  tokenFailed:
  Push "interactive-token-unavailable"
  Call DshHandoffLog
  SetErrorLevel 2
  Quit
FunctionEnd

Function DshHandoffRelaunch
  StrCpy $0 "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  StrCpy $1 '"$0" $dshHandoffArgs'
  StrCmp $dshHandoffToken 0 launchUnprivileged

  ; STARTUPINFOW and PROCESS_INFORMATION for the x86 NSIS process.
  System::Call 'kernel32::GlobalAlloc(i 0x40, p 68) p.r2'
  System::Call 'kernel32::GlobalAlloc(i 0x40, p 16) p.r3'
  StrCpy $5 "allocate-failed"
  StrCmp $2 0 cleanupLaunch
  StrCmp $3 0 cleanupLaunch
  System::Call '*$2(i 68)'
  System::Call 'advapi32::CreateProcessWithTokenW(p "$dshHandoffToken", i 0, w r0, w r1, i 0, p 0, w "$INSTDIR", p r2, p r3) i.r4 ?e'
  Pop $5
  StrCmp $4 0 cleanupLaunch
  System::Call '*$3(p .r0, p .r1)'
  System::Call 'kernel32::CloseHandle(p r0)'
  System::Call 'kernel32::CloseHandle(p r1)'
  StrCpy $5 "ok"
  cleanupLaunch:
  System::Call 'kernel32::GlobalFree(p r2) p'
  System::Call 'kernel32::GlobalFree(p r3) p'
  System::Call 'kernel32::CloseHandle(p "$dshHandoffToken")'
  Goto launchResult

  launchUnprivileged:
  StrCpy $5 "exec-failed"
  ClearErrors
  Exec $1
  IfErrors launchResult
  StrCpy $5 "ok"

  launchResult:
  Push "relaunch-$5"
  Call DshHandoffLog
  StrCmp $5 "ok" launchDone
  SetErrorLevel 2
  Quit
  launchDone:
FunctionEnd
