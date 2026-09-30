using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

namespace Tohyee.Tray
{
    internal enum PhoneState
    {
        Checking,
        NotInstalled,
        /// <summary>Installed, but its Windows service isn't answering.</summary>
        NotRunning,
        /// <summary>Tailscale needs someone to sign in to their Tailscale account.</summary>
        SignedOut,
        /// <summary>Signed in, Funnel off.</summary>
        Off,
        /// <summary>Funnel is on, but for something other than Tohyee's port.</summary>
        OtherFunnel,
        On,
        Problem,
    }

    /// <summary>What Tailscale says about this computer.</summary>
    internal sealed class TailscaleStatus
    {
        public PhoneState State;
        public string Version;
        /// <summary>This computer's name on the tailnet, e.g. tohyee-pc.tail1a2b3c.ts.net (no trailing dot).</summary>
        public string DnsName;
        public string Problem;

        public string Address
        {
            get { return string.IsNullOrEmpty(DnsName) ? null : "https://" + DnsName; }
        }
    }

    /// <summary>The steps of turning phone access on; the demo mode fakes them.</summary>
    internal interface ITailscale
    {
        Task<TailscaleStatus> GetStatus(int port);
        Task Install(Action<string> progress);
        /// <summary>Signs this computer in to Tailscale; opens Tailscale's sign-in page in the browser.</summary>
        Task LogIn(Action<string> openUrl);
        /// <summary>Turns Funnel on for 127.0.0.1:port, in the background so it survives restarts. May open Tailscale's approval page.</summary>
        Task FunnelOn(int port, Action<string> openUrl);
        Task FunnelOff();
    }

    /// <summary>A problem with Tailscale, in words for the person at the computer.</summary>
    internal sealed class TailscaleException : Exception
    {
        public TailscaleException(string message) : base(message)
        {
        }
    }

    /// <summary>
    /// Phone access through Tailscale Funnel: Tailscale gives this computer a
    /// https://&lt;name&gt;.&lt;tailnet&gt;.ts.net address that works from any phone, and
    /// forwards it to Tohyee on 127.0.0.1. This drives Tailscale's own
    /// command-line tool (tailscale.exe); Tohyee never sees or stores the
    /// Tailscale login. Every call has a time limit and runs off the UI thread.
    ///
    /// Checked against Tailscale's docs and source (Sept 2026):
    ///   - MSI list: https://pkgs.tailscale.com/stable/?mode=json ("MSIs": {"amd64": …}),
    ///     each with a .sha256 beside it.
    ///   - MSI properties TS_UNATTENDEDMODE=always and TS_NOLAUNCH (tailscale.com/docs/install/windows/msi).
    ///   - tailscale up --unattended (Windows only), tailscale set --unattended.
    ///   - tailscale funnel --bg --yes &lt;port&gt; (port alone means http://127.0.0.1:&lt;port&gt;);
    ///     tailscale funnel --https=443 off; tailscale funnel reset; tailscale funnel status --json.
    ///   - tailscale status --json: BackendState, Self.DNSName (ends with a dot).
    /// </summary>
    internal sealed class TailscaleCli : ITailscale
    {
        public const string PackagesUrl = "https://pkgs.tailscale.com/stable/";
        private static readonly TimeSpan Quick = TimeSpan.FromSeconds(20);
        private static readonly TimeSpan Waiting = TimeSpan.FromMinutes(10);

        /// <summary>Where tailscale.exe is, or null if Tailscale isn't installed.</summary>
        public static string FindExe()
        {
            var candidates = new List<string>();
            foreach (var variable in new[] { "ProgramW6432", "ProgramFiles", "ProgramFiles(x86)" })
            {
                var folder = Environment.GetEnvironmentVariable(variable);
                if (!string.IsNullOrEmpty(folder)) candidates.Add(Path.Combine(folder, "Tailscale", "tailscale.exe"));
            }
            var path = Environment.GetEnvironmentVariable("PATH") ?? "";
            foreach (var folder in path.Split(Path.PathSeparator))
            {
                if (folder.Trim().Length > 0) candidates.Add(Path.Combine(folder.Trim(), "tailscale.exe"));
            }
            foreach (var candidate in candidates)
            {
                try
                {
                    if (File.Exists(candidate)) return candidate;
                }
                catch (Exception)
                {
                    // A strange PATH entry.
                }
            }
            return null;
        }

        private sealed class CliResult
        {
            public int ExitCode;
            public string Output;
            public bool TimedOut;
        }

        /// <summary>Runs tailscale.exe with a time limit, passing each output line to onLine as it comes.</summary>
        private static Task<CliResult> Run(string arguments, TimeSpan timeout, Action<string> onLine)
        {
            return Task.Run(() =>
            {
                var exe = FindExe();
                if (exe == null) throw new TailscaleException("Tailscale isn't installed on this computer.");
                var output = new StringBuilder();
                using (var process = new Process())
                {
                    process.StartInfo = new ProcessStartInfo
                    {
                        FileName = exe,
                        Arguments = arguments,
                        UseShellExecute = false,
                        CreateNoWindow = true,
                        RedirectStandardOutput = true,
                        RedirectStandardError = true,
                        StandardOutputEncoding = Encoding.UTF8,
                        StandardErrorEncoding = Encoding.UTF8,
                    };
                    DataReceivedEventHandler take = (s, e) =>
                    {
                        if (e.Data == null) return;
                        lock (output) output.AppendLine(e.Data);
                        if (onLine != null) onLine(e.Data);
                    };
                    process.OutputDataReceived += take;
                    process.ErrorDataReceived += take;
                    try
                    {
                        process.Start();
                    }
                    catch (Exception error)
                    {
                        throw new TailscaleException("Couldn't run Tailscale (" + error.Message + ").");
                    }
                    process.BeginOutputReadLine();
                    process.BeginErrorReadLine();
                    var finished = process.WaitForExit((int)timeout.TotalMilliseconds);
                    if (!finished)
                    {
                        try
                        {
                            process.Kill();
                        }
                        catch (Exception)
                        {
                            // It finished just now.
                        }
                    }
                    else
                    {
                        process.WaitForExit(); // lets the output readers finish
                    }
                    lock (output)
                    {
                        return new CliResult { ExitCode = finished ? process.ExitCode : -1, Output = output.ToString(), TimedOut = !finished };
                    }
                }
            });
        }

        /// <summary>Tailscale's pages (sign in, approve Funnel) are on tailscale.com; nothing else gets opened.</summary>
        internal static string TailscaleUrlIn(string line)
        {
            if (line == null) return null;
            var match = Regex.Match(line, @"https://[A-Za-z0-9.-]+(/[^\s""'<>]*)?");
            if (!match.Success) return null;
            Uri uri;
            if (!Uri.TryCreate(match.Value, UriKind.Absolute, out uri)) return null;
            var host = uri.Host.ToLowerInvariant();
            return host == "tailscale.com" || host.EndsWith(".tailscale.com") ? uri.AbsoluteUri : null;
        }

        private static Action<string> OpenOnce(Action<string> openUrl)
        {
            var opened = new HashSet<string>();
            return line =>
            {
                var url = TailscaleUrlIn(line);
                if (url == null) return;
                lock (opened)
                {
                    if (!opened.Add(url)) return;
                }
                openUrl(url);
            };
        }

        private static Dictionary<string, object> ParseJson(string text)
        {
            // The CLI can print a warning line before the JSON.
            var start = text.IndexOf('{');
            if (start < 0) return null;
            try
            {
                return new JavaScriptSerializer { MaxJsonLength = 8 * 1024 * 1024 }.DeserializeObject(text.Substring(start)) as Dictionary<string, object>;
            }
            catch (Exception)
            {
                return null;
            }
        }

        private static string FirstLine(string text)
        {
            foreach (var line in (text ?? "").Split('\n'))
            {
                if (line.Trim().Length > 0) return line.Trim();
            }
            return "";
        }

        public async Task<TailscaleStatus> GetStatus(int port)
        {
            var result = new TailscaleStatus { State = PhoneState.Checking };
            if (FindExe() == null)
            {
                result.State = PhoneState.NotInstalled;
                return result;
            }
            var version = await Run("version", Quick, null);
            if (version.ExitCode == 0) result.Version = FirstLine(version.Output);

            var status = await Run("status --json", Quick, null);
            var json = ParseJson(status.Output);
            var backend = J.Str(json, "BackendState");
            if (json == null || backend == null)
            {
                var text = status.Output.ToLowerInvariant();
                if (status.TimedOut || text.Contains("failed to connect") || text.Contains("is tailscale running") || text.Contains("not running"))
                {
                    result.State = PhoneState.NotRunning;
                }
                else
                {
                    result.State = PhoneState.Problem;
                    result.Problem = FirstLine(status.Output);
                }
                return result;
            }
            var self = J.Obj(json, "Self");
            var dnsName = J.Str(self, "DNSName");
            result.DnsName = string.IsNullOrEmpty(dnsName) ? null : dnsName.TrimEnd('.');
            if (backend != "Running")
            {
                // NeedsLogin, NeedsMachineAuth, Stopped, NoState, Starting.
                result.State = PhoneState.SignedOut;
                if (backend == "NeedsMachineAuth") result.Problem = "Your Tailscale admin needs to approve this computer in the Tailscale admin console.";
                return result;
            }

            var funnel = await Run("funnel status --json", Quick, null);
            result.State = FunnelState(ParseJson(funnel.Output), port);
            return result;
        }

        /// <summary>
        /// Reads `tailscale funnel status --json` (the serve config): Funnel is on
        /// for Tohyee when some host:443 is allowed through Funnel and its web
        /// handler proxies to Tohyee's port.
        /// </summary>
        internal static PhoneState FunnelState(Dictionary<string, object> config, int port)
        {
            var allow = J.Obj(config, "AllowFunnel");
            if (allow == null) return PhoneState.Off;
            var anyOn = false;
            foreach (var entry in allow)
            {
                if (!(entry.Value is bool) || !(bool)entry.Value) continue;
                anyOn = true;
                var web = J.Obj(J.Obj(config, "Web"), entry.Key);
                var handlers = J.Obj(web, "Handlers");
                if (handlers == null) continue;
                foreach (var handler in handlers)
                {
                    var proxy = J.Str(handler.Value as Dictionary<string, object>, "Proxy") ?? "";
                    if (proxy.TrimEnd('/').EndsWith(":" + port)) return PhoneState.On;
                }
            }
            return anyOn ? PhoneState.OtherFunnel : PhoneState.Off;
        }

        /// <summary>
        /// Downloads the current Tailscale MSI for this computer from Tailscale's
        /// package server, checks its SHA-256, and installs it quietly. Windows
        /// asks for permission (UAC). Unattended mode keeps Tailscale connected
        /// when nobody is signed in to Windows, like Tohyee's own service.
        /// </summary>
        public async Task Install(Action<string> progress)
        {
            progress("Finding the latest Tailscale for Windows…");
            string msiName;
            byte[] msi;
            string expected;
            using (var http = new HttpClient { Timeout = TimeSpan.FromMinutes(5) })
            {
                http.DefaultRequestHeaders.UserAgent.ParseAdd("TohyeeServerApp/1.0");
                try
                {
                    var list = new JavaScriptSerializer().DeserializeObject(await http.GetStringAsync(PackagesUrl + "?mode=json")) as Dictionary<string, object>;
                    msiName = J.Str(J.Obj(list, "MSIs"), Architecture());
                    if (msiName == null || !Regex.IsMatch(msiName, @"^tailscale-setup-[0-9.]+-(amd64|arm64|x86)\.msi$"))
                    {
                        throw new TailscaleException("Tailscale's download list didn't have an installer for this computer. Install Tailscale from tailscale.com/download, then try again.");
                    }
                    progress("Downloading " + msiName + "…");
                    msi = await http.GetByteArrayAsync(PackagesUrl + msiName);
                    expected = (await http.GetStringAsync(PackagesUrl + msiName + ".sha256")).Trim().Split(' ')[0].ToLowerInvariant();
                }
                catch (HttpRequestException error)
                {
                    throw new TailscaleException("Couldn't download Tailscale (" + error.Message + "). Check this computer is online, or install it from tailscale.com/download.");
                }
                catch (TaskCanceledException)
                {
                    throw new TailscaleException("Downloading Tailscale took too long. Check this computer is online, or install it from tailscale.com/download.");
                }
            }
            string actual;
            using (var sha = SHA256.Create())
            {
                actual = BitConverter.ToString(sha.ComputeHash(msi)).Replace("-", "").ToLowerInvariant();
            }
            if (actual != expected) throw new TailscaleException("The Tailscale download didn't match its checksum, so it wasn't installed. Try again later.");

            var folder = Path.Combine(Path.GetTempPath(), "Tohyee-Tailscale");
            Directory.CreateDirectory(folder);
            var file = Path.Combine(folder, msiName);
            File.WriteAllBytes(file, msi);

            progress("Installing Tailscale. Windows will ask for permission…");
            var exitCode = await Task.Run(() =>
            {
                try
                {
                    using (var process = Process.Start(new ProcessStartInfo
                    {
                        FileName = Path.Combine(Environment.SystemDirectory, "msiexec.exe"),
                        Arguments = "/i \"" + file + "\" /qn /norestart TS_UNATTENDEDMODE=always TS_NOLAUNCH=yes",
                        Verb = "runas",
                        UseShellExecute = true,
                    }))
                    {
                        if (process == null) return -1;
                        if (!process.WaitForExit((int)Waiting.TotalMilliseconds)) return -2;
                        return process.ExitCode;
                    }
                }
                catch (System.ComponentModel.Win32Exception)
                {
                    return 1223; // permission declined
                }
            });
            try
            {
                File.Delete(file);
            }
            catch (Exception)
            {
                // Windows tidies the temp folder.
            }
            if (exitCode == 1223 || exitCode == 1602) throw new TailscaleException("Tailscale wasn't installed: Windows didn't get permission.");
            if (exitCode == -2) throw new TailscaleException("Installing Tailscale is taking a long time. Check for a Windows prompt, then press Set up phone access again.");
            if (exitCode != 0 && exitCode != 3010) throw new TailscaleException("Installing Tailscale failed (Windows Installer code " + exitCode + ").");

            progress("Starting Tailscale…");
            for (var i = 0; i < 30; i++)
            {
                if (FindExe() != null)
                {
                    var status = await Run("status --json", Quick, null);
                    if (J.Str(ParseJson(status.Output), "BackendState") != null) return;
                }
                await Task.Delay(2000);
            }
            throw new TailscaleException("Tailscale was installed but hasn't started yet. Restart the computer if it doesn't start in a minute, then try again.");
        }

        private static string Architecture()
        {
            var arch = (Environment.GetEnvironmentVariable("PROCESSOR_ARCHITEW6432") ?? Environment.GetEnvironmentVariable("PROCESSOR_ARCHITECTURE") ?? "").ToUpperInvariant();
            if (arch == "ARM64") return "arm64";
            return Environment.Is64BitOperatingSystem ? "amd64" : "x86";
        }

        public async Task LogIn(Action<string> openUrl)
        {
            var open = OpenOnce(openUrl);
            var result = await Run("up --unattended", Waiting, open);
            if (result.ExitCode != 0 && result.Output.Contains("mention"))
            {
                // Tailscale was already set up with other options; `up` wants them
                // all repeated. `login` signs in without changing them.
                result = await Run("login --unattended", Waiting, open);
            }
            if (result.TimedOut) throw new TailscaleException("Signing in to Tailscale took too long. Press Set up phone access to try again.");
            if (result.ExitCode != 0) throw new TailscaleException("Tailscale didn't sign in: " + FirstLine(result.Output));
        }

        public async Task FunnelOn(int port, Action<string> openUrl)
        {
            // Keep Tailscale connected when nobody is signed in to Windows (best effort).
            await Run("set --unattended", Quick, null);
            var result = await Run("funnel --bg --yes " + port, Waiting, OpenOnce(openUrl));
            if (result.TimedOut) throw new TailscaleException("Waiting for Funnel to be approved took too long. Approve it in the browser, then press Turn on phone access again.");
            if (result.ExitCode != 0) throw new TailscaleException("Tailscale didn't turn Funnel on: " + FirstLine(result.Output));
        }

        public async Task FunnelOff()
        {
            var result = await Run("funnel --https=443 off", Quick, null);
            if (result.ExitCode != 0)
            {
                result = await Run("funnel reset", Quick, null);
                if (result.ExitCode != 0) throw new TailscaleException("Tailscale didn't turn Funnel off: " + FirstLine(result.Output));
            }
        }
    }
}
