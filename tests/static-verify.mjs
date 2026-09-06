import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configs = ["providers/bai/wrangler.toml", "providers/dahl/wrangler.toml", "router/wrangler.toml"];
let failed = 0;
function check(name, ok) { if (ok) console.log(`✔ ${name}`); else { failed++; console.error(`✘ ${name}`); } }
for (const file of configs) {
  const text = await readFile(path.join(root, file), "utf8");
  check(`${file}: compatibility date`, /compatibility_date="2026-09-05"/.test(text));
  check(`${file}: workers_dev`, /workers_dev=(true|false)/.test(text));
  check(`${file}: main`, /main="[^"]+"/.test(text));
  if (file.startsWith("providers/")) {
    check(`${file}: SQLite Durable Object`, /new_sqlite_classes=\["ApiKeyCoordinator"\]/.test(text));
    check(`${file}: retry budget`, /MAX_RETRY_TIME_MS="/.test(text));
    check(`${file}: upstream timeout`, /UPSTREAM_TIMEOUT_MS="25000"/.test(text));
    check(`${file}: quota controls`, /DAILY_TOKEN_LIMIT="/.test(text) && /MONTHLY_TOKEN_LIMIT="/.test(text));
  } else {
    check(`${file}: service bindings`, /\[\[services\]\]/.test(text));
    check(`${file}: router secret`, /required=\["ROUTER_API_KEY"\]/.test(text));
  }
}
console.log(`\nSTATIC RESULT: ${failed === 0 ? "PASS" : "FAIL"}`);
if (failed) process.exitCode = 1;
