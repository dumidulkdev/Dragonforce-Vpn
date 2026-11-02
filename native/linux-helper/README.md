# DragonForce Linux network helper

This helper is the only DragonForce component that runs with elevated privileges. It owns the Linux TUN interface and exact routes recorded in `/run/dragonforce-vpn/session.json`. Electron, the controller, Xray, and tun2socks remain unprivileged.

Build from the repository root:

```bash
npm run build:linux-helper
```

For manual testing, an administrator must install the generated files with root ownership:

```bash
sudo install -D -o root -g root -m 0755 build/linux/dragonforce-net-helper /usr/lib/dragonforce-vpn/dragonforce-net-helper
sudo install -D -o root -g root -m 0644 build/linux/com.dragonforce.vpn.network.policy /usr/share/polkit-1/actions/com.dragonforce.vpn.network.policy
```

Never authorize or install a helper directly from a user-writable project or download directory. Rebuild it, inspect it, and install the resulting binary under `/usr/lib/dragonforce-vpn/`.
