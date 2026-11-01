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
  /** Hard ceiling per UTC day across chat() and paidFetch() calls on this instance, in whole USD. Required, in-memory only. */
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
  /** Default "completions" (POST /v1/chat/completions, live today). "per-model" calls POST /v1/chat/{model} (SI-62, live). */
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
  /**
   * A fetch-compatible function for frameworks that take a custom fetch (LangChain's ChatOpenAI `configuration.fetch`,
   * the AI SDK's createOpenAICompatible({ fetch }), the OpenAI SDK's `fetch`). A request to baseUrl that gets HTTP 402 is
   * paid like chat(): same pins and per-call/per-day ceilings (shared with chat() on this instance), signed once, never
   * repeated. Other origins pass through unpaid. Non-streaming JSON answers only; set the framework's maxRetries to 0.
   */
  paidFetch(options?: { scheme?: SingItScheme }): typeof fetch;
  /** GET /v1/wallet/{address}/reconciliation on appBaseUrl (SI-67). */
  /** Private: options.apiKey must be a SingIt API key of the account that signs in with `address`. */
  walletReport(address: string, options?: { days?: number; apiKey?: string }): Promise<any>;
  /** GET /pricing.json on baseUrl (SI-68; live). */
  pricing(): Promise<any>;
  /** walletReport(address, options).allowance */
  allowance(address: string, options?: { days?: number; apiKey?: string }): Promise<any>;
}

export type WalletNetwork = "base" | "solana";
export interface WalletOptions { network?: WalletNetwork; outPath?: string; home?: string; includeKey?: boolean; }
export interface CreatedWallet { network: WalletNetwork; address: string; keyPath: string; }
export declare function createWallet(options: WalletOptions & { includeKey: true }): Promise<CreatedWallet & { privateKey: string }>;
export declare function createWallet(options?: WalletOptions): Promise<CreatedWallet & { privateKey?: string }>;
export declare function fundingUri(options: { network: WalletNetwork; address: string; amount?: string }): string;
