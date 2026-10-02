using System;
using System.Collections.Generic;
using System.Drawing;
using System.Text;
using System.Windows.Forms;

namespace Tohyee.Tray
{
    /// <summary>
    /// A small QR code maker (byte mode, error correction level M, versions 1
    /// to 40), for showing the remote access address so a phone camera can open
    /// it. Written for Tohyee following the QR code standard (ISO/IEC 18004);
    /// the structure follows Project Nayuki's public description of the
    /// algorithm. No outside code or packages.
    /// </summary>
    internal sealed class QrCode
    {
        // Level M, indexed by version (index 0 unused).
        private static readonly int[] EccPerBlock =
        {
            -1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26,
            26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28,
        };

        private static readonly int[] Blocks =
        {
            -1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16,
            17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49,
        };

        private const int FormatBitsM = 0;

        public int Version { get; private set; }
        public int Size { get; private set; }
        private readonly bool[,] _modules;
        private readonly bool[,] _function;

        /// <summary>True where the module (y = row, x = column) is dark.</summary>
        public bool this[int x, int y]
        {
            get { return _modules[y, x]; }
        }

        private QrCode(int version)
        {
            Version = version;
            Size = version * 4 + 17;
            _modules = new bool[Size, Size];
            _function = new bool[Size, Size];
        }

        public static QrCode Encode(string text)
        {
            var data = Encoding.UTF8.GetBytes(text);
            int version;
            for (version = 1; ; version++)
            {
                if (version > 40) throw new ArgumentException("Too long for a QR code.");
                var capacityBits = DataCodewords(version) * 8;
                if (4 + CountBits(version) + data.Length * 8 <= capacityBits) break;
            }

            var bits = new List<bool>();
            Append(bits, 4, 4); // byte mode
            Append(bits, data.Length, CountBits(version));
            foreach (var b in data) Append(bits, b, 8);
            var capacity = DataCodewords(version) * 8;
            Append(bits, 0, Math.Min(4, capacity - bits.Count));
            Append(bits, 0, (8 - bits.Count % 8) % 8);
            for (var pad = 0xEC; bits.Count < capacity; pad ^= 0xEC ^ 0x11) Append(bits, pad, 8);

            var codewords = new byte[bits.Count / 8];
            for (var i = 0; i < bits.Count; i++)
            {
                if (bits[i]) codewords[i >> 3] |= (byte)(1 << (7 - (i & 7)));
            }

            var qr = new QrCode(version);
            qr.DrawFunctionPatterns();
            qr.DrawCodewords(qr.AddEccAndInterleave(codewords));

            var best = 0;
            var bestPenalty = int.MaxValue;
            for (var mask = 0; mask < 8; mask++)
            {
                qr.ApplyMask(mask);
                qr.DrawFormatBits(mask);
                var penalty = qr.Penalty();
                if (penalty < bestPenalty)
                {
                    best = mask;
                    bestPenalty = penalty;
                }
                qr.ApplyMask(mask); // undo
            }
            qr.ApplyMask(best);
            qr.DrawFormatBits(best);
            return qr;
        }

        private static int CountBits(int version)
        {
            return version <= 9 ? 8 : 16;
        }

        private static void Append(List<bool> bits, int value, int length)
        {
            for (var i = length - 1; i >= 0; i--) bits.Add(((value >> i) & 1) != 0);
        }

        private static int RawDataModules(int version)
        {
            var result = (16 * version + 128) * version + 64;
            if (version >= 2)
            {
                var align = version / 7 + 2;
                result -= (25 * align - 10) * align - 55;
                if (version >= 7) result -= 36;
            }
            return result;
        }

        private static int DataCodewords(int version)
        {
            return RawDataModules(version) / 8 - EccPerBlock[version] * Blocks[version];
        }

        // ------------------------------------------------------------ function patterns

        private void Set(int x, int y, bool dark)
        {
            _modules[y, x] = dark;
            _function[y, x] = true;
        }

        private int[] AlignmentPositions()
        {
            if (Version == 1) return new int[0];
            var count = Version / 7 + 2;
            var step = Version == 32 ? 26 : (Version * 4 + count * 2 + 1) / (count * 2 - 2) * 2;
            var result = new int[count];
            result[0] = 6;
            for (int i = count - 1, pos = Size - 7; i >= 1; i--, pos -= step) result[i] = pos;
            return result;
        }

        private void DrawFunctionPatterns()
        {
            for (var i = 0; i < Size; i++)
            {
                Set(6, i, i % 2 == 0);
                Set(i, 6, i % 2 == 0);
            }
            DrawFinder(3, 3);
            DrawFinder(Size - 4, 3);
            DrawFinder(3, Size - 4);

            var positions = AlignmentPositions();
            var n = positions.Length;
            for (var i = 0; i < n; i++)
            {
                for (var j = 0; j < n; j++)
                {
                    if ((i == 0 && j == 0) || (i == 0 && j == n - 1) || (i == n - 1 && j == 0)) continue;
                    for (var dy = -2; dy <= 2; dy++)
                    {
                        for (var dx = -2; dx <= 2; dx++)
                        {
                            Set(positions[i] + dx, positions[j] + dy, Math.Max(Math.Abs(dx), Math.Abs(dy)) != 1);
                        }
                    }
                }
            }

            DrawFormatBits(0); // reserves the area; drawn for real after masking
            if (Version >= 7)
            {
                var rem = Version;
                for (var i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >> 11) * 0x1F25);
                var bits = (Version << 12) | rem;
                for (var i = 0; i < 18; i++)
                {
                    var bit = ((bits >> i) & 1) != 0;
                    var a = Size - 11 + i % 3;
                    var b = i / 3;
                    Set(a, b, bit);
                    Set(b, a, bit);
                }
            }
        }

        private void DrawFinder(int cx, int cy)
        {
            for (var dy = -4; dy <= 4; dy++)
            {
                for (var dx = -4; dx <= 4; dx++)
                {
                    var x = cx + dx;
                    var y = cy + dy;
                    if (x < 0 || x >= Size || y < 0 || y >= Size) continue;
                    var dist = Math.Max(Math.Abs(dx), Math.Abs(dy));
                    Set(x, y, dist != 2 && dist != 4);
                }
            }
        }

        private void DrawFormatBits(int mask)
        {
            var data = (FormatBitsM << 3) | mask;
            var rem = data;
            for (var i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >> 9) * 0x537);
            var bits = ((data << 10) | rem) ^ 0x5412;

            for (var i = 0; i <= 5; i++) Set(8, i, Bit(bits, i));
            Set(8, 7, Bit(bits, 6));
            Set(8, 8, Bit(bits, 7));
            Set(7, 8, Bit(bits, 8));
            for (var i = 9; i < 15; i++) Set(14 - i, 8, Bit(bits, i));

            for (var i = 0; i < 8; i++) Set(Size - 1 - i, 8, Bit(bits, i));
            for (var i = 8; i < 15; i++) Set(8, Size - 15 + i, Bit(bits, i));
            Set(8, Size - 8, true);
        }

        private static bool Bit(int value, int i)
        {
            return ((value >> i) & 1) != 0;
        }

        // ------------------------------------------------------------ data and error correction

        private byte[] AddEccAndInterleave(byte[] data)
        {
            var numBlocks = Blocks[Version];
            var eccLen = EccPerBlock[Version];
            var rawCodewords = RawDataModules(Version) / 8;
            var numShort = numBlocks - rawCodewords % numBlocks;
            var shortLen = rawCodewords / numBlocks;

            var divisor = ReedSolomonDivisor(eccLen);
            var blocks = new List<byte[]>();
            for (int i = 0, k = 0; i < numBlocks; i++)
            {
                var length = shortLen - eccLen + (i < numShort ? 0 : 1);
                var dat = new byte[length];
                Array.Copy(data, k, dat, 0, length);
                k += length;
                var ecc = ReedSolomonRemainder(dat, divisor);
                var block = new byte[shortLen + 1];
                Array.Copy(dat, block, length);
                // Short blocks get a placeholder byte so every block lines up.
                Array.Copy(ecc, 0, block, shortLen + 1 - eccLen, eccLen);
                blocks.Add(block);
            }

            var result = new List<byte>();
            for (var i = 0; i < shortLen + 1; i++)
            {
                for (var j = 0; j < blocks.Count; j++)
                {
                    if (i != shortLen - eccLen || j >= numShort) result.Add(blocks[j][i]);
                }
            }
            return result.ToArray();
        }

        private static byte[] ReedSolomonDivisor(int degree)
        {
            var result = new byte[degree];
            result[degree - 1] = 1;
            var root = 1;
            for (var i = 0; i < degree; i++)
            {
                for (var j = 0; j < result.Length; j++)
                {
                    result[j] = (byte)Multiply(result[j], root);
                    if (j + 1 < result.Length) result[j] ^= result[j + 1];
                }
                root = Multiply(root, 0x02);
            }
            return result;
        }

        private static byte[] ReedSolomonRemainder(byte[] data, byte[] divisor)
        {
            var result = new byte[divisor.Length];
            foreach (var b in data)
            {
                var factor = b ^ result[0];
                Array.Copy(result, 1, result, 0, result.Length - 1);
                result[result.Length - 1] = 0;
                for (var i = 0; i < result.Length; i++) result[i] ^= (byte)Multiply(divisor[i], factor);
            }
            return result;
        }

        private static int Multiply(int x, int y)
        {
            var z = 0;
            for (var i = 7; i >= 0; i--)
            {
                z = (z << 1) ^ ((z >> 7) * 0x11D);
                z ^= ((y >> i) & 1) * x;
            }
            return z & 0xFF;
        }

        private void DrawCodewords(byte[] data)
        {
            var i = 0;
            for (var right = Size - 1; right >= 1; right -= 2)
            {
                if (right == 6) right = 5;
                for (var vert = 0; vert < Size; vert++)
                {
                    for (var j = 0; j < 2; j++)
                    {
                        var x = right - j;
                        var upward = ((right + 1) & 2) == 0;
                        var y = upward ? Size - 1 - vert : vert;
                        if (!_function[y, x] && i < data.Length * 8)
                        {
                            _modules[y, x] = ((data[i >> 3] >> (7 - (i & 7))) & 1) != 0;
                            i++;
                        }
                    }
                }
            }
        }

        private void ApplyMask(int mask)
        {
            for (var y = 0; y < Size; y++)
            {
                for (var x = 0; x < Size; x++)
                {
                    bool invert;
                    switch (mask)
                    {
                        case 0: invert = (x + y) % 2 == 0; break;
                        case 1: invert = y % 2 == 0; break;
                        case 2: invert = x % 3 == 0; break;
                        case 3: invert = (x + y) % 3 == 0; break;
                        case 4: invert = (x / 3 + y / 2) % 2 == 0; break;
                        case 5: invert = x * y % 2 + x * y % 3 == 0; break;
                        case 6: invert = (x * y % 2 + x * y % 3) % 2 == 0; break;
                        default: invert = ((x + y) % 2 + x * y % 3) % 2 == 0; break;
                    }
                    if (invert && !_function[y, x]) _modules[y, x] = !_modules[y, x];
                }
            }
        }

        /// <summary>The standard's mask penalty: long runs, 2x2 blocks, finder look-alikes, and dark/light balance.</summary>
        private int Penalty()
        {
            var penalty = 0;
            for (var pass = 0; pass < 2; pass++)
            {
                for (var a = 0; a < Size; a++)
                {
                    var run = 1;
                    for (var b = 1; b < Size; b++)
                    {
                        var here = pass == 0 ? _modules[a, b] : _modules[b, a];
                        var before = pass == 0 ? _modules[a, b - 1] : _modules[b - 1, a];
                        if (here == before)
                        {
                            run++;
                            if (run == 5) penalty += 3;
                            else if (run > 5) penalty++;
                        }
                        else
                        {
                            run = 1;
                        }
                    }
                    for (var b = 0; b + 10 < Size; b++)
                    {
                        if (FinderLike(pass, a, b)) penalty += 40;
                    }
                }
            }
            for (var y = 0; y < Size - 1; y++)
            {
                for (var x = 0; x < Size - 1; x++)
                {
                    var c = _modules[y, x];
                    if (c == _modules[y, x + 1] && c == _modules[y + 1, x] && c == _modules[y + 1, x + 1]) penalty += 3;
                }
            }
            var dark = 0;
            foreach (var module in _modules)
            {
                if (module) dark++;
            }
            var total = Size * Size;
            var k = (Math.Abs(dark * 20 - total * 10) + total - 1) / total - 1;
            penalty += Math.Max(0, k) * 10;
            return penalty;
        }

        private static readonly bool[] FinderA = { true, false, true, true, true, false, true, false, false, false, false };
        private static readonly bool[] FinderB = { false, false, false, false, true, false, true, true, true, false, true };

        private bool FinderLike(int pass, int a, int b)
        {
            bool matchA = true, matchB = true;
            for (var i = 0; i < 11; i++)
            {
                var m = pass == 0 ? _modules[a, b + i] : _modules[b + i, a];
                if (m != FinderA[i]) matchA = false;
                if (m != FinderB[i]) matchB = false;
            }
            return matchA || matchB;
        }

        /// <summary>Draws the code, dark on white, with the quiet zone round it, as big as fits in the box.</summary>
        public void Draw(Graphics g, Rectangle box)
        {
            const int quiet = 4;
            var total = Size + quiet * 2;
            var scale = Math.Max(1, Math.Min(box.Width, box.Height) / total);
            var side = scale * total;
            var left = box.X + (box.Width - side) / 2;
            var top = box.Y + (box.Height - side) / 2;
            g.FillRectangle(Brushes.White, left, top, side, side);
            for (var y = 0; y < Size; y++)
            {
                for (var x = 0; x < Size; x++)
                {
                    if (_modules[y, x]) g.FillRectangle(Brushes.Black, left + (x + quiet) * scale, top + (y + quiet) * scale, scale, scale);
                }
            }
        }
    }

    /// <summary>Shows a QR code for some text (the remote access address).</summary>
    internal sealed class QrView : Control
    {
        private QrCode _code;
        private string _text;

        public QrView()
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
            Size = new Size(176, 176);
        }

        public string Value
        {
            get { return _text; }
            set
            {
                _text = value;
                _code = string.IsNullOrEmpty(value) ? null : QrCode.Encode(value);
                Invalidate();
            }
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            e.Graphics.Clear(Theme.BackOf(this));
            if (_code == null) return;
            using (var path = Theme.Rounded(new RectangleF(0, 0, Width - 1, Height - 1), 8))
            {
                e.Graphics.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
                e.Graphics.FillPath(Brushes.White, path);
            }
            e.Graphics.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.None;
            _code.Draw(e.Graphics, new Rectangle(4, 4, Width - 8, Height - 8));
        }
    }
}
