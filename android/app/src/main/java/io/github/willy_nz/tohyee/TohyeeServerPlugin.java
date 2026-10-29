package io.github.willy_nz.tohyee;

import android.app.Activity;
import android.net.Uri;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.JSONObject;

/**
 * The Tohyee address, from the app's pages (#502, decision 1142):
 * get, set (only from the bundled first-run page), and clear (back to the
 * first-run page, from Get Tohyee on this device). The "can't reach Tohyee"
 * page's two links, tohyee-app://retry and tohyee-app://change-address, are
 * handled here too.
 */
@CapacitorPlugin(name = "TohyeeServer")
public class TohyeeServerPlugin extends Plugin {

    private static final String LINK_SCHEME = "tohyee-app";

    @PluginMethod
    public void get(PluginCall call) {
        String origin = TohyeeServer.saved(getContext());
        JSObject result = new JSObject();
        result.put("url", origin == null ? JSONObject.NULL : origin);
        call.resolve(result);
    }

    @PluginMethod
    public void set(PluginCall call) {
        // Only the app's own first-run page may choose the server, never a page from a server.
        String current = getBridge().getWebView().getUrl();
        String local = getBridge().getLocalUrl();
        if (current == null || local == null || !current.startsWith(local + "/") || getBridge().getServerUrl() != null) {
            call.reject("The Tohyee address can only be chosen on the app's first screen.", "NOT_ALLOWED");
            return;
        }
        String origin = TohyeeServer.origin(call.getString("url"));
        if (origin == null) {
            call.reject("The app only opens HTTPS addresses (https://…).", "INVALID");
            return;
        }
        TohyeeServer.save(getContext(), origin);
        call.resolve();
        restart();
    }

    @PluginMethod
    public void clear(PluginCall call) {
        TohyeeServer.clear(getContext());
        call.resolve();
        restart();
    }

    @Override
    public Boolean shouldOverrideLoad(Uri url) {
        if (url == null || !LINK_SCHEME.equals(url.getScheme())) return null;
        if ("change-address".equals(url.getHost())) TohyeeServer.clear(getContext());
        restart();
        return true;
    }

    /** Starts the app's page again with the new (or no) address. */
    private void restart() {
        Activity activity = getActivity();
        if (activity != null) activity.runOnUiThread(activity::recreate);
    }
}
