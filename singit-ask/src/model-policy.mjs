// Assumed Surplus id: claude-fable-5.2, mirroring 5.1; revise if its live listing differs.
export const isFable52 = id => id === "claude-fable-5.2" || /^claude-fable-5-2(?:-\d{8})?$/.test(id);
export const samplingAllowed = (id, name) => !isFable52(id) || !["temperature", "top_p", "top_k"].includes(name);
export function forcedToolError(id, choice) {
  const type = typeof choice === "string" ? choice : choice?.type;
  return isFable52(id) && ["required", "function", "any", "tool"].includes(type)
    ? Object.assign(new Error("Claude Fable 5.2 does not support forced tool use; use auto or none. Nothing was charged."), { status: 400, code: "forced_tools_unsupported" }) : null;
}
