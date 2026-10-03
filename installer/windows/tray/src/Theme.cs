using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace Tohyee.Tray
{
    /// <summary>
    /// The server app's look: dark charcoal like a media server's app, one
    /// accent colour (Tohyee blue), Segoe UI, cards with rounded corners.
    /// </summary>
    internal static class Theme
    {
        /// <summary>
        /// Screen scale (1 at 100%, 1.5 at 150%): the app is DPI-aware (app.manifest),
        /// so fixed pixel sizes are multiplied by this; fonts in points scale by
        /// themselves. TOHYEE_UI_SCALE overrides it, for checking layouts (the
        /// screenshots mode then scales the fonts too, as Windows would).
        /// </summary>
        public static readonly float Scale = ReadScale();
        public static readonly float FontScale = Environment.GetEnvironmentVariable("TOHYEE_UI_SCALE") != null ? Scale : 1f;

        private static float ReadScale()
        {
            float forced;
            var text = Environment.GetEnvironmentVariable("TOHYEE_UI_SCALE");
            if (text != null && float.TryParse(text, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out forced) && forced >= 1 && forced <= 3) return forced;
            try
            {
                using (var g = Graphics.FromHwnd(IntPtr.Zero)) return Math.Max(1f, g.DpiX / 96f);
            }
            catch (Exception)
            {
                return 1f;
            }
        }

        /// <summary>Pixels at 100%, scaled for this screen.</summary>
        public static int S(int pixels)
        {
            return (int)Math.Round(pixels * Scale);
        }

        public static Font F(string family, float points)
        {
            return new Font(family, points * FontScale);
        }

        /// <summary>Opt-in light palette for checking the app in both themes; dark is the default.</summary>
        public static readonly bool Light = Environment.GetEnvironmentVariable("TOHYEE_UI_THEME") == "light";
        public static readonly Color Bg = Light ? Color.FromArgb(244, 246, 249) : Color.FromArgb(28, 31, 36);
        public static readonly Color Sidebar = Light ? Color.FromArgb(235, 239, 245) : Color.FromArgb(20, 22, 26);
        public static readonly Color Card = Light ? Color.White : Color.FromArgb(38, 42, 49);
        public static readonly Color CardBorder = Light ? Color.FromArgb(212, 218, 228) : Color.FromArgb(52, 57, 67);
        public static readonly Color Input = Light ? Color.FromArgb(248, 250, 252) : Color.FromArgb(27, 30, 35);
        public static readonly Color Header = Light ? Color.FromArgb(235, 239, 245) : Color.FromArgb(31, 35, 41);
        public static readonly Color Text = Light ? Color.FromArgb(28, 31, 36) : Color.FromArgb(236, 239, 243);
        public static readonly Color Muted = Light ? Color.FromArgb(82, 94, 112) : Color.FromArgb(160, 168, 180);
        /// <summary>Tohyee blue, for filled buttons (white text on it).</summary>
        public static readonly Color Accent = Color.FromArgb(37, 99, 235);
        public static readonly Color AccentHover = Color.FromArgb(59, 118, 245);
        /// <summary>A lighter blue for text and highlights on the dark background.</summary>
        public static readonly Color AccentText = Light ? Accent : Color.FromArgb(122, 167, 255);
        public static readonly Color Secondary = Light ? Color.FromArgb(229, 234, 242) : Color.FromArgb(52, 58, 69);
        public static readonly Color SecondaryHover = Light ? Color.FromArgb(216, 223, 234) : Color.FromArgb(64, 71, 84);
        public static readonly Color DangerFill = Color.FromArgb(92, 35, 40);
        public static readonly Color DangerHover = Color.FromArgb(118, 42, 48);
        public static readonly Color NavSelected = Light ? Color.FromArgb(215, 228, 252) : Color.FromArgb(40, 47, 60);
        public static readonly Color NavHover = Light ? Color.FromArgb(224, 230, 240) : Color.FromArgb(30, 34, 40);
        public static readonly Color Success = Light ? Color.FromArgb(21, 128, 61) : Color.FromArgb(74, 222, 128);
        public static readonly Color Danger = Light ? Color.FromArgb(185, 28, 28) : Color.FromArgb(248, 113, 113);
        public static readonly Color Warning = Light ? Color.FromArgb(146, 94, 10) : Color.FromArgb(251, 191, 36);

        public static readonly Font Body = F("Segoe UI", 9.75f);
        public static readonly Font Small = F("Segoe UI", 8.75f);
        public static readonly Font SmallCaps = F("Segoe UI Semibold", 8.25f);
        public static readonly Font Strong = F("Segoe UI Semibold", 10.5f);
        public static readonly Font CardTitle = F("Segoe UI Semibold", 12f);
        public static readonly Font PageTitle = F("Segoe UI Semibold", 19f);
        public static readonly Font Big = F("Segoe UI Semibold", 17f);
        public static readonly Font Nav = F("Segoe UI", 10.25f);
        public static readonly Font NavSelectedFont = F("Segoe UI Semibold", 10.25f);
        public static readonly Font Mono = F("Consolas", 9f);

        private static Image _logo;
        private static Icon _appIcon;

        /// <summary>The Tohyee logo (the white Japanese Spitz on blue), 128 px.</summary>
        public static Image Logo
        {
            get { return _logo ?? (_logo = LoadImage("logo-128.png")); }
        }

        /// <summary>The window and app icon (assets/tohyee.ico, rendered from assets/logo.svg).</summary>
        public static Icon AppIcon
        {
            get
            {
                if (_appIcon != null) return _appIcon;
                try
                {
                    using (var stream = typeof(Theme).Assembly.GetManifestResourceStream("Tohyee.Tray.tohyee.ico"))
                    {
                        if (stream != null) _appIcon = new Icon(stream);
                    }
                }
                catch (Exception)
                {
                    _appIcon = null;
                }
                return _appIcon;
            }
        }

        public static Image LoadImage(string name)
        {
            try
            {
                using (var stream = typeof(Theme).Assembly.GetManifestResourceStream("Tohyee.Tray." + name))
                {
                    if (stream == null) return null;
                    using (var copy = new MemoryStream())
                    {
                        stream.CopyTo(copy);
                        // Bitmap needs its stream kept open, so give it its own copy.
                        return new Bitmap(new MemoryStream(copy.ToArray()));
                    }
                }
            }
            catch (Exception)
            {
                return null;
            }
        }

        /// <summary>The colour behind a control, looking through transparent parents.</summary>
        public static Color BackOf(Control control)
        {
            for (var parent = control.Parent; parent != null; parent = parent.Parent)
            {
                if (parent.BackColor.A == 255) return parent.BackColor;
            }
            return Bg;
        }

        [DllImport("uxtheme.dll", CharSet = CharSet.Unicode)]
        private static extern int SetWindowTheme(IntPtr hwnd, string appName, string idList);

        /// <summary>Dark scroll bars (Windows 10 1809+ and 11). Harmless elsewhere.</summary>
        public static void DarkScrollBars(Control control)
        {
            if (Environment.OSVersion.Platform != PlatformID.Win32NT) return;
            control.HandleCreated += (s, e) =>
            {
                try
                {
                    SetWindowTheme(control.Handle, Light ? "Explorer" : "DarkMode_Explorer", null);
                }
                catch (Exception)
                {
                    // Older Windows: light scroll bars.
                }
            };
        }

        public static GraphicsPath Rounded(RectangleF r, float radius)
        {
            var path = new GraphicsPath();
            var d = Math.Min(radius * 2, Math.Min(r.Width, r.Height));
            if (d <= 0)
            {
                path.AddRectangle(r);
                return path;
            }
            path.AddArc(r.X, r.Y, d, d, 180, 90);
            path.AddArc(r.Right - d, r.Y, d, d, 270, 90);
            path.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
            path.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
            path.CloseFigure();
            return path;
        }

        // ------------------------------------------------------------ dark title bar

        [DllImport("dwmapi.dll")]
        private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);

        /// <summary>Asks Windows 10 (20H1+) and 11 for a dark title bar. Harmless elsewhere.</summary>
        public static void DarkTitleBar(Form form)
        {
            if (Environment.OSVersion.Platform != PlatformID.Win32NT) return;
            try
            {
                var on = Light ? 0 : 1;
                if (DwmSetWindowAttribute(form.Handle, 20, ref on, 4) != 0) DwmSetWindowAttribute(form.Handle, 19, ref on, 4);
            }
            catch (Exception)
            {
                // Older Windows: a light title bar.
            }
        }

        // ------------------------------------------------------------ dressing ordinary controls

        /// <summary>
        /// Gives a dialog (or any control tree) the dark look: text boxes, lists,
        /// check boxes and plain buttons. Colours already set on purpose (status
        /// text) are kept.
        /// </summary>
        public static void Apply(Control root)
        {
            var form = root as Form;
            if (form != null)
            {
                form.BackColor = Bg;
                form.ForeColor = Text;
                if (AppIcon != null) form.Icon = AppIcon;
                form.HandleCreated += (s, e) => DarkTitleBar(form);
            }
            Dress(root);
        }

        private static void Dress(Control control)
        {
            if (control is FlatButton || control is NavItem || control is Card) { }
            else if (control is TextBox)
            {
                var box = (TextBox)control;
                box.BackColor = Input;
                box.ForeColor = Text;
                box.BorderStyle = BorderStyle.FixedSingle;
            }
            else if (control is ComboBox)
            {
                var combo = (ComboBox)control;
                combo.BackColor = Input;
                combo.ForeColor = Text;
                combo.FlatStyle = FlatStyle.Flat;
            }
            else if (control is CheckBox)
            {
                var check = (CheckBox)control;
                check.ForeColor = Text;
                check.FlatStyle = FlatStyle.Flat;
                check.FlatAppearance.BorderColor = Muted;
                check.FlatAppearance.CheckedBackColor = Accent;
            }
            else if (control is Button)
            {
                var button = (Button)control;
                button.FlatStyle = FlatStyle.Flat;
                button.FlatAppearance.BorderSize = 0;
                button.FlatAppearance.MouseOverBackColor = SecondaryHover;
                button.BackColor = Secondary;
                button.ForeColor = Text;
                button.Height = Math.Max(button.Height, 30);
            }
            else if (control is Label)
            {
                if (IsDefaultText(control.ForeColor)) control.ForeColor = Text;
            }
            else if (control is Panel || control is UserControl)
            {
                if (control.BackColor == SystemColors.Control || control.BackColor == Color.Transparent) control.BackColor = control.Parent != null ? control.Parent.BackColor : Bg;
            }
            foreach (Control child in control.Controls) Dress(child);
        }

        private static bool IsDefaultText(Color colour)
        {
            return colour == SystemColors.ControlText || colour == Color.Black || colour.ToArgb() == Color.Black.ToArgb();
        }
    }

    internal enum ButtonKind
    {
        Secondary,
        Primary,
        Danger,
    }

    /// <summary>
    /// A tick box drawn to match the theme. Windows' own flat tick box draws a
    /// white box with the tick in the text colour, and this theme's text is
    /// near-white, so a ticked box looked empty (seen on Jess's server, 2 Oct 2026).
    /// </summary>
    internal sealed class DarkCheckBox : CheckBox
    {
        public DarkCheckBox()
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
            ForeColor = Theme.Text;
            Cursor = Cursors.Hand;
        }

        public override Size GetPreferredSize(Size proposedSize)
        {
            var text = TextRenderer.MeasureText(Text ?? "", Font);
            return new Size(Theme.S(26) + text.Width, Math.Max(Theme.S(22), text.Height + Theme.S(4)));
        }

        protected override void OnCheckedChanged(EventArgs e)
        {
            base.OnCheckedChanged(e);
            Invalidate();
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics;
            g.Clear(Theme.BackOf(this));
            g.SmoothingMode = SmoothingMode.AntiAlias;
            var size = Theme.S(16);
            var box = new RectangleF(1, (Height - size) / 2f, size, size);
            using (var path = Theme.Rounded(box, Theme.S(4)))
            {
                using (var fill = new SolidBrush(Checked ? Theme.Accent : Theme.Input)) g.FillPath(fill, path);
                using (var border = new Pen(Checked ? Theme.Accent : (Focused ? Theme.AccentText : Theme.Muted))) g.DrawPath(border, path);
            }
            if (Checked)
            {
                using (var tick = new Pen(Color.White, Theme.S(2)) { StartCap = LineCap.Round, EndCap = LineCap.Round, LineJoin = LineJoin.Round })
                {
                    g.DrawLines(tick, new[]
                    {
                        new PointF(box.Left + size * 0.24f, box.Top + size * 0.52f),
                        new PointF(box.Left + size * 0.43f, box.Top + size * 0.72f),
                        new PointF(box.Left + size * 0.78f, box.Top + size * 0.30f),
                    });
                }
            }
            var textArea = new Rectangle(Theme.S(26), 0, Width - Theme.S(26), Height);
            TextRenderer.DrawText(g, Text, Font, textArea, Enabled ? ForeColor : Theme.Muted, TextFormatFlags.VerticalCenter | TextFormatFlags.Left | TextFormatFlags.WordBreak);
        }
    }

    /// <summary>A flat button with rounded corners, drawn to match the theme.</summary>
    internal sealed class FlatButton : Button
    {
        private bool _hover;
        private bool _down;

        public ButtonKind Kind { get; set; }

        public FlatButton(string text, ButtonKind kind)
        {
            Text = text;
            Kind = kind;
            Font = kind == ButtonKind.Primary ? Theme.F("Segoe UI Semibold", 9.75f) : Theme.Body;
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
            FlatStyle = FlatStyle.Flat;
            FlatAppearance.BorderSize = 0;
            Cursor = Cursors.Hand;
            AutoSize = true;
            Margin = new Padding(0, 0, Theme.S(8), Theme.S(8));
            ForeColor = Color.White;
        }

        public override Size GetPreferredSize(Size proposedSize)
        {
            var text = TextRenderer.MeasureText(Text, Font);
            return new Size(text.Width + Theme.S(30), Math.Max(Theme.S(32), text.Height + Theme.S(14)));
        }

        protected override void OnMouseEnter(EventArgs e) { _hover = true; Invalidate(); base.OnMouseEnter(e); }
        protected override void OnMouseLeave(EventArgs e) { _hover = false; _down = false; Invalidate(); base.OnMouseLeave(e); }
        protected override void OnMouseDown(MouseEventArgs e) { _down = true; Invalidate(); base.OnMouseDown(e); }
        protected override void OnMouseUp(MouseEventArgs e) { _down = false; Invalidate(); base.OnMouseUp(e); }
        protected override void OnEnabledChanged(EventArgs e) { Invalidate(); base.OnEnabledChanged(e); }

        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics;
            g.Clear(Theme.BackOf(this));
            g.SmoothingMode = SmoothingMode.AntiAlias;
            Color fill;
            Color text = Color.White;
            switch (Kind)
            {
                case ButtonKind.Primary:
                    fill = _hover ? Theme.AccentHover : Theme.Accent;
                    break;
                case ButtonKind.Danger:
                    fill = _hover ? Theme.DangerHover : Theme.DangerFill;
                    text = Color.FromArgb(254, 202, 202);
                    break;
                default:
                    fill = _hover ? Theme.SecondaryHover : Theme.Secondary;
                    text = Theme.Text;
                    break;
            }
            if (_down) fill = ControlPaint.Dark(fill, 0.05f);
            if (!Enabled)
            {
                fill = Color.FromArgb(120, fill);
                text = Color.FromArgb(130, text);
            }
            using (var path = Theme.Rounded(new RectangleF(0.5f, 0.5f, Width - 1.5f, Height - 1.5f), Theme.S(6)))
            using (var brush = new SolidBrush(fill))
            {
                g.FillPath(brush, path);
                if (Focused && ShowFocusCues)
                {
                    using (var pen = new Pen(Theme.AccentText, 1.5f)) g.DrawPath(pen, path);
                }
            }
            TextRenderer.DrawText(g, Text, Font, ClientRectangle, text, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine);
        }
    }

    /// <summary>
    /// A card: a rounded panel with a vertical list of controls (Body). Its
    /// height follows what's in it; its width is set by the page.
    /// </summary>
    internal sealed class Card : Panel
    {
        public static readonly int Pad = Theme.S(20);
        public readonly FlowLayoutPanel Body;
        private int _minContentHeight;

        public Color Fill { get; set; }

        /// <summary>A coloured strip along the card's left edge (e.g. the accent), or empty.</summary>
        public Color Strip { get; set; }

        public Card()
        {
            Fill = Theme.Card;
            Strip = Color.Empty;
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw | ControlStyles.UserPaint, true);
            BackColor = Theme.Bg;
            Margin = new Padding(0, 0, 0, Theme.S(16));
            Body = new FlowLayoutPanel
            {
                FlowDirection = FlowDirection.TopDown,
                WrapContents = false,
                AutoSize = true,
                AutoSizeMode = AutoSizeMode.GrowAndShrink,
                BackColor = Fill,
                ForeColor = Theme.Text,
                Location = new Point(Pad, Pad),
                Margin = new Padding(0),
                Padding = new Padding(0),
            };
            Body.SizeChanged += (s, e) => FitHeight();
            Body.ControlAdded += (s, e) => { Fit(e.Control); FitHeight(); };
            Controls.Add(Body);
            Width = 600;
        }

        /// <summary>The height the content needs.</summary>
        public int ContentHeight
        {
            get { return Body.Height + Pad * 2; }
        }

        /// <summary>Keeps cards in a row the same height.</summary>
        public int MinContentHeight
        {
            get { return _minContentHeight; }
            set { _minContentHeight = value; FitHeight(); }
        }

        public int InnerWidth
        {
            get { return Math.Max(100, Width - Pad * 2); }
        }

        private void FitHeight()
        {
            var height = Math.Max(ContentHeight, _minContentHeight);
            if (Height != height) Height = height;
        }

        protected override void OnResize(EventArgs eventargs)
        {
            base.OnResize(eventargs);
            Refit();
        }

        /// <summary>Makes wrapping text and stretching lists follow the card's width (also inside nested groups).</summary>
        public void Refit()
        {
            Body.BackColor = Fill;
            Body.MinimumSize = new Size(InnerWidth, 0);
            Body.MaximumSize = new Size(InnerWidth, 0);
            Body.SuspendLayout();
            foreach (Control child in Body.Controls) Fit(child, InnerWidth);
            Body.ResumeLayout();
        }

        private void Fit(Control child)
        {
            Fit(child, InnerWidth);
        }

        internal static void Fit(Control child, int available)
        {
            var tag = child.Tag as string;
            var width = Math.Max(40, available - child.Margin.Horizontal);
            if (tag == "wrap")
            {
                child.MaximumSize = new Size(width, 0);
            }
            else if (tag == "stretch")
            {
                // Auto-sized groups ignore Width, so pin it with the minimum and maximum.
                // A maximum height of 0 means "no limit" only to auto-sized controls: on
                // Windows (.NET Framework) it cuts a fixed-height one (a list, a graph) to
                // nothing, which hid the organisation and user lists (2 Oct 2026). Mono
                // treats 0 as no limit for both, so it only showed on Windows.
                child.MinimumSize = new Size(width, 0);
                child.MaximumSize = new Size(width, child.AutoSize ? 0 : 100000);
                child.Width = width;
                var inner = width - child.Padding.Horizontal;
                if (!(child is ListView) && !(child is TableLayoutPanel))
                {
                    foreach (Control grandchild in child.Controls) Fit(grandchild, inner);
                }
            }
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics;
            g.Clear(Theme.BackOf(this));
            g.SmoothingMode = SmoothingMode.AntiAlias;
            using (var path = Theme.Rounded(new RectangleF(0.5f, 0.5f, Width - 1.5f, Height - 1.5f), Theme.S(10)))
            using (var brush = new SolidBrush(Fill))
            using (var pen = new Pen(Theme.CardBorder))
            {
                g.FillPath(brush, path);
                if (Strip != Color.Empty)
                {
                    var clip = g.Clip;
                    g.SetClip(path);
                    using (var strip = new SolidBrush(Strip)) g.FillRectangle(strip, 0, 0, Theme.S(5), Height);
                    g.Clip = clip;
                }
                g.DrawPath(pen, path);
            }
        }
    }

    /// <summary>
    /// A page: a scrolling column of cards that stretch to its width (up to a
    /// comfortable reading width).
    /// </summary>
    internal sealed class PageFlow : FlowLayoutPanel
    {
        public static readonly int MaxWidth = Theme.S(1040);
        private bool _fitting;

        public PageFlow()
        {
            Dock = DockStyle.Fill;
            FlowDirection = FlowDirection.TopDown;
            WrapContents = false;
            AutoScroll = true;
            BackColor = Theme.Bg;
            ForeColor = Theme.Text;
            Padding = new Padding(Theme.S(32), Theme.S(28), Theme.S(32), Theme.S(24));
            SetStyle(ControlStyles.OptimizedDoubleBuffer | ControlStyles.AllPaintingInWmPaint, true);
            Theme.DarkScrollBars(this);
        }

        public int ContentWidth
        {
            // Room for the scroll bar is always kept, so cards don't jump or overflow when it appears.
            get { return Math.Max(320, Math.Min(MaxWidth, ClientSize.Width - Padding.Horizontal - SystemInformation.VerticalScrollBarWidth)); }
        }

        protected override void OnLayout(LayoutEventArgs levent)
        {
            if (!_fitting)
            {
                _fitting = true;
                try
                {
                    foreach (Control child in Controls)
                    {
                        var width = ContentWidth - child.Margin.Horizontal;
                        if (child is Card || child is SplitRow || (child.Tag as string) == "stretch")
                        {
                            if (child.Width != width) child.Width = width;
                        }
                        else if ((child.Tag as string) == "wrap")
                        {
                            child.MaximumSize = new Size(width, 0);
                        }
                    }
                }
                finally
                {
                    _fitting = false;
                }
            }
            base.OnLayout(levent);
        }
    }

    /// <summary>Cards side by side, sharing the width by weight, all as tall as the tallest.</summary>
    internal sealed class SplitRow : Panel
    {
        public static readonly int Gap = Theme.S(16);
        private readonly float[] _weights;
        private readonly Card[] _cards;
        private bool _fitting;

        public SplitRow(Card[] cards, float[] weights)
        {
            _cards = cards;
            _weights = weights;
            BackColor = Theme.Bg;
            Margin = new Padding(0, 0, 0, Theme.S(16));
            foreach (var card in cards)
            {
                card.Margin = new Padding(0);
                Controls.Add(card);
                card.Body.SizeChanged += (s, e) => PerformLayout();
            }
        }

        protected override void OnLayout(LayoutEventArgs levent)
        {
            base.OnLayout(levent);
            if (_fitting) return;
            _fitting = true;
            try
            {
                var total = 0f;
                foreach (var weight in _weights) total += weight;
                var free = Width - Gap * (_cards.Length - 1);
                var x = 0;
                for (var i = 0; i < _cards.Length; i++)
                {
                    var width = i == _cards.Length - 1 ? Width - x : (int)(free * _weights[i] / total);
                    _cards[i].Location = new Point(x, 0);
                    _cards[i].Width = width;
                    x += width + Gap;
                }
                var height = 0;
                foreach (var card in _cards) height = Math.Max(height, card.ContentHeight);
                foreach (var card in _cards) card.MinContentHeight = height;
                if (Height != height) Height = height;
            }
            finally
            {
                _fitting = false;
            }
        }
    }

    internal enum Glyph
    {
        Home,
        Organisations,
        Users,
        Phone,
        Backups,
        Email,
        Updates,
        Stats,
        Open,
        SignOut,
        News,
        Calendar,
    }

    /// <summary>Small line icons, drawn so they're crisp at any size and need no icon font.</summary>
    internal static class Icons
    {
        public static void Draw(Graphics g, Glyph glyph, RectangleF box, Color colour)
        {
            var state = g.Save();
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.TranslateTransform(box.X, box.Y);
            g.ScaleTransform(box.Width / 20f, box.Height / 20f);
            using (var pen = new Pen(colour, 1.6f) { LineJoin = LineJoin.Round, StartCap = LineCap.Round, EndCap = LineCap.Round })
            using (var brush = new SolidBrush(colour))
            {
                switch (glyph)
                {
                    case Glyph.Home:
                        g.DrawLines(pen, new[] { new PointF(2.5f, 9.5f), new PointF(10, 3), new PointF(17.5f, 9.5f) });
                        g.DrawLines(pen, new[] { new PointF(4.5f, 8), new PointF(4.5f, 17), new PointF(15.5f, 17), new PointF(15.5f, 8) });
                        g.DrawLines(pen, new[] { new PointF(8.5f, 17), new PointF(8.5f, 12), new PointF(11.5f, 12), new PointF(11.5f, 17) });
                        break;
                    case Glyph.Organisations:
                        g.DrawRectangle(pen, 4, 3, 12, 14);
                        for (var row = 0; row < 3; row++)
                        {
                            g.FillRectangle(brush, 6.8f, 5.6f + row * 3.2f, 2, 1.8f);
                            g.FillRectangle(brush, 11.2f, 5.6f + row * 3.2f, 2, 1.8f);
                        }
                        g.DrawLine(pen, 10, 17, 10, 14.5f);
                        break;
                    case Glyph.Users:
                        g.DrawEllipse(pen, 4.5f, 3.5f, 6, 6);
                        g.DrawArc(pen, 2, 11.5f, 11, 10, 180, 180);
                        g.DrawArc(pen, 11.5f, 4.5f, 4.5f, 4.5f, 250, 250);
                        g.DrawArc(pen, 12.5f, 12, 7, 8, 250, 110);
                        break;
                    case Glyph.Phone:
                        using (var path = Theme.Rounded(new RectangleF(5.5f, 2, 9, 16), 2))
                        {
                            g.DrawPath(pen, path);
                        }
                        g.DrawLine(pen, 9, 15, 11, 15);
                        break;
                    case Glyph.Backups:
                        g.DrawRectangle(pen, 3, 4, 14, 4);
                        g.DrawLines(pen, new[] { new PointF(4.5f, 8), new PointF(4.5f, 16.5f), new PointF(15.5f, 16.5f), new PointF(15.5f, 8) });
                        g.DrawLine(pen, 8, 11, 12, 11);
                        break;
                    case Glyph.Email:
                        g.DrawRectangle(pen, 2.5f, 4.5f, 15, 11);
                        g.DrawLines(pen, new[] { new PointF(3, 5), new PointF(10, 11), new PointF(17, 5) });
                        break;
                    case Glyph.Updates:
                        g.DrawArc(pen, 3.5f, 3.5f, 13, 13, 300, 300);
                        g.DrawLines(pen, new[] { new PointF(14.5f, 2.5f), new PointF(14.3f, 5.6f), new PointF(11.2f, 5.4f) });
                        break;
                    case Glyph.Stats:
                        g.DrawLines(pen, new[] { new PointF(3, 3), new PointF(3, 17), new PointF(17, 17) });
                        g.DrawLines(pen, new[] { new PointF(5.5f, 13.5f), new PointF(9, 9), new PointF(12, 11.5f), new PointF(16.5f, 5.5f) });
                        break;
                    case Glyph.Open:
                        g.DrawLines(pen, new[] { new PointF(9, 4), new PointF(4, 4), new PointF(4, 16), new PointF(16, 16), new PointF(16, 11) });
                        g.DrawLine(pen, 9.5f, 10.5f, 16.5f, 3.5f);
                        g.DrawLines(pen, new[] { new PointF(12, 3.5f), new PointF(16.5f, 3.5f), new PointF(16.5f, 8) });
                        break;
                    case Glyph.SignOut:
                        g.DrawLines(pen, new[] { new PointF(11, 4), new PointF(4, 4), new PointF(4, 16), new PointF(11, 16) });
                        g.DrawLine(pen, 8, 10, 17, 10);
                        g.DrawLines(pen, new[] { new PointF(14, 7), new PointF(17, 10), new PointF(14, 13) });
                        break;
                    case Glyph.News:
                        g.DrawRectangle(pen, 3, 4, 14, 12);
                        g.DrawLine(pen, 6, 8, 14, 8);
                        g.DrawLine(pen, 6, 11, 14, 11);
                        g.DrawLine(pen, 6, 13.5f, 11, 13.5f);
                        break;
                    case Glyph.Calendar:
                        g.DrawRectangle(pen, 3, 4.5f, 14, 12.5f);
                        g.DrawLine(pen, 3, 8.5f, 17, 8.5f);
                        g.DrawLine(pen, 7, 2.5f, 7, 6);
                        g.DrawLine(pen, 13, 2.5f, 13, 6);
                        break;
                }
            }
            g.Restore(state);
        }
    }

    /// <summary>A sidebar item: an icon and a name, highlighted when it's the current page.</summary>
    internal sealed class NavItem : Control
    {
        private bool _hover;
        private bool _selected;

        public Glyph Glyph { get; private set; }
        public string Key { get; private set; }

        public bool Selected
        {
            get { return _selected; }
            set { _selected = value; Invalidate(); }
        }

        public NavItem(string key, string text, Glyph glyph)
        {
            Key = key;
            Text = text;
            Glyph = glyph;
            Height = Theme.S(40);
            Cursor = Cursors.Hand;
            TabStop = true;
            Margin = new Padding(0, 0, 0, 2);
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw | ControlStyles.Selectable, true);
            BackColor = Theme.Sidebar;
        }

        protected override void OnMouseEnter(EventArgs e) { _hover = true; Invalidate(); base.OnMouseEnter(e); }
        protected override void OnMouseLeave(EventArgs e) { _hover = false; Invalidate(); base.OnMouseLeave(e); }
        protected override void OnGotFocus(EventArgs e) { Invalidate(); base.OnGotFocus(e); }
        protected override void OnLostFocus(EventArgs e) { Invalidate(); base.OnLostFocus(e); }

        protected override void OnKeyDown(KeyEventArgs e)
        {
            if (e.KeyCode == Keys.Enter || e.KeyCode == Keys.Space) OnClick(EventArgs.Empty);
            base.OnKeyDown(e);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics;
            g.Clear(Theme.Sidebar);
            g.SmoothingMode = SmoothingMode.AntiAlias;
            if (_selected || _hover)
            {
                using (var path = Theme.Rounded(new RectangleF(0, 0, Width - 1, Height - 1), Theme.S(8)))
                using (var brush = new SolidBrush(_selected ? Theme.NavSelected : Theme.NavHover))
                {
                    g.FillPath(brush, path);
                }
            }
            if (_selected)
            {
                using (var path = Theme.Rounded(new RectangleF(0, Theme.S(9), Theme.S(4), Height - Theme.S(18)), Theme.S(2)))
                using (var brush = new SolidBrush(Theme.AccentText))
                {
                    g.FillPath(brush, path);
                }
            }
            if (Focused && ShowFocusCues)
            {
                using (var path = Theme.Rounded(new RectangleF(0.5f, 0.5f, Width - 2, Height - 2), 8))
                using (var pen = new Pen(Theme.AccentText))
                {
                    g.DrawPath(pen, path);
                }
            }
            var colour = _selected ? (Theme.Light ? Theme.Text : Color.White) : Theme.Muted;
            Icons.Draw(g, Glyph, new RectangleF(Theme.S(16), (Height - Theme.S(20)) / 2f, Theme.S(20), Theme.S(20)), _selected ? Theme.AccentText : colour);
            TextRenderer.DrawText(g, Text, _selected ? Theme.NavSelectedFont : Theme.Nav, new Rectangle(Theme.S(48), 0, Width - Theme.S(52), Height), colour,
                TextFormatFlags.VerticalCenter | TextFormatFlags.Left | TextFormatFlags.SingleLine | TextFormatFlags.EndEllipsis);
        }
    }

    /// <summary>A coloured status dot (green, amber, red, grey).</summary>
    internal sealed class Dot : Control
    {
        private Color _colour = Theme.Muted;

        public Color Colour
        {
            get { return _colour; }
            set { _colour = value; Invalidate(); }
        }

        public Dot()
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer, true);
            Size = new Size(Theme.S(12), Theme.S(12));
            Margin = new Padding(0, Theme.S(7), Theme.S(8), 0);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            e.Graphics.Clear(Theme.BackOf(this));
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            using (var halo = new SolidBrush(Color.FromArgb(60, _colour))) e.Graphics.FillEllipse(halo, 0, 0, Width - 1, Height - 1);
            using (var brush = new SolidBrush(_colour)) e.Graphics.FillEllipse(brush, 2.5f, 2.5f, Width - 6, Height - 6);
        }
    }

    /// <summary>A picture that paints itself (an icon, the logo) on the card's colour.</summary>
    internal sealed class Picture : Control
    {
        private readonly Action<Graphics, Rectangle> _paint;

        public Picture(Size size, Action<Graphics, Rectangle> paint)
        {
            _paint = paint;
            Size = size;
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            e.Graphics.Clear(Theme.BackOf(this));
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            e.Graphics.InterpolationMode = InterpolationMode.HighQualityBicubic;
            e.Graphics.PixelOffsetMode = PixelOffsetMode.HighQuality;
            _paint(e.Graphics, ClientRectangle);
        }

        public static Picture Logo(int size)
        {
            return new Picture(new Size(Theme.S(size), Theme.S(size)), (g, r) =>
            {
                var logo = Theme.Logo;
                if (logo != null) g.DrawImage(logo, r);
            });
        }

        public static Picture Icon(Glyph glyph, int size, Color colour)
        {
            return new Picture(new Size(Theme.S(size), Theme.S(size)), (g, r) => Icons.Draw(g, glyph, r, colour));
        }
    }
}
