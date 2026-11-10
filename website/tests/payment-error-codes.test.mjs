import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PAYMENT_ERROR_CODES, ACTIONS } from "../../singit-ask/src/payment-codes.mjs";

test("payment refusal codes and actions agree across public docs", () => {
  for (const path of ["website/docs/errors/index.html", "website/llms.txt", "singit-ask/ERRORS.md"]) {
    const text = readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
    for (const code of PAYMENT_ERROR_CODES) {
      assert.ok(text.includes(code), `${path}: ${code}`);
      assert.ok(text.includes(ACTIONS[code]), `${path}: ${ACTIONS[code]}`);
    }
    assert.ok(text.includes("payment_duplicate"), path);
  }
});

test("docs/errors documents next_action and amountAtomic as the required amount", () => {
  const text = readFileSync(new URL("../../website/docs/errors/index.html", import.meta.url), "utf8");
  assert.match(text, /next_action/);
  assert.match(text, /amountAtomic/);
  assert.match(text, /required amount/);
  assert.match(text, /not the shortfall/);
  assert.match(text, /approve_allowance/);
  assert.ok(text.includes("&quot;amountAtomic&quot;: &quot;10000&quot;"));
  assert.ok(text.includes("&quot;type&quot;: &quot;fund_wallet&quot;"));
});
