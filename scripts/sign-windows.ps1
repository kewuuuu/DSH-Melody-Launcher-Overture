<#
.SYNOPSIS
    对 Windows 产物做代码签名（signtool.exe）。
.DESCRIPTION
    证书来源按环境变量自动选择，PFX 模式优先：
      - PFX 模式：SIGN_CERT_BASE64（base64 编码的 .pfx）+ SIGN_CERT_PASSWORD
      - 证书存储模式：SIGN_THUMBPRINT（CurrentUser\My 或 LocalMachine\My 里的证书指纹）

    没有配置任何证书时打印“未配置签名证书，跳过签名”并以 0 退出，
    未配置证书的 CI 不会因为缺证书而变红。

    参数与路径校验在证书检测之前完成：路径写错时即使没有证书也会报错退出。
    时间戳服务器默认 http://timestamp.digicert.com，签名失败会重试 2 次（共 3 次），
    仍失败则退出码 1。
.PARAMETER Path
    待签名的 .exe，或包含 .exe 的目录（只签目录顶层的 *.exe）。
.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts/sign-windows.ps1 -Path release
.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts/sign-windows.ps1 -Path "release\b13\DSH-launcher-KEWU-Setup-1.0.4.exe"
#>

[CmdletBinding()]
param(
    [string]$Path,
    [string]$TimestampUrl = "http://timestamp.digicert.com",
    [int]$TimestampRetries = 2
)

$ErrorActionPreference = "Stop"
$script:Prefix = "[sign-windows] "

function Write-Step([string]$message) {
    Write-Host ($script:Prefix + $message)
}

function Fail([string]$message) {
    Write-Host ($script:Prefix + $message) -ForegroundColor Red
    exit 1
}

function Find-SignTool {
    $fromPath = Get-Command signtool.exe -ErrorAction SilentlyContinue
    if ($fromPath) { return $fromPath.Source }

    # PATH 里没有就翻 Windows SDK 的常见安装位置（10.x 取版本号最高的那个）。
    $kitsRoots = @()
    $pf86 = ${env:ProgramFiles(x86)}
    if ($pf86) {
        $kitsRoots += (Join-Path $pf86 "Windows Kits\10\bin")
        $kitsRoots += (Join-Path $pf86 "Windows Kits\8.1\bin")
    }
    if ($env:ProgramFiles) { $kitsRoots += (Join-Path $env:ProgramFiles "Windows Kits\10\bin") }

    foreach ($root in $kitsRoots) {
        if (-not (Test-Path -LiteralPath $root)) { continue }
        # 8.1 的 bin 下直接是 x64/x86，10.x 下还有一层版本目录。
        $bases = @()
        foreach ($versionDir in @(Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending)) {
            $bases += $versionDir.FullName
        }
        $bases += $root
        foreach ($base in $bases) {
            foreach ($arch in @("x64", "x86")) {
                $candidate = Join-Path (Join-Path $base $arch) "signtool.exe"
                if (Test-Path -LiteralPath $candidate) { return $candidate }
            }
        }
    }
    return $null
}

# --- 1. 解析目标：先校验路径，路径错误永远要报出来 ---
if ([string]::IsNullOrWhiteSpace($Path)) { Fail "缺少 -Path 参数，请传入 .exe 或包含 .exe 的目录" }

$resolved = $null
try {
    $resolved = (Resolve-Path -LiteralPath $Path -ErrorAction Stop).ProviderPath
} catch {
    $resolved = $null
}
if (-not $resolved -or -not (Test-Path -LiteralPath $resolved)) { Fail "找不到目标路径：$Path" }

$targets = @()
if (Test-Path -LiteralPath $resolved -PathType Container) {
    $targets = @(Get-ChildItem -LiteralPath $resolved -Filter *.exe -File | Sort-Object Name | ForEach-Object { $_.FullName })
    if ($targets.Count -eq 0) { Fail "目录下没有 .exe 可签名：$resolved" }
    Write-Step ("目录模式下待签名文件 " + $targets.Count + " 个：" + $resolved)
} else {
    $targets = @($resolved)
    Write-Step ("单文件模式：$resolved")
}

# --- 2. 证书检测：没有证书就干净地跳过，退出码 0 ---
$pfxBase64 = $env:SIGN_CERT_BASE64
$pfxPassword = $env:SIGN_CERT_PASSWORD
$thumbprint = $env:SIGN_THUMBPRINT

$usePfx = -not [string]::IsNullOrWhiteSpace($pfxBase64)
$useStore = (-not $usePfx) -and (-not [string]::IsNullOrWhiteSpace($thumbprint))

if ((-not $usePfx) -and (-not $useStore)) {
    Write-Step "未配置签名证书，跳过签名"
    Write-Step "（需要设置 SIGN_CERT_BASE64 + SIGN_CERT_PASSWORD，或 SIGN_THUMBPRINT）"
    exit 0
}

# --- 3. 找 signtool.exe ---
$signTool = Find-SignTool
if (-not $signTool) {
    Fail "找不到 signtool.exe：PATH 中没有，Windows SDK 常见路径下也没有（请安装 Windows SDK 后重试）"
}
Write-Step ("使用 signtool：" + $signTool)

$tempPfx = $null
try {
    if ($usePfx) {
        $compact = $pfxBase64 -replace "\s", ""
        $certBytes = $null
        try {
            $certBytes = [System.Convert]::FromBase64String($compact)
        } catch {
            Fail "SIGN_CERT_BASE64 不是合法的 base64 字符串"
        }
        $tempPfx = Join-Path ([System.IO.Path]::GetTempPath()) ("overture-sign-" + [Guid]::NewGuid().ToString("N") + ".pfx")
        [System.IO.File]::WriteAllBytes($tempPfx, $certBytes)
        Write-Step "PFX 模式：证书已解到临时文件 $tempPfx"
        if ([string]::IsNullOrEmpty($pfxPassword)) { Write-Step "提示：SIGN_CERT_PASSWORD 为空，将按空密码打开 PFX。" }
        $signArguments = @("sign", "/fd", "sha256", "/f", $tempPfx, "/p", $pfxPassword, "/tr", $TimestampUrl, "/td", "sha256")
    } else {
        $normalized = ($thumbprint -replace "\s", "").ToUpperInvariant()
        $certificate = $null
        foreach ($store in @("Cert:\CurrentUser\My", "Cert:\LocalMachine\My")) {
            $hit = Get-ChildItem -Path $store -ErrorAction SilentlyContinue | Where-Object { $_.Thumbprint -eq $normalized } | Select-Object -First 1
            if ($hit) { $certificate = $hit; break }
        }
        if (-not $certificate) { Fail "证书存储里找不到指纹 $normalized（已查 CurrentUser\My 与 LocalMachine\My）" }
        Write-Step ("证书存储模式：使用 " + $certificate.Subject)
        $signArguments = @("sign", "/fd", "sha256", "/sha1", $normalized, "/tr", $TimestampUrl, "/td", "sha256")
    }

    # --- 4. 逐个签名，失败重试（时间戳服务器抖动是常见原因） ---
    $maxAttempts = $TimestampRetries + 1
    foreach ($target in $targets) {
        $attempt = 0
        $done = $false
        while ((-not $done) -and ($attempt -lt $maxAttempts)) {
            $attempt = $attempt + 1
            Write-Step ("签名第 " + $attempt + "/" + $maxAttempts + " 次：$target")
            $arguments = @($signArguments) + @($target)
            $output = & $signTool @arguments 2>&1
            $code = $LASTEXITCODE
            foreach ($line in @($output)) { Write-Host ("    " + $line) }
            if ($code -eq 0) {
                $done = $true
            } else {
                Write-Host ($script:Prefix + "签名失败（退出码 " + $code + "）") -ForegroundColor Yellow
                if ($attempt -lt $maxAttempts) {
                    Write-Step "3 秒后重试，时间戳服务器：$TimestampUrl"
                    Start-Sleep -Seconds 3
                }
            }
        }
        if (-not $done) { Fail ("签名未成功：$target（已尝试 " + $maxAttempts + " 次，时间戳服务器 $TimestampUrl）") }
    }
} finally {
    if ($tempPfx -and (Test-Path -LiteralPath $tempPfx)) {
        Remove-Item -LiteralPath $tempPfx -Force -ErrorAction SilentlyContinue
        Write-Step "已清理临时证书文件"
    }
}

# --- 5. 自检：读回签名状态，NotSigned/HashMismatch 视为失败 ---
$broken = @()
foreach ($target in $targets) {
    $signature = Get-AuthenticodeSignature -LiteralPath $target
    Write-Step ("验签结果：" + $target + " -> " + $signature.Status)
    if (($signature.Status -eq "NotSigned") -or ($signature.Status -eq "HashMismatch")) { $broken += $target }
}
if ($broken.Count -gt 0) { Fail ("签名未生效：" + ($broken -join ", ")) }

Write-Step ("完成：已签名 " + $targets.Count + " 个文件")
exit 0
