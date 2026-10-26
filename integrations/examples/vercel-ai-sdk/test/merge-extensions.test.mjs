import test from "node:test";
import assert from "node:assert/strict";
import { mergeExtensions } from "../src/x402/pay.js";

test("mergeExtensions keeps the merchant's declared fields next to the signed ones", () => {
  const declared = { eip2612GasSponsoring: { info: { name: "USD Coin", version: "2" }, schema: { type: "object" } } };
  const signed = { eip2612GasSponsoring: { info: { signature: "0xsig", deadline: "1" } } };
  assert.deepEqual(mergeExtensions(signed, declared), {
    eip2612GasSponsoring: { schema: { type: "object" }, info: { name: "USD Coin", version: "2", signature: "0xsig", deadline: "1" } },
  });
  assert.equal(mergeExtensions(undefined, declared), undefined);
  assert.deepEqual(mergeExtensions({ x: { info: { a: 1 } } }, undefined), { x: { info: { a: 1 } } });
});
