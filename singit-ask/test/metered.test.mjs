import { test } from 'node:test';
import assert from 'node:assert/strict';
import { privateKeyToAccount } from 'viem/accounts';
import { createApp } from '../src/app.mjs';
import { BASE, ASSET, PAY_TO, TERMS, METERED_ROUTE, billUsage, ceilingAtomic, DEFAULT_EXACT_OUTPUT_FRACTION } from '../src/pricing.mjs';
import { ceilings } from '../src/metered.mjs';
import { ENDPOINT, selectOffer, payMetered, validateTransfer } from '../src/metered-buyer.mjs';
const CDP_SIGNER = '0x2A89407a98A0732b7fD578c4E156B7166540EB5A';
// CDP also supports Solana upto, which the public route offers next to Base.
const SOLANA_UPTO = {x402Version:2,scheme:'upto',network:'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
  extra:{feePayer:'Hc3sdEAsCGQcpgfivywog9uwtk8gUBUZgsxdME1EJy88',receiverAuthorizer:'9dpHxn3XFZMZv59vE5MKxhfwGUCCgkcCUzYZLpdEm7ox'}};
const encode = v => Buffer.from(JSON.stringify(v)).toString('base64');
const decode = v => JSON.parse(Buffer.from(v, 'base64').toString());
const account = privateKeyToAccount('0x' + '11'.repeat(32)); // Public unfunded test fixture.
const offer = () => ({ x402Version:2, resource:{url:ENDPOINT}, extensions:{eip2612GasSponsoring:{info:{version:'1'}}}, accepts:[{
  scheme:'upto', network:BASE, amount:'3000', asset:ASSET, payTo:PAY_TO, maxTimeoutSeconds:120,
  extra:{name:'USD Coin',version:'2',assetTransferMethod:'permit2',facilitatorAddress:CDP_SIGNER,billing:TERMS},
}] });
const usage={prompt_tokens:50,completion_tokens:10,buyer_cost_micro:100};
const body={choices:[{message:{content:'Hello'}}],usage,billing:billUsage(usage)};
const tx='0x'+'aa'.repeat(32);
const receipt=amount=>({status:'success',logs:[{address:ASSET,logIndex:3,
  topics:['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
    '0x'+account.address.slice(2).toLowerCase().padStart(64,'0'),'0x'+PAY_TO.slice(2).toLowerCase().padStart(64,'0')],data:'0x'+BigInt(amount).toString(16)}]});

test('actual cost, upward rounding, missing cost and cap enforcement',()=>{
  assert.equal(billUsage({buyer_cost_micro:0}).totalAtomic,'1000');
  assert.equal(billUsage({buyer_cost_micro:1}).totalAtomic,'1002');
  assert.equal(billUsage(usage).totalAtomic,'1130');
  for(const cost of [undefined,-1,1.1,'1e3',NaN,Infinity,Number.MAX_SAFE_INTEGER+1,2000]) assert.throws(()=>billUsage({buyer_cost_micro:cost}));
});
test('changed payment terms are refused before signing',()=>{
  assert.equal(selectOffer(offer()).amount,'3000');
  for(const [key,value] of [['payTo',account.address],['amount','3001'],['asset',account.address],['network','eip155:1']]){
    const q=offer();q.accepts[0][key]=value;assert.throws(()=>selectOffer(q));
  }
  for(const [key,value] of [['facilitatorAddress','0x'+'0'.repeat(40)],['billing',{...TERMS,markupBps:4000}]]){
    const q=offer();q.accepts[0].extra[key]=value;assert.throws(()=>selectOffer(q));
  }
});
test('real SDK signs bounded sponsored approval and submits once; receipt proves actual cost',async()=>{
  let calls=0,checkpoint;
  const result=await payMetered({signer:{...account,readContract:async()=>0n},body:{messages:[{role:'user',content:'Hi'}]},
    beforeSubmit:async value=>{checkpoint=value;},chain:{waitForTransactionReceipt:async()=>receipt(1130)},
    fetchImpl:async(url,init)=>{
      assert.equal(url,ENDPOINT);calls++;
      if(calls===1)return new Response('',{status:402,headers:{'payment-required':encode(offer())}});
      assert.ok(checkpoint);const signed=decode(init.headers['PAYMENT-SIGNATURE']);
      assert.equal(signed.extensions.eip2612GasSponsoring.info.amount,'3000');
      assert.equal(signed.payload.permit2Authorization.permitted.amount,'3000');
      return new Response(JSON.stringify(body),{status:200,headers:{'payment-response':encode({success:true,network:BASE,payer:account.address,transaction:tx})}});
    }});
  assert.equal(calls,2);assert.equal(result.amountAtomic,'1130');assert.equal(result.logIndex,3);
});
test('lost paid response is never submitted twice',async()=>{
  let calls=0,checkpoint=false;
  await assert.rejects(payMetered({signer:{...account,readContract:async()=>5000n},body:{},chain:{},
    beforeSubmit:async()=>{checkpoint=true;},fetchImpl:async()=>{
      calls++;if(calls===1)return new Response('',{status:402,headers:{'payment-required':encode(offer())}});throw new Error('timeout');
    }}));
  assert.equal(checkpoint,true);assert.equal(calls,2);
});
test('receipt must prove actual native USDC transfer from this agent',()=>{
  assert.equal(validateTransfer(receipt(1130),account.address,'1130'),3);
  assert.throws(()=>validateTransfer(receipt(3000),account.address,'1130'));
  assert.throws(()=>validateTransfer(receipt(1130),PAY_TO,'1130'));
});
for(const cost of [100,undefined,2000]) test(`merchant settles actual usage only, cost=${cost}`,async t=>{
  const settled=[];
  const facilitator={getSupported:async()=>({kinds:[{x402Version:2,scheme:'exact',network:BASE},{x402Version:2,scheme:'exact',network:'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',extra:{feePayer:'4an2sqamWWhny9mjLsMtGXCDXakeNtg6vSLq4QvhdmQu'}},{x402Version:2,scheme:'upto',network:BASE,extra:{facilitatorAddress:CDP_SIGNER}},SOLANA_UPTO],extensions:['eip2612GasSponsoring'],signers:{}}),
    verify:async()=>({isValid:true,payer:account.address}),settle:async(_p,r)=>{settled.push(r.amount);return{success:true,network:BASE,transaction:tx,payer:account.address};}};
  const app=createApp({payToBase:PAY_TO,payToSolana:'4an2sqamWWhny9mjLsMtGXCDXakeNtg6vSLq4QvhdmQu',model:'test'},
    {facilitatorClient:facilitator,upstream:async()=>({content:'Hello',finishReason:'stop',usage:{buyer_cost_micro:cost}}),log:()=>{}});
  const listener=await new Promise(resolve=>{const l=app.listen(0,'127.0.0.1',()=>resolve(l));});t.after(()=>listener.close());
  const url=`http://127.0.0.1:${listener.address().port}${METERED_ROUTE}`;
  const send=headers=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify({messages:[{role:'user',content:'Hi'}]})});
  const first=await send({});assert.equal(first.status,402);
  const q=decode(first.headers.get('payment-required'));assert.equal(q.accepts[0].amount,'3000');assert.equal(q.accepts[0].extra.billing.mode,'actual_usage');
  const paid=await send({'PAYMENT-SIGNATURE':encode({x402Version:2,resource:q.resource,accepted:q.accepts[0],payload:{signature:'0xsigned'},extensions:q.extensions})});
  assert.equal(paid.status,cost===100?200:503);assert.deepEqual(settled,cost===100?['1130']:[]);
});

// vet402-style buyers sign only `exact`: it is offered alongside `upto` on the gateway's own Base route, at the
// same ceiling, charged flat. The gateway's own buyer (metered-buyer.mjs) keeps picking the `upto` offer by
// filtering for it explicitly (selectOffer), so this is additive and does not change its behaviour above.
test('vet402-style exact buyer pays the full ceiling on the gateway route; upto is unaffected',async t=>{
  const settled=[];
  // createApp also wires /v1/credit, which offers exact on both networks; its startup validation needs every
  // (scheme, network) pair any wired route offers to be in getSupported(), so both are listed here too.
  const facilitator={getSupported:async()=>({kinds:[{x402Version:2,scheme:'exact',network:BASE},{x402Version:2,scheme:'exact',network:'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',extra:{feePayer:'4an2sqamWWhny9mjLsMtGXCDXakeNtg6vSLq4QvhdmQu'}},{x402Version:2,scheme:'upto',network:BASE,extra:{facilitatorAddress:CDP_SIGNER}},SOLANA_UPTO],extensions:['eip2612GasSponsoring'],signers:{}}),
    verify:async()=>({isValid:true,payer:account.address}),settle:async(_p,r)=>{settled.push(r.amount);return{success:true,network:BASE,transaction:tx,payer:account.address};}};
  const app=createApp({payToBase:PAY_TO,payToSolana:'4an2sqamWWhny9mjLsMtGXCDXakeNtg6vSLq4QvhdmQu',model:'test'},
    {facilitatorClient:facilitator,upstream:async()=>({content:'Hello',finishReason:'stop',usage:{buyer_cost_micro:100}}),log:()=>{}});
  const listener=await new Promise(resolve=>{const l=app.listen(0,'127.0.0.1',()=>resolve(l));});t.after(()=>listener.close());
  const url=`http://127.0.0.1:${listener.address().port}${METERED_ROUTE}`;
  const send=headers=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify({messages:[{role:'user',content:'Hi'}]})});
  const first=await send({});assert.equal(first.status,402);
  const q=decode(first.headers.get('payment-required'));
  assert.deepEqual(q.accepts.map(a=>a.scheme),['upto','exact']);
  const exact=q.accepts[1];
  assert.equal(exact.amount,q.accepts[0].amount);assert.equal(exact.extra.billing.mode,'exact_ceiling');
  const paid=await send({'PAYMENT-SIGNATURE':encode({x402Version:2,resource:q.resource,accepted:exact,payload:{signature:'0xsigned'},extensions:q.extensions})});
  assert.equal(paid.status,200);assert.deepEqual(settled,['3000']);
  const body=await paid.json();assert.equal(body.billing.totalAtomic,'3000');assert.equal(body.billing.mode,'exact_ceiling');
});

test('a failed upstream request paid with exact on the gateway route is not settled',async t=>{
  const settled=[];
  const facilitator={getSupported:async()=>({kinds:[{x402Version:2,scheme:'exact',network:BASE},{x402Version:2,scheme:'exact',network:'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',extra:{feePayer:'4an2sqamWWhny9mjLsMtGXCDXakeNtg6vSLq4QvhdmQu'}},{x402Version:2,scheme:'upto',network:BASE,extra:{facilitatorAddress:CDP_SIGNER}},SOLANA_UPTO],extensions:['eip2612GasSponsoring'],signers:{}}),
    verify:async()=>({isValid:true,payer:account.address}),settle:async(_p,r)=>{settled.push(r.amount);return{success:true,network:BASE,transaction:tx,payer:account.address};}};
  const app=createApp({payToBase:PAY_TO,payToSolana:'4an2sqamWWhny9mjLsMtGXCDXakeNtg6vSLq4QvhdmQu',model:'test'},
    {facilitatorClient:facilitator,upstream:async()=>{throw new Error('model answered HTTP 503');},log:()=>{}});
  const listener=await new Promise(resolve=>{const l=app.listen(0,'127.0.0.1',()=>resolve(l));});t.after(()=>listener.close());
  const url=`http://127.0.0.1:${listener.address().port}${METERED_ROUTE}`;
  const send=headers=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify({messages:[{role:'user',content:'Hi'}]})});
  const q=decode((await send({})).headers.get('payment-required'));
  const exact=q.accepts.find(a=>a.scheme==='exact');
  const paid=await send({'PAYMENT-SIGNATURE':encode({x402Version:2,resource:q.resource,accepted:exact,payload:{signature:'0xsigned'},extensions:q.extensions})});
  assert.equal(paid.status,503);assert.deepEqual(settled,[]);
});

test('failed paid HTTP request reports a safe stage and status without retrying',async()=>{
  const progress=[];let calls=0;
  await assert.rejects(payMetered({signer:{...account,readContract:async()=>5000n},body:{},chain:{},
    beforeSubmit:async()=>{},onProgress:(stage,status)=>progress.push([stage,status]),
    fetchImpl:async()=>++calls===1
      ?new Response('',{status:402,headers:{'payment-required':encode(offer())}})
      :new Response('sensitive provider body must not appear in diagnostics',{status:402})}),/HTTP 402/);
  assert.equal(calls,2);assert.deepEqual(progress.at(-1),['response',402]);
  assert.equal(JSON.stringify(progress).includes('sensitive'),false);
});

test('real buyer passes the real merchant extension-echo validation before CDP verify',async t=>{
  let verifies=0,settles=0;
  const facilitator={getSupported:async()=>({kinds:[
    {x402Version:2,scheme:'exact',network:BASE},
    {x402Version:2,scheme:'exact',network:'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',extra:{feePayer:'4an2sqamWWhny9mjLsMtGXCDXakeNtg6vSLq4QvhdmQu'}},
    {x402Version:2,scheme:'upto',network:BASE,extra:{facilitatorAddress:CDP_SIGNER}},SOLANA_UPTO
  ],extensions:['eip2612GasSponsoring'],signers:{}}),
  verify:async(p)=>{verifies++;assert.equal(p.extensions.eip2612GasSponsoring.info.version,'1');
    assert.equal(p.extensions.eip2612GasSponsoring.info.amount,'3000');
    assert.equal(typeof p.extensions.eip2612GasSponsoring.info.description,'string');
    return{isValid:true,payer:account.address};},
  settle:async()=>{settles++;return{success:true,network:BASE,transaction:tx,payer:account.address};}};
  const app=createApp({payToBase:PAY_TO,payToSolana:'4an2sqamWWhny9mjLsMtGXCDXakeNtg6vSLq4QvhdmQu',model:'test'},
    {facilitatorClient:facilitator,upstream:async()=>({content:'Hello',finishReason:'stop',usage}),log:()=>{}});
  const listener=await new Promise(resolve=>{const l=app.listen(0,'127.0.0.1',()=>resolve(l));});t.after(()=>listener.close());
  let submissions=0;
  const result=await payMetered({signer:{...account,readContract:async()=>0n},body:{messages:[{role:'user',content:'Hello'}]},
    chain:{waitForTransactionReceipt:async()=>receipt(1130)},beforeSubmit:async()=>{},
    fetchImpl:async(_url,init)=>{if(init.headers['PAYMENT-SIGNATURE'])submissions++;
      const response=await fetch(`http://127.0.0.1:${listener.address().port}${METERED_ROUTE}`,{...init,
        headers:{...init.headers,Host:'ask.singitai.app','X-Forwarded-Proto':'https'}});
      // The local test transport substitutes only the advertised public URL.
      // Requirements and extension declarations remain exactly as the merchant emitted them.
      if(!init.headers['PAYMENT-SIGNATURE']){
        const required=decode(response.headers.get('payment-required'));required.resource.url=ENDPOINT;
        const headers=new Headers(response.headers);headers.set('payment-required',encode(required));
        return new Response(await response.text(),{status:response.status,headers});
      }
      if(response.status===402){
        const failure=decode(response.headers.get('payment-required'));
        assert.fail(`Merchant rejected before verify=${verifies}: ${failure.error}`);
      }
      return response;}});
  assert.equal(result.amountAtomic,'1130');assert.equal(verifies,1);assert.equal(settles,1);assert.equal(submissions,1);
});

test('a raised ceiling is accepted only up to the cap the caller worked out, and its billing must name it',()=>{
  const raised=amount=>{const q=offer();q.accepts[0].amount=amount;q.accepts[0].extra.billing={...TERMS,maxChargeAtomic:amount};return q;};
  assert.equal(selectOffer(raised('400000'),'400000').amount,'400000');
  assert.throws(()=>selectOffer(raised('400001'),'400000'),'above the caller\'s own cap');
  assert.throws(()=>selectOffer(raised('400000')),'above the standing cap when none is given');
  const stale=raised('400000');stale.accepts[0].extra.billing.maxChargeAtomic='3000';
  assert.throws(()=>selectOffer(stale,'400000'),'billing that names another ceiling');
  for(const bad of ['0','-5','1e5','04000',400000,null]){const q=raised('400000');q.accepts[0].amount=bad;assert.throws(()=>selectOffer(q,'400000'));}
  assert.throws(()=>selectOffer(raised('400000'),'oops'));
});

const fullFacilitator=(settled)=>({getSupported:async()=>({kinds:[{x402Version:2,scheme:'exact',network:BASE},{x402Version:2,scheme:'exact',network:'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',extra:{feePayer:'4an2sqamWWhny9mjLsMtGXCDXakeNtg6vSLq4QvhdmQu'}},{x402Version:2,scheme:'upto',network:BASE,extra:{facilitatorAddress:CDP_SIGNER}},SOLANA_UPTO],extensions:['eip2612GasSponsoring'],signers:{}}),
  verify:async()=>({isValid:true,payer:account.address}),settle:async(_p,r)=>{settled.push(r.amount);return{success:true,network:BASE,transaction:tx,payer:account.address};}});

test("exact prices its output at exactOutputFraction of max_tokens; upto always prices the whole budget",async t=>{
  // Not the default model (config.model is 'test'), so its ceiling is not clamped to the standing 3000: the
  // difference between upto's and exact's output budget is visible in the amounts offered.
  const priced={id:'priced-model',promptUsdPerToken:4e-6,completionUsdPerToken:20e-6};
  const catalogue={async resolve(id){if(id==='priced-model')return priced;throw new Error('unknown');},async canAnswer(){return true;}};
  const app=createApp({payToBase:PAY_TO,payToSolana:'4an2sqamWWhny9mjLsMtGXCDXakeNtg6vSLq4QvhdmQu',model:'test',exactOutputFraction:0.5},
    {facilitatorClient:fullFacilitator([]),upstream:async()=>({content:'Hello',finishReason:'stop',usage:{buyer_cost_micro:10}}),log:()=>{},catalogue});
  const listener=await new Promise(resolve=>{const l=app.listen(0,'127.0.0.1',()=>resolve(l));});t.after(()=>listener.close());
  const url=`http://127.0.0.1:${listener.address().port}${METERED_ROUTE}`;
  const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({messages:[{role:'user',content:'Hi'}],model:'priced-model'})});
  assert.equal(response.status,402);
  const q=decode(response.headers.get('payment-required'));
  const upto=q.accepts.find(a=>a.scheme==='upto'&&a.network===BASE).amount;
  const exact=q.accepts.find(a=>a.scheme==='exact'&&a.network===BASE).amount;
  assert.ok(BigInt(exact)<BigInt(upto),`exact (${exact}) should price less output than upto (${upto})`);
});

test('ceilings: with no exactOutputFraction given, exact prices ceil(maxTokens*DEFAULT_EXACT_OUTPUT_FRACTION); exactOutputFraction 1 restores equal output budgets',()=>{
  const model={promptUsdPerToken:4e-6,completionUsdPerToken:20e-6};
  // chars and messageCount are 0, so the input estimate (which upto and exact bound differently, see pricing.mjs)
  // contributes nothing: any remaining difference between exact and upto is purely the output budget.
  const input={chars:0,messageCount:0,maxTokens:1000};
  const defaults=ceilings(model,input);
  assert.equal(defaults.exact[BASE],ceilingAtomic(model,{...input,maxTokens:Math.ceil(1000*DEFAULT_EXACT_OUTPUT_FRACTION)},TERMS));
  assert.equal(defaults.upto[BASE],ceilingAtomic(model,{...input,maxTokens:1000,charsPerToken:1},TERMS));
  assert.ok(BigInt(defaults.exact[BASE])<BigInt(defaults.upto[BASE]),'exact prices less than the whole max_tokens budget by default');
  const atOne=ceilings(model,input,1);
  assert.equal(atOne.exact[BASE],atOne.upto[BASE],'exactOutputFraction 1 gives exact the same output budget as upto');
});

test('exact overrun: actual cost over the flat ceiling still answers, settles the ceiling flat, and reports the overrun',async t=>{
  const settled=[];
  const app=createApp({payToBase:PAY_TO,payToSolana:'4an2sqamWWhny9mjLsMtGXCDXakeNtg6vSLq4QvhdmQu',model:'test'},
    {facilitatorClient:fullFacilitator(settled),upstream:async()=>({content:'Hello',finishReason:'stop',usage:{buyer_cost_micro:10_000}}),log:()=>{}});
  const listener=await new Promise(resolve=>{const l=app.listen(0,'127.0.0.1',()=>resolve(l));});t.after(()=>listener.close());
  const url=`http://127.0.0.1:${listener.address().port}${METERED_ROUTE}`;
  const send=headers=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify({messages:[{role:'user',content:'Hi'}]})});
  const q=decode((await send({})).headers.get('payment-required'));
  const exact=q.accepts.find(a=>a.scheme==='exact');
  const paid=await send({'PAYMENT-SIGNATURE':encode({x402Version:2,resource:q.resource,accepted:exact,payload:{signature:'0xsigned'},extensions:q.extensions})});
  assert.equal(paid.status,200);
  const body=await paid.json();
  // 10,000 cost + 3,000 markup (30%) + 1,000 fee = 14,000, over the 3,000 ceiling by 11,000.
  assert.equal(body.billing.totalAtomic,'3000');
  assert.equal(body.billing.overrunAtomic,'11000');
  assert.deepEqual(settled,['3000']);
});

test('upto still refuses an answer over its ceiling, even where exact would have absorbed the overrun',async t=>{
  const settled=[];
  const app=createApp({payToBase:PAY_TO,payToSolana:'4an2sqamWWhny9mjLsMtGXCDXakeNtg6vSLq4QvhdmQu',model:'test'},
    {facilitatorClient:fullFacilitator(settled),upstream:async()=>({content:'Hello',finishReason:'stop',usage:{buyer_cost_micro:10_000}}),log:()=>{}});
  const listener=await new Promise(resolve=>{const l=app.listen(0,'127.0.0.1',()=>resolve(l));});t.after(()=>listener.close());
  const url=`http://127.0.0.1:${listener.address().port}${METERED_ROUTE}`;
  const send=headers=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify({messages:[{role:'user',content:'Hi'}]})});
  const q=decode((await send({})).headers.get('payment-required'));
  const upto=q.accepts.find(a=>a.scheme==='upto');
  const paid=await send({'PAYMENT-SIGNATURE':encode({x402Version:2,resource:q.resource,accepted:upto,payload:{signature:'0xsigned'},extensions:q.extensions})});
  assert.equal(paid.status,503);
  assert.deepEqual(settled,[]);
});
