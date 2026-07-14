import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { chromium, type Page } from "playwright";
import {
  accountProofDir,
  accountStorageStatePath,
  ensureDir,
  hasFlag,
  HOYOLAB_SIGNIN_URL,
  isHeadless,
  parisDay,
  proofPath,
  storageStatePath,
} from "./config.js";

type RewardTile = {
  text: string;
  className: string;
  rect: { x: number; y: number; width: number; height: number };
};

type TileState = {
  active: RewardTile[];
  signed: RewardTile[];
  all: RewardTile[];
};

export type CheckinStatus = "checked_in" | "noop" | "failed";

export type CheckinResult = {
  accountId?: string;
  status: CheckinStatus;
  proof?: string;
  error?: string;
  beforeCounter?: number | null;
  afterCounter?: number | null;
};

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function parseCounter(text: string): number | null {
  const match = text.match(/(\d+)\s+jour\(s\)\s+ce mois-ci/i);
  return match ? Number(match[1]) : null;
}

async function dismissCookieBanner(page: Page): Promise<void> {
  const okButton = page.getByRole("button", { name: /^OK$/i });
  if (await okButton.isVisible({ timeout: 1500 }).catch(() => false)) {
    await okButton.click();
    await page.waitForTimeout(1000);
  }
}

async function closeAppReminderIfPresent(page: Page): Promise<boolean> {
  const hasReminder = await page
    .locator("body")
    .innerText({ timeout: 2000 })
    .then((text) => /L'application vous permet d'établir un rappel|téléchargez l'application/i.test(text))
    .catch(() => false);

  if (!hasReminder) {
    return false;
  }

  const modal = await page
    .locator(".m-modal")
    .filter({ hasText: /rappel de connexion|téléchargez l'application/i })
    .first()
    .boundingBox()
    .catch(() => null);

  if (modal) {
    await page.mouse.click(modal.x + modal.width - 28, modal.y + 28);
  } else {
    await page.keyboard.press("Escape").catch(() => undefined);
  }

  await page.waitForTimeout(1000);
  return true;
}

async function readTileState(page: Page): Promise<TileState> {
  return page.evaluate<TileState>(`(() => {
    function clean(value) {
      return (value || "").trim().replace(/\\s+/g, " ");
    }

    const all = [...document.querySelectorAll("body *")]
      .filter((element) => {
        const className = String(element.className || "");
        return className.includes("sign-wrapper") || className.includes("has-signed");
      })
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          text: clean(element.innerText || element.textContent),
          className: String(element.className || ""),
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        };
      })
      .filter((tile) => /Jour \\d+/.test(tile.text) && tile.rect.width > 40 && tile.rect.height > 40);

    return {
      active: all.filter((tile) => tile.className.includes("sign-wrapper")),
      signed: all.filter((tile) => tile.className.includes("has-signed")),
      all,
    };
  })()`);
}

async function revealMoreIfUseful(page: Page, state: TileState): Promise<TileState> {
  if (state.active.length > 0) {
    return state;
  }

  const showMore = page.getByText(/Afficher plus/i).first();
  if (await showMore.isVisible({ timeout: 1500 }).catch(() => false)) {
    await showMore.click();
    await page.waitForTimeout(1000);
    return readTileState(page);
  }

  return state;
}

async function waitForCheckinPage(page: Page): Promise<string> {
  await page.waitForLoadState("domcontentloaded", { timeout: 30_000 });
  await page.waitForTimeout(3000);
  await dismissCookieBanner(page);

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const text = await page.locator("body").innerText({ timeout: 10_000 });
    if (/Jour \d+/i.test(text)) {
      return text;
    }
    await page.waitForTimeout(2000);
    await dismissCookieBanner(page);
  }

  const text = await page.locator("body").innerText({ timeout: 10_000 });
  if (/se connecter|log in|captcha|verification|vérification/i.test(text)) {
    throw new Error("Hoyolab session is not usable. Manual login or verification is required.");
  }
  throw new Error("Hoyolab check-in grid did not load.");
}

async function hasSuccessDialog(page: Page): Promise<boolean> {
  return page
    .getByText(/Connexion quotidienne effectuée|Bravo/i)
    .first()
    .isVisible({ timeout: 3000 })
    .catch(() => false);
}

async function clickActiveTile(page: Page, tile: RewardTile): Promise<void> {
  await page.mouse.click(tile.rect.x + tile.rect.width / 2, tile.rect.y + tile.rect.height / 2);
  await page.waitForTimeout(3000);
}

export function makeAccountProofPath(id: string, kind: string): string {
  const dd = String(parisDay()).padStart(2, "0");
  const dir = accountProofDir(id);
  if (kind === "checkin") {
    return resolve(dir, `${dd}.png`);
  }
  const prefix = kind === "dry-run" ? "dry" : "fail";
  return resolve(dir, `${prefix}-${dd}.png`);
}

export async function runCheckin(opts: {
  storageStatePath: string;
  makeProofPath: (kind: string) => string;
  dryRun: boolean;
  allowRerun: boolean;
  accountId?: string;
}): Promise<CheckinResult> {
  const { storageStatePath: statePath, makeProofPath, dryRun, allowRerun, accountId } = opts;
  const finalProofPath = makeProofPath("checkin");

  if (!dryRun && !allowRerun && (await fileExists(finalProofPath))) {
    return { accountId, status: "noop", proof: finalProofPath };
  }

  if (!(await fileExists(statePath))) {
    return { accountId, status: "failed", error: `Missing storage state at ${statePath}.` };
  }

  await ensureDir(dirname(finalProofPath));

  const browser = await chromium.launch({ headless: isHeadless() });
  const context = await browser.newContext({
    locale: "fr-FR",
    storageState: statePath,
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();

  try {
    await page.goto(HOYOLAB_SIGNIN_URL, { waitUntil: "domcontentloaded" });
    const beforeText = await waitForCheckinPage(page);
    const beforeCounter = parseCounter(beforeText);
    let state = await revealMoreIfUseful(page, await readTileState(page));

    if (dryRun) {
      const dryProofPath = makeProofPath("dry-run");
      await page.screenshot({ path: dryProofPath, fullPage: false });
      return { accountId, status: "noop", proof: dryProofPath, beforeCounter, afterCounter: beforeCounter };
    }

    if (state.active.length === 0) {
      await page.screenshot({ path: finalProofPath, fullPage: false });
      return { accountId, status: "noop", proof: finalProofPath, beforeCounter, afterCounter: beforeCounter };
    }

    await clickActiveTile(page, state.active[0]);

    if (await closeAppReminderIfPresent(page)) {
      state = await revealMoreIfUseful(page, await readTileState(page));
      if (state.active.length === 0) {
        const failurePath = makeProofPath("failure");
        await page.screenshot({ path: failurePath, fullPage: false });
        return { accountId, status: "failed", proof: failurePath, error: "App reminder closed, active tile disappeared." };
      }
      await clickActiveTile(page, state.active[0]);
    }

    const afterText = await page.locator("body").innerText({ timeout: 10_000 });
    const afterCounter = parseCounter(afterText);
    const successByDialog = await hasSuccessDialog(page);
    const successByCounter =
      typeof beforeCounter === "number" && typeof afterCounter === "number" && afterCounter > beforeCounter;

    if (!successByDialog && !successByCounter) {
      const failurePath = makeProofPath("failure");
      await page.screenshot({ path: failurePath, fullPage: false });
      return { accountId, status: "failed", proof: failurePath, beforeCounter, afterCounter, error: "Success could not be verified." };
    }

    await page.screenshot({ path: finalProofPath, fullPage: false });
    return { accountId, status: "checked_in", proof: finalProofPath, beforeCounter, afterCounter };
  } finally {
    await context.close();
    await browser.close();
  }
}

function getFlagValue(name: string): string | undefined {
  for (let i = 0; i < process.argv.length; i += 1) {
    const arg = process.argv[i];
    if (arg === name && i + 1 < process.argv.length) {
      return process.argv[i + 1];
    }
    if (arg.startsWith(`${name}=`)) {
      return arg.slice(name.length + 1);
    }
  }
  return undefined;
}

async function listAccountStates(): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const { ACCOUNTS_DIR } = await import("./config.js");
  let files: string[] = [];
  try {
    files = await readdir(ACCOUNTS_DIR);
  } catch {
    files = [];
  }
  return files.filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -".json".length));
}

async function main(): Promise<void> {
  const dryRun = hasFlag("--dry-run");
  const accountId = getFlagValue("--account");
  const runAll = hasFlag("--all");

  if (runAll || accountId) {
    const ids = accountId ? [accountId] : await listAccountStates();
    const results: CheckinResult[] = [];
    for (const id of ids) {
      const result = await runCheckin({
        storageStatePath: accountStorageStatePath(id),
        makeProofPath: (kind) => makeAccountProofPath(id, kind),
        dryRun,
        allowRerun: true,
        accountId: id,
      });
      results.push(result);
      console.log(JSON.stringify(result));
    }
    const failed = results.filter((r) => r.status === "failed");
    if (failed.length > 0) process.exitCode = 1;
    return;
  }

  const result = await runCheckin({
    storageStatePath: await storageStatePath(),
    makeProofPath: (kind) => proofPath(kind),
    dryRun,
    allowRerun: false,
  });
  console.log(JSON.stringify(result, null, 2));
  if (result.status === "failed") process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
