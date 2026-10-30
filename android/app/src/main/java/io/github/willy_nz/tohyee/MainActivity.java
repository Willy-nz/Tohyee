package io.github.willy_nz.tohyee;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

/**
 * Tohyee for Android (#502, decisions 1140-1142): one app for everyone. The
 * first time, it shows the bundled "Your Tohyee address" page; once an
 * address is saved, it opens that Tohyee server's own pages in the
 * WebView, so the web app's offline pages and queue carry on inside it.
 */
public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(TohyeeServerPlugin.class);
        // Null (no address yet) loads the bundled first-run page from capacitor.config.json.
        config = TohyeeServer.configFor(this);
        super.onCreate(savedInstanceState);
    }
}
