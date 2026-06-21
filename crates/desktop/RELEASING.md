# Releasing HoneyHub desktop (auto-update)

The desktop app self-updates via Tauri's updater: on launch it checks a signed release manifest
(`latest.json`) and, if a newer **signed** build exists, asks to install + relaunch. Updates are
signature-verified, so only builds signed with our private key install.

## One-time setup (operator)

1. **Generate a signing keypair** (do this once; keep the private key safe):
   ```sh
   npx @tauri-apps/cli signer generate -w honeyhub.key
   # prints a PUBLIC KEY and writes the private key to honeyhub.key (+ asks for a password)
   ```
   Never commit `honeyhub.key`.

2. **Add the public key** to [`tauri.conf.json`](./tauri.conf.json) → `plugins.updater.pubkey`,
   replacing `REPLACE_WITH_TAURI_UPDATER_PUBLIC_KEY`. Commit it.

3. **Add repo secrets** (Settings → Secrets and variables → Actions):
   - `TAURI_SIGNING_PRIVATE_KEY` — the contents of `honeyhub.key`
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — the password (empty string if you set none)

The updater endpoint is already set to this repo's GitHub Releases:
`https://github.com/HoneyDrunkStudios/HoneyDrunk.HoneyHub/releases/latest/download/latest.json`.
(Change it in `tauri.conf.json` if you host the manifest elsewhere, e.g. Cloudflare.)

## Cutting a release

1. Bump `version` in `tauri.conf.json` (and keep the cargo/npm versions in step per the usual
   release process).
2. Tag and push:
   ```sh
   git tag honeyhub-desktop-v<version>
   git push origin honeyhub-desktop-v<version>
   ```
3. The [`release`](../../.github/workflows/release.yml) workflow builds + signs the macOS / Linux
   / Windows bundles and creates a **draft** GitHub Release with the installers + `latest.json`.
4. **Publish** the draft. `releases/latest` only resolves to a published, non-prerelease release,
   so the updater won't see it until you publish.

Installed apps then pick it up on their next launch.

## Notes
- Until steps 1–3 are done, the launch-time check is a no-op (best-effort) — the app runs fine,
  it just never finds an update.
- The served PWA (bridge-host in a browser) updates separately, by shipping new static assets;
  this updater is only for the packaged native app.
- Pin `tauri-apps/tauri-action@v0` to a commit SHA before merge to match the repo's action policy.
