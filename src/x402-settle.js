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

import { ethers } from "ethers";
import { NETWORKS } from "./payment.js";

const PAY_TO = (process.env.PAY_TO || "").toLowerCase();
const SETTLE_KEY = process.env.SETTLE_PRIVATE_KEY || "";

const USDC_ABI = [
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes signature)",
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
];

export function settlementEnabled() {
  return Boolean(SETTLE_KEY);
}

export function settlementAddress() {
  return SETTLE_KEY ? new ethers.Wallet(SETTLE_KEY).address : null;
}

/** Decode either payment header shape into { authorization, signature, network }. */
export function parsePaymentHeader(headerValue) {
  const decoded = JSON.parse(Buffer.from(String(headerValue), "base64").toString("utf8"));
  const payload = decoded.payload || {};
  const network = decoded.accepted?.network || decoded.network || null;
  const { authorization, signature } = payload;
  if (!authorization || !signature) throw new Error("payment header missing payload.authorization/signature");
  return { authorization, signature, network };
}

/**
 * Validate the signed authorization against the quote and settle it on-chain.
 * @returns {{ ok:boolean, txHash?:string, payer?:string, amountUnits?:string, network?:string, error?:string }}
 */
export async function settlePayment({ authorization: a, signature, network }, minUnits) {
  if (!SETTLE_KEY) return { ok: false, error: "Signed-authorization settlement not enabled on this server; use X-Payment-Tx" };

  const chainId = Number(String(network || "").replace("eip155:", ""));
  const net = NETWORKS.find((n) => n.chainId === chainId);
  if (!net) return { ok: false, error: `Unsupported payment network: ${network}` };

  if ((a.to || "").toLowerCase() !== PAY_TO) return { ok: false, error: "Authorization is not payable to this server" };
  if (BigInt(a.value) < minUnits) return { ok: false, error: "Authorized amount below quoted price" };
  const now = Math.floor(Date.now() / 1000);
  if (Number(a.validAfter) > now) return { ok: false, error: "Authorization not yet valid" };
  if (Number(a.validBefore) <= now + 15) return { ok: false, error: "Authorization expired or expires too soon" };

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
