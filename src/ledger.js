// ledger.js
// Minimal append-only payment ledger (JSON file, atomic writes).
// Zero native dependencies so it deploys anywhere. If you outgrow it,
// swap for your existing PostgreSQL: same three functions.

import fs from "node:fs";
import path from "node:path";

const FILE = process.env.DB_PATH || "./forge-ledger.json";

let data = { payments: {} };
try {
  if (fs.existsSync(FILE)) data = JSON.parse(fs.readFileSync(FILE, "utf8"));
} catch {
  // corrupted file: back it up rather than losing replay protection silently
  fs.renameSync(FILE, FILE + ".corrupt." + Date.now());
}

function persist() {
  const tmp = FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, FILE); // atomic on same filesystem
}

export function hasPayment(txHash) {
  return Boolean(data.payments[txHash]);
}

export function recordPayment(txHash, payer, service, amountUnits, network) {
  data.payments[txHash] = {
    payer,
    service,
    amount: amountUnits,
    ...(network && { network }),
    at: new Date().toISOString(),
  };
  persist();
}

export function revenueSummary() {
  const byService = {};
  for (const p of Object.values(data.payments)) {
    byService[p.service] ??= { jobs: 0, usdc: 0 };
    byService[p.service].jobs += 1;
    byService[p.service].usdc += Number(p.amount) / 1e6;
  }
  return byService;
}

export function ledgerPath() {
  return path.resolve(FILE);
}
