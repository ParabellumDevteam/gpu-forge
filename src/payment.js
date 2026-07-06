// payment.js
// Verifies USDC payments for the x402-style paywall, on any enabled network.
// Flow: client sends a tx hash in the X-Payment-Tx header. We locate the tx on
// one of the enabled chains, then check it is a confirmed USDC Transfer to
// PAY_TO for at least the quoted amount. Replay protection lives in ledger.js.

import { ethers } from "ethers";

const PAY_TO = (process.env.PAY_TO || "").toLowerCase();
const MIN_CONFIRMATIONS = Number(process.env.MIN_CONFIRMATIONS || 5);

const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");

// Enabled payment rails. Same receiving EOA on every EVM chain.
// USDC defaults are the native (Circle-issued) deployments; override per
// network in .env if you ever need the bridged variants.
// Base first: marketplace validators (Coinbase Bazaar, x402scan) only accept
// Base and judge accepts[0], so the preferred rail must lead the list.
export const NETWORKS = [
  {
    key: "base",
    chainId: 8453,
    rpc: process.env.BASE_RPC || "https://base-rpc.publicnode.com",
    usdc: (process.env.BASE_USDC_ADDRESS || "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913").toLowerCase(),
  },
  {
    key: "polygon",
    chainId: 137,
    rpc: process.env.POLYGON_RPC || "https://polygon-bor-rpc.publicnode.com",
    usdc: (process.env.USDC_ADDRESS || "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359").toLowerCase(),
  },
];

for (const net of NETWORKS) net.provider = new ethers.JsonRpcProvider(net.rpc);

export function usdcToUnits(amountUsd) {
  // USDC has 6 decimals on every enabled network
  return ethers.parseUnits(String(amountUsd), 6);
}

async function verifyOnNetwork(net, txHash, minUnits) {
  let receipt;
  try {
    receipt = await net.provider.getTransactionReceipt(txHash);
  } catch (e) {
    return { found: false, error: "RPC error: " + e.message };
  }
  if (!receipt) return { found: false };
  if (receipt.status !== 1) return { found: true, ok: false, error: "Transaction reverted" };

  const current = await net.provider.getBlockNumber();
  const confirmations = current - receipt.blockNumber + 1;
  if (confirmations < MIN_CONFIRMATIONS) {
    return {
      found: true,
      ok: false,
      error: `Only ${confirmations}/${MIN_CONFIRMATIONS} confirmations on ${net.key}, retry shortly`,
    };
  }

  // Find a USDC Transfer log where the recipient is PAY_TO
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== net.usdc) continue;
    if (log.topics[0] !== TRANSFER_TOPIC) continue;

    const from = "0x" + log.topics[1].slice(26).toLowerCase();
    const to = "0x" + log.topics[2].slice(26).toLowerCase();
    const value = BigInt(log.data);

    if (to === PAY_TO && value >= minUnits) {
      return { found: true, ok: true, payer: from, amountUnits: value.toString(), network: net.key };
    }
  }

  return {
    found: true,
    ok: false,
    error: `No USDC transfer to the payment address for the required amount found in this tx on ${net.key}`,
  };
}

/**
 * Verify a USDC payment on any enabled network.
 * A tx hash can only exist on one chain in practice, so the first network
 * where the receipt is found decides the outcome.
 * @param {string} txHash   Transaction hash supplied by the client
 * @param {bigint} minUnits Minimum acceptable amount in USDC base units
 * @returns {{ ok: boolean, payer?: string, amountUnits?: string, network?: string, error?: string }}
 */
export async function verifyPayment(txHash, minUnits) {
  if (!PAY_TO) return { ok: false, error: "Server misconfigured: PAY_TO not set" };
  if (!/^0x([0-9a-fA-F]{64})$/.test(txHash || "")) {
    return { ok: false, error: "Invalid tx hash format" };
  }

  const rpcErrors = [];
  const results = await Promise.allSettled(NETWORKS.map((net) => verifyOnNetwork(net, txHash, minUnits)));
  for (const r of results) {
    if (r.status !== "fulfilled") continue;
    if (r.value.found) return r.value.ok ? r.value : { ok: false, error: r.value.error };
    if (r.value.error) rpcErrors.push(r.value.error);
  }
  if (rpcErrors.length === NETWORKS.length) return { ok: false, error: rpcErrors[0] };
  return {
    ok: false,
    error: `Transaction not found on ${NETWORKS.map((n) => n.key).join(" or ")} (not mined yet?)`,
  };
}

export const paymentInfo = {
  networks: NETWORKS.map((n) => ({
    network: n.key,
    chainId: n.chainId,
    asset: "USDC",
    assetAddress: n.usdc,
    decimals: 6,
  })),
  payTo: process.env.PAY_TO || "",
  minConfirmations: MIN_CONFIRMATIONS,
  // Back-compat fields (historical primary network) for existing consumers
  network: "polygon",
  chainId: 137,
  asset: "USDC",
  assetAddress: NETWORKS.find((n) => n.key === "polygon").usdc,
  decimals: 6,
};
