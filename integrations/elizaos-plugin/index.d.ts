import type { Action, Plugin, Provider } from "@elizaos/core";

export declare const DEFAULT_MCP_URL: string;
export declare const DEFAULT_ASK_BASE_URL: string;

export declare class SingItMcpError extends Error {
  code?: number;
  status?: number;
}

export declare class SingItMcpClient {
  constructor(options: { url?: string; apiKey?: string; fetchImpl?: typeof fetch });
  listTools(): Promise<unknown>;
  callTool(name: string, args?: Record<string, unknown>): Promise<unknown>;
}

export declare class SingItPaymentError extends Error {}
export declare class SingItAskError extends Error { status: number }

export interface BasePin {
  caip: string;
  chainId: number;
  viemChain: string;
  asset: string;
  payTo: string;
  defaultRpcUrl: string;
}
export declare const BASE_PIN: BasePin;

export declare const X402_INSTALL_HINT: string;
/** True when the optional peer @x402/evm can be loaded (needed for SINGIT_PAID_CHAT). */
export declare function isX402Available(): Promise<boolean>;

export interface PayAskRequestOptions {
  body: unknown;
  path?: string;
  baseUrl?: string;
  payTo?: string;
  rpcUrl?: string;
  scheme?: "upto" | "exact";
  evmPrivateKey: `0x${string}`;
  limiter: unknown;
  maxPerCallAtomic: string;
  fetchImpl?: typeof fetch;
  /** Test seam: replaces the dynamic import of @x402/evm client modules. */
  importModule?: (specifier: string) => Promise<unknown>;
}
export declare function payAskRequest(options: PayAskRequestOptions): Promise<{
  response: unknown;
  payment: { scheme: "upto" | "exact"; network: "base"; amountAtomic: string; txHash?: string } | null;
}>;

export declare const getSingitPriceAction: Action;
export declare const listSingitPriceSymbolsAction: Action;
export declare const listSingitModelsAction: Action;
export declare const singitWebSearchAction: Action;
export declare const singitReadPageAction: Action;
export declare const singitPaidChatAction: Action;
export declare const singitToolsProvider: Provider;

export declare const singitPlugin: Plugin;
export default singitPlugin;
