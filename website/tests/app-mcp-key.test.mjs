import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../app/main.js", import.meta.url), "utf8");
function section(start, end) {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from);
  return source.slice(from, to);
}
const kinds = section("const KEY_KINDS =", "const networkFee");
const helpers = section("function mcpKeyExamples()", "function renderUsageTab()");
function setup(kind = "mcp", balance = false) {
  const state = { newKey: "copy-once-test-value", newKeyKind: kind };
  const context = vm.createContext({ state, balanceOn: () => balance,
    esc: (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;"),
    keyExample: () => "SDK example", claudeCodeExample: () => "Claude example" });
  vm.runInContext(kinds + helpers + "\nglobalThis.kinds = KEY_KINDS;", context);
  return context;
}

test("MCP is the first preset and the existing presets retain their limits and hints", () => {
  const { kinds } = setup();
  assert.deepEqual(Object.keys(kinds), ["mcp", "code", "agent"]);
  assert.deepEqual(JSON.parse(JSON.stringify(kinds)), {
    mcp: { label: "Agent via MCP", daily: "1", per: "0.05", days: 7,
      hint: "For an agent in Claude Code, Cursor or Codex over MCP: $1 a day, $0.05 a request, 7 days." },
    code: { label: "My code", daily: "5", per: "0.25", days: 90, hint: "Scripts, bots and apps: short questions." },
    agent: { label: "Claude Code", daily: "20", per: "2", days: 90, hint: "Coding agents send long contexts: up to $2 a request." },
  });
});

test("opening, rendering and creating default to MCP and duration follows the kind", () => {
  assert.match(source, /"open-create-key": \(\) => \{ state.modal = \{ type: "create-key", kind: "mcp" \}/);
  assert.match(source, /const kind = KEY_KINDS\[m.kind\] \|\| KEY_KINDS.mcp;/);
  assert.match(source, /const kind = state.modal\?\.kind \|\| "mcp";/);
  assert.match(source, /k === kind \? "on"/);
  assert.match(source, /id="key-days" type="number" min="1" max="365" value="\$\{kind.days\}"/);
  assert.match(source, /state.newKeyKind = kind;/);
});

test("MCP snippets match the documented clients and never interpolate the key", () => {
  const context = setup();
  const examples = context.mcpKeyExamples();
  assert.equal(examples.claude, 'claude mcp add --transport http singit https://app.singitai.app/mcp --header "Authorization: Bearer $SINGIT_API_KEY"');
  assert.equal(examples.codex, 'codex mcp add singit --url https://app.singitai.app/mcp --bearer-token-env-var SINGIT_API_KEY');
  const docs = readFileSync(new URL("../docs/mcp-key/index.html", import.meta.url), "utf8");
  assert.ok(docs.includes(examples.cursor));
  assert.match(examples.cursor, /Bearer \$\{env:SINGIT_API_KEY\}/);
  const snippetHelpers = section("function mcpKeyExamples()", "function renderNewKey()");
  assert.doesNotMatch(snippetHelpers, /sk_singit_|state.newKey/);
  const html = context.renderNewKey();
  assert.equal(html.split("copy-once-test-value").length - 1, 1);
  assert.match(html, /export SINGIT_API_KEY=… in the shell that launches your client/);
  assert.match(html, /Check the limit: ask your agent to call get_limits/);
  assert.match(html, /free and read-only/);
  assert.match(html, /https:\/\/singitai.app\/docs\/mcp-key\//);
  assert.doesNotMatch(html, /SDK example|Claude example/);
});

test("other kinds keep the SDK example and balance-gated Claude Code example", () => {
  for (const kind of ["code", "agent"]) {
    for (const balance of [false, true]) {
      const html = setup(kind, balance).renderNewKey();
      assert.match(html, /SDK example/);
      assert.equal(html.includes("Claude example"), balance);
      assert.doesNotMatch(html, /get_limits/);
    }
  }
});
