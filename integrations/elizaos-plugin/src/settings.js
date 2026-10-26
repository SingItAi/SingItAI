// Reads a runtime setting, falling back to the process environment. Never logs the value: callers
// must not interpolate the result into a log line or thrown error message.
export function readSetting(runtime, key) {
  const fromRuntime = runtime?.getSetting?.(key);
  if (fromRuntime !== undefined && fromRuntime !== null && fromRuntime !== "") return fromRuntime;
  const fromEnv = process.env[key];
  return fromEnv !== undefined && fromEnv !== "" ? fromEnv : null;
}

export function readNumberSetting(runtime, key) {
  const raw = readSetting(runtime, key);
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}
