// server.js
// GPU Forge: machine-payable GPU inference API (x402-style, USDC on Polygon).
//
// Protocol (agent-friendly, no accounts, no API keys):
//   1. GET  /v1/services            -> price list (machine readable)
//   2. POST /v1/jobs/:service       -> without payment: HTTP 402 + payment quote
//   3. Agent sends USDC on Polygon to payTo for the quoted amount
//   4. POST /v1/jobs/:service again with header  X-Payment-Tx: 0x<hash>
//      -> server verifies on-chain, marks hash redeemed, runs job, returns result
//
// Each tx hash is single-use (replay-protected via SQLite ledger).

import "dotenv/config";
import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import { hasPayment, recordPayment, revenueSummary } from "./ledger.js";
import { verifyPayment, usdcToUnits, paymentInfo, NETWORKS } from "./payment.js";
import { parsePaymentHeader, settlePayment, settlementEnabled, settlementResponseHeader } from "./x402-settle.js";
import { CATALOG } from "./services.js";

const PORT = Number(process.env.PORT || 4402);
const HOST = process.env.HOST || "0.0.0.0";

// Payment ledger: replay protection + revenue log (see ledger.js)

// ---------- server ----------
// trustProxy: behind Cloudflare Tunnel every request arrives from 127.0.0.1;
// without it the rate limiter would throttle all clients as one IP.
const app = Fastify({ logger: true, bodyLimit: 10 * 1024 * 1024, trustProxy: true });

// await so the limiter's onRoute hook is installed before the routes below are defined
await app.register(rateLimit, {
  max: (req) => (req.method === "POST" ? 30 : 120),
  timeWindow: "1 minute",
});

app.get("/", async () => ({
  name: "GPU Forge",
  description: "Machine-payable GPU compute. AI agents welcome. Pay per call in USDC on Base or Polygon, no signup.",
  protocol: "x402-style: POST a job, receive 402 with a quote, pay, retry with X-Payment-Tx header.",
  services: "/v1/services",
}));

const BASE_URL = process.env.PUBLIC_BASE_URL || "https://forge.parabellum.tech";

// Per-service invocation schemas, shared by the 402 body and /openapi.json
// so the two discovery surfaces can never drift apart.
const SERVICE_SCHEMAS = {
  "gpu.probe": {
    input: { type: "object", properties: {}, additionalProperties: false },
    output: {
      type: "object",
      properties: { gpu: { type: "string", description: "name, VRAM total/used, utilization, temperature" } },
    },
  },
  "llm.generate": {
    input: {
      type: "object",
      properties: {
        prompt: { type: "string", minLength: 1, description: "The prompt to generate from" },
        model: { type: "string", description: "Optional Ollama model name, defaults to llama3.1:8b" },
        max_tokens: { type: "number", description: "Max tokens to generate, capped at 2048" },
      },
      required: ["prompt"],
    },
    output: {
      type: "object",
      properties: {
        model: { type: "string" },
        response: { type: "string" },
        eval_count: { type: "number" },
      },
    },
  },
};

// Concrete request/response examples per service. The Bazaar discovery
// extension validates its info block against the schema above, so each
// example must conform to the matching SERVICE_SCHEMAS entry.
const SERVICE_EXAMPLES = {
  "gpu.probe": {
    body: {},
    output: { gpu: "NVIDIA RTX 4000 Ada Generation, 20475 MiB total, 2011 MiB used, 3 % util, 41 C" },
  },
  "llm.generate": {
    body: { prompt: "Say hello in one short sentence.", max_tokens: 64 },
    output: { model: "llama3.1:8b", response: "Hello there, nice to meet you!", eval_count: 9 },
  },
};

// x402 v2 PaymentRequired body (spec: coinbase/x402 specs/x402-specification-v2.md).
// Settlement here is by direct on-chain transfer + X-Payment-Tx, not a signed
// payment header, so `extra.instructions` spells out the flow for agents.
// maxAmountRequired is kept alongside `amount` for legacy v1 parsers.
function paymentRequirements(name, svc) {
  const units = usdcToUnits(svc.priceUsd).toString();
  const schemas = SERVICE_SCHEMAS[name];
  return {
    x402Version: 2,
    error: "X-Payment-Tx header is required",
    resource: {
      url: `${BASE_URL}/v1/jobs/${name}`,
      description: `${name}: ${svc.description}`,
      mimeType: "application/json",
    },
    accepts: NETWORKS.map((net) => ({
      scheme: "exact",
      network: `eip155:${net.chainId}`,
      amount: units,
      maxAmountRequired: units,
      asset: net.usdc,
      payTo: paymentInfo.payTo,
      maxTimeoutSeconds: 300,
      ...(schemas && {
        outputSchema: {
          input: { type: "http", method: "POST", bodyType: "json", body: schemas.input },
          output: schemas.output,
        },
      }),
      extra: {
        name: "USD Coin",
        version: "2",
        chainId: net.chainId,
        decimals: 6,
        amountUsd: svc.priceUsd,
        settlement: "direct-transfer",
        instructions: `Send the exact USDC amount on ${net.key} (chainId ${net.chainId}) to payTo, then retry this request with header X-Payment-Tx: 0x<txhash>. Each tx hash is single-use.`,
      },
    })),
    // Bazaar discovery extension, canonical Coinbase shape (BodyDiscoveryExtension
    // in coinbase/x402 extensions/src/bazaar/http/types.ts): an `info` block with a
    // concrete example invocation, validated against `schema`. The same paths also
    // feed x402scan/agentcash, which read schema.properties.input.properties.body
    // and schema.properties.output.properties.example.
    extensions: schemas
      ? {
          bazaar: {
            info: {
              input: {
                type: "http",
                method: "POST",
                bodyType: "json",
                body: SERVICE_EXAMPLES[name]?.body ?? {},
              },
              output: { type: "object", example: SERVICE_EXAMPLES[name]?.output ?? {} },
            },
            schema: {
              $schema: "https://json-schema.org/draft/2020-12/schema",
              type: "object",
              properties: {
                input: {
                  type: "object",
                  properties: {
                    type: { type: "string", const: "http" },
                    method: { type: "string", enum: ["POST"] },
                    bodyType: { type: "string", enum: ["json"] },
                    body: schemas.input,
                  },
                  required: ["type", "method", "bodyType", "body"],
                },
                output: { type: "object", properties: { example: schemas.output } },
              },
              required: ["input"],
            },
          },
        }
      : {},
  };
}

// Minimal inline favicon so discovery crawlers do not warn on a missing one.
app.get("/favicon.ico", async (req, reply) => {
  reply.header("content-type", "image/svg+xml").header("cache-control", "public, max-age=86400");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="3" fill="#111"/><path d="M4 12V4h8v2H6v2h5v2H6v2z" fill="#7CFC9B"/></svg>`;
});

// Discovery manifest: every sellable resource with its payment requirements.
app.get("/.well-known/x402", async () => ({
  x402Version: 1,
  resources: Object.entries(CATALOG).map(([name, svc]) => paymentRequirements(name, svc).accepts[0]),
}));

// OpenAPI discovery document (x402scan et al. read this at /openapi.json).
// Only services that deliver real output are listed; catalog stubs are omitted.
const paidResponses = (outputSchema) => ({
  200: {
    description: "Successful response (payment redeemed)",
    content: { "application/json": { schema: outputSchema } },
  },
  402: { description: "Payment Required" },
});
const paidReceipt = {
  type: "object",
  properties: {
    service: { type: "string" },
    paid: {
      type: "object",
      properties: {
        txHash: { type: "string" },
        payer: { type: "string" },
        amountUsdc: { type: "number" },
      },
    },
  },
};
const openapiDoc = () => ({
  openapi: "3.1.0",
  info: {
    title: "GPU Forge",
    version: "1.0.0",
    description:
      "Machine-payable GPU compute. Pay per call in USDC on Base or Polygon, no accounts, no API keys.",
    "x-guidance":
      "Each POST endpoint returns HTTP 402 with an x402 quote when called without payment. Send the exact USDC amount on Base (chainId 8453) or Polygon (chainId 137) to the quoted payTo address, then retry the same request with header X-Payment-Tx: 0x<transaction hash>. Each transaction hash is single use. Use POST /v1/jobs/gpu.probe (0.01 USD) to verify live GPU capacity, and POST /v1/jobs/llm.generate (0.05 USD) for text generation with a JSON body containing a prompt field.",
    contact: { email: "admin@parabellum.tech" },
  },
  servers: [{ url: BASE_URL }],
  paths: {
    "/v1/jobs/gpu.probe": {
      post: {
        operationId: "gpuProbe",
        summary: "GPU probe: live nvidia-smi capacity check",
        tags: ["GPU"],
        "x-payment-info": {
          price: { mode: "fixed", currency: "USD", amount: CATALOG["gpu.probe"].priceUsd },
          protocols: [{ x402: {} }],
        },
        requestBody: {
          required: false,
          content: { "application/json": { schema: SERVICE_SCHEMAS["gpu.probe"].input } },
        },
        responses: paidResponses({
          ...paidReceipt,
          properties: { ...paidReceipt.properties, result: SERVICE_SCHEMAS["gpu.probe"].output },
        }),
      },
    },
    "/v1/jobs/llm.generate": {
      post: {
        operationId: "llmGenerate",
        summary: "LLM text generation on a locally hosted open model",
        tags: ["LLM"],
        "x-payment-info": {
          price: { mode: "fixed", currency: "USD", amount: CATALOG["llm.generate"].priceUsd },
          protocols: [{ x402: {} }],
        },
        requestBody: {
          required: true,
          content: { "application/json": { schema: SERVICE_SCHEMAS["llm.generate"].input } },
        },
        responses: paidResponses({
          ...paidReceipt,
          properties: { ...paidReceipt.properties, result: SERVICE_SCHEMAS["llm.generate"].output },
        }),
      },
    },
  },
});
app.get("/openapi.json", async () => openapiDoc());

app.get("/v1/services", async () => ({
  payment: paymentInfo,
  services: Object.fromEntries(
    Object.entries(CATALOG).map(([name, s]) => [
      name,
      { priceUsd: s.priceUsd, description: s.description, endpoint: `/v1/jobs/${name}` },
    ])
  ),
}));

app.get("/v1/revenue", async (req, reply) => {
  // Simple admin endpoint. Protect it.
  if ((req.headers["x-admin-key"] || "") !== (process.env.ADMIN_KEY || "")) {
    return reply.code(401).send({ error: "unauthorized" });
  }
  return { revenue: revenueSummary() };
});

// GET is allowed so discovery probes always reach the 402 challenge;
// execution with a payment header works on either method.
app.route({ method: ["GET", "POST"], url: "/v1/jobs/:service", handler: async (req, reply) => {
  const name = req.params.service;
  const svc = CATALOG[name];
  if (!svc) return reply.code(404).send({ error: "Unknown service", services: Object.keys(CATALOG) });

  const txHash = String(req.headers["x-payment-tx"] || "").trim();
  const signedPayment = req.headers["payment-signature"] || req.headers["x-payment"];

  // Standard x402 flow: a signed EIP-3009 authorization we settle ourselves.
  if (!txHash && signedPayment && settlementEnabled()) {
    let parsed;
    try {
      parsed = parsePaymentHeader(signedPayment);
    } catch (e) {
      const pr = paymentRequirements(name, svc);
      reply.header("payment-required", Buffer.from(JSON.stringify(pr)).toString("base64"));
      return reply.code(402).send({ ...pr, error: "payment_invalid", detail: e.message });
    }
    const settle = await settlePayment(parsed, usdcToUnits(svc.priceUsd));
    if (!settle.ok) {
      const pr = paymentRequirements(name, svc);
      reply.header("payment-required", Buffer.from(JSON.stringify(pr)).toString("base64"));
      return reply.code(402).send({ ...pr, error: "payment_invalid", detail: settle.error });
    }

    // Record BEFORE running the job so a crash cannot allow double-spend
    recordPayment(settle.txHash, settle.payer, name, settle.amountUnits, settle.network);
    reply.header("access-control-expose-headers", "PAYMENT-RESPONSE,X-PAYMENT-RESPONSE");
    reply.header("payment-response", settlementResponseHeader(settle));
    reply.header("x-payment-response", settlementResponseHeader(settle));
    try {
      const result = await svc.handler(req.body || {});
      return {
        service: name,
        paid: { txHash: settle.txHash, payer: settle.payer, amountUsdc: Number(settle.amountUnits) / 1e6 },
        result,
      };
    } catch (e) {
      req.log.error(e);
      return reply.code(500).send({
        error: "job_failed",
        detail: e.message,
        note: "Payment was settled. Contact operator with the tx hash for a rerun.",
        txHash: settle.txHash,
      });
    }
  }

  // No payment yet: respond 402 with a machine-readable quote.
  // x402 v2 HTTP transport carries the PaymentRequired object base64-encoded
  // in the PAYMENT-REQUIRED header; the JSON body is a human-friendly copy.
  if (!txHash) {
    const pr = paymentRequirements(name, svc);
    reply.header("payment-required", Buffer.from(JSON.stringify(pr)).toString("base64"));
    return reply.code(402).send(pr);
  }

  // Replay protection
  if (hasPayment(txHash)) {
    return reply.code(409).send({ error: "This payment tx has already been redeemed" });
  }

  // On-chain verification
  const minUnits = usdcToUnits(svc.priceUsd);
  const check = await verifyPayment(txHash, minUnits);
  if (!check.ok) {
    const pr = paymentRequirements(name, svc);
    reply.header("payment-required", Buffer.from(JSON.stringify(pr)).toString("base64"));
    return reply.code(402).send({ ...pr, error: "payment_invalid", detail: check.error });
  }

  // Record BEFORE running the job so a crash cannot allow double-spend
  recordPayment(txHash, check.payer, name, check.amountUnits, check.network);

  // Run the GPU job
  try {
    const result = await svc.handler(req.body || {});
    return {
      service: name,
      paid: { txHash, payer: check.payer, amountUsdc: Number(check.amountUnits) / 1e6 },
      result,
    };
  } catch (e) {
    req.log.error(e);
    return reply.code(500).send({
      error: "job_failed",
      detail: e.message,
      note: "Payment was consumed. Contact operator with the tx hash for a rerun.",
      txHash,
    });
  }
}});

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.once(sig, () => {
    app.log.info({ sig }, "shutting down");
    app.close().then(() => process.exit(0));
  });
}

app.listen({ port: PORT, host: HOST }).then(() => {
  console.log(`GPU Forge listening on ${HOST}:${PORT}`);
  if (!process.env.PAY_TO) console.warn("WARNING: PAY_TO not set, payments cannot verify");
});
