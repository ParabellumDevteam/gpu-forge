// async-jobs.js
// Result store for long-running paid jobs (video generation outlives the
// Cloudflare tunnel's ~100s response window, so those jobs are accepted
// immediately and polled). A job's id is the paid tx hash: unguessable,
// single-use, and recorded by the paywall before the job starts.

import fs from "node:fs";
import path from "node:path";

const DIR = process.env.RESULTS_DIR || "/var/lib/gpu-forge/results";
fs.mkdirSync(DIR, { recursive: true });

const live = new Map();
const file = (id) => path.join(DIR, id.replace(/[^0-9a-zA-Zx]/g, "") + ".json");

// Sweep results older than 7 days on boot.
for (const f of fs.readdirSync(DIR)) {
  try {
    const p = path.join(DIR, f);
    if (Date.now() - fs.statSync(p).mtimeMs > 7 * 86400_000) fs.unlinkSync(p);
  } catch { /* ignore */ }
}

export function startJob(id, service, svc, body) {
  const running = { status: "running", service, pid: process.pid, started_at: new Date().toISOString() };
  live.set(id, { status: "running", service, started_at: running.started_at });
  fs.writeFileSync(file(id), JSON.stringify(running));
  svc
    .handler(body)
    .then((result) => {
      const done = { status: "done", service, result, finished_at: new Date().toISOString() };
      live.set(id, done);
      fs.writeFileSync(file(id), JSON.stringify(done));
    })
    .catch((e) => {
      const failed = {
        status: "failed",
        service,
        error: e.message,
        note: "Payment was consumed. Contact operator with the tx hash for a rerun.",
        finished_at: new Date().toISOString(),
      };
      live.set(id, failed);
      fs.writeFileSync(file(id), JSON.stringify(failed));
    });
  return {
    status: "accepted",
    job_id: id,
    poll: `/v1/results/${id}`,
    eta_seconds: svc.etaSeconds || 600,
    note: "Async job accepted. Poll the result URL; results are retained for 7 days.",
  };
}

export function getJob(id) {
  if (live.has(id)) return live.get(id);
  try {
    const j = JSON.parse(fs.readFileSync(file(id), "utf8"));
    if (j.status === "running") {
      return { ...j, status: "interrupted", note: "Server restarted mid-job. Contact operator with the tx hash for a rerun." };
    }
    return j;
  } catch {
    return null;
  }
}
