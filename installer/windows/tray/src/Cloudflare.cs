using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

namespace Tohyee.Tray
{
    /// <summary>A problem with Cloudflare, in words for the person at the computer.</summary>
    internal sealed class CloudflareException : Exception
    {
        public CloudflareException(string message) : base(message)
        {
        }
    }

    /// <summary>What Connect to Cloudflare made: the tunnel's run token, for the server.</summary>
    internal sealed class CloudflareTunnel
    {
        public string TunnelId;
        public string Token;
        public string Hostname;
    }

    /// <summary>The steps of Connect to Cloudflare; the demo mode fakes them.</summary>
    internal interface ICloudflare
    {
        /// <summary>
        /// Signs in to Cloudflare in the browser (the person picks their domain
        /// and presses Authorise). onUrl gets the sign-in page and whether
        /// cloudflared already opened it. Finishes when Cloudflare's
        /// certificate has been saved; cancelling stops waiting.
        /// </summary>
        Task LogIn(Action<string, bool> onUrl, CancellationToken cancel);

        /// <summary>The domain picked when signing in (e.g. example.nz), if Cloudflare says; null if it can't tell.</summary>
        Task<string> SignedInDomain();

        /// <summary>Makes (or reuses) the tunnel, points hostname at it in DNS, and gets its run token.</summary>
        Task<CloudflareTunnel> Connect(string tunnelName, string hostname, Action<string> progress, CancellationToken cancel);

        /// <summary>Deletes the sign-in certificate and tunnel credentials files (Tohyee only needs the token).</summary>
        void Forget();
    }

    /// <summary>
    /// Connect to Cloudflare: drives Cloudflare's own command-line connector,
    /// cloudflared.exe (the installer puts it in &lt;install dir&gt;\cloudflared), so
    /// the owner's own domain can be used without the Zero Trust dashboard.
    /// Every call runs off the UI thread with a time limit.
    ///
    ///   cloudflared tunnel login
    ///       prints (and opens) https://dash.cloudflare.com/argotunnel?...; the person
    ///       signs in, clicks the domain and presses Authorise; cloudflared then saves
    ///       cert.pem in &lt;HOME&gt;\.cloudflared (it polls up to about 10 minutes).
    ///   cloudflared tunnel create --output json tohyee-&lt;name&gt;
    ///       makes the tunnel ("tunnel with name already exists" if it's there: reused).
    ///   cloudflared tunnel route dns &lt;tunnel&gt; &lt;hostname&gt;
    ///       adds the CNAME ("Added CNAME x which will route to this tunnel" or
    ///       "x is already configured to route to your tunnel"); never overwrites a record.
    ///   cloudflared tunnel token &lt;tunnel&gt;
    ///       prints the run token (eyJ…), which the server stores encrypted.
    ///
    /// Checked against cloudflared's source (github.com/cloudflare/cloudflared,
    /// cmd/cloudflared/tunnel/login.go, subcommands.go, cfapi/hostname.go; Sept 2026).
    /// HOME is set to a folder of Tohyee's own (%LocalAppData%\Tohyee\cloudflare),
    /// so cloudflared's cert.pem lands there (go-homedir prefers HOME) and an
    /// existing cloudflared set-up on this computer is left alone.
    /// </summary>
    internal sealed class CloudflaredCli : ICloudflare
    {
        private static readonly TimeSpan Quick = TimeSpan.FromSeconds(60);
        private static readonly TimeSpan SignIn = TimeSpan.FromMinutes(11);
        private readonly TraySettings _settings;

        public CloudflaredCli(TraySettings settings)
        {
            _settings = settings;
        }

        public static string Home
        {
            get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Tohyee", "cloudflare"); }
        }

        public static string CertPath
        {
            get { return Path.Combine(Home, ".cloudflared", "cert.pem"); }
        }

        /// <summary>Where cloudflared.exe is: beside Tohyee (the installer's copy), else on the PATH.</summary>
        public string FindExe()
        {
            var candidates = new List<string> { Path.Combine(_settings.InstallDir, "cloudflared", "cloudflared.exe") };
            foreach (var folder in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator))
            {
                if (folder.Trim().Length > 0) candidates.Add(Path.Combine(folder.Trim(), "cloudflared.exe"));
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
            public string StdOut;
            public bool TimedOut;
        }

        private static string Quote(string argument)
        {
            return "\"" + argument.Replace("\"", "") + "\"";
        }

        private Task<CliResult> Run(string arguments, TimeSpan timeout, Action<string> onLine, CancellationToken cancel)
        {
            return Task.Run(() =>
            {
                var exe = FindExe();
                if (exe == null) throw new CloudflareException("cloudflared.exe isn't where Tohyee put it (" + Path.Combine(_settings.InstallDir, "cloudflared") + "). Run the Tohyee setup again (Repair).");
                Directory.CreateDirectory(Path.Combine(Home, ".cloudflared"));
                var output = new StringBuilder();
                var stdout = new StringBuilder();
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
                    process.StartInfo.EnvironmentVariables["HOME"] = Home;
                    process.StartInfo.EnvironmentVariables["TUNNEL_ORIGIN_CERT"] = CertPath;
                    process.StartInfo.EnvironmentVariables["NO_AUTOUPDATE"] = "true";
                    process.OutputDataReceived += (s, e) =>
                    {
                        if (e.Data == null) return;
                        lock (output)
                        {
                            output.AppendLine(e.Data);
                            stdout.AppendLine(e.Data);
                        }
                        if (onLine != null) onLine(e.Data);
                    };
                    process.ErrorDataReceived += (s, e) =>
                    {
                        if (e.Data == null) return;
                        lock (output) output.AppendLine(e.Data);
                        if (onLine != null) onLine(e.Data);
                    };
                    try
                    {
                        process.Start();
                    }
                    catch (Exception error)
                    {
                        throw new CloudflareException("Couldn't run cloudflared (" + error.Message + ").");
                    }
                    process.BeginOutputReadLine();
                    process.BeginErrorReadLine();
                    var deadline = DateTime.UtcNow + timeout;
                    var finished = false;
                    while (!(finished = process.WaitForExit(250)))
                    {
                        if (cancel.IsCancellationRequested || DateTime.UtcNow > deadline) break;
                    }
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
                        if (cancel.IsCancellationRequested) throw new OperationCanceledException(cancel);
                    }
                    else
                    {
                        process.WaitForExit(); // lets the output readers finish
                    }
                    lock (output)
                    {
                        return new CliResult { ExitCode = finished ? process.ExitCode : -1, Output = output.ToString(), StdOut = stdout.ToString(), TimedOut = !finished };
                    }
                }
            });
        }

        /// <summary>Cloudflare's sign-in page (dash.cloudflare.com) in a line of cloudflared's output; nothing else gets opened.</summary>
        internal static string SignInUrlIn(string line)
        {
            if (line == null) return null;
            var match = Regex.Match(line, @"https://[A-Za-z0-9.-]+/[^\s""'<>]*");
            if (!match.Success) return null;
            Uri uri;
            if (!Uri.TryCreate(match.Value, UriKind.Absolute, out uri)) return null;
            return uri.Host.ToLowerInvariant() == "dash.cloudflare.com" ? uri.AbsoluteUri : null;
        }

        /// <summary>The last error cloudflared printed ("... ERR message" or "failed to …"), for showing.</summary>
        internal static string Problem(string output)
        {
            string found = null;
            string last = null;
            foreach (var raw in (output ?? "").Split('\n'))
            {
                var line = raw.Trim();
                if (line.Length > 0 && !line.StartsWith("See 'cloudflared")) last = line;
                var err = Regex.Match(line, @"\b(ERR|FTL)\s+(.*)$");
                if (err.Success) found = err.Groups[2].Value;
                else if (line.StartsWith("failed", StringComparison.OrdinalIgnoreCase) || line.StartsWith("error", StringComparison.OrdinalIgnoreCase)) found = line;
            }
            if (found == null) found = last;
            if (found == null) return "cloudflared didn't say why.";
            found = Regex.Replace(found, @"eyJ[A-Za-z0-9_-]{20,}", "[token]");
            return found.Length > 300 ? found.Substring(0, 300) + "…" : found;
        }

        public async Task LogIn(Action<string, bool> onUrl, CancellationToken cancel)
        {
            // A fresh sign-in each time, so the domain is the one picked now.
            Forget();
            var told = false;
            var pleaseOpen = false;
            var result = await Run("tunnel login", SignIn, line =>
            {
                if (line.IndexOf("Please open the following URL", StringComparison.OrdinalIgnoreCase) >= 0) pleaseOpen = true;
                var url = SignInUrlIn(line);
                if (url == null || told) return;
                told = true;
                // cloudflared opens the browser itself unless it says it couldn't.
                onUrl(url, !pleaseOpen);
            }, cancel);
            if (File.Exists(CertPath)) return;
            if (result.TimedOut) throw new CloudflareException("Signing in to Cloudflare took too long. Press Connect to Cloudflare to try again.");
            throw new CloudflareException("Cloudflare sign-in didn't finish: " + Problem(result.Output));
        }

        public async Task<string> SignedInDomain()
        {
            // cert.pem holds {zoneID, accountID, apiToken} (cloudflared's credentials/origin_cert.go).
            try
            {
                var text = File.ReadAllText(CertPath);
                var match = Regex.Match(text, @"-----BEGIN ARGO TUNNEL TOKEN-----\s*([A-Za-z0-9+/=\s]+?)\s*-----END ARGO TUNNEL TOKEN-----");
                if (!match.Success) return null;
                var json = Encoding.UTF8.GetString(Convert.FromBase64String(Regex.Replace(match.Groups[1].Value, @"\s", "")));
                var cert = new JavaScriptSerializer().DeserializeObject(json) as Dictionary<string, object>;
                var zone = J.Str(cert, "zoneID");
                var token = J.Str(cert, "apiToken");
                if (zone == null || token == null || !Regex.IsMatch(zone, "^[0-9a-f]{32}$")) return null;
                using (var http = new HttpClient { Timeout = TimeSpan.FromSeconds(10) })
                {
                    http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
                    http.DefaultRequestHeaders.UserAgent.ParseAdd("TohyeeServerApp/1.0");
                    var answer = new JavaScriptSerializer().DeserializeObject(await http.GetStringAsync("https://api.cloudflare.com/client/v4/zones/" + zone)) as Dictionary<string, object>;
                    var name = J.Str(J.Obj(answer, "result"), "name");
                    return name != null && Regex.IsMatch(name, @"^[a-z0-9.-]+\.[a-z]{2,}$") ? name : null;
                }
            }
            catch (Exception)
            {
                // Best effort: the person types the domain instead.
                return null;
            }
        }

        public async Task<CloudflareTunnel> Connect(string tunnelName, string hostname, Action<string> progress, CancellationToken cancel)
        {
            if (!File.Exists(CertPath)) throw new CloudflareException("Tohyee isn't signed in to Cloudflare. Press Connect to Cloudflare again.");
            progress("Making the tunnel…");
            var created = await Run("tunnel create --output json " + Quote(tunnelName), Quick, null, cancel);
            string tunnel;
            if (created.ExitCode == 0)
            {
                var json = created.StdOut.IndexOf('{') >= 0 ? new JavaScriptSerializer().DeserializeObject(created.StdOut.Substring(created.StdOut.IndexOf('{'))) as Dictionary<string, object> : null;
                tunnel = J.Str(json, "id");
                if (tunnel == null) throw new CloudflareException("cloudflared made the tunnel but didn't say its id. Try again.");
            }
            else if (created.Output.IndexOf("already exists", StringComparison.OrdinalIgnoreCase) >= 0)
            {
                // Made by an earlier Connect to Cloudflare: use it again.
                tunnel = tunnelName;
            }
            else
            {
                throw new CloudflareException("Cloudflare didn't make the tunnel: " + Problem(created.Output));
            }

            progress("Adding " + hostname + " to your domain…");
            var routed = await Run("tunnel route dns " + Quote(tunnel) + " " + Quote(hostname), Quick, null, cancel);
            if (routed.ExitCode != 0)
            {
                var why = Problem(routed.Output);
                if (why.IndexOf("already exists", StringComparison.OrdinalIgnoreCase) >= 0)
                {
                    throw new CloudflareException(hostname + " is already used for something else in your Cloudflare DNS, so Tohyee left it alone. Choose another name, or delete that DNS record in Cloudflare first.");
                }
                throw new CloudflareException("Cloudflare didn't add " + hostname + ": " + why);
            }
            var added = Regex.Match(routed.Output, @"(?:Added CNAME (\S+) which will route to this tunnel|(\S+) is already configured to route to your tunnel|(\S+) updated to route to your tunnel)");
            var actual = added.Success ? (added.Groups[1].Value + added.Groups[2].Value + added.Groups[3].Value).TrimEnd('.').ToLowerInvariant() : null;
            if (actual != null && actual != hostname)
            {
                // cloudflared adds the name inside the domain chosen when signing in.
                throw new CloudflareException("Cloudflare added " + actual + " instead of " + hostname + ", because " + hostname + " isn't on the domain you chose when signing in. Delete " + actual + " in Cloudflare's DNS settings, then connect again and choose that domain.");
            }

            progress("Getting the tunnel's key…");
            var token = await Run("tunnel token " + Quote(tunnel), Quick, null, cancel);
            var found = Regex.Match(token.StdOut ?? "", @"eyJ[A-Za-z0-9+/=_-]{40,}");
            if (token.ExitCode != 0 || !found.Success) throw new CloudflareException("Cloudflare didn't give the tunnel's key: " + Problem(token.Output));
            return new CloudflareTunnel { TunnelId = tunnel, Token = found.Value, Hostname = hostname };
        }

        public void Forget()
        {
            RemoveSignInFiles();
        }

        /// <summary>
        /// Deletes cloudflared's cert.pem (an API token for the domain) and tunnel
        /// credentials from Tohyee's own folder. Done after connecting, and when the
        /// app starts in case it stopped partway through connecting (#208).
        /// </summary>
        public static void RemoveSignInFiles()
        {
            try
            {
                var folder = Path.Combine(Home, ".cloudflared");
                if (!Directory.Exists(folder)) return;
                foreach (var file in Directory.GetFiles(folder))
                {
                    var name = Path.GetFileName(file).ToLowerInvariant();
                    if (name == "cert.pem" || name.EndsWith(".json"))
                    {
                        File.SetAttributes(file, FileAttributes.Normal); // cloudflared writes credentials read-only
                        File.Delete(file);
                    }
                }
            }
            catch (Exception)
            {
                // Tohyee's own folder; nothing else depends on it.
            }
        }
    }
}
