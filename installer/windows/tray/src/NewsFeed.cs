using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

namespace Tohyee.Tray
{
    internal sealed class NewsItem
    {
        public string Date; // YYYY-MM-DD
        public string Title;
        public string Body;
        public string Link;
        /// <summary>"release", "announcement" or "conference".</summary>
        public string Kind;
    }

    internal sealed class NewsResult
    {
        public List<NewsItem> Items = new List<NewsItem>();
        public NewsItem Conference;
        public DateTime? FetchedAt;
        /// <summary>The last try to refresh failed (the items are from the cache, if any).</summary>
        public bool Offline;
    }

    /// <summary>
    /// News for the Home page: Tohyee's releases on GitHub, plus announcements
    /// from website/news.json (published by GitHub Pages), so news can be posted
    /// without a release. Fetched at most every few hours (GitHub allows 60
    /// unauthenticated requests an hour), cached in the user's app data for when
    /// the computer is offline, and failures are quiet.
    /// </summary>
    internal sealed class NewsFeed
    {
        public const string ReleasesUrl = "https://api.github.com/repos/Willy-nz/Tohyee/releases?per_page=6";
        public const string ReleasesPage = "https://github.com/Willy-nz/Tohyee/releases";
        public const string AnnouncementsUrl = "https://willy-nz.github.io/Tohyee/news.json";
        /// <summary>The same file straight from the repository, if GitHub Pages isn't set up.</summary>
        public const string AnnouncementsFallbackUrl = "https://raw.githubusercontent.com/Willy-nz/Tohyee/main/website/news.json";
        private static readonly TimeSpan RefreshEvery = TimeSpan.FromHours(4);
        private static readonly TimeSpan RetryAfterFailure = TimeSpan.FromMinutes(30);

        /// <summary>Shown until news.json is reachable (and if it has no conference item).</summary>
        public static readonly NewsItem DefaultConference = new NewsItem
        {
            Date = "2026-09-30",
            Kind = "conference",
            Title = "Save the date: TohyeeCon",
            Body = "The first Tohyee conference is coming to Ōtepoti Dunedin… one day. Date to be confirmed (probably after payroll is built). 🐶",
        };

        private readonly string _cacheFile;
        private readonly List<NewsItem> _sample;
        private Task<NewsResult> _loading;

        private NewsFeed(string cacheFile, List<NewsItem> sample)
        {
            _cacheFile = cacheFile;
            _sample = sample;
        }

        public static NewsFeed ForThisUser()
        {
            var folder = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Tohyee");
            return new NewsFeed(Path.Combine(folder, "news-cache.json"), null);
        }

        /// <summary>For the screenshots mode: fixed items, no network.</summary>
        public static NewsFeed Sample(List<NewsItem> items)
        {
            return new NewsFeed(null, items);
        }

        public Task<NewsResult> Load(bool force)
        {
            if (_sample != null)
            {
                var result = new NewsResult { FetchedAt = DateTime.Now };
                result.Items.AddRange(_sample.Where(i => i.Kind != "conference"));
                result.Conference = _sample.FirstOrDefault(i => i.Kind == "conference") ?? DefaultConference;
                return Task.FromResult(result);
            }
            if (_loading == null || _loading.IsCompleted) _loading = Task.Run(() => LoadNow(force));
            return _loading;
        }

        private sealed class Cache
        {
            public DateTime? FetchedAt;
            public DateTime? AttemptedAt;
            public List<NewsItem> Releases = new List<NewsItem>();
            public List<NewsItem> Announcements = new List<NewsItem>();
        }

        private async Task<NewsResult> LoadNow(bool force)
        {
            var cache = ReadCache();
            var now = DateTime.UtcNow;
            var fresh = cache.FetchedAt.HasValue && now - cache.FetchedAt.Value < RefreshEvery;
            var triedRecently = cache.AttemptedAt.HasValue && now - cache.AttemptedAt.Value < RetryAfterFailure;
            var offline = false;
            if (!fresh && !(triedRecently && !force))
            {
                cache.AttemptedAt = now;
                using (var http = new HttpClient { Timeout = TimeSpan.FromSeconds(15) })
                {
                    http.DefaultRequestHeaders.UserAgent.ParseAdd("TohyeeServerApp/1.0 (+https://github.com/Willy-nz/Tohyee)");
                    var releases = await Fetch(http, ReleasesUrl, "application/vnd.github+json");
                    var announcements = await Fetch(http, AnnouncementsUrl, "application/json") ?? await Fetch(http, AnnouncementsFallbackUrl, "application/json");
                    if (releases != null) cache.Releases = ParseReleases(releases);
                    if (announcements != null) cache.Announcements = ParseAnnouncements(announcements);
                    if (releases != null || announcements != null) cache.FetchedAt = now;
                    offline = releases == null && announcements == null;
                }
                WriteCache(cache);
            }
            else if (!cache.FetchedAt.HasValue)
            {
                offline = true;
            }

            var result = new NewsResult
            {
                FetchedAt = cache.FetchedAt.HasValue ? cache.FetchedAt.Value.ToLocalTime() : (DateTime?)null,
                Offline = offline,
            };
            result.Items = cache.Announcements.Where(i => i.Kind != "conference").Concat(cache.Releases)
                .OrderByDescending(i => i.Date, StringComparer.Ordinal).ToList();
            result.Conference = cache.Announcements.Where(i => i.Kind == "conference").OrderByDescending(i => i.Date, StringComparer.Ordinal).FirstOrDefault() ?? DefaultConference;
            return result;
        }

        private static async Task<string> Fetch(HttpClient http, string url, string accept)
        {
            try
            {
                using (var request = new HttpRequestMessage(HttpMethod.Get, url))
                {
                    request.Headers.Accept.ParseAdd(accept);
                    using (var response = await http.SendAsync(request).ConfigureAwait(false))
                    {
                        if (!response.IsSuccessStatusCode) return null;
                        return await response.Content.ReadAsStringAsync().ConfigureAwait(false);
                    }
                }
            }
            catch (Exception)
            {
                return null; // offline, blocked or slow: the cache is used
            }
        }

        internal static List<NewsItem> ParseReleases(string json)
        {
            var items = new List<NewsItem>();
            object parsed;
            try
            {
                parsed = new JavaScriptSerializer { MaxJsonLength = 8 * 1024 * 1024 }.DeserializeObject(json);
            }
            catch (Exception)
            {
                return items;
            }
            var list = parsed as object[];
            if (list == null) return items;
            foreach (var entry in list.OfType<Dictionary<string, object>>())
            {
                if (J.Bool(entry, "draft") || J.Bool(entry, "prerelease")) continue;
                var link = J.Str(entry, "html_url");
                items.Add(new NewsItem
                {
                    Kind = "release",
                    Date = DateOnly(J.Str(entry, "published_at")),
                    Title = J.Str(entry, "name") ?? J.Str(entry, "tag_name") ?? "New release",
                    Body = Summary(J.Str(entry, "body")),
                    Link = SafeLink(link) ?? ReleasesPage,
                });
                if (items.Count >= 5) break;
            }
            return items;
        }

        internal static List<NewsItem> ParseAnnouncements(string json)
        {
            var items = new List<NewsItem>();
            Dictionary<string, object> parsed;
            try
            {
                parsed = new JavaScriptSerializer().DeserializeObject(json) as Dictionary<string, object>;
            }
            catch (Exception)
            {
                return items;
            }
            foreach (var entry in J.List(parsed, "items"))
            {
                var title = J.Str(entry, "title");
                if (string.IsNullOrEmpty(title)) continue;
                items.Add(new NewsItem
                {
                    Kind = J.Str(entry, "kind") == "conference" ? "conference" : "announcement",
                    Date = DateOnly(J.Str(entry, "date")),
                    Title = Clip(title, 120),
                    Body = Clip(J.Str(entry, "body") ?? "", 400),
                    Link = SafeLink(J.Str(entry, "link")),
                });
            }
            return items;
        }

        /// <summary>Only https links are opened.</summary>
        private static string SafeLink(string link)
        {
            Uri uri;
            return link != null && Uri.TryCreate(link, UriKind.Absolute, out uri) && uri.Scheme == Uri.UriSchemeHttps ? uri.AbsoluteUri : null;
        }

        private static string DateOnly(string iso)
        {
            if (string.IsNullOrEmpty(iso)) return "";
            return iso.Length >= 10 ? iso.Substring(0, 10) : iso;
        }

        /// <summary>The first couple of lines of release notes, without Markdown.</summary>
        internal static string Summary(string markdown)
        {
            if (string.IsNullOrEmpty(markdown)) return "";
            var lines = new List<string>();
            foreach (var raw in markdown.Replace("\r", "").Split('\n'))
            {
                var line = raw.Trim();
                if (line.Length == 0 || line.StartsWith("#") || line.StartsWith("<!--") || line.StartsWith("---")) continue;
                line = Regex.Replace(line, @"^[-*+]\s+", "");
                line = Regex.Replace(line, @"!?\[([^\]]*)\]\([^)]*\)", "$1");
                line = Regex.Replace(line, @"[*_`]{1,3}", "");
                lines.Add(line);
                if (lines.Count == 2) break;
            }
            return Clip(string.Join(" · ", lines), 220);
        }

        private static string Clip(string text, int length)
        {
            return text.Length <= length ? text : text.Substring(0, length - 1).TrimEnd() + "…";
        }

        public static string FormatDate(string date)
        {
            DateTime parsed;
            return DateTime.TryParseExact(date, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out parsed)
                ? parsed.ToString("d MMM yyyy", CultureInfo.GetCultureInfo("en-NZ"))
                : date;
        }

        // ------------------------------------------------------------ cache

        private Cache ReadCache()
        {
            try
            {
                if (File.Exists(_cacheFile))
                {
                    var parsed = new JavaScriptSerializer().Deserialize<Cache>(File.ReadAllText(_cacheFile, Encoding.UTF8));
                    if (parsed != null)
                    {
                        if (parsed.Releases == null) parsed.Releases = new List<NewsItem>();
                        if (parsed.Announcements == null) parsed.Announcements = new List<NewsItem>();
                        return parsed;
                    }
                }
            }
            catch (Exception)
            {
                // A damaged cache is just refetched.
            }
            return new Cache();
        }

        private void WriteCache(Cache cache)
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(_cacheFile));
                File.WriteAllText(_cacheFile, new JavaScriptSerializer().Serialize(cache), Encoding.UTF8);
            }
            catch (Exception)
            {
                // Not being able to cache just means fetching again next time.
            }
        }
    }
}
