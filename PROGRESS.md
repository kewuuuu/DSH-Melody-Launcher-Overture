# launcher-overture · 进度

## 目标

在原有 Windows Electron 启动器上增量增加多包 DSH Web 控制面板、独立并行运行、逐包配置和 CLI，保留运行时、市场、导入导出、外观与托盘能力。

## 已定决策与原因

- 直接修改原项目，复用已有 DSH Web 启动、安装与配置逻辑，避免新建同类启动器。
- 各包以明确 ID、家目录、profile 和版本启动，不切换全局激活包；同一家目录禁止重复占用，避免会话与配置冲突。
- 图形界面与 CLI 共用 launcherControl；CLI 必须显式指定停止／重启的包，避免误操作当前选中环境。
- 采用包环境隔离，不引入系统级文件沙箱或新的 Windows 常驻服务；关闭窗口到托盘，退出停止托管包。
- 共享资源显式引用，保留包内同名内容；显示来源和不同底色，仍被引用时保护源资源和源包。
- 包启动前提供默认 launcher-control skill，保留用户自建同名 skill；自停／自重启会断开当前 DSH 会话。

## 当前进度

- 2026-11-05：实现列表控制面板（名称／创建时间／端口升降序、独立置顶顺序、逐包端口／权限／自启）、配置浮层和指定包市场返回路径。
- 实现多包管理器、配置持久化、启动端口预留、逐包启停重启、管理员监督进程及便携版登录自启路径。
- CLI 支持包查询／创建／改名／删除／启停／重启／配置，允许的全局设置，以及插件／技能／预设资源操作；包导入导出继续使用原界面。
- 2026-11-05：数据目录改为跟随 EXE（单文件便携即 EXE 同级 launcher-data），支持 --data-dir、指针文件、便携／安装／开发态解析、设置页存储位置区块与 storage CLI，详见下文「数据目录（单文件 EXE · 同级存储）」。
- 独立验收：npm run build 通过；npm test 为 989 passed、11 skipped（102 个测试文件通过、9 个跳过）。真实临时子进程验证独立家目录、端口和逐包启停；CLI 用真实 Node 子进程测试；浏览器检查控制面板与配置浮层，无控制台错误。
- 评审发现并处理：大文件读取截断导致的误删已恢复；市场跨包缓存污染已修复；共享行底色和失败反馈已补齐；CLI 资源别名已修正；源引用保护、回滚、旧默认包与 profile 兼容、重复启动保护和管理员父进程看护已验证。
- Windows 便携包已生成：release/preview/DSH-Launcher-1.0.4-portable.exe（92,497,456 字节）；目录版位于 release/preview/win-unpacked/。已检查 app.asar 包含 bin/launcher-control.cjs。
- 打包原目录重命名遇到 EPERM；使用已安装 Electron 到独立 preview 输出完成目录版。封装工具直连超时后经 npmmirror 镜像下载成功。权限诊断为项目／release／临时解压目录补齐当前用户权限，复读验证通过；备份和撤销说明位于 Workspace/_cache/launcher-acl/RECOVERY.md。

## 下一步

- 桌面实机验收实际 UAC 提权启动／停止、Windows 登录自启和便携 EXE 运行。自动化测试未触发 UAC、未操作登录注册表。
- 需要时扩展 CLI 包导入导出及更多设置字段；当前全局设置限于 openAfterLaunch、uiTheme、appearance、network。

## 已知限制

- 未替换本机已安装启动器，未修改正在使用的 DSH 家目录，未停止当前 3080 主机。
- 提权路径通过模拟 Windows 进程调用及真实临时脚本／日志测试；尚未实际弹出 UAC。
- 共享目录使用 junction／symlink；平铺技能用 hardlink，要求源与目标在同一卷，跨卷明确报错。
- 自动端口检查最多向后查找 100 个；启动器内并发有预留保护，外部进程抢占仍由启动错误报告。
- 未实测联网安装市场项目；继续调用已有安装器。
- 11 项测试跳过，不能将全量回归结果解读为所有平台行为均已实测。

## 启动失败根因（实机复核）

- 症状：新构建双击后没有新窗口；解压目录版直接以 0x80000003（EXCEPTION_BREAKPOINT）退出，--enable-logging=file 不产生任何日志，说明死在 Chromium 日志初始化之前。
- 已排除产品代码：把旧版 app.asar 换进新版载荷后仍然同样崩溃；把同一份 win-unpacked 复制到 D:\launcher-preview 后正常开出窗口。
- 根因一（单实例）：新旧版本共用默认 userData %APPDATA%\dsh-launcher。旧启动器在运行时，新 EXE 拿到 requestSingleInstanceLock 失败即静默退出，只留下旧窗口，表现为「打不开」。给 --user-data-dir 指定独立目录后同一 EXE 正常开窗（便携版实测，解压到 %TEMP% 后运行）。
- 根因二（路径）：D:\engine\DSH 整棵树带有 Low Mandatory Level 标签和继承的 Everyone 删除拒绝 ACE，放在其中的 Electron 可执行文件在启用沙箱时启动即崩；同一份文件放在 D:\launcher-preview、D:\ 根目录或 %TEMP% 下均正常。对该树 icacls /setintegritylevel 被拒绝，无法原位修复。
- 结论：产物本身可用；不要在 D:\engine\DSH 内直接运行构建产物，也不要与正在运行的旧启动器共用默认 userData。
- 早先为跑起来临时放的项目外副本 `D:\launcher-preview\`、`D:\DML-Smoke\`、`D:\DML-Smoke2\` 已全部删除；构建产物只保留在项目内 `release\` 下，规则见文末「构建产物与交付路径约定」。

## 构建产物与交付路径约定（2026-11-07）

- 唯一构建产物位置：`D:\engine\DSH\projects\launcher-overture\release\<tag>\`（便携单文件 `DSH-Launcher-<ver>-portable.exe`、解包版在同级 `win-unpacked\`）。`release/` 已在 `.gitignore`，不进仓库。
- 为什么不放在项目外也能跑到：`D:\engine\DSH` 把 `Mandatory Label\Low Mandatory Level` 继承给整棵子树，Electron 沙箱在里面启动即静默退出（0x80000003），NSIS 便携壳直接报 NSIS Error；对该树 `icacls /setintegritylevel` 被拒绝，无法原位修复。
- 2026-11-07 复测：把 portable EXE 复制到 `release\b3\smoke-test\` 用 schtasks 拉起，24 秒内 `launcher-data` 未生成、进程随即消失，确认项目树内不可运行。该目录已删除。
- 因此实机烟测一律复制到 `%TEMP%\<name>-smoke\` 跑，跑完删除；交付说明只报项目内绝对路径 + 文件大小 + SHA256，不把 EXE 复制到 `D:\` 根或桌面当交付物。
- 例外：`D:\DSH-Launcher\` 是用户在用的运行实例（同级 `launcher-data` 含整合包与市场缓存），属用户数据，不按构建产物清理；它的 EXE 与 `release\b3` 那份 SHA256 一致，删掉也不会丢构建产物。

## 数据目录（单文件 EXE · 同级存储）

- 目标：一个 EXE 即可运行，数据写在 EXE 同级 `launcher-data`（整合包登记、包目录、DSH 运行时、插件存储），不同启动器互不干扰，并能在界面里指定任意目录以接管旧数据。
- 解析优先级（命中即返回）：`--data-dir=<绝对路径>` / `--user-data-dir=<绝对路径>`（也支持空格形式，`--data-dir` 优先）→ EXE 同级 `launcher-storage.json` 的 `{"dataDir":"…"}` → 便携版 `PORTABLE_EXECUTABLE_DIR/launcher-data` → 安装版 `dirname(execPath)/launcher-data` → 开发态 `%APPDATA%/dsh-launcher`（保持 vite 传给 dev 的隔离参数有效）。
- `app.setPath('userData')` 与 `app.setPath('sessionData', <数据目录>/browser-data)` 都在 `requestSingleInstanceLock` 之前执行，因此单实例锁、log、CLI 元数据都跟着所选目录走；建目录失败退回 `%APPDATA%/dsh-launcher` 并给出中文警告，不阻断启动。
- 切换目录只写指针文件 `launcher-storage.json`，需重启生效；`relaunchLauncher` 用 `PORTABLE_EXECUTABLE_FILE || process.execPath` 并剔除 `--data-dir`/`--user-data-dir`，避免旧参数把新目录覆盖回去。
- 界面：设置页「存储位置」区块（原挂在「DSH版本」tab 末尾，2026-11-06 迁到新的「设置」tab）提供当前路径与复制、来源说明、指针文件行、警告与重启提示、选择文件夹／接管旧版数据（把 `%APPDATA%/dsh-launcher` 作为默认目录带入选择框）／恢复默认位置。
- CLI：`storage info` / `storage set <dir>` / `storage reset`，支持 `--user-data` 指定要查询的实例；`storage set` 写指针并返回 `restartRequired: true`。
- 实机验收（2026-11-05，Windows）：新便携包复制到 `D:\DSH-Launcher\DSH-Launcher.exe`（92,544,598 字节）运行后，同级生成 `launcher-data`（packs.json、launcher-control.json、settings.json、browser-data 等），`storage info` 报 `source: "portable"`；`storage set` 写指针后重启，`source: "pointer"` 且数据落到新目录；两个不同数据目录的实例可同时运行；强杀后再次启动可正常接管。
- 回归：`npx tsc --noEmit` 通过，`npm run build` 通过，`npm test` 为 **1027 passed、11 skipped（104 文件通过、9 跳过）**；storage 相关定向用例 46 例全绿。
- 交付副本：`D:\DSH-Launcher\DSH-Launcher.exe`（目录内不要再手写 `--user-data-dir`，默认即 EXE 同级）。构建产物仍不可在 `D:\engine\DSH` 树内直接运行，见上一节。

## 设置主页 tab 与启动器级 API 库（2026-11-06）

- 顶栏新增第 7 个 tab「设置」（`src/lib/nav.ts` 的 HOME_TABS，`HomeTab` 加 `'settings'`）：外观 → 启动器 → 存储位置 → API 库 → 网络 → 关于；旧的「启动器设置」弹窗 `SettingsDialog` 与其 `settingsOpen` 状态整体删除，齿轮入口改为切到该 tab，避免两套设置并存。
- 启动器图标 = 界面/窗口图标，复用现有的 `appearance.logo`（运行时可换）；EXE 文件图标需重新打包签名，不在本轮范围。
- 开机自启语义拆分：`AppSettings.launchAtLogin` 只负责「启动器随 Windows 登录启动」（Run 项 `electron.app.DSH Launcher`，参数 `--background`，路径优先 `PORTABLE_EXECUTABLE_FILE`）；整合包自己的 `autoStart` 只在启动器起来后由 `packControl.autoStart()` 拉起对应包。原来「任一包 autoStart 为真就注册登录项」的 `onAutoStartChange` 三条调用已删除；`launchAtLogin` 一律默认关，不做旧数据迁移。
- 启动器级 API 库（`electron/api-library.ts`，`<userData>/api-library.json` v1 + 密钥进 `<userData>/.credentials.yaml`）：库里登记一次，再在「整合包配置 → API」按包勾选授予。授予记录在 `<userData>/pack-api-grants.json`（`{version,grants,errors}`）。
- 唯一来源语义：勾选后由启动器把 provider 写进该包自己的 `settings.yaml`、把密钥写进该包的 `.credentials.yaml`；库条目改名称/端点/协议/模型会重新同步进所有已授予的包；改 route 名按 `originalRoute` 语义把 provider 与包侧密钥一起迁移；删库条目级联撤销所有已授予包的 provider 与包侧密钥。组合点在 `electron/launcher-control.ts` 的 `apiLibrary` facade，`api-library.ts` 与 `pack-apis.ts` 互不 import，IPC 与 CLI 走同一实现。
- 安全边界：停用一个从未授予过的 route 是 no-op（不碰用户手配的 provider）；包内同步失败回滚授予记录并把原因记进 `errors[packId]`，可经 `pack api list <packId>.error` 读到；`restartRequired` 只在「本次真的改了授予且该包正在运行」时为真，`getState` 恒为 false，不再每次打开 API 子页都挂重启横幅。
- CLI 新增：`api list` / `api add <route> --name --base-url --protocol --models [--api-key]` / `api remove <route>`（级联撤销）/ `pack api list <pack-id>` / `pack api enable|disable <pack-id> <route>` / `settings launch-at-login [on|off]`，文档见 `docs/launcher-cli.md`。
- 回归：`npm run build` 通过（`dist-electron/preload.mjs` 18.63 kB）；`npm test` **1073 passed / 11 skipped（112 文件通过、9 跳过）**；`npx tsc --noEmit` 通过。新增用例覆盖 api-library 7、pack-apis 11（含未授予 no-op、restartRequired 真值语义）、launch-at-login 7、launcher-control-api-cli 7（含库改元数据跟随、改名迁移、删除级联且未授予包两文件仍 ENOENT）、ipc-launch-at-login 2，前端 SettingsHomeView 3 / ApiLibraryCard 4 / PackControlDialog 5。
- 实机验收（2026-11-06，Windows，便携单文件 EXE 从 `D:\DML-Smoke2\` 与 `D:\DSH-Launcher\` 两处各跑一次）：同级自建 `launcher-data`，`storage info` 报 `source:"portable"`，`pack list` 返回默认 web 包；`api add smoke-openai` → `pack api enable web smoke-openai` 后，该包家目录（本例 `C:\Users\kewu0\.dsh`）`settings.yaml` 出现 provider 且 `.credentials.yaml` 出现 `SMOKE_OPENAI_API_KEY`；改库端点/协议/模型后该 provider 跟着变；`request api.save` 改名到 `smoke-two` 后 provider 与密钥名一起迁移、旧密钥消失、grants 跟着改名；`api remove smoke-two` 后 `settings.yaml` 回到 `{ llm-pi-ai: {} }`、包侧密钥清空、grants 为 `{"web":[]}`；`pack api disable web never-granted` 返回 `enabled:[]` 且不碰包；`settings launch-at-login on` 在 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` 写入 `electron.app.DSH Launcher : "D:\DML-Smoke2\DSH-Launcher.exe" --background`，`off` 后该值消失且其它自启项未受影响。
- 该轮产物：`release\b3\DSH-Launcher-1.0.4-portable.exe`（92,561,829 字节，SHA256 `A09E039AE8116AA9AC803B266F8F360EEC1F97B47F27DE29FA565947A25187C4`）。当时另复制了一份到 `D:\DSH-Launcher\` 做烟测，用户随后在那个位置继续使用，因此它成了运行实例（数据在同级 `launcher-data`）。构建产物不再放项目外。
- 未验证：真实 UAC 提权启动、Windows 登录后自启的实际触发（只验证了注册表项写入与移除）、以及打包 EXE 的窗口截图（工具截屏对 Electron 窗口取不到画面）。

## Wave2：KEWU 改名、启动页重做、备份区、插件面板、工作区技能与对话自动续接（2026-11-07）

- 品牌与导航：窗口标题与顶栏改为「DSH启动器：KEWU」；第 7 个 tab 之后新增「设置」已在前一节，「启动」tab 重做为左列品牌图／名称／版本／检查更新，右列余额卡（`api.deepseekBalance` + `api.dshUsage`）与「查看用量」外链，右下是启动器插件数据面板；原 AI 日报轮播（`WidgetZone`）与旧 `LauncherHome` 整体删除，删除同时移除了新闻缓存等数据通路。
- 控制面板迁到「整合包」tab：`PacksRuntimeBar` + `PackDashboard`（排序／置顶／端口／启动停止重启／快捷打开网页／管理员／自启动／配置）加上内联「新建整合包」「导入整合包」，页面底部折叠「更多整合包操作…」保留重命名、导出、会话导入、克隆版本、官方包等低频操作。
- 滚动修复：全仓唯一滚动容器是 `.home-tab-pane { overflow-y: auto; min-height: 0 }`，各 tab 内容不再自己撑 `height: 100%`，实测 `browser_scroll(400)` 时 pane 固定、内容上移。
- 备份区（`electron/backups.ts`，索引 `<userData>/backups/index.json`，包文件 `<id>.partial.zip` → rename）：删除类操作一律先备份，三处 hook 为 `electron/pack.ts`、`electron/skill-format.ts`、`electron/installer.ts`；`backupBeforeDelete` 在默认引擎未注入时**抛错阻止删除**（fail-closed，不再静默放行）。压缩只用系统工具：`SystemRoot\System32\tar.exe`（bsdtar，`-a -cf` 建包、`-tf` 列成员、`-xf -C` 解压）→ PowerShell（Compress-Archive / ZipFile / Expand-Archive）→ 都没有则抛中文错误。恢复：列成员 → `assertSafeArchiveMembers` 拒绝对路径/盘符/`..`/首段越界 → `assertTargetsIdle` 拦住运行中的包（「整合包 <名> 正在运行，请先停止再恢复。」）→ 解到 `.restore-XXXX` 暂存 → rm+rename → finally 清暂存。总大小上限默认 2 GB（`DEFAULT_BACKUP_LIMIT_BYTES`），支持锁定不被清理。
- 启动器插件（`electron/launcher-plugins.ts`，目录 `<userData>/launcher-plugins`）：每个插件一个目录，`manifest.json` 必填 `name`（`/^[A-Za-z0-9][A-Za-z0-9._-]*$/`）；可选 `index.mjs` 作为代码插件，stdout 输出 `{panels:[…]}` 或数组，10 秒超时，env 只透传 PATH/SystemRoot/TEMP/HOME，Electron 下带 `ELECTRON_RUN_AS_NODE=1`。面板类型 `list`（≤200 项）/`table`（≤200 行、12 列）/`html`（≤512 KiB，前端用 `<iframe sandbox="" srcDoc>` 渲染，脚本不执行）；单插件失败只写 `error`，不影响其它插件，总上限单插件 50 个面板。
- 工作区技能（`electron/workspace-skills.ts`）：读 `<dshHome>/storages/workspace.json`（v2：`global.workspaceIds[]` + `tables.workspaces.<uuid>.path`）只读不改，按「全局 `<dshHome>/skills`」与每个 `<workspace>/.dsh/skills` 分组列出，bundle（含 SKILL.md）与扁平 `.md` 都认；停用 = 目录改名加 `.disabled`；删除先走备份引擎。菜单位置在「技能」tab 的「已安装技能」之后。
- 对话自动续接（`electron/pending-resume.ts`，队列 `<userData>/pending-resumes.json` v1，`writeFileAtomic` 写）：`pack restart <id> --resume "<prompt>" [--session <id>]` 先入队再重启；包就绪后由 `electron/launcher-control.ts` 的 `pendingDeliveryFor(request, result)` 判定（只在 `pack.start`/`pack.restart` 且拿到 `runtime.url` 时）触发 `queue.deliver(packId, url)`：`GET <origin>/connect?token=…` 换 cookie → `POST /api/session/list` 挑唯一 `status==='running'` 会话（多个则要求显式 `--session`）→ `POST /api/session/prompt`，`args {requestId, sessionId, mode:'queue', content:[{type:'text',text}]}`，固定 requestId 幂等；`attempts >= 3` 不再自动重试，失败留在队列里由页面横幅「1 条待发请求 · 重试/复制/放弃」处理。CLI：`pending list|retry|discard`。
- 目录迁移（`electron/path-migration.ts`）：`paths.migrate(kind, target)` 支持 `dshHome` 与 `dshInstallPath`；`assertMigrationTarget` 拒绝空值、相对路径、与当前相同、位于当前目录内部、等于启动器数据目录；迁移前先对该目录做一次 `path.migrate` 备份，再复制、成功后写设置、最后删旧目录（旧目录删除是「所有包都停止后」由用户确认的部分）。
- CLI 汇总（`bin/launcher-control.cjs` + `docs/launcher-cli.md`）：`backups list|create|restore|remove|lock|limit`、`plugins list|refresh|open`、`skills workspace [--json]`、`pending list|retry|discard`、`path migrate dshHome|dshInstallPath <dir>`、`pack restart <id> --resume`。
- 回归：`npx tsc --noEmit` 通过；`npm run build` 通过（`dist-electron/preload.mjs` 20.48 kB）；`npx vitest run` **125 文件通过 / 9 跳过，1154 passed / 11 skipped / 0 failed（1165 例）**。新增用例覆盖备份引擎 8、插件宿主 9、工作区技能 8、续接队列 11、路径迁移 11、CLI 续接 4、续接触发条件 3，以及前端 DataPanels 6 / PendingResumesBanner 4 / BackupManager 5 / WorkspaceSkillsPanel 3 / PathMigrationSection 3 / StartView 3。
- 实机验收（2026-11-07，Windows，便携 EXE 从 `%TEMP%\kewu-smoke\` 运行，符合「烟测只在 %TEMP%」的规则）：`launcher-storage.json` 指针生效，`storage info` 报 `source:"pointer"` 且 `dataDir` 为指针指向的目录；`pack list` 返回 web 包并自动完成旧数据迁移（`packsV2Migrated: true`，导入 `pack-test` 快照包与 0.2.2-rc.1 运行时）；`pending list` 返回 `[]`；`path migrate dshHome rel/path` 被拒（「迁移目标必须是绝对路径」），`path migrate bump` 被拒（不支持的迁移目标）。烟测目录（含 859 MB 备份 zip 与运行时）已删除，无残留进程。
- 已知成本：`path migrate dshHome` 会先给整个 DSH 家目录打备份包（本机 67,492 文件 / 2.1 GB → 859 MB zip，耗时数分钟），期间 CLI 会长时间无输出，空间占用短暂翻倍；迁移 2 GB 目录建议单独给足时间，不要用默认超时。
- 该轮产物：`release\b4\DSH-Launcher-1.0.4-portable.exe`（92,589,873 字节，SHA256 `1F4F947C86400D1A4860EFD13FFA56233F523C4ED5A4669F39D659DCB60A4593`），解包版在 `release\b4\win-unpacked\`。
- 未验证：真实 UAC 提权启动、Windows 登录后自启的实际触发、打包 EXE 的窗口截图（工具截屏对 Electron 窗口取不到画面）、续接请求对真实运行中 DSH 会话的端到端投递（队列、触发条件与 RPC 协议已分别单测，实机只验证到 `pending list`）。

## 卸载功能（2026-11-07）

- 口径：**只删「启动这个软件之后新增的内容」**。启动器 EXE、EXE 同级 `launcher-data`、`launcher-storage.json` 指针、开机自启项（`HKCU\...\Run\electron.app.DSH Launcher`）、`%TEMP%\3L*` 自解压残留算本版内容；`%APPDATA%\dsh-launcher`（旧启动器数据）与 `~/.dsh`（DSH 家目录）永不删。
- 三个入口共用一套引擎：设置页「备份与卸载 → 卸载」面板（预览、导出脚本、立即卸载，两步确认）、CLI `uninstall plan|script|now`、以及 `tools/uninstall-kewu.ps1` + `tools/uninstall-kewu.cmd` 离线版（可脱离启动器双击运行）。界面能选择「把卸载脚本导出到某个目录」，导出的就是 ps1 + cmd 一对。
- 引擎文件：`electron/uninstall-plan.ts`（纯计划，可注入 `existsSync/statTree/readDirNames/processImagePaths`）、`electron/uninstall-script.ts`（脚本模板 + 生成器，单测断言 `tools/uninstall-kewu.ps1` 与模板逐字一致）、`electron/uninstall.ts`（停包 ≤20 秒 → 写 `%TEMP%\kewu-uninstall-<8位hex>\{uninstall-kewu.ps1,run.cmd}` → detached 拉起 → 返回 `{started:true}`）、`electron/uninstall-ipc.ts`（三个 IPC，界面与 CLI 两条路都会通知主进程退出）。
- **默认保留数据**：IPC 导出一律 `deleteData:false`；CLI 只有显式 `--delete-data` 才删数据（`--keep-data` 仍被接受但已无作用）。
- 退出链路：`main.ts` 的 `quitAfterUninstallStarted()` 延后 300ms 再 `app.quit()`，先把 IPC/HTTP 回复写完；helper 用 `-WaitPid` 等启动器真正退出（最多 120 秒）再删。**CLI 这条路一开始没接退出**，实测 helper 白等 120 秒后中止、什么都没删，已修并加 `tests/uninstall-quit-hook.test.ts` 三例锁定。
- **别人的解压目录不许删**：`%TEMP%\3L*` 里如果正有进程从里面运行（典型是用户另一个启动器实例），计划判 `keep` 并写明原因，ps1 侧还有 `Test-InUse` 二次守卫。改了这条以后，计划里 `3L5B3…`（用户实例）判 keep，只有真正的孤儿残留才 delete。
- 日志：helper 的日志写在 `%TEMP%\kewu-uninstall-<8位hex>.log`（helper 目录旁边，不随目录自删消失）。
- 实机验收（`D:\engine\DSH\test\uninstall-smoke`，该目录没有 Low 完整性标签，EXE 能跑）：`uninstall plan` 给出 `deleteBytes 910,426,752 / keepBytes 4,103,204,324`，逐项 action 符合预期；`uninstall now --yes --delete-data` 后 CLI 退出码 0，**2 秒后安装目录整棵消失**（EXE、launcher-data、目录本身），日志记录「已删除：安装目录」。同时复核用户数据：用户在跑的旧启动器 7 个进程仍在、`C:\Users\kewu0\.dsh` 67,492 文件、`%APPDATA%\dsh-launcher` 154,465 文件均未动，HKCU Run 键没有 `electron.app.DSH Launcher`。
- 已知台账：卸载时自己那一份解压目录（正在运行的那个 `3L*`）会被判 keep，卸载后可能留下 1 个残留目录，日志里会写「1 项没有删掉」。这是「不删别人正在用的目录」的同一条规则带来的副作用，用户可手动删。
- 回归：`npx tsc --noEmit` 0 error；`npx vitest run` 130 文件通过 / 9 跳过，**1186 passed / 11 skipped / 0 failed**；`npm run build` 通过。
- 提交：`6f4058d`（装配 + 默认保留数据）、`8b4e726`（in-use 守卫）、`93853c1`（CLI 退出 + 计划注入 processImagePaths）、`a46481f`（CLI 文档）。
- 产物：`release\b5\DSH-Launcher-1.0.4-portable.exe`（92,594,198 字节，SHA256 `B1E383BC5D2953A8FF08073095FDA82CB234753C71D5825CA08005BBDB357B7E`），解包版 `release\b5\win-unpacked\`；卸载程序 `release\b5\uninstall-kewu.cmd` + `release\b5\uninstall-kewu.ps1`（与 `tools\` 下同源）。
- 未验证：真实 UAC 提权下的卸载、界面点「立即卸载」这条 UI 链路（只验证了它复用的同一个 service 与同一个 `quitAfterUninstallStarted`）。


## 三件交付物：便携 EXE、卸载器 EXE、安装版 Setup（2026-11-07）

- 交付口径：一个 EXE 便携版（数据就在 EXE 同级 `launcher-data`）、一个独立卸载器 EXE（WinForms，勾选界面，可脱离启动器运行）、一个安装版 Setup。卸载器不再是 .cmd+.ps1 那种命令行形式，但仍保留 `tools/uninstall-kewu.ps1`+`.cmd` 作离线兜底。
- 安装版数据目录改造：`electron/storage-root.ts` 新增 `INSTALLED_DATA_DIRNAME = 'KEWU-launcher'`，`defaultLocation` 的 install 分支由「EXE 旁的 launcher-data」改为 `<appData>/KEWU-launcher`——装在 Program Files/用户目录时，升级和卸载都不会连坐数据；便携版（`PORTABLE_EXECUTABLE_DIR` 存在）与开发态分支不变。`docs/launcher-cli.md` 的 Storage location 同步改写。
- NSIS 安装包配置（`package.json` 的 `build`）：`win.target` 加 `nsis`；产物名 `KEWU-Portable-${version}.exe` / `KEWU-Setup-${version}.exe`；`oneClick:false`、`perMachine:false`（按用户安装，不需要管理员）、可选安装目录、桌面+开始菜单快捷方式（「DSH启动器 KEWU」）、`uninstallDisplayName`「DSH启动器：KEWU」、`deleteAppDataOnUninstall:false`、中文界面（`language=2052`）、`runAfterFinish:true`。
- 卸载器 EXE：`tools/uninstaller/src/Program.cs`（计划构建 + `--plan`/`--run`/`--selftest-gui`/`--dir` 无界面模式）、`UninstallerForm.cs`（760x620 中文窗口、逐条复选框、重新扫描、两步确认、实时日志、结束占用进程）、`scripts/build-uninstaller.ps1`（系统 `csc.exe` 离线编译，Framework64 缺失时回退 32 位），产物 `tools/uninstaller/bin/KEWU-Uninstaller.exe`（136,192 字节，已 gitignore，属本地构建物）。
- 卸载器条目与默认勾选：启动器主程序（删）、EXE 同级 `launcher-data`（默认保留）、`launcher-storage.json`（删）、`HKCU\\...\\Run\\electron.app.DSH Launcher`（删）、`%TEMP%\\3L*` 自解压残留（有进程在里面运行则强制保留并写明原因）、`%APPDATA%\\KEWU-launcher`（安装版数据，默认保留）；`%APPDATA%\\dsh-launcher` 与 `~/.dsh` 只展示、永不可勾选。
- 主程序挑选规则（本轮 review 退回修掉的缺陷）：一开始按文件名排序取第一个 `*.exe`、只排除硬编码 `KEWU-Uninstaller.exe`，三个交付文件同目录时会把安装包当启动器删掉。现在先按**完整路径**排除自身，再排除文件名含 `uninstall`/`setup` 的，然后按 KEWU → DSH → Melody → Launcher 的档位挑第一个命中者，都不像才回退第一个候选；没有合格候选就只清理数据与自启项并在界面/日志里提示「没找到启动器主程序」，绝不删错。
- 构建坑：NSIS 目标要执行中间 installer，而 `D:\\engine\\DSH` 整棵树带 Low 完整性标签、EXE 在里面起不来 → 直接在 `release/b6` 构建会失败（只落下 320,104 字节 stub 与 `ERR_ELECTRON_BUILDER_CANNOT_EXECUTE`）。做法是 `-c.directories.output=D:/engine/DSH/test/kewu-b6-nsis` 构建成功后再把 EXE 复制回 `release/b6`。
- 实机验收（`D:\\engine\\DSH\\test\\kewu-b6\\`）：便携版启动即生成同级 `launcher-data`、`storage info` 报 `source:"portable"`；安装版 `KEWU-Setup-1.0.4.exe /S /D=...` 静默装出 85 个文件（含 `Uninstall DSH Launcher.exe`、HKCU 卸载项、两处快捷方式），启动后 `storage info` 报 `{"dataDir":"C:\\Users\\kewu0\\AppData\\Roaming\\KEWU-launcher","source":"install"}`；静默卸载后程序目录消失、`%APPDATA%\\KEWU-launcher\\packs.json` 仍在、注册表/开始菜单/桌面残留均为 0。
- 卸载器实测（真实 EXE，schtasks 脱离工具沙箱）：`--plan` 条目与默认勾选全对；`--run --yes` 删主程序/指针/`3L*` 残留、保留 `launcher-data` 与安装版数据；`--run --yes --delete-data` 再把两处数据删掉，两次日志都是「退出码：0」。
- 本轮实测删掉了旧实例遗留的自解压目录 `%TEMP%\\3L5B3GoCeXELafWB8uVQQa3Q6H6`（当时已无进程从里面运行，日志 0 失败）——这正是「无进程的残留才删」这条规则的效果；用户的 `%APPDATA%\\dsh-launcher`、`~/.dsh` 均未受影响。
- 环境限制（不是产品缺陷）：从工具沙箱里启动安装版时数据目录从不生成、窗口空转，改用 schtasks 在沙箱外启动就正常——沙箱内子进程只能写自己的根，写 `%APPDATA%` 会被拦。
- 回归：`npx tsc --noEmit` 0 error；`npx vitest run` 131 文件通过 / 9 跳过，**1192 passed / 11 skipped / 0 failed**；`npm run build` 通过。
- 提交：`befe152`（卸载器 EXE 首版）、`2b704d0`（主程序挑选规则修复）、`d49d1c7`（安装版数据目录 + NSIS 目标）。
- 产物（`release\\b6\\`，解包目录 `release\\b6\\win-unpacked\\`）：
  - `KEWU-Portable-1.0.4.exe` — 92,597,516 字节，SHA256 `5F67B50A515B58EFFE2EBE01E7C61A91A5A03E13842A399219270756972F1859`
  - `KEWU-Setup-1.0.4.exe` — 104,059,558 字节，SHA256 `69CA2736A840464CC0B728FD9241038C37F7FC84B2DA11BE201CFED4AFA1978F`
  - `KEWU-Uninstaller-1.0.4.exe` — 136,192 字节，SHA256 `286A6612C169BCC3FA599955688A9642CE9852AF3422FFA77557765F5B9BF317`
- 未验证：卸载器 GUI 的真人点击（只跑了 `--selftest-gui` 与无界面模式）、目标机没装 .NET Framework 4.x 时卸载器起不来（`csc` 编出来的 WinForms 依赖系统自带的 4.x）、真实 UAC 下的安装/卸载。

## 改名 DSH-launcher-KEWU、关闭官方包自动安装与 b7 三件产物（2026-11-07）

- 产品名统一改为 `DSH-launcher-KEWU`：`package.json` 的 `productName`、两个 portable 产物名、`nsis.artifactName/shortcutName/uninstallDisplayName`、`electron/storage-root.ts` 的 `INSTALLED_DATA_DIRNAME`（安装版数据目录改为 `%APPDATA%\DSH-launcher-KEWU`）、`electron/uninstall-plan.ts` 的 `UNINSTALL_LOGIN_ITEM_NAME = 'electron.app.DSH-launcher-KEWU'`、`electron/uninstall-script.ts` 模板的 `$runValue`、`tools/uninstall-kewu.ps1`、卸载器 `Program.cs`/`UninstallerForm.cs`、`docs/launcher-cli.md`、`src/App.tsx` 的 `APP_TITLE`。冻结不动：`appId com.local.dshlauncher`、`LEGACY_DATA_DIRNAME 'dsh-launcher'`（旧数据识别）、顶栏短品牌 KEWU。上节里的 `KEWU-launcher` / `electron.app.DSH Launcher` 均已被本节取代。
- 首启不再自动下载安装官方整合包：`electron/main.ts` 的 `officialPackBootstrap` 删掉「零官方包且存在 recommended 就 `runOfficialPack(false, status.recommended)`」那段，只保留 `resolveOfficialPackStatus` 与状态广播；手动入口（下载/恢复官方包）未动。
- 便携版实测 `PACK_COUNT=0`、无 `dsh-packs` 目录 → 自动安装确实已关闭。
- **b7 安装失败的真因（不是产品缺陷，是产物跑错了地方）**：`D:\engine\DSH` 整棵树被 DSH 自己的 Windows 沙箱打上 Low 完整性标签，`release\b7\*.exe` 也继承该标签；从那里直接执行 Setup 会在解压前就被拒绝，表现为 `EXIT=2`、`%TEMP%` 一个 `ns*` 目录都不生成、也不报错。把 Setup 复制到 `D:\engine\DSH\test\kewu-b7\setup\setup.exe`（`icacls` 确认无 Mandatory Label）后同一文件静默安装成功。旧 b6 产物现在同样 `EXIT=2`，可反证与代码无关。
- b7 实机验收（全部在 `D:\engine\DSH\test\kewu-b7\`，schtasks 脱离工具沙箱）：便携版同级生成 `launcher-data`、`storage info` 报 `source:"portable"`；Setup `/S /D=<test>\app` 装出 85 个文件、HKCU 卸载项 `DSH-launcher-KEWU`、`UninstallString = "…\Uninstall DSH-launcher-KEWU.exe" /currentuser`、桌面与开始菜单各一条 `DSH-launcher-KEWU.lnk`；启动后 `storage info` 报 `{"dataDir":"C:\\Users\\kewu0\\AppData\\Roaming\\DSH-launcher-KEWU","source":"install"}`；静默卸载后程序目录消失、`%APPDATA%\DSH-launcher-KEWU\packs.json` 保留、注册表与快捷方式残留 0。
- 卸载器 EXE（重命名后重建，136,704 字节）：`--plan` 在便携/安装两种布局下都正确（`exe` delete+勾选、`data`/`installed-data` keep+不勾选，`alwaysKeep` 仍列出旧版 `dsh-launcher` 与 `~/.dsh`）；`--run --yes --delete-data` 实跑「已删除 4，已跳过 0，失败 0，退出码：0」，删掉主程序、安装版数据目录与遗留的自解压残留。
- 清理口径的教训：卸载器 EXE 内部有「有进程从该目录运行就跳过」的守卫，但我这次手写的 PowerShell 清理循环直接 `Remove-Item` 了 `%TEMP%\3L*`，把用户当时仍在运行的旧实例解压目录 `%TEMP%\3L5B3GoCeXELafWB8uVQQa3Q6H6` 一并删了（进程仍在跑，映射文件不受影响，wrapper `D:\engine\DSH\DSH-Launcher-1.0.4-portable.exe` 完好，重开即重新解压）。后续一律用卸载器或带占用检查的脚本清 `3L*`。
- 回归：`npx tsc --noEmit` 0 error；`npx vitest run` 131 文件通过 / 9 跳过，1192 passed / 11 skipped / 0 failed；`npm run build` 通过。
- 提交：`0a8db7c`（品牌改名）、`ba72813`（不再自动装官方包）。
- 产物（`release\b7\`，解包目录 `release\b7\win-unpacked\`）：
  - `DSH-launcher-KEWU-Portable-1.0.4.exe` — 92,589,294 字节，SHA256 `64579191392A7F79278393D53016BFCC5BB0DA3F73CE021D72B9FE38C8861697`
  - `DSH-launcher-KEWU-Setup-1.0.4.exe` — 104,059,540 字节，SHA256 `E65E014237ED40212EC67ADDE8A385EFDE7A6388E8C19E0255BB4D6BC8DC0D7A`
  - `DSH-launcher-KEWU-Uninstaller-1.0.4.exe` — 136,704 字节，SHA256 `08EB32E8EE18B93B12AE9928B50A73615912DBD99F75432ACECB5CE4F3E848A0`
- 未验证：卸载器 GUI 真人点击、无 .NET Framework 4.x 的机器、真实 UAC 弹窗下的安装/卸载、登录自启项写入后的实际开机触发（只核对了常量与卸载器读取的键名一致）。

## 卸载器窗口按钮跑到窗口外（2026-11-08）

- 用户反馈「卸载程序没有确认取消等按钮，没法卸载」。实测：窗口内根本看不到按钮，只有一块内容区。
- 根因：`tools/uninstaller/src/UninstallerForm.cs` 用 `AutoScaleMode.Dpi` + 按 `ClientSize.Width` 手算的按钮坐标，本机缩放把子控件按另一套尺寸摆放，两个按钮落到窗口右侧外面（量到的按钮屏幕坐标 1341..1431，窗口右边界 1079）。
- 修复（`UninstallerForm.cs`）：①`AutoScaleMode = AutoScaleMode.None`，顺序改为先设 AutoScaleMode/Font 再设 `ClientSize`（780x640）、`MinimumSize` 700x560；②底部按钮条改成靠右停靠的 `FlowLayoutPanel`（`开始卸载` 124x32、`关闭` 96x32），日志路径标签改 `Dock = Fill`；③顶部 `重新扫描` 与两个路径框改为 `DockStyle.Fill` + `DockStyle.Right` 容器；④`始终保留` 区块先加 Fill 再加 Top，避免标题与正文重叠（WinForms 按相反顺序停靠）。
- 新增 `--selftest-layout`：不显示窗口，打印 `client=780x640 size=798x687 mode=None dpi=96 screen=1920x1080`，用于回归这类缩放问题。
- 验收方式（真窗口）：`SetProcessDPIAware` 后 `PrintWindow` 截图 + `EnumChildWindows` 量矩形——三个按钮都在窗口内（`重新扫描` 1218..1334 / `开始卸载` 1106..1230 / `关闭` 1238..1334，窗口右边界 1359），截图存 `Workspace\_cache\uninstaller-fixed2.png`；`BM_CLICK` 点「开始卸载」弹出 `#32770 确认卸载`（是/否），取消后主程序与数据都在，点「是」后 `EXE_DELETED=True POINTER_DELETED=True DATA_KEPT=True`。
- 测量教训：Windows PowerShell 5.1 默认 DPI 不感知，`GetWindowRect`/`PrintWindow` 拿到的是 0.8 倍虚拟坐标，会把正常布局误判成「按钮在窗口外」；脚本开头先调 `SetProcessDPIAware()` 再量。
- 测试：`tests/uninstaller-exe.test.ts` 增加源码守卫（含 `AutoScaleMode.None`、不含 `AutoScaleMode.Dpi`、含 `FlowLayoutPanel` 与 `DockStyle.Right`）；`--selftest-layout` 的进程内 GUI 断言在 vitest 里会超时不退出，故不入测试。全量 `npx vitest run` 131 文件通过 / 9 跳过，1193 passed / 11 skipped。
- 产物：`release\b7\DSH-launcher-KEWU-Uninstaller-1.0.4.exe` 与交付副本 `D:\DSH-launcher-KEWU\DSH-launcher-KEWU-Uninstaller-1.0.4.exe` 均为 137,728 字节，SHA256 `5FE98949233E062CC7D431C2490BFEC3E8B7D483088840AB3DE061F259F67C11`（csc 每次编译 PE 时间戳不同，两份副本取的是同一次编译输出）。
- 未验证：真人点击（用 `BM_CLICK`/`WM_CLOSE` 程序化模拟）、其它 DPI 缩放比例下的显示。

## 卸载器删不掉深路径数据目录（2026-11-08）

- 用户反馈：在 `D:\engine\DSH\test` 用卸载器删 `launcher-data` 失败（勾选后仍然失败）。
- 根因：该数据目录里有 `dsh-runtime\versions\0.2.2-rc.1\node_modules\.pnpm\…` 这类深层文件，最长路径 319 字符（>260）。旧版在**计划阶段**就抛 `System.IO.PathTooLongException: 指定的路径或文件名太长…`（栈顶 `KewuUninstaller.TreeMeasure.Measure` → `UninstallPlanBuilder.Build` → `HeadlessRunner.Run`），退出码 1，一个文件都没删。
- 关键坑：csc 编出来的 .NET Framework 4.0 产物（无 app.config）对 `\\?\D:\…` 前缀的 `Directory.Exists` 返回 **false**，所以「给 .NET API 加长路径前缀」这条路走不通；PowerShell 对同样前缀返回 true（PS 的 app.config 关了 LegacyPathHandling），不能拿 PS 的结论推断卸载器。
- 修复（`tools/uninstaller/src/Program.cs`）：新增 `NativeFs`（`FindFirstFileW/FindNextFileW/GetFileAttributesW/DeleteFileW/RemoveDirectoryW` + `\?` 前缀，UNC 用 `\?UNC`）与 `FsEntry`；`TreeMeasure.Measure` 与 `TreeDelete` 全量改走 Win32 长路径 API（reparse point 只删自身，不递归）；失败项汇总成「还有 N 项删不掉」或「目录仍然存在」。
- 实证：同一份 9,768,922 字节 / 292 文件 / 最深 319 字符的数据目录副本，旧 b7 版退出码 1（PathTooLongException），新版 `--run --yes --delete-data` 输出「已删除 2，已跳过 0，失败 0 / 退出码：0」并删净整棵；`--plan` 能算出 `sizeBytes=9768922`（旧版算不出来）。
- 回归：`tests/uninstaller-exe.test.ts` 新增「数据目录里有超过 260 字符的深路径时，--plan 能算出大小、--delete-data 能删净」；全量 `npx vitest run` 131 文件通过 / 9 跳过，1194 passed / 11 skipped（1205）；`npx tsc --noEmit` 0 error。
- 卸载器的条目规则（回答「为什么只有几项」）：条目按**当前是否存在**生成——`exe`（默认勾选删）、`本版数据目录`（默认保留）、`launcher-storage.json` 指针（存在才列，默认删）、`开机自启项`（HKCU Run 有值才列，默认删）、`%TEMP%\3L*` 自解压残留（存在才列，默认删；有进程住在里面就改成保留）、`安装版数据目录 %APPDATA%\DSH-launcher-KEWU`（存在才列，默认保留）；另有两条恒保留不可勾选：`%APPDATA%\dsh-launcher`、`%USERPROFILE%\.dsh`。没有任何不列出来却偷偷删的动作。
- 产物：`release\b7\DSH-launcher-KEWU-Uninstaller-1.0.4.exe` 与 `D:\DSH-launcher-KEWU\DSH-launcher-KEWU-Uninstaller-1.0.4.exe` 均为 139,776 字节，SHA256 `606E33FCF39F249D180D1A8507959EF1B35298C92732FE39EF939CA20B56B68E`。
- 未完成：`D:\engine\DSH\test` 里那份旧卸载器被用户正在运行的实例锁定（PID 12212），未能覆盖；关掉那个窗口后才能替换。
## 删除整合包入口、隐藏提权窗口与原地切换 DSH 版本（2026-11-09）

- 用户提三项（含「导入后会话标题都显示未命名」的另一问）：整合包没有删除入口、管理员模式启动会弹出 PowerShell 窗口、整合包的 DSH 版本能否升级。
- 删除整合包：控制面板每一行的操作列末尾加删除按钮（`src/components/PackDashboard.tsx:106-108`，`aria-label="删除 <包名>"`，`title="删除整合包（先停止运行，再整份备份进备份区）"`），两步确认（行内 `confirmRemove` → `danger-button`）；后端沿用已有 `pack.delete`（运行中拒绝，先 `backupBeforeDelete` 把整份家目录打进备份区，再移除并写注册表）。为放下这一列，`.pack-table` 的 `min-width` 760px → 820px（`ec1c7a5`）。CLI 对应 `pack delete <id>`，返回最新列表。
- 隐藏提权 PowerShell 窗口（`f0ceff5`）：`electron/elevated-runtime.ts` 起提权监督进程时原来会闪一个控制台窗口。现在三层都隐藏——①`Start-Process powershell.exe` 的 `ArgumentList` 里加 `-WindowStyle Hidden`；②外层 `-WindowStyle Hidden`；③监督脚本开头先 `Add-Type` 导入 `GetConsoleWindow/ShowWindow` 并 `ShowWindow($h,0)` 把已经分配到的控制台也隐藏。`tests/elevated-runtime.test.ts` 断言命令行含 `-WindowStyle Hidden`。
- 原地切换 DSH 版本：新增 `upgradePackDshVersion(packId, version)`（`electron/pack.ts:2113`，接口 :184），只改这个包自己的 `dshVersion`（`profiles/<id>/profile.yaml` + 注册表），不动全局 `activePackId`，也不动别的包。四条拒绝分支：版本号非法 → `DSH 版本无效：<输入>`；比当前旧 → 复用 `downgradeRejection`（「请新建一个空整合包」「也可以往 <source> 或更高的版本复制」）；包在运行 → `请先停止整合包再切换 DSH 版本。`；同版本 → 不写盘、不装版本、直接返回现状。目标版本没安装时先走 `ensureDshVersionInstalled`，装失败则记录保持旧版本。
- 写盘顺序（D5，`20869d9`）：先 `setProfileDshVersion`（包内派生自述）再 `upsertPackRecord`（注册表这条事实）。反过来时 `profile.yaml` 写失败会留下「记录说新版本、包里还是旧版本」，而同版本 no-op 会让它永远修不回来；新用例「包内 profile.yaml 写失败时注册表保持旧版本，重试仍能修好」钉住这个顺序。
- 交互：整合包配置浮层「启动设置」新增「DSH 版本」块——当前版本、目标版本下拉（只列本机已安装版本）、「切换版本」按钮（同版本或运行中禁用）、运行中提示「整合包正在运行，停止后才能切换版本。」、说明「只能升级不能降级；切换后插件可能需要重新安装。」。成功文案「已切换到 DSH <v>，下次启动生效。」。
- CLI：`node bin/launcher-control.cjs pack upgrade <pack-id> --dsh-version <version> [--json]`；`--dsh-version` 只属于 `pack upgrade`，缺失或错用的报错都是中文。文档写在 `docs/launcher-cli.md:216` 起的「## 原地切换 DSH 版本（pack upgrade）」。
- 回归：`npx tsc --noEmit` 0 error；`npx vitest run` 132 文件通过 / 9 跳过，1205 passed / 11 skipped（1216）。提交线 `ee5bb03 → 85fe4da → dcd62d0 → ec1c7a5 → f0ceff5 → 20869d9`，工作树干净。
- b8 产物（`release\b8\`，构建时间 17:08-17:09 晚于最后一次提交 17:07:26）：便携 `DSH-launcher-KEWU-Portable-1.0.4.exe` 92,596,213 字节 SHA256 `CC20297360ACACEA6C4CD9402EDE02A79CDD0DEEA404EE005E3F93138C9E697B`；安装包 `DSH-launcher-KEWU-Setup-1.0.4.exe` 104,059,408 字节 SHA256 `94F1B3C9D583CC9CE1B24F14FB415A2DD1295FDCC40A1F684143CFCAEB202BB4`；卸载器 `DSH-launcher-KEWU-Uninstaller-1.0.4.exe` 139,776 字节 SHA256 `606E33FCF39F249D180D1A8507959EF1B35298C92732FE39EF939CA20B56B68E`（源码未变，沿用 ee5bb03 的编译结果）。三件已覆盖到交付目录 `D:\DSH-launcher-KEWU\`。
- b8 实机烟测（`D:\engine\DSH\test\kewu-b8-smoke`，schtasks 一次性任务脱离工具沙箱）：6 秒生成 `launcher-data`，`storage info` 报 `source:"portable"`，无 `dsh-packs`（官方包自动安装保持关闭）；`pack upgrade web --dsh-version latest` 返回 `DSH 版本无效：latest`，证明 CLI→控制服务→facade→`pack.ts` 全链路通；`pack create --args '{"name":"smoke-b"}'` → id `pack-smoke-b`、`pack rename … --args '{"name":"smoke-c"}'` 成功、`pack delete pack-smoke-b` 返回 `{"removed":0}` 且 `launcher-data\backups\` 里出现 `mw91k46x-h97z28.zip`（删除前备份生效）。清理时按 `ExecutablePath` 前缀区分两个解压目录，只杀自己那份（`3LrbxAvm…`），用户正在跑的实例（wrapper PID 1316、`3LmuQHcM…`）未触碰。
- 未验证：真实 UAC 弹窗下管理员启动的窗口是否真的完全不再出现（只验证了命令行参数与源码守卫）；界面「删除整合包」与「切换版本」的真鼠标点击（走的是与 CLI 同一条后端路径）。

## 会话标题投影缓存、UI 自查截图与三处缺陷修复（2026-11-09）

- 用户选 A（m03865）：导出时勾选「会话」要连投影缓存一起带走，并把当前包已导入会话的标题补回显示。
- 导出端（`a5391dd`）：`electron/pack-snapshot.ts:98` 新增 `SESSIONS_STORAGE_PATHS = ['storages/session_projcache', 'storages/session_projcache.json']`，`:101-104` 的 `isSessionsStoragePath` 按**路径段**匹配（`rel === allowed || rel.startsWith(allowed + '/')`，并放行裸 `storages` 目录让 walk 继续下去），`:174` 在勾了 sessions 时对它返回 false。会话标题与每会话用量只存在于 `storages/session_projcache/sessions/*.json` 的 `record.rows.title.val` / `record.rows.billTurns`，会话日志本身不带标题；`storages/workspace.json` 写死源机绝对路径，故意不带。导入端未改，`extractSnapshot` 用同一个 `isSnapshotExcluded` + `privacyIncludeFromList(meta.private)`，所以勾了就一定解出来。
- 一次性补齐（只增不覆盖）：脚本 `D:/engine/DSH/Workspace/_cache/kewu-cache-backfill.ps1` 从旧实例 `C:\Users\kewu0\AppData\Roaming\dsh-launcher\dsh-packs\pack-test\storages\session_projcache\sessions` 拷到新实例 `D:\engine\DSH\launcher-data\dsh-packs\pack-test\…`，目标已存在则跳过，且只复制「新包 sessions 下确实有同名会话目录」的条目：`COPIED=43 SKIPPED=8 ORPHAN=1`，目标 53 个缓存文件里 50 个有非空标题（另 3 个本来就没标题）。
- UI 自查能力（`4e3986b`）：新增 `electron/ui-shot.ts`（`uiShotDirectory(argv)` 读 `--ui-shots=<dir>`，空串视为未开；`captureUiShots(window, dir)` 等 `did-finish-load` + 2s，按 `.topbar-tabs button` 的文字依次点每个栏目，每页截「顶部 / -中部 / -底部」三张）；`electron/main.ts` 在 `openMainWindow()` 之后调用它。滚动脚本一开始只认 `.home-tab-pane`，导致四张「-底部」与首屏哈希完全相同；改成遍历所有元素取 `overflowY` 为 auto/scroll 且 `scrollHeight > clientHeight` 的容器设 `scrollTop`。测试 `tests/ui-shot.test.ts` 3 例。
- 缺陷 D-A（真 bug）：`pack-control.json` 带 UTF-8 BOM 时 `JSON.parse` 抛错，整页「整合包」变红且列表 0 个包。`electron/pack-control.ts` 的 `configs()` 现在先 readFile（ENOENT→{}）再 `JSON.parse(text.replace(/^\uFEFF/, ''))`，仍失败就把原文件改名成 `pack-control.json.corrupt-<时间戳>` 留档、`console.warn` 后返回 {}；`electron/settings.ts` 同样剥 BOM。新增两例测试（BOM 能读、坏文件能留档并继续列出包）。
- 缺陷 D-B：`src/components/start/StartView.tsx:191` 写「设置 → API 密钥」，设置页那栏其实叫「API 库」，已改。
- 缺陷 D-C：卸载面板把安装目录里 Electron 运行时的每个文件单独列一行（`libEGL.dll`、`LICENSES.chromium.html`、`resources` 5369 个文件…几十行噪音）。`electron/uninstall-plan.ts` 现在把所有「别人的内容」聚合成一条 `install-dir-keep-other`（`安装目录里的其他内容（N 项）`，`path` = 安装目录，`fileCount`/`sizeBytes` 求和），警告里只点前 20 个名字。测试新增「成百上千个文件也只聚合成一行」。
- 缺陷 D-D：技能页「工作区技能」多出一个「全局 0 个」的空分组。根因是 `electron/workspace-skills.ts:216` 把全局组也塞进 `workspaces`，而界面自己已经按 `scope === 'global'` 建了同名分组，于是撞 key、还多出一行带路径的空组。现在后端只返回真实工作区，界面再兜一层 `workspace.id === 'global'` 跳过。
- 回归：`npx tsc --noEmit` 0 error；`npx vitest run` 133 文件通过 / 9 跳过，1213 passed / 11 skipped（1224）。提交线 `a5391dd → 4e3986b → cb6d0f4`，工作树干净。
- b10 产物（`release\b10\`）：便携 `DSH-launcher-KEWU-Portable-1.0.4.exe` 92,600,537 字节 SHA256 `21C343C3075279C4D957EA0F9676121A2680390435E26ED9013AC7260B173D45`；安装包 `DSH-launcher-KEWU-Setup-1.0.4.exe` 104,059,706 字节 SHA256 `E3DB50BF484AEC05153B5D5C6431ECBBFDAEF2E56B6AA0BE8A7744F2AB20D51B`；卸载器 `DSH-launcher-KEWU-Uninstaller-1.0.4.exe` 139,776 字节 SHA256 `606E33FCF39F249D180D1A8507959EF1B35298C92732FE39EF939CA20B56B68E`（源码未变）。三件已覆盖到交付目录 `D:\DSH-launcher-KEWU\`。
- 截图验收（21 张，`D:\engine\DSH\test\ui-shots\shots`，验收后已随测试目录删除）：整合包页 2 个包无红条；设置页滚到底能看到网络/关于/高级设置；「安装目录里的其他内容（20 项）171 MB / 5442 个文件」合并成一行；技能页不再出现空的「全局 0 个」分组。
- 实机烟测（`D:\engine\DSH\test\kewu-b10-smoke`，schtasks 一次性任务）：便携版同级生成 `launcher-data`，`storage info` 报 `source:"portable"`，`pack list` 只有默认 `web` 包、`pending list` 为空；清理时只杀自己那份进程（`3Lrfamgj…`），用户正在跑的实例（wrapper PID 1316、`3LmuQHcM…`）未触碰。
- 未验证：卸载器 EXE 里没有「安装目录里的其他内容」这一概念（它本来就只列 exe/data/pointer/registry/temp 五类），所以 D-C 只影响启动器内的卸载面板；界面上的修复靠截图复核，没有真鼠标点击。

## 空闲自动关机、未托管实例认领、运行中改资源与 b12 三件产物（2026-11-10）
- 用户 m05573 提了六件事：空闲自动关机（方案 A，判定 10 分钟、可配置、启动页开关默认关、先停包再关机、系统通知、10 分钟内可取消）、认出启动器之外还在跑的 DSH、整合包配置页加「改名」「打开文件夹」、修管理员模式启动失败并让已提权的启动器直接继承、包运行中也能改插件/技能（下次启动生效）、全部做完再一起出包。
- 契约（`e15ffe5`）：`AppSettings` 加 `shutdownWhenIdle`（默认 false）/`shutdownIdleMinutes`（10）/`shutdownGraceMinutes`（10）/`shutdownStopPacks`（true）；新增 `IdleShutdownPhase = 'off' | 'waiting' | 'armed'`、`IdleShutdownState`（含 `busy` 与 `message`）与 `LauncherApi.idleShutdown.{get,arm,disarm,cancel}`；IPC 四键 `idle-shutdown:get|arm|disarm|cancel`；`PackStatus` 补 `homePath`。
- 空闲关机后端（`d91f31c`、`3aba105`，子代理 e4cc10d2）：新建 `electron/idle-shutdown.ts`（381 行）— 15 秒轮询、5 秒探测超时、20 秒停包预算，`serial()` 串行 + `shuttingDown` 互斥防双关机；`seenRunning` 保证「从没跑过包」不会直接进入关机倒计时；拿不到地址、RPC 失败一律 **fail closed 按忙**；到点先复查，仍有活动就退回 `waiting` 重新计时；`cancel` 只取消本轮、`disarm` 顺手把开关写回 false。`electron/idle-shutdown-ipc.ts` 注册四键。`electron/pending-resume.ts` 顺手抽出可复用的 `parsePackBaseUrl` / `readRunningSessions`（`/connect?token=` 换 cookie → `POST /api/session/list` 过滤 `status === 'running'`），原 11 例全绿。
- 关机动作只在 Windows 上执行：`shutdown.exe /s /t 0 /c "KEWU: 所有整合包空闲，自动关机"`；停包用 `pack.stop` 且带 `noElevated`（此刻界面可能已关，没人能点 UAC）。
- 未托管实例算忙（`51786a7`、`4e05fd1`，父级自己改）：`electron/main.ts` 的 `listRunningPacks` 改走 `packControl.execute({ command: 'pack.list' })`，把 `runtime.running` 与 `externalRuntime` 一并带回；未托管实例给 `unmanaged: true` + 原因文案，判定里算 **activity**（不是「无法确认」），界面文案「还有整合包在运行，暂不关机」。
- 管理员模式启动失败真因（`52ca49e`，子代理 68834409）：`electron/elevated-runtime.ts` 生成 `$hideConsole` 脚本块少一个右花括号，整段 PowerShell 解析失败（`MissingEndCurlyBrace`，supervise.ps1:5 char 16），而这一行正是上一轮「隐藏提权窗口」引入的。已补括号并加「supervise.ps1 括号配平」回归断言。同时新增 `electron/process-elevation.ts`（`OpenProcessToken` + `TokenElevation`，缓存、非 win32 不探测），启动器本身已是管理员时直接普通 spawn 并提示「启动器已以管理员身份运行，整合包直接继承管理员权限，不再弹出 UAC」。
- 运行中改资源（同一提交）：删掉 `pack-control` 里 `Stop this pack before changing its resources` 的硬拦截；包在跑时如果写家目录撞 `EPERM/EBUSY/EACCES/ENOTEMPTY/EISDIR/EROFS`，翻成中文「整合包「x」正在运行，这次改动没能写进它的家目录（code）…原始错误」。界面在插件/技能子页提示「下次启动生效」。
- 界面（`44ec0be`，子代理 e0a0a08f）：启动页余额卡与数据面板之间加「任务完成后自动关机」卡（5 秒轮询、`waiting` 显示空闲判定与 `busy` 逐行、`armed` 显示「将于 HH:MM 关机」+「取消本次关机」）；设置页加空闲分钟（1–1440）与取消时间（0–60）两栏；整合包配置浮层标题旁加「改名」（行内 Enter/Esc）与「打开文件夹」。
- 回归：`npx tsc --noEmit` 0 error；`npx vitest run` **137 文件通过 / 9 跳过，1270 passed / 11 skipped（1281）**；`npm run build` 通过。提交线 `e15ffe5 → 44ec0be → 52ca49e → d91f31c → 3aba105 → 51786a7 → 4e05fd1`，工作树干净。
- b12 三件产物（`release\b12\`，NSIS 仍在 `D:\engine\DSH\test\kewu-b12-nsis` 里构建后复制回来）：便携 `DSH-launcher-KEWU-Portable-1.0.4.exe` 92,613,741 字节 SHA256 `01E04CC48ADF52D71DE88C742676EBA493A4B3E3B9412DB6C6BAA1C46E411E57`；安装包 `DSH-launcher-KEWU-Setup-1.0.4.exe` 104,141,360 字节 SHA256 `A4A8044123755727B9E26CE2A6EB9228FB4E02281D036CCF5392BA689B922927`；卸载器 139,776 字节 SHA256 `606E33FCF39F249D180D1A8507959EF1B35298C92732FE39EF939CA20B56B68E`（源码未变）。三件已覆盖到 `D:\DSH-launcher-KEWU\`。
- 实机烟测（`D:\engine\DSH\test\kewu-b12-smoke`，便携 EXE 用 schtasks 一次性任务拉起，数据目录用同级 `launcher-storage.json` 指针指定）：12 秒生成 `launcher-data`；`--ui-shots` 出 21 张截图，启动页确认「任务完成后自动关机」卡（默认未开启）与余额 29.97 CNY；CLI `idle-shutdown status/arm/disarm`、`settings get` 四字段、`pack list` 全部走通。
- 未托管实例的实测：另起一个 `node … --profile "pack-ghost"` 假 DSH（PID 9460），`pack list` 正确报 `externalRuntime {pid:9460,port:3098,requiresElevation:false}`；`idle-shutdown status` 在轮询一拍后给出 `busy:[{packId:'pack-ghost', reason:'有一份启动器没在托管的实例在运行（PID 9460）…'}]` 与「还有整合包在运行，暂不关机」。
- 空闲计时实测：把 `shutdownIdleMinutes` 改成 1 后，先出现「所有整合包都空闲，正在累计空闲时间」，约 1 分钟后转 `armed`（`shutdownAt` = +10 分钟、「将在 10 分钟后自动关机」），随即 `disarm` 回到 `off`；**真正的 `shutdown.exe` 执行没有实跑**（会关掉这台机器），列为未验证项。
- 清理：烟测实例（`%TEMP%\3Luq…`）、`kewu-b12-smoke`、`fake-dsh2`、`kewu-b11-*` 残留全部删除；用户当时正在跑的实例（`%TEMP%\3Lsd…`，数据 `D:\engine\DSH\launcher-data`）六个进程全程未触碰。


## 设置页卡顿、开机自启勾选、SmartScreen 与启动即提权（2026-11-12）

- 用户 m05871 四件事：①进设置页卡顿；②开机自启勾了没生效、再打开显示没勾；③首启被 SmartScreen 拦；④想加「启动器启动时默认以管理员身份运行」，之后内部操作复用该权限不再弹 UAC。
- 卡顿真因：`src/components/uninstall/UninstallPanel.tsx:81` 的 `useEffect(load,[load])` 挂载即调 `api.uninstall.plan()`，而 `electron/uninstall-plan.ts` 的 `defaultStatTree` 用 `readdirSync/statSync` 同步递归。同机实测：`C:\Users\kewu0\AppData\Roaming\dsh-launcher` 179,822 文件/3,598MB 用 6,767ms，`C:\Users\kewu0\.dsh` 67,495 文件/2,186MB 用 3,751ms，合计约 10.5 秒主进程阻塞。
- 卡顿修复（`a7f67a6` 后端 + `86fa74a` 前端）：`electron/uninstall-plan.ts` 新增 `resolveUninstallPaths`、`inspectInstallDir`、`statTreeAsync`（fs/promises BFS，`UNINSTALL_ASYNC_IO_CONCURRENCY = 8`）、`collectUninstallTreeSizes`、`createUninstallPlanAsync`；`electron/uninstall.ts` 改用异步版并加 `UNINSTALL_PLAN_CACHE_TTL_MS = 30_000` 进程内缓存（失败逐出）。界面改为按需扫描：首屏只有说明与「扫描本版内容」，有结果后才变「重新扫描」，扫描中 `aria-busy` 且动作按钮禁用。
- 自启「勾了没生效」的真因不是机制坏了：CLI `settings launch-at-login on` 会写 `"launchAtLogin": true` 并在 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` 建出 `"...\L.exe" --background`，重启后字段与注册项都还在；用户那次只是勾了复选框、没点底部「保存设置」，磁盘上始终是 false。改成即点即存：`SettingsHomeView.tsx` 的 `toggleLaunchAtLogin` 立刻 `onSave`，成功给 `role="status"`，失败 `role="alert"` 并回滚勾选，`loginBusy` 防连点。
- SmartScreen：`D:\engine\DSH\DSH-launcher-KEWU-Portable-1.0.4.exe` 的 `Get-AuthenticodeSignature` 为 NotSigned，也无 Zone.Identifier。未签名的新程序首启必然被拦一次，代码里没有开关能绕过，只能「更多信息 → 仍要运行」，或买 OV/EV 代码签名证书把发布者身份签进去。
- 启动即提权（`27e6fc4` 后端 + `86fa74a` 开关）：`AppSettings.launchElevated`（默认 false）；新建 `electron/startup-elevation.ts`——`ELEVATED_RELAUNCH_FLAG = '--elevated-relaunch'`、`shouldRelaunchElevated`（设置开着 + 不是提权重启 + 当前未提权）、`buildElevatedRelaunchArgs`（丢掉旧 flag 与两种写法的 `--data-dir`，补绝对路径数据目录）、`buildElevatedPowerShellCommand`（`Start-Process -Verb RunAs`，不加 `-Wait`）、`relaunchElevated`（失败/超时/非 win32 一律 warn + false，绝不抛）。提权后的实例继承管理员令牌，启动器内所有操作与托管包都不再各弹一次 UAC。
- 父级复核发现并退回的竞态（`f74ea18`）：`electron/main.ts:1182` 的 `app.requestSingleInstanceLock()` 早于提权判定，父进程持锁时提权子进程取锁失败立刻退出、父进程随后也 `quit`，用户看到「点了以后什么都没开」。修法：新增 `orchestrateElevationRelaunch({ releaseLock, acquireLock, relaunch })`，顺序固定 release → relaunch，失败才 acquire（抢不回锁返回 `'handed-over'` 直接交班）；`releaseLock` 抛错按 `'continued'` 处理。同时把提权门整体前移到 `createServices()` 之前（新增 `createLauncherSettingsStore`，`createServices(bootSettings)` 复用同一 store），避免 UAC 期间打断 `migrateLegacyPacks`。
- CLI 与文档：`settings launch-elevated on|off`，`settings get --json` 增 `launchElevated`；`docs/launcher-cli.md` 记下单实例锁交接与提权判定时序。
- 回归：`npx tsc --noEmit` 0 error；`npx vitest run` **139 文件通过 / 9 跳过，1301 passed / 11 skipped（1312）**；`npm run build` 通过。提交线 `86fa74a → a7f67a6 → 27e6fc4 → f74ea18 → aaa076a`（`aaa076a` 把子代理无权提交的 `src/types.ts` 契约补齐），工作树干净。
- b13 三件产物（`release\b13\`，NSIS 在 `D:\engine\DSH\test\kewu-b13-build\` 构建后复制回来，因为项目树带 Low 完整性标签无法执行中间安装器）：便携 `DSH-launcher-KEWU-Portable-1.0.4.exe` 92,619,277 字节 SHA256 `0F01C642A4C94668EA5C076D6A8654E1FAFE7744B6BD385C85E57EC789B6C129`；安装包 `DSH-launcher-KEWU-Setup-1.0.4.exe` 104,145,324 字节 SHA256 `D7283632631B7B38E8D46533DA0F9E8C76DF5F62E73A871B8314846622F664D7`；卸载器 `KEWU-Uninstaller.exe` 139,776 字节 SHA256 `7F2248AF2E60E7F792D7828008C71BEC137A3FF46B178181CE8360DF81834110`。三件已覆盖到 `D:\DSH-launcher-KEWU\`。
- 实机烟测（`D:\engine\DSH\test\kewu-b13-smoke`，schtasks 一次性任务拉起）：便携版 7 秒生成数据目录，`storage info` 报 `source:"argument"`；`settings launch-elevated on` 返回 `{"launchElevated":true}`，重启后进程表里出现 1 个等待授权的 `powershell.exe` 与 1 个 `consent.exe`（UAC 弹窗确实弹了）；无人可点，杀掉这两个进程模拟「拒绝」，启动器继续运行且控制服务仍应答（`settings get --json` 正常）——重新抢回单实例锁这条分支实测成立；带 `--elevated-relaunch` 启动则不再弹 UAC（防无限重启成立）。
- 安装版烟测：`Setup /S /D=…\app` 装出 85 个文件，运行后 `storage info` 报 `source:"install"` 且数据落在 `C:\Users\kewu0\AppData\Roaming\DSH-launcher-KEWU`，`pack list` 返回默认 web 包；静默卸载后程序目录消失、数据保留（`deleteAppDataOnUninstall:false` 语义成立）。
- 未验证项：UAC 点「是」后的成功交接（无人值守环境无法代点，只由 `tests/startup-elevation.test.ts` 19 例覆盖顺序语义）；登录自启的实际开机触发（只验证了注册表项写入/移除）；设置页新开关的真人点击（浏览器预览在本机起不来，改为 23 例组件测试 + 代码复核）。
- 清理：`kewu-b13-smoke`、`kewu-b13-inst`、`kewu-b13-build`、`%APPDATA%\DSH-launcher-KEWU` 与四个 schtasks 任务全部删除；用户正在跑的老实例（`D:\engine\DSH\launcher-data`）与 `%APPDATA%\dsh-launcher`、`C:\Users\kewu0\.dsh` 未触碰。


## 重启/停止缺陷、自更新发版 1.1.0 与签名管线（2026-11-12）

- 用户 m06121 四件事：重启后整合包显示「正在运行」却停不掉、不要在 D 盘根建交付目录、改版本号并推送云端+修好自更新、免费代码签名。
- #1 现场：`pack-control.json` 里 pack-test 是 `runAsAdmin:true`，提权监督进程等 UAC 27 秒才拉起 DSH，这期间 `pack list` 已经报 `running:true`（其实服务已起，只是没有状态）。真正卡死的四条：D1 `electron/runtime.ts:589` 先 `child=null` 再 killProcessTree，`electron/elevated-runtime.ts:107-118` 写完 stop 文件就硬等 15 秒并抛 `Elevated pack did not acknowledge stop`（UAC 未应答时监督进程还不存在），异常里又把 `child=running` 复原；D2 `electron/pack-control.ts:226` restart 中 stop 抛错即整条中断，`controllers.delete` 不执行；D3 `electron/runtime.ts:500` 就绪超时抛出时 child 已在 `:533` 赋值却没清零；D4 包内 agent 调 restart 会先杀掉自己。
- 修法（`d4415f8` 子代理 A）：`ELEVATED_STOP_ACK_MS=3000`、`ELEVATED_EXIT_WAIT_MS=20000` 与 `stopElevatedRuntime`（3 秒内没等到 child.json 就 taskkill 外层并按「已取消启动」处理；起来了最多等 20 秒，pid 仍活则抛中文错误并给出 taskkill 提示）；新增 `runtime.stop({force})`、`abortLaunch`、`awaitElevatedRuntime`；`pack.restart` 立即回 `{accepted:true,restarting:true}`；PackStatus 加 `restarting`/`awaitingAuthorization`/`lastError`。
- 第 2 轮（`1bce9e6`，父级退回两条）：不带 `--resume` 的 `pack.restart` 也要补投积压续接（`electron/launcher-control.ts:395-398`）；`pack.stop --force` 不再排在串行队列后面（`electron/pack-control.ts:189-215` 抽出 `stopPack`，`:286` 直接返回），并用 `restartEpochs` 让被强制停止作废的那轮重启不再把包拉起来。
- 界面（父级 `fc8f160`）：`src/components/PackDashboard.tsx:99-106` 显示「等待管理员授权／正在重启」与「重启中」标签，并给强制停止按钮；`lastError` 只在未运行时展示，避免把上一轮错误当现状。
- #3 自更新与发版（`b525b02` 子代理 B）：`electron/launcher-update.ts` 改用 `PORTABLE_ASSET_MARKER`/`SETUP_ASSET_MARKER` 加版本号比较挑资产（原来大小写敏感的 `-portable.exe` 判断永远匹配不上新命名）；`detectInstallMode` 区分 portable/installed/dev，安装版走 `applySetupInstaller`（detached `Setup /S`）而不是抛「仅支持便携版」；`src/constants.ts:16-18` 的 `LAUNCHER_RELEASE_REPOSITORY` 改成 `kewuuuu/DSH-Melody-Launcher-Overture`；版本号 1.1.0；新增 `scripts/release.mjs`（三件产物清单 + SHA256 交付表）与 `.github/workflows/release.yml`（版本一致校验、三件产物校验、可选签名、`gh release upload --clobber`）。
- `c50fb75` 修 `scripts/release.mjs` 默认目录：原来永远取「最大编号 + 1」，构建完再跑一次会跳到 `b15` 并报「还缺 3 件产物」；改为先找含当前版本便携版的最高编号目录，找不到才 +1，并补 `tests/release-script.test.ts` 4 例。
- #4 签名（`a1ffe05` 子代理 C）：`scripts/sign-windows.ps1`（`-Path` 支持文件或目录、时间戳重试、证书来自 `SIGN_CERT_BASE64`+`SIGN_CERT_PASSWORD` 或 `SIGN_THUMBPRINT`；没证书只打印「未配置签名证书，跳过签名」并 EXIT=0）、`.github/workflows/sign.yml`（workflow_dispatch，9 步）、`docs/signing.md`（Certum/SignPath/自签名/EV 的取舍）。本机无证书，b14 三件仍是 NotSigned——SmartScreen 只能靠证书与下载信誉解决，代码里关不掉。
- 回归：`npx tsc --noEmit` 0 error；`npx vitest run` **143 文件通过 / 9 跳过，1327 passed / 11 skipped（1338）**；`npm run build` 通过。提交线 `d4415f8 → fc8f160 → 1bce9e6 → a1ffe05 → b525b02 → c50fb75`。
- b14 三件产物（`release\b14\`，NSIS 仍在 `D:\engine\DSH\test\kewu-b14-build\` 构建后复制回来）：便携 `DSH-launcher-KEWU-Portable-1.1.0.exe` 92,623,798 字节 SHA256 `B3CD76C379857A28C421AF6008543562059CA7042B4A2CEFDE54C1A79DE8CF90`；安装包 `DSH-launcher-KEWU-Setup-1.1.0.exe` 104,153,393 字节 SHA256 `3AA9EFA4B62492C03AC372C6523B7BD4734993AFEC8DFB87EEE42B315517C679`；卸载器 `DSH-launcher-KEWU-Uninstaller-1.1.0.exe` 139,776 字节 SHA256 `F41B9EDFF7433E6C2E4A2FB0E2E00A215C17B6F920B18942328D6ACE32FD7FD9`。
- 实机烟测（`D:\engine\DSH\test\kewu-b14-*`，schtasks 一次性任务拉起）：便携版版本资源 FileVersion/ProductVersion 都是 1.1.0，`storage info` 报 `source:"portable"`，`pack list` 的 runtime 带 `restarting:false`/`lastError:null`；安装版 `Setup /S` 装出 85 个文件，运行后 `storage info` 报 `source:"install"`、数据落在 `%APPDATA%\DSH-launcher-KEWU`，静默卸载后程序目录整棵消失、数据保留（53 个文件）、HKCU 卸载项与用户快捷方式归零。
- 未验证项：真实 UAC 下重启/停止的成功交接（无人值守只能模拟「拒绝」）、GitHub Actions 实跑、真实证书签名、从旧版本实跑一次自更新升级。
- 清理：`kewu-b14-smoke`、`kewu-b14-inst`、`kewu-b14-build`、`%APPDATA%\DSH-launcher-KEWU`、烟测自解压目录 `%TEMP%\3M0ZdNrbT46vVjI7hWek9wshinJ` 与 schtasks 任务全部删除；用户正在跑的实例与其数据未触碰。
