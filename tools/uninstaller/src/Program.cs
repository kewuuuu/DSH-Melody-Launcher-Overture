// DSH-launcher-KEWU 卸载程序（独立单文件 WinForms EXE）。
//
// 只用系统自带的 .NET Framework 4.x + csc 编译（C# 5），不引第三方库、不联网。
// 本文件负责：路径/体积/进程工具、卸载条目扫描、--plan 的 JSON 输出、删除执行。
// 界面在 UninstallerForm.cs。
//
// 口径与 electron/uninstall-plan.ts 一致：只删「启动这个软件之后新增的内容」，
// %APPDATA%\dsh-launcher（旧版数据）与 ~\.dsh（DSH 家目录）永远只出现在「始终保留」区。

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32;

namespace KewuUninstaller
{
    /// <summary>一条卸载条目。</summary>
    internal sealed class UninstallItem
    {
        public string Id = "";
        public string Label = "";
        public string Path = "";
        /** file / directory / registry */
        public string Kind = "file";
        public long SizeBytes;
        /** 统计超过上限（5 万文件）时为 true，界面显示「> 5 万文件」。 */
        public bool SizeTruncated;
        public int FileCount;
        /** 默认动作：delete / keep。 */
        public string Action = "keep";
        public string Reason = "";
        public bool DefaultChecked;
        /** false = 不可勾选（例如有进程正从该目录运行）。 */
        public bool Checkable = true;

        public string SizeText
        {
            get { return PathUtil.FormatSize(SizeBytes, SizeTruncated); }
        }
    }

    /// <summary>始终保留、不可勾选的只读行。</summary>
    internal sealed class KeepItem
    {
        public string Label = "";
        public string Path = "";
        public string Reason = "";
    }

    internal sealed class ProcessInfo
    {
        public int Id;
        public string Name = "";
        public string ImagePath = "";
    }

    internal sealed class UninstallPlanModel
    {
        public string ExeDir = "";
        public string ExePath = "";
        public string DataDir = "";
        public List<UninstallItem> Items = new List<UninstallItem>();
        public List<KeepItem> AlwaysKeep = new List<KeepItem>();
        /** 正从启动器目录/数据目录里运行的进程（跑 --plan 时只提示，不阻塞）。 */
        public List<ProcessInfo> RunningProcesses = new List<ProcessInfo>();
        public List<string> Warnings = new List<string>();
    }

    internal sealed class RemoveResult
    {
        public bool Ok;
        public bool Skipped;
        public string Message = "";
    }

    internal sealed class UninstallOutcome
    {
        public int Deleted;
        public int Skipped;
        public int Failed;
        public List<string> Failures = new List<string>();
    }

    /// <summary>路径比较、体积格式化、进程映像路径。</summary>
    internal static class PathUtil
    {
        private const uint ProcessQueryLimitedInformation = 0x1000;

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr OpenProcess(uint desiredAccess, bool inheritHandle, int processId);

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern bool QueryFullProcessImageName(IntPtr processHandle, uint flags, StringBuilder exeName, ref int size);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr handle);

        public static string Normalize(string target)
        {
            if (string.IsNullOrEmpty(target)) return "";
            string full = target;
            try { full = Path.GetFullPath(target); }
            catch (Exception) { }
            return full.Trim().TrimEnd('\\', '/').ToLowerInvariant();
        }

        public static bool IsSamePath(string left, string right)
        {
            if (string.IsNullOrEmpty(left) || string.IsNullOrEmpty(right)) return false;
            return string.Equals(Normalize(left), Normalize(right), StringComparison.Ordinal);
        }

        public static bool IsInside(string child, string parent)
        {
            string c = Normalize(child);
            string p = Normalize(parent);
            if (c.Length == 0 || p.Length == 0) return false;
            if (string.Equals(c, p, StringComparison.Ordinal)) return false;
            return c.StartsWith(p + "\\", StringComparison.Ordinal) || c.StartsWith(p + "/", StringComparison.Ordinal);
        }

        /// <summary>imagePath 命中目录本身或其子路径。</summary>
        public static bool Covers(string imagePath, string dir)
        {
            if (string.IsNullOrEmpty(imagePath) || string.IsNullOrEmpty(dir)) return false;
            return IsSamePath(imagePath, dir) || IsInside(imagePath, dir);
        }

        /// <summary>把路径规范成绝对路径与统一的分隔符；失败就用原值。</summary>
        public static string FullPathOrSelf(string target)
        {
            if (string.IsNullOrEmpty(target)) return "";
            try { return Path.GetFullPath(target).TrimEnd('\\'); }
            catch (Exception) { return target.TrimEnd('\\'); }
        }

        /// <summary>%APPDATA%：优先环境变量（自动化测试可重定向），退化到系统文件夹。</summary>
        public static string AppDataDir()
        {
            string fromEnv = Environment.GetEnvironmentVariable("APPDATA");
            if (!string.IsNullOrEmpty(fromEnv)) return FullPathOrSelf(fromEnv);
            return FullPathOrSelf(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData));
        }

        /// <summary>%USERPROFILE%：同上。</summary>
        public static string UserProfileDir()
        {
            string fromEnv = Environment.GetEnvironmentVariable("USERPROFILE");
            if (!string.IsNullOrEmpty(fromEnv)) return FullPathOrSelf(fromEnv);
            return FullPathOrSelf(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile));
        }

        /// <summary>「12.3 MB」这种格式。</summary>
        public static string FormatSize(long bytes, bool truncated)
        {
            if (truncated) return "> 5 万文件";
            long value = bytes < 0 ? 0 : bytes;
            if (value < 1024) return value.ToString(CultureInfo.InvariantCulture) + " B";
            double amount = value;
            string unit = "KB";
            amount = amount / 1024d;
            if (amount >= 1024d) { amount = amount / 1024d; unit = "MB"; }
            if (amount >= 1024d) { amount = amount / 1024d; unit = "GB"; }
            return amount.ToString("0.0", CultureInfo.InvariantCulture) + " " + unit;
        }

        public static string GetImagePath(int processId)
        {
            IntPtr handle = IntPtr.Zero;
            try
            {
                handle = OpenProcess(ProcessQueryLimitedInformation, false, processId);
                if (handle == IntPtr.Zero) return null;
                int capacity = 2048;
                StringBuilder buffer = new StringBuilder(capacity);
                int size = capacity;
                if (!QueryFullProcessImageName(handle, 0, buffer, ref size)) return null;
                if (size <= 0 || size > buffer.Length) return null;
                string path = buffer.ToString(0, size);
                return string.IsNullOrEmpty(path) ? null : path;
            }
            catch (Exception)
            {
                return null;
            }
            finally
            {
                if (handle != IntPtr.Zero) CloseHandle(handle);
            }
        }

        /// <summary>取所有进程的映像路径；取不到的进程直接跳过。</summary>
        public static List<ProcessInfo> ListProcesses()
        {
            List<ProcessInfo> result = new List<ProcessInfo>();
            Process[] all;
            try { all = Process.GetProcesses(); }
            catch (Exception) { return result; }
            for (int i = 0; i < all.Length; i++)
            {
                Process process = all[i];
                try
                {
                    int id = process.Id;
                    string imagePath = GetImagePath(id);
                    if (string.IsNullOrEmpty(imagePath)) continue;
                    ProcessInfo info = new ProcessInfo();
                    info.Id = id;
                    info.ImagePath = imagePath;
                    try { info.Name = process.ProcessName + ".exe"; }
                    catch (Exception) { info.Name = Path.GetFileName(imagePath); }
                    result.Add(info);
                }
                catch (Exception)
                {
                }
                finally
                {
                    try { process.Dispose(); } catch (Exception) { }
                }
            }
            return result;
        }
    }

    /// <summary>文件系统枚举/删除：\?\ 前缀 + Win32 API，绕开 .NET 的 260 字符上限。</summary>
    internal sealed class FsEntry
    {
        public string Name = "";
        public long Size;
        public bool IsDirectory;
        public bool IsReparsePoint;
    }

    internal static class NativeFs
    {
        private const uint FileAttributeDirectory = 0x10;
        private const uint FileAttributeReparsePoint = 0x400;
        private const uint FileAttributeReadOnly = 0x1;
        private const uint InvalidFileAttributes = 0xFFFFFFFF;

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct WIN32_FIND_DATAW
        {
            public uint dwFileAttributes;
            public uint ftCreationLow;
            public uint ftCreationHigh;
            public uint ftAccessLow;
            public uint ftAccessHigh;
            public uint ftWriteLow;
            public uint ftWriteHigh;
            public uint nFileSizeHigh;
            public uint nFileSizeLow;
            public uint dwReserved0;
            public uint dwReserved1;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
            public string cFileName;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 14)]
            public string cAlternateFileName;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr FindFirstFileW(string pattern, out WIN32_FIND_DATAW data);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool FindNextFileW(IntPtr handle, out WIN32_FIND_DATAW data);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool FindClose(IntPtr handle);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern uint GetFileAttributesW(string path);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool SetFileAttributesW(string path, uint attributes);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool DeleteFileW(string path);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool RemoveDirectoryW(string path);

        /// <summary>加 \?\ 前缀（UNC 走 \?\UNC\），已经是带前缀的原样返回。</summary>
        public static string Long(string target)
        {
            if (string.IsNullOrEmpty(target)) return target;
            if (target.StartsWith(@"\\?\", StringComparison.Ordinal)) return target;
            if (target.StartsWith(@"\\", StringComparison.Ordinal)) return @"\\?\UNC\" + target.Substring(2);
            return @"\\?\" + target;
        }

        public static uint Attributes(string path)
        {
            if (string.IsNullOrEmpty(path)) return InvalidFileAttributes;
            return GetFileAttributesW(Long(path));
        }

        public static bool Exists(string path)
        {
            return Attributes(path) != InvalidFileAttributes;
        }

        public static bool DirectoryExists(string path)
        {
            uint attributes = Attributes(path);
            return attributes != InvalidFileAttributes && (attributes & FileAttributeDirectory) != 0;
        }

        public static bool FileExists(string path)
        {
            uint attributes = Attributes(path);
            return attributes != InvalidFileAttributes && (attributes & FileAttributeDirectory) == 0;
        }

        /// <summary>列一层子项；列不出来就返回空表（调用方自己决定算不算失败）。</summary>
        public static List<FsEntry> List(string dir)
        {
            List<FsEntry> entries = new List<FsEntry>();
            if (string.IsNullOrEmpty(dir)) return entries;
            string pattern = Long(dir.TrimEnd('\\')) + @"\*";
            WIN32_FIND_DATAW data;
            IntPtr handle = FindFirstFileW(pattern, out data);
            if (handle == new IntPtr(-1)) return entries;
            try
            {
                while (true)
                {
                    string name = data.cFileName;
                    if (!string.IsNullOrEmpty(name) && name != "." && name != "..")
                    {
                        FsEntry entry = new FsEntry();
                        entry.Name = name;
                        entry.Size = ((long)data.nFileSizeHigh << 32) + data.nFileSizeLow;
                        entry.IsDirectory = (data.dwFileAttributes & FileAttributeDirectory) != 0;
                        entry.IsReparsePoint = (data.dwFileAttributes & FileAttributeReparsePoint) != 0;
                        entries.Add(entry);
                    }
                    if (!FindNextFileW(handle, out data)) break;
                }
            }
            finally
            {
                FindClose(handle);
            }
            return entries;
        }

        public static bool ClearReadOnly(string path)
        {
            uint attributes = Attributes(path);
            if (attributes == InvalidFileAttributes) return false;
            if ((attributes & FileAttributeReadOnly) == 0) return true;
            return SetFileAttributesW(Long(path), attributes & ~FileAttributeReadOnly);
        }

        public static bool DeleteFile(string path)
        {
            if (string.IsNullOrEmpty(path)) return false;
            ClearReadOnly(path);
            return DeleteFileW(Long(path));
        }

        public static bool RemoveDirectory(string path)
        {
            if (string.IsNullOrEmpty(path)) return false;
            return RemoveDirectoryW(Long(path));
        }

        public static string LastError()
        {
            int code = Marshal.GetLastWin32Error();
            return "错误码 " + code;
        }
    }

    /// <summary>目录树体积；超过 5 万文件就停，不把界面拖死。</summary>
    internal sealed class TreeMeasure
    {
        public const int EntryLimit = 50000;

        public long Bytes;
        public int Files;
        public bool Truncated;

        /// <summary>不存在或读不到时返回 null。</summary>
        public static TreeMeasure Measure(string target)
        {
            if (string.IsNullOrEmpty(target)) return null;
            TreeMeasure info = new TreeMeasure();

            if (NativeFs.FileExists(target))
            {
                try
                {
                    info.Bytes = new FileInfo(target).Length;
                    info.Files = 1;
                }
                catch (Exception)
                {
                }
                return info;
            }
            if (!NativeFs.DirectoryExists(target)) return null;

            bool touched = false;
            int visited = 0;
            HashSet<string> seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            Stack<string> pending = new Stack<string>();
            pending.Push(target);

            while (pending.Count > 0)
            {
                if (visited >= EntryLimit) { info.Truncated = true; break; }
                string current = pending.Pop();
                string key = PathUtil.Normalize(current);
                if (!seen.Add(key)) continue;

                if (!NativeFs.DirectoryExists(current)) continue;
                touched = true;

                List<FsEntry> entries = NativeFs.List(current);
                for (int i = 0; i < entries.Count; i++)
                {
                    FsEntry entry = entries[i];
                    if (entry.IsDirectory)
                    {
                        // 不跟符号链接/联接点走，避免成环。
                        if (!entry.IsReparsePoint) pending.Push(current.TrimEnd('\\') + "\\" + entry.Name);
                        continue;
                    }
                    info.Bytes += entry.Size;
                    info.Files++;
                    visited++;
                    if (visited >= EntryLimit) { info.Truncated = true; break; }
                }
                if (info.Truncated) break;
            }

            if (!touched) return null;
            return info;
        }
    }

    /// <summary>递归删除目录树：全程走 Win32 + \?\ 前缀，超过 260 字符的 node_modules 也能删。</summary>
    internal static class TreeDelete
    {
        public static void DeleteTree(string target)
        {
            if (string.IsNullOrEmpty(target)) return;
            if (!NativeFs.DirectoryExists(target)) return;
            List<string> blocked = new List<string>();
            DeleteInto(target.TrimEnd('\\'), blocked);
            if (blocked.Count > 0)
                throw new IOException("还有 " + blocked.Count + " 项删不掉，第一个是：" + blocked[0]);
            if (NativeFs.DirectoryExists(target)) throw new IOException("目录仍然存在：" + target);
        }

        private static void DeleteInto(string dir, List<string> blocked)
        {
            List<FsEntry> entries = NativeFs.List(dir);
            for (int i = 0; i < entries.Count; i++)
            {
                FsEntry entry = entries[i];
                string child = dir + "\\" + entry.Name;
                if (entry.IsDirectory)
                {
                    if (entry.IsReparsePoint)
                    {
                        // 联接点/符号链接只删链接本身，不跟进去，避免删到别处。
                        if (!NativeFs.RemoveDirectory(child)) blocked.Add(child + "（" + NativeFs.LastError() + "）");
                        continue;
                    }
                    DeleteInto(child, blocked);
                    continue;
                }
                if (!NativeFs.DeleteFile(child)) blocked.Add(child + "（" + NativeFs.LastError() + "）");
            }
            if (!NativeFs.RemoveDirectory(dir)) blocked.Add(dir + "（" + NativeFs.LastError() + "）");
        }
    }
    internal static class JsonText
    {
        public static string Escape(string value)
        {
            if (string.IsNullOrEmpty(value)) return "";
            StringBuilder sb = new StringBuilder(value.Length + 8);
            for (int i = 0; i < value.Length; i++)
            {
                char c = value[i];
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\b': sb.Append("\\b"); break;
                    case '\f': sb.Append("\\f"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < ' ') sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                        else sb.Append(c);
                        break;
                }
            }
            return sb.ToString();
        }
    }

    /// <summary>扫描并算出卸载计划；纯读，不改任何东西。</summary>
    internal static class UninstallPlanBuilder
    {
        public const string StorageDataDirName = "launcher-data";
        public const string StoragePointerFileName = "launcher-storage.json";
        public const string InstalledDataDirName = "DSH-launcher-KEWU";
        public const string LegacyDataDirName = "dsh-launcher";
        public const string DshHomeName = ".dsh";
        public const string RunKeyPath = @"Software\Microsoft\Windows\CurrentVersion\Run";
        public const string LoginItemName = "electron.app.DSH-launcher-KEWU";
        public const string TempResiduePrefix = "3l";
        /// <summary>名字里带这些词的一律不是启动器主程序：卸载器自身（真实文件名可能带版本号）或安装包。</summary>
        public static readonly string[] ExcludedNameTokens = new string[] { "uninstall", "setup" };
        /// <summary>看起来像启动器主程序的名字线索，按优先级排列：越靠前越优先。</summary>
        public static readonly string[] LauncherNameHints = new string[] { "kewu", "dsh", "melody", "launcher" };

        public static string CurrentExecutablePath()
        {
            try
            {
                Assembly assembly = Assembly.GetExecutingAssembly();
                if (assembly != null && !string.IsNullOrEmpty(assembly.Location)) return assembly.Location;
            }
            catch (Exception)
            {
            }
            try { return Process.GetCurrentProcess().MainModule.FileName; }
            catch (Exception) { }
            return "";
        }

        /// <summary>路径规范化：失败时退回原样，避免空串被当成"相等"。</summary>
        private static string FullPathOrSelf(string path)
        {
            if (string.IsNullOrEmpty(path)) return "";
            try { return System.IO.Path.GetFullPath(path); }
            catch (Exception) { return path; }
        }

        /// <summary>
        /// 在启动器目录里挑出启动器主程序：
        /// ① 按完整路径排除卸载程序自身（忽略大小写，文件名带不带版本号都成立）；
        /// ② 排除名字里含 uninstall 的任意文件、含 setup 的安装包；
        /// ③ 剩下的按 KEWU / DSH / Melody / Launcher 的先后顺序找第一个命中者（同档内按文件名顺序，先匹配到优先）；
        /// ④ 一个都不像时才回退到第一个非自身、非卸载器、非 setup 的 exe；
        /// ⑤ 没有合格候选就返回空串，让上层提示"没找到启动器主程序"，绝不删错文件。
        /// </summary>
        public static string FindLauncherExe(string exeDir, string selfExeName)
        {
            if (string.IsNullOrEmpty(exeDir)) return "";
            string[] files;
            try { files = Directory.GetFiles(exeDir, "*.exe"); }
            catch (Exception) { return ""; }
            Array.Sort(files, StringComparer.OrdinalIgnoreCase);

            string selfPath = FullPathOrSelf(CurrentExecutablePath());
            List<string> candidates = new List<string>();
            for (int i = 0; i < files.Length; i++)
            {
                string name = System.IO.Path.GetFileName(files[i]);
                string full = FullPathOrSelf(files[i]);
                if (selfPath.Length > 0 && string.Equals(full, selfPath, StringComparison.OrdinalIgnoreCase)) continue;
                if (!string.IsNullOrEmpty(selfExeName) && string.Equals(name, selfExeName, StringComparison.OrdinalIgnoreCase)) continue;
                bool excluded = false;
                for (int t = 0; t < ExcludedNameTokens.Length; t++)
                {
                    if (name.IndexOf(ExcludedNameTokens[t], StringComparison.OrdinalIgnoreCase) >= 0) { excluded = true; break; }
                }
                if (excluded) continue;
                candidates.Add(full);
            }

            for (int h = 0; h < LauncherNameHints.Length; h++)
            {
                for (int i = 0; i < candidates.Count; i++)
                {
                    if (System.IO.Path.GetFileName(candidates[i]).IndexOf(LauncherNameHints[h], StringComparison.OrdinalIgnoreCase) >= 0) return candidates[i];
                }
            }

            return candidates.Count > 0 ? candidates[0] : "";
        }

        /// <summary>自启项注册表路径：允许用环境变量重定向（自动化测试用，避免碰真实自启项）。</summary>
        public static string EffectiveRunKeyPath()
        {
            string overridePath = Environment.GetEnvironmentVariable("KEWU_UNINSTALLER_RUN_KEY");
            if (!string.IsNullOrEmpty(overridePath)) return overridePath;
            return RunKeyPath;
        }

        /// <summary>把 HKCU\... 形式转成 Registry.CurrentUser.OpenSubKey 能用的相对路径。</summary>
        public static string RegistrySubKeyPath()
        {
            string path = EffectiveRunKeyPath();
            if (string.IsNullOrEmpty(path)) return path;
            string[] prefixes = new string[] { "HKEY_CURRENT_USER\\", "HKEY_CURRENT_USER", "HKCU\\", "HKCU" };
            for (int i = 0; i < prefixes.Length; i++)
            {
                if (path.StartsWith(prefixes[i], StringComparison.OrdinalIgnoreCase))
                {
                    path = path.Substring(prefixes[i].Length);
                    break;
                }
            }
            return path.TrimStart('\\');
        }

        public static bool RunValueExists()
        {
            try
            {
                using (RegistryKey key = Registry.CurrentUser.OpenSubKey(RegistrySubKeyPath()))
                {
                    if (key == null) return false;
                    return key.GetValue(LoginItemName) != null;
                }
            }
            catch (Exception)
            {
                return false;
            }
        }

        public static List<string> ListTempResidues(string tempDir)
        {
            List<string> result = new List<string>();
            if (string.IsNullOrEmpty(tempDir) || !Directory.Exists(tempDir)) return result;
            string[] dirs;
            try { dirs = Directory.GetDirectories(tempDir); }
            catch (Exception) { return result; }
            Array.Sort(dirs, StringComparer.OrdinalIgnoreCase);
            for (int i = 0; i < dirs.Length; i++)
            {
                string name = System.IO.Path.GetFileName(dirs[i]);
                if (name.ToLowerInvariant().StartsWith(TempResiduePrefix, StringComparison.Ordinal)) result.Add(dirs[i]);
            }
            return result;
        }

        private static UninstallItem NewItem(string id, string label, string path, string kind, TreeMeasure size)
        {
            UninstallItem item = new UninstallItem();
            item.Id = id;
            item.Label = label;
            // 注册表项不是文件路径，别拿去 GetFullPath。
            item.Path = string.Equals(kind, "registry", StringComparison.OrdinalIgnoreCase) ? path : PathUtil.FullPathOrSelf(path);
            item.Kind = kind;
            if (size != null)
            {
                item.SizeBytes = size.Bytes;
                item.FileCount = size.Files;
                item.SizeTruncated = size.Truncated;
            }
            return item;
        }

        public static UninstallPlanModel Build(string exeDir, string selfExeName)
        {
            UninstallPlanModel plan = new UninstallPlanModel();
            plan.ExeDir = exeDir;
            plan.DataDir = System.IO.Path.Combine(exeDir, StorageDataDirName);
            plan.ExePath = FindLauncherExe(exeDir, selfExeName);

            int selfPid = 0;
            try { selfPid = Process.GetCurrentProcess().Id; }
            catch (Exception) { }
            string selfPath = CurrentExecutablePath();
            List<ProcessInfo> processes = PathUtil.ListProcesses();

            // 1. 启动器主程序：默认删除。
            if (!string.IsNullOrEmpty(plan.ExePath))
            {
                UninstallItem item = NewItem("exe", "启动器主程序", plan.ExePath, "file", TreeMeasure.Measure(plan.ExePath));
                item.Action = "delete";
                item.DefaultChecked = true;
                plan.Items.Add(item);
            }
            else
            {
                plan.Warnings.Add("没找到启动器主程序，请把卸载程序放到启动器 EXE 同目录（本次只能清理数据与自启项：" + exeDir + "）");
            }

            // 2. 本版数据目录：默认保留。
            {
                TreeMeasure size = TreeMeasure.Measure(plan.DataDir);
                UninstallItem item = NewItem("data", "本版数据目录", plan.DataDir, "directory", size);
                item.Action = "keep";
                item.DefaultChecked = false;
                item.Reason = size == null ? "本版数据目录不存在，没有可删除的内容" : "默认保留本版数据目录（勾选后才会删除）";
                plan.Items.Add(item);
            }

            // 3. 数据目录指针文件：存在才列，默认删除。
            string pointerFile = System.IO.Path.Combine(exeDir, StoragePointerFileName);
            if (File.Exists(pointerFile))
            {
                UninstallItem item = NewItem("pointer", "数据目录指针文件", pointerFile, "file", TreeMeasure.Measure(pointerFile));
                item.Action = "delete";
                item.DefaultChecked = true;
                plan.Items.Add(item);
            }

            // 4. 开机自启项：存在才列，默认删除。
            if (RunValueExists())
            {
                UninstallItem item = NewItem("registry-run", "开机自启项", EffectiveRunKeyPath() + "\\" + LoginItemName, "registry", null);
                item.Action = "delete";
                item.DefaultChecked = true;
                plan.Items.Add(item);
            }

            // 5. %TEMP% 里的 3L* 自解压残留：有进程住在里面就改成不可勾选、保留。
            string tempDir = System.IO.Path.GetTempPath();
            List<string> residues = ListTempResidues(tempDir);
            for (int i = 0; i < residues.Count; i++)
            {
                string residue = residues[i];
                bool inUse = false;
                for (int p = 0; p < processes.Count; p++)
                {
                    if (processes[p].Id == selfPid) continue;
                    if (PathUtil.Covers(processes[p].ImagePath, residue)) { inUse = true; break; }
                }
                string name = System.IO.Path.GetFileName(residue);
                UninstallItem item = NewItem("temp-residue-" + name.ToLowerInvariant(), "便携版自解压残留", residue, "directory", TreeMeasure.Measure(residue));
                item.Action = inUse ? "keep" : "delete";
                item.DefaultChecked = !inUse;
                item.Checkable = !inUse;
                item.Reason = inUse ? "有进程正从这个目录运行（可能是另一个启动器实例），保留" : "";
                plan.Items.Add(item);
            }

            // 6. 安装版数据目录：存在才列，默认保留。
            string appData = PathUtil.AppDataDir();
            string installedData = string.IsNullOrEmpty(appData) ? "" : System.IO.Path.Combine(appData, InstalledDataDirName);
            if (!string.IsNullOrEmpty(installedData) && Directory.Exists(installedData))
            {
                UninstallItem item = NewItem("installed-data", "安装版数据目录", installedData, "directory", TreeMeasure.Measure(installedData));
                item.Action = "keep";
                item.DefaultChecked = false;
                item.Reason = "默认保留安装版数据目录（勾选后才会删除）";
                plan.Items.Add(item);
            }

            // 始终保留、不可勾选的两行：只显示路径，不统计体积（不碰用户数据）。
            plan.AlwaysKeep.Add(NewKeep("旧版启动器数据（" + LegacyDataDirName + "）",
                string.IsNullOrEmpty(appData) ? "%APPDATA%\\" + LegacyDataDirName : System.IO.Path.Combine(appData, LegacyDataDirName),
                "这是旧版启动器数据，按规则保留"));
            string profile = PathUtil.UserProfileDir();
            plan.AlwaysKeep.Add(NewKeep("DSH 家目录（" + DshHomeName + "）",
                string.IsNullOrEmpty(profile) ? "%USERPROFILE%\\" + DshHomeName : System.IO.Path.Combine(profile, DshHomeName),
                "这是 DSH 的家目录（会话、配置与运行时都在里面），按规则保留"));

            // 运行中守卫：正从启动器目录或数据目录里跑起来的进程（排除卸载程序自己）。
            for (int i = 0; i < processes.Count; i++)
            {
                ProcessInfo process = processes[i];
                if (process.Id == selfPid) continue;
                if (!string.IsNullOrEmpty(selfPath) && PathUtil.IsSamePath(process.ImagePath, selfPath)) continue;
                if (PathUtil.Covers(process.ImagePath, exeDir) || PathUtil.Covers(process.ImagePath, plan.DataDir))
                    plan.RunningProcesses.Add(process);
            }

            if (plan.RunningProcesses.Count > 0)
                plan.Warnings.Add("检测到 " + plan.RunningProcesses.Count + " 个进程正从启动器目录/数据目录运行。");

            return plan;
        }

        private static KeepItem NewKeep(string label, string path, string reason)
        {
            KeepItem item = new KeepItem();
            item.Label = label;
            item.Path = path;
            item.Reason = reason;
            return item;
        }
    }

    /// <summary>--plan 的 JSON：结构固定，UTF-8 无 BOM。</summary>
    internal static class PlanJson
    {
        public static string Serialize(UninstallPlanModel plan)
        {
            StringBuilder sb = new StringBuilder(4096);
            sb.Append("{\n");
            sb.Append("  \"exePath\": \"").Append(JsonText.Escape(plan.ExePath)).Append("\",\n");
            sb.Append("  \"dataDir\": \"").Append(JsonText.Escape(plan.DataDir)).Append("\",\n");

            sb.Append("  \"items\": [");
            for (int i = 0; i < plan.Items.Count; i++)
            {
                UninstallItem item = plan.Items[i];
                sb.Append(i == 0 ? "\n" : ",\n");
                sb.Append("    { \"id\": \"").Append(JsonText.Escape(item.Id));
                sb.Append("\", \"label\": \"").Append(JsonText.Escape(item.Label));
                sb.Append("\", \"path\": \"").Append(JsonText.Escape(item.Path));
                sb.Append("\", \"kind\": \"").Append(JsonText.Escape(item.Kind));
                sb.Append("\", \"sizeBytes\": ").Append(item.SizeBytes.ToString(CultureInfo.InvariantCulture));
                sb.Append(", \"action\": \"").Append(JsonText.Escape(item.Action));
                sb.Append("\", \"reason\": \"").Append(JsonText.Escape(item.Reason));
                sb.Append("\", \"defaultChecked\": ").Append(item.DefaultChecked ? "true" : "false");
                sb.Append(" }");
            }
            sb.Append(plan.Items.Count > 0 ? "\n  ],\n" : "],\n");

            sb.Append("  \"alwaysKeep\": [");
            for (int i = 0; i < plan.AlwaysKeep.Count; i++)
            {
                KeepItem item = plan.AlwaysKeep[i];
                sb.Append(i == 0 ? "\n" : ",\n");
                sb.Append("    { \"label\": \"").Append(JsonText.Escape(item.Label));
                sb.Append("\", \"path\": \"").Append(JsonText.Escape(item.Path));
                sb.Append("\", \"reason\": \"").Append(JsonText.Escape(item.Reason));
                sb.Append("\" }");
            }
            sb.Append(plan.AlwaysKeep.Count > 0 ? "\n  ],\n" : "],\n");

            sb.Append("  \"runningProcesses\": [");
            for (int i = 0; i < plan.RunningProcesses.Count; i++)
            {
                ProcessInfo process = plan.RunningProcesses[i];
                string text = process.ImagePath + " (" + process.Name + ", PID " + process.Id.ToString(CultureInfo.InvariantCulture) + ")";
                sb.Append(i == 0 ? "\n" : ",\n");
                sb.Append("    \"").Append(JsonText.Escape(text)).Append("\"");
            }
            sb.Append(plan.RunningProcesses.Count > 0 ? "\n  ]\n" : "]\n");
            sb.Append("}\n");
            return sb.ToString();
        }
    }

    /// <summary>真删：逐条来，删不掉的记错误继续下一条。</summary>
    internal static class UninstallRunner
    {
        public static bool KillProcesses(List<ProcessInfo> processes, Action<string> log)
        {
            bool allOk = true;
            for (int i = 0; i < processes.Count; i++)
            {
                ProcessInfo info = processes[i];
                try
                {
                    Process process = Process.GetProcessById(info.Id);
                    try
                    {
                        process.Kill();
                        if (process.WaitForExit(5000)) log("已结束进程：" + info.Name + "（PID " + info.Id + "）");
                        else { allOk = false; log("结束进程超时：" + info.Name + "（PID " + info.Id + "）"); }
                    }
                    finally
                    {
                        try { process.Dispose(); } catch (Exception) { }
                    }
                }
                catch (Exception ex)
                {
                    allOk = false;
                    log("结束进程失败：" + info.Name + "（PID " + info.Id + "）：" + ex.Message);
                }
            }
            return allOk;
        }

        public static RemoveResult Remove(UninstallItem item)
        {
            RemoveResult result = new RemoveResult();
            try
            {
                if (string.Equals(item.Kind, "registry", StringComparison.OrdinalIgnoreCase))
                {
                    using (RegistryKey run = Registry.CurrentUser.OpenSubKey(UninstallPlanBuilder.RegistrySubKeyPath(), true))
                    {
                        if (run == null)
                        {
                            result.Ok = true;
                            result.Skipped = true;
                            result.Message = "注册表项已不存在";
                            return result;
                        }
                        if (run.GetValue(UninstallPlanBuilder.LoginItemName) == null)
                        {
                            result.Ok = true;
                            result.Skipped = true;
                            result.Message = "注册表值已不存在";
                            return result;
                        }
                        run.DeleteValue(UninstallPlanBuilder.LoginItemName, false);
                    }
                    result.Ok = true;
                    return result;
                }

                if (string.Equals(item.Kind, "file", StringComparison.OrdinalIgnoreCase))
                {
                    if (!NativeFs.FileExists(item.Path))
                    {
                        result.Ok = true;
                        result.Skipped = true;
                        result.Message = "文件已不存在";
                        return result;
                    }
                    if (!NativeFs.DeleteFile(item.Path))
                    {
                        result.Ok = false;
                        result.Message = "删除文件失败（" + NativeFs.LastError() + "）：" + item.Path;
                        return result;
                    }
                    result.Ok = true;
                    return result;
                }

                if (!NativeFs.DirectoryExists(item.Path))
                {
                    result.Ok = true;
                    result.Skipped = true;
                    result.Message = "目录已不存在";
                    return result;
                }
                TreeDelete.DeleteTree(item.Path);
                result.Ok = true;
                return result;
            }
            catch (Exception ex)
            {
                result.Ok = false;
                result.Message = ex.GetType().Name + ": " + ex.Message;
                return result;
            }
        }
    }

    /// <summary>卸载日志：先写卸载程序同目录的 uninstall-log.txt（UTF-8 BOM），写不进去就退到 %TEMP%。</summary>
    internal sealed class LogSink : IDisposable
    {
        private StreamWriter _writer;
        private StreamWriter _stdout;
        private bool _stdoutTried;
        private bool _echo;

        public string LogPath = "";
        public string OpenError = "";

        public static LogSink Open(string preferredDir, bool echo)
        {
            LogSink sink = new LogSink();
            sink._echo = echo;
            string preferred = "";
            if (!string.IsNullOrEmpty(preferredDir)) preferred = System.IO.Path.Combine(preferredDir, "uninstall-log.txt");
            if (sink.TryOpen(preferred)) return sink;
            string fallback = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "kewu-uninstall-" + Guid.NewGuid().ToString("N").Substring(0, 8) + ".log");
            sink.TryOpen(fallback);
            return sink;
        }

        private bool TryOpen(string path)
        {
            if (string.IsNullOrEmpty(path)) return false;
            try
            {
                string dir = System.IO.Path.GetDirectoryName(path);
                if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir)) Directory.CreateDirectory(dir);
                StreamWriter writer = new StreamWriter(path, false, new UTF8Encoding(true));
                writer.AutoFlush = true;
                _writer = writer;
                LogPath = path;
                return true;
            }
            catch (Exception ex)
            {
                OpenError = ex.Message;
                _writer = null;
                return false;
            }
        }

        /// <summary>重定向到管道时 Console.Out 会用 ANSI 代码页写坏中文，这里自己按 UTF-8 写标准输出。</summary>
        private void Echo(string text)
        {
            if (!_stdoutTried)
            {
                _stdoutTried = true;
                try
                {
                    Stream stream = Console.OpenStandardOutput();
                    if (stream != null)
                    {
                        _stdout = new StreamWriter(stream, new UTF8Encoding(false));
                        _stdout.AutoFlush = true;
                    }
                }
                catch (Exception)
                {
                    _stdout = null;
                }
            }
            if (_stdout == null) return;
            try { _stdout.WriteLine(text); }
            catch (Exception) { _stdout = null; }
        }

        public void Write(string text)
        {
            if (_writer != null)
            {
                try { _writer.WriteLine(text); }
                catch (Exception) { }
            }
            if (_echo) Echo(text);
        }

        public void Dispose()
        {
            if (_writer != null)
            {
                try { _writer.Dispose(); } catch (Exception) { }
                _writer = null;
            }
            if (_stdout != null)
            {
                try { _stdout.Flush(); _stdout.Dispose(); } catch (Exception) { }
                _stdout = null;
            }
        }
    }

    /// <summary>无界面执行模式（--run --yes [--delete-data]）：不弹窗、不杀进程，结果进日志与退出码。</summary>
    internal static class HeadlessRunner
    {
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool AttachConsole(int processId);

        private const int AttachParentProcess = -1;

        private static bool InUse(UninstallItem item, List<ProcessInfo> processes)
        {
            if (processes == null || processes.Count == 0) return false;
            if (string.Equals(item.Kind, "registry", StringComparison.OrdinalIgnoreCase)) return false;
            for (int i = 0; i < processes.Count; i++)
            {
                string image = processes[i].ImagePath;
                if (string.IsNullOrEmpty(image)) continue;
                if (PathUtil.IsSamePath(image, item.Path)) return true;
                if (string.Equals(item.Kind, "directory", StringComparison.OrdinalIgnoreCase) && PathUtil.IsInside(image, item.Path)) return true;
            }
            return false;
        }

        private static bool Wanted(UninstallItem item, bool deleteData)
        {
            if (string.Equals(item.Action, "delete", StringComparison.OrdinalIgnoreCase)) return true;
            if (!deleteData) return false;
            return string.Equals(item.Id, "data", StringComparison.OrdinalIgnoreCase)
                || string.Equals(item.Id, "installed-data", StringComparison.OrdinalIgnoreCase);
        }

        public static int Run(string exeDir, string selfPath, string selfName, string selfDir, bool confirmed, bool deleteData)
        {
            try { AttachConsole(AttachParentProcess); } catch (Exception) { }
            // 重定向到管道时 .NET 默认用 ANSI 代码页，会把中文写乱；统一按 UTF-8 输出。
            try { Console.OutputEncoding = new UTF8Encoding(false); } catch (Exception) { }
            LogSink log = LogSink.Open(selfDir, true);
            try
            {
                log.Write("[headless] DSH-launcher-KEWU 卸载程序");
                log.Write("[headless] 日志：" + log.LogPath);
                log.Write("[headless] 启动器目录：" + exeDir);
                log.Write("[headless] 数据目录：" + System.IO.Path.Combine(exeDir, "launcher-data"));
                if (!string.IsNullOrEmpty(log.OpenError)) log.Write("[headless] 首选日志位置不可写：" + log.OpenError);
                if (!confirmed)
                {
                    log.Write("[headless] 拒绝执行：缺少 --yes。没有删除任何内容。");
                    return 2;
                }

                UninstallPlanModel plan = UninstallPlanBuilder.Build(exeDir, selfName);
                for (int i = 0; i < plan.Warnings.Count; i++) log.Write("[headless] 提示：" + plan.Warnings[i]);
                for (int i = 0; i < plan.RunningProcesses.Count; i++) log.Write("[headless] 运行中的启动器进程：" + plan.RunningProcesses[i]);

                List<UninstallItem> selected = new List<UninstallItem>();
                for (int i = 0; i < plan.Items.Count; i++)
                {
                    if (Wanted(plan.Items[i], deleteData)) selected.Add(plan.Items[i]);
                }
                log.Write("[headless] 本次计划删除 " + selected.Count.ToString() + " 项" + (deleteData ? "（含数据目录）" : ""));

                // 执行前重新取一次进程表，不用扫描时的旧快照做决定。
                List<ProcessInfo> processes = new List<ProcessInfo>();
                List<ProcessInfo> all = PathUtil.ListProcesses();
                for (int i = 0; i < all.Count; i++)
                {
                    if (!string.IsNullOrEmpty(selfPath) && PathUtil.IsSamePath(all[i].ImagePath, selfPath)) continue;
                    processes.Add(all[i]);
                }

                UninstallOutcome outcome = new UninstallOutcome();
                List<string> errors = new List<string>();
                for (int i = 0; i < selected.Count; i++)
                {
                    UninstallItem item = selected[i];
                    if (InUse(item, processes))
                    {
                        outcome.Skipped = outcome.Skipped + 1;
                        string why = "有进程正在使用「" + item.Path + "」，按规则跳过，不结束任何进程";
                        log.Write("[headless] 跳过（" + item.Label + "）：" + why);
                        errors.Add(item.Label + "：" + why);
                        continue;
                    }
                    log.Write("[headless] 删除（" + item.Label + "）：" + item.Path);
                    RemoveResult result = UninstallRunner.Remove(item);
                    if (result.Ok)
                    {
                        outcome.Deleted = outcome.Deleted + 1;
                        log.Write("[headless] 已删除：" + item.Path);
                    }
                    else
                    {
                        outcome.Failed = outcome.Failed + 1;
                        log.Write("[headless] 失败：" + item.Path + "（" + result.Message + "）");
                        errors.Add(item.Label + "：" + result.Message);
                    }
                }

                log.Write("[headless] 汇总：已删除 " + outcome.Deleted.ToString() + "，已跳过 " + outcome.Skipped.ToString() + "，失败 " + outcome.Failed.ToString());
                for (int i = 0; i < errors.Count; i++) log.Write("[headless] 明细：" + errors[i]);
                log.Write("[headless] 退出码：" + (outcome.Failed > 0 || outcome.Skipped > 0 ? "1" : "0"));
                if (outcome.Failed > 0 || outcome.Skipped > 0) return 1;
                return 0;
            }
            catch (Exception ex)
            {
                log.Write("[headless] 执行中出现异常：" + ex);
                return 1;
            }
            finally
            {
                log.Dispose();
            }
        }
    }

    internal static class Program
    {
        [DllImport("user32.dll")]
        private static extern bool SetProcessDPIAware();

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool SetProcessDpiAwarenessContext(IntPtr value);

        /// <summary>高 DPI 不糊：优先 PerMonitorV2，退回 System DPI Aware。</summary>
        private static void EnableDpiAwareness()
        {
            try
            {
                IntPtr perMonitorV2 = new IntPtr(-4);
                if (SetProcessDpiAwarenessContext(perMonitorV2)) return;
            }
            catch (Exception)
            {
            }
            try { SetProcessDPIAware(); }
            catch (Exception) { }
        }

        private static string ResolveExeDir(string dirArg)
        {
            if (!string.IsNullOrEmpty(dirArg))
            {
                try { return System.IO.Path.GetFullPath(dirArg).TrimEnd('\\'); }
                catch (Exception) { }
            }
            string baseDir = AppDomain.CurrentDomain.BaseDirectory;
            if (string.IsNullOrEmpty(baseDir)) baseDir = System.IO.Path.GetDirectoryName(CurrentSelfPath());
            return (baseDir ?? "").TrimEnd('\\');
        }

        private static string CurrentSelfPath()
        {
            return UninstallPlanBuilder.CurrentExecutablePath();
        }

        private static string ResolveSelfDir(string selfPath)
        {
            string dir = null;
            try { if (!string.IsNullOrEmpty(selfPath)) dir = System.IO.Path.GetDirectoryName(selfPath); }
            catch (Exception) { }
            if (string.IsNullOrEmpty(dir)) dir = AppDomain.CurrentDomain.BaseDirectory;
            return (dir ?? "").TrimEnd('\\');
        }

        [STAThread]
        private static int Main(string[] args)
        {
            EnableDpiAwareness();
            bool headless = false;
            try
            {
                string planPath = null;
                string dirArg = null;
                bool runMode = false;
                bool confirmed = false;
                bool deleteData = false;
                bool guiSelfTest = false;
                bool layoutSelfTest = false;
                for (int i = 0; i < args.Length; i++)
                {
                    string arg = args[i];
                    if (string.Equals(arg, "--plan", StringComparison.OrdinalIgnoreCase) && i + 1 < args.Length)
                    {
                        planPath = args[++i];
                        continue;
                    }
                    if (string.Equals(arg, "--dir", StringComparison.OrdinalIgnoreCase) && i + 1 < args.Length)
                    {
                        dirArg = args[++i];
                        continue;
                    }
                    if (string.Equals(arg, "--run", StringComparison.OrdinalIgnoreCase))
                    {
                        runMode = true;
                        continue;
                    }
                    if (string.Equals(arg, "--yes", StringComparison.OrdinalIgnoreCase))
                    {
                        confirmed = true;
                        continue;
                    }
                    if (string.Equals(arg, "--delete-data", StringComparison.OrdinalIgnoreCase))
                    {
                        deleteData = true;
                        continue;
                    }
                    if (string.Equals(arg, "--selftest-gui", StringComparison.OrdinalIgnoreCase))
                    {
                        guiSelfTest = true;
                        continue;
                    }
                    if (string.Equals(arg, "--selftest-layout", StringComparison.OrdinalIgnoreCase))
                    {
                        layoutSelfTest = true;
                        continue;
                    }
                    if (string.Equals(arg, "--help", StringComparison.OrdinalIgnoreCase) || string.Equals(arg, "-h", StringComparison.OrdinalIgnoreCase) || string.Equals(arg, "/?", StringComparison.Ordinal))
                    {
                        headless = true;
                        ShowHelp();
                        return 0;
                    }
                }

                string selfPath = CurrentSelfPath();
                string selfName = string.IsNullOrEmpty(selfPath) ? "" : System.IO.Path.GetFileName(selfPath);
                string selfDir = ResolveSelfDir(selfPath);
                string exeDir = ResolveExeDir(dirArg);
                headless = headless || runMode || !string.IsNullOrEmpty(planPath) || guiSelfTest || layoutSelfTest;

                // 无人值守自检：只构建窗体并强制创建句柄，不显示窗口、不删任何东西，用来验证 GUI 代码路径没崩。
                if (guiSelfTest)
                {
                    System.Windows.Forms.Application.EnableVisualStyles();
                    System.Windows.Forms.Application.SetCompatibleTextRenderingDefault(false);
                    int controls;
                    using (UninstallerForm form = new UninstallerForm(exeDir, selfName, selfPath, selfDir))
                    {
                        form.CreateControl();
                        controls = form.Controls.Count;
                    }
                    Console.Error.WriteLine("[selftest-gui] ok controls=" + controls + " dir=" + exeDir);
                    return 0;
                }

                // 布局自检：打印窗体实际客户区与 DPI，用来定位「控件被推出窗口」这类缩放问题。
                if (layoutSelfTest)
                {
                    System.Windows.Forms.Application.EnableVisualStyles();
                    System.Windows.Forms.Application.SetCompatibleTextRenderingDefault(false);
                    using (UninstallerForm form = new UninstallerForm(exeDir, selfName, selfPath, selfDir))
                    {
                        form.CreateControl();
                        System.Drawing.Rectangle screen = System.Windows.Forms.Screen.PrimaryScreen.Bounds;
                        Console.Error.WriteLine("[selftest-layout] client=" + form.ClientSize.Width + "x" + form.ClientSize.Height
                            + " size=" + form.Size.Width + "x" + form.Size.Height
                            + " mode=" + form.AutoScaleMode
                            + " font=" + form.Font.Name + "/" + form.Font.SizeInPoints.ToString(System.Globalization.CultureInfo.InvariantCulture)
                            + " dpi=" + form.DeviceDpi
                            + " screen=" + screen.Width + "x" + screen.Height);
                    }
                    return 0;
                }

                if (runMode) return HeadlessRunner.Run(exeDir, selfPath, selfName, selfDir, confirmed, deleteData);
                if (!string.IsNullOrEmpty(planPath)) return RunPlan(exeDir, selfName, planPath);

                if (!string.IsNullOrEmpty(dirArg) && !Directory.Exists(exeDir))
                {
                    System.Windows.Forms.MessageBox.Show("指定的目录不存在：" + exeDir, "DSH-launcher-KEWU 卸载程序",
                        System.Windows.Forms.MessageBoxButtons.OK, System.Windows.Forms.MessageBoxIcon.Error);
                    return 1;
                }

                System.Windows.Forms.Application.EnableVisualStyles();
                System.Windows.Forms.Application.SetCompatibleTextRenderingDefault(false);
                System.Windows.Forms.Application.Run(new UninstallerForm(exeDir, selfName, selfPath, selfDir));
                return 0;
            }
            catch (Exception ex)
            {
                if (headless)
                {
                    try { Console.Error.WriteLine("[headless] 未处理错误：" + ex); }
                    catch (Exception) { }
                    return 1;
                }
                try
                {
                    System.Windows.Forms.MessageBox.Show("卸载程序发生未处理错误：\n" + ex, "DSH-launcher-KEWU 卸载程序",
                        System.Windows.Forms.MessageBoxButtons.OK, System.Windows.Forms.MessageBoxIcon.Error);
                }
                catch (Exception)
                {
                }
                return 1;
            }
        }

        private static int RunPlan(string exeDir, string selfName, string planPath)
        {
            UninstallPlanModel plan = UninstallPlanBuilder.Build(exeDir, selfName);
            string json = PlanJson.Serialize(plan);
            string fullPath = System.IO.Path.GetFullPath(planPath);
            string parent = System.IO.Path.GetDirectoryName(fullPath);
            if (!string.IsNullOrEmpty(parent) && !Directory.Exists(parent)) Directory.CreateDirectory(parent);
            // UTF-8 无 BOM：JSON.parse 读到 BOM 会直接报错。
            File.WriteAllText(fullPath, json, new UTF8Encoding(false));
            return 0;
        }

        private static void ShowHelp()
        {
            string text = "DSH-launcher-KEWU 卸载程序\n\n" +
                "无参数：打开图形界面（扫描 + 勾选 + 卸载）。\n" +
                "KEWU-Uninstaller.exe --plan <输出json路径> [--dir <启动器目录>]\n" +
                "    只扫描、不删除，把卸载计划写成 JSON 后退出（退出码 0）。\n" +
                "KEWU-Uninstaller.exe --run --yes [--delete-data] [--dir <启动器目录>]\n" +
                "    按扫描结果执行卸载，不弹窗、不结束任何进程；缺 --yes 时拒绝执行并返回 2。\n" +
                "    全部成功返回 0，有条目失败或被跳过返回 1。默认不删数据目录，--delete-data 才删。\n" +
                "--dir 缺省为卸载程序自身所在目录。\n";
            try
            {
                System.Windows.Forms.MessageBox.Show(text, "DSH-launcher-KEWU 卸载程序", System.Windows.Forms.MessageBoxButtons.OK, System.Windows.Forms.MessageBoxIcon.Information);
            }
            catch (Exception)
            {
            }
        }
    }
}
