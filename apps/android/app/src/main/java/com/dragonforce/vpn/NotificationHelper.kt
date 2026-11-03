package com.dragonforce.vpn

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat

/**
 * Manages all 4 Android notification channels and builds rich notifications for:
 *  1. Persistent Foreground VPN Status (live speeds, session duration, Disconnect / Switch Server buttons)
 *  2. Connection & Data Cap Alerts (Connected, Disconnected, Connection Lost, Failed, Data Cap 80% / 100%)
 *  3. Subscription Updates (node counts added/updated)
 *  4. Usage & Privacy Shield Insights (weekly summary & milestone badges)
 */
object NotificationHelper {

    const val CHANNEL_STATUS = "vpn_status"
    const val CHANNEL_ALERTS = "vpn_alerts"
    const val CHANNEL_SUBSCRIPTIONS = "vpn_subscriptions"
    const val CHANNEL_INSIGHTS = "vpn_insights"

    const val FOREGROUND_NOTIFICATION_ID = 1001
    const val ALERT_NOTIFICATION_ID = 2001
    const val DATA_CAP_NOTIFICATION_ID = 2002
    const val SUBSCRIPTION_NOTIFICATION_ID = 3001
    const val INSIGHT_NOTIFICATION_ID = 4001

    fun ensureChannels(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

        val statusChannel = NotificationChannel(
            CHANNEL_STATUS,
            context.getString(R.string.notif_channel_status),
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = "Ongoing DragonForce VPN connection status and live throughput"
            setShowBadge(false)
        }

        val alertsChannel = NotificationChannel(
            CHANNEL_ALERTS,
            context.getString(R.string.notif_channel_alerts),
            NotificationManager.IMPORTANCE_HIGH
        ).apply {
            description = "Alerts for unexpected disconnects, connection failures, and data cap limits"
            enableVibration(true)
        }

        val subsChannel = NotificationChannel(
            CHANNEL_SUBSCRIPTIONS,
            context.getString(R.string.notif_channel_subs),
            NotificationManager.IMPORTANCE_DEFAULT
        ).apply {
            description = "Notifications when subscription feeds refresh"
        }

        val insightsChannel = NotificationChannel(
            CHANNEL_INSIGHTS,
            context.getString(R.string.notif_channel_insights),
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = "Privacy Shield milestones and weekly bandwidth summaries"
        }

        nm.createNotificationChannels(
            listOf(statusChannel, alertsChannel, subsChannel, insightsChannel)
        )
    }

    fun buildForegroundNotification(
        context: Context,
        serverName: String,
        protocol: String,
        upSpeedBytes: Long,
        downSpeedBytes: Long,
        sessionUpBytes: Long,
        sessionDownBytes: Long,
        connectedAtMs: Long
    ): Notification {
        ensureChannels(context)

        val openAppIntent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val openPending = PendingIntent.getActivity(
            context,
            0,
            openAppIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val disconnectIntent = Intent(context, VpnActionReceiver::class.java).apply {
            action = VpnActionReceiver.ACTION_DISCONNECT
        }
        val disconnectPending = PendingIntent.getBroadcast(
            context,
            1,
            disconnectIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val switchIntent = Intent(context, VpnActionReceiver::class.java).apply {
            action = VpnActionReceiver.ACTION_SWITCH_SERVER
        }
        val switchPending = PendingIntent.getBroadcast(
            context,
            2,
            switchIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val title = "Connected • $serverName (${protocol.uppercase()})"
        val content = "↓ ${formatRate(downSpeedBytes)}   ↑ ${formatRate(upSpeedBytes)}   •   Total ${formatBytes(sessionDownBytes + sessionUpBytes)}"

        return NotificationCompat.Builder(context, CHANNEL_STATUS)
            .setSmallIcon(R.drawable.ic_qs_shield)
            .setContentTitle(title)
            .setContentText(content)
            .setSubText("TUN Protected")
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setUsesChronometer(true)
            .setWhen(connectedAtMs)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setContentIntent(openPending)
            .addAction(0, "Disconnect", disconnectPending)
            .addAction(0, "Switch Server", switchPending)
            .build()
    }

    fun notifyEvent(
        context: Context,
        channelId: String,
        notificationId: Int,
        title: String,
        body: String
    ) {
        ensureChannels(context)
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

        val openAppIntent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val openPending = PendingIntent.getActivity(
            context,
            notificationId,
            openAppIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val priority = if (channelId == CHANNEL_ALERTS) {
            NotificationCompat.PRIORITY_HIGH
        } else {
            NotificationCompat.PRIORITY_DEFAULT
        }

        val notification = NotificationCompat.Builder(context, channelId)
            .setSmallIcon(R.drawable.ic_qs_shield)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(priority)
            .setAutoCancel(true)
            .setContentIntent(openPending)
            .build()

        nm.notify(notificationId, notification)
    }

    fun formatBytes(bytes: Long): String {
        if (bytes < 1024L) return "$bytes B"
        val kb = bytes / 1024.0
        if (kb < 1024.0) return String.format("%.1f KB", kb)
        val mb = kb / 1024.0
        if (mb < 1024.0) return String.format("%.1f MB", mb)
        val gb = mb / 1024.0
        return String.format("%.2f GB", gb)
    }

    fun formatRate(bytesPerSec: Long): String = "${formatBytes(bytesPerSec)}/s"
}
