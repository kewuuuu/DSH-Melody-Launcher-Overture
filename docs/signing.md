# Windows 代码签名

当前状态：Release 里的 exe 全部未签名，`Get-AuthenticodeSignature` 返回 `NotSigned`，所以用户第一次运行时大概率看到 SmartScreen 的「Windows 已保护你的电脑」。

这份文档只写能真正落地的路线，以及本仓库自带的工具怎么用；供应商的价格、审核周期会变，正式提交材料前以官方页面为准。

本仓库已有的三件东西：

| 文件 | 作用 |
| --- | --- |
| `scripts/sign-windows.ps1` | 通用签名脚本：PFX 模式或证书存储模式，没有证书时打印跳过信息并 `exit 0` |
| `.github/workflows/sign.yml` | 手动触发，下载某个 Release 的 exe → 签名 → `gh release upload --clobber` 回传 |
| `docs/signing.md` | 就是本文 |

## 1. 三条免费/低成本路线对比

| 路线 | 成本 | 审核周期 | 是否即时免 SmartScreen | 维护成本 | 适合情况 |
| --- | --- | --- | --- | --- | --- |
| Certum 开源代码签名证书（OV） | 对公开 OSS 免费，需通过开源项目审核 | 人工审核约 1-3 周 | 否。仍是 OV 证书，要积累下载信誉 | 低。拿到 PFX 后离线签名，每年续期审一次 | 想长期持有证书、CI 里不依赖第三方云 |
| SignPath.io（开源项目免费） | 0 | 项目审核约 1-2 周 | 否。签出来的仍是 OV 证书 | 中。私钥在 SignPath 云端，签名策略/产物规则变更要跟着改 workflow | 不想自己托管私钥，接受云端签名 |
| 自签名（`New-SelfSignedCertificate`） | 0 | 无 | 否。SmartScreen 完全不认 | 低，但没有实际收益 | 只做内部测试、验证签名流程是否跑通 |
| 付费对照：EV 证书 / Azure Trusted Signing | 订阅制付费（以官方为准） | 身份验证 1-3 个工作日 | 是。这是唯一能即时免拦的一类 | 低到中 | 商业化分发、不能容忍初次弹窗 |

结论：想免费就只能在 Certum 和 SignPath 之间选，两者都只是「真实但无信誉的 OV 签名」。想彻底没有弹窗，只有 EV 或 Azure Trusted Signing。

## 2. Certum 开源代码签名证书

### 2.1 申请材料清单

- [ ] 项目公开仓库地址：`https://github.com/Miyazawai/DSH-Melody-Launcher-Overture`
- [ ] 开源许可证证明：仓库根目录的 LICENSE 文件，以及 SPDX 标识（如 MIT / Apache-2.0）
- [ ] 项目简介：做什么、给谁用、从哪里下载（指向 Release 页）
- [ ] 项目活跃度证据：近期提交记录、Release 列表、下载量或 star 数
- [ ] 申请人身份证明：护照或身份证扫描件（个人申请 OSS 证书需要身份核验）
- [ ] 联系方式：与仓库/主页一致的邮箱和地址，用于证书主体信息
- [ ] 已签署的申请表/订户协议（电子签名）
- [ ] 可下载的产物链接：Release 页面上的 exe，用于证明「确实有二进制在分发」

注意：材料清单随供应商政策调整，提交前对照 Certum 官方的开源项目申请页面确认一遍，避免因缺件被打回重排 1-3 周。

### 2.2 拿到证书之后

1. 在签发端导出 `.pfx`（含私钥，设置强密码）。
2. base64 化后放进仓库 secret `SIGN_CERT_BASE64`，密码放 `SIGN_CERT_PASSWORD`：

   ```powershell
   [Convert]::ToBase64String([IO.File]::ReadAllBytes("C:\path\to\codesign.pfx")) | Set-Clipboard
   ```

3. 本地签名（目录模式会签顶层的所有 `*.exe`）：

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/sign-windows.ps1 -Path release
   ```

4. 或者把证书导入当前用户证书存储，改用指纹模式：

   ```powershell
   $env:SIGN_THUMBPRINT = "ABCDEF0123456789..."
   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/sign-windows.ps1 -Path "release\b13\DSH-launcher-KEWU-Setup-1.0.4.exe"
   ```

5. 想给已经发布的 Release 补签名：Actions 里手动跑一次 `Sign Windows Assets`，填 tag 即可。

脚本行为要点：

- PFX 模式优先于指纹模式；PFX 会解到临时文件并在结束时删除。
- `signtool.exe` 先找 PATH，再依次找 `%ProgramFiles(x86)%\Windows Kits\10\bin\<version>\x64`、`x86`、`%ProgramFiles%\Windows Kits\10\bin`、`Windows Kits\8.1\bin`。
- 时间戳服务器 `http://timestamp.digicert.com`，签名失败重试 2 次（共 3 次），仍失败则退出码 1。
- 没有证书环境变量时打印「未配置签名证书，跳过签名」并 `exit 0`；但路径写错仍然报错退出 1，不会把配置错误悄悄吞掉。

## 3. SignPath.io 云端签名

### 3.1 接入步骤

1. 用 GitHub 账号注册 SignPath.io，选择开源项目（SignPath Foundation）通道申请免费额度。
2. 提交项目资料：仓库 URL、LICENSE、项目简介、产物类型（exe / msi）。
3. 审核通过后，在 GitHub 仓库安装 SignPath GitHub App，并授权它读取 Actions 运行。
4. 在 SignPath 里建 Project、建 Signing Policy（决定用什么证书、是否需要人工审批）。
5. 配置 origin verification：把可签名的来源限定为本仓库的 workflow，防止有人拿别处的文件来签。
6. 在 workflow 里加签名步骤（`signpath/github-action-submit-signing-request` 或官方 `signpath-action`），提交待签文件、拿回签名后的产物。
7. 首次跑通后对比前后哈希与 `Get-AuthenticodeSignature` 状态，确认上传回 Release 的确实是签名产物。

### 3.2 和本仓库 `sign.yml` 的关系

两者是并行的两条路线，**二选一**：

- `sign.yml` 走「自己持证」：证书 secret 注入 runner，调用 `scripts/sign-windows.ps1` 本地签名。
- SignPath 路线是「云端持证」：把 `sign.yml` 里的「调用签名脚本」一步换成 SignPath 的 action，其余下载、状态打印、回传步骤完全不用改。

`sign.yml` 的三条硬约束：`workflow_dispatch` 触发并接收 tag 输入；缺 `SIGN_CERT_*` secret 时整段跳过且整次运行成功；回传用 `gh release upload --clobber`。

## 4. 自签名为什么不够

- 自签名的根证书不在 Windows 受信任根存储里，用户机器上 `Get-AuthenticodeSignature` 是 `UnknownError` / `NotTrusted`，不是 `Valid`。
- SmartScreen 完全不认自签名证书，该拦还是拦，弹窗内容甚至更糟（签发者名陌生）。
- 想让签名「有效」就必须让用户手动把根证书装进受信任根，这一步比不签名更像恶意软件，不能作为分发方案。
- 唯一剩余价值：验证文件没被篡改、以及在没有证书的机器上把签名流水线跑通。所以脚本的「跳过」分支和自签证书只用于测试。

## 5. 验证命令

### 5.1 读签名状态（PowerShell）

```powershell
Get-AuthenticodeSignature -LiteralPath "release\b13\DSH-launcher-KEWU-Setup-1.0.4.exe" | Format-List Status, StatusMessage, SignerCertificate
```

`Status` 的几种取值：`Valid`（签名有效且证书受信任）、`NotSigned`（未签名）、`HashMismatch`（文件被改过）、`UnknownError` / `NotTrusted`（自签名或证书链不受信任）。批量看一个目录：

```powershell
Get-ChildItem -LiteralPath release\b13 -Filter *.exe | Get-AuthenticodeSignature | Format-Table Status, @{n="File";e={Split-Path $_.Path -Leaf}} -AutoSize
```

### 5.2 signtool verify

```cmd
"C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64\signtool.exe" verify /pa /v "release\b13\DSH-launcher-KEWU-Setup-1.0.4.exe"
```

`/pa` 表示按默认验证策略（Windows 驱动之外一律用它），`/v` 打印证书链细节。只关心签过没签过可以省略 `/pa`。

### 5.3 检查 MOTW（Zone.Identifier）

```powershell
# 有没有 MOTW
Get-Item -LiteralPath "C:\Users\me\Downloads\DSH-launcher-KEWU-Setup-1.0.4.exe" -Stream * | Select-Object Stream, Length

# 看 MOTW 的来源标记
Get-Content -LiteralPath "C:\Users\me\Downloads\DSH-launcher-KEWU-Setup-1.0.4.exe" -Stream Zone.Identifier

# 清掉 MOTW（只用于复现/对照测试，不要教用户这么做）
Unblock-File -LiteralPath "C:\Users\me\Downloads\DSH-launcher-KEWU-Setup-1.0.4.exe"
```

`Zone.Identifier` 里常见 `ZoneId=3`（来自 Internet）和 `HostUrl=` 或 `ReferrerUrl=`（下载来源）。没有这个数据流，就没有 MOTW。

### 5.4 生成 SHA-256（贴到 Release 说明）

```powershell
Get-FileHash -Algorithm SHA256 -LiteralPath "release\b13\DSH-launcher-KEWU-Setup-1.0.4.exe" | Format-List
```

哈希和签名要一起给：签名证明「是谁发的」，哈希证明「下载到的和发布的是同一份」，两者都缺的时候用户只能靠 SmartScreen 的弹窗做判断。

## 6. 对 SmartScreen 与 MOTW 的真实预期

- **触发条件是两条同时成立**：文件带 MOTW（`Zone.Identifier` 数据流），并且签名缺失或签名没有积累到信誉。
- **本地自己 build 的产物没有 MOTW**，所以「我这儿运行没弹窗」是正常的，不代表用户不弹窗；要复现就从浏览器或邮件里下一次自己的 Release。
- **签名不受沙箱影响**：`%TEMP%` 和用户目录不带 Low 完整性标签，签名脚本在这些位置能正常读写证书和时间戳。
- **时间戳的作用**：加上 RFC3161 时间戳后，即使证书过期，已有签名的旧版本仍然有效，所以签名命令必须带 `/tr` + `/td sha256`（脚本已经带）。
- **免费 OV 签名只是把「未知发布者」变成真实发布者，弹窗可能仍出现直到积累信誉。** 这是免费路线的天花板，不要把签名当成「弹窗消失」的承诺。
- **想即时免拦只有两条路**：EV 证书，或 Azure Trusted Signing；两者都要付费并做身份验证。

因此对外话术建议：签名的目标是「可追溯、可验证、不显示未知发布者」，不是「保证不弹窗」。用户遇到 SmartScreen 时给出的操作是「更多信息 → 仍要运行」，同时附上 SHA-256 校验值（见 5.4）。
