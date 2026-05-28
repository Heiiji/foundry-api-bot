# Foundry REST Bridge Headless Client

This Node.js app keeps a real Foundry VTT browser client connected in headless Chromium. It is for REST bridge modules such as `foundryvtt-rest-api`, where the relay only works while a Foundry client is connected to the world.

This app does not expose a REST API by itself. It logs into Foundry as a dedicated user, keeps the session alive, verifies the Foundry module is active, and can optionally verify that the REST relay sees the connected client.

## Before You Start

You need:

- Foundry VTT already running on the server.
- Your target world auto-loaded, usually with Foundry's `--world=<world-id>`.
- A dedicated Foundry user, usually a GM user named `api-bot`.
- Node.js 20 or newer.
- The ThreeHats REST relay/module flow already configured.

ThreeHats reference links:

- Relay/API repo: [ThreeHats/foundryvtt-rest-api-relay](https://github.com/ThreeHats/foundryvtt-rest-api-relay)
- Foundry module manifest: `https://github.com/ThreeHats/foundryvtt-rest-api/releases/latest/download/module.json`
- Relay check endpoint: `GET /clients` with the `x-api-key` header

The relay can be public or self-hosted. The Foundry module connects to the relay over WebSocket, and your external tools call the relay over REST.

## Quick Test Over SSH

```bash
git clone git@github.com:Heiiji/foundry-api-bot.git
cd foundry-api-bot
npm ci
npm run install-browser-with-deps
npm run setup     # guided, asks for URL / user / password
npm run doctor
npm start
```

`npm run setup` walks you through the required settings and writes a private
`.env` for you (permissions `600`), so you do not have to edit it by hand. If
you run `npm start` before any `.env` exists, it offers the same guided setup.
To edit settings later, re-run `npm run setup` or open `.env` in an editor.

HTTPS clone fallback:

```bash
git clone https://github.com/Heiiji/foundry-api-bot.git
```

On non-Debian/Ubuntu servers, `npm run install-browser-with-deps` may not be supported. Use `npm run install-browser`, then install any missing Chromium libraries using your distro's package manager.

You are done when the logs show `Foundry world is ready` and this command shows `"ok": true`:

```bash
cat data/status.json
```

Expected healthy fields:

```json
{
  "ok": true,
  "state": "ready",
  "user": "api-bot",
  "userIsGM": true,
  "moduleActive": true,
  "socketConnected": true
}
```

## Configure `.env`

The easiest way is `npm run setup`. The rest of this section explains the values
it asks for, in case you prefer to edit `.env` directly.

Required values:

```bash
FOUNDRY_URL=http://127.0.0.1:30000
FOUNDRY_USER=api-bot
FOUNDRY_PASSWORD=your-foundry-user-password
CHECK_MODULE_ID=foundryvtt-rest-api
```

If the bot runs on the same server as Foundry, prefer `http://127.0.0.1:30000`. Use your public HTTPS URL only when the local URL does not reach the same Foundry instance.

Optional relay verification:

```bash
REST_RELAY_URL=http://127.0.0.1:3010
REST_RELAY_API_KEY=your-relay-api-key
REST_RELAY_CLIENT_ID=
```

Use the relay's HTTP(S) base URL here. If your module setting uses `ws://localhost:3010`, set `REST_RELAY_URL=http://127.0.0.1:3010`. If your module setting uses `wss://foundryrestapi.com`, set `REST_RELAY_URL=https://foundryrestapi.com`.

When relay verification is configured, the bot reports `/clients` failures as unhealthy in `status.json`, but a relay outage on its own does **not** reload the Foundry browser (reloading Foundry cannot fix a down relay). Only after `RELAY_RELOAD_AFTER_FAILURES` consecutive misses does it reload once, in case the relay restarted and dropped the websocket client. If `REST_RELAY_CLIENT_ID` is empty, at least one connected client is enough. If it is set, the `/clients` response must contain that id.

## Reliability Behavior

A few things the bot does to stay healthy unattended:

- **Right-user check.** After login it verifies the connected user matches `FOUNDRY_USER`. If not (for example a stale saved session), it reports `wrong-user` and tells you to fix `FOUNDRY_USER` or delete `USER_DATA_DIR`, rather than running as the wrong account.
- **Browser recycle.** By default it cleanly restarts the headless browser every `RESTART_AFTER_HOURS` hours (24) to avoid slow memory growth over long runs. Set `RESTART_AFTER_HOURS=0` to disable.
- **Backoff and recovery.** Transient Foundry failures trigger a page reload after `RELOAD_AFTER_FAILURES`, and full session failures restart the browser with capped exponential backoff.

## Run As A systemd Service

The service example assumes:

- App path: `/opt/foundry-api-bot`
- Service user: `foundry`
- State path: `/var/lib/foundry-api-bot`
- Env file: `/etc/foundry-api-bot/env`

Install:

```bash
sudo useradd --system --create-home --shell /usr/sbin/nologin foundry || true
sudo install -d -o foundry -g foundry /var/lib/foundry-api-bot
sudo install -d -o root -g foundry /etc/foundry-api-bot

cd ~
git clone git@github.com:Heiiji/foundry-api-bot.git
sudo mv foundry-api-bot /opt/foundry-api-bot
sudo chown -R foundry:foundry /opt/foundry-api-bot /var/lib/foundry-api-bot

cd /opt/foundry-api-bot
sudo -u foundry npm ci
sudo env PLAYWRIGHT_BROWSERS_PATH=/var/lib/foundry-api-bot/ms-playwright ./node_modules/.bin/playwright install --with-deps chromium
sudo chown -R foundry:foundry /var/lib/foundry-api-bot

sudo cp deploy/foundry-api-bot.env.example /etc/foundry-api-bot/env
sudo nano /etc/foundry-api-bot/env
sudo chown root:foundry /etc/foundry-api-bot/env
sudo chmod 640 /etc/foundry-api-bot/env

sudo cp deploy/foundry-api-bot.service.example /etc/systemd/system/foundry-api-bot.service
sudo systemctl daemon-reload
sudo systemctl enable --now foundry-api-bot
journalctl -u foundry-api-bot -f
```

If your Foundry service is not named `foundryvtt.service`, leave the dependency lines commented in the service file or replace them with your real Foundry unit name.

Do not run Chromium as root. Only set `CHROMIUM_NO_SANDBOX=true` if you understand the risk and cannot run the service as a normal user.

## Health Checks

The bot writes its latest status to `STATUS_FILE`.

Manual check:

```bash
npm run health
```

With systemd:

```bash
sudo -u foundry env STATUS_FILE=/var/lib/foundry-api-bot/status.json /usr/bin/node /opt/foundry-api-bot/src/foundry-bot.js --health
```

The health command fails if the status file is stale or the latest status is not `ok`.

## Troubleshooting

Run:

```bash
npm run doctor
```

`doctor` checks config, write permissions, relay verification when configured, Playwright installation, and whether Chromium can launch.

Common issues:

- Foundry is running, but no world is loaded. Start Foundry with `--world=<world-id>`.
- The bot user is not a GM. Many bridge modules are GM-only.
- `CHECK_MODULE_ID` is wrong or the module is not enabled in the world.
- The relay URL is the WebSocket URL. For this bot, use the HTTP(S) REST URL.
- Chromium dependencies are missing. On Debian/Ubuntu, run `npm run install-browser-with-deps`.

If the bot cannot log in, check screenshots in `ARTIFACTS_DIR`. They may contain private world data, so handle them like secrets.

## Security Notes

Treat `.env` and `/etc/foundry-api-bot/env` as secrets because they contain a Foundry user password and possibly a relay API key.

Recommended setup:

- A dedicated GM bot user in Foundry.
- Foundry reached locally by the bot at `http://127.0.0.1:30000`.
- REST relay protected by API key and normal network controls.
- Env files owned by root or the service user and not world-readable.
- Status and screenshot directories readable only by the service user.
