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
- 可运行副本：D:\launcher-preview\（目录版 DSH Launcher.exe、便携版 DSH-Launcher-1.0.4-portable.exe，以及独立配置启动脚本「启动新版启动器-独立配置.cmd」）。

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
- 交付副本：`D:\DSH-Launcher\DSH-Launcher.exe`（92,561,829 字节，SHA256 `A09E039AE8116AA9AC803B266F8F360EEC1F97B47F27DE29FA565947A25187C4`，目录内只有这一个文件）；该副本已实机启动验证并清空了测试产生的 `launcher-data`，首次双击会重新生成。
- 未验证：真实 UAC 提权启动、Windows 登录后自启的实际触发（只验证了注册表项写入与移除）、以及打包 EXE 的窗口截图（工具截屏对 Electron 窗口取不到画面）。

