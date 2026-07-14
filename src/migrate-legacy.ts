import { copyFile, access } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import * as db from "./web/db.js";
import { accountStorageStatePath, DEFAULT_STORAGE_STATE_PATH } from "./config.js";
import { writeBundle } from "./bundle.js";
import { pushSecrets } from "./github.js";

const LEGACY_NAME = "DOX";
const legacyPath = process.env.HOYOLAB_STORAGE_STATE_PATH || DEFAULT_STORAGE_STATE_PATH;

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  if (!(await fileExists(legacyPath))) {
    console.error(`Aucun fichier legacy trouve: ${legacyPath}`);
    process.exitCode = 1;
    return;
  }

  const existing = db.listAccounts().find((a) => a.name === LEGACY_NAME);
  const id = existing ? existing.id : randomUUID();

  if (!existing) {
    db.createAccount(id, LEGACY_NAME);
  }
  db.setActive(id, 1);

  await copyFile(legacyPath, accountStorageStatePath(id));
  console.log(`Compte legacy importe comme "${LEGACY_NAME}" (${id}).`);

  const value = await writeBundle();
  const push = await pushSecrets(value);
  console.log(push.output);
  if (!push.ok) {
    console.log("Compte configure localement; push GitHub a echoue (verifie `gh` authentifie).");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
