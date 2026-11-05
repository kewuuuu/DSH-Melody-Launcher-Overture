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
