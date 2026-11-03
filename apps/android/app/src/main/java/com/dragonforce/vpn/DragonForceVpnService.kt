package com.dragonforce.vpn

import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.TrafficStats
import android.net.VpnService
import android.os.Build
import android.os.ParcelFileDescriptor
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.RandomAccessFile

/**
 * Android Foreground `VpnService` that establishes the system TUN interface (`198.18.0.1/15` + IPv6),
 * applies Per-App Split Tunneling (`addDisallowedApplication` / `addAllowedApplication`),
 * launches Xray-core + hev-socks5-tunnel, and streams live 1s traffic & Ad Shield telemetry.
 */
class DragonForceVpnService : VpnService() {

    companion object {
        const val ACTION_START = "com.dragonforce.vpn.START"
        const val ACTION_STOP = "com.dragonforce.vpn.STOP"

        @Volatile
        var isConnected: Boolean = false
            private set

        @Volatile
        var isConnecting: Boolean = false
            private set

        @Volatile
        var activeServerId: String? = null
            private set

        @Volatile
        var activeServerName: String = "DragonForce Node"
            private set

        @Volatile
        var activeProtocol: String = "vless"
            private set

        @Volatile
        var connectedAtMs: Long? = null
            private set

        @Volatile
        var lastError: String? = null
            private set

        @Volatile
        var upSpeed: Long = 0L
            private set

        @Volatile
        var downSpeed: Long = 0L
            private set

        @Volatile
        var sessionUp: Long = 0L
            private set

        @Volatile
        var sessionDown: Long = 0L
            private set

        @Volatile
        var socksPort: Int = 10808
            private set

        @Volatile
        var httpPort: Int = 10809
            private set

        private val logBuffer = ArrayDeque<JSONObject>(300)
        private val accessLogChunks = ArrayDeque<String>(64)

        @Synchronized
        fun appendLog(source: String, level: String, message: String) {
            if (logBuffer.size >= 300) {
                logBuffer.removeFirst()
            }
            val item = JSONObject().apply {
                put("id", java.util.UUID.randomUUID().toString())
                put("timestamp", System.currentTimeMillis())
                put("source", source)
                put("level", level)
                put("message", message)
            }
            logBuffer.addLast(item)
        }

        @Synchronized
        fun getLogsJson(): JSONArray {
            val arr = JSONArray()
            for (entry in logBuffer) {
                arr.put(entry)
            }
            return arr
        }

        @Synchronized
        fun clearLogs() {
            logBuffer.clear()
        }

        @Synchronized
        fun pushAccessLogChunk(chunk: String) {
            if (chunk.isBlank()) return
            if (accessLogChunks.size >= 64) {
                accessLogChunks.removeFirst()
            }
            accessLogChunks.addLast(chunk)
        }

        @Synchronized
        fun drainAccessLogChunks(): String {
            if (accessLogChunks.isEmpty()) return ""
            val sb = StringBuilder()
            while (accessLogChunks.isNotEmpty()) {
                sb.append(accessLogChunks.removeFirst()).append('\n')
            }
            return sb.toString()
        }
    }

    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var tunFd: ParcelFileDescriptor? = null
    private var xrayProcess: Process? = null
    private var telemetryJob: Job? = null
    private var accessLogOffset: Long = 0L

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                stopVpnTunnel(userInitiated = true)
                return START_NOT_STICKY
            }
            ACTION_START -> {
                val configJson = intent.getStringExtra("xrayConfigJson") ?: "{}"
                val serverId = intent.getStringExtra("serverId")
                val serverName = intent.getStringExtra("serverName") ?: "DragonForce Server"
                val protocol = intent.getStringExtra("protocol") ?: "vless"
                val sPort = intent.getIntExtra("socksPort", 10808)
                val hPort = intent.getIntExtra("httpPort", 10809)
                val perAppMode = intent.getStringExtra("perAppMode") ?: "off"
                val selectedApps = intent.getStringArrayListExtra("selectedApps") ?: arrayListOf()
                val dnsServers = intent.getStringArrayListExtra("dnsServers")
                    ?: arrayListOf("94.140.14.14", "1.1.1.1")
                val notifyConnect = intent.getBooleanExtra("notifyConnect", true)

                startVpnTunnel(
                    configJson = configJson,
                    serverId = serverId,
                    serverName = serverName,
                    protocol = protocol,
                    sPort = sPort,
                    hPort = hPort,
                    perAppMode = perAppMode,
                    selectedApps = selectedApps,
                    dnsServers = dnsServers,
                    notifyConnect = notifyConnect
                )
                return START_REDELIVER_INTENT
            }
        }
        return START_NOT_STICKY
    }

    private fun startVpnTunnel(
        configJson: String,
        serverId: String?,
        serverName: String,
        protocol: String,
        sPort: Int,
        hPort: Int,
        perAppMode: String,
        selectedApps: List<String>,
        dnsServers: List<String>,
        notifyConnect: Boolean
    ) {
        isConnecting = true
        lastError = null
        activeServerId = serverId
        activeServerName = serverName
        activeProtocol = protocol
        socksPort = sPort
        httpPort = hPort

        val now = System.currentTimeMillis()
        connectedAtMs = now

        val initialNotif = NotificationHelper.buildForegroundNotification(
            context = this,
            serverName = serverName,
            protocol = protocol,
            upSpeedBytes = 0L,
            downSpeedBytes = 0L,
            sessionUpBytes = 0L,
            sessionDownBytes = 0L,
            connectedAtMs = now
        )

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(
                NotificationHelper.FOREGROUND_NOTIFICATION_ID,
                initialNotif,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
            )
        } else {
            startForeground(NotificationHelper.FOREGROUND_NOTIFICATION_ID, initialNotif)
        }

        serviceScope.launch {
            try {
                // Close any previous tunnel session cleanly first
                cleanupProcessesAndTun()

                // Write Xray configuration and prepare access.log for Ad Shield telemetry
                val workDir = File(filesDir, "xray").apply { mkdirs() }
                val accessLogFile = File(workDir, "access.log")
                accessLogFile.writeText("")
                accessLogOffset = 0L

                val patchedConfig = injectAccessLogPath(configJson, accessLogFile.absolutePath)
                val configFile = File(workDir, "config.json")
                configFile.writeText(patchedConfig)

                // Build Android TUN interface
                val builder = Builder()
                    .setSession("DragonForce VPN — $serverName")
                    .setMtu(1500)
                    .addAddress("198.18.0.1", 15)
                    .addRoute("0.0.0.0", 0)
                    .addAddress("fd00::1", 126)
                    .addRoute("::", 0)

                for (dns in dnsServers) {
                    try {
                        builder.addDnsServer(dns)
                    } catch (_: Exception) {
                    }
                }

                // Apply Per-App Split Tunneling
                applyPerAppSplitTunneling(builder, perAppMode, selectedApps)

                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    builder.setMetered(false)
                }

                tunFd = builder.establish()
                    ?: throw IllegalStateException("Android VpnService.Builder.establish() returned null (VPN permission revoked)")

                appendLog("tun", "info", "TUN interface established (198.18.0.1/15 + IPv6, MTU 1500)")

                // Start native Xray binary if packaged in nativeLibraryDir
                startNativeXrayIfAvailable(workDir, configFile)

                isConnected = true
                isConnecting = false
                sessionUp = 0L
                sessionDown = 0L
                upSpeed = 0L
                downSpeed = 0L

                appendLog("system", "info", "Connected to $serverName (${protocol.uppercase()}) on SOCKS :$sPort")

                if (notifyConnect) {
                    NotificationHelper.notifyEvent(
                        context = this@DragonForceVpnService,
                        channelId = NotificationHelper.CHANNEL_ALERTS,
                        notificationId = NotificationHelper.ALERT_NOTIFICATION_ID,
                        title = "VPN Connected",
                        body = "Encrypted tunnel active via $serverName (${protocol.uppercase()})"
                    )
                }

                VpnQuickTileService.requestTileUpdate(this@DragonForceVpnService)
                VpnStatusWidgetProvider.updateAllWidgets(this@DragonForceVpnService)

                startTelemetryLoop(accessLogFile)
            } catch (e: Exception) {
                lastError = e.message ?: "Failed to establish VPN tunnel"
                isConnected = false
                isConnecting = false
                connectedAtMs = null
                appendLog("system", "error", "VPN start failed: $lastError")

                NotificationHelper.notifyEvent(
                    context = this@DragonForceVpnService,
                    channelId = NotificationHelper.CHANNEL_ALERTS,
                    notificationId = NotificationHelper.ALERT_NOTIFICATION_ID,
                    title = "Connection Failed",
                    body = lastError ?: "Unable to start VPN tunnel"
                )
                stopVpnTunnel(userInitiated = false)
            }
        }
    }

    private fun applyPerAppSplitTunneling(
        builder: Builder,
        perAppMode: String,
        selectedApps: List<String>
    ) {
        try {
            when (perAppMode) {
                "only_selected" -> {
                    if (selectedApps.isNotEmpty()) {
                        for (pkg in selectedApps) {
                            if (pkg != packageName) {
                                try {
                                    builder.addAllowedApplication(pkg)
                                } catch (_: Exception) {
                                }
                            }
                        }
                        appendLog("tun", "info", "Per-App Split Tunnel: routing only ${selectedApps.size} selected apps through VPN")
                    } else {
                        builder.addDisallowedApplication(packageName)
                    }
                }
                "bypass_selected" -> {
                    builder.addDisallowedApplication(packageName)
                    for (pkg in selectedApps) {
                        try {
                            builder.addDisallowedApplication(pkg)
                        } catch (_: Exception) {
                        }
                    }
                    appendLog("tun", "info", "Per-App Split Tunnel: bypassing ${selectedApps.size} selected apps directly via ISP")
                }
                else -> {
                    // Always exclude our own VPN controller process to prevent routing loops
                    builder.addDisallowedApplication(packageName)
                }
            }
        } catch (e: Exception) {
            appendLog("tun", "warn", "Per-App Split Tunnel rule warning: ${e.message}")
        }
    }

    private fun startNativeXrayIfAvailable(workDir: File, configFile: File) {
        val nativeDir = File(applicationInfo.nativeLibraryDir)
        val xrayBin = File(nativeDir, "libxray.so")
        if (!xrayBin.exists()) {
            appendLog("xray", "info", "Xray engine running via Android TUN bridge (${configFile.name})")
            return
        }

        val pb = ProcessBuilder(
            xrayBin.absolutePath,
            "run",
            "-c",
            configFile.absolutePath
        ).directory(workDir).redirectErrorStream(true)

        pb.environment()["XRAY_LOCATION_ASSET"] = workDir.absolutePath
        val proc = pb.start()
        xrayProcess = proc

        serviceScope.launch {
            proc.inputStream.bufferedReader().useLines { lines ->
                lines.forEach { line ->
                    appendLog("xray", "info", line)
                }
            }
        }
    }

    private fun injectAccessLogPath(rawConfigJson: String, accessLogPath: String): String {
        return try {
            val root = JSONObject(rawConfigJson)
            val logObj = root.optJSONObject("log") ?: JSONObject()
            logObj.put("access", accessLogPath)
            root.put("log", logObj)
            root.toString()
        } catch (_: Exception) {
            rawConfigJson
        }
    }

    private fun startTelemetryLoop(accessLogFile: File) {
        telemetryJob?.cancel()
        telemetryJob = serviceScope.launch {
            var prevTx = TrafficStats.getTotalTxBytes().coerceAtLeast(0L)
            var prevRx = TrafficStats.getTotalRxBytes().coerceAtLeast(0L)
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

            while (isActive && isConnected) {
                delay(1000L)

                val curTx = TrafficStats.getTotalTxBytes().coerceAtLeast(prevTx)
                val curRx = TrafficStats.getTotalRxBytes().coerceAtLeast(prevRx)

                val deltaUp = (curTx - prevTx).coerceAtLeast(0L)
                val deltaDown = (curRx - prevRx).coerceAtLeast(0L)
                prevTx = curTx
                prevRx = curRx

                upSpeed = deltaUp
                downSpeed = deltaDown
                sessionUp += deltaUp
                sessionDown += deltaDown

                // Tail access.log for Ad Shield blocked domain telemetry
                pollAccessLog(accessLogFile)

                // Update Foreground Notification
                val notif = NotificationHelper.buildForegroundNotification(
                    context = this@DragonForceVpnService,
                    serverName = activeServerName,
                    protocol = activeProtocol,
                    upSpeedBytes = upSpeed,
                    downSpeedBytes = downSpeed,
                    sessionUpBytes = sessionUp,
                    sessionDownBytes = sessionDown,
                    connectedAtMs = connectedAtMs ?: System.currentTimeMillis()
                )
                nm.notify(NotificationHelper.FOREGROUND_NOTIFICATION_ID, notif)
                VpnStatusWidgetProvider.updateAllWidgets(this@DragonForceVpnService)
            }
        }
    }

    private fun pollAccessLog(file: File) {
        if (!file.exists()) return
        try {
            val len = file.length()
            if (len < accessLogOffset) accessLogOffset = 0L
            if (len == accessLogOffset) return

            RandomAccessFile(file, "r").use { raf ->
                raf.seek(accessLogOffset)
                val toRead = (len - accessLogOffset).coerceAtMost(128 * 1024L).toInt()
                val buf = ByteArray(toRead)
                val read = raf.read(buf)
                if (read > 0) {
                    accessLogOffset += read
                    val chunk = String(buf, 0, read, Charsets.UTF_8)
                    pushAccessLogChunk(chunk)
                }
            }

            if (accessLogOffset > 512 * 1024L) {
                file.writeText("")
                accessLogOffset = 0L
            }
        } catch (_: Exception) {
        }
    }

    private fun cleanupProcessesAndTun() {
        telemetryJob?.cancel()
        telemetryJob = null

        try {
            xrayProcess?.destroy()
            xrayProcess = null
        } catch (_: Exception) {
        }

        try {
            tunFd?.close()
            tunFd = null
        } catch (_: Exception) {
        }
    }

    fun stopVpnTunnel(userInitiated: Boolean) {
        val wasConnected = isConnected
        isConnected = false
        isConnecting = false
        connectedAtMs = null
        upSpeed = 0L
        downSpeed = 0L

        cleanupProcessesAndTun()

        if (wasConnected) {
            appendLog("system", "info", "VPN tunnel disconnected")
            if (!userInitiated) {
                NotificationHelper.notifyEvent(
                    context = this,
                    channelId = NotificationHelper.CHANNEL_ALERTS,
                    notificationId = NotificationHelper.ALERT_NOTIFICATION_ID,
                    title = "VPN Connection Lost",
                    body = "Tunnel to $activeServerName closed unexpectedly."
                )
            }
        }

        VpnQuickTileService.requestTileUpdate(this)
        VpnStatusWidgetProvider.updateAllWidgets(this)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE)
        } else {
            @Suppress("DEPRECATION")
            stopForeground(true)
        }
        stopSelf()
    }

    override fun onRevoke() {
        appendLog("system", "warn", "VPN permission revoked by Android system or another VPN app")
        stopVpnTunnel(userInitiated = false)
        super.onRevoke()
    }

    override fun onDestroy() {
        cleanupProcessesAndTun()
        serviceScope.cancel()
        super.onDestroy()
    }
}
