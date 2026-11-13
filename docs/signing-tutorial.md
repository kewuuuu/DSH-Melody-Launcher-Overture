# 代码签名与 SmartScreen：从零到「不再弹『已保护你的电脑』」

> 这份文档解决两件事：① 让 Windows 知道这三件产物是谁发布的（去掉「未知发布者」+ 让 SmartScreen 逐步放行）；② 在**没有预算**和**愿意花一点钱**两种情况下分别怎么走。
> 文中的价格与审核时长会变，下单前以官网为准。

## 0. 现在的事实（2026-11-12 实测）

```
DSH-launcher-KEWU-Portable-1.1.0.exe    | 92,623,798  | NotSigned
DSH-launcher-KEWU-Setup-1.1.0.exe       | 104,153,393 | NotSigned
DSH-launcher-KEWU-Uninstaller-1.1.0.exe | 139,776     | NotSigned
```

三者都是 `NotSigned`，且清单里 `requestedExecutionLevel=asInvoker`——**弹的 SmartScreen 与 UAC 是两件事**：

- **SmartScreen**（蓝底「Windows 已保护你的电脑」）：因为「没签名 + 这个文件还没攒够下载信誉」。只有签名 + 声誉能消掉。
- **UAC**（consent.exe「你要允许此应用对你的设备进行更改吗」）：只在清单要求管理员、或代码显式 `-Verb RunAs`、或系统认定它是安装/卸载程序时弹。本项目只在两个开关打开时才会弹（设置里的「启动器启动时请求管理员权限」、每个整合包的「管理员」勾选）。

另外一层是 **Mark-of-the-Web**（NTFS 备用流 `Zone.Identifier`）：浏览器下载的文件带 `ZoneId=3`，SmartScreen 与 Office 保护视图都读它。用户本机可以用 `Unblock-File .\xxx.exe` 或 `Remove-Item -Stream Zone.Identifier` 去掉，但**这不是产品方案**——不能要求每个用户都去敲命令。

## 1. 三条路线的取舍

| 路线 | 花钱 | 拿到的证书 | SmartScreen | 适合本项目吗 |
|---|---|---|---|---|
| **SignPath.io 开源免费签名** | 0 | 由 SignPath 托管的证书，发布者显示为 SignPath 或其背书主体 | 有效，仍需攒声誉 | ✅ 首选，前提是仓库公开且有 OSI 许可证 |
| **Certum 开源代码签名（云）** | 付费（按年，见官网） | 自己名下的证书，发布者是你 | 有效，仍需攒声誉 | ✅ 愿意花钱、想要自己署名时 |
| **Azure Trusted Signing** | 约 $9.99/月 | 微软云签名，发布者=你的组织 | 声誉最好，接近即时 | ❌ 要求组织成立满 3 年、且只在少数国家/地区开放，个人开发者一般不符合 |
| 自签名（`New-SelfSignedCertificate`） | 0 | 自己造的根证书 | **完全无效**，SmartScreen 照拦 | ❌ 只适合内网分发 |

关键认知：**签名 ≠ 立刻不弹**。OV 类证书（含 SignPath、Certum 开源证书）刚签发时信誉是 0，头几十到几百次下载仍可能被拦；下载量、时间、不同来源的下载会逐步累积信誉。只有 EV 证书（硬件令牌、年费高）才是「签完立刻不弹」。

## 2. 路线 A：SignPath.io 开源免费签名

### 2.1 前置条件（本仓库目前缺一条）

1. 仓库**公开**。
2. 有 **OSI 认可的开源许可证**（MIT / Apache-2.0 / GPL 等）。
   ⚠️ 现在 `package.json` 里没有 `license` 字段，仓库也没有 `LICENSE` 文件——**必须先选一个许可证并提交**，否则 SignPath 会直接拒。选哪个是法律决定，需要你拍板（见文末待办）。
3. 项目是「真的在用」的（有提交历史、有 Release），不是空壳。

### 2.2 申请步骤

1. 打开 <https://signpath.io/open-source>，点 **Apply for free signing**（"SignPath Foundation" 项目）。
2. 表单要填：项目名、仓库 URL（`https://github.com/kewuuuu/DSH-Melody-Launcher-Overture`）、许可证类型、维护者邮箱、项目简介（一句话说清这是什么软件）。
3. 等审核，通常**几个工作日**。他们会核对：许可证是否 OSI、仓库是否公开、是否真在发版。
4. 通过后会收到邀请，登录 <https://app.signpath.io>，在里面建：
   - **Organization**（你的组织）
   - **Project**（对应这个仓库）
   - **Artifact configuration**：声明要签的文件（例如 `**/*.exe`）
   - **Signing policy**：例如 `release-signing`（可以要求「只能由 tag 触发」）
5. 在 GitHub 仓库里安装 **SignPath GitHub App**（SignPath 后台会给安装链接），授权这个仓库。

### 2.3 CI 里怎么签（通过后我来接）

SignPath 的签名在他们云端 HSM 里做，CI 里只发「签名请求」：

```yaml
# 形态示意，实际参数用你后台里的 slug
- uses: signpath/github-action-submit-signing-request@v1
  with:
    api-token: ${{ secrets.SIGNPATH_API_TOKEN }}
    organization-id: <你的 org id>
    project-slug: dsh-launcher-kewu
    signing-policy-slug: release-signing
    artifact-configuration-slug: exe
    github-artifact-id: ${{ steps.upload.outputs.artifact-id }}
    wait-for-completion: true
    output-artifact-directory: signed
```

Token 在 SignPath 的 **User settings → API tokens** 生成，存成 GitHub secret `SIGNPATH_API_TOKEN`。
拿到 org id / 四个 slug 之后告诉我，我把 `.github/workflows/sign.yml` 改成 SignPath 版本（现有那份是给 `signtool` + PFX 用的，保留给路线 B）。

### 2.4 限制

- 免费额度有上限（每月签名次数、单文件大小），个人项目够用。
- 产物必须由他们托管的构建流程签，本地手工签不行。
- 审核被拒的常见原因：没许可证、仓库私有、长期不更新、项目与软件明显不符。

## 3. 路线 B：Certum 开源代码签名（付费、自己署名）

1. 在 Certum 官方或国内代理（例如 certumcodesign.cn）买 **Open Source Code Signing in the Cloud**（云签名版）。
2. 提交材料：开源项目证明（仓库 URL + LICENSE）、身份证明（护照/身份证）、地址证明。个人可以申请。
3. 签发后私钥在 **HSM/云端**（CA/B Forum 要求），本地通过 **SimplySign** 桌面客户端做签名——**通常不能导出 `.pfx`**。
4. 于是 CI 里签名要多一步：要么在装有 SimplySign 的 Windows 机器上签，要么用 Certum 的云签名网关。**本仓库现有的「PFX + `sign-windows.ps1`」路线只适用于能导出 pfx 的旧式证书**；拿不到 pfx 时就走「本机 SimplySign 签 → 手动上传 Release」。
5. 预算与周期：按年计费，审核约数个工作日到两周。

## 4. Azure Trusted Signing（了解即可）

微软的托管签名服务，价格低、声誉好，但要求：组织实体、**可查的 3 年经营历史**、开放国家/地区列表内的地址。中国大陆个人开发者基本不符合，所以不作推荐。

## 5. 拿到证书之后，在本仓库怎么落地

仓库里已经写好两条通路（`scripts/sign-windows.ps1`）：

### 5.1 PFX 模式（能导出 pfx 的证书）

```powershell
# 1) 本机把 pfx 转成 base64（只做一次，别把 pfx 提交进仓库）
[Convert]::ToBase64String([IO.File]::ReadAllBytes('C:\path\cert.pfx')) | Set-Clipboard

# 2) GitHub → Settings → Secrets and variables → Actions，新增：
#    SIGN_CERT_BASE64    = 上面那串
#    SIGN_CERT_PASSWORD  = pfx 密码

# 3) 本机手工签（不经过 CI）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/sign-windows.ps1 -Path release\b15
```

### 5.2 证书存储模式（证书已导入本机）

```powershell
Get-ChildItem Cert:\CurrentUser\My | Where-Object { $_.Subject -like '*你的名字*' } | Format-List Thumbprint, Subject
# 把 Thumbprint 存成 GitHub secret SIGN_THUMBPRINT
```

### 5.3 验证

```powershell
Get-AuthenticodeSignature .\DSH-launcher-KEWU-Portable-1.1.1.exe | Format-List Status, SignerCertificate
# Status 必须是 Valid；NotSigned 说明没签上，UnknownError 多半是证书链/时间戳问题
```

### 5.4 发版流程里已经接好

`.github/workflows/release.yml` 里有一段：检测到 `SIGN_CERT_BASE64` 就对三件产物调 `scripts/sign-windows.ps1`，没检测到就打印「跳过代码签名（产物以未签名方式发布）」并继续。也就是说 **证书一配，发版流水线自动开始签，不用改代码**。

## 6. 常被问到的几点

- **签了为什么还弹？** 新证书没有下载信誉。OV 类需要时间与下载量；EV 才是即时。Windows 的「SmartScreen 信誉」按证书+文件哈希累积，换版本重新累积得比首次快得多。
- **时间戳必须加。** 不加的话证书一过期，已发布的签名全部失效。脚本默认 `http://timestamp.digicert.com`，失败重试 2 次。
- **私钥不能进仓库。** 只放 GitHub secret；本地签完把 pfx 从工作目录移走。
- **每次发版都要重签。** 我们的 release 流程已经这么做了。
- **能不能让用户自己解除拦截？** 可以但不该指望：`Unblock-File` 只对当前机器当前文件有效。

## 7. 要推进这件事，需要你给的东西

1. **给仓库定一个许可证**（MIT 最省事，Apache-2.0 带专利授权）——这是 SignPath 的硬门槛，也是法律决定，我不替你选。
2. 选路线：SignPath（免费，等审核）还是 Certum（付费，自己署名）。
3. 若走 SignPath：申请通过后把 **organization id 与四个 slug**（project / signing policy / artifact configuration）给我，我改 CI。
4. 若走 Certum：拿到证书后告诉我它是 pfx 还是云签名（SimplySign），我按对应方式接。
