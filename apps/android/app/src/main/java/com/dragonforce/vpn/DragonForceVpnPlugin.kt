package com.dragonforce.vpn

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.os.Build
import android.webkit.JavascriptInterface
import org.json.JSONArray
import org.json.JSONObject
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Socket

/**
 * Native bridge exposed to the WebView as `window.DragonForceAndroid` (and wired into
 * `window.Capacitor.Plugins.DragonForceVpn`).
 *
 * Provides:
 *  - `connect(payloadJson)` / `disconnect()` / `getStatus()`
 *  - `pingServer(host, port, timeoutMs)` (TCP connect timing excluding DNS resolution)
 *  - `fetchCertSha256(host, port, sni)` (for Xray 26.10.31 `pinnedPeerCertSha256`)
 *  - `listInstalledApps()` (for Android Per-App Split Tunneling)
 *  - `getDynamicColors()` (Material You wallpaper palette on Android 12+)
 *  - `dispatchNotification(payloadJson)` (for Data Cap 80%/100%, Subscription updates, Shield milestones)
 *  - `readClipboard()` / `writeClipboard(text)` / `shareText(title, text)`
 *  - `getLogs()` / `clearLogs()` / `drainAccessLog()`
 */
class DragonForceVpnPlugin(private val activity: MainActivity) {

    @JavascriptInterface
    fun getStatus(): String {
        val obj = JSONObject()
        obj.put("connected", DragonForceVpnService.isConnected)
        obj.put("connecting", DragonForceVpnService.isConnecting)
        obj.put("activeServerId", DragonForceVpnService.activeServerId ?: JSONObject.NULL)
        obj.put("routingMode", "tun")
        obj.put("isAdmin", true)
        obj.put("tunActive", DragonForceVpnService.isConnected)
        obj.put("systemProxyActive", false)
        obj.put("terminalEnvActive", false)
        obj.put("connectedAt", DragonForceVpnService.connectedAtMs ?: JSONObject.NULL)
        obj.put("lastError", DragonForceVpnService.lastError ?: JSONObject.NULL)
        obj.put("socksPort", DragonForceVpnService.socksPort)
        obj.put("httpPort", DragonForceVpnService.httpPort)

        val stats = JSONObject().apply {
            put("upSpeed", DragonForceVpnService.upSpeed)
            put("downSpeed", DragonForceVpnService.downSpeed)
            put("sessionUp", DragonForceVpnService.sessionUp)
            put("sessionDown", DragonForceVpnService.sessionDown)
        }
        obj.put("stats", stats)
        return obj.toString()
    }

    @JavascriptInterface
    fun connect(payloadJson: String): String {
        return try {
            val req = JSONObject(payloadJson)
            val xrayConfigJson = req.optString("xrayConfigJson", "{}")
            val serverId = req.optString("serverId", "")
            val serverName = req.optString("serverName", "DragonForce Server")
            val protocol = req.optString("protocol", "vless")
            val socksPort = req.optInt("socksPort", 10808)
            val httpPort = req.optInt("httpPort", 10809)
            val perAppMode = req.optString("perAppMode", "off")
            val notifyConnect = req.optBoolean("notifyConnect", true)

            val selectedApps = ArrayList<String>()
            req.optJSONArray("selectedApps")?.let { arr ->
                for (i in 0 until arr.length()) {
                    val pkg = arr.optString(i).trim()
                    if (pkg.isNotEmpty()) selectedApps.add(pkg)
                }
            }

            val dnsServers = ArrayList<String>()
            req.optJSONArray("dnsServers")?.let { arr ->
                for (i in 0 until arr.length()) {
                    val d = arr.optString(i).trim()
                    if (d.isNotEmpty()) dnsServers.add(d)
                }
            }
            if (dnsServers.isEmpty()) {
                dnsServers.add("94.140.14.14")
                dnsServers.add("1.1.1.1")
            }

            activity.prepareAndStartVpnService(
                xrayConfigJson = xrayConfigJson,
                serverId = serverId,
                serverName = serverName,
                protocol = protocol,
                socksPort = socksPort,
                httpPort = httpPort,
                perAppMode = perAppMode,
                selectedApps = selectedApps,
                dnsServers = dnsServers,
                notifyConnect = notifyConnect
            )

            JSONObject().put("ok", true).toString()
        } catch (e: Exception) {
            JSONObject()
                .put("ok", false)
                .put("error", e.message ?: "Failed to start VPN")
                .toString()
        }
    }

    @JavascriptInterface
    fun disconnect(): String {
        return try {
            val stopIntent = Intent(activity, DragonForceVpnService::class.java).apply {
                action = DragonForceVpnService.ACTION_STOP
            }
            activity.startService(stopIntent)
            JSONObject().put("ok", true).toString()
        } catch (e: Exception) {
            JSONObject().put("ok", false).put("error", e.message).toString()
        }
    }

    @JavascriptInterface
    fun pingServer(host: String, port: Int, timeoutMs: Int): String {
        val checkedAt = System.currentTimeMillis()
        return try {
            // Resolve DNS first so DNS lookup latency is excluded from TCP handshake RTT
            val resolved: InetAddress = try {
                InetAddress.getByName(host)
            } catch (dnsErr: Exception) {
                return JSONObject()
                    .put("ping", -1)
                    .put("pingStatus", "dns-error")
                    .put("pingError", "DNS lookup failed for $host")
                    .put("pingCheckedAt", checkedAt)
                    .toString()
            }

            val socket = Socket()
            val startNs = System.nanoTime()
            try {
                socket.connect(InetSocketAddress(resolved, port), timeoutMs.coerceIn(500, 10000))
                val elapsedMs = ((System.nanoTime() - startNs) / 1_000_000.0).toInt().coerceAtLeast(1)
                JSONObject()
                    .put("ping", elapsedMs)
                    .put("pingStatus", "ok")
                    .put("pingCheckedAt", checkedAt)
                    .toString()
            } finally {
                try {
                    socket.close()
                } catch (_: Exception) {
                }
            }
        } catch (e: java.net.SocketTimeoutException) {
            JSONObject()
                .put("ping", -1)
                .put("pingStatus", "timeout")
                .put("pingError", "Connection timed out")
                .put("pingCheckedAt", checkedAt)
                .toString()
        } catch (e: java.net.ConnectException) {
            JSONObject()
                .put("ping", -1)
                .put("pingStatus", "refused")
                .put("pingError", e.message ?: "Connection refused")
                .put("pingCheckedAt", checkedAt)
                .toString()
        } catch (e: Exception) {
            JSONObject()
                .put("ping", -1)
                .put("pingStatus", "error")
                .put("pingError", e.message ?: "Probe failed")
                .put("pingCheckedAt", checkedAt)
                .toString()
        }
    }

    @JavascriptInterface
    fun fetchCertSha256(host: String, port: Int, sni: String?): String {
        return try {
            val hash = TlsCertPinner.fetchLeafCertSha256(host, port, sni)
            JSONObject().put("ok", true).put("sha256", hash).toString()
        } catch (e: Exception) {
            JSONObject()
                .put("ok", false)
                .put("error", e.message ?: "Could not read TLS certificate")
                .toString()
        }
    }

    @JavascriptInterface
    fun listInstalledApps(): String {
        return try {
            val pm: PackageManager = activity.packageManager
            val packages = pm.getInstalledApplications(PackageManager.GET_META_DATA)
            val result = JSONArray()

            for (appInfo in packages) {
                val pkgName = appInfo.packageName ?: continue
                if (pkgName == activity.packageName) continue

                val isSystem = (appInfo.flags and ApplicationInfo.FLAG_SYSTEM) != 0 &&
                    (appInfo.flags and ApplicationInfo.FLAG_UPDATED_SYSTEM_APP) == 0

                // Include all user-installed apps and launchable system apps (e.g. Chrome, YouTube)
                if (isSystem && pm.getLaunchIntentForPackage(pkgName) == null) continue

                val label = try {
                    pm.getApplicationLabel(appInfo).toString()
                } catch (_: Exception) {
                    pkgName
                }

                result.put(
                    JSONObject().apply {
                        put("packageName", pkgName)
                        put("name", label)
                        put("isSystem", isSystem)
                    }
                )
            }
            JSONObject().put("ok", true).put("apps", result).toString()
        } catch (e: Exception) {
            JSONObject().put("ok", false).put("apps", JSONArray()).put("error", e.message).toString()
        }
    }

    @JavascriptInterface
    fun getDynamicColors(): String {
        val obj = JSONObject()
        val supported = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
        obj.put("supported", supported)
        if (supported && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            try {
                val res = activity.resources
                val accent = res.getColor(android.R.color.system_accent1_500, activity.theme)
                val accentSoft = res.getColor(android.R.color.system_accent1_200, activity.theme)
                val surfaceDark = res.getColor(android.R.color.system_neutral1_900, activity.theme)
                val surfaceLight = res.getColor(android.R.color.system_neutral1_50, activity.theme)

                obj.put("accentHex", String.format("#%06X", 0xFFFFFF and accent))
                obj.put("accentSoftHex", String.format("#%06X", 0xFFFFFF and accentSoft))
                obj.put("surfaceDarkHex", String.format("#%06X", 0xFFFFFF and surfaceDark))
                obj.put("surfaceLightHex", String.format("#%06X", 0xFFFFFF and surfaceLight))
            } catch (_: Exception) {
            }
        }
        return obj.toString()
    }

    @JavascriptInterface
    fun dispatchNotification(payloadJson: String): String {
        return try {
            val req = JSONObject(payloadJson)
            val channel = req.optString("channel", NotificationHelper.CHANNEL_ALERTS)
            val id = req.optInt("id", NotificationHelper.ALERT_NOTIFICATION_ID)
            val title = req.optString("title", "DragonForce VPN")
            val body = req.optString("body", "")

            NotificationHelper.notifyEvent(activity, channel, id, title, body)
            JSONObject().put("ok", true).toString()
        } catch (e: Exception) {
            JSONObject().put("ok", false).put("error", e.message).toString()
        }
    }

    @JavascriptInterface
    fun readClipboard(): String {
        return try {
            val cm = activity.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            val clip: ClipData? = cm.primaryClip
            val text = if (clip != null && clip.itemCount > 0) {
                clip.getItemAt(0).coerceToText(activity)?.toString() ?: ""
            } else {
                ""
            }
            JSONObject().put("ok", true).put("text", text).toString()
        } catch (e: Exception) {
            JSONObject().put("ok", false).put("text", "").put("error", e.message).toString()
        }
    }

    @JavascriptInterface
    fun writeClipboard(text: String): String {
        return try {
            val cm = activity.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            cm.setPrimaryClip(ClipData.newPlainText("DragonForce VPN", text))
            JSONObject().put("ok", true).toString()
        } catch (e: Exception) {
            JSONObject().put("ok", false).put("error", e.message).toString()
        }
    }

    @JavascriptInterface
    fun shareText(title: String, text: String): String {
        return try {
            val sendIntent = Intent(Intent.ACTION_SEND).apply {
                type = "text/plain"
                putExtra(Intent.EXTRA_SUBJECT, title)
                putExtra(Intent.EXTRA_TEXT, text)
            }
            val chooser = Intent.createChooser(sendIntent, title)
            activity.startActivity(chooser)
            JSONObject().put("ok", true).toString()
        } catch (e: Exception) {
            JSONObject().put("ok", false).put("error", e.message).toString()
        }
    }

    @JavascriptInterface
    fun getLogs(): String = DragonForceVpnService.getLogsJson().toString()

    @JavascriptInterface
    fun clearLogs(): String {
        DragonForceVpnService.clearLogs()
        return JSONObject().put("ok", true).toString()
    }

    @JavascriptInterface
    fun drainAccessLog(): String = DragonForceVpnService.drainAccessLogChunks()
}
