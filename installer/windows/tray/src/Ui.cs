using System;
using System.Drawing;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace Tohyee.Tray
{
    /// <summary>Small helpers so every screen looks and behaves the same.</summary>
    internal static class Ui
    {
        public static readonly Font Body = new Font("Segoe UI", 9.75f);
        public static readonly Font Heading = new Font("Segoe UI Semibold", 13f);
        public static readonly Color Muted = Color.FromArgb(91, 100, 116);
        public static readonly Color Danger = Color.FromArgb(185, 28, 28);
        public static readonly Color Success = Color.FromArgb(21, 128, 61);

        public static Label Title(string text)
        {
            return new Label { Text = text, Font = Heading, AutoSize = true, Margin = new Padding(0, 0, 0, 6) };
        }

        public static Label Note(string text)
        {
            return new Label { Text = text, ForeColor = Muted, AutoSize = true, MaximumSize = new Size(640, 0), Margin = new Padding(0, 0, 0, 10) };
        }

        public static Label Status()
        {
            return new Label { AutoSize = true, MaximumSize = new Size(640, 0), Margin = new Padding(0, 8, 0, 0) };
        }

        public static void Show(Label label, string text, bool error)
        {
            label.Text = text ?? "";
            label.ForeColor = error ? Danger : Success;
        }

        public static Button Btn(string text, EventHandler onClick)
        {
            var button = new Button { Text = text, AutoSize = true, Padding = new Padding(8, 2, 8, 2), Margin = new Padding(0, 0, 8, 0) };
            button.Click += onClick;
            return button;
        }

        /// <summary>A two-column form: labels on the left, fields on the right.</summary>
        public static TableLayoutPanel Form()
        {
            var table = new TableLayoutPanel { ColumnCount = 2, AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, Margin = new Padding(0, 0, 0, 8) };
            table.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 150));
            table.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 400));
            return table;
        }

        public static T Field<T>(TableLayoutPanel form, string label, T control) where T : Control
        {
            form.RowCount += 1;
            form.Controls.Add(new Label { Text = label, AutoSize = true, Anchor = AnchorStyles.Left, Margin = new Padding(0, 6, 12, 6) });
            control.Dock = DockStyle.Fill;
            control.Margin = new Padding(0, 3, 0, 3);
            form.Controls.Add(control);
            return control;
        }

        /// <summary>A vertical page that scrolls if the window is small.</summary>
        public static FlowLayoutPanel Page()
        {
            return new FlowLayoutPanel
            {
                Dock = DockStyle.Fill,
                FlowDirection = FlowDirection.TopDown,
                WrapContents = false,
                AutoScroll = true,
                Padding = new Padding(16),
            };
        }

        public static FlowLayoutPanel Row()
        {
            return new FlowLayoutPanel { FlowDirection = FlowDirection.LeftToRight, AutoSize = true, WrapContents = false, Margin = new Padding(0, 4, 0, 4) };
        }

        public static ListView List(params string[] columns)
        {
            var list = new ListView
            {
                View = View.Details,
                FullRowSelect = true,
                MultiSelect = false,
                HideSelection = false,
                Width = 760,
                Height = 260,
                Margin = new Padding(0, 0, 0, 8),
            };
            foreach (var column in columns)
            {
                list.Columns.Add(column, -2);
            }
            return list;
        }

        /// <summary>Asks for one line of text; null if cancelled.</summary>
        public static string Ask(IWin32Window owner, string title, string prompt, string initial)
        {
            using (var dialog = new System.Windows.Forms.Form
            {
                Text = title,
                Font = Body,
                FormBorderStyle = FormBorderStyle.FixedDialog,
                StartPosition = FormStartPosition.CenterParent,
                MinimizeBox = false,
                MaximizeBox = false,
                ClientSize = new Size(420, 130),
            })
            {
                var label = new Label { Text = prompt, Left = 16, Top = 16, Width = 388, AutoSize = false, Height = 20 };
                var box = new TextBox { Left = 16, Top = 42, Width = 388, Text = initial ?? "" };
                var ok = new Button { Text = "OK", DialogResult = DialogResult.OK, Left = 238, Top = 84, Width = 80 };
                var cancel = new Button { Text = "Cancel", DialogResult = DialogResult.Cancel, Left = 324, Top = 84, Width = 80 };
                dialog.Controls.AddRange(new Control[] { label, box, ok, cancel });
                dialog.AcceptButton = ok;
                dialog.CancelButton = cancel;
                return dialog.ShowDialog(owner) == DialogResult.OK ? box.Text.Trim() : null;
            }
        }

        public static bool Confirm(IWin32Window owner, string text)
        {
            return MessageBox.Show(owner, text, "Tohyee", MessageBoxButtons.OKCancel, MessageBoxIcon.Question) == DialogResult.OK;
        }

        /// <summary>
        /// Runs server work with the buttons disabled, showing any refusal in the
        /// status label. Returns false if it failed.
        /// </summary>
        public static async Task<bool> Busy(Control owner, Label status, Func<Task> work)
        {
            owner.Cursor = Cursors.WaitCursor;
            owner.Enabled = false;
            try
            {
                await work();
                return true;
            }
            catch (ApiException error)
            {
                if (status != null) Show(status, error.Message, true);
                else MessageBox.Show(error.Message, "Tohyee", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return false;
            }
            finally
            {
                if (!owner.IsDisposed)
                {
                    owner.Enabled = true;
                    owner.Cursor = Cursors.Default;
                }
            }
        }
    }
}
