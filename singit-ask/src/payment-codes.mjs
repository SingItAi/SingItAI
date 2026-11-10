// Dependency-free public payment refusal vocabulary.
import { usd } from "./pricing.mjs";
export const PAYMENT_ERROR_CODES = ["payment_unfunded", "payment_blockhash_stale", "payment_replay", "payment_invalid"];
export const ACTIONS = {
  payment_unfunded: "fund_wallet", payment_blockhash_stale: "sign_again",
  payment_replay: "check_previous_result", payment_invalid: "fix_payment",
};
export const MESSAGES = {
  payment_unfunded: "Fund the wallet and its token account. Nothing was charged for this request.",
  payment_blockhash_stale: "Sign again with a fresh blockhash. Nothing was charged for this request.",
  payment_replay: "Check the previous result before paying again. Nothing was charged for this request.",
  payment_invalid: "Fix the payment before retrying. Nothing was charged for this request.",
};
// On Base an unfunded payer needs USDC, not a token account (that is Solana's); the facilitator's insufficient-funds
// reason alone says nothing about token accounts.
const BASE_UNFUNDED = "Fund the wallet with enough USDC on Base. Nothing was charged for this request.";
export const messageFor = (code, network) =>
  code === "payment_unfunded" && typeof network === "string" && network.startsWith("eip155:") ? BASE_UNFUNDED : MESSAGES[code];
export const ERRORS_DOCS = "https://singitai.app/docs/errors/";
// Solana refuses a transfer from (or to) an absent associated token account with these; anything else unfunded is
// a USDC shortfall.
export const missingFor = (text, network) =>
  !String(network ?? "").startsWith("eip155:") && /token account is missing|InvalidAccountData|AccountNotFound/i.test(text ?? "")
    ? "usdc_token_account" : "USDC";
// Machine-readable recovery step for an unfunded or under-approved payer. Only public facts: no addresses, mints or
// payer ids. The amount is the signed/required atomic USDC amount, omitted unless it is a decimal integer string.
export function nextAction({ type, missing, amount, network }) {
  const known = typeof amount === "string" && /^[0-9]+$/.test(amount);
  return { type, missing, ...(known ? { amountAtomic: amount, amountUsd: Number(usd(amount)) } : {}),
    ...(typeof network === "string" ? { network } : {}), asset: "USDC", docs: ERRORS_DOCS };
}
const chainName = network => network.startsWith("eip155:") ? "Base" : network.startsWith("solana:") ? "Solana" : null;
// The unfunded message with what is missing, how much and where, when those are known; messageFor otherwise.
export function unfundedMessage({ missing, amount, network } = {}) {
  const chain = typeof network === "string" ? chainName(network) : null;
  if (!chain) return messageFor("payment_unfunded", network);
  const much = typeof amount === "string" && /^[0-9]+$/.test(amount) ? `at least ${usd(amount)}` : "enough";
  const where = `USDC on ${chain} (${network})`;
  return (missing === "usdc_token_account"
    ? `Create the wallet's USDC token account and fund it with ${much} ${where}.`
    : chain === "Solana" ? `Fund the wallet's USDC token account with ${much} ${where}.`
    : `Fund the wallet with ${much} ${where}.`) + " Nothing was charged for this request.";
}
// Null when the text names no known cause, so a caller can tell "unknown" from "invalid".
function classifyKnownPaymentFailure({ reason, message } = {}) {
  const text = [reason, message].filter(v => typeof v === "string").join(" ");
  if (/insufficient_funds|insufficient balance|token account is missing|InvalidAccountData|InsufficientFunds|map\[Custom:1\]/i.test(text)) return "payment_unfunded";
  if (/BlockhashNotFound|blockhash (?:expired|not found|stale)/i.test(text)) return "payment_blockhash_stale";
  // SVM upto: facilitator settleDeposit returns invalid_upto_svm_channel_already_open
  // when that channel PDA already exists. Same public class as other replays.
  if (/already (?:submitted|used|settled|processed|on-chain)|nonce already|duplicate|replay|channel_already_open|channel already exists/i.test(text)) return "payment_replay";
  return null;
}
export function classifyPaymentFailure(input) {
  return classifyKnownPaymentFailure(input) ?? "payment_invalid";
}
