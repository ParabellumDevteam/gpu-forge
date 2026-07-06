# GPU Forge

Machine-payable GPU compute. AI agents (or humans) pay per call in USDC on Polygon. No accounts, no API keys, no Stripe. This is the seller side of the agent economy: autonomous agents need programmable, always-on payment rails, and stablecoins are the medium they actually use.

## How the protocol works (x402-style)

1. `GET /v1/services` returns a machine-readable price list.
2. `POST /v1/jobs/<service>` without payment returns **HTTP 402** with a quote: asset (USDC), chain (Polygon), payTo address, exact amount.
3. The buyer sends USDC on Polygon, then retries with header `X-Payment-Tx: 0x<hash>`.
4. The server verifies the transfer on-chain (recipient, amount, confirmations), marks the hash as redeemed (single use), runs the GPU job, returns the result.

An AI agent with a wallet can complete this loop with zero human involvement. That is the entire point.

## Deploy (Termux -> VPS, PM2)

```bash
# on the GPU VPS
git clone <your-repo> gpu-forge && cd gpu-forge
npm install
cp .env.example .env && nano .env   # set PAY_TO at minimum
pm2 start ecosystem.config.cjs
pm2 save
```

Expose it through your existing Cloudflare Tunnel, e.g. `forge.parabellum.tech` -> `localhost:4402`.

## Test the loop

```bash
# 1. See the quote
curl -s -X POST https://forge.parabellum.tech/v1/jobs/gpu.probe | jq

# 2. Send that USDC amount on Polygon to PAY_TO from any wallet

# 3. Redeem
curl -s -X POST https://forge.parabellum.tech/v1/jobs/gpu.probe \
  -H "X-Payment-Tx: 0xYOURTXHASH" | jq

# Revenue dashboard
curl -s https://forge.parabellum.tech/v1/revenue -H "X-Admin-Key: change-me" | jq
```

## Wiring real GPU workloads

The API sells whatever adapters you enable in `src/services.js`:

| Service | Backend to run on the GPU | Suggested price |
|---|---|---|
| `llm.generate` | Ollama or vLLM (`ollama serve`) | $0.05/call |
| `audio.transcribe` | whisper.cpp | $0.03/min |
| `image.generate` | ComfyUI + SDXL/Flux | $0.08/image |
| `gpu.probe` | nvidia-smi | $0.01 |

Prices are your margin lever. A single mid GPU doing SDXL images at $0.08 needs ~250 images/day to cover a $600/mo box. Transcription and LLM tokens stack on top of the same idle hardware.

## Getting buyers (this is 80% of the work)

1. **List on agent marketplaces.** OKX AI just opened to developers; register your endpoints as purchasable services. Also look at Fetch.ai Agentverse and Virtuals ACP.
2. **Publish an x402/OpenAPI manifest** so agent frameworks can discover pricing automatically. `/v1/services` is already machine-readable.
3. **Dogfood it.** Point your own Parabellum agent fleet (SCOUT, TACTICA, PULSE, EDGE, ORACLE) at the Forge for their inference. Every internal call becomes a public case study: "our agents buy compute from our own machine-payable API."
4. **Baseline income while demand ramps:** rent idle hours on Vast.ai or io.net IF your VPS provider's ToS allows compute resale. Read the ToS first; many prohibit it.

## Safety and ops notes

- Use a dedicated hot wallet for PAY_TO and sweep to your Treasury Safe regularly.
- Public RPC works but rate-limits; get a free Alchemy Polygon key for production.
- Failed jobs still consume the payment (recorded first to block double-spend). Handle reruns manually via the tx hash, or add an auto-retry queue later.
- Add rate limiting (@fastify/rate-limit) before going viral.
