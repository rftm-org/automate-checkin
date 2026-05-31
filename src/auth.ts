import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { dirname } from "node:path";
import { chromium } from "playwright";
import { DEFAULT_STORAGE_STATE_PATH, ensureDir, HOYOLAB_SIGNIN_URL, isHeadless, storageStatePath } from "./config.js";

async function main(): Promise<void> {
  const statePath = await storageStatePath();
  await ensureDir(dirname(statePath));

  const browser = await chromium.launch({ headless: isHeadless() });
  const context = await browser.newContext({
    locale: "fr-FR",
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();

  await page.goto(HOYOLAB_SIGNIN_URL, { waitUntil: "domcontentloaded" });

  const rl = createInterface({ input, output });
  try {
    await rl.question(
      [
        "Connecte-toi manuellement a Hoyolab dans la fenetre ouverte.",
        "Quand la page de connexion quotidienne est visible/connectee, appuie sur Entree ici pour sauvegarder la session.",
        "",
      ].join("\n"),
    );
  } finally {
    rl.close();
  }

  await context.storageState({ path: statePath, indexedDB: true });
  await browser.close();

  console.log(`Storage state saved to ${statePath}`);
  console.log("PowerShell secret helper:");
  console.log(
    `[Convert]::ToBase64String([IO.File]::ReadAllBytes("${DEFAULT_STORAGE_STATE_PATH}")) | Set-Clipboard`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
