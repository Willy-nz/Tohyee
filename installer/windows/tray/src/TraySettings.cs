using System;
using System.Collections.Generic;
using System.IO;

namespace Tohyee.Tray
{
    /// <summary>
    /// Where Tohyee is on this computer. The installer writes
    /// %ProgramData%\Tohyee\tray.ini (ports only, nothing secret); without it the
    /// defaults are used: the books on port 3000, server settings on 3001.
    /// </summary>
    internal sealed class TraySettings
    {
        public int Port { get; private set; }
        public int AdminPort { get; private set; }
        public string DataRoot { get; private set; }
        public string InstallDir { get; private set; }

        /// <summary>The books, for people (opened in the browser).</summary>
        public string BooksUrl { get { return "http://localhost:" + Port; } }

        /// <summary>Server settings: 127.0.0.1 only (see src/lib/server-admin/local.ts).</summary>
        public string AdminUrl { get { return "http://127.0.0.1:" + AdminPort; } }

        public string LogsDir { get { return Path.Combine(DataRoot, "logs"); } }

        public static TraySettings Load()
        {
            var dataRoot = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "Tohyee");
            var values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            var file = Path.Combine(dataRoot, "tray.ini");
            try
            {
                if (File.Exists(file))
                {
                    foreach (var raw in File.ReadAllLines(file))
                    {
                        var line = raw.Trim();
                        if (line.Length == 0 || line.StartsWith("#")) continue;
                        var eq = line.IndexOf('=');
                        if (eq > 0) values[line.Substring(0, eq).Trim()] = line.Substring(eq + 1).Trim();
                    }
                }
            }
            catch (IOException)
            {
                // Unreadable: fall back to the defaults.
            }
            catch (UnauthorizedAccessException)
            {
            }

            var port = ReadPort(values, "PORT", 3000);
            var settings = new TraySettings
            {
                Port = port,
                AdminPort = ReadPort(values, "ADMIN_PORT", port + 1),
                DataRoot = dataRoot,
                InstallDir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\', '/'),
            };
            // The app lives in <install dir>\tray.
            var parent = Directory.GetParent(settings.InstallDir);
            if (parent != null && string.Equals(Path.GetFileName(settings.InstallDir), "tray", StringComparison.OrdinalIgnoreCase))
            {
                settings.InstallDir = parent.FullName;
            }
            return settings;
        }

        private static int ReadPort(Dictionary<string, string> values, string key, int fallback)
        {
            string text;
            int port;
            if (values.TryGetValue(key, out text) && int.TryParse(text, out port) && port > 0 && port < 65536)
            {
                return port;
            }
            return fallback;
        }
    }
}
