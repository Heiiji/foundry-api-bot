#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const APP_ROOT = path.resolve(__dirname, "..");
const DEFAULT_ENV_FILE = path.join(APP_ROOT, ".env");

process.umask(0o077);
loadDotEnv(DEFAULT_ENV_FILE);

let activeContext = null;
let shuttingDown = false;
let config = null;

bootstrap().catch((error) => {
  log("error", "Fatal startup failure.", { error: error.message });
  process.exit(1);
});

async function bootstrap() {
  const wantsDoctor = process.argv.includes("--doctor");
  const wantsHealth = process.argv.includes("--health");
  const wantsSetup = process.argv.includes("--setup");

  if (wantsSetup) {
    const created = await runSetup();
    process.exit(created ? 0 : 1);
  }

  // First run with no config and a real terminal: walk the user through setup
  // instead of failing with a wall of "missing variable" errors.
  if (!wantsDoctor && !wantsHealth && shouldAutoSetup()) {
    log("info", "No .env file found. Starting guided setup.");
    const created = await runSetup();
    if (!created) process.exit(1);
    loadDotEnv(DEFAULT_ENV_FILE);
  }

  config = readConfig();

  if (wantsDoctor) {
    const ok = await runDoctor();
    process.exit(ok ? 0 : 1);
  }

  if (wantsHealth) {
    const ok = runHealthCheck();
    process.exit(ok ? 0 : 1);
  }

  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));

  await main();
}

function shouldAutoSetup() {
  return !fs.existsSync(DEFAULT_ENV_FILE) && Boolean(process.stdin.isTTY);
}

async function main() {
  validateConfig();

  let restartAttempt = 0;
  while (!shuttingDown) {
    let context = null;
    try {
      restartAttempt += 1;
      context = await openBrowserContext();
      activeContext = context;

      const page = await getPrimaryPage(context);
      wirePageLogging(page);

      await connectToFoundry(page);
      restartAttempt = 0;

      // monitorConnection returns either on shutdown or for a planned recycle.
      await monitorConnection(page);

      if (!shuttingDown) {
        log("info", "Recycling browser session.");
        await closeQuietly(context);
        activeContext = null;
      }
    } catch (error) {
      if (shuttingDown) break;

      log("error", "Bot session failed.", { error: error.message });
      await writeStatus({ state: "session-failed", ok: false, error: error.message });

      if (context) {
        await closeQuietly(context);
        activeContext = null;
      }

      const delayMs = Math.min(60000, 5000 * Math.max(1, restartAttempt));
      log("info", `Restarting browser in ${Math.round(delayMs / 1000)} seconds.`);
      await sleep(delayMs);
    }
  }
}

async function openBrowserContext() {
  const { chromium } = loadPlaywright();
  fs.mkdirSync(config.userDataDir, { recursive: true, mode: 0o700 });

  const args = ["--disable-dev-shm-usage"];
  if (config.noSandbox) args.push("--no-sandbox");

  log("info", "Starting Chromium.", {
    headless: config.headless,
    profile: config.userDataDir
  });

  return chromium.launchPersistentContext(config.userDataDir, {
    headless: config.headless,
    viewport: { width: 1280, height: 800 },
    ignoreHTTPSErrors: config.ignoreHTTPSErrors,
    args
  });
}

async function getPrimaryPage(context) {
  const pages = context.pages();
  return pages[0] || context.newPage();
}

function wirePageLogging(page) {
  page.on("console", (message) => {
    const type = message.type();
    if (type === "error" || type === "warning") {
      log(type === "error" ? "error" : "warn", `Browser ${type}: ${message.text()}`);
    }
  });

  page.on("pageerror", (error) => {
    log("error", "Browser page error.", { error: error.message });
  });

  page.on("crash", () => {
    log("error", "Browser page crashed.");
  });
}

async function connectToFoundry(page) {
  log("info", "Opening Foundry.", { url: config.foundryUrl });
  await gotoFoundry(page);
  await loginIfNeeded(page);

  const status = await waitForFoundryReady(page, config.worldReadyTimeoutMs);
  await writeStatus(status);

  logReadyStatus(status);
}

async function monitorConnection(page) {
  const sessionStart = Date.now();
  let failures = 0;
  let relayFailures = 0;
  let lastHeartbeatAt = 0;
  let warnedModule = false;
  let warnedGm = false;
  let warnedRelay = false;
  let warnedWrongUser = false;

  while (!shuttingDown) {
    const status = await getFullStatus(page);

    await writeStatus(status);

    // Foundry itself is connected and the right user is logged in.
    if (status.foundryOk) {
      failures = 0;
      warnedWrongUser = false;

      const now = Date.now();
      if (now - lastHeartbeatAt > 5 * 60 * 1000) {
        lastHeartbeatAt = now;
        log("info", "Foundry session is alive.", summarizeStatus(status));
      }

      if (config.moduleId && status.moduleActive === false && !warnedModule) {
        warnedModule = true;
        log("warn", "Configured module is not active in this world.", {
          moduleId: config.moduleId
        });
      }

      if (config.requireGm && status.userIsGM === false && !warnedGm) {
        warnedGm = true;
        log("warn", "Connected user is not a GM. REST bridge modules often require GM access.", {
          user: status.user
        });
      }

      // A relay outage does not mean Foundry is broken, so it must not churn the
      // browser. Warn, and only after many consecutive misses nudge the websocket
      // with a single reload in case the relay restarted and dropped our client.
      if (status.relay && status.relay.configured && status.relay.ok === false) {
        relayFailures += 1;
        if (!warnedRelay) {
          warnedRelay = true;
          log("warn", "Foundry is connected but the REST relay does not see this client.", status.relay);
        }
        if (relayFailures >= config.relayReloadAfterFailures) {
          log("info", `Relay still cannot see this client after ${relayFailures} checks; reloading Foundry to re-register the websocket.`);
          await recoverPage(page, status);
          relayFailures = 0;
          warnedRelay = false;
        }
      } else {
        relayFailures = 0;
        warnedRelay = false;
      }

      if (shouldRecycle(sessionStart)) {
        log("info", `Session reached ${config.restartAfterHours}h; recycling the browser to stay reliable.`);
        return;
      }

      await sleep(config.checkIntervalMs);
      continue;
    }

    // Wrong user is a configuration problem the bot cannot fix by reloading, so
    // surface it loudly and keep checking without thrashing the browser.
    if (status.state === "wrong-user") {
      if (!warnedWrongUser) {
        warnedWrongUser = true;
        log("error", `Connected as "${status.user}" but FOUNDRY_USER is "${config.userName}". The bot cannot fix this automatically: correct FOUNDRY_USER, or reset the saved session by deleting ${config.userDataDir}.`);
      }
      await sleep(config.checkIntervalMs);
      continue;
    }

    failures += 1;
    log("warn", `Foundry is not ready (${status.state || "unknown"}), failure ${failures}/${config.reloadAfterFailures}.`);

    if (failures >= config.reloadAfterFailures) {
      await recoverPage(page, status);
      failures = 0;
    }

    await sleep(config.checkIntervalMs);
  }
}

function shouldRecycle(sessionStart) {
  if (config.restartAfterHours <= 0) return false;
  return Date.now() - sessionStart > config.restartAfterHours * 60 * 60 * 1000;
}

async function recoverPage(page, lastStatus) {
  log("info", "Reloading Foundry session.", { lastState: lastStatus.state });
  await captureDebugScreenshot(page, "before-reload");
  await gotoFoundry(page);
  await loginIfNeeded(page);
  const status = await waitForFoundryReady(page, config.worldReadyTimeoutMs);
  await writeStatus(status);
  logReadyStatus(status);
}

async function gotoFoundry(page) {
  await page.goto(config.foundryUrl, {
    waitUntil: "domcontentloaded",
    timeout: config.navigationTimeoutMs
  });
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
}

async function loginIfNeeded(page) {
  const current = await probeRuntimeStatus(page).catch(() => null);
  if (current && current.ok) return;

  await page.waitForTimeout(1000);

  const selectedUser = await selectFoundryUser(page);
  const filledPassword = await fillFoundryPassword(page);
  const submitted = await submitLoginForm(page);

  if (!selectedUser && config.userName) {
    log("warn", "Could not find a Foundry user selector matching FOUNDRY_USER.", {
      user: config.userName
    });
  }

  if (!filledPassword && config.userPassword) {
    throw new Error("Foundry password field was not visible, so the bot could not enter FOUNDRY_PASSWORD.");
  }

  if (!filledPassword && !config.userPassword) {
    log("info", "No password field was visible. Continuing in case the saved browser session is already valid.");
  }

  if (!submitted) {
    log("info", "No login button was clicked. Waiting in case Foundry is already entering the world.");
  }

  await waitForEitherGameOrNavigation(page, config.loginTimeoutMs);
}

async function selectFoundryUser(page) {
  if (!config.userName) return false;

  const selects = page.locator("select");
  const selectCount = await selects.count().catch(() => 0);

  for (let index = 0; index < selectCount; index += 1) {
    const select = selects.nth(index);
    const options = await select.evaluate((element) => {
      return Array.from(element.options).map((option) => ({
        label: option.label || option.textContent || "",
        text: option.textContent || "",
        value: option.value || ""
      }));
    }).catch(() => []);

    const match = findMatchingOption(options, config.userName);
    if (!match) continue;

    await chooseSelectOption(select, match);
    log("info", "Selected Foundry user.", { user: config.userName });
    return true;
  }

  const textLocator = page.getByText(config.userName, { exact: true }).first();
  if (await textLocator.isVisible().catch(() => false)) {
    const clicked = await textLocator.click({ timeout: 5000 }).then(() => true).catch(() => false);
    if (clicked) {
      log("info", "Clicked Foundry user entry.", { user: config.userName });
      return true;
    }
  }

  return false;
}

async function chooseSelectOption(select, match) {
  if (match.value) {
    const byValue = await select.selectOption({ value: match.value }, { timeout: 5000 }).then(() => true).catch(() => false);
    if (byValue) return;
  }

  if (match.label) {
    const byLabel = await select.selectOption({ label: match.label }, { timeout: 5000 }).then(() => true).catch(() => false);
    if (byLabel) return;
  }

  await select.evaluate((element, value) => {
    element.value = value;
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }, match.value);
}

async function fillFoundryPassword(page) {
  const passwordInput = page.locator([
    "input[type='password']",
    "input[name='password']",
    "input[name='accessKey']",
    "input[autocomplete='current-password']"
  ].join(", ")).first();

  if (!(await passwordInput.isVisible().catch(() => false))) {
    return false;
  }

  await passwordInput.fill(config.userPassword, { timeout: 5000 });
  log("info", "Filled Foundry password field.");
  return true;
}

async function submitLoginForm(page) {
  const candidates = [
    page.locator("button[type='submit'], input[type='submit']"),
    page.getByRole("button", { name: /join|log in|login|enter|connect/i }),
    page.locator("button").filter({ hasText: /join|log in|login|enter|connect/i })
  ];

  for (const candidate of candidates) {
    if (await clickFirstVisible(candidate, "login button")) {
      return true;
    }
  }

  return page.keyboard.press("Enter").then(() => true).catch(() => false);
}

async function clickFirstVisible(locator, description) {
  const count = Math.min(await locator.count().catch(() => 0), 10);
  for (let index = 0; index < count; index += 1) {
    const item = locator.nth(index);
    const visible = await item.isVisible().catch(() => false);
    const enabled = await item.isEnabled().catch(() => false);
    if (!visible || !enabled) continue;

    await item.click({ timeout: 5000 });
    log("info", `Clicked ${description}.`);
    return true;
  }

  return false;
}

async function waitForEitherGameOrNavigation(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const status = await probeRuntimeStatus(page).catch(() => null);
    if (status && status.ok) return;

    const url = page.url();
    if (/\/game(?:$|[/?#])/.test(url)) return;

    await sleep(1000);
  }
}

async function waitForFoundryReady(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = null;

  while (Date.now() < deadline) {
    lastStatus = await getFullStatus(page);

    if (lastStatus.ok) return lastStatus;
    // Waiting will not change which user is logged in; fail immediately.
    if (lastStatus.state === "wrong-user") break;
    await sleep(1000);
  }

  await captureDebugScreenshot(page, "not-ready");

  if (lastStatus && lastStatus.state === "wrong-user") {
    throw new Error(`Logged in as "${lastStatus.user}" but FOUNDRY_USER is "${config.userName}". Correct FOUNDRY_USER, or reset the saved session by deleting ${config.userDataDir}.`);
  }

  const detail = lastStatus ? JSON.stringify(lastStatus) : "no status";
  throw new Error(`Foundry did not become ready within ${Math.round(timeoutMs / 1000)} seconds: ${detail}`);
}

async function getFullStatus(page) {
  const status = applyIdentityCheck(await probeRuntimeStatus(page));
  return addRelayStatus(status);
}

function applyIdentityCheck(status) {
  // Only meaningful once Foundry reports a logged-in user.
  if (!status.ok || !config.userName || !status.user) return status;
  if (normalizeText(status.user) === normalizeText(config.userName)) return status;

  return {
    ...status,
    ok: false,
    state: "wrong-user",
    expectedUser: config.userName
  };
}

async function probeRuntimeStatus(page) {
  return withTimeout(
    getRuntimeStatus(page),
    config.statusProbeTimeoutMs,
    "Foundry status check timed out"
  ).catch((error) => ({
    ok: false,
    state: error.message.includes("timed out") ? "status-check-timeout" : "status-check-failed",
    error: error.message
  }));
}

async function getRuntimeStatus(page) {
  if (page.isClosed()) {
    return { ok: false, state: "page-closed" };
  }

  return page.evaluate((moduleId) => {
    const game = globalThis.game;
    if (!game) {
      return {
        ok: false,
        state: "no-game-object",
        title: document.title,
        url: location.href
      };
    }

    const module = moduleId ? game.modules?.get?.(moduleId) : null;
    const ready = Boolean(game.ready);
    const socketConnected = game.socket?.connected ?? null;
    const ok = ready && socketConnected !== false;

    return {
      ok,
      state: !ready ? "game-not-ready" : socketConnected === false ? "socket-disconnected" : "ready",
      title: document.title,
      url: location.href,
      world: game.world?.id || game.world?.title || null,
      system: game.system?.id || null,
      user: game.user?.name || null,
      userId: game.user?.id || null,
      userIsGM: game.user?.isGM ?? null,
      moduleId: moduleId || null,
      moduleActive: moduleId ? Boolean(module?.active) : null,
      socketConnected: game.socket?.connected ?? null
    };
  }, config.moduleId);
}

async function addRelayStatus(status) {
  // foundryOk is "is Foundry connected as the right user?" and drives browser
  // recovery. The top-level ok also folds in relay visibility for health checks.
  const foundryOk = Boolean(status.ok);

  if (!config.relayUrl || !config.relayApiKey) {
    return {
      ...status,
      foundryOk,
      relay: { configured: false }
    };
  }

  const relay = await checkRelayClients();
  return {
    ...status,
    foundryOk,
    ok: foundryOk && relay.ok,
    state: foundryOk && !relay.ok ? "relay-check-failed" : status.state,
    relay
  };
}

async function checkRelayClients() {
  try {
    const clientsUrl = new URL("/clients", config.relayUrl).toString();
    const response = await fetchWithTimeout(clientsUrl, {
      headers: {
        "x-api-key": config.relayApiKey,
        "accept": "application/json"
      }
    }, config.relayTimeoutMs);

    const text = await response.text();
    const data = parseJson(text);

    if (!response.ok) {
      return {
        configured: true,
        ok: false,
        state: "http-error",
        status: response.status,
        url: clientsUrl,
        body: text.slice(0, 500)
      };
    }

    const clients = extractClients(data);
    const visible = config.relayClientId
      ? JSON.stringify(data).includes(config.relayClientId)
      : clients.length > 0;

    return {
      configured: true,
      ok: visible,
      state: visible ? "visible" : "not-visible",
      url: clientsUrl,
      clientId: config.relayClientId || null,
      clientCount: clients.length
    };
  } catch (error) {
    return {
      configured: true,
      ok: false,
      state: "request-failed",
      url: config.relayUrl,
      error: error.message
    };
  }
}

function logReadyStatus(status) {
  log("info", "Foundry world is ready.", summarizeStatus(status));

  if (config.moduleId && status.moduleActive === false) {
    log("warn", "The configured REST bridge module is not active in this world.", {
      moduleId: config.moduleId
    });
  }

  if (config.requireGm && status.userIsGM === false) {
    log("warn", "The bot user is not a GM.", { user: status.user });
  }
}

function summarizeStatus(status) {
  return {
    world: status.world,
    user: status.user,
    userIsGM: status.userIsGM,
    moduleId: status.moduleId,
    moduleActive: status.moduleActive,
    socketConnected: status.socketConnected,
    relay: status.relay
  };
}

async function captureDebugScreenshot(page, label) {
  if (!page || page.isClosed()) return null;

  const safeLabel = label.replace(/[^a-z0-9._-]/gi, "-");
  const artifactsDir = config.artifactsDir;
  const screenshotPath = path.join(artifactsDir, `latest-${safeLabel}.png`);

  try {
    fs.mkdirSync(artifactsDir, { recursive: true, mode: 0o700 });
    await page.screenshot({ path: screenshotPath, fullPage: true });
    fs.chmodSync(screenshotPath, 0o600);
    log("info", "Saved debug screenshot.", { path: screenshotPath });
    return screenshotPath;
  } catch (error) {
    log("warn", "Could not save debug screenshot.", { error: error.message });
    return null;
  }
}

async function writeStatus(status) {
  const payload = {
    checkedAt: new Date().toISOString(),
    ...status
  };

  try {
    fs.mkdirSync(path.dirname(config.statusFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(config.statusFile, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(config.statusFile, 0o600);
  } catch (error) {
    log("warn", "Could not write status file.", {
      path: config.statusFile,
      error: error.message
    });
  }
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log("info", `Received ${signal}, shutting down.`);

  if (activeContext) {
    await closeQuietly(activeContext);
  }

  process.exit(0);
}

async function closeQuietly(context) {
  try {
    await context.close();
  } catch {
    // Nothing useful to do during shutdown.
  }
}

function readConfig() {
  const foundryUrl = normalizeUrl(env("FOUNDRY_URL", ""), "FOUNDRY_URL");
  const relayUrl = normalizeHttpUrl(env("REST_RELAY_URL", ""));
  const reloadAfterFailures = intEnv("RELOAD_AFTER_FAILURES", 3);

  return {
    configErrors: [
      foundryUrl.error,
      relayUrl.error
    ].filter(Boolean),
    foundryUrl: foundryUrl.value,
    userName: env("FOUNDRY_USER", ""),
    userPassword: env("FOUNDRY_PASSWORD", ""),
    useExistingBrowserSession: boolEnv("USE_EXISTING_BROWSER_SESSION", false),
    allowEmptyPassword: boolEnv("ALLOW_EMPTY_PASSWORD", false),
    moduleId: env("CHECK_MODULE_ID", env("MODULE_ID", "foundryvtt-rest-api")).trim(),
    relayUrl: relayUrl.value,
    relayApiKey: env("REST_RELAY_API_KEY", ""),
    relayClientId: env("REST_RELAY_CLIENT_ID", ""),
    headless: boolEnv("HEADLESS", true),
    userDataDir: resolveAppPath(env("USER_DATA_DIR", "./data/browser-profile")),
    checkIntervalMs: intEnv("CHECK_INTERVAL_SECONDS", 30) * 1000,
    reloadAfterFailures,
    relayReloadAfterFailures: intEnv("RELAY_RELOAD_AFTER_FAILURES", reloadAfterFailures * 3),
    restartAfterHours: intEnvMin("RESTART_AFTER_HOURS", 24, 0),
    worldReadyTimeoutMs: intEnv("WORLD_READY_TIMEOUT_SECONDS", 120) * 1000,
    loginTimeoutMs: intEnv("LOGIN_TIMEOUT_SECONDS", 60) * 1000,
    navigationTimeoutMs: intEnv("NAVIGATION_TIMEOUT_SECONDS", 60) * 1000,
    statusProbeTimeoutMs: intEnv("STATUS_PROBE_TIMEOUT_SECONDS", 10) * 1000,
    relayTimeoutMs: intEnv("REST_RELAY_TIMEOUT_SECONDS", 10) * 1000,
    ignoreHTTPSErrors: boolEnv("IGNORE_HTTPS_ERRORS", false),
    noSandbox: boolEnv("CHROMIUM_NO_SANDBOX", false),
    requireGm: boolEnv("REQUIRE_GM", true),
    statusFile: resolveAppPath(env("STATUS_FILE", "./data/status.json")),
    artifactsDir: resolveAppPath(env("ARTIFACTS_DIR", "./artifacts"))
  };
}

function validateConfig() {
  if (config.configErrors.length > 0) {
    throw new Error(config.configErrors.join("; "));
  }

  if (!config.foundryUrl) {
    throw new Error("FOUNDRY_URL is required. Copy .env.example to .env and edit it.");
  }

  if (!config.userName) {
    log("warn", "FOUNDRY_USER is empty. This only works if the browser profile already has a valid Foundry session.");
  }

  if (!config.useExistingBrowserSession && !config.allowEmptyPassword) {
    if (!config.userPassword || config.userPassword === "change-me") {
      throw new Error("FOUNDRY_PASSWORD must be set. If you intentionally rely on a saved browser session, set USE_EXISTING_BROWSER_SESSION=true.");
    }
  }

  if ((config.relayUrl && !config.relayApiKey) || (!config.relayUrl && config.relayApiKey)) {
    throw new Error("Set both REST_RELAY_URL and REST_RELAY_API_KEY, or leave both empty to skip relay verification.");
  }
}

function normalizeUrl(value, name) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return { value: "", error: "" };

  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `http://${trimmed}`;

  try {
    return { value: new URL(withProtocol).toString(), error: "" };
  } catch (error) {
    return { value: withProtocol, error: `${name} is invalid: ${error.message}` };
  }
}

function normalizeHttpUrl(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return { value: "", error: "" };

  const httpish = trimmed
    .replace(/^wss:\/\//i, "https://")
    .replace(/^ws:\/\//i, "http://");

  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(httpish)
    ? httpish
    : `http://${httpish}`;

  try {
    const url = new URL(withProtocol);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return { value: withProtocol, error: "REST_RELAY_URL must use http://, https://, ws://, or wss://" };
    }
    return { value: url.toString(), error: "" };
  } catch (error) {
    return { value: withProtocol, error: `REST_RELAY_URL is invalid: ${error.message}` };
  }
}

function resolveAppPath(value) {
  const raw = String(value || "").trim();
  if (!raw) return APP_ROOT;
  return path.isAbsolute(raw) ? raw : path.join(APP_ROOT, raw);
}

function findMatchingOption(options, userName) {
  const wanted = normalizeText(userName);

  const exact = options.find((option) => normalizeText(option.label) === wanted)
    || options.find((option) => normalizeText(option.text) === wanted)
    || options.find((option) => normalizeText(option.value) === wanted);
  if (exact) return exact;

  // Only fall back to a partial match when it is unambiguous, so "Bob" never
  // silently selects "Bobby". A wrong pick would also be caught after login.
  const partial = options.filter((option) =>
    normalizeText(option.label).includes(wanted) || normalizeText(option.text).includes(wanted));
  return partial.length === 1 ? partial[0] : null;
}

function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
}

function loadPlaywright() {
  try {
    return require("playwright");
  } catch (error) {
    throw new Error("Playwright is not installed. Run: npm install && npm run install-browser");
  }
}

async function runDoctor() {
  const checks = [];

  checks.push(["Node.js >= 20", Number(process.versions.node.split(".")[0]) >= 20, process.versions.node]);
  checks.push([".env file exists", fs.existsSync(DEFAULT_ENV_FILE), DEFAULT_ENV_FILE]);
  checks.push(["FOUNDRY_URL configured", Boolean(config.foundryUrl), config.foundryUrl || "missing"]);
  checks.push(["FOUNDRY_URL valid", !config.configErrors.some((error) => error.startsWith("FOUNDRY_URL")), config.configErrors.join("; ") || "ok"]);
  checks.push(["FOUNDRY_USER configured", Boolean(config.userName), config.userName || "missing"]);
  checks.push([
    "FOUNDRY_PASSWORD configured",
    Boolean(config.userPassword && config.userPassword !== "change-me") || config.useExistingBrowserSession || config.allowEmptyPassword,
    config.useExistingBrowserSession ? "using saved browser session" : config.allowEmptyPassword ? "empty password explicitly allowed" : config.userPassword ? "configured" : "missing"
  ]);
  checks.push([
    "Relay verification config",
    config.configErrors.every((error) => !error.startsWith("REST_RELAY_URL")) && (!config.relayUrl || Boolean(config.relayApiKey)),
    config.relayUrl ? "configured" : "skipped"
  ]);
  checks.push(["Browser profile directory writable", canWriteDirectory(config.userDataDir), config.userDataDir]);
  checks.push(["Status directory writable", canWriteDirectory(path.dirname(config.statusFile)), path.dirname(config.statusFile)]);
  checks.push(["Artifacts directory writable", canWriteDirectory(config.artifactsDir), config.artifactsDir]);

  if (config.relayUrl && config.relayApiKey && config.configErrors.every((error) => !error.startsWith("REST_RELAY_URL"))) {
    const relay = await checkRelayClients();
    checks.push(["Relay /clients reachable", relay.ok, relay.ok ? `clients: ${relay.clientCount}` : relay.error || relay.state]);
  }

  let playwrightInstalled = false;
  try {
    require.resolve("playwright");
    playwrightInstalled = true;
    checks.push(["Playwright package installed", true, "ok"]);
  } catch {
    checks.push(["Playwright package installed", false, "run npm install"]);
  }

  if (playwrightInstalled) {
    const browser = await smokeTestChromium();
    checks.push(["Chromium can launch", browser.ok, browser.ok ? "ok" : browser.error]);
  }

  for (const [name, ok, detail] of checks) {
    const mark = ok ? "OK " : "FAIL";
    console.log(`${mark} ${name}: ${detail}`);
  }

  const failed = checks.filter(([, ok]) => !ok);
  if (failed.length > 0) {
    console.log("");
    console.log("Fix the failed checks, then run: npm run doctor");
    return false;
  }

  return true;
}

function runHealthCheck() {
  const status = readStatusFile();
  if (!status) {
    console.error(`FAIL status file missing or unreadable: ${config.statusFile}`);
    return false;
  }

  const maxAgeMs = intEnv("HEALTH_MAX_AGE_SECONDS", 120) * 1000;
  const checkedAt = Date.parse(status.checkedAt || "");
  const fresh = Number.isFinite(checkedAt) && Date.now() - checkedAt <= maxAgeMs;
  const ok = Boolean(status.ok) && fresh;

  if (!ok) {
    console.error(JSON.stringify({
      ok: false,
      reason: !fresh ? "stale-status" : "bot-unhealthy",
      maxAgeSeconds: Math.round(maxAgeMs / 1000),
      status
    }, null, 2));
    return false;
  }

  console.log(JSON.stringify({
    ok: true,
    checkedAt: status.checkedAt,
    state: status.state,
    world: status.world,
    user: status.user,
    moduleActive: status.moduleActive,
    socketConnected: status.socketConnected,
    relay: status.relay
  }, null, 2));
  return true;
}

function readStatusFile() {
  try {
    return JSON.parse(fs.readFileSync(config.statusFile, "utf8"));
  } catch {
    return null;
  }
}

async function smokeTestChromium() {
  let browser = null;
  try {
    const { chromium } = loadPlaywright();
    const args = ["--disable-dev-shm-usage"];
    if (config.noSandbox) args.push("--no-sandbox");
    browser = await chromium.launch({ headless: true, args });
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: `${error.message} (run npm run install-browser, or on Debian/Ubuntu run npm run install-browser-with-deps)`
    };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

function canWriteDirectory(directory) {
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const testPath = path.join(directory, `.write-test-${process.pid}`);
    fs.writeFileSync(testPath, "ok", { mode: 0o600 });
    fs.unlinkSync(testPath);
    return true;
  } catch {
    return false;
  }
}

function extractClients(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.clients)) return data.clients;
  if (Array.isArray(data?.data)) return data.data;
  if (data?.clients && typeof data.clients === "object") return Object.values(data.clients);
  if (data?.data && typeof data.data === "object") return Object.values(data.data);
  return [];
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

function withTimeout(promise, timeoutMs, message) {
  let timeout = null;
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeout));
}

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;

  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;

    const key = match[1];
    let value = match[2].trim();

    const doubleQuoted = value.length >= 2 && value.startsWith('"') && value.endsWith('"');
    const singleQuoted = value.length >= 2 && value.startsWith("'") && value.endsWith("'");

    if (doubleQuoted) {
      // Unescape \\, \" and \n so passwords with quotes/spaces survive round-trips.
      value = value.slice(1, -1).replace(/\\([\\"n])/g, (_, char) => (char === "n" ? "\n" : char));
    } else if (singleQuoted) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\\n/g, "\n");
    }

    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

async function runSetup() {
  const readline = require("node:readline/promises");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    console.log("");
    console.log("Foundry REST Bridge - guided setup");
    console.log("This writes a .env file with your settings. Press Enter to accept the [default].");
    console.log("");

    if (fs.existsSync(DEFAULT_ENV_FILE)) {
      const overwrite = await askYesNo(rl, `A .env already exists at ${DEFAULT_ENV_FILE}. Overwrite it?`, false);
      if (!overwrite) {
        console.log("Keeping the existing .env. Setup cancelled.");
        return true;
      }
    }

    const foundryUrl = await askUrl(rl, "Foundry URL", "http://127.0.0.1:30000");
    const userName = await askText(rl, "Foundry bot user", "api-bot");
    const userPassword = await askPassword(rl, "Foundry password for that user");
    const moduleId = await askText(rl, "Foundry REST module id", "foundryvtt-rest-api");

    let relayUrl = "";
    let relayApiKey = "";
    let relayClientId = "";
    const configureRelay = await askYesNo(rl, "Also verify the REST relay sees this client?", false);
    if (configureRelay) {
      relayUrl = await askUrl(rl, "Relay HTTP(S) base URL", "http://127.0.0.1:3010");
      relayApiKey = await askText(rl, "Relay API key", "");
      relayClientId = await askText(rl, "Relay client id (optional, Enter to skip)", "");
    }

    const contents = buildEnvFile({
      foundryUrl,
      userName,
      userPassword,
      moduleId,
      relayUrl,
      relayApiKey,
      relayClientId
    });

    fs.writeFileSync(DEFAULT_ENV_FILE, contents, { mode: 0o600 });
    fs.chmodSync(DEFAULT_ENV_FILE, 0o600);

    console.log("");
    console.log(`Saved ${DEFAULT_ENV_FILE} (permissions 600).`);
    console.log("Next, run `npm run doctor` to verify everything, then `npm start`.");
    return true;
  } catch (error) {
    console.error(`Setup failed: ${error.message}`);
    return false;
  } finally {
    rl.close();
  }
}

function buildEnvFile(values) {
  const lines = [
    `# Generated by \`npm run setup\` on ${new Date().toISOString()}.`,
    "# Re-run setup to regenerate, or edit by hand. Keep this file private.",
    "",
    `FOUNDRY_URL=${envValueLiteral(values.foundryUrl)}`,
    `FOUNDRY_USER=${envValueLiteral(values.userName)}`,
    `FOUNDRY_PASSWORD=${envValueLiteral(values.userPassword)}`,
    `CHECK_MODULE_ID=${envValueLiteral(values.moduleId)}`,
    "",
    "# Optional REST relay verification.",
    `REST_RELAY_URL=${envValueLiteral(values.relayUrl)}`,
    `REST_RELAY_API_KEY=${envValueLiteral(values.relayApiKey)}`,
    `REST_RELAY_CLIENT_ID=${envValueLiteral(values.relayClientId)}`,
    "",
    "# Run headless. Set to false only for local debugging on a desktop.",
    "HEADLESS=true",
    ""
  ];
  return lines.join("\n");
}

function envValueLiteral(value) {
  const str = String(value ?? "");
  if (str === "") return "";
  if (/^[A-Za-z0-9._:/@+=~-]+$/.test(str)) return str;
  const escaped = str.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
  return `"${escaped}"`;
}

async function askText(rl, label, defaultValue) {
  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  const answer = (await rl.question(`${label}${suffix}: `)).trim();
  return answer || defaultValue;
}

async function askUrl(rl, label, defaultValue) {
  for (;;) {
    const value = await askText(rl, label, defaultValue);
    const normalized = normalizeUrl(value, label);
    if (!normalized.error) return normalized.value;
    console.log(`  ${normalized.error}`);
  }
}

async function askYesNo(rl, label, defaultValue) {
  const hint = defaultValue ? "Y/n" : "y/N";
  const answer = (await rl.question(`${label} (${hint}): `)).trim().toLowerCase();
  if (!answer) return defaultValue;
  return ["y", "yes"].includes(answer);
}

async function askPassword(rl, label) {
  // Print the prompt, then suppress the terminal echo while the password is typed.
  // Wrapping process.stdout.write works across Node versions (readline internals do not).
  process.stdout.write(`${label}: `);
  const restore = muteStdout();
  try {
    const value = await rl.question("");
    return value.trim();
  } finally {
    restore();
    process.stdout.write("\n");
  }
}

function muteStdout() {
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, encoding, callback) => {
    if (typeof encoding === "function") encoding();
    else if (typeof callback === "function") callback();
    return true;
  };
  return () => {
    process.stdout.write = original;
  };
}

function env(name, defaultValue) {
  return process.env[name] === undefined ? defaultValue : process.env[name];
}

function boolEnv(name, defaultValue) {
  const value = process.env[name];
  if (value === undefined || value === "") return defaultValue;
  return ["1", "true", "yes", "y", "on"].includes(value.toLowerCase());
}

function intEnv(name, defaultValue) {
  const value = Number.parseInt(env(name, String(defaultValue)), 10);
  return Number.isFinite(value) && value > 0 ? value : defaultValue;
}

// Like intEnv but allows values down to `min` (e.g. 0 to disable a feature).
function intEnvMin(name, defaultValue, min) {
  const raw = env(name, "");
  if (raw === "") return defaultValue;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value >= min ? value : defaultValue;
}

function log(level, message, details) {
  const line = `[${new Date().toISOString()}] ${level.toUpperCase().padEnd(5)} ${message}`;
  if (details && Object.keys(details).length > 0) {
    console.log(`${line} ${JSON.stringify(details)}`);
  } else {
    console.log(line);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
