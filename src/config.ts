import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export const HOYOLAB_SIGNIN_URL =
  "https://act.hoyolab.com/ys/event/signin-sea-v3/index.html?act_id=e202102251931481&hyl_auth_required=true&hyl_presentation_style=fullscreen&lang=fr-fr";

export const DEFAULT_STORAGE_STATE_PATH = ".auth/hoyolab-storage-state.json";
export const DEFAULT_PROOF_DIR = "output/proofs";

export function parisDate(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const value = (type: string) => {
    const part = parts.find((item) => item.type === type);
    if (!part) {
      throw new Error(`Could not format Europe/Paris date part: ${type}`);
    }
    return part.value;
  };

  return `${value("year")}-${value("month")}-${value("day")}`;
}

export function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

export function isHeadless(): boolean {
  if (hasFlag("--headed")) {
    return false;
  }
  if (hasFlag("--headless")) {
    return true;
  }
  return process.env.HEADLESS !== "false";
}

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export async function storageStatePath(): Promise<string> {
  const configuredPath = process.env.HOYOLAB_STORAGE_STATE_PATH || DEFAULT_STORAGE_STATE_PATH;
  const path = resolve(configuredPath);

  if (process.env.HOYOLAB_STORAGE_STATE_B64) {
    await ensureDir(dirname(path));
    await writeFile(path, Buffer.from(process.env.HOYOLAB_STORAGE_STATE_B64, "base64"));
  }

  return path;
}

export function proofPath(kind = "checkin"): string {
  const proofDir = resolve(process.env.PROOF_DIR || DEFAULT_PROOF_DIR);
  return resolve(proofDir, `hoyolab-${kind}-${parisDate()}.png`);
}
