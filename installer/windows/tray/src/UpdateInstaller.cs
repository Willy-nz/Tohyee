using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Net.Http;
using System.Security.Cryptography;
using System.Threading.Tasks;

namespace Tohyee.Tray
{
    /// <summary>
    /// The second half of "Install" (decision 331): after the server has backed
    /// everything up and handed over the installer's address and SHA-256, this
    /// downloads TohyeeSetup, checks it against the SHA-256, and runs it
    /// silently. The installer stops Tohyee, replaces the program, starts it
    /// again (the database upgrades run as it starts) and starts this app again
    /// with --after-update. A note in this person's local app data says what
    /// was being installed, so the restarted app can say how it went.
    /// </summary>
    internal static class UpdateInstaller
    {
        /// <summary>Only Tohyee's own GitHub releases are downloaded.</summary>
        private const string ReleasesPrefix = "https://github.com/Willy-nz/Tohyee/releases/download/";

        /// <summary>How long to wait for the new version before saying the update didn't finish.</summary>
        public static readonly TimeSpan GiveUpAfter = TimeSpan.FromMinutes(20);

        private static string Folder
        {
            get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Tohyee"); }
        }

        private static string PendingFile
        {
            get { return Path.Combine(Folder, "pending-update.txt"); }
        }

        /// <summary>Downloads the installer to this person's temp folder and checks its SHA-256. Throws if it doesn't match.</summary>
        public static async Task<string> Download(string url, string fileName, string sha256, long size, Action<int> progress)
        {
            if (url == null || !url.StartsWith(ReleasesPrefix, StringComparison.Ordinal))
            {
                throw new ApiException(0, "The installer isn't on Tohyee's GitHub releases page, so it wasn't downloaded.");
            }
            if (string.IsNullOrEmpty(fileName) || fileName.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0 || !fileName.EndsWith(".exe", StringComparison.OrdinalIgnoreCase))
            {
                throw new ApiException(0, "The installer's name isn't right, so it wasn't downloaded.");
            }
            var folder = Path.Combine(Path.GetTempPath(), "Tohyee");
            Directory.CreateDirectory(folder);
            var target = Path.Combine(folder, fileName);
            var partial = target + ".partial";
            try
            {
                using (var client = new HttpClient { Timeout = TimeSpan.FromMinutes(30) })
                {
                    client.DefaultRequestHeaders.UserAgent.ParseAdd("TohyeeTray/1.0");
                    using (var response = await client.GetAsync(url, HttpCompletionOption.ResponseHeadersRead))
                    {
                        if (!response.IsSuccessStatusCode)
                        {
                            throw new ApiException((int)response.StatusCode, "GitHub didn't send the installer (" + (int)response.StatusCode + "). Try again later.");
                        }
                        var total = response.Content.Headers.ContentLength ?? size;
                        using (var input = await response.Content.ReadAsStreamAsync())
                        using (var output = File.Create(partial))
                        {
                            var buffer = new byte[81920];
                            long done = 0;
                            var lastPercent = -1;
                            int read;
                            while ((read = await input.ReadAsync(buffer, 0, buffer.Length)) > 0)
                            {
                                await output.WriteAsync(buffer, 0, read);
                                done += read;
                                if (total > 0 && progress != null)
                                {
                                    var percent = (int)Math.Min(100, done * 100 / total);
                                    if (percent != lastPercent)
                                    {
                                        lastPercent = percent;
                                        progress(percent);
                                    }
                                }
                            }
                        }
                    }
                }
            }
            catch (HttpRequestException error)
            {
                TryDelete(partial);
                throw new ApiException(0, "Couldn't download the installer: " + error.Message);
            }
            catch (TaskCanceledException)
            {
                TryDelete(partial);
                throw new ApiException(0, "Downloading the installer took too long. Try again later.");
            }
            catch (IOException error)
            {
                TryDelete(partial);
                throw new ApiException(0, "Couldn't save the installer: " + error.Message);
            }

            try
            {
                var actual = Sha256Of(partial);
                if (!string.Equals(actual, sha256, StringComparison.OrdinalIgnoreCase))
                {
                    TryDelete(partial);
                    throw new ApiException(0, "The downloaded installer doesn't match the fingerprint GitHub gave for it (expected " + sha256 + ", got " + actual + "), so it was deleted and not run. Nothing was changed.");
                }
                TryDelete(target);
                File.Move(partial, target);
                return target;
            }
            catch (IOException error)
            {
                TryDelete(partial);
                throw new ApiException(0, "Couldn't check the downloaded installer: " + error.Message);
            }
        }

        public static string Sha256Of(string file)
        {
            using (var sha = SHA256.Create())
            using (var stream = File.OpenRead(file))
            {
                var hash = sha.ComputeHash(stream);
                return BitConverter.ToString(hash).Replace("-", "").ToLowerInvariant();
            }
        }

        /// <summary>
        /// Runs the installer silently (Windows asks for permission). Returns false
        /// if permission was declined. /RESTARTTRAY=yes makes it start this app
        /// again when it's done; /LOG keeps its log beside Tohyee's other logs.
        /// </summary>
        public static bool Run(string setup, string fromVersion, string toVersion, string logsDir)
        {
            var log = Path.Combine(logsDir, "update-" + toVersion + "-" + DateTime.Now.ToString("yyyyMMdd-HHmmss", CultureInfo.InvariantCulture) + ".log");
            SavePending(new PendingUpdate { From = fromVersion, To = toVersion, StartedAt = DateTime.UtcNow, Log = log });
            try
            {
                Process.Start(new ProcessStartInfo
                {
                    FileName = setup,
                    Arguments = "/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /RESTARTTRAY=yes /LOG=\"" + log + "\"",
                    UseShellExecute = true,
                });
                return true;
            }
            catch (System.ComponentModel.Win32Exception)
            {
                // Permission was declined: nothing is happening.
                ClearPending();
                return false;
            }
        }

        // ------------------------------------------------------------ the note for after the restart

        internal sealed class PendingUpdate
        {
            public string From;
            public string To;
            public DateTime StartedAt;
            public string Log;
        }

        private static void SavePending(PendingUpdate pending)
        {
            Directory.CreateDirectory(Folder);
            File.WriteAllLines(PendingFile, new[]
            {
                "from=" + pending.From,
                "to=" + pending.To,
                "startedAt=" + pending.StartedAt.ToString("o", CultureInfo.InvariantCulture),
                "log=" + pending.Log,
            });
        }

        public static PendingUpdate LoadPending()
        {
            try
            {
                if (!File.Exists(PendingFile)) return null;
                var values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                foreach (var line in File.ReadAllLines(PendingFile))
                {
                    var eq = line.IndexOf('=');
                    if (eq > 0) values[line.Substring(0, eq)] = line.Substring(eq + 1);
                }
                DateTime started;
                string to;
                if (!values.TryGetValue("to", out to) || !values.ContainsKey("startedAt")
                    || !DateTime.TryParse(values["startedAt"], CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out started))
                {
                    ClearPending();
                    return null;
                }
                string from, log;
                values.TryGetValue("from", out from);
                values.TryGetValue("log", out log);
                return new PendingUpdate { From = from, To = to, StartedAt = started.ToUniversalTime(), Log = log };
            }
            catch (IOException)
            {
                return null;
            }
            catch (UnauthorizedAccessException)
            {
                return null;
            }
        }

        public static void ClearPending()
        {
            TryDelete(PendingFile);
        }

        private static void TryDelete(string file)
        {
            try
            {
                if (File.Exists(file)) File.Delete(file);
            }
            catch (IOException)
            {
            }
            catch (UnauthorizedAccessException)
            {
            }
        }
    }
}
