// @x402/evm is an OPTIONAL peer dependency: it is only needed for SINGIT_PAID_CHAT, and its zod 3
// dependency carries a published advisory (GHSA-mrhx-c7xc-m3w5), so it is not installed for free-only
// consumers. Everything here fails closed: a missing package means no request and no signing.
import { SingItPaymentError } from "./guards.js";

const SPECIFIERS = { upto: "@x402/evm/upto/client", exact: "@x402/evm/exact/client" };
const EXPORTS = { upto: "UptoEvmScheme", exact: "ExactEvmScheme" };

export const X402_INSTALL_HINT = "Paid chat needs the optional peer dependency @x402/evm: run "
  + "`npm install @x402/evm` and add `\"overrides\": { \"zod\": \"^4.6.7\" }` to your package.json "
  + "(see the README). No request was sent and nothing was signed.";

const defaultImporter = specifier => import(specifier);

// Loads the x402 client scheme class, or throws SingItPaymentError(X402_INSTALL_HINT) when the
// package is not installed. Other load errors propagate unchanged.
export async function loadX402Scheme(scheme, importModule = defaultImporter) {
  const specifier = SPECIFIERS[scheme];
  if (!specifier) throw new SingItPaymentError(`Unsupported x402 scheme: ${scheme}.`);
  let mod;
  try {
    mod = await importModule(specifier);
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND" || error?.code === "MODULE_NOT_FOUND") {
      throw new SingItPaymentError(X402_INSTALL_HINT);
    }
    throw error;
  }
  const Scheme = mod?.[EXPORTS[scheme]];
  if (typeof Scheme !== "function") throw new SingItPaymentError(X402_INSTALL_HINT);
  return Scheme;
}

// True when both client schemes can be loaded (what validate() and the provider report).
export async function isX402Available(importModule = defaultImporter) {
  try {
    await Promise.all(["upto", "exact"].map(scheme => loadX402Scheme(scheme, importModule)));
    return true;
  } catch {
    return false;
  }
}
