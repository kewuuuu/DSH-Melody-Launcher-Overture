import { spawn } from 'node:child_process'
import path from 'node:path'
import { buildWindowsBatchCommand, trackSpawnedProcess, withExecutableDirectoryOnPath } from './process'

// taskkill needs a live root PID. A Job Object owns the descendants even after that root exits.
const JOB_SOURCE = String.raw`using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

public static class InstallProcessJob {
    [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
        public long ProcessTime, JobTime;
        public uint Flags;
        public UIntPtr MinWorkingSet, MaxWorkingSet;
        public uint ProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
        public BasicLimits Basic;
        public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [StructLayout(LayoutKind.Sequential)] struct Accounting {
        public long UserTime, KernelTime, PeriodUserTime, PeriodKernelTime;
        public uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses;
    }
    [StructLayout(LayoutKind.Sequential)] struct StartupInfo {
        public uint Size;
        public IntPtr Reserved, Desktop, Title;
        public uint X, Y, Width, Height, XChars, YChars, Fill, Flags;
        public ushort ShowWindow, ReservedSize;
        public IntPtr ReservedData, Input, Output, Error;
    }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo {
        public IntPtr Process, Thread;
        public uint ProcessId, ThreadId;
    }
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr attributes, IntPtr name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int type, ref ExtendedLimits limits, int length);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int type, out Accounting accounting, int length, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool CreateProcess(string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string cwd, ref StartupInfo startup, out ProcessInfo process);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr GetStdHandle(int handle);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

    static void Check(bool success) {
        if (!success) throw new Win32Exception(Marshal.GetLastWin32Error());
    }

    static uint ActiveProcesses(IntPtr job) {
        Accounting accounting;
        Check(QueryInformationJobObject(job, 1, out accounting, Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero));
        return accounting.ActiveProcesses;
    }

    public static int Run(string commandLine) {
        // A cancel line or EOF requests shutdown. Job membership is established before the child executes.
        Task<string> cancellation = Task.Factory.StartNew(() => Console.In.ReadLine(), TaskCreationOptions.LongRunning);
        IntPtr job = CreateJobObject(IntPtr.Zero, IntPtr.Zero);
        Check(job != IntPtr.Zero);
        ProcessInfo child = new ProcessInfo();
        bool assigned = false;
        try {
            var limits = new ExtendedLimits();
            limits.Basic.Flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            Check(SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(typeof(ExtendedLimits))));
            var startup = new StartupInfo { Size = (uint)Marshal.SizeOf(typeof(StartupInfo)), Flags = 0x100,
                Output = GetStdHandle(-11), Error = GetStdHandle(-12) };
            Check(SetHandleInformation(startup.Output, 1, 1));
            Check(SetHandleInformation(startup.Error, 1, 1));
            if (cancellation.IsCompleted) return 1;
            Check(CreateProcess(null, new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero, true,
                0x08000004, IntPtr.Zero, null, ref startup, out child)); // CREATE_NO_WINDOW | CREATE_SUSPENDED
            Check(AssignProcessToJobObject(job, child.Process));
            assigned = true;
            Check(ResumeThread(child.Thread) != uint.MaxValue);
            bool cancelled = false;
            uint exitCode = 1;
            while (ActiveProcesses(job) > 0) {
                if (child.Process != IntPtr.Zero && WaitForSingleObject(child.Process, 0) == 0) {
                    Check(GetExitCodeProcess(child.Process, out exitCode));
                    CloseHandle(child.Process);
                    child.Process = IntPtr.Zero;
                }
                if (!cancelled && cancellation.IsCompleted) {
                    Check(TerminateJobObject(job, 1));
                    cancelled = true;
                }
                Thread.Sleep(25);
            }
            if (child.Process != IntPtr.Zero) Check(GetExitCodeProcess(child.Process, out exitCode));
            return unchecked((int)exitCode);
        } finally {
            if (child.Process != IntPtr.Zero && !assigned) {
                TerminateProcess(child.Process, 1);
                WaitForSingleObject(child.Process, uint.MaxValue);
            }
            if (child.Process != IntPtr.Zero) CloseHandle(child.Process);
            if (child.Thread != IntPtr.Zero) CloseHandle(child.Thread);
            CloseHandle(job);
        }
    }
}
`

function quoteWindowsArgument(value: string): string {
  if (value && !/[\s"]/.test(value)) return value
  return '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/\\+$/, '$&$&') + '"'
}

export function spawnWindowsInstallCommand(executable: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) {
  const env = withExecutableDirectoryOnPath(executable, options.env)
  const shell = env.ComSpec || process.env.ComSpec || 'cmd.exe'
  const commandLine = /\.(?:cmd|bat)$/i.test(executable)
    ? quoteWindowsArgument(shell) + ' /d /s /v:off /c ' + buildWindowsBatchCommand(executable, args)
    : [executable, ...args].map(quoteWindowsArgument).join(' ')
  const powerShell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const encodedLine = Buffer.from(commandLine, 'utf16le').toString('base64')
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    "Add-Type -TypeDefinition @'\n" + JOB_SOURCE + "\n'@",
    "$line = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('" + encodedLine + "'))",
    'exit [InstallProcessJob]::Run($line)',
  ].join('\n')
  return trackSpawnedProcess(spawn(powerShell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    ...options, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  }))
}
