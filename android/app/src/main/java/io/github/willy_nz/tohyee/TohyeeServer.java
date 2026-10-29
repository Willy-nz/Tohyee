package io.github.willy_nz.tohyee;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;
import com.getcapacitor.CapConfig;
import com.getcapacitor.Logger;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * The Tohyee address the app opens (#502, decision 1142): kept in the app's
 * own private storage, HTTPS only, the server's origin only. With one
 * saved, Capacitor is started with it as its server URL and no other
 * address allowed, so every link to another website opens in the phone's
 * browser.
 */
final class TohyeeServer {

    private static final String PREFS = "tohyee_server";
    private static final String KEY = "origin";
    private static final String PREVIOUS = "previous";

    private TohyeeServer() {}

    /** "https://host[:port]" from an address, or null unless it's HTTPS with a host and nothing else. */
    static String origin(String input) {
        if (input == null) return null;
        Uri uri = Uri.parse(input.trim());
        String scheme = uri.getScheme();
        String host = uri.getHost();
        if (scheme == null || !"https".equals(scheme.toLowerCase(Locale.ROOT))) return null;
        if (host == null || host.isEmpty() || uri.getUserInfo() != null) return null;
        String path = uri.getPath();
        if (path != null && !path.isEmpty() && !"/".equals(path)) return null;
        if (uri.getQuery() != null || uri.getFragment() != null) return null;
        int port = uri.getPort();
        return "https://" + host.toLowerCase(Locale.ROOT) + (port > 0 && port != 443 ? ":" + port : "");
    }

    static String saved(Context context) {
        return origin(prefs(context).getString(KEY, null));
    }

    static void save(Context context, String origin) {
        prefs(context).edit().putString(KEY, origin).apply();
    }

    /** Forgets the address; it's kept as the previous one, to fill in on the first-run page. */
    static void clear(Context context) {
        String origin = saved(context);
        SharedPreferences.Editor editor = prefs(context).edit().remove(KEY);
        if (origin != null) editor.putString(PREVIOUS, origin);
        editor.apply();
    }

    static String previous(Context context) {
        return origin(prefs(context).getString(PREVIOUS, null));
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** Capacitor's config with the saved server, or null to start on the first-run page. */
    static CapConfig configFor(Context context) {
        String origin = saved(context);
        if (origin == null) return null;
        try {
            JSONObject root = new JSONObject(readAsset(context, "capacitor.config.json"));
            JSONObject server = root.optJSONObject("server");
            if (server == null) server = new JSONObject();
            server.put("url", origin);
            // Only the server itself: anything else is opened outside the app.
            server.put("allowNavigation", new JSONArray());
            server.put("cleartext", false);
            root.put("server", server);
            File dir = new File(context.getFilesDir(), "tohyee-config");
            if (!dir.isDirectory() && !dir.mkdirs()) return null;
            try (FileOutputStream out = new FileOutputStream(new File(dir, "capacitor.config.json"))) {
                out.write(root.toString().getBytes(StandardCharsets.UTF_8));
            }
            return CapConfig.loadFromFile(context, dir.getAbsolutePath());
        } catch (Exception error) {
            Logger.error("Tohyee", "Couldn't use the saved Tohyee address; showing the first screen.", error);
            return null;
        }
    }

    private static String readAsset(Context context, String name) throws Exception {
        try (InputStream in = context.getAssets().open(name); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            int read;
            while ((read = in.read(buffer)) != -1) out.write(buffer, 0, read);
            return out.toString("UTF-8");
        }
    }
}
