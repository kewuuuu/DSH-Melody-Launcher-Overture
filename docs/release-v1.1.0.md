# v1.1.0 — 自更新覆盖安装版

一句话版本：**安装版用户也能在启动器内自更新；资产匹配适配改名后的产物，发版流程固化成一键脚本。**

## 新功能

- `node scripts/release.mjs`：校验工作树、打印三件产物构建命令，产物齐了打印带 SHA256 的交付表；`--notes` 生成本文件的骨架。
- GitHub Actions 的 Release 现在同时上传便携版、安装包（Setup）与卸载器，并支持可选的代码签名。

## 修复

- 检查更新找不到便携版包：旧规则只认小写 `-portable.exe` 后缀，改名后的 `DSH-launcher-KEWU-Portable-1.1.0.exe` 命中不了。现在忽略大小写、按 `portable` 关键字匹配，多份时取版本号最大者。
- 安装版永远无法自更新：apply() 只认便携版并直接报「开发模式」。现在安装版会下载 Setup 并以独立进程启动安装程序（`/S`，需要管理员确认），真正的开发模式仍然拒绝。
- 自更新检查改指向 fork 的 Release：`kewuuuu/DSH-Melody-Launcher-Overture`。

## 升级说明

- 便携版：覆盖旧的 exe 即可。
- 安装版：直接运行 `DSH-launcher-KEWU-Setup-1.1.0.exe` 覆盖安装；也可以在启动器内点「检查更新」，它会下载 Setup 并启动安装程序（需要管理员确认）。
- 自更新与官方整合包的 Release 已迁到 `kewuuuu/DSH-Melody-Launcher-Overture`。

## 验证

- `npx tsc --noEmit` / `npx vitest run`：待填写
- 三件产物 SHA256：待填写（`node scripts/release.mjs` 会打印）

## 已知限制

- 产物未做代码签名，SmartScreen 拦截时选择「更多信息 → 仍要运行」。
