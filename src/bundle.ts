import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { ACCOUNTS_DIR } from "./config.js";
import * as db from "./web/db.js";

export interface BundleAccount {
  id: string;
  name: string;
  state: string;
}

export interface AccountsBundle {
  accounts: BundleAccount[];
}

export const BUNDLE_PATH = resolve(process.env.BUNDLE_PATH || ".auth/accounts-bundle.b64");

export async function buildBundle(): Promise<AccountsBundle> {
  let files: string[] = [];
  try {
    files = await readdir(ACCOUNTS_DIR);
  } catch {
    files = [];
  }

  const accounts: BundleAccount[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const id = file.slice(0, -".json".length);
    const row = db.getAccount(id);
    if (!row || row.active === 0) continue;

    const raw = await readFile(resolve(ACCOUNTS_DIR, file), "utf8");
    accounts.push({ id, name: row.name, state: raw });
  }

  return { accounts };
}

export function encodeBundle(bundle: AccountsBundle): string {
  return gzipSync(Buffer.from(JSON.stringify(bundle), "utf8")).toString("base64");
}

export function decodeBundle(encoded: string): AccountsBundle {
  return JSON.parse(gunzipSync(Buffer.from(encoded, "base64")).toString("utf8")) as AccountsBundle;
}

export async function writeBundle(): Promise<string> {
  const bundle = await buildBundle();
  const encoded = encodeBundle(bundle);
  await mkdir(dirname(BUNDLE_PATH), { recursive: true });
  await writeFile(BUNDLE_PATH, encoded, "utf8");
  return encoded;
}
