// Shared local-wallet helpers live in @singitai/session-wallet so @singitai/proxy
// uses the same ~/.singit/session file and the same load/create rules. This file
// stays the package's public path (tests and npm pack still list src/wallet.js).
export { loadWallet, loadOrCreateWallet, sessionDir, sessionPath, WalletError, NETWORK } from "@singitai/session-wallet";
