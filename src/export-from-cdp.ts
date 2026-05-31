import { dirname } from "node:path";
import { chromium } from "playwright";
import { ensureDir, HOYOLAB_SIGNIN_URL, storageStatePath } from "./config.js";

async function main(): Promise<void> {
  const cdpUrl = process.env.CDP_URL || "http://127.0.0.1:9223";
  const statePath = await storageStatePath();
  await ensureDir(dirname(statePath));

  const browser = await chromium.connectOverCDP(cdpUrl);
  const context = browser.contexts()[0];
  if (!context) {
    throw new Error(`No browser context found at ${cdpUrl}`);
  }

  const page = context.pages()[0] || (await context.newPage());
  await page.goto(HOYOLAB_SIGNIN_URL, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);

  const bodyText = await page.locator("body").innerText({ timeout: 10_000 });
  if (!/jour\(s\) ce mois-ci|Jour \d+|Connexion quotidienne/i.test(bodyText)) {
    throw new Error("Hoyolab check-in page did not look authenticated. Open the agent Chrome profile and sign in first.");
  }

  await context.storageState({ path: statePath, indexedDB: true });
  await browser.close();

  console.log(`Storage state exported from ${cdpUrl} to ${statePath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
