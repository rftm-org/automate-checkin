import { writeBundle } from "./bundle.js";
import { pushSecrets } from "./github.js";

async function main(): Promise<void> {
  const value = await writeBundle();
  const result = await pushSecrets(value);
  console.log(result.output);
  if (!result.ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
