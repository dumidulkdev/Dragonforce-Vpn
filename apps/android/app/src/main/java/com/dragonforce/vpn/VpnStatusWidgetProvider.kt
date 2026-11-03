package com.dragonforce.vpn

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.widget.RemoteViews

/**
 * 4x2 Home Screen Widget displaying DragonForce VPN connection status, active server name,
 * live throughput speeds (`↓ / ↑`), and a 1-tap Connect / Disconnect button.
 */
class VpnStatusWidgetProvider : AppWidgetProvider() {

    companion object {
        fun updateAllWidgets(context: Context) {
            val manager = AppWidgetManager.getInstance(context)
            val ids = manager.getAppWidgetIds(
                ComponentName(context, VpnStatusWidgetProvider::class.java)
            )
            if (ids.isNotEmpty()) {
                for (id in ids) {
                    updateSingleWidget(context, manager, id)
                }
            }
        }

        private fun updateSingleWidget(
            context: Context,
            manager: AppWidgetManager,
            appWidgetId: Int
        ) {
            val views = RemoteViews(context.packageName, R.layout.widget_vpn_status)
            val connected = DragonForceVpnService.isConnected
            val connecting = DragonForceVpnService.isConnecting

            val statusText = when {
                connected -> "DragonForce VPN • Connected"
                connecting -> "DragonForce VPN • Connecting..."
                else -> "DragonForce VPN • Disconnected"
            }

            val serverText = when {
                connected -> "${DragonForceVpnService.activeServerName} (${DragonForceVpnService.activeProtocol.uppercase()})"
                connecting -> "Establishing encrypted TUN..."
                else -> "Tap Connect to secure your traffic"
            }

            val speedText = if (connected) {
                "↓ ${NotificationHelper.formatRate(DragonForceVpnService.downSpeed)}   ↑ ${NotificationHelper.formatRate(DragonForceVpnService.upSpeed)}"
            } else {
                "Ad Shield & Smart Split Tunnel ready"
            }

            views.setTextViewText(R.id.widget_status_title, statusText)
            views.setTextViewText(R.id.widget_server_name, serverText)
            views.setTextViewText(R.id.widget_traffic_stats, speedText)
            views.setTextViewText(
                R.id.widget_toggle_btn,
                if (connected || connecting) "Disconnect" else "Connect"
            )

            val toggleIntent = Intent(context, VpnActionReceiver::class.java).apply {
                action = VpnActionReceiver.ACTION_TOGGLE_VPN
            }
            val togglePending = PendingIntent.getBroadcast(
                context,
                10,
                toggleIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
            views.setOnClickPendingIntent(R.id.widget_toggle_btn, togglePending)

            val openIntent = Intent(context, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
            }
            val openPending = PendingIntent.getActivity(
                context,
                11,
                openIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
            views.setOnClickPendingIntent(R.id.widget_root, openPending)

            manager.updateAppWidget(appWidgetId, views)
        }
    }

    override fun onUpdate(
        context: Context,
        appWidgetManager: AppWidgetManager,
        appWidgetIds: IntArray
    ) {
        for (id in appWidgetIds) {
            updateSingleWidget(context, appWidgetManager, id)
        }
    }
}
