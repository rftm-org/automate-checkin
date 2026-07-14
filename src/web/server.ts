import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, rm, mkdir } from "node:fs/promises";
import { existsSync, readdirSync as readdirSyncFs } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { chromium, type Browser, type BrowserContext } from "playwright";
import * as db from "./db.js";
import {
  ACCOUNTS_DIR,
  accountProofDir,
  accountStorageStatePath,
  HOYOLAB_SIGNIN_URL,
} from "../config.js";
import { writeBundle } from "../bundle.js";
import { pushSecrets } from "../github.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(__dirname, "public");
const HOST = process.env.WEB_HOST || "127.0.0.1";
const PORT = Number(process.env.WEB_PORT || 8787);

await mkdir(ACCOUNTS_DIR, { recursive: true });

type LoginSession = { browser: Browser; context: BrowserContext };
const loginSessions = new Map<string, LoginSession>();

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(data);
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk.toString();
      if (raw.length > 1_000_000) reject(new Error("Body too large"));
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

async function regenerateAndPush(): Promise<{ ok: boolean; output: string }> {
  const value = await writeBundle();
  const result = await pushSecrets(value);
  return result;
}

function runCheckinProcess(accountId?: string): Promise<{ results: unknown[]; output: string; code: number | null }> {
  const args = ["tsx", "src/checkin.ts"];
  if (accountId) args.push("--account", accountId);
  else args.push("--all");

  return new Promise((resolve) => {
    const child = spawn("npx", args, {
      cwd: process.cwd(),
      env: { ...process.env, HEADLESS: "true" },
      stdio: ["ignore", "pipe", "pipe"],
      shell: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => {
      const lines = stdout
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      resolve({ results: lines, output: stdout + stderr, code });
    });
    child.on("error", (err) => resolve({ results: [], output: err.message, code: null }));
  });
}

function statusToDb(status: string): "success" | "failed" | "noop" | "unknown" {
  if (status === "checked_in") return "success";
  if (status === "failed") return "failed";
  if (status === "noop") return "noop";
  return "unknown";
}

async function serveStatic(req: IncomingMessage, res: ServerResponse, urlPath: string): Promise<void> {
  const rel = urlPath === "/" ? "/index.html" : urlPath;
  const target = resolve(PUBLIC_DIR, "." + rel);
  if (!target.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  if (!existsSync(target)) {
    res.writeHead(404).end("Not found");
    return;
  }
  const data = await readFile(target);
  res.writeHead(200, { "Content-Type": MIME[extname(target)] || "application/octet-stream" });
  res.end(data);
}

async function serveProof(req: IncomingMessage, res: ServerResponse, parts: string[]): Promise<void> {
  const [id, file] = parts;
  if (!id || !file || file.includes("..") || id.includes("..")) {
    res.writeHead(400).end("Bad request");
    return;
  }
  const target = resolve(accountProofDir(id), file);
  if (!target.startsWith(accountProofDir(id))) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  if (!existsSync(target)) {
    res.writeHead(404).end("No proof");
    return;
  }
  const data = await readFile(target);
  res.writeHead(200, { "Content-Type": "image/png" });
  res.end(data);
}

async function handleApi(req: IncomingMessage, res: ServerResponse, parts: string[]): Promise<void> {
  const method = req.method || "GET";

  if (req.url?.startsWith("/api/accounts") && parts[1] === "accounts") {
    if (method === "GET" && parts.length === 2) {
      const accounts = db.listAccounts().map((a) => {
        let proofDay: string | null = null;
        try {
          const dir = accountProofDir(a.id);
          if (existsSync(dir)) {
            const pngs = readdirSyncFs(dir).filter((f) => /^\d{2}\.png$/.test(f));
            if (pngs.length > 0) proofDay = pngs.sort().pop()!.replace(".png", "");
          }
        } catch {
          proofDay = null;
        }
        return { ...a, proofDay };
      });
      return sendJson(res, 200, { accounts });
    }

    if (method === "POST" && parts.length === 2) {
      const body = (await readBody(req)) as { name?: string };
      const name = (body.name || "").trim();
      if (!name) return sendJson(res, 400, { error: "Le nom du compte est requis." });

      const id = randomUUID();
      db.createAccount(id, name);

      let browser: Browser;
      try {
        browser = await chromium.launch({ headless: false });
      } catch (err) {
        db.deleteAccount(id);
        return sendJson(res, 500, { error: `Impossible de lancer le navigateur: ${(err as Error).message}` });
      }
      const context = await browser.newContext({ locale: "fr-FR", viewport: { width: 1280, height: 900 } });
      const page = await context.newPage();
      await page.goto(HOYOLAB_SIGNIN_URL, { waitUntil: "domcontentloaded" });
      loginSessions.set(id, { browser, context });

      return sendJson(res, 201, {
        id,
        name,
        message: "Connecte-toi dans la fenetre ouverte, puis clique 'Sauvegarder'.",
      });
    }

    const id = parts[2];
    if (!id || !db.getAccount(id)) return sendJson(res, 404, { error: "Compte introuvable." });

    if (method === "POST" && parts[3] === "commit-login") {
      const session = loginSessions.get(id);
      if (!session) return sendJson(res, 400, { error: "Aucune session de connexion en cours pour ce compte." });

      const cookies = await session.context.cookies();
      const names = new Set(cookies.map((c) => c.name));
      const required = ["ltuid_v2", "ltoken_v2", "account_id_v2", "cookie_token_v2"];
      const missing = required.filter((n) => !names.has(n));
      if (missing.length > 0) {
        await session.browser.close().catch(() => undefined);
        loginSessions.delete(id);
        db.deleteAccount(id);
        return sendJson(res, 400, {
          error: `Session Hoyolab incomplete (cookies manquants: ${missing.join(", ")}). Reconnecte-toi completement (jusqu'au tableau de bord Hoyolab), puis clique Sauvegarder.`,
        });
      }

      try {
        await session.context.storageState({ path: accountStorageStatePath(id), indexedDB: true });
      } catch (err) {
        return sendJson(res, 500, { error: `Echec de la sauvegarde: ${(err as Error).message}` });
      } finally {
        await session.browser.close().catch(() => undefined);
        loginSessions.delete(id);
      }

      db.setActive(id, 1);
      const push = await regenerateAndPush();
      return sendJson(res, 200, {
        id,
        status: "saved",
        push: push.output,
        pushOk: push.ok,
      });
    }

    if (method === "DELETE" && parts.length === 3) {
      const session = loginSessions.get(id);
      if (session) {
        await session.browser.close().catch(() => undefined);
        loginSessions.delete(id);
      }
      await rm(accountStorageStatePath(id), { force: true });
      await rm(accountProofDir(id), { recursive: true, force: true });
      db.deleteAccount(id);
      const push = await regenerateAndPush();
      return sendJson(res, 200, { deleted: id, push: push.output, pushOk: push.ok });
    }
  }

  if (method === "POST" && parts[1] === "run") {
    const body = (await readBody(req)) as { accountId?: string };
    const accountId = body.accountId;
    if (accountId && !db.getAccount(accountId)) {
      return sendJson(res, 404, { error: "Compte introuvable." });
    }
    const { results, output } = await runCheckinProcess(accountId);
    for (const r of results as Array<{ accountId?: string; status: string }>) {
      if (r.accountId) db.updateRun(r.accountId, statusToDb(r.status), new Date().toISOString());
    }
    return sendJson(res, 200, { results, output });
  }

  if (method === "POST" && parts[1] === "push-secrets") {
    const push = await regenerateAndPush();
    return sendJson(res, push.ok ? 200 : 502, { output: push.output, ok: push.ok });
  }

  return sendJson(res, 404, { error: "Endpoint inconnu." });
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);
    const pathname = decodeURIComponent(url.pathname);
    const parts = pathname.split("/").filter(Boolean);

    if (pathname.startsWith("/api/")) {
      return await handleApi(req, res, parts);
    }
    if (pathname.startsWith("/proofs/")) {
      return await serveProof(req, res, parts.slice(1));
    }
    return await serveStatic(req, res, pathname);
  } catch (err) {
    sendJson(res, 500, { error: (err as Error).message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Web app running at http://${HOST}:${PORT}`);
});
