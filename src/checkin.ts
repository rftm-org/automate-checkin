import { access } from "node:fs/promises";
import { dirname } from "node:path";
import { chromium, type Page } from "playwright";
import { ensureDir, hasFlag, HOYOLAB_SIGNIN_URL, isHeadless, proofPath, storageStatePath } from "./config.js";

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

async function main(): Promise<void> {
  const dryRun = hasFlag("--dry-run");
  const finalProofPath = proofPath("checkin");

  if (!dryRun && (await fileExists(finalProofPath))) {
    console.log(`Proof already exists: ${finalProofPath}`);
    return;
  }

  const statePath = await storageStatePath();
  if (!(await fileExists(statePath))) {
    throw new Error(`Missing storage state at ${statePath}. Run npm run auth first.`);
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

    console.log(
      JSON.stringify(
        {
          beforeCounter,
          active: state.active.map((tile) => tile.text),
          signed: state.signed.map((tile) => tile.text),
          dryRun,
        },
        null,
        2,
      ),
    );

    if (dryRun) {
      const dryProofPath = proofPath("dry-run");
      await page.screenshot({ path: dryProofPath, fullPage: false });
      console.log(`Dry-run screenshot saved: ${dryProofPath}`);
      return;
    }

    if (state.active.length === 0) {
      await page.screenshot({ path: finalProofPath, fullPage: false });
      console.log(`No active tile found. Treating as already done; proof saved: ${finalProofPath}`);
      return;
    }

    await clickActiveTile(page, state.active[0]);

    if (await closeAppReminderIfPresent(page)) {
      state = await revealMoreIfUseful(page, await readTileState(page));
      if (state.active.length === 0) {
        throw new Error("App reminder was closed, but active reward tile disappeared before success verification.");
      }
      await clickActiveTile(page, state.active[0]);
    }

    const afterText = await page.locator("body").innerText({ timeout: 10_000 });
    const afterCounter = parseCounter(afterText);
    const successByDialog = await hasSuccessDialog(page);
    const successByCounter =
      typeof beforeCounter === "number" && typeof afterCounter === "number" && afterCounter > beforeCounter;

    if (!successByDialog && !successByCounter) {
      const failurePath = proofPath("failure");
      await page.screenshot({ path: failurePath, fullPage: false });
      throw new Error(`Check-in success could not be verified. Failure screenshot: ${failurePath}`);
    }

    await page.screenshot({ path: finalProofPath, fullPage: false });
    console.log(
      JSON.stringify(
        {
          status: "checked_in",
          proof: finalProofPath,
          beforeCounter,
          afterCounter,
          successByDialog,
          successByCounter,
        },
        null,
        2,
      ),
    );
  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
