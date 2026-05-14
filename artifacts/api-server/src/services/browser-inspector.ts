/**
 * Browser Inspector Service
 *
 * Manages a single shared Playwright Chromium instance for the API server.
 * Exposes:
 *   screenshotUrl(url, viewport?)  → Buffer (PNG)
 *   captureConsoleLogs(url, durationMs) → ConsoleLine[]
 *
 * Design:
 *   - Browser is lazy-initialised on first call.
 *   - A new page is opened per request and closed after, to avoid state leakage.
 *   - If the browser crashes, it is restarted on the next call.
 *   - Navigation timeout: 15 seconds (per task spec).
 */

import { chromium, type Browser, type BrowserContext } from "playwright";
import { logger } from "../lib/logger";

export interface ConsoleLine {
  level: "log" | "info" | "warn" | "error" | "debug";
  message: string;
  timestamp: number;
}

export interface Viewport {
  width: number;
  height: number;
}

const NAV_TIMEOUT_MS = 15_000;

let browser: Browser | null = null;

/**
 * Resolve the Chromium executable path.
 * Prefers a system Chromium so we don't need a playwright browser download.
 */
function resolveChromiumPath(): string | undefined {
  const candidates = [
    process.env["CHROMIUM_PATH"],
    // Nix-installed Chromium (most likely after `installSystemDependencies`)
    "/nix/store/qa9cnw4v5xkxyip6mb9kxqfq1z4x2dx1-chromium-138.0.7204.100/bin/chromium",
    "/nix/store/5afrhwm7zqn1vb7p5z1mc2rkh2grsfgz-ungoogled-chromium-138.0.7204.100/bin/chromium",
  ];
  for (const c of candidates) {
    if (c) return c;
  }
  return undefined; // let Playwright find its own bundled binary
}

async function getBrowser(): Promise<Browser> {
  if (browser && browser.isConnected()) return browser;
  const executablePath = resolveChromiumPath();
  logger.info({ executablePath }, "browser-inspector: launching Chromium");
  browser = await chromium.launch({
    executablePath,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
  });
  browser.on("disconnected", () => {
    logger.warn("browser-inspector: Chromium disconnected — will relaunch on next request");
    browser = null;
  });
  return browser;
}

/**
 * Take a screenshot of the given URL.
 * Returns a PNG buffer.
 */
export async function screenshotUrl(
  url: string,
  viewport: Viewport = { width: 1280, height: 720 }
): Promise<Buffer> {
  const b = await getBrowser();
  let ctx: BrowserContext | null = null;
  try {
    ctx = await b.newContext({
      viewport,
      userAgent: "MIZIBot/1.0 (screenshot; +https://mizicode.com/bot)",
    });
    const page = await ctx.newPage();
    page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
    await page.goto(url, { waitUntil: "networkidle" });
    const buf = await page.screenshot({ type: "png", fullPage: false });
    return Buffer.from(buf);
  } finally {
    await ctx?.close().catch(() => {});
  }
}

/**
 * Load the given URL in a headless browser, collect all console output and
 * unhandled JS exceptions for `durationMs` milliseconds, then return the log lines.
 */
export async function captureConsoleLogs(
  url: string,
  durationMs = 5_000
): Promise<ConsoleLine[]> {
  const b = await getBrowser();
  const logs: ConsoleLine[] = [];
  let ctx: BrowserContext | null = null;
  try {
    ctx = await b.newContext({
      userAgent: "MIZIBot/1.0 (console-capture; +https://mizicode.com/bot)",
    });
    const page = await ctx.newPage();
    page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);

    page.on("console", (msg) => {
      const level = (msg.type() as ConsoleLine["level"]) ?? "log";
      logs.push({ level, message: msg.text(), timestamp: Date.now() });
    });

    page.on("pageerror", (err) => {
      logs.push({ level: "error", message: `Unhandled exception: ${err.message}`, timestamp: Date.now() });
    });

    await page.goto(url, { waitUntil: "domcontentloaded" });

    // Wait for the requested duration to capture async console output
    await page.waitForTimeout(durationMs);

    return logs;
  } finally {
    await ctx?.close().catch(() => {});
  }
}

/** Gracefully close the shared browser. Called on server shutdown. */
export async function closeBrowser(): Promise<void> {
  if (browser) {
    await browser.close().catch(() => {});
    browser = null;
  }
}
