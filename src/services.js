// services.js
// The catalog of GPU services you sell, and the adapters that run them.
// Prices are in USDC. Adjust freely: this is your margin lever.
//
// Each handler receives the JSON body of the job request and must return
// a JSON-serializable result. Adapters shell out or proxy to whatever is
// actually running on the GPU (Ollama/vLLM, whisper.cpp, ComfyUI, etc).

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

const OLLAMA_URL = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
const COMFY_URL = process.env.COMFY_URL || "http://127.0.0.1:8188";

// GPU capacity is on-demand: the controller on this host maintains a heartbeat
// file while a GPU droplet is up. Services flagged `gpu: true` are refused
// BEFORE any payment is taken when no GPU is live (see server.js).
export const GPU_STATUS_FILE = process.env.GPU_STATUS_FILE || "/var/lib/gpu-forge/gpu-status.json";

export async function gpuStatus() {
  // Prefer the controller heartbeat (gpu-forge runs on the CPU box).
  try {
    const fs = await import("node:fs/promises");
    const s = JSON.parse(await fs.readFile(GPU_STATUS_FILE, "utf8"));
    if (Date.now() - new Date(s.at).getTime() < 90_000) return { up: true, smi: s.smi, source: "controller" };
  } catch {
    /* no heartbeat file */
  }
  // Fallback: local GPU (pre-split behavior, keeps working on a GPU host).
  try {
    const { stdout } = await run("nvidia-smi", [
      "--query-gpu=name,memory.total,memory.used,utilization.gpu,temperature.gpu",
      "--format=csv,noheader",
    ]);
    return { up: true, smi: stdout.trim(), source: "local" };
  } catch {
    return { up: false };
  }
}

export const CATALOG = {
  "gpu.probe": {
    priceUsd: "0.01",
    gpu: true,
    description: "Returns live nvidia-smi output. Cheap way for agents to verify real GPU capacity before buying bigger jobs.",
    handler: async () => {
      const s = await gpuStatus();
      if (!s.up) throw new Error("GPU offline");
      return { gpu: s.smi };
    },
  },

  "llm.generate": {
    priceUsd: "0.05",
    gpu: true,
    description: "Text generation on a locally hosted open model via Ollama/vLLM (OpenAI-compatible or Ollama API). Body: { model, prompt, max_tokens? }",
    handler: async (body) => {
      const res = await fetch(`${OLLAMA_URL}/api/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: body.model || process.env.DEFAULT_MODEL || "llama3.1:8b",
          prompt: String(body.prompt || ""),
          stream: false,
          options: { num_predict: Math.min(Number(body.max_tokens || 512), 2048) },
        }),
      });
      if (!res.ok) throw new Error(`LLM backend error ${res.status}`);
      const data = await res.json();
      return { model: data.model, response: data.response, eval_count: data.eval_count };
    },
  },

  // Disabled until whisper.cpp is installed on this host: buying this service
  // would consume the payment and then fail. Re-enable after installing
  // whisper-cli and setting WHISPER_MODEL in .env.
  // "audio.transcribe": {
  //   priceUsd: "0.03",
  //   description: "Whisper transcription via whisper.cpp server or local binary. Body: { audio_url } (server downloads and transcribes).",
  //   handler: async (body) => {
  //     if (!body.audio_url) throw new Error("audio_url required");
  //     // Download to /tmp then run whisper.cpp. Adjust binary/model paths on your host.
  //     const tmp = `/tmp/job-${Date.now()}.audio`;
  //     const dl = await fetch(body.audio_url);
  //     if (!dl.ok) throw new Error("Could not download audio");
  //     const buf = Buffer.from(await dl.arrayBuffer());
  //     const fs = await import("node:fs/promises");
  //     await fs.writeFile(tmp, buf);
  //     const { stdout } = await run(process.env.WHISPER_BIN || "whisper-cli", [
  //       "-m", process.env.WHISPER_MODEL || "/opt/whisper/ggml-base.bin",
  //       "-f", tmp, "--no-timestamps",
  //     ]);
  //     await fs.unlink(tmp).catch(() => {});
  //     return { transcript: stdout.trim() };
  //   },
  // },

  "image.generate": {
    priceUsd: "0.08",
    gpu: true,
    description: "Flux schnell text-to-image via local ComfyUI. Body: { prompt, width?, height?, seed? } (dims 256-1024). Returns base64 PNG.",
    handler: async (body) => {
      if (!process.env.COMFY_WIRED) {
        return {
          status: "not_configured",
          note: "Set up your ComfyUI workflow JSON in services.js, then set COMFY_WIRED=1",
          prompt_received: body.prompt || null,
        };
      }
      if (!body.prompt) throw new Error("prompt required");
      const dim = (v, d) => Math.min(Math.max(Number(v) || d, 256), 1024) & ~7;
      const width = dim(body.width, 1024);
      const height = dim(body.height, 1024);
      const graph = {
        1: { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "flux1-schnell-fp8.safetensors" } },
        2: { class_type: "CLIPTextEncode", inputs: { clip: ["1", 1], text: String(body.prompt).slice(0, 2000) } },
        3: { class_type: "CLIPTextEncode", inputs: { clip: ["1", 1], text: "" } },
        4: { class_type: "EmptySD3LatentImage", inputs: { width, height, batch_size: 1 } },
        5: {
          class_type: "KSampler",
          inputs: {
            model: ["1", 0], positive: ["2", 0], negative: ["3", 0], latent_image: ["4", 0],
            seed: Number.isFinite(Number(body.seed)) ? Number(body.seed) : Date.now() % 2 ** 32,
            steps: 4, cfg: 1, sampler_name: "euler", scheduler: "simple", denoise: 1,
          },
        },
        6: { class_type: "VAEDecode", inputs: { samples: ["5", 0], vae: ["1", 2] } },
        7: { class_type: "SaveImage", inputs: { images: ["6", 0], filename_prefix: "forge" } },
      };
      const q = await fetch(`${COMFY_URL}/prompt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: graph }),
      });
      if (!q.ok) throw new Error(`ComfyUI queue error ${q.status}`);
      const { prompt_id } = await q.json();
      let outputs;
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1500));
        const h = await (await fetch(`${COMFY_URL}/history/${prompt_id}`)).json();
        const e = h[prompt_id];
        if (e?.status?.completed) { outputs = e.outputs; break; }
        if (e?.status?.status_str === "error") throw new Error("ComfyUI execution error");
      }
      if (!outputs) throw new Error("ComfyUI timeout after 120s");
      const img = Object.values(outputs).flatMap((o) => o.images || [])[0];
      if (!img) throw new Error("ComfyUI produced no image");
      const view = await fetch(
        `${COMFY_URL}/view?filename=${encodeURIComponent(img.filename)}&subfolder=${encodeURIComponent(img.subfolder || "")}&type=${img.type}`
      );
      if (!view.ok) throw new Error("could not fetch generated image");
      return {
        image_base64: Buffer.from(await view.arrayBuffer()).toString("base64"),
        width, height, model: "flux1-schnell-fp8", format: "png",
      };
    },
  },
  "llm.summarize": {
    priceUsd: "0.03",
    gpu: true,
    description: "Summarize text on a locally hosted open model. Body: { text, style? (bullets|paragraph) }",
    handler: async (body) => {
      if (!body.text) throw new Error("text required");
      const prompt = `Summarize the following as ${body.style === "bullets" ? "concise bullet points" : "one tight paragraph"}. Output only the summary.\n\n${String(body.text).slice(0, 24000)}`;
      const res = await fetch(`${OLLAMA_URL}/api/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: process.env.DEFAULT_MODEL || "llama3.1:8b", prompt, stream: false, options: { num_predict: 512 } }),
      });
      if (!res.ok) throw new Error(`LLM backend error ${res.status}`);
      const data = await res.json();
      return { summary: data.response.trim(), eval_count: data.eval_count };
    },
  },
  "llm.extract": {
    priceUsd: "0.03",
    gpu: true,
    description: "Extract structured JSON from text. Body: { text, schema } where schema describes the desired fields. Returns { data }.",
    handler: async (body) => {
      if (!body.text || !body.schema) throw new Error("text and schema required");
      const prompt = `Extract data from the text below matching this schema: ${JSON.stringify(body.schema)}. Respond with ONLY valid JSON, no prose.\n\nTEXT:\n${String(body.text).slice(0, 24000)}`;
      const res = await fetch(`${OLLAMA_URL}/api/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: process.env.DEFAULT_MODEL || "llama3.1:8b", prompt, stream: false, format: "json", options: { num_predict: 1024 } }),
      });
      if (!res.ok) throw new Error(`LLM backend error ${res.status}`);
      const data = await res.json();
      return { data: JSON.parse(data.response) };
    },
  },
  "llm.embed": {
    priceUsd: "0.01",
    gpu: true,
    description: "Embedding vector for a text. Body: { text }. Returns { embedding }. Machine-payable building block for agent RAG.",
    handler: async (body) => {
      if (!body.text) throw new Error("text required");
      const res = await fetch(`${OLLAMA_URL}/api/embeddings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: process.env.EMBED_MODEL || process.env.DEFAULT_MODEL || "llama3.1:8b", prompt: String(body.text).slice(0, 8000) }),
      });
      if (!res.ok) throw new Error(`Embedding backend error ${res.status}`);
      const data = await res.json();
      return { embedding: data.embedding, dim: data.embedding.length };
    },
  },

  "video.generate": {
    priceUsd: "0.25",
    gpu: true,
    async: true,
    etaSeconds: 240,
    description: "Wan 2.1 text-to-video via local ComfyUI. 832x480 @16fps animated WebP, 9-49 frames (~0.5-3s). Async: pay, receive job_id, poll /v1/results/{job_id}. Body: { prompt, negative?, seed?, frames? }",
    handler: async (body) => {
      if (!body.prompt) throw new Error("prompt required");
      let frames = Math.min(Math.max(Number(body.frames) || 33, 9), 49);
      frames -= (frames - 1) % 4; // latent length must be 4k+1
      const graph = {
        1: { class_type: "UNETLoader", inputs: { unet_name: "wan2.1_t2v_1.3B_fp16.safetensors", weight_dtype: "default" } },
        2: { class_type: "CLIPLoader", inputs: { clip_name: "umt5_xxl_fp8_e4m3fn_scaled.safetensors", type: "wan", device: "default" } },
        3: { class_type: "VAELoader", inputs: { vae_name: "wan_2.1_vae.safetensors" } },
        4: { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: String(body.prompt).slice(0, 2000) } },
        5: { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: String(body.negative || "blurry, distorted, low quality, static").slice(0, 500) } },
        6: { class_type: "ModelSamplingSD3", inputs: { model: ["1", 0], shift: 8 } },
        7: { class_type: "EmptyHunyuanLatentVideo", inputs: { width: 832, height: 480, length: frames, batch_size: 1 } },
        8: {
          class_type: "KSampler",
          inputs: {
            model: ["6", 0], positive: ["4", 0], negative: ["5", 0], latent_image: ["7", 0],
            seed: Number.isFinite(Number(body.seed)) ? Number(body.seed) : Date.now() % 2 ** 32,
            steps: 20, cfg: 6, sampler_name: "uni_pc", scheduler: "simple", denoise: 1,
          },
        },
        9: { class_type: "VAEDecode", inputs: { samples: ["8", 0], vae: ["3", 0] } },
        10: { class_type: "SaveAnimatedWEBP", inputs: { images: ["9", 0], filename_prefix: "forge-video", fps: 16, lossless: false, quality: 85, method: "default" } },
      };
      const q = await fetch(`${COMFY_URL}/prompt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: graph }),
      });
      if (!q.ok) throw new Error(`ComfyUI queue error ${q.status}`);
      const { prompt_id } = await q.json();
      let outputs;
      const deadline = Date.now() + 900_000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 3000));
        const h = await (await fetch(`${COMFY_URL}/history/${prompt_id}`)).json();
        const e = h[prompt_id];
        if (e?.status?.completed) { outputs = e.outputs; break; }
        if (e?.status?.status_str === "error") throw new Error("ComfyUI execution error");
      }
      if (!outputs) throw new Error("ComfyUI timeout after 900s");
      const img = Object.values(outputs).flatMap((o) => o.images || [])[0];
      if (!img) throw new Error("ComfyUI produced no video");
      const view = await fetch(
        `${COMFY_URL}/view?filename=${encodeURIComponent(img.filename)}&subfolder=${encodeURIComponent(img.subfolder || "")}&type=${img.type}`
      );
      if (!view.ok) throw new Error("could not fetch generated video");
      return {
        video_webp_base64: Buffer.from(await view.arrayBuffer()).toString("base64"),
        frames, fps: 16, width: 832, height: 480, model: "wan2.1-t2v-1.3B",
      };
    },
  },
  "image.upscale": {
    priceUsd: "0.02",
    gpu: true,
    description: "4x upscale via Real-ESRGAN on local ComfyUI. Body: { image_base64 } (PNG/JPEG, max 4MB decoded). Returns base64 PNG at 4x resolution.",
    handler: async (body) => {
      if (!body.image_base64) throw new Error("image_base64 required");
      const src = Buffer.from(String(body.image_base64), "base64");
      if (src.length < 100) throw new Error("image_base64 is not a valid image");
      if (src.length > 4 * 1024 * 1024) throw new Error("image too large (max 4MB decoded)");
      const boundary = "----forge" + Date.now();
      const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="up-${Date.now()}.png"\r\nContent-Type: application/octet-stream\r\n\r\n`);
      const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
      const up = await fetch(`${COMFY_URL}/upload/image`, {
        method: "POST",
        headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
        body: Buffer.concat([head, src, tail]),
      });
      if (!up.ok) throw new Error(`ComfyUI upload error ${up.status}`);
      const { name: uploaded } = await up.json();
      const graph = {
        1: { class_type: "LoadImage", inputs: { image: uploaded } },
        2: { class_type: "UpscaleModelLoader", inputs: { model_name: "RealESRGAN_x4plus.pth" } },
        3: { class_type: "ImageUpscaleWithModel", inputs: { upscale_model: ["2", 0], image: ["1", 0] } },
        4: { class_type: "SaveImage", inputs: { images: ["3", 0], filename_prefix: "forge-upscale" } },
      };
      const q = await fetch(`${COMFY_URL}/prompt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: graph }),
      });
      if (!q.ok) throw new Error(`ComfyUI queue error ${q.status}`);
      const { prompt_id } = await q.json();
      let outputs;
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1500));
        const h = await (await fetch(`${COMFY_URL}/history/${prompt_id}`)).json();
        const e = h[prompt_id];
        if (e?.status?.completed) { outputs = e.outputs; break; }
        if (e?.status?.status_str === "error") throw new Error("ComfyUI execution error (is the input a valid image?)");
      }
      if (!outputs) throw new Error("ComfyUI timeout after 120s");
      const img = Object.values(outputs).flatMap((o) => o.images || [])[0];
      if (!img) throw new Error("ComfyUI produced no image");
      const view = await fetch(
        `${COMFY_URL}/view?filename=${encodeURIComponent(img.filename)}&subfolder=${encodeURIComponent(img.subfolder || "")}&type=${img.type}`
      );
      if (!view.ok) throw new Error("could not fetch upscaled image");
      return { image_base64: Buffer.from(await view.arrayBuffer()).toString("base64"), scale: 4, model: "RealESRGAN_x4plus", format: "png" };
    },
  },
};
