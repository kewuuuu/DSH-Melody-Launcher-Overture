# KEWU 启动器卸载程序（独立 EXE）

单文件 WinForms 卸载程序，C# 5 + 系统自带 csc.exe 编译，不依赖 Node / npm / .NET SDK。
产物：`tools/uninstaller/bin/KEWU-Uninstaller.exe`（构建产物，不入库）。

## 构建

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-uninstaller.ps1
```

脚本优先用 `%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe`，找不到就回退 32 位
`Framework\v4.0.30319\csc.exe`；两者都没有会打印候选路径并以非零退出。编译失败时原样打印 csc 的
错误并以非零退出。`build/icon.ico` 存在时自动带上 `/win32icon`。

机器要求：装有 .NET Framework 4.x（Windows 10/11 默认自带）。没有时装不了运行环境，EXE 起不来。

## 图形界面

双击 EXE，自动扫描以下条目（勾选框 + 名称 + 路径 + 体积 + 默认动作）：

| id | 条目 | 默认 |
| --- | --- | --- |
| exe | 同目录下的启动器主程序 | 勾选（删除） |
| data | `<启动器目录>\launcher-data` | 不勾选（保留） |
| pointer | `<启动器目录>\launcher-storage.json` | 勾选 |
| registry-run | `HKCU\...\Run\electron.app.DSH Launcher` | 勾选 |
| temp-residue-3l* | `%TEMP%\3L*` 自解压残留 | 勾选；有进程正从该目录运行则改为保留且不可勾选 |
| installed-data | `%APPDATA%\KEWU-launcher` | 不勾选 |

`%APPDATA%\dsh-launcher` 与 `%USERPROFILE%\.dsh` 固定展示为「始终保留」，不参与删除。
「开始卸载」先弹确认框，执行前若发现启动器正从启动器目录 / 数据目录运行，会询问是否结束这些进程；
拒绝则什么都不删。日志实时显示在窗口里，并写入卸载程序同目录的 `uninstall-log.txt`（UTF-8 带 BOM）。

## 无界面模式（自动化用）

```powershell
# 只扫描，不删任何东西，退出码 0
KEWU-Uninstaller.exe --dir <启动器目录> --plan <输出 json 路径>

# 真删：delete 条目 + 自启项；数据目录要显式 --delete-data
KEWU-Uninstaller.exe --dir <启动器目录> --run --yes [--delete-data]
```

`--plan` 输出的 JSON：

```json
{
  "exePath": "...",
  "dataDir": "...",
  "items": [{ "id": "exe", "label": "...", "path": "...", "kind": "file|directory|registry",
              "sizeBytes": 0, "action": "delete|keep", "reason": "...", "defaultChecked": true }],
  "alwaysKeep": [{ "label": "...", "path": "...", "reason": "..." }],
  "runningProcesses": ["..."]
}
```

`--run` 的退出码：全部成功 0；有条目失败 1；缺 `--yes` 拒绝执行 2（不删任何东西）。
两种无人值守模式都不弹窗；命中进程占用只跳过并记录原因，绝不结束进程。日志默认写卸载程序同目录的
`uninstall-log.txt`，写不进去时退到 `%TEMP%\kewu-uninstall-<8位hex>.log` 并在 stdout 打印路径。

测试环境可用环境变量重定向，避免碰真实用户数据：

- `APPDATA` / `USERPROFILE` / `TEMP` / `TMP`：决定扫描到的数据目录与残留目录。
- `KEWU_UNINSTALLER_RUN_KEY`：替换自启项注册表路径（默认真实 Run 键）。

诊断用：`--selftest-gui` 只构建主窗体并创建句柄（不显示窗口、不删任何东西），成功返回 0，
用来在无桌面环境里确认 GUI 代码路径没有崩。

## 测试

```powershell
npx vitest run tests/uninstaller-exe.test.ts
```

EXE 不存在时整组测试跳过并打印原因（不判失败）。fixture 全部建在 `os.tmpdir()` 下，跑完删除，
不碰真实的 `%APPDATA%\dsh-launcher`、`%USERPROFILE%\.dsh` 和正在运行的启动器。
注意：测试会把 EXE 复制进 fixture 再运行——某些沙箱只允许子进程改动它自己临时根下的文件，
跨根调用 `--plan` / `--run` 会被拒成 UnauthorizedAccessException。
