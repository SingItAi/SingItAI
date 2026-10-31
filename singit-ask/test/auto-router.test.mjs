import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, ROUTE, readRequest, RequestError } from '../src/app.mjs';
import { AUTO_CONFIG, classifyAuto, chooseAuto, validateAutoConfig } from '../src/auto-router.mjs';
import { ceilings } from '../src/metered.mjs';
import { BASE, SOLANA, METERED_ROUTE, TERMS, SOLANA_TERMS, worstModelCostMicro, billUsage, exactReserveTokens, DEFAULT_EXACT_OUTPUT_FRACTION } from '../src/pricing.mjs';
const input = (text = 'hi', extra = {}) => readRequest({model: 'singit/auto', messages: [{role:'user', content:text}], max_tokens:512, ...extra});
// Offline price fixtures from website/data/models-snapshot.json (2026-10-30), USD per million.
// Include the cheap eco models: their quotes exercise the minimum ceiling, not just markup.
const rates = {
  'deepseek-v4.1-flash': [.045, .5], 'claude-haiku-5.5': [.1, .5], 'gemini-3.8-flash': [.825, 4.125],
  'claude-sonnet-5.5': [2, 10], 'kimi-k3': [.192, 15],
  'claude-opus-5.5': [4, 20], 'gpt-5.5': [5, 30], 'gemini-3.1-pro-preview': [2, 12],
};
const models = Object.values(AUTO_CONFIG.tiers).flat().map(id => ({id,
  promptUsdPerToken: rates[id][0]*1e-6, completionUsdPerToken: rates[id][1]*1e-6}));
const catalogue = {resolve: async id => models.find(m=>m.id===id), canAnswer: async()=>true};
test('classifier boundaries, whole phrases and min_tier', () => {
  for (const [text, extra, tier] of [
    ['a'.repeat(1600),{},'eco'], ['a'.repeat(1601),{},'standard'],
    ['hi',{max_tokens:513},'standard'], ['a'.repeat(23996),{},'standard'],
    ['a'.repeat(23997),{},'premium'], ['DEBUG ```x```',{},'premium'],
    ['debug',{max_tokens:1000},'premium'], ['debug',{max_tokens:999},'standard'],
    ['debugger',{},'eco'], ['step by step',{},'standard'],
    ['debug '+'a'.repeat(5994),{},'premium'], ['debug '+'a'.repeat(5990),{},'standard'],
    ['hi',{min_tier:'standard'},'standard'], ['hi',{min_tier:'premium'},'premium'],
    ['hi',{max_tokens:undefined},'standard'],
    ['hi',{messages:Array.from({length:4},()=>({role:'user',content:'hi'}))},'standard'],
  ]) assert.equal(classifyAuto(input(text,extra)).tier,tier);
  assert.equal(classifyAuto(input('debug', {max_tokens:1000})).reason, 'reasoning_large_output');
  for (const extra of [{min_tier:null},{min_tier:'bad'},{model:'other',min_tier:'eco'}]) assert.throws(()=>input('hi',extra),e=>e.status===400);
});
test('config, healthy selection, escalation, tie order and determinism', async()=>{
  validateAutoConfig(AUTO_CONFIG);
  assert.throws(()=>validateAutoConfig({...AUTO_CONFIG,tiers:{...AUTO_CONFIG.tiers,eco:['free/test']}}));
  const a = await chooseAuto({},catalogue,input(),RequestError);
  assert.equal(a.model,AUTO_CONFIG.tiers.eco[0]);
  assert.deepEqual(await chooseAuto({},catalogue,input(),RequestError),a);
  const unhealthy = {...catalogue,canAnswer:async id=>!AUTO_CONFIG.tiers.eco.includes(id)};
  assert.equal((await chooseAuto({},unhealthy,input(),RequestError)).autoTier,'standard');
  assert.equal((await chooseAuto({},{...catalogue,isUnservable:id=>!AUTO_CONFIG.tiers.premium.includes(id)},input(),RequestError)).autoTier,'premium');
  await assert.rejects(chooseAuto({},{...catalogue,canAnswer:async()=>false},input(),RequestError),e=>e.status===503 && !!e.retryAfter);
});
test('every tier retains margin and floor on both priced budgets',()=>{
  assert.equal(models.length, 8);
  assert.deepEqual(models.map(m=>m.id).sort(), Object.keys(rates).sort());
  for(const model of models) for(const chars of [1,1600,24000]) for(const maxTokens of [32,512,1200]) {
    const request={chars,maxTokens,messageCount:2}, quotes=ceilings(model,request);
    for(const [net,terms] of [[BASE,TERMS],[SOLANA,SOLANA_TERMS]]) for(const scheme of ['upto','exact']) {
      const cost=BigInt(worstModelCostMicro(model,{...request,charsPerToken:scheme==='upto'?1:4,
        maxTokens:scheme==='upto'?maxTokens:Math.ceil(maxTokens*DEFAULT_EXACT_OUTPUT_FRACTION),
        reserveTokens:scheme==='upto'?null:exactReserveTokens(model.id,maxTokens)}));
      const minimum=cost+(cost*3000n+9999n)/10000n+BigInt(terms.settlementFeeAtomic);
      assert.ok(BigInt(quotes[scheme][net])>=minimum); assert.ok(BigInt(quotes[scheme][net])>=1500n);
      assert.ok(BigInt(billUsage({buyer_cost_micro:cost.toString()},{...terms,maxChargeAtomic:quotes[scheme][net]}).totalAtomic)>=minimum);
    }
  }
});

const CONFIG = {payToSolana:"9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",payToBase:"0x1111111111111111111111111111111111111111",model:"deepseek-v4.1-flash",surplusUrl:"https://surplus.test"};
const encode=v=>Buffer.from(JSON.stringify(v)).toString("base64");
const decode=v=>JSON.parse(Buffer.from(v,"base64").toString());
catalogue.list=async()=>models;
function fakeFacilitator() {
  const calls = { verify: 0, settle: [] };
  return { calls,
    async getSupported() {
      return { kinds: [
        { x402Version: 2, scheme: "exact", network: BASE },
        { x402Version: 2, scheme: "exact", network: SOLANA, extra: { feePayer: "Hc3sdEAsCGQcpgfivywog9uwtk8gUBUZgsxdME1EJy88" } },
        { x402Version: 2, scheme: "upto", network: BASE, extra: { facilitatorAddress: "0x" + "3".repeat(40) } },
        { x402Version: 2, scheme: "upto", network: SOLANA, extra: { feePayer: "Hc3sdEAsCGQcpgfivywog9uwtk8gUBUZgsxdME1EJy88",
          receiverAuthorizer: "9dpHxn3XFZMZv59vE5MKxhfwGUCCgkcCUzYZLpdEm7ox" } },
      ], extensions: ["bazaar", "eip2612GasSponsoring"], signers: {} };
    },
    async verify() { calls.verify += 1; return { isValid: true, payer: "0x2222222222222222222222222222222222222222" }; },
    async settle(_payload, requirements) {
      calls.settle.push([requirements.network, requirements.amount]);
      return { success: true, transaction: "0x" + "a".repeat(64), network: requirements.network };
    } };
}

async function serve(t, { upstream, catalogue: selectedCatalogue = catalogue } = {}) {
  const facilitator = fakeFacilitator();
  const asked = [];
  const answer = upstream ?? (async (_config, messages, maxTokens, _fetchImpl, model) => {
    asked.push({ model, messages, maxTokens });
    return { content: "Try Caffè Propaganda.", finishReason: "stop", usage: { total_tokens: 42, buyer_cost_micro: 100 } };
  });
  const app = createApp(CONFIG, { facilitatorClient: facilitator, upstream: answer, log: () => {}, catalogue: selectedCatalogue });
  const listener = await new Promise((resolve) => { const l = app.listen(0, "127.0.0.1", () => resolve(l)); });
  t.after(() => listener.close());
  return { url: `http://127.0.0.1:${listener.address().port}`, facilitator, asked };
}

const post = (url, body, headers = {}) => fetch(url, { method: "POST",
  headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
const pay = (required, network, scheme = "upto") => ({ "PAYMENT-SIGNATURE": encode({ x402Version: 2, resource: required.resource,
  accepted: required.accepts.find((a) => a.network === network && a.scheme === scheme), payload: { signature: "0xsigned" },
  extensions: required.extensions }) });


for (const path of [ROUTE, METERED_ROUTE]) test(`auto headers, paid model and price, validation: ${path}`, async t=>{
 const {url,asked,facilitator}=await serve(t);
 const body={model:'singit/auto',messages:[{role:'user',content:'Hi'}],max_tokens:512};
 const r=await post(url+path,body); assert.equal(r.status,402);
 const required=decode(r.headers.get('payment-required'));
 const concrete=await chooseAuto(CONFIG,catalogue,readRequest(body),RequestError);
 assert.equal(r.headers.get('x-singit-model'),concrete.model);
 const expected=ceilings(concrete.info,concrete);
 for(const offer of required.accepts) assert.equal(offer.amount,expected[offer.scheme][offer.network]);
 const paid=await post(url+path,body,pay(required,BASE));
 assert.equal(paid.status,200); assert.equal(r.headers.get('x-singit-tier'),'eco');
 assert.equal(paid.headers.get('x-singit-model'),r.headers.get('x-singit-model'));
 assert.equal(paid.headers.get('x-singit-tier'),'eco'); assert.equal(asked[0].model,r.headers.get('x-singit-model'));
 for(const extra of [{min_tier:null},{min_tier:'bad'},{model:CONFIG.model,min_tier:'eco'}]) {
  const bad=await post(url+path,{...body,...extra}); assert.equal(bad.status,400);
  assert.equal((await bad.json()).error.code,'invalid_request'); assert.equal(bad.headers.get('payment-required'),null);
 }
 for(const path of ['/v1/messages','/v1/responses']) {
  const bad=await post(url+path,{...body,input:"hi"}); assert.ok(bad.status>=400); assert.equal(bad.headers.get('payment-required'),null); assert.equal(bad.headers.get('x-singit-model'),null);
 }
 const raised=await post(url+path,{...body,min_tier:'premium'});
 assert.equal(raised.status,402); assert.equal(raised.headers.get('x-singit-tier'),'premium');
 for(const [max_tokens,tier] of [[999,'standard'],[1000,'premium']]) {
  const boundary=await post(url+path,{...body,messages:[{role:'user',content:'debug'}],max_tokens});
  assert.equal(boundary.status,402); assert.equal(boundary.headers.get('x-singit-tier'),tier);
 }
 assert.equal(facilitator.calls.verify,1); assert.equal(facilitator.calls.settle.length,1);
});
// With unchanged health, identical unpaid and paid bodies choose the same model and ceilings.
// Health changes between challenge and retry can change the model and price. The existing
// middleware refuses a signed amount that no longer matches before upstream or settlement.
// Equal ceilings may still match, in which case the newly chosen healthy model answers.

test('chosen headers survive unpaid and paid retries on both chat routes, including upstream errors', async t=>{
 for (const path of [ROUTE, METERED_ROUTE]) for (const code of [undefined, 'max_tokens_spent_reasoning']) {
  const {url,facilitator}=await serve(t,{upstream:async()=>{throw Object.assign(new Error('offline'),{code});}});
  const body={model:'singit/auto',messages:[{role:'user',content:'debug'}],max_tokens:1000};
  const challenge=await post(url+path,body);
  assert.equal(challenge.status,402);
  const response=await post(url+path,body,pay(decode(challenge.headers.get('payment-required')),BASE));
  assert.equal(response.status,code?422:503);
  for(const header of ['x-singit-model','x-singit-tier']) {
   assert.ok(challenge.headers.get(header)); assert.equal(response.headers.get(header),challenge.headers.get(header));
  }
  assert.equal(response.headers.get('x-singit-tier'),'premium');
  assert.equal(facilitator.calls.settle.length,0);
 }
});
test('HTTP health escalation never goes down and exhaustion refuses payment',async t=>{
 for(const healthy of ['standard','premium',null]) {
  const {url,facilitator}=await serve(t,{catalogue:{...catalogue,canAnswer:async id=>healthy!==null && AUTO_CONFIG.tiers[healthy].includes(id)}});
  for(const min_tier of ['eco','standard','premium']) {
   const response=await post(url+ROUTE,{model:'singit/auto',min_tier,messages:[{role:'user',content:'hi'}],max_tokens:512});
   if(healthy && ['eco','standard','premium'].indexOf(healthy)>=['eco','standard','premium'].indexOf(min_tier)) {
    assert.equal(response.status,402); assert.equal(response.headers.get('x-singit-tier'),healthy);
   } else {
    assert.equal(response.status,503); assert.equal((await response.json()).error.code,'no_healthy_sellers');
    assert.ok(Number(response.headers.get('retry-after'))>0); assert.equal(response.headers.get('payment-required'),null);
   }
  }
  assert.equal(facilitator.calls.verify,0); assert.equal(facilitator.calls.settle.length,0);
 }
});
