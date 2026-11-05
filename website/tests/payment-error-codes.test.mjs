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
