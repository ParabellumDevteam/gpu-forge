// credits.js
// Forge Bot credit packs sold over the same x402 paywall as /v1/jobs.
// GET/POST /forge/credits/:pack?code=<link code from the Telegram bot /buy>
//   - no payment header  -> 402 + machine-readable quote
//   - X-Payment-Tx       -> verify direct USDC transfer on-chain
//   - X-PAYMENT (signed) -> settle EIP-3009 authorization ourselves
// On success the forge Postgres ledger is credited exactly once per tx hash
// and the buyer is notified on Telegram.

import pg from "pg";
import QRCode from "qrcode";
import { verifyPayment, usdcToUnits, paymentInfo, NETWORKS } from "./payment.js";
import { hasPayment, recordPayment } from "./ledger.js";
import {
  settlementEnabled,
  parsePaymentHeader,
  settlePayment,
  settlementResponseHeader,
} from "./x402-settle.js";

const BASE_URL = process.env.PUBLIC_BASE_URL || "https://forge.parabellum.tech";

// name:usdc:credits, env-overridable
export const PACKS = Object.fromEntries(
  (process.env.CREDIT_PACKS || "starter:2:100,creator:5:300,studio:10:700").split(",").map((p) => {
    const [name, usdc, credits] = p.split(":");
    return [name, { name, usdc: Number(usdc), credits: Number(credits) }];
  })
);

const forgeDb = process.env.FORGE_DATABASE_URL
  ? new pg.Pool({ connectionString: process.env.FORGE_DATABASE_URL, max: 3 })
  : null;

function creditRequirements(pack, code) {
  const resource = `${BASE_URL}/forge/credits/${pack.name}${code ? `?code=${code}` : ""}`;
  return {
    x402Version: 1,
    error: "payment_required",
    accepts: NETWORKS.map((n) => ({
      scheme: "exact",
      network: n.key,
      maxAmountRequired: usdcToUnits(pack.usdc).toString(),
      resource,
      description: `Forge Bot ${pack.name} pack: ${pack.credits} generation credits`,
      mimeType: "application/json",
      payTo: paymentInfo.payTo,
      maxTimeoutSeconds: 300,
      asset: n.usdc,
      extra: {
        name: "USDC",
        version: "2",
        instructions:
          "Include your Telegram link code as the ?code= query parameter (get one with /buy in the bot). " +
          "Pay the exact USDC amount, then retry this URL with the X-Payment-Tx: 0x<hash> header, " +
          "or send a signed x402 X-PAYMENT envelope.",
      },
    })),
  };
}

/**
 * Credit the pack to the linked Telegram user, exactly once per tx hash.
 * Returns { credited, balance?, telegramId?, error? }.
 */
async function creditPurchase({ pack, code, txHash, payer, amountUnits, network }) {
  if (!forgeDb) return { credited: false, error: "FORGE_DATABASE_URL not configured" };
  const client = await forgeDb.connect();
  try {
    await client.query("BEGIN");
    const link = await client.query("SELECT user_id FROM link_codes WHERE code=$1", [code]);
    if (!link.rows.length) {
      await client.query("ROLLBACK");
      return { credited: false, error: "unknown link code - run /buy in the bot to get yours" };
    }
    const telegramId = Number(link.rows[0].user_id);
    // exactly-once on tx_hash via the partial unique index
    const ins = await client.query(
      `INSERT INTO credit_ledger (user_id, delta, reason, tx_hash)
       VALUES ($1,$2,'purchase',$3) ON CONFLICT (tx_hash) WHERE tx_hash IS NOT NULL DO NOTHING RETURNING id`,
      [telegramId, pack.credits, txHash]
    );
    if (!ins.rows.length) {
      await client.query("ROLLBACK");
      return { credited: false, error: "this payment tx has already been redeemed" };
    }
    await client.query(
      `INSERT INTO purchases (user_id, pack, usdc_amount, chain, tx_hash, status)
       VALUES ($1,$2,$3,$4,$5,'settled') ON CONFLICT (tx_hash) DO NOTHING`,
      [telegramId, pack.name, Number(amountUnits) / 1e6, network, txHash]
    );
    await client.query(
      "UPDATE users SET wallet_address=COALESCE(wallet_address,$2) WHERE telegram_id=$1",
      [telegramId, payer]
    );
    await client.query("UPDATE link_codes SET used_at=COALESCE(used_at, now()) WHERE code=$1", [code]);
    const bal = await client.query(
      "SELECT COALESCE(SUM(delta),0)::int AS bal FROM credit_ledger WHERE user_id=$1",
      [telegramId]
    );
    await client.query("COMMIT");
    return { credited: true, balance: bal.rows[0].bal, telegramId };
  } catch (e) {
    await client.query("ROLLBACK");
    return { credited: false, error: "ledger write failed: " + e.message };
  } finally {
    client.release();
  }
}

async function notifyTelegram(telegramId, text) {
  const token = process.env.FORGE_BOT_TOKEN;
  if (!token) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: telegramId, text }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    /* balance is already credited; the user sees it via /credits */
  }
}

// TODO(payment-seam): add Telegram Stars / Stripe for non-crypto users here.
// Implement by calling creditPurchase-equivalent ledger writes keyed on the
// provider's payment id instead of tx_hash. Deliberately not built yet.
export async function creditViaFiat() {
  throw new Error("fiat purchases not implemented");
}

// ---------- human-facing payment pages ----------
// Agents keep the exact JSON 402/x402 flow; browsers (Accept: text/html, no
// payment headers) get a usable page: pick chain, pay, paste tx hash, redeem.

const sanitizeCode = (c) => (/^[A-Z0-9]{1,32}$/.test(c) ? c : "");

const PAGE_CSS = `
:root{--bg:#0b0d10;--card:#14171c;--line:#242a33;--txt:#e8eaed;--dim:#9aa3ad;--acc:#f97316;--acc2:#fbbf24;--ok:#34d399;--err:#f87171}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--txt);font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;min-height:100vh}
.wrap{max-width:560px;margin:0 auto;padding:28px 18px 60px}
a{color:var(--acc);text-decoration:none}
.logo{display:flex;align-items:center;gap:10px;margin-bottom:26px}
.logo .mark{width:38px;height:38px;border-radius:10px;background:radial-gradient(circle at 50% 35%,#2a2e35,#16181d);display:flex;align-items:center;justify-content:center;font-size:20px;border:1px solid var(--line)}
.logo b{font-size:19px;letter-spacing:.4px}
.logo span{color:var(--dim);font-size:13px;display:block;margin-top:1px}
h1{font-size:24px;margin-bottom:6px}
.sub{color:var(--dim);margin-bottom:24px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:20px;margin-bottom:16px}
.packrow{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:2px}
.price{font-size:30px;font-weight:700;color:var(--acc2)}
.credits{font-size:17px;color:var(--txt)}
.per{color:var(--dim);font-size:13.5px;margin-top:4px}
.step{display:flex;gap:12px;margin:22px 0 10px}
.stepn{flex:none;width:26px;height:26px;border-radius:50%;background:var(--acc);color:#000;font-weight:700;font-size:14px;display:flex;align-items:center;justify-content:center}
.step h2{font-size:16.5px;align-self:center}
input[type=text]{width:100%;background:#0e1114;border:1px solid var(--line);border-radius:10px;color:var(--txt);padding:12px 14px;font-size:15px;font-family:ui-monospace,Menlo,monospace}
input[type=text]:focus{outline:none;border-color:var(--acc)}
.hint{color:var(--dim);font-size:13px;margin-top:8px}
.tabs{display:flex;gap:8px;margin-bottom:14px}
.tab{flex:1;padding:10px;border-radius:10px;border:1px solid var(--line);background:transparent;color:var(--dim);font-size:15px;cursor:pointer}
.tab.on{border-color:var(--acc);color:var(--txt);background:rgba(249,115,22,.08)}
.field{margin-bottom:12px}
.field label{display:block;color:var(--dim);font-size:12.5px;margin-bottom:5px;text-transform:uppercase;letter-spacing:.5px}
.copyrow{display:flex;gap:8px}
.copyrow .val{flex:1;background:#0e1114;border:1px solid var(--line);border-radius:10px;padding:11px 13px;font-family:ui-monospace,Menlo,monospace;font-size:13.5px;overflow-wrap:anywhere}
.btn{border:none;border-radius:10px;padding:11px 16px;font-size:14.5px;font-weight:600;cursor:pointer}
.btn.copy{background:#20262e;color:var(--txt);flex:none}
.btn.copy.done{background:rgba(52,211,153,.15);color:var(--ok)}
.btn.primary{width:100%;background:var(--acc);color:#000;padding:14px;font-size:16px;margin-top:6px}
.btn.primary:disabled{opacity:.55;cursor:wait}
.btn.wallet{display:block;text-align:center;background:#20262e;color:var(--txt);margin-top:4px;padding:13px}
.panel{display:none;border-radius:12px;padding:16px;margin-top:14px;font-size:14.5px}
.panel.ok{background:rgba(52,211,153,.1);border:1px solid rgba(52,211,153,.35);color:var(--ok)}
.panel.err{background:rgba(248,113,113,.08);border:1px solid rgba(248,113,113,.3);color:var(--err)}
.foot{color:var(--dim);font-size:12.5px;margin-top:30px;line-height:1.6}
.grid{display:grid;gap:14px}
.pcard{display:block;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px 20px;color:var(--txt)}
.pcard:hover{border-color:var(--acc)}
.pcard .n{font-weight:700;font-size:17px;margin-bottom:2px}
.pcard .d{color:var(--dim);font-size:13.5px}
.pcard .p{float:right;font-size:20px;font-weight:700;color:var(--acc2)}
.badge{display:inline-block;background:rgba(249,115,22,.12);color:var(--acc);font-size:12px;padding:3px 9px;border-radius:20px;margin-left:8px;vertical-align:2px}
`;

const pageShell = (title, body) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<title>${title}</title><style>${PAGE_CSS}</style></head>
<body><div class="wrap">
<div class="logo"><div class="mark">⚒️</div><div><b>FORGE</b><span>AI image &amp; video studio · @parabellum_brain_bot</span></div></div>
${body}
<div class="foot">Payments are verified on-chain (5 confirmations). Credits are added exactly once per transaction and you get a Telegram confirmation.<br><br>
Agent? This same URL speaks x402: request it without an Accept: text/html header for a machine-readable 402 quote, then retry with X-Payment-Tx or a signed X-PAYMENT envelope.</div>
</div></body></html>`;

function renderIndexPage(code) {
  const q = code ? `?code=${code}` : "";
  const cards = Object.values(PACKS)
    .map(
      (p, i) => `<a class="pcard" href="${BASE_URL}/forge/credits/${p.name}${q}">
<span class="p">${p.usdc} USDC</span><div class="n">${p.name[0].toUpperCase() + p.name.slice(1)}${i === 1 ? '<span class="badge">most popular</span>' : ""}</div>
<div class="d">${p.credits} credits · ${["try it out", "best value for regular use", "for heavy creation"][i] ?? ""} · ~${((p.usdc / p.credits) * 100).toFixed(1)}¢ per image</div></a>`
    )
    .join("");
  return pageShell(
    "Forge — Buy credits",
    `<h1>Buy credits</h1>
<p class="sub">Generate images (~2¢) and videos up to 15s (~50¢) in the <a href="https://t.me/parabellum_brain_bot">Forge Telegram bot</a> — a fraction of what mainstream AI apps charge. Pay with USDC on Base or Polygon.</p>
<div class="grid">${cards}</div>
<div class="card" style="margin-top:16px"><b>How it works</b>
<p class="hint" style="font-size:14px">1. In the bot, send <b>/buy</b> to get your personal link code.<br>
2. Pick a pack above and pay the exact USDC amount from any wallet.<br>
3. Paste the transaction hash on the pack page — credits land instantly and the bot messages you.</p></div>`
  );
}

function renderPackPage(pack, code) {
  const units = usdcToUnits(pack.usdc).toString();
  const chains = NETWORKS.map((n) => ({
    key: n.key,
    label: n.key === "base" ? "Base" : n.key[0].toUpperCase() + n.key.slice(1),
    chainId: n.chainId,
    usdc: n.usdc,
  }));
  const perImg = ((pack.usdc / pack.credits) * 100).toFixed(1);
  return pageShell(
    `Forge — ${pack.name} pack`,
    `<h1>${pack.name[0].toUpperCase() + pack.name.slice(1)} pack</h1>
<p class="sub"><a href="${BASE_URL}/forge/credits${code ? `?code=${code}` : ""}">← all packs</a></p>
<div class="card"><div class="packrow"><span class="price">${pack.usdc} USDC</span><span class="credits">${pack.credits} credits</span></div>
<div class="per">≈ ${perImg}¢ per image · works out to ~50¢ per 15-second video</div></div>

<div class="step"><div class="stepn">1</div><h2>Your link code</h2></div>
<div class="card"><input type="text" id="code" maxlength="32" placeholder="e.g. 7F3A9B2C" value="${code}" autocomplete="off" spellcheck="false">
<div class="hint">Send <b>/buy</b> to <a href="https://t.me/parabellum_brain_bot">@parabellum_brain_bot</a> to get yours — it ties this payment to your Telegram account.</div></div>

<div class="step"><div class="stepn">2</div><h2>Send exactly ${pack.usdc} USDC</h2></div>
<div class="card">
<div class="tabs">${chains.map((c, i) => `<button class="tab${i === 0 ? " on" : ""}" data-chain="${c.key}">${c.label}</button>`).join("")}</div>
<button class="btn primary" id="wcPay" style="margin:2px 0 8px">🔗 Connect wallet &amp; pay</button>
<button class="btn wallet" id="injPay" style="display:none;margin-bottom:8px">🦊 Pay with browser wallet</button>
<div class="hint" id="payStatus" style="text-align:center;min-height:18px"></div>
<div style="display:flex;align-items:center;gap:10px;color:var(--dim);font-size:12px;margin:10px 0"><span style="flex:1;height:1px;background:var(--line)"></span>or pay manually<span style="flex:1;height:1px;background:var(--line)"></span></div>
<div class="field"><label>Amount</label><div class="copyrow"><div class="val">${pack.usdc} USDC</div><button class="btn copy" data-copy="${pack.usdc}">Copy</button></div></div>
<div class="field"><label>To address</label><div class="copyrow"><div class="val">${paymentInfo.payTo}</div><button class="btn copy" data-copy="${paymentInfo.payTo}">Copy</button></div></div>
<div class="field"><label>Token (USDC contract)</label><div class="copyrow"><div class="val" id="usdcAddr"></div><button class="btn copy" id="usdcCopy">Copy</button></div></div>
<div style="display:flex;justify-content:center;margin:16px 0 6px"><img id="qr" alt="payment QR" width="210" height="210" style="border-radius:12px;background:#fff;padding:8px"></div>
<div class="hint" style="text-align:center;margin-bottom:10px">Scan with your phone's wallet — it prefills token, amount and address.</div>
<a class="btn wallet" id="walletLink" href="#">Open in wallet app (mobile)</a>
<div class="hint">Native USDC only — send the exact amount in one transaction. On desktop: scan the QR or use the copy buttons.</div>
</div>

<div class="step"><div class="stepn">3</div><h2>Redeem your credits</h2></div>
<div class="card"><input type="text" id="txhash" placeholder="Paste the transaction hash (0x…)" autocomplete="off" spellcheck="false">
<button class="btn primary" id="redeem">Redeem credits</button>
<div class="panel ok" id="ok"></div>
<div class="panel err" id="err"></div></div>

<script>
const CHAINS=${JSON.stringify(chains)};const UNITS="${units}";const PAYTO="${paymentInfo.payTo}";
let chain=CHAINS[0];
function setChain(c){chain=c;
 document.querySelectorAll('.tab').forEach(t=>t.classList.toggle('on',t.dataset.chain===c.key));
 document.getElementById('usdcAddr').textContent=c.usdc;
 document.getElementById('usdcCopy').dataset.copy=c.usdc;
 document.getElementById('walletLink').href='ethereum:'+c.usdc+'@'+c.chainId+'/transfer?address='+PAYTO+'&uint256='+UNITS;
 document.getElementById('qr').src=location.pathname+'/qr?chain='+c.key;}
setChain(chain);
document.querySelectorAll('.tab').forEach(t=>t.onclick=()=>setChain(CHAINS.find(c=>c.key===t.dataset.chain)));
document.addEventListener('click',e=>{const b=e.target.closest('.btn.copy');if(!b)return;
 navigator.clipboard.writeText(b.dataset.copy).then(()=>{b.textContent='Copied';b.classList.add('done');
 setTimeout(()=>{b.textContent='Copy';b.classList.remove('done')},1600)})});
const ok=document.getElementById('ok'),err=document.getElementById('err'),btn=document.getElementById('redeem');
function showErr(m){err.textContent=m;err.style.display='block';ok.style.display='none'}
function showOk(h){ok.innerHTML=h;ok.style.display='block';err.style.display='none'}
function getCode(){const c=document.getElementById('code').value.trim().toUpperCase();
 if(!/^[A-Z0-9]{4,32}$/.test(c)){showErr('Enter your link code first (send /buy to the bot to get it).');return null}return c}
async function redeemOnce(tx,code){
 const r=await fetch(location.pathname+'?code='+encodeURIComponent(code),{headers:{'X-Payment-Tx':tx}});
 return {r,d:await r.json()}}
btn.onclick=async()=>{
 const code=getCode();if(!code)return;
 const tx=document.getElementById('txhash').value.trim();
 if(!/^0x[0-9a-fA-F]{64}$/.test(tx)){showErr('That does not look like a transaction hash (0x + 64 hex characters).');return}
 btn.disabled=true;btn.textContent='Verifying on-chain…';
 try{const {r,d}=await redeemOnce(tx,code);
  if(r.ok&&d.creditsAdded){showOk('✅ <b>'+d.creditsAdded+' credits added.</b> New balance: '+d.balance+' credits.<br>Back to <a href="https://t.me/parabellum_brain_bot">@parabellum_brain_bot</a> and start creating.')}
  else{const m=d.detail||d.error||'verification failed';
   showErr('✗ '+m+(String(m).includes('confirmation')?' — wait a few seconds and press Redeem again.':''))}
 }catch(e){showErr('Network error: '+e.message)}
 btn.disabled=false;btn.textContent='Redeem credits'};

// ---- wallet payment (WalletConnect + injected) ----
const WC_PROJECT_ID='${process.env.WC_PROJECT_ID || ""}';
const RPC={8453:'https://base-rpc.publicnode.com',137:'https://polygon-bor-rpc.publicnode.com'};
const status=document.getElementById('payStatus');
const wcBtn=document.getElementById('wcPay'),injBtn=document.getElementById('injPay');
if(window.ethereum)injBtn.style.display='block';
if(!WC_PROJECT_ID)wcBtn.style.display='none';
function transferData(){const to=PAYTO.toLowerCase().replace('0x','').padStart(64,'0');
 const amt=BigInt(UNITS).toString(16).padStart(64,'0');return '0xa9059cbb'+to+amt}
async function ensureChain(p){try{
 await p.request({method:'wallet_switchEthereumChain',params:[{chainId:'0x'+chain.chainId.toString(16)}]})
}catch(e){/* wallet may not support switching; verification accepts both chains anyway */}}
async function autoRedeem(tx,code){
 document.getElementById('txhash').value=tx;
 for(let i=0;i<30;i++){
  status.textContent='Payment sent — waiting for confirmations… ('+tx.slice(0,10)+'…)';
  try{const {r,d}=await redeemOnce(tx,code);
   if(r.ok&&d.creditsAdded){status.textContent='';
    showOk('✅ <b>'+d.creditsAdded+' credits added.</b> New balance: '+d.balance+' credits.<br>Back to <a href="https://t.me/parabellum_brain_bot">@parabellum_brain_bot</a> and start creating.');return}
   const m=String(d.detail||d.error||'');
   if(!/confirmation|not found|mined/i.test(m)){status.textContent='';showErr('✗ '+m);return}
  }catch(e){}
  await new Promise(s=>setTimeout(s,6000))}
 status.textContent='';showErr('Still unconfirmed — your hash is filled in below, press Redeem in a moment.')}
async function payWith(provider,from){
 await ensureChain(provider);
 status.textContent='Confirm the transaction in your wallet…';
 const tx=await provider.request({method:'eth_sendTransaction',
  params:[{from,to:chain.usdc,value:'0x0',data:transferData()}]});
 await autoRedeem(tx,getCodeSafe())}
function getCodeSafe(){return document.getElementById('code').value.trim().toUpperCase()}
injBtn.onclick=async()=>{
 if(!getCode())return;injBtn.disabled=true;
 try{const accs=await window.ethereum.request({method:'eth_requestAccounts'});
  await payWith(window.ethereum,accs[0])}
 catch(e){status.textContent='';showErr(e.message||'wallet cancelled')}
 injBtn.disabled=false};
wcBtn.onclick=async()=>{
 if(!getCode())return;wcBtn.disabled=true;wcBtn.textContent='Opening WalletConnect…';
 try{
  const {EthereumProvider}=await import('https://cdn.jsdelivr.net/npm/@walletconnect/ethereum-provider@2/+esm');
  const p=await EthereumProvider.init({projectId:WC_PROJECT_ID,showQrModal:true,
   optionalChains:[8453,137],rpcMap:RPC,
   metadata:{name:'Forge',description:'AI image & video credits',url:'${BASE_URL}',icons:[]}});
  if(!p.session)await Promise.race([p.connect(),
   new Promise((_,rej)=>setTimeout(()=>rej(new Error('WalletConnect did not respond - scan the payment QR below or use the copy buttons instead')),45000))]);
  try{p.setDefaultChain('eip155:'+chain.chainId)}catch(e){}
  await payWith(p,p.accounts[0])}
 catch(e){status.textContent='';showErr(e.message||'WalletConnect cancelled');
  document.querySelector('w3m-modal')?.remove()}
 wcBtn.disabled=false;wcBtn.textContent='🔗 Connect wallet & pay'};
</script>`
  );
}

export function registerCreditRoutes(app) {
  app.route({
    method: ["GET", "POST"],
    url: "/forge/credits/:pack",
    handler: async (req, reply) => {
      const pack = PACKS[req.params.pack];
      if (!pack) {
        return reply.code(404).send({ error: "unknown pack", packs: Object.keys(PACKS) });
      }
      const code = String(req.query.code || "").trim().toUpperCase();
      const txHash = String(req.headers["x-payment-tx"] || "").trim();
      const signedPayment = req.headers["payment-signature"] || req.headers["x-payment"];

      // Browsers get the human payment page; agents keep the JSON 402 flow.
      if (!txHash && !signedPayment && String(req.headers.accept || "").includes("text/html")) {
        return reply.type("text/html; charset=utf-8").send(renderPackPage(pack, sanitizeCode(code)));
      }
      const quote402 = (detail) => {
        const pr = creditRequirements(pack, code);
        reply.header("payment-required", Buffer.from(JSON.stringify(pr)).toString("base64"));
        return reply.code(402).send(detail ? { ...pr, error: "payment_invalid", detail } : pr);
      };

      // settlement path (signed EIP-3009 envelope)
      if (!txHash && signedPayment && settlementEnabled()) {
        if (!code) return quote402("missing ?code= link code (get one with /buy in the Telegram bot)");
        let parsed;
        try {
          parsed = parsePaymentHeader(signedPayment);
        } catch (e) {
          return quote402(e.message);
        }
        const settle = await settlePayment(parsed, usdcToUnits(pack.usdc), creditRequirements(pack, code));
        if (!settle.ok) return quote402(settle.error);
        recordPayment(settle.txHash, settle.payer, `credits.${pack.name}`, settle.amountUnits, settle.network);
        const res = await creditPurchase({
          pack,
          code,
          txHash: settle.txHash,
          payer: settle.payer,
          amountUnits: settle.amountUnits,
          network: settle.network,
        });
        if (!res.credited) return reply.code(409).send({ error: res.error, txHash: settle.txHash });
        reply.header("access-control-expose-headers", "PAYMENT-RESPONSE,X-PAYMENT-RESPONSE");
        reply.header("payment-response", settlementResponseHeader(settle));
        reply.header("x-payment-response", settlementResponseHeader(settle));
        void notifyTelegram(
          res.telegramId,
          `Payment received: ${pack.credits} credits added (${pack.name} pack). New balance: ${res.balance} credits.`
        );
        return { pack: pack.name, creditsAdded: pack.credits, balance: res.balance, txHash: settle.txHash };
      }

      if (!txHash) return quote402();

      // direct-transfer path (X-Payment-Tx)
      if (!code) return quote402("missing ?code= link code (get one with /buy in the Telegram bot)");
      if (hasPayment(txHash)) {
        return reply.code(409).send({ error: "This payment tx has already been redeemed" });
      }
      const check = await verifyPayment(txHash, usdcToUnits(pack.usdc));
      if (!check.ok) return quote402(check.error);
      recordPayment(txHash, check.payer, `credits.${pack.name}`, check.amountUnits, check.network);
      const res = await creditPurchase({
        pack,
        code,
        txHash,
        payer: check.payer,
        amountUnits: check.amountUnits,
        network: check.network,
      });
      if (!res.credited) return reply.code(409).send({ error: res.error, txHash });
      void notifyTelegram(
        res.telegramId,
        `Payment received: ${pack.credits} credits added (${pack.name} pack). New balance: ${res.balance} credits.`
      );
      return { pack: pack.name, creditsAdded: pack.credits, balance: res.balance, txHash };
    },
  });

  // QR for the EIP-681 payment URI (black-on-white scans reliably in dark UIs)
  app.get("/forge/credits/:pack/qr", async (req, reply) => {
    const pack = PACKS[req.params.pack];
    const net = NETWORKS.find((n) => n.key === String(req.query.chain || "base")) ?? NETWORKS[0];
    if (!pack) return reply.code(404).send({ error: "unknown pack" });
    const uri = `ethereum:${net.usdc}@${net.chainId}/transfer?address=${paymentInfo.payTo}&uint256=${usdcToUnits(pack.usdc)}`;
    const png = await QRCode.toBuffer(uri, { width: 420, margin: 1 });
    return reply.type("image/png").header("cache-control", "public, max-age=86400").send(png);
  });

  app.get("/forge/credits", async (req, reply) => {
    if (String(req.headers.accept || "").includes("text/html")) {
      const code = sanitizeCode(String(req.query.code || "").trim().toUpperCase());
      return reply.type("text/html; charset=utf-8").send(renderIndexPage(code));
    }
    return creditsJson();
  });

  const creditsJson = () => ({
    packs: Object.values(PACKS).map((p) => ({
      pack: p.name,
      usdc: p.usdc,
      credits: p.credits,
      endpoint: `${BASE_URL}/forge/credits/${p.name}`,
    })),
    payment: paymentInfo,
    note: "Buy generation credits for the Forge Telegram bot. Include your ?code= from /buy.",
  });
}
