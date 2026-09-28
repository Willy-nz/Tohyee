using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

namespace Tohyee.Tray
{
    /// <summary>A refusal or failure from the Tohyee server, with its message.</summary>
    internal sealed class ApiException : Exception
    {
        public int Status { get; private set; }

        public ApiException(int status, string message) : base(message)
        {
            Status = status;
        }
    }

    /// <summary>
    /// Talks to the Tohyee server's own API on this computer. Server settings go
    /// to the local-only address (127.0.0.1, the admin port), signed in as a
    /// server admin; the session cookie is kept for as long as the app runs.
    /// </summary>
    internal sealed class TohyeeApi : IDisposable
    {
        private readonly HttpClient _client;
        private readonly CookieContainer _cookies = new CookieContainer();
        private readonly string _baseUrl;
        private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 16 * 1024 * 1024 };

        public string SignedInEmail { get; private set; }

        public TohyeeApi(string baseUrl)
        {
            _baseUrl = baseUrl.TrimEnd('/');
            var handler = new HttpClientHandler { CookieContainer = _cookies, UseCookies = true, AllowAutoRedirect = false, UseProxy = false };
            _client = new HttpClient(handler) { Timeout = System.Threading.Timeout.InfiniteTimeSpan };
            // The server checks that changes come from its own address.
            _client.DefaultRequestHeaders.Add("Origin", _baseUrl);
            _client.DefaultRequestHeaders.UserAgent.ParseAdd("TohyeeTray/1.0");
        }

        public Task<Dictionary<string, object>> Get(string path)
        {
            return Send(HttpMethod.Get, path, null);
        }

        public Task<Dictionary<string, object>> Post(string path, object body)
        {
            return Send(HttpMethod.Post, path, body ?? new Dictionary<string, object>());
        }

        /// <summary>A POST that may take a while (a backup or a restore): waits up to 30 minutes.</summary>
        public Task<Dictionary<string, object>> PostLong(string path, object body)
        {
            return Send(HttpMethod.Post, path, body ?? new Dictionary<string, object>(), TimeSpan.FromMinutes(30));
        }

        public Task<Dictionary<string, object>> Put(string path, object body)
        {
            return Send(HttpMethod.Put, path, body);
        }

        public Task<Dictionary<string, object>> Patch(string path, object body)
        {
            return Send(new HttpMethod("PATCH"), path, body);
        }

        public Task<Dictionary<string, object>> Delete(string path)
        {
            return Send(HttpMethod.Delete, path, null);
        }

        private Task<Dictionary<string, object>> Send(HttpMethod method, string path, object body)
        {
            return Send(method, path, body, TimeSpan.FromSeconds(60));
        }

        private async Task<Dictionary<string, object>> Send(HttpMethod method, string path, object body, TimeSpan timeout)
        {
            using (var cancel = new System.Threading.CancellationTokenSource(timeout))
            using (var request = new HttpRequestMessage(method, _baseUrl + path))
            {
                if (body != null)
                {
                    request.Content = new StringContent(Json.Serialize(body), Encoding.UTF8, "application/json");
                }
                HttpResponseMessage response;
                try
                {
                    response = await _client.SendAsync(request, cancel.Token).ConfigureAwait(false);
                }
                catch (HttpRequestException)
                {
                    throw new ApiException(0, "Tohyee isn't answering on this computer (" + _baseUrl + "). Check that the Tohyee service is running.");
                }
                catch (TaskCanceledException)
                {
                    throw new ApiException(0, "Tohyee took too long to answer.");
                }
                using (response)
                {
                    var text = await response.Content.ReadAsStringAsync().ConfigureAwait(false);
                    Dictionary<string, object> payload = null;
                    try
                    {
                        payload = Json.DeserializeObject(text) as Dictionary<string, object>;
                    }
                    catch (ArgumentException)
                    {
                        payload = null;
                    }
                    catch (InvalidOperationException)
                    {
                        payload = null;
                    }
                    if (!response.IsSuccessStatusCode)
                    {
                        var message = payload != null ? J.Str(payload, "error") : null;
                        throw new ApiException((int)response.StatusCode, message ?? "Tohyee refused the request (" + (int)response.StatusCode + ").");
                    }
                    return payload ?? new Dictionary<string, object>();
                }
            }
        }

        /// <summary>
        /// Signs in with email and password. Returns the stage: "full" (signed in),
        /// "verify" (an authenticator or backup code is needed next) or "enrol"
        /// (two-step sign-in must be set up first, in the browser).
        /// </summary>
        public async Task<string> SignIn(string email, string password)
        {
            var result = await Post("/api/auth/login", new Dictionary<string, object> { { "email", email }, { "password", password } }).ConfigureAwait(false);
            var stage = J.Str(result, "stage") ?? "full";
            if (stage == "full") SignedInEmail = email;
            return stage;
        }

        /// <summary>Finishes signing in with an authenticator code or a backup code.</summary>
        public async Task Verify(string email, string code)
        {
            await Post("/api/auth/two-step/verify", new Dictionary<string, object> { { "code", code } }).ConfigureAwait(false);
            SignedInEmail = email;
        }

        public async Task SignOut()
        {
            try
            {
                await Post("/api/auth/logout", null).ConfigureAwait(false);
            }
            catch (ApiException)
            {
                // Signed out locally either way.
            }
            SignedInEmail = null;
        }

        public void Dispose()
        {
            _client.Dispose();
        }
    }

    /// <summary>Reading the JSON the server sends (JavaScriptSerializer's dictionaries and arrays).</summary>
    internal static class J
    {
        public static string Str(Dictionary<string, object> obj, string key)
        {
            object value;
            if (obj == null || !obj.TryGetValue(key, out value) || value == null) return null;
            if (value is string) return (string)value;
            return Convert.ToString(value, CultureInfo.InvariantCulture);
        }

        public static bool Bool(Dictionary<string, object> obj, string key)
        {
            object value;
            return obj != null && obj.TryGetValue(key, out value) && value is bool && (bool)value;
        }

        public static double Num(Dictionary<string, object> obj, string key)
        {
            object value;
            if (obj == null || !obj.TryGetValue(key, out value) || value == null) return 0;
            try
            {
                return Convert.ToDouble(value, CultureInfo.InvariantCulture);
            }
            catch (FormatException)
            {
                return 0;
            }
        }

        public static int Int(Dictionary<string, object> obj, string key)
        {
            object value;
            if (obj == null || !obj.TryGetValue(key, out value) || value == null) return 0;
            try
            {
                return Convert.ToInt32(value, CultureInfo.InvariantCulture);
            }
            catch (FormatException)
            {
                return 0;
            }
        }

        public static Dictionary<string, object> Obj(Dictionary<string, object> obj, string key)
        {
            object value;
            if (obj == null || !obj.TryGetValue(key, out value)) return null;
            return value as Dictionary<string, object>;
        }

        public static List<Dictionary<string, object>> List(Dictionary<string, object> obj, string key)
        {
            var list = new List<Dictionary<string, object>>();
            object value;
            if (obj == null || !obj.TryGetValue(key, out value)) return list;
            var items = value as IEnumerable;
            if (items == null || value is string) return list;
            foreach (var item in items)
            {
                var entry = item as Dictionary<string, object>;
                if (entry != null) list.Add(entry);
            }
            return list;
        }

        public static List<string> Strings(Dictionary<string, object> obj, string key)
        {
            var list = new List<string>();
            object value;
            if (obj == null || !obj.TryGetValue(key, out value)) return list;
            var items = value as IEnumerable;
            if (items == null || value is string) return list;
            foreach (var item in items)
            {
                if (item != null) list.Add(Convert.ToString(item, CultureInfo.InvariantCulture));
            }
            return list;
        }

        /// <summary>"2026-09-28T07:51:00Z" as local time, e.g. "28 Sep 2026 7:51 pm".</summary>
        public static string When(string iso)
        {
            DateTime parsed;
            if (string.IsNullOrEmpty(iso)) return "";
            if (DateTime.TryParse(iso, CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out parsed))
            {
                return parsed.ToLocalTime().ToString("d MMM yyyy h:mm tt", CultureInfo.GetCultureInfo("en-NZ"));
            }
            return iso;
        }
    }
}
