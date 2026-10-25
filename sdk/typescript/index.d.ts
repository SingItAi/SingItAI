export type SingItNetwork = "base" | "base-sepolia" | "solana";
export type SingItScheme = "upto" | "exact";
export type SingItRoute = "completions" | "per-model";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface SingItOptions {
  /** Hex-encoded EVM private key (0x...). Ignored for network: "solana". */
  evmPrivateKey?: `0x${string}`;
  /** A viem Account (e.g. from privateKeyToAccount or a hardware/remote signer). Alternative to evmPrivateKey. */
  evmAccount?: unknown;
  /** A @solana/kit TransactionSigner. Required for network: "solana". */
  solanaSigner?: unknown;
  network: SingItNetwork;
  /** SingIt Ask base URL. Default: "https://ask.singitai.app". */
  baseUrl?: string;
  /** app.singitai.app base URL used by walletReport/allowance. Default: "https://app.singitai.app". */
  appBaseUrl?: string;
  /** Required for network: "base-sepolia" (no SingIt deployment there to pin a default). */
  payTo?: string;
  /** Override the default public RPC endpoint for the configured network. */
  rpcUrl?: string;
  /** Hard ceiling per chat() call, in whole USD (e.g. 0.01). Required. */
  maxPerCallUsd: number;
  /** Hard ceiling per rolling UTC day across all chat() calls, in whole USD. Required, in-memory only. */
  maxPerDayUsd: number;
  fetchImpl?: typeof fetch;
}

export interface ChatOptions {
  /** Model id. Required when route is "per-model"; optional otherwise (server default applies). */
  model?: string;
  messages: ChatMessage[];
  max_tokens?: number;
  /** Default "upto": pay only the actual answer cost, up to the offered ceiling. "exact" pays the ceiling flat. */
  scheme?: SingItScheme;
  /** Default "completions" (POST /v1/chat/completions, live today). "per-model" calls POST /v1/chat/{model} (SI-62, may not be deployed yet). */
  route?: SingItRoute;
}

export interface PaymentInfo {
  scheme: SingItScheme;
  network: SingItNetwork;
  amountAtomic: string;
  txHash?: string;
}

export interface ChatResult {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{ index: number; message: ChatMessage; finish_reason: string }>;
  usage?: unknown;
  billing?: unknown;
  payment: PaymentInfo | null;
}

export declare class SingItPaymentError extends Error {}

export declare class SingIt {
  constructor(options: SingItOptions);
  chat(options: ChatOptions): Promise<ChatResult>;
  /** GET /v1/wallet/{address}/reconciliation on appBaseUrl (SI-67; may not be deployed yet). */
  walletReport(address: string, options?: { days?: number }): Promise<any>;
  /** GET /pricing.json on baseUrl (SI-68; may not be deployed yet). */
  pricing(): Promise<any>;
  /** walletReport(address, options).allowance */
  allowance(address: string, options?: { days?: number }): Promise<any>;
}
