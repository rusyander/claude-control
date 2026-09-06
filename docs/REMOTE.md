# Access from a phone

The same panel and the same user on a phone: Tailscale Serve, one token, the app or a browser.

🇷🇺 [Русская версия](REMOTE.ru.md) · 🔧 [Setup](SETUP.md) · 🛠 [Troubleshooting](TROUBLESHOOTING.md) · 🔒 [Security](SECURITY.md)

---

## Access from a phone

The `apps/mobile` app talks to the same panel over the same API. Nothing is published to the
internet: the server keeps listening on `127.0.0.1`, and the tunnel terminates on this machine and
proxies to loopback.

Four steps, the first of which is off by default:

1. **Settings → Remote access → enable.** The panel issues a token and shows it as a QR code. The
   token is visible exactly once — the API never returns it again, and "Rotate token" revokes the
   old one together with every paired device.
2. **`pnpm remote`** — raises Tailscale Serve in front of the API and prints an address like
   `https://<machine>.<tail>.ts.net`. `pnpm remote:off` takes it down.
3. **Pair the phone**: in the app, Settings → Pair, point the camera at the QR. By hand — the same
   address and the same token in two fields.
4. **`pnpm mobile`** — builds and installs the app on a connected phone or emulator (needs the
   Android Studio SDK or Xcode). For installing by hand there is `pnpm mobile:apk`: it puts
   `claude-control.apk` in the repository root, replacing the previous one. Android 12 or newer.

What the panel cannot do for you:

- **Tailscale installed and logged into your own account**, with HTTPS certificates enabled for the
  tailnet. Without Tailscale the panel says plainly that it has no address rather than inventing
  one. The phone must be on the same tailnet.
- **Push notifications need `eas init` under your Expo account and a Firebase (FCM) project.** Until
  then the app states this on screen; it still tells you a run finished with a local notification
  while it is alive in the background.

Checking without a phone:

```bash
curl -H "Authorization: Bearer <token>" http://127.0.0.1:5178/api/system   # 200
curl http://127.0.0.1:5178/api/system                                      # 401 while access is on
```

A 401 with the right token is almost always a space or a newline that came along when the token was
copied.

The tailnet address belongs to the MACHINE: a reboot, restarting the client, switching from Wi-Fi to
mobile data leave it as it was — no re-pairing. It changes only if the machine is removed from the
tailnet or renamed.

**Builds take disk — and clean up after themselves.** Gradle puts each native library's object files
inside the library itself, in `node_modules/<package>/android/build` and `.cxx`: one release build is
about 10 GB, and none of it reaches the APK. So `pnpm mobile:apk` wipes them the moment the APK lands
in the repository root; building several times in a row, use `pnpm mobile:apk --keep-build` for a
faster rebuild. Left over from an interrupted build — `pnpm mobile:clean` (`--dry` measures without
deleting), and `pnpm doctor` warns on its own once more than 2 GB has piled up.
