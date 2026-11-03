# Keep DragonForce VPN native bridge and JNI entrypoints
-keep class com.dragonforce.vpn.** { *; }
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
-dontwarn libv2ray.**
