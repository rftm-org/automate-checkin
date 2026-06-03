# Automate Checkin

Private GitHub Actions runner for the Hoyolab Genshin Impact daily check-in.

The runner does not store a Hoyolab password. It uses a Playwright `storageState` generated after a manual login, then restores that state in GitHub Actions from an encrypted repository secret.

## Scripts

```powershell
npm run auth       # Manual login flow, saves .auth/hoyolab-storage-state.json
npm run auth:cdp   # Optional local export from browser-harness agent Chrome on port 9223
npm run checkin    # Runs the check-in
npm run checkin:dry
npm run verify
```

No local web server is used, so this project does not need `localhost:3000` or any other port.

## Local Setup

```powershell
npm install
npx playwright install chromium
```

Generate an authenticated state file:

```powershell
npm run auth
```

Alternative, if `browser-harness` agent Chrome is already authenticated on Hoyolab:

```powershell
& "C:\Users\<user-name>\.agents\skills\browser-harness\scripts\start-agent-chrome.ps1" -PersistEnv
npm run auth:cdp
```

Run a local dry-run:

```powershell
npm run checkin:dry
```

Run the real local check-in:

```powershell
npm run checkin
```

If the reward was already collected for the day, the script should not click anything. It saves a proof screenshot and exits successfully.

## GitHub Secret

Encode `.auth/hoyolab-storage-state.json` and save it as an Actions secret named `HOYOLAB_STORAGE_STATE_B64`.

PowerShell helper:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes(".auth/hoyolab-storage-state.json")) | Set-Clipboard
```

In GitHub:

1. Open the private repository.
2. Go to `Settings` -> `Secrets and variables` -> `Actions`.
3. Create repository secret `HOYOLAB_STORAGE_STATE_B64`.
4. Paste the clipboard value.

## Schedule

The workflow runs daily at `09:15 Europe/Paris`:

```yaml
schedule:
  - cron: "15 9 * * *"
    timezone: "Europe/Paris"
```

There is also `workflow_dispatch` for manual runs.

## Artifacts

Each run uploads proof screenshots from:

```text
output/proofs/*.png
```

Successful runs are intentionally quiet. Failures appear in GitHub Actions logs, and any failure screenshot is uploaded as an artifact when available.

## Session Expiry

If Hoyolab expires the session or asks for CAPTCHA/manual verification:

1. Run `npm run auth` locally.
2. Log in manually.
3. Re-encode `.auth/hoyolab-storage-state.json`.
4. Update the GitHub secret `HOYOLAB_STORAGE_STATE_B64`.
5. Re-run the workflow manually.

Do not store Hoyolab email/password secrets for automated login.
