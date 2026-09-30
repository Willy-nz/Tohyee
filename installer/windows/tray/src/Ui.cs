using System;
using System.Drawing;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace Tohyee.Tray
{
    /// <summary>Small helpers so every screen looks and behaves the same (see Theme for the look).</summary>
    internal static class Ui
    {
        public static readonly Font Body = Theme.Body;
        public static readonly Color Muted = Theme.Muted;
        public static readonly Color Danger = Theme.Danger;
        public static readonly Color Success = Theme.Success;

        /// <summary>A page with its title and a line about what it's for, ready for cards.</summary>
        public static PageFlow Page(string title, string about)
        {
            var page = new PageFlow();
            page.Controls.Add(new Label { Text = title, Font = Theme.PageTitle, ForeColor = Theme.Text, AutoSize = true, Margin = new Padding(0, 0, 0, 4) });
            if (about != null)
            {
                page.Controls.Add(new Label { Text = about, ForeColor = Theme.Muted, AutoSize = true, Tag = "wrap", Margin = new Padding(0, 0, 0, 20) });
            }
            return page;
        }

        /// <summary>A card on the page, with an optional title and note; add controls to its Body.</summary>
        public static Card Card(Control page, string title, string note)
        {
            var card = new Card();
            if (title != null) card.Body.Controls.Add(Title(title));
            if (note != null) card.Body.Controls.Add(Note(note));
            if (page != null) page.Controls.Add(card);
            return card;
        }

        /// <summary>A card's heading.</summary>
        public static Label Title(string text)
        {
            return new Label { Text = text, Font = Theme.CardTitle, ForeColor = Theme.Text, AutoSize = true, Margin = new Padding(0, 0, 0, 6) };
        }

        public static Label Note(string text)
        {
            return new Label { Text = text, ForeColor = Theme.Muted, AutoSize = true, Tag = "wrap", MaximumSize = new Size(640, 0), Margin = new Padding(0, 0, 0, 12) };
        }

        /// <summary>A line of state in larger type (e.g. "On: every night at 02:00").</summary>
        public static Label State()
        {
            return new Label { AutoSize = true, Font = Theme.Strong, ForeColor = Theme.Text, Tag = "wrap", MaximumSize = new Size(640, 0), Margin = new Padding(0, 0, 0, 10) };
        }

        /// <summary>A line for what just happened (hidden while there's nothing to say).</summary>
        public static Label Status()
        {
            var label = new Label { AutoSize = true, Tag = "wrap", ForeColor = Theme.Text, MaximumSize = new Size(640, 0), Margin = new Padding(0, 6, 0, 4), Visible = false };
            label.TextChanged += (s, e) => label.Visible = label.Text.Length > 0;
            return label;
        }

        public static void Show(Label label, string text, bool error)
        {
            label.Text = text ?? "";
            label.ForeColor = error ? Danger : Success;
            if (label.Text.Length == 0) return;
            // Bring it into view if the page has scrolled away from it.
            for (var parent = label.Parent; parent != null; parent = parent.Parent)
            {
                var page = parent as PageFlow;
                if (page != null)
                {
                    page.ScrollControlIntoView(label);
                    break;
                }
            }
        }

        /// <summary>An ordinary (secondary) button.</summary>
        public static Button Btn(string text, EventHandler onClick)
        {
            return Button(text, ButtonKind.Secondary, onClick);
        }

        /// <summary>The main thing to do on a card.</summary>
        public static Button Primary(string text, EventHandler onClick)
        {
            return Button(text, ButtonKind.Primary, onClick);
        }

        /// <summary>Removing or turning something off.</summary>
        public static Button DangerBtn(string text, EventHandler onClick)
        {
            return Button(text, ButtonKind.Danger, onClick);
        }

        private static Button Button(string text, ButtonKind kind, EventHandler onClick)
        {
            var button = new FlatButton(text, kind);
            if (onClick != null) button.Click += onClick;
            return button;
        }

        /// <summary>A two-column form: labels on the left, fields on the right.</summary>
        public static TableLayoutPanel Form()
        {
            var table = new TableLayoutPanel { ColumnCount = 2, AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, Margin = new Padding(0, 0, 0, 8), BackColor = Color.Transparent };
            table.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, Theme.S(160)));
            table.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, Theme.S(420)));
            return table;
        }

        public static T Field<T>(TableLayoutPanel form, string label, T control) where T : Control
        {
            form.RowCount += 1;
            form.Controls.Add(new Label { Text = label, AutoSize = true, ForeColor = Theme.Muted, Anchor = AnchorStyles.Left, Margin = new Padding(0, 7, 12, 7) });
            control.Dock = DockStyle.Fill;
            control.Margin = new Padding(0, 4, 0, 4);
            Input(control);
            form.Controls.Add(control);
            return control;
        }

        /// <summary>Dark text boxes, drop-downs and check boxes.</summary>
        public static T Input<T>(T control) where T : Control
        {
            if (control is TextBox)
            {
                var box = (TextBox)(Control)control;
                box.BackColor = Theme.Input;
                box.ForeColor = Theme.Text;
                box.BorderStyle = BorderStyle.FixedSingle;
            }
            else if (control is ComboBox)
            {
                var combo = (ComboBox)(Control)control;
                combo.BackColor = Theme.Input;
                combo.ForeColor = Theme.Text;
                combo.FlatStyle = FlatStyle.Flat;
            }
            else if (control is CheckBox)
            {
                var check = (CheckBox)(Control)control;
                check.ForeColor = Theme.Text;
                check.FlatStyle = FlatStyle.Flat;
                check.FlatAppearance.BorderColor = Theme.Muted;
                check.FlatAppearance.CheckedBackColor = Theme.Accent;
            }
            return control;
        }

        public static FlowLayoutPanel Row()
        {
            return new FlowLayoutPanel { FlowDirection = FlowDirection.LeftToRight, AutoSize = true, WrapContents = true, Margin = new Padding(0, 6, 0, 2), BackColor = Color.Transparent, Tag = "wrap" };
        }

        public static ListView List(params string[] columns)
        {
            var list = new ListView
            {
                View = View.Details,
                FullRowSelect = true,
                MultiSelect = false,
                HideSelection = false,
                Width = Theme.S(760),
                Height = Theme.S(260),
                Margin = new Padding(0, 4, 0, 10),
                BackColor = Theme.Input,
                ForeColor = Theme.Text,
                BorderStyle = BorderStyle.None,
                Tag = "stretch",
                OwnerDraw = true,
                // Taller rows: a ListView's row height follows its image list.
                SmallImageList = new ImageList { ImageSize = new Size(1, Theme.S(28)) },
            };
            list.DrawColumnHeader += (s, e) =>
            {
                using (var back = new SolidBrush(Theme.Header)) e.Graphics.FillRectangle(back, e.Bounds);
                using (var line = new Pen(Theme.CardBorder)) e.Graphics.DrawLine(line, e.Bounds.Left, e.Bounds.Bottom - 1, e.Bounds.Right, e.Bounds.Bottom - 1);
                var text = new Rectangle(e.Bounds.X + 8, e.Bounds.Y, e.Bounds.Width - 10, e.Bounds.Height);
                TextRenderer.DrawText(e.Graphics, e.Header.Text, Theme.SmallCaps, text, Theme.Muted, TextFormatFlags.VerticalCenter | TextFormatFlags.Left | TextFormatFlags.EndEllipsis | TextFormatFlags.SingleLine);
            };
            list.DrawItem += (s, e) => e.DrawDefault = true;
            list.Resize += (s, e) => FillLastColumn(list);
            Theme.DarkScrollBars(list);
            list.DrawSubItem += (s, e) => e.DrawDefault = true;
            foreach (var column in columns)
            {
                list.Columns.Add(column, -2);
            }
            return list;
        }

        /// <summary>Columns as wide as their contents, the last one filling the rest (so the header has no gap).</summary>
        public static void FitColumns(ListView list)
        {
            var lastIndex = list.Columns.Count - 1;
            for (var i = 0; i < lastIndex; i++) list.Columns[i].Width = -2;
            if (lastIndex < 0) return;
            // The last column: measured, since "-2" there means "fill the list" (and Mono overdoes it).
            var needed = TextRenderer.MeasureText(list.Columns[lastIndex].Text, Theme.SmallCaps).Width;
            foreach (ListViewItem item in list.Items)
            {
                if (item.SubItems.Count > lastIndex) needed = Math.Max(needed, TextRenderer.MeasureText(item.SubItems[lastIndex].Text, list.Font).Width);
            }
            list.Columns[lastIndex].Tag = needed + 20;
            list.Columns[lastIndex].Width = needed + 20;
            FillLastColumn(list);
        }

        private static void FillLastColumn(ListView list)
        {
            if (list.Columns.Count == 0) return;
            var used = 0;
            for (var i = 0; i < list.Columns.Count - 1; i++) used += list.Columns[i].Width;
            var last = list.Columns[list.Columns.Count - 1];
            // Leave room for a vertical scroll bar if the rows don't all fit.
            var rows = (list.Items.Count + 1) * Theme.S(28);
            var room = list.ClientSize.Width - used - 4 - (rows > list.ClientSize.Height ? SystemInformation.VerticalScrollBarWidth : 0);
            var needed = last.Tag is int ? (int)last.Tag : last.Width;
            last.Width = Math.Max(needed, room);
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
                ClientSize = new Size(Theme.S(440), Theme.S(140)),
            })
            {
                var label = new Label { Text = prompt, Left = Theme.S(16), Top = Theme.S(16), Width = Theme.S(408), AutoSize = false, Height = Theme.S(22) };
                var box = new TextBox { Left = Theme.S(16), Top = Theme.S(44), Width = Theme.S(408), Text = initial ?? "" };
                var ok = new Button { Text = "OK", DialogResult = DialogResult.OK, Left = Theme.S(252), Top = Theme.S(92), Width = Theme.S(84), Height = Theme.S(30) };
                var cancel = new Button { Text = "Cancel", DialogResult = DialogResult.Cancel, Left = Theme.S(340), Top = Theme.S(92), Width = Theme.S(84), Height = Theme.S(30) };
                dialog.Controls.AddRange(new Control[] { label, box, ok, cancel });
                dialog.AcceptButton = ok;
                dialog.CancelButton = cancel;
                Theme.Apply(dialog);
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

        /// <summary>A short "3 days", "5 hours" for how long something has been going.</summary>
        public static string Duration(TimeSpan span)
        {
            if (span.TotalDays >= 2) return (int)span.TotalDays + " days";
            if (span.TotalDays >= 1) return "1 day " + span.Hours + (span.Hours == 1 ? " hour" : " hours");
            if (span.TotalHours >= 1) return (int)span.TotalHours + ((int)span.TotalHours == 1 ? " hour" : " hours");
            var minutes = Math.Max(1, (int)span.TotalMinutes);
            return minutes + (minutes == 1 ? " minute" : " minutes");
        }
    }
}
