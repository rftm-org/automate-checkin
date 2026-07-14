import { DatabaseSync } from "node:sqlite";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const DB_PATH = resolve(process.env.WEB_DB_PATH || ".auth/web.db");

await mkdir(dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_run_at TEXT,
    last_status TEXT,
    active INTEGER NOT NULL DEFAULT 0
  );
`);

export type AccountStatus = "success" | "failed" | "noop" | "unknown";

export interface AccountRow {
  id: string;
  name: string;
  created_at: string;
  last_run_at: string | null;
  last_status: string | null;
  active: number;
}

export function listAccounts(): AccountRow[] {
  return db.prepare("SELECT * FROM accounts ORDER BY created_at ASC").all() as unknown as AccountRow[];
}

export function getAccount(id: string): AccountRow | undefined {
  return db.prepare("SELECT * FROM accounts WHERE id = ?").get(id) as unknown as AccountRow | undefined;
}

export function createAccount(id: string, name: string): AccountRow {
  const created_at = new Date().toISOString();
  db.prepare("INSERT INTO accounts (id, name, created_at, active) VALUES (?, ?, ?, 0)").run(
    id,
    name,
    created_at,
  );
  return getAccount(id)!;
}

export function setActive(id: string, active: number): void {
  db.prepare("UPDATE accounts SET active = ? WHERE id = ?").run(active, id);
}

export function updateRun(id: string, status: AccountStatus, at: string): void {
  db.prepare("UPDATE accounts SET last_run_at = ?, last_status = ? WHERE id = ?").run(at, status, id);
}

export function deleteAccount(id: string): void {
  db.prepare("DELETE FROM accounts WHERE id = ?").run(id);
}

export { db };
