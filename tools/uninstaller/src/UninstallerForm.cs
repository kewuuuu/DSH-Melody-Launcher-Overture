// DSH-launcher-KEWU 卸载程序的图形界面：扫描 → 勾选 → 确认 → 逐条删除 → 汇总。
// 只用 .NET Framework 4.x 自带的 WinForms，C# 5 语法。

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.Windows.Forms;

namespace KewuUninstaller
{
    internal sealed class UninstallerForm : Form
    {
        private readonly string _launcherDir;
        private readonly string _selfName;
        private readonly string _selfPath;
        private readonly LogSink _log;

        private readonly TextBox _txtExe = new TextBox();
        private readonly TextBox _txtData = new TextBox();
        private readonly TableLayoutPanel _itemsTable = new TableLayoutPanel();
        private readonly Label _keepLabel = new Label();
        private readonly RichTextBox _logBox = new RichTextBox();
        private readonly Button _btnRescan = new Button();
        private readonly Button _btnUninstall = new Button();
        private readonly Button _btnClose = new Button();
        private readonly Label _logPathLabel = new Label();
        private readonly List<CheckBox> _checks = new List<CheckBox>();
        private readonly List<UninstallItem> _checkItems = new List<UninstallItem>();

        private UninstallPlanModel _plan;
        private bool _busy;

        public UninstallerForm(string launcherDir, string selfName, string selfPath, string selfDir)
        {
            _launcherDir = launcherDir;
            _selfName = selfName;
            _selfPath = selfPath;
            _log = LogSink.Open(selfDir, false);

            // AutoScaleMode.None：本窗体的坐标全由代码按 96 DPI 手工算，交给 WinForms 再按 DPI 缩放
            // 会让子控件的坐标与 ClientSize 脱节（实测高 DPI 下底部按钮被推出窗口），统一不缩放。
            AutoScaleMode = AutoScaleMode.None;
            Text = "DSH-launcher-KEWU 卸载程序";
            Font = SystemFonts.MessageBoxFont;
            ClientSize = new Size(780, 640);
            MinimumSize = new Size(700, 560);
            StartPosition = FormStartPosition.CenterScreen;

            BuildLayout();
            LogLine("DSH-launcher-KEWU 卸载程序已启动。");
            LogLine("卸载程序：" + (_selfPath ?? ""));
            LogLine("启动器目录：" + _launcherDir);
            LogLine("日志文件：" + _log.LogPath + (string.IsNullOrEmpty(_log.OpenError) ? "" : "（首选位置不可写：" + _log.OpenError + "）"));
            Rescan();
        }

        private void BuildLayout()
        {
            Panel top = new Panel();
            top.Dock = DockStyle.Top;
            top.Height = 104;

            Label title = new Label();
            title.Text = "DSH-launcher-KEWU 卸载程序";
            title.Font = new Font(Font.FontFamily, 15f, FontStyle.Bold);
            title.AutoSize = true;
            title.Location = new Point(16, 12);
            top.Controls.Add(title);

            // 路径区与右侧按钮都用停靠布局：手算的右边界坐标在窗口被缩放时会落到窗口外面。
            Panel fields = new Panel();
            fields.Dock = DockStyle.Fill;
            fields.Padding = new Padding(16, 0, 0, 0);

            Label exeCaption = new Label();
            exeCaption.Text = "启动器 EXE：";
            exeCaption.AutoSize = true;
            exeCaption.Location = new Point(0, 56);
            fields.Controls.Add(exeCaption);

            _txtExe.ReadOnly = true;
            _txtExe.Location = new Point(96, 52);
            _txtExe.Width = 560;
            _txtExe.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
            fields.Controls.Add(_txtExe);

            Label dataCaption = new Label();
            dataCaption.Text = "数据目录：";
            dataCaption.AutoSize = true;
            dataCaption.Location = new Point(0, 82);
            fields.Controls.Add(dataCaption);

            _txtData.ReadOnly = true;
            _txtData.Location = new Point(96, 78);
            _txtData.Width = 560;
            _txtData.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
            fields.Controls.Add(_txtData);

            Panel rescanHost = new Panel();
            rescanHost.Dock = DockStyle.Right;
            rescanHost.Width = 132;
            rescanHost.Padding = new Padding(0, 52, 16, 0);

            _btnRescan.Text = "重新扫描";
            _btnRescan.Dock = DockStyle.Top;
            _btnRescan.Height = 32;
            _btnRescan.Click += delegate { Rescan(); };
            rescanHost.Controls.Add(_btnRescan);

            top.Controls.Add(fields);
            top.Controls.Add(rescanHost);

            Panel keep = new Panel();
            keep.Dock = DockStyle.Top;
            keep.Height = 68;
            keep.Padding = new Padding(16, 2, 16, 2);

            Label keepTitle = new Label();
            keepTitle.Text = "始终保留（不可勾选）";
            keepTitle.Font = new Font(Font.FontFamily, 9f, FontStyle.Bold);
            keepTitle.AutoSize = true;
            keepTitle.Dock = DockStyle.Top;
            // 先加 Fill、再加 Top：WinForms 按相反顺序停靠，Fill 最后加会把 Top 压住（实测标题与正文重叠）。
            _keepLabel.AutoSize = false;
            _keepLabel.Dock = DockStyle.Fill;
            _keepLabel.ForeColor = SystemColors.GrayText;
            keep.Controls.Add(_keepLabel);
            keep.Controls.Add(keepTitle);

            Panel itemsHost = new Panel();
            itemsHost.Dock = DockStyle.Top;
            itemsHost.Height = 250;
            itemsHost.AutoScroll = true;
            itemsHost.Padding = new Padding(8, 4, 8, 4);
            itemsHost.BorderStyle = BorderStyle.FixedSingle;

            _itemsTable.Dock = DockStyle.Top;
            _itemsTable.AutoSize = true;
            _itemsTable.AutoSizeMode = AutoSizeMode.GrowAndShrink;
            _itemsTable.ColumnCount = 4;
            _itemsTable.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 26f));
            _itemsTable.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100f));
            _itemsTable.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 104f));
            _itemsTable.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 96f));
            itemsHost.Controls.Add(_itemsTable);

            Panel logHost = new Panel();
            logHost.Dock = DockStyle.Fill;
            logHost.Padding = new Padding(16, 6, 16, 6);

            GroupBox logGroup = new GroupBox();
            logGroup.Text = "日志";
            logGroup.Dock = DockStyle.Fill;
            logGroup.Padding = new Padding(8);

            _logBox.Dock = DockStyle.Fill;
            _logBox.ReadOnly = true;
            _logBox.BackColor = SystemColors.Window;
            _logBox.WordWrap = false;
            _logBox.ScrollBars = RichTextBoxScrollBars.Both;
            try { _logBox.Font = new Font("Consolas", 9f); }
            catch (Exception) { }
            logGroup.Controls.Add(_logBox);
            logHost.Controls.Add(logGroup);

            Panel bottom = new Panel();
            bottom.Dock = DockStyle.Bottom;
            bottom.Height = 52;

            _logPathLabel.AutoSize = false;
            _logPathLabel.Dock = DockStyle.Fill;
            _logPathLabel.TextAlign = ContentAlignment.MiddleLeft;
            _logPathLabel.Padding = new Padding(16, 0, 0, 0);
            _logPathLabel.ForeColor = SystemColors.GrayText;

            // 按钮交给靠右的 FlowLayoutPanel 自己排：不再用 ClientSize 手算坐标，
            // 窗口被缩放或改尺寸时也不会跑到窗口外面去。
            FlowLayoutPanel buttons = new FlowLayoutPanel();
            buttons.Dock = DockStyle.Right;
            buttons.FlowDirection = FlowDirection.LeftToRight;
            buttons.WrapContents = false;
            buttons.AutoSize = true;
            buttons.Padding = new Padding(0, 11, 16, 0);

            _btnUninstall.Text = "开始卸载";
            _btnUninstall.Size = new Size(124, 32);
            _btnUninstall.Margin = new Padding(8, 0, 0, 0);
            _btnUninstall.Click += delegate { StartUninstall(); };
            buttons.Controls.Add(_btnUninstall);

            _btnClose.Text = "关闭";
            _btnClose.Size = new Size(96, 32);
            _btnClose.Margin = new Padding(8, 0, 0, 0);
            _btnClose.Click += delegate { Close(); };
            buttons.Controls.Add(_btnClose);

            bottom.Controls.Add(_logPathLabel);
            bottom.Controls.Add(buttons);

            Controls.Add(logHost);
            Controls.Add(itemsHost);
            Controls.Add(keep);
            Controls.Add(top);
            Controls.Add(bottom);
        }

        private void Rescan()
        {
            if (_busy) return;
            try
            {
                UninstallPlanModel plan = UninstallPlanBuilder.Build(_launcherDir, _selfName);
                _plan = plan;
                _txtExe.Text = string.IsNullOrEmpty(plan.ExePath) ? "（启动器目录里没找到启动器 EXE）" : plan.ExePath;
                _txtData.Text = plan.DataDir;
                FillItems(plan);
                FillKeep(plan);
                int deletable = 0;
                for (int i = 0; i < plan.Items.Count; i++)
                {
                    if (string.Equals(plan.Items[i].Action, "delete", StringComparison.OrdinalIgnoreCase)) deletable = deletable + 1;
                }
                LogLine("扫描完成：共 " + plan.Items.Count.ToString(CultureInfo.InvariantCulture) + " 项，默认删除 " + deletable.ToString(CultureInfo.InvariantCulture) + " 项。");
                for (int i = 0; i < plan.Warnings.Count; i++) LogLine("提示：" + plan.Warnings[i]);
                for (int i = 0; i < plan.Items.Count; i++)
                {
                    UninstallItem item = plan.Items[i];
                    if (!item.Checkable || string.Equals(item.Action, "keep", StringComparison.OrdinalIgnoreCase))
                    {
                        string reason = string.IsNullOrEmpty(item.Reason) ? "不可勾选" : item.Reason;
                        LogLine("  " + item.Label + "：" + reason);
                    }
                }
                if (plan.RunningProcesses.Count > 0) LogLine("检测到启动器进程正在运行：" + ProcessNames(plan.RunningProcesses) + "（执行卸载前会询问是否结束）。");
            }
            catch (Exception ex)
            {
                LogLine("扫描失败：" + ex.Message);
            }
        }

        private void FillItems(UninstallPlanModel plan)
        {
            _itemsTable.SuspendLayout();
            try
            {
                _itemsTable.Controls.Clear();
                _itemsTable.RowStyles.Clear();
                _itemsTable.RowCount = 0;
                _checks.Clear();
                _checkItems.Clear();

                for (int i = 0; i < plan.Items.Count; i++)
                {
                    UninstallItem item = plan.Items[i];
                    _itemsTable.RowCount = _itemsTable.RowCount + 1;
                    int row = _itemsTable.RowCount - 1;
                    _itemsTable.RowStyles.Add(new RowStyle(SizeType.Absolute, 46f));

                    CheckBox check = new CheckBox();
                    check.Text = "";
                    check.Dock = DockStyle.Fill;
                    check.CheckAlign = ContentAlignment.MiddleLeft;
                    check.Enabled = item.Checkable;
                    check.Checked = item.Checkable && item.DefaultChecked;
                    check.TextAlign = ContentAlignment.MiddleLeft;
                    check.Tag = item;
                    _itemsTable.Controls.Add(check, 0, row);
                    _checks.Add(check);
                    _checkItems.Add(item);

                    Label caption = new Label();
                    string head = item.Label;
                    if (!item.Checkable) head = head + "（不可勾选）";
                    caption.Text = head + Environment.NewLine + item.Path;
                    caption.AutoSize = false;
                    caption.Dock = DockStyle.Fill;
                    caption.TextAlign = ContentAlignment.MiddleLeft;
                    if (!item.Checkable) caption.ForeColor = SystemColors.GrayText;
                    _itemsTable.Controls.Add(caption, 1, row);

                    Label size = new Label();
                    size.Text = string.Equals(item.Kind, "registry", StringComparison.OrdinalIgnoreCase) ? "注册表项" : item.SizeText;
                    size.AutoSize = false;
                    size.Dock = DockStyle.Fill;
                    size.TextAlign = ContentAlignment.MiddleRight;
                    _itemsTable.Controls.Add(size, 2, row);

                    Label action = new Label();
                    bool keep = string.Equals(item.Action, "keep", StringComparison.OrdinalIgnoreCase);
                    action.Text = keep ? "默认保留" : "默认删除";
                    action.AutoSize = false;
                    action.Dock = DockStyle.Fill;
                    action.TextAlign = ContentAlignment.MiddleLeft;
                    action.ForeColor = keep ? SystemColors.GrayText : SystemColors.ControlText;
                    _itemsTable.Controls.Add(action, 3, row);

                    if (!string.IsNullOrEmpty(item.Reason))
                    {
                        ToolTip tip = new ToolTip();
                        tip.SetToolTip(check, item.Reason);
                        tip.SetToolTip(caption, item.Reason);
                        tip.SetToolTip(action, item.Reason);
                    }
                }
            }
            finally
            {
                _itemsTable.ResumeLayout();
            }
        }

        private void FillKeep(UninstallPlanModel plan)
        {
            System.Text.StringBuilder builder = new System.Text.StringBuilder();
            for (int i = 0; i < plan.AlwaysKeep.Count; i++)
            {
                KeepItem item = plan.AlwaysKeep[i];
                if (i > 0) builder.Append(Environment.NewLine);
                builder.Append("· ").Append(item.Path).Append(" —— ").Append(item.Reason);
            }
            _keepLabel.Text = builder.ToString();
        }

        private List<UninstallItem> SelectedItems()
        {
            List<UninstallItem> selected = new List<UninstallItem>();
            for (int i = 0; i < _checks.Count; i++)
            {
                if (!_checks[i].Enabled || !_checks[i].Checked) continue;
                selected.Add(_checkItems[i]);
            }
            return selected;
        }

        private static string ProcessNames(List<ProcessInfo> processes)
        {
            System.Text.StringBuilder builder = new System.Text.StringBuilder();
            for (int i = 0; i < processes.Count; i++)
            {
                if (i > 0) builder.Append("、");
                builder.Append(processes[i].Name).Append("（PID ").Append(processes[i].Id.ToString(CultureInfo.InvariantCulture)).Append("）");
            }
            return builder.ToString();
        }

        private List<ProcessInfo> FindRunning()
        {
            List<ProcessInfo> found = new List<ProcessInfo>();
            int selfPid = Process.GetCurrentProcess().Id;
            string dataDir = _plan == null ? "" : _plan.DataDir;
            List<ProcessInfo> all = PathUtil.ListProcesses();
            for (int i = 0; i < all.Count; i++)
            {
                ProcessInfo info = all[i];
                if (info.Id == selfPid) continue;
                if (string.IsNullOrEmpty(info.ImagePath)) continue;
                if (!string.IsNullOrEmpty(_selfPath) && PathUtil.IsSamePath(info.ImagePath, _selfPath)) continue;
                if (PathUtil.Covers(info.ImagePath, _launcherDir) || PathUtil.Covers(info.ImagePath, dataDir)) found.Add(info);
            }
            return found;
        }

        private void StartUninstall()
        {
            if (_busy) return;
            List<UninstallItem> selected = SelectedItems();
            if (selected.Count == 0)
            {
                MessageBox.Show("没有勾选任何要删除的条目。", "DSH-launcher-KEWU 卸载程序", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }

            System.Text.StringBuilder list = new System.Text.StringBuilder();
            for (int i = 0; i < selected.Count; i++)
            {
                list.Append("· ").Append(selected[i].Label).Append("：").Append(selected[i].Path).Append(Environment.NewLine);
            }
            string question = "将删除以下 " + selected.Count.ToString(CultureInfo.InvariantCulture) + " 项：\n\n" + list.ToString() + "\n删除后不可恢复，确定继续吗？";
            DialogResult confirm = MessageBox.Show(question, "确认卸载", MessageBoxButtons.YesNo, MessageBoxIcon.Warning, MessageBoxDefaultButton.Button2);
            if (confirm != DialogResult.Yes)
            {
                LogLine("已取消：用户没有确认，本次没有删除任何内容。");
                return;
            }

            List<ProcessInfo> running = FindRunning();
            if (running.Count > 0)
            {
                string text = "启动器进程正在运行：\n" + ProcessNames(running) + "\n\n结束这些进程后继续卸载？\n选「否」将中止卸载，不删除任何内容。";
                DialogResult answer = MessageBox.Show(text, "启动器正在运行", MessageBoxButtons.YesNo, MessageBoxIcon.Warning, MessageBoxDefaultButton.Button2);
                if (answer != DialogResult.Yes)
                {
                    LogLine("已中止：用户不同意结束启动器进程，本次没有删除任何内容。");
                    return;
                }
                LogLine("用户同意结束启动器进程，开始结束 " + running.Count.ToString(CultureInfo.InvariantCulture) + " 个进程。");
                UninstallRunner.KillProcesses(running, delegate(string line) { LogLine(line); });
                System.Threading.Thread.Sleep(300);
            }

            Execute(selected);
        }

        private void Execute(List<UninstallItem> selected)
        {
            _busy = true;
            SetBusy(true);
            UninstallOutcome outcome = new UninstallOutcome();
            try
            {
                LogLine("=== 开始卸载（" + selected.Count.ToString(CultureInfo.InvariantCulture) + " 项） ===");
                for (int i = 0; i < selected.Count; i++)
                {
                    UninstallItem item = selected[i];
                    LogLine("删除：" + item.Label + " → " + item.Path);
                    _logBox.Refresh();
                    RemoveResult result;
                    try
                    {
                        result = UninstallRunner.Remove(item);
                    }
                    catch (Exception ex)
                    {
                        result = new RemoveResult();
                        result.Ok = false;
                        result.Message = ex.Message;
                    }
                    if (result.Ok)
                    {
                        outcome.Deleted = outcome.Deleted + 1;
                        LogLine("  已删除");
                    }
                    else if (result.Skipped)
                    {
                        outcome.Skipped = outcome.Skipped + 1;
                        LogLine("  已跳过：" + result.Message);
                    }
                    else
                    {
                        outcome.Failed = outcome.Failed + 1;
                        LogLine("  失败：" + result.Message);
                    }
                }
                LogLine("=== 汇总：已删除 " + outcome.Deleted.ToString(CultureInfo.InvariantCulture) + "，已跳过 "
                    + outcome.Skipped.ToString(CultureInfo.InvariantCulture) + "，失败 " + outcome.Failed.ToString(CultureInfo.InvariantCulture) + " ===");
            }
            finally
            {
                _busy = false;
                SetBusy(false);
            }

            string summary = "卸载完成。\n\n已删除：" + outcome.Deleted.ToString(CultureInfo.InvariantCulture)
                + "\n已跳过：" + outcome.Skipped.ToString(CultureInfo.InvariantCulture)
                + "\n失败：" + outcome.Failed.ToString(CultureInfo.InvariantCulture)
                + "\n\n日志：" + _log.LogPath;
            MessageBox.Show(summary, "DSH-launcher-KEWU 卸载程序", MessageBoxButtons.OK,
                outcome.Failed > 0 ? MessageBoxIcon.Warning : MessageBoxIcon.Information);
            Rescan();
        }

        private void SetBusy(bool busy)
        {
            _btnUninstall.Enabled = !busy;
            _btnRescan.Enabled = !busy;
            Cursor = busy ? Cursors.WaitCursor : Cursors.Default;
        }

        private void LogLine(string text)
        {
            string line = "[" + DateTime.Now.ToString("HH:mm:ss", CultureInfo.InvariantCulture) + "] " + text;
            try
            {
                if (_logBox.TextLength > 400000) _logBox.Clear();
                _logBox.AppendText(line + Environment.NewLine);
                _logBox.SelectionStart = _logBox.TextLength;
                _logBox.ScrollToCaret();
            }
            catch (Exception)
            {
            }
            _log.Write(line);
            _logPathLabel.Text = "日志：" + _log.LogPath;
        }

        protected override void OnFormClosed(FormClosedEventArgs e)
        {
            try { _log.Write("[GUI] 窗口关闭。"); _log.Dispose(); }
            catch (Exception)
            {
            }
            base.OnFormClosed(e);
        }
    }
}
