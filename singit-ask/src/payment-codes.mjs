// Dependency-free public payment refusal vocabulary.
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
// Null when the text names no known cause, so a caller can tell "unknown" from "invalid".
function classifyKnownPaymentFailure({ reason, message } = {}) {
  const text = [reason, message].filter(v => typeof v === "string").join(" ");
  if (/insufficient_funds|insufficient balance|token account is missing|InvalidAccountData|InsufficientFunds|map\[Custom:1\]/i.test(text)) return "payment_unfunded";
  if (/BlockhashNotFound|blockhash (?:expired|not found|stale)/i.test(text)) return "payment_blockhash_stale";
  if (/already (?:submitted|used|settled|processed|on-chain)|nonce already|duplicate|replay/i.test(text)) return "payment_replay";
  return null;
}
export function classifyPaymentFailure(input) {
  return classifyKnownPaymentFailure(input) ?? "payment_invalid";
}
