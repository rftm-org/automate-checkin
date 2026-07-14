import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "checkin-selfcheck-"));
  process.env.ACCOUNTS_DIR = join(root, "accounts");
  process.env.WEB_DB_PATH = join(root, "web.db");
  process.env.BUNDLE_PATH = join(root, "bundle.b64");

  const db = await import("./db.js");
  const bundle = await import("../bundle.js");

  const id = "test-account";
  db.createAccount(id, "Alice");
  db.setActive(id, 1);
  await import("node:fs/promises").then((m) => m.mkdir(join(root, "accounts"), { recursive: true }));
  await writeFile(join(root, "accounts", `${id}.json`), JSON.stringify({ cookies: [{ name: "x" }] }));

  const encoded = await bundle.writeBundle();
  const decoded = bundle.decodeBundle(encoded);
  if (decoded.accounts.length !== 1) throw new Error("bundle should contain 1 account");
  if (decoded.accounts[0].id !== id) throw new Error("bundle id mismatch");
  const stateBack = JSON.parse(decoded.accounts[0].state);
  if (stateBack.cookies[0].name !== "x") throw new Error("bundle state roundtrip failed");

  const accounts = db.listAccounts();
  if (accounts.length !== 1 || accounts[0].name !== "Alice") throw new Error("db listing failed");

  db.deleteAccount(id);
  if (db.listAccounts().length !== 0) throw new Error("db delete failed");

  db.db.close();
  await rm(root, { recursive: true, force: true });
  console.log("self-check OK: db + bundle roundtrip");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
