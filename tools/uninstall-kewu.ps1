
# DSH Launcher 卸载脚本（KEWU）
#
# 用户核心原则：只删掉「装上这个软件之后新增的内容」，之前的都不要动。
#   · 删除：启动器 EXE、EXE 旁边的 launcher-data（本版数据）、launcher-storage.json 指针文件、
#           HKCU Run 里的自启项、%TEMP% 里的 3L* 自解压残留，以及只装了启动器的安装目录。
#   · 保留：%APPDATA%\dsh-launcher（旧版启动器数据）与用户目录下的 .dsh（DSH 家目录），永不删除。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File uninstall-kewu.ps1 -ExePath "<启动器 EXE>"
#     可选：-DataDir "<本版数据目录>"  -WaitPid <进程号>  -DeleteData  -DryRun  -Yes  -LogPath "<日志文件>"
param(
  [string]$ExePath = '',
  [string]$DataDir = '',
  [int]$WaitPid = 0,
  [switch]$DeleteData,
  [switch]$DryRun,
  [switch]$Yes,
  [string]$LogPath = ''
)

$ErrorActionPreference = 'Stop'
# 控制台按 UTF-8 输出：源码是 UTF-8，中文在 GBK 代码页的窗口里才不会变乱码。
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$script:logLines = New-Object System.Collections.Generic.List[string]
$script:warnings = New-Object System.Collections.Generic.List[string]
$script:failures = New-Object System.Collections.Generic.List[string]
$script:startedAt = Get-Date

function Write-Usage {
  Write-Host 'DSH Launcher 卸载脚本（KEWU）'
  Write-Host ''
  Write-Host '用法：'
  Write-Host '  powershell -NoProfile -ExecutionPolicy Bypass -File uninstall-kewu.ps1 -ExePath "<启动器 EXE 的完整路径>"'
  Write-Host '    可选：-DataDir "<本版数据目录>"  -WaitPid <要等待退出的进程号>  -DeleteData  -DryRun  -Yes  -LogPath "<日志文件>"'
  Write-Host ''
  Write-Host '说明：'
  Write-Host '  · -DryRun 只打印计划，不删除任何内容。'
  Write-Host '  · -DeleteData 才会删除本版数据目录（launcher-data）；不给就只删程序、保留数据。'
  Write-Host '  · %APPDATA%\dsh-launcher（旧版启动器数据）与用户目录下的 .dsh（DSH 家目录）永不删除。'
  Write-Host '  · -Yes 跳过交互确认；没有 -Yes 时会先问一次。'
  Write-Host '  · -WaitPid 会先等那个进程退出（最多 120 秒）再删，用于内置卸载。'
  Write-Host ''
  Write-Host '退出码：0 = 完成或预览成功；1 = 缺少参数、删除失败或等待超时。'
}

function Write-Line([string]$text) {
  Write-Host $text
  $script:logLines.Add($text)
}

function Save-Log {
  if (-not $script:logPath) { return }
  try {
    $header = '# DSH Launcher 卸载日志 ' + $script:startedAt.ToString('yyyy-MM-dd HH:mm:ss')
    Set-Content -LiteralPath $script:logPath -Value (@($header) + $script:logLines) -Encoding UTF8
  } catch {
    Write-Host ('警告：日志写入失败：' + $_.Exception.Message)
  }
}

function Resolve-FullPath([string]$value) {
  $full = [System.IO.Path]::GetFullPath($value)
  while ($full.Length -gt 3 -and $full.EndsWith('\')) { $full = $full.Substring(0, $full.Length - 1) }
  return $full
}

function Test-SamePath([string]$left, [string]$right) {
  if (-not $left -or -not $right) { return $false }
  return ($left.TrimEnd('\').ToLowerInvariant() -eq $right.TrimEnd('\').ToLowerInvariant())
}

function Test-ParentOf([string]$parent, [string]$child) {
  if (-not $parent -or -not $child) { return $false }
  $prefix = $parent.TrimEnd('\').ToLowerInvariant() + '\'
  return $child.TrimEnd('\').ToLowerInvariant().StartsWith($prefix)
}

function Test-InUse([string]$target) {
  # 有进程正住在目录里（例如另一个便携版启动器实例）时不能删：删了那个实例随时会崩。
  try {
    foreach ($process in Get-Process -ErrorAction SilentlyContinue) {
      $path = $null
      try { $path = $process.Path } catch { $path = $null }
      if (-not $path) { continue }
      if ((Test-SamePath $path $target) -or (Test-ParentOf $target $path)) { return $true }
    }
  } catch {
    return $false
  }
  return $false
}

function Get-TreeSize([string]$target) {
  if (-not $target -or -not (Test-Path -LiteralPath $target)) { return [int64]0 }
  try {
    $item = Get-Item -LiteralPath $target -Force -ErrorAction Stop
    if (-not $item.PSIsContainer) { return [int64]$item.Length }
    $sum = (Get-ChildItem -LiteralPath $target -Recurse -Force -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
    if (-not $sum) { return [int64]0 }
    return [int64]$sum
  } catch {
    return [int64]0
  }
}

function Format-Size([int64]$bytes) {
  if ($bytes -ge 1073741824) { return ('{0:N1} GB' -f ($bytes / 1073741824.0)) }
  if ($bytes -ge 1048576) { return ('{0:N1} MB' -f ($bytes / 1048576.0)) }
  if ($bytes -ge 1024) { return ('{0:N1} KB' -f ($bytes / 1024.0)) }
  return ($bytes.ToString() + ' B')
}

function Assert-SafeTarget([string]$target) {
  if (-not $target) { throw '目标路径为空。' }
  $full = Resolve-FullPath $target
  if ($full -match '^[A-Za-z]:$') { throw ('拒绝删除驱动器根目录：' + $full) }
  if ($full.Length -le 3) { throw ('拒绝删除过短的路径：' + $full) }
  if (Test-SamePath $full $script:legacyDataDir) { throw ('拒绝删除旧版启动器数据：' + $full) }
  if (Test-SamePath $full $script:dshHome) { throw ('拒绝删除 DSH 家目录：' + $full) }
  if ($env:USERPROFILE -and (Test-SamePath $full $env:USERPROFILE)) { throw ('拒绝删除用户主目录：' + $full) }
  if ($env:APPDATA -and (Test-SamePath $full $env:APPDATA)) { throw ('拒绝删除 AppData 目录：' + $full) }
  if ($env:LOCALAPPDATA -and (Test-SamePath $full $env:LOCALAPPDATA)) { throw ('拒绝删除 LocalAppData 目录：' + $full) }
  if ((Test-ParentOf $full $script:legacyDataDir) -or (Test-ParentOf $full $script:dshHome)) { throw ('拒绝删除装着旧版数据或 DSH 家目录的上级目录：' + $full) }
}

function Remove-Target([string]$target, [string]$label) {
  if (-not (Test-Path -LiteralPath $target)) {
    Write-Line ('跳过（不存在）：' + $label + ' -> ' + $target)
    return
  }
  try {
    Assert-SafeTarget $target
    $item = Get-Item -LiteralPath $target -Force -ErrorAction Stop
    if ($item.PSIsContainer) {
      Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction Stop
    } else {
      Remove-Item -LiteralPath $target -Force -ErrorAction Stop
    }
    Write-Line ('已删除：' + $label + ' -> ' + $target)
  } catch {
    $message = $label + ' 删除失败：' + $_.Exception.Message
    $script:failures.Add($message)
    $script:warnings.Add($message)
    Write-Line ('删除失败（这一项跳过，其余继续）：' + $label + ' -> ' + $target)
    Write-Line ('  原因：' + $_.Exception.Message)
  }
}

if (-not $ExePath) {
  Write-Usage
  exit 1
}

$script:legacyDataDir = Resolve-FullPath (Join-Path $env:APPDATA 'dsh-launcher')
$script:dshHome = Resolve-FullPath (Join-Path $env:USERPROFILE '.dsh')
$script:logPath = $LogPath
if (-not $script:logPath) { $script:logPath = Join-Path $PSScriptRoot 'uninstall-log.txt' }
$exe = Resolve-FullPath $ExePath
$exeDir = Split-Path -Parent $exe
if (-not $DataDir) { $DataDir = Join-Path $exeDir 'launcher-data' }
$dataDir = Resolve-FullPath $DataDir
$pointerFile = Join-Path $exeDir 'launcher-storage.json'
$dataIsLegacy = Test-SamePath $dataDir $script:legacyDataDir

Write-Line ('DSH Launcher 卸载脚本（KEWU）  ' + (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'))
Write-Line ('启动器 EXE：' + $exe)
Write-Line ('本版数据目录：' + $dataDir)
Write-Line ''

# 计划：只有 delete 列表里的东西会被删；keep 列表只是打出来让人看清保留了哪些。
$deleteSteps = New-Object System.Collections.Generic.List[object]
$keepSteps = New-Object System.Collections.Generic.List[object]

[void]$deleteSteps.Add([pscustomobject]@{ Label = '启动器主程序'; Path = $exe; Kind = 'file' })
if (Test-Path -LiteralPath $pointerFile) {
  [void]$deleteSteps.Add([pscustomobject]@{ Label = '数据目录指针文件'; Path = $pointerFile; Kind = 'file' })
}
if ($dataIsLegacy) {
  [void]$keepSteps.Add([pscustomobject]@{ Label = '启动器数据目录（旧版）'; Path = $dataDir; Reason = '这是旧版启动器数据，按规则保留' })
} elseif ($DeleteData) {
  [void]$deleteSteps.Add([pscustomobject]@{ Label = '本版数据目录'; Path = $dataDir; Kind = 'directory' })
} else {
  [void]$keepSteps.Add([pscustomobject]@{ Label = '本版数据目录'; Path = $dataDir; Reason = '本次没有指定 -DeleteData，只删程序、保留数据' })
}
if (-not $dataIsLegacy) {
  [void]$keepSteps.Add([pscustomobject]@{ Label = '旧版启动器数据'; Path = $script:legacyDataDir; Reason = '这是旧版启动器数据，按规则保留' })
}
[void]$keepSteps.Add([pscustomobject]@{ Label = 'DSH 家目录'; Path = $script:dshHome; Reason = '这是 DSH 的家目录（会话、配置与运行时都在里面），按规则保留' })

$tempResidues = @()
if ($env:TEMP -and (Test-Path -LiteralPath $env:TEMP)) {
  $tempResidues = @(Get-ChildItem -LiteralPath $env:TEMP -Filter '3L*' -Force -ErrorAction SilentlyContinue)
}
foreach ($residue in $tempResidues) {
  if (Test-InUse $residue.FullName) {
    [void]$keepSteps.Add([pscustomobject]@{ Label = '便携版自解压残留'; Path = $residue.FullName; Reason = '有进程正从这个目录运行（可能是另一个启动器实例），跳过删除' })
    continue
  }
  [void]$deleteSteps.Add([pscustomobject]@{ Label = '便携版自解压残留'; Path = $residue.FullName; Kind = 'directory' })
}
if ($tempResidues.Count -gt 0) {
  $script:warnings.Add('自解压残留可能正被占用：删不掉只会记进告警，不影响其余步骤。')
}

$ownedNames = New-Object System.Collections.Generic.List[string]
$ownedNames.Add([System.IO.Path]::GetFileName($exe).ToLowerInvariant())
$ownedNames.Add('launcher-storage.json')
$ownedNames.Add('launcher-data')
if (Test-SamePath (Split-Path -Parent $dataDir) $exeDir) { $ownedNames.Add([System.IO.Path]::GetFileName($dataDir).ToLowerInvariant()) }
$foreign = @()
if (Test-Path -LiteralPath $exeDir) {
  $foreign = @(Get-ChildItem -LiteralPath $exeDir -Force -ErrorAction SilentlyContinue | Where-Object { -not $ownedNames.Contains($_.Name.ToLowerInvariant()) })
}
foreach ($item in $foreign) {
  [void]$keepSteps.Add([pscustomobject]@{ Label = '安装目录里的其他内容'; Path = $item.FullName; Reason = '不属于本版启动器创建的内容，按规则保留' })
}
$deleteInstallDir = $false
if ($foreign.Count -eq 0 -and (Test-Path -LiteralPath $exeDir)) {
  $installDirOk = ($exeDir -notmatch '^[A-Za-z]:$')
  if (Test-SamePath $exeDir $dataDir) { $installDirOk = $false }
  if (Test-SamePath $exeDir $script:legacyDataDir) { $installDirOk = $false }
  if (Test-SamePath $exeDir $script:dshHome) { $installDirOk = $false }
  if ($env:USERPROFILE -and (Test-SamePath $exeDir $env:USERPROFILE)) { $installDirOk = $false }
  if ((Test-ParentOf $exeDir $script:legacyDataDir) -or (Test-ParentOf $exeDir $script:dshHome)) { $installDirOk = $false }
  foreach ($keptTarget in $keepSteps) {
    if ((Test-SamePath $keptTarget.Path $exeDir) -or (Test-ParentOf $exeDir $keptTarget.Path)) { $installDirOk = $false }
  }
  if ($installDirOk) {
    $deleteInstallDir = $true
    [void]$deleteSteps.Add([pscustomobject]@{ Label = '安装目录'; Path = $exeDir; Kind = 'directory' })
  }
} elseif ($foreign.Count -gt 0) {
  $names = ($foreign | ForEach-Object { $_.Name }) -join '、'
  $script:warnings.Add('安装目录里还有不属于本版启动器的内容（' + $names + '）：本次只删除启动器文件，目录保留。')
}

$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$runValue = 'electron.app.DSH-launcher-KEWU'
$hasRunValue = $false
try {
  if (Test-Path -LiteralPath $runKey) {
    $existing = Get-ItemProperty -LiteralPath $runKey -ErrorAction SilentlyContinue
    if ($existing -and ($existing.PSObject.Properties.Name -contains $runValue)) { $hasRunValue = $true }
  }
} catch {
  $hasRunValue = $false
}
if ($hasRunValue) {
  [void]$deleteSteps.Add([pscustomobject]@{ Label = '开机自启注册表项'; Path = ($runKey + '\' + $runValue); Kind = 'registry' })
}

Write-Line '将删除：'
$deleteTotal = [int64]0
foreach ($step in $deleteSteps) {
  if ($step.Kind -eq 'registry') {
    Write-Line ('  · ' + $step.Label + '  ' + $step.Path)
  } else {
    $stepSize = Get-TreeSize $step.Path
    $deleteTotal = $deleteTotal + $stepSize
    Write-Line ('  · ' + $step.Label + '  ' + $step.Path + '  (' + (Format-Size $stepSize) + ')')
  }
}
Write-Line ''
Write-Line '保留：'
foreach ($step in $keepSteps) {
  Write-Line ('  · ' + $step.Label + '  ' + $step.Path)
  Write-Line ('      原因：' + $step.Reason)
}
if ($script:warnings.Count -gt 0) {
  Write-Line ''
  foreach ($warning in $script:warnings) { Write-Line ('警告：' + $warning) }
}
Write-Line ''
Write-Line ('合计将删除 ' + (Format-Size $deleteTotal) + '。')

if ($DryRun) {
  Write-Line '仅为预览（-DryRun），没有删除任何内容。'
  Save-Log
  exit 0
}

if (-not $Yes) {
  $answer = Read-Host '确认卸载？输入 y 继续，其他任意输入取消'
  if ($answer -ne 'y' -and $answer -ne 'Y') {
    Write-Line '已取消，没有删除任何内容。'
    Save-Log
    exit 1
  }
}

if ($WaitPid -gt 0) {
  Write-Line ('等待启动器进程退出（PID ' + $WaitPid + '，最多 120 秒）…')
  $deadline = (Get-Date).AddSeconds(120)
  while ((Get-Date) -lt $deadline) {
    if (-not (Get-Process -Id $WaitPid -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Milliseconds 800
  }
  if (Get-Process -Id $WaitPid -ErrorAction SilentlyContinue) {
    Write-Line ('等待启动器退出超时（PID ' + $WaitPid + '），已中止卸载，没有删除任何内容。')
    Save-Log
    exit 1
  }
  Write-Line '启动器已退出，开始删除。'
}

foreach ($step in $deleteSteps) {
  if ($step.Kind -eq 'registry') { continue }
  Remove-Target $step.Path $step.Label
}
if ($hasRunValue) {
  try {
    Remove-ItemProperty -LiteralPath $runKey -Name $runValue -ErrorAction Stop
    Write-Line ('已删除：开机自启注册表项 -> ' + $runValue)
  } catch {
    $message = '开机自启注册表项 删除失败：' + $_.Exception.Message
    $script:failures.Add($message)
    Write-Line ('删除失败（这一项跳过，其余继续）：' + $message)
  }
}
if ($deleteInstallDir) { Remove-Target $exeDir '安装目录' }

Write-Line ''
if ($script:failures.Count -eq 0) {
  Write-Line '卸载完成：计划内的项目已全部删除，保留项原样未动。'
} else {
  Write-Line ('卸载完成，但有 ' + $script:failures.Count + ' 项没有删掉：')
  foreach ($failure in $script:failures) { Write-Line ('  · ' + $failure) }
}
Save-Log

$helperRoot = $PSScriptRoot
if ($helperRoot -and ((Split-Path -Leaf $helperRoot) -match '^kewu-uninstall-')) {
  try {
    Remove-Item -LiteralPath $helperRoot -Recurse -Force -ErrorAction Stop
  } catch {
    Write-Host ('提示：临时 helper 目录留待手动删除：' + $helperRoot)
  }
}
if ($script:failures.Count -eq 0) { exit 0 }
exit 1
