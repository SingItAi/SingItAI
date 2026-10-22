let builderCodeDataSuffix;

// Test-only: the module caches the resolved suffix after the first call.
export function _resetForTests() {
  builderCodeDataSuffix = undefined;
}

export async function loadBuilderCodeDataSuffix() {
  if (builderCodeDataSuffix !== undefined) {
    return builderCodeDataSuffix;
  }
  const code = (process.env.SIGN402_BASE_BUILDER_CODE || "").trim();
  if (!code) {
    builderCodeDataSuffix = null;
    return builderCodeDataSuffix;
  }
  try {
    const { Attribution } = await import("ox/erc8021");
    builderCodeDataSuffix = Attribution.toDataSuffix({ codes: [code] });
  } catch (error) {
    // Attribution is a reporting nicety. It must never block a payment.
    console.error(`builder code attribution disabled: ${error.message}`);
    builderCodeDataSuffix = null;
  }
  return builderCodeDataSuffix;
}

export async function walletClientOptions(base) {
  const dataSuffix = await loadBuilderCodeDataSuffix();
  return dataSuffix ? { ...base, dataSuffix } : base;
}
