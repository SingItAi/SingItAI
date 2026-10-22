import test from "node:test";
import assert from "node:assert/strict";

import { decodeFunctionData, erc20Abi } from "viem";

import { transferUsdc } from "../src/usdc-transfer.mjs";


const RECIPIENT = "0x2A52e5eA26013bdCDCfEf8b71d700A6cDc918423";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const HASH = `0x${"1".repeat(64)}`;


function fakeAccount() {
  const transferCalls = [];
  const sendTransactionCalls = [];
  return {
    transferCalls,
    sendTransactionCalls,
    transfer: async (request) => {
      transferCalls.push(request);
      return { transactionHash: HASH };
    },
    sendTransaction: async (request) => {
      sendTransactionCalls.push(request);
      return { transactionHash: HASH };
    },
  };
}


test("without a dataSuffix, transferUsdc calls account.transfer unchanged", async () => {
  const account = fakeAccount();

  const result = await transferUsdc({
    account,
    to: RECIPIENT,
    amount: 1_000_000n,
    network: "base",
    dataSuffix: null,
  });

  assert.equal(account.transferCalls.length, 1);
  assert.deepEqual(account.transferCalls[0], {
    to: RECIPIENT,
    amount: 1_000_000n,
    token: "usdc",
    network: "base",
  });
  assert.equal(account.sendTransactionCalls.length, 0);
  assert.equal(result.ok, true);
  assert.equal(result.transactionHash, HASH);
  assert.equal(result.to, RECIPIENT);
  assert.equal(result.amount, "1000000");
  assert.equal(result.token, "usdc");
  assert.equal(result.network, "base");
});


test("with a dataSuffix, transferUsdc builds the ERC-20 transfer with the suffix appended", async () => {
  const account = fakeAccount();
  const suffix = "0x" + Buffer.from("bc_test1234").toString("hex");

  const result = await transferUsdc({
    account,
    to: RECIPIENT,
    amount: 1_000_000n,
    network: "base",
    dataSuffix: suffix,
  });

  assert.equal(account.transferCalls.length, 0);
  assert.equal(account.sendTransactionCalls.length, 1);
  const sent = account.sendTransactionCalls[0];
  assert.equal(sent.network, "base");
  assert.equal(sent.transaction.to, USDC_BASE);
  assert.ok(sent.transaction.data.startsWith("0xa9059cbb"));
  assert.ok(sent.transaction.data.endsWith(suffix.slice(2)));

  const decoded = decodeFunctionData({
    abi: erc20Abi,
    data: sent.transaction.data,
  });
  assert.equal(decoded.functionName, "transfer");
  assert.equal(decoded.args[0], RECIPIENT);
  assert.equal(decoded.args[1], 1_000_000n);

  assert.equal(result.ok, true);
  assert.equal(result.transactionHash, HASH);
});


test("with a dataSuffix but an unknown network, transferUsdc falls back to account.transfer", async () => {
  const account = fakeAccount();
  const suffix = "0x" + Buffer.from("bc_test1234").toString("hex");

  await transferUsdc({
    account,
    to: RECIPIENT,
    amount: 1_000_000n,
    network: "some-other-network",
    dataSuffix: suffix,
  });

  assert.equal(account.transferCalls.length, 1);
  assert.equal(account.sendTransactionCalls.length, 0);
});
