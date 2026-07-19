// discovery.js
// Invocation schemas + examples for the services added after the original
// catalog (llm.summarize onward). Merged into SERVICE_SCHEMAS/SERVICE_EXAMPLES
// in server.js so every discovery surface (.well-known/x402, openapi.json,
// 402 bazaar extension) advertises the full catalog and can never drift.

export const EXTRA_SCHEMAS = {
  "llm.summarize": {
    input: {
      type: "object",
      properties: {
        text: { type: "string", minLength: 1, description: "Text to summarize (up to ~24k chars)" },
        style: { type: "string", enum: ["bullets", "paragraph"], description: "Output style, default paragraph" },
      },
      required: ["text"],
    },
    output: {
      type: "object",
      properties: { summary: { type: "string" }, eval_count: { type: "number" } },
    },
  },
  "llm.extract": {
    input: {
      type: "object",
      properties: {
        text: { type: "string", minLength: 1, description: "Source text (up to ~24k chars)" },
        schema: { type: "object", description: "Shape of the JSON you want back, e.g. {\"name\":\"string\",\"amount\":\"number\"}" },
      },
      required: ["text", "schema"],
    },
    output: { type: "object", properties: { data: { type: "object", description: "Extracted JSON matching your schema" } } },
  },
  "llm.embed": {
    input: {
      type: "object",
      properties: { text: { type: "string", minLength: 1, description: "Text to embed (up to 8k chars)" } },
      required: ["text"],
    },
    output: {
      type: "object",
      properties: { embedding: { type: "array", items: { type: "number" } }, dim: { type: "number" } },
    },
  },
  "image.generate": {
    input: {
      type: "object",
      properties: {
        prompt: { type: "string", minLength: 1, description: "Image prompt" },
        width: { type: "number", description: "256-1024, default 1024" },
        height: { type: "number", description: "256-1024, default 1024" },
        seed: { type: "number", description: "Optional seed for reproducibility" },
      },
      required: ["prompt"],
    },
    output: {
      type: "object",
      properties: {
        image_base64: { type: "string", description: "PNG, base64" },
        width: { type: "number" }, height: { type: "number" },
        model: { type: "string" }, format: { type: "string" },
      },
    },
  },
  "image.upscale": {
    input: {
      type: "object",
      properties: { image_base64: { type: "string", minLength: 1, description: "PNG/JPEG, base64, max 4MB decoded" } },
      required: ["image_base64"],
    },
    output: {
      type: "object",
      properties: {
        image_base64: { type: "string", description: "PNG at 4x resolution, base64" },
        scale: { type: "number" }, model: { type: "string" }, format: { type: "string" },
      },
    },
  },
  "video.generate": {
    input: {
      type: "object",
      properties: {
        prompt: { type: "string", minLength: 1, description: "Video prompt" },
        negative: { type: "string", description: "Optional negative prompt" },
        frames: { type: "number", description: "9-49 frames (~0.5-3s at 16fps), default 33" },
        seed: { type: "number", description: "Optional seed" },
      },
      required: ["prompt"],
    },
    output: {
      type: "object",
      description: "ASYNC: the paid response returns {status:'accepted', job_id, poll}; poll /v1/results/{job_id} until status 'done', then read result below.",
      properties: {
        video_webp_base64: { type: "string", description: "Animated WebP, base64" },
        frames: { type: "number" }, fps: { type: "number" },
        width: { type: "number" }, height: { type: "number" }, model: { type: "string" },
      },
    },
  },
};

export const EXTRA_EXAMPLES = {
  "llm.summarize": {
    body: { text: "The x402 protocol turns HTTP 402 into a payment flow: a server quotes a price, the client pays on-chain, then retries with proof of payment.", style: "paragraph" },
    output: { summary: "x402 turns HTTP 402 into an on-chain pay-per-request flow.", eval_count: 14 },
  },
  "llm.extract": {
    body: { text: "Invoice #4021 from VILANO for 12.50 USDC due 2026-08-01", schema: { invoice: "string", amount: "number", due: "string" } },
    output: { data: { invoice: "4021", amount: 12.5, due: "2026-08-01" } },
  },
  "llm.embed": {
    body: { text: "machine-payable GPU compute" },
    output: { embedding: [0.0123, -0.0456, 0.0789], dim: 4096 },
  },
  "image.generate": {
    body: { prompt: "molten metal pouring over a silicon wafer, macro, cinematic", width: 768, height: 768 },
    output: { image_base64: "iVBORw0KGgo…", width: 768, height: 768, model: "flux1-schnell-fp8", format: "png" },
  },
  "image.upscale": {
    body: { image_base64: "iVBORw0KGgo…" },
    output: { image_base64: "iVBORw0KGgo…", scale: 4, model: "RealESRGAN_x4plus", format: "png" },
  },
  "video.generate": {
    body: { prompt: "a blacksmith hammering glowing metal, sparks flying, cinematic", frames: 33 },
    output: { status: "accepted", job_id: "0x…txhash", poll: "/v1/results/0x…txhash", eta_seconds: 240 },
  },
};
