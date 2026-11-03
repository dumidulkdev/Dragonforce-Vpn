package com.dragonforce.vpn

import android.app.PendingIntent
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Build
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService
import androidx.annotation.RequiresApi

/**
 * Android Quick Settings Tile ("DragonForce VPN") in the notification shade for 1-tap
 * connect/disconnect without opening the main app.
 */
@RequiresApi(Build.VERSION_CODES.N)
class VpnQuickTileService : TileService() {

    companion object {
        fun requestTileUpdate(context: Context) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                try {
                    requestListeningState(
                        context,
                        ComponentName(context, VpnQuickTileService::class.java)
                    )
                } catch (_: Exception) {
                }
            }
        }
    }

    override fun onStartListening() {
        super.onStartListening()
        syncTileState()
    }

    override fun onClick() {
        super.onClick()
        if (DragonForceVpnService.isConnected || DragonForceVpnService.isConnecting) {
            val stopIntent = Intent(this, DragonForceVpnService::class.java).apply {
                action = DragonForceVpnService.ACTION_STOP
            }
            startService(stopIntent)
            syncTileState(forceState = Tile.STATE_INACTIVE)
        } else {
            val launchIntent = Intent(this, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
                putExtra("quickConnect", true)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                val pending = PendingIntent.getActivity(
                    this,
                    20,
                    launchIntent,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
                )
                startActivityAndCollapse(pending)
            } else {
                @Suppress("DEPRECATION")
                startActivityAndCollapse(launchIntent)
            }
        }
    }

    private fun syncTileState(forceState: Int? = null) {
        val tile = qsTile ?: return
        val connected = DragonForceVpnService.isConnected
        val connecting = DragonForceVpnService.isConnecting

        tile.state = forceState ?: when {
            connected || connecting -> Tile.STATE_ACTIVE
            else -> Tile.STATE_INACTIVE
        }

        tile.label = getString(R.string.qs_tile_label)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            tile.subtitle = when {
                connected -> DragonForceVpnService.activeServerName
                connecting -> "Connecting..."
                else -> "Disconnected"
            }
        }
        tile.updateTile()
    }
}
