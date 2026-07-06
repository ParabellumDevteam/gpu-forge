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

export const CATALOG = {
  "gpu.probe": {
    priceUsd: "0.01",
    description: "Returns live nvidia-smi output. Cheap way for agents to verify real GPU capacity before buying bigger jobs.",
    handler: async () => {
      try {
        const { stdout } = await run("nvidia-smi", [
          "--query-gpu=name,memory.total,memory.used,utilization.gpu,temperature.gpu",
          "--format=csv,noheader",
        ]);
        return { gpu: stdout.trim() };
      } catch {
        return { gpu: "nvidia-smi unavailable", note: "Configure GPU drivers on the host" };
      }
    },
  },

  "llm.generate": {
    priceUsd: "0.05",
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
    description: "Image generation via a local ComfyUI/SD API. Body: { prompt }. Returns base64 PNG. Wire prompt into your ComfyUI workflow JSON.",
    handler: async (body) => {
      // Minimal example against ComfyUI's /prompt API. You must adapt the
      // workflow graph to whatever checkpoint you run. Placeholder response
      // keeps the endpoint honest until you wire it.
      void COMFY_URL;
      if (!process.env.COMFY_WIRED) {
        return {
          status: "not_configured",
          note: "Set up your ComfyUI workflow JSON in services.js, then set COMFY_WIRED=1",
          prompt_received: body.prompt || null,
        };
      }
      throw new Error("Wire your ComfyUI workflow here");
    },
  },
};
