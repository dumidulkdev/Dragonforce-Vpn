package com.dragonforce.vpn

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.net.VpnService
import android.os.Build
import android.os.Bundle
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.webkit.WebViewAssetLoader
import org.json.JSONObject

/**
 * Main Android hybrid activity hosting the DragonForce VPN UI inside a hardware-accelerated
 * WebView backed by `WebViewAssetLoader` and `DragonForceVpnPlugin` (`window.DragonForceAndroid`).
 */
class MainActivity : AppCompatActivity() {

    companion object {
        private const val REQ_VPN_PERMISSION = 9001
        private const val REQ_POST_NOTIFICATIONS = 9002
        private const val REQ_CAMERA_PERMISSION = 9003
    }

    private lateinit var webView: WebView
    private var pendingVpnStartIntent: Intent? = null
    private var pendingWebCameraRequest: PermissionRequest? = null

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        NotificationHelper.ensureChannels(this)
        requestNotificationPermissionIfNeeded()

        webView = WebView(this)
        setContentView(webView)

        val assetLoader = WebViewAssetLoader.Builder()
            .setDomain("appassets.androidplatform.net")
            .addPathHandler("/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = false
            allowContentAccess = true
            mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
            cacheMode = WebSettings.LOAD_DEFAULT
        }

        webView.addJavascriptInterface(DragonForceVpnPlugin(this), "DragonForceAndroid")

        webView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(
                view: WebView,
                request: WebResourceRequest
            ): WebResourceResponse? {
                return assetLoader.shouldInterceptRequest(request.url)
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                handleIncomingIntent(intent)
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                if (request.resources.contains(PermissionRequest.RESOURCE_VIDEO_CAPTURE)) {
                    if (ContextCompat.checkSelfPermission(
                            this@MainActivity,
                            Manifest.permission.CAMERA
                        ) == PackageManager.PERMISSION_GRANTED
                    ) {
                        request.grant(request.resources)
                    } else {
                        pendingWebCameraRequest = request
                        ActivityCompat.requestPermissions(
                            this@MainActivity,
                            arrayOf(Manifest.permission.CAMERA),
                            REQ_CAMERA_PERMISSION
                        )
                    }
                } else {
                    request.grant(request.resources)
                }
            }
        }

        webView.loadUrl("https://appassets.androidplatform.net/app.html")
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIncomingIntent(intent)
    }

    private fun handleIncomingIntent(intent: Intent?) {
        if (intent == null) return

        // 1. Handle notification "Switch Server" navigation
        val navView = intent.getStringExtra("navigateView")
        if (!navView.isNullOrBlank()) {
            intent.removeExtra("navigateView")
            dispatchToWebUi("navigateView", navView)
        }

        // 2. Handle Quick Settings Tile / Widget 1-Tap Connect
        if (intent.getBooleanExtra("quickConnect", false)) {
            intent.removeExtra("quickConnect")
            dispatchToWebUi("quickConnect", "true")
        }

        // 3. Handle vless:// or vmess:// deep link
        val dataUri = intent.dataString
        if (!dataUri.isNullOrBlank() &&
            (dataUri.startsWith("vless://", true) || dataUri.startsWith("vmess://", true))
        ) {
            intent.data = null
            dispatchToWebUi("importUri", dataUri)
        }

        // 4. Handle Android Share Sheet text/plain
        if (Intent.ACTION_SEND == intent.action && intent.type == "text/plain") {
            val sharedText = intent.getStringExtra(Intent.EXTRA_TEXT)
            if (!sharedText.isNullOrBlank()) {
                intent.removeExtra(Intent.EXTRA_TEXT)
                dispatchToWebUi("importUri", sharedText)
            }
        }
    }

    private fun dispatchToWebUi(type: String, payload: String) {
        if (!::webView.isInitialized) return
        val eventJson = JSONObject().apply {
            put("type", type)
            put("payload", payload)
        }.toString()

        webView.post {
            webView.evaluateJavascript(
                "window.dispatchEvent(new CustomEvent('dragonforce:native', { detail: $eventJson }));",
                null
            )
        }
    }

    fun prepareAndStartVpnService(
        xrayConfigJson: String,
        serverId: String,
        serverName: String,
        protocol: String,
        socksPort: Int,
        httpPort: Int,
        perAppMode: String,
        selectedApps: ArrayList<String>,
        dnsServers: ArrayList<String>,
        notifyConnect: Boolean
    ) {
        val serviceIntent = Intent(this, DragonForceVpnService::class.java).apply {
            action = DragonForceVpnService.ACTION_START
            putExtra("xrayConfigJson", xrayConfigJson)
            putExtra("serverId", serverId)
            putExtra("serverName", serverName)
            putExtra("protocol", protocol)
            putExtra("socksPort", socksPort)
            putExtra("httpPort", httpPort)
            putExtra("perAppMode", perAppMode)
            putStringArrayListExtra("selectedApps", selectedApps)
            putStringArrayListExtra("dnsServers", dnsServers)
            putExtra("notifyConnect", notifyConnect)
        }

        val prepareIntent = VpnService.prepare(this)
        if (prepareIntent != null) {
            pendingVpnStartIntent = serviceIntent
            @Suppress("DEPRECATION")
            startActivityForResult(prepareIntent, REQ_VPN_PERMISSION)
        } else {
            startVpnForegroundService(serviceIntent)
        }
    }

    private fun startVpnForegroundService(serviceIntent: Intent) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(serviceIntent)
        } else {
            startService(serviceIntent)
        }
    }

    private fun requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(
                    this,
                    Manifest.permission.POST_NOTIFICATIONS
                ) != PackageManager.PERMISSION_GRANTED
            ) {
                ActivityCompat.requestPermissions(
                    this,
                    arrayOf(Manifest.permission.POST_NOTIFICATIONS),
                    REQ_POST_NOTIFICATIONS
                )
            }
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == REQ_VPN_PERMISSION) {
            val pending = pendingVpnStartIntent
            pendingVpnStartIntent = null
            if (resultCode == Activity.RESULT_OK && pending != null) {
                startVpnForegroundService(pending)
            } else {
                dispatchToWebUi("vpnPermissionDenied", "VPN permission was denied by the user")
            }
        }
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQ_CAMERA_PERMISSION) {
            val req = pendingWebCameraRequest
            pendingWebCameraRequest = null
            if (req != null) {
                if (grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                    req.grant(req.resources)
                } else {
                    req.deny()
                }
            }
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (::webView.isInitialized && webView.canGoBack()) {
            webView.goBack()
        } else {
            super.onBackPressed()
        }
    }
}
