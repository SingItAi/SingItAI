// Base Builder Code (ERC-8021) attribution for the x402 payments SingIt Ask sells.
//
// The code is declared in every 402 as the `builder-code` extension's app code (`a`). The buyer's
// x402 client echoes it in its payment, and the CDP facilitator appends it, with its own wallet code
// (`w`), as an ERC-8021 schema-2 suffix to the settlement calldata on Base, which is where base.dev
// counts the payment for this app. Solana settlements carry no calldata suffix.
//
// Read from SIGN402_BASE_BUILDER_CODE only (never from git). Unset or invalid: no extension at all,
// the 402 stays exactly as before. The value is never logged.
import { BUILDER_CODE, BUILDER_CODE_PATTERN, builderCodeResourceServerExtension, declareBuilderCodeExtension }
  from "@x402/extensions/builder-code";

export const BUILDER_CODE_ENV = "SIGN402_BASE_BUILDER_CODE";
let warned = false;

export function appBuilderCode(env = process.env, log = console.error) {
  const code = String(env[BUILDER_CODE_ENV] ?? "").trim();
  if (!code) return null;
  if (BUILDER_CODE_PATTERN.test(code)) return code;
  if (!warned) log(`singit-ask: ${BUILDER_CODE_ENV} is set but is not a valid builder code; attribution is off.`);
  warned = true;
  return null;
}

// A route whose offers are not a plain list (a function) may offer Base, so it is declared too.
function offersBase(accepts) {
  const list = Array.isArray(accepts) ? accepts : [accepts];
  return list.some((offer) => typeof offer?.network !== "string" || offer.network.startsWith("eip155:"));
}

// `routes` in paymentMiddleware's shape; returns a copy with the declaration on each route that can be paid on Base.
export function withBuilderCode(routes, server, code = appBuilderCode()) {
  if (!code) return routes;
  if (!server.hasExtension(BUILDER_CODE)) server.registerExtension(builderCodeResourceServerExtension);
  return Object.fromEntries(Object.entries(routes).map(([pattern, route]) => [pattern, offersBase(route.accepts)
    ? { ...route, extensions: { ...route.extensions, [BUILDER_CODE]: declareBuilderCodeExtension(code) } }
    : route]));
}
