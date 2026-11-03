package com.dragonforce.vpn

import java.net.InetSocketAddress
import java.net.Socket
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.cert.X509Certificate
import javax.net.ssl.SNIHostName
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLParameters
import javax.net.ssl.SSLSocket
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager

/**
 * Extracts the leaf TLS certificate SHA-256 fingerprint (lowercase hex) from a
 * target server endpoint so Xray-core 26.10.31+ can pin self-signed or mismatched
 * certificates via `pinnedPeerCertSha256` (since `allowInsecure` was removed in Xray 26).
 */
object TlsCertPinner {

    private val trustAllManager = object : X509TrustManager {
        override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {}
        override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {}
        override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
    }

    fun fetchLeafCertSha256(
        host: String,
        port: Int,
        sni: String?,
        timeoutMs: Int = 6000
    ): String {
        val sslContext = SSLContext.getInstance("TLS")
        sslContext.init(null, arrayOf<TrustManager>(trustAllManager), SecureRandom())

        val rawSocket = Socket()
        try {
            rawSocket.connect(InetSocketAddress(host, port), timeoutMs)
            rawSocket.soTimeout = timeoutMs

            val factory = sslContext.socketFactory
            val peerHost = (sni?.takeIf { it.isNotBlank() } ?: host).trim()
            val sslSocket = factory.createSocket(rawSocket, peerHost, port, true) as SSLSocket

            val params: SSLParameters = sslSocket.sslParameters
            if (peerHost.isNotEmpty() && !peerHost.matches(Regex("^[0-9.:]+$"))) {
                try {
                    params.serverNames = listOf(SNIHostName(peerHost))
                    sslSocket.sslParameters = params
                } catch (_: IllegalArgumentException) {
                    // Ignore invalid SNI literal
                }
            }

            sslSocket.startHandshake()
            val certs = sslSocket.session.peerCertificates
            if (certs.isEmpty()) {
                throw IllegalStateException("Server did not present any TLS certificates")
            }

            val leaf = certs[0] as X509Certificate
            val digest = MessageDigest.getInstance("SHA-256").digest(leaf.encoded)
            return digest.joinToString("") { "%02x".format(it) }
        } finally {
            try {
                rawSocket.close()
            } catch (_: Exception) {
            }
        }
    }
}
