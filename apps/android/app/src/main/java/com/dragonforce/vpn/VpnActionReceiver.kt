package com.dragonforce.vpn

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Handles action buttons inside the persistent VPN foreground notification and Home Screen Widget:
 *  - Disconnect (`ACTION_DISCONNECT`)
 *  - Switch Server (`ACTION_SWITCH_SERVER`)
 *  - 1-Tap Toggle (`ACTION_TOGGLE_VPN`)
 */
class VpnActionReceiver : BroadcastReceiver() {

    companion object {
        const val ACTION_DISCONNECT = "com.dragonforce.vpn.ACTION_DISCONNECT"
        const val ACTION_SWITCH_SERVER = "com.dragonforce.vpn.ACTION_SWITCH_SERVER"
        const val ACTION_TOGGLE_VPN = "com.dragonforce.vpn.ACTION_TOGGLE_VPN"
    }

    override fun onReceive(context: Context, intent: Intent?) {
        when (intent?.action) {
            ACTION_DISCONNECT -> {
                val stopIntent = Intent(context, DragonForceVpnService::class.java).apply {
                    action = DragonForceVpnService.ACTION_STOP
                }
                context.startService(stopIntent)
            }
            ACTION_SWITCH_SERVER -> {
                val openIntent = Intent(context, MainActivity::class.java).apply {
                    flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
                    putExtra("navigateView", "servers")
                }
                context.startActivity(openIntent)
            }
            ACTION_TOGGLE_VPN -> {
                if (DragonForceVpnService.isConnected || DragonForceVpnService.isConnecting) {
                    val stopIntent = Intent(context, DragonForceVpnService::class.java).apply {
                        action = DragonForceVpnService.ACTION_STOP
                    }
                    context.startService(stopIntent)
                } else {
                    val openIntent = Intent(context, MainActivity::class.java).apply {
                        flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
                        putExtra("quickConnect", true)
                    }
                    context.startActivity(openIntent)
                }
            }
        }
    }
}
