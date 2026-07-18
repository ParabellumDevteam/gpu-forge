// Sanity-check the CDP API key against the facilitator BEFORE flipping prod:
// calls GET /supported with JWT auth. Exits 0 with the supported kinds on
// success, 1 with the error otherwise. Reads CDP_API_KEY_ID/SECRET from .env.
import { createFacilitatorConfig } from "@coinbase/x402";
import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

dotenv.config({ path: join(dirname(fileURLToPath(import.meta.url)), "..", ".env") });

if (!process.env.CDP_API_KEY_ID || !process.env.CDP_API_KEY_SECRET) {
  console.error("CDP_API_KEY_ID / CDP_API_KEY_SECRET not set in gpu-forge/.env");
  process.exit(1);
}

const cfg = createFacilitatorConfig(process.env.CDP_API_KEY_ID, process.env.CDP_API_KEY_SECRET);
const headers = (await cfg.createAuthHeaders()).supported;
const res = await fetch(`${cfg.url}/supported`, { headers });
const body = await res.text();
if (!res.ok) {
  console.error(`Facilitator /supported failed: HTTP ${res.status}\n${body.slice(0, 400)}`);
  process.exit(1);
}
const kinds = JSON.parse(body).kinds || [];
console.log(`CDP key VALID. Facilitator supports ${kinds.length} kinds, incl:`);
for (const k of kinds.filter((k) => ["eip155:8453", "eip155:137"].includes(k.network))) {
  console.log(` - ${k.scheme} on ${k.network}`);
}
