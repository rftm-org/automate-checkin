import { spawn } from "node:child_process";

export const SECRET_NAME = process.env.ACCOUNTS_SECRET_NAME || "HOYOLAB_ACCOUNTS_B64";

export function pushSecrets(value: string): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const child = spawn("gh", ["secret", "set", SECRET_NAME], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdin.write(value);
    child.stdin.end();
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => {
      const output = stdout + stderr;
      if (code === 0) {
        resolve({ ok: true, output: `Secret ${SECRET_NAME} updated (${value.length} bytes).` });
      } else {
        resolve({ ok: false, output: `gh failed (code ${code}): ${output.trim() || "no output"}` });
      }
    });
    child.on("error", (err) => {
      resolve({ ok: false, output: `Could not run gh CLI: ${err.message}` });
    });
  });
}
