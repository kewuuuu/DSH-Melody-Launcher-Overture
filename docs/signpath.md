# SignPath 签名接入（已选定路线）

README 之外的单页操作清单：从「申请」到「自动签名」只有六步，全部在 SignPath 与 GitHub 上做，本仓库已经准备好前置材料。

> **当前阻塞**：本账号没有 GitHub Actions 额度（任何 job 都起不来，提示「account is locked due to a billing issue」），而 SignPath 的 GitHub App 走的是 Actions runner，所以本文第 6 步的自动签名现在**跑不起来**；仓库里原来那个 `signpath.yml` 已按「发布只走本地」的规则删掉。可行的两条路：① 恢复 Actions 额度后按本文重建 workflow；② 用 SignPath 的 API token 在本机提交签名请求（需在控制台确认接口后接入 `scripts/`，未验证）。

## 前置条件（本仓库现状）

| 要求 | 状态 |
|---|---|
| 仓库公开 | 是：`kewuuuu/DSH-Melody-Launcher-Overture` |
| OSI 认可的开源许可证 | 已放 `LICENSE`（MIT 全文）、`package.json` 有 `"license": "MIT"` |
| 真在发版（有 Release 与版本号） | 是：v1.1.0 / v1.1.1 / v1.1.2，三件产物齐全 |
| 仓库根有 LICENSE 文件 | 是，构建时也随 `files` 打进安装包 |

**一个必须知道的法律事实**：上游 `rirko/dsh-melody-launcher` 与 `Miyazawai/DSH-Melody-Launcher-Overture` 的 GitHub `license` 字段都是 `null`、`/license` 端点 404，也就是「保留所有权利」。本分支加的 MIT 只对本分支新增的代码有效，覆盖不了上游代码；`NOTICE` 里如实写明了来源链与这一现状。SignPath 审核若追问项目许可证来源，需要能说清这件事（或先向上游拿到书面授权）。

## 六步接入

1. **申请**：<https://signpath.io/open-source/> 填表（项目名、仓库地址、许可证、发版方式）。审核通常几个工作日，通过后拿到 Organization ID 与一个邀请。
2. **建项目**：登录 <https://app.signpath.io>，在组织下新建 Project（slug 例如 `dsh-launcher-kewu`），Origin 选 GitHub。
3. **建 Artifact Configuration**：用一个 `.exe` 通配（例如 `**/*.exe`），签名的就是 CI 上传的那个 artifact 里的可执行文件。
4. **建 Signing Policy**：slug 取 `release-signing`，触发条件设成需要审批或自动通过（内部测试可用自动）。
5. **装 GitHub App**：在 SignPath 里给 Organization 安装 GitHub App，授权到 `kewuuuu/DSH-Melody-Launcher-Overture`；把 API token（`SIGNPATH_API_TOKEN`）存进仓库 Secrets。
6. **配变量**：仓库 Settings → Variables 增加四个：`SIGNPATH_ORGANIZATION_ID`、`SIGNPATH_PROJECT_SLUG`、`SIGNPATH_SIGNING_POLICY_SLUG`、`SIGNPATH_ARTIFACT_CONFIGURATION_SLUG`。

配完这六步，`.github/workflows/signpath.yml` 会在发布 Release 时自动把三件产物送签：artifact 上传 → 签名请求 → 下载已签名产物 → 覆盖 Release 上的资产。没配变量时这个 workflow 会整体跳过，不会让发布变红。

## 与本地脚本的关系

- `.github/workflows/release.yml` 里已经有一段「有 `SIGN_CERT_BASE64` 就用 `scripts/sign-windows.ps1` 本地签名」的逻辑，走的是 PFX 路线。
- SignPath 走云端 HSM，不需要把私钥放进仓库；两条路线可以并存：PFX 优先，没有 PFX 时交给 SignPath。
- 自签名证书对 SmartScreen 完全无效，别绕这条路。

## 签完之后

- 首次下载仍可能被 SmartScreen 拦一次：信誉要时间累积（OV 证书同理，只有 EV 与 Azure Trusted Signing 是即时）。
- 验证：`Get-AuthenticodeSignature .\DSH-launcher-KEWU-Portable-1.1.3.exe` 应为 `Valid`，签名者显示 SignPath 代表的开源项目发布者身份。
