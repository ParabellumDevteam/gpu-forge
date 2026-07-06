// x402-settle.js
// Standard x402 "exact" scheme settlement: the client sends a signed EIP-3009
// USDC transferWithAuthorization in a payment header; we verify it against the
// quote, broadcast it ourselves (self-settle, no facilitator), and return the
// settlement result. Complements the X-Payment-Tx direct-transfer flow.
//
// Accepted headers (base64 JSON):
//   payment-signature  — ampersend clients ({ x402Version, payload, accepted, ... })
//   x-payment          — Coinbase-style clients ({ x402Version, scheme, network, payload })
//
// The signature may be an EOA sig or a smart-account (ERC-1271) wrapper; USDC
// v2.2's bytes-signature transferWithAuthorization verifies either on-chain,
// so no local signature check is needed — a staticCall pre-flight is the test.
//
// When CDP_API_KEY_ID/CDP_API_KEY_SECRET are set, settlement is routed through
// the Coinbase CDP facilitator instead (with self-settle as fallback): the CDP
// Bazaar only catalogs a service after its first successful settle THROUGH the
// facilitator, so this is what makes the Bazaar/Agentic.Market listing happen.

import { ethers } from "ethers";
import { createFacilitatorConfig } from "@coinbase/x402";
import { NETWORKS } from "./payment.js";

const PAY_TO = (process.env.PAY_TO || "").toLowerCase();
const SETTLE_KEY = process.env.SETTLE_PRIVATE_KEY || "";
const CDP_KEY_ID = process.env.CDP_API_KEY_ID || "";
const CDP_KEY_SECRET = process.env.CDP_API_KEY_SECRET || "";

const USDC_ABI = [
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes signature)",
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
];

export function settlementEnabled() {
  return Boolean(SETTLE_KEY) || facilitatorEnabled();
}

export function facilitatorEnabled() {
  return Boolean(CDP_KEY_ID && CDP_KEY_SECRET);
}

export function settlementAddress() {
  return SETTLE_KEY ? new ethers.Wallet(SETTLE_KEY).address : null;
}

/** Decode either payment header shape into { authorization, signature, network, envelope }. */
export function parsePaymentHeader(headerValue) {
  const decoded = JSON.parse(Buffer.from(String(headerValue), "base64").toString("utf8"));
  const payload = decoded.payload || {};
  const network = decoded.accepted?.network || decoded.network || null;
  const { authorization, signature } = payload;
  if (!authorization || !signature) throw new Error("payment header missing payload.authorization/signature");
  return { authorization, signature, network, envelope: decoded };
}

/**
 * Settle through the Coinbase CDP facilitator (triggers Bazaar cataloging).
 * The envelope is forwarded verbatim as paymentPayload; paymentRequirements is
 * the accepts entry the client committed to, or our own quote for that network.
 */
async function settleViaFacilitator(envelope, net, minUnits, quote) {
  try {
    const cfg = createFacilitatorConfig(CDP_KEY_ID, CDP_KEY_SECRET);
    const headers = { "content-type": "application/json", ...(await cfg.createAuthHeaders()).settle };
    const paymentPayload = { ...envelope };
    // Bazaar cataloging requires paymentPayload.resource; some clients omit it.
    if (!paymentPayload.resource && quote?.resource) paymentPayload.resource = quote.resource;
    const paymentRequirements =
      envelope.accepted ||
      quote?.accepts?.find((acc) => acc.network === `eip155:${net.chainId}`) || {
        scheme: "exact",
        network: `eip155:${net.chainId}`,
        amount: String(minUnits),
        maxAmountRequired: String(minUnits),
        asset: net.usdc,
        payTo: envelope.payload.authorization.to,
        maxTimeoutSeconds: 300,
        extra: { name: "USD Coin", version: "2" },
      };
    const res = await fetch(`${cfg.url}/settle`, {
      method: "POST",
      headers,
      body: JSON.stringify({ x402Version: envelope.x402Version || 2, paymentPayload, paymentRequirements }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success) {
      const reason = data.errorReason || data.errorMessage || JSON.stringify(data).slice(0, 200);
      return { ok: false, error: `Facilitator settle failed (${res.status}): ${reason}` };
    }
    return {
      ok: true,
      txHash: data.transaction,
      payer: (data.payer || envelope.payload.authorization.from).toLowerCase(),
      amountUnits: String(envelope.payload.authorization.value),
      network: net.key,
      via: "cdp-facilitator",
    };
  } catch (e) {
    return { ok: false, error: "Facilitator settle failed: " + e.message };
  }
}

/**
 * Validate the signed authorization against the quote and settle it on-chain.
 * Prefers the CDP facilitator when configured (Bazaar listing), falling back
 * to self-settle; with no CDP keys it self-settles directly as before.
 * @returns {{ ok:boolean, txHash?:string, payer?:string, amountUnits?:string, network?:string, error?:string }}
 */
export async function settlePayment({ authorization: a, signature, network, envelope }, minUnits, quote) {
  if (!settlementEnabled()) return { ok: false, error: "Signed-authorization settlement not enabled on this server; use X-Payment-Tx" };

  const chainId = Number(String(network || "").replace("eip155:", ""));
  const net = NETWORKS.find((n) => n.chainId === chainId);
  if (!net) return { ok: false, error: `Unsupported payment network: ${network}` };

  if ((a.to || "").toLowerCase() !== PAY_TO) return { ok: false, error: "Authorization is not payable to this server" };
  if (BigInt(a.value) < minUnits) return { ok: false, error: "Authorized amount below quoted price" };
  const now = Math.floor(Date.now() / 1000);
  if (Number(a.validAfter) > now) return { ok: false, error: "Authorization not yet valid" };
  if (Number(a.validBefore) <= now + 15) return { ok: false, error: "Authorization expired or expires too soon" };

  if (facilitatorEnabled() && envelope) {
    const fac = await settleViaFacilitator(envelope, net, minUnits, quote);
    if (fac.ok || !SETTLE_KEY) return fac;
    console.error(`[x402-settle] ${fac.error} — falling back to self-settle`);
  }
  if (!SETTLE_KEY) return { ok: false, error: "Signed-authorization settlement not enabled on this server; use X-Payment-Tx" };

  const wallet = new ethers.Wallet(SETTLE_KEY, net.provider);
  const usdc = new ethers.Contract(net.usdc, USDC_ABI, wallet);
  const args = [a.from, a.to, a.value, a.validAfter, a.validBefore, a.nonce, signature];

  try {
    if (await usdc.authorizationState(a.from, a.nonce)) {
      return { ok: false, error: "Authorization nonce already used" };
    }
    await usdc.transferWithAuthorization.staticCall(...args); // pre-flight: reverts on bad sig/balance
    const tx = await usdc.transferWithAuthorization(...args);
    const receipt = await tx.wait(1);
    if (receipt.status !== 1) return { ok: false, error: "Settlement transaction reverted" };
    return { ok: true, txHash: receipt.hash, payer: a.from.toLowerCase(), amountUnits: String(a.value), network: net.key };
  } catch (e) {
    return { ok: false, error: "Settlement failed: " + (e.shortMessage || e.message) };
  }
}

/** x402 v2 SettlementResult, base64-encoded for the payment-response header. */
export function settlementResponseHeader(settle) {
  return Buffer.from(
    JSON.stringify({
      success: true,
      transaction: settle.txHash,
      network: `eip155:${NETWORKS.find((n) => n.key === settle.network)?.chainId}`,
      payer: settle.payer,
    })
  ).toString("base64");
}
