import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildCatalog, catalogResponse } from '../src/catalog.mjs';
import { serve, request } from './fixtures/listing-harness.mjs';
import { availableAudioPrices, MUSIC_ROUTE, SFX_ROUTE } from '../src/audio-generation.mjs';
import { CONFIG } from './fixtures/listing-harness.mjs';
import { BASE } from '../src/pricing.mjs';
import { renderCatalog } from '../../scripts/generate-catalog-page.mjs';
const map = (...entries) => new Map(entries.map(e => [e.id, e]));
const voice = { speech: map({id:'tts',usdPerUnit:0.01}), transcription: map({id:'stt',usdPerUnit:0.02}) };
test('catalog API filters, global counts, free/router flags and transcription access', async t => {
  const {url,facilitator}=await serve(t,{voiceModels:async()=>voice},{audioSold:undefined,videoSold:undefined});
  const response=await request(url+'/v1/catalog');
  assert.equal(response.status,200);
  const all=await response.json();
  assert.equal(all.counts.transcription,1);
  const stt=all.data.find(m=>m.id==='stt');
  const schema=(await (await request(url+'/openapi.json')).json()).paths['/v1/catalog'].get;
  assert.deepEqual(schema.parameters[0].schema.enum,Object.keys(all.counts));
  assert.equal(stt.access,'api_key');
  for (const entry of all.data) {
    assert.equal(typeof entry.id,'string'); assert.equal(typeof entry.modality,'string');
    assert.ok(['x402','api_key','free'].includes(entry.access));
    assert.equal(entry.available,true);
    assert.equal(entry.router,entry.kind==='router');
    assert.equal(entry.free,entry.kind==='free' || entry.payment==='free');
  }
  for (const modality of ['music','sound_effects','video']) assert.ok(!Object.hasOwn(all.counts,modality));
  assert.equal(stt.payment,'api_key_only'); assert.deepEqual(stt.networks,[]);
  assert.equal(all.data.find(m=>m.id==='singit/auto').kind,'router');
  assert.ok(all.data.some(m=>m.id.startsWith('free/') && m.kind==='free' && m.payment==='free'));
  for (const modality of Object.keys(all.counts)) {
    const filtered=await (await request(url+'/v1/catalog?modality='+modality)).json();
    assert.deepEqual(filtered.counts,all.counts);
    assert.deepEqual(filtered.data,all.data.filter(e=>e.modality===modality));
  }
  assert.equal((await request(url+'/v1/catalog?modality=video')).status,400);
  assert.equal((await request(url+'/v1/catalog?modality=music')).status,400);
  assert.equal((await request(url+'/v1/catalog?modality=sound_effects')).status,400);
  assert.equal(facilitator.calls.verify,0); assert.deepEqual(facilitator.calls.settle,[]);
});
test('videoSold false (default): video absent from catalog and discovery', async t=>{
  const {url}=await serve(t,{videoModels:async()=>map({id:'video-fixture',usdPerJob:1})});
  for(const path of ['/v1/catalog','/openapi.json','/.well-known/x402','/.well-known/agent-card.json','/llms.txt']) {
    const response=await request(url+path); assert.equal(response.status,200);
    const text=await response.text(); assert.doesNotMatch(text,/\/v1\/video|video-fixture/);
    if(path==='/v1/catalog') assert.ok(!Object.hasOwn(JSON.parse(text).counts,'video'));
  }
});
test('static counts and API catalog shape agree on the exact snapshot inputs',async t=>{
  const s=JSON.parse(await readFile(new URL('../../website/data/catalog-snapshot.json',import.meta.url)));
  const chat=s.data.filter(m=>m.modality==='chat' && m.kind==='model');
  const free=s.data.filter(m=>m.kind==='free').map(m=>m.id.slice(5));
  const data=await buildCatalog({catalogue:{list:async()=>chat},free:{models:free}, searchEnabled:true});
  assert.deepEqual(catalogResponse(data).counts,s.counts);
  const raw = chat.map(m => ({...m,promptUsdPerToken:0.000001,completionUsdPerToken:0.000002}));
  const {url}=await serve(t,{list:async()=>raw,resolve:async id=>raw.find(m=>m.id===id),canAnswer:async()=>true,
    imageModels:async()=>map(),editModels:async()=>map(),embeddingModels:async()=>map(),
    voiceModels:async()=>({speech:map(),transcription:map()})},{freeModels:free,audioSold:false});
  const api=await (await request(url+'/v1/catalog')).json();
  assert.deepEqual(api.counts,s.counts);
  const html=renderCatalog(s);
  for(const [modality,count] of Object.entries(s.counts)) assert.ok(html.includes(`<dd data-modality="${modality}">${count}</dd>`));
  assert.doesNotMatch(html,/<script|video/i);
  assert.equal(await readFile(new URL('../../website/models/index.html',import.meta.url),'utf8'),html);
});

test('media entries reuse pricing.json reference prices; every existing modality is present', async t => {
  const {url}=await serve(t,{ voiceModels:async()=>voice,
    editModels:async()=>map({id:'qwen-image-2-edit',name:'Edit',metering:'per_image',imageUsd:0.01}),
    embeddingModels:async()=>map({id:'embed',name:'Embed',usdPerMillionTokens:0.1}),
  });
  const catalog=await (await request(url+'/v1/catalog')).json();
  const pricing=await (await request(url+'/pricing.json')).json();
  for (const modality of Object.keys(catalog.counts)) assert.ok(catalog.counts[modality]>0,modality);
  for(const m of pricing.models) {
    const entry=catalog.data.find(e=>e.id===m.id);
    if(m.id==='singit/auto') continue;
    assert.ok(entry,m.id);
    assert.deepEqual(entry.price.exact,m.exact);
    if(m.upto) assert.deepEqual(entry.price.upto,m.upto);
  }
});
test('snapshot catalog rejects unknown modalities and duplicate entries',()=>{
  assert.throws(()=>catalogResponse([{id:'a',modality:'unknown'}]));
  assert.throws(()=>catalogResponse([{id:'a',modality:'chat'},{id:'a',modality:'chat'}]));
});

test('audio readiness exposes Base-only music and sound effects without revealing video', async t => {
  const {url,facilitator}=await serve(t,{videoModels:async()=>map({id:'video-fixture',usdPerJob:1})});
  const all=await (await request(url+'/v1/catalog')).json();
  const schema=(await (await request(url+'/openapi.json')).json()).paths['/v1/catalog'].get;
  assert.deepEqual(new Set(schema.parameters[0].schema.enum),new Set(Object.keys(all.counts)));
  const prices=availableAudioPrices(CONFIG,{});
  for (const modality of ['music','sound_effects']) {
    const filtered=await request(url+'/v1/catalog?modality='+modality);
    assert.equal(filtered.status,200);
    const body=await filtered.json();
    assert.deepEqual(body.counts,all.counts);
    assert.ok(body.data.length>0);
    assert.equal(all.counts[modality],body.data.length);
    for (const entry of body.data) {
      assert.equal(entry.modality,modality);
      assert.equal(entry.route,modality==='music'?MUSIC_ROUTE:SFX_ROUTE);
      assert.equal(entry.access,'x402'); assert.equal(entry.available,true);
      assert.equal(entry.router,false); assert.equal(entry.free,false);
      assert.deepEqual(entry.networks,[BASE]);
      assert.deepEqual(entry.price.exact,{base:prices.find(m=>m.id===entry.id).exact.base});
    }
  }
  assert.ok(!Object.hasOwn(all.counts,'video'));
  assert.ok(!all.data.some(m=>m.modality==='video'));
  assert.equal((await request(url+'/v1/catalog?modality=video')).status,400);
  assert.equal(facilitator.calls.verify,0); assert.deepEqual(facilitator.calls.settle,[]);
});
test('audio fails closed when readiness is missing or the model is suspended', async t => {
  for (const options of [{audioSold:false},{audioGenerationReady:undefined},{audioGenerationReady:()=>false}]) {
    const {url}=await serve(t,{},options);
    const body=await (await request(url+'/v1/catalog')).json();
    for (const modality of ['music','sound_effects']) {
      assert.ok(!Object.hasOwn(body.counts,modality));
      assert.equal((await request(url+'/v1/catalog?modality='+modality)).status,400);
    }
  }
  const data=await buildCatalog({config:CONFIG,catalogue:{list:async()=>[],isSuspended:()=>true}});
  assert.ok(!data.some(m=>['music','sound_effects'].includes(m.modality)));
});
test('video is independently gated and follows the video listing seller filter', async t => {
  const cat={videoModels:async()=>map({id:'video-fixture',usdPerJob:1},{id:'video-unhealthy',usdPerJob:1}),
    videoServed:async()=>new Map([['video-fixture',1],['video-unhealthy',0]])};
  for (const videoSold of [true,false,undefined]) {
    const {url}=await serve(t,cat,{audioSold:false,videoSold});
    const all=await (await request(url+'/v1/catalog')).json();
    const filtered=await request(url+'/v1/catalog?modality=video');
    assert.equal(filtered.status,videoSold===true?200:400);
    if(videoSold===true) {
      assert.equal(all.counts.video,1);
      const body=await filtered.json(); assert.deepEqual(body.counts,all.counts);
      assert.deepEqual(body.data.map(m=>m.id),['video-fixture']);
      assert.equal(body.data[0].available,true); assert.equal(body.data[0].access,'x402');
      assert.equal(body.data[0].route,'/v1/video/generations');
    } else {
      assert.ok(!Object.hasOwn(all.counts,'video'));
      assert.ok(!all.data.some(m=>m.modality==='video'));
    }
  }
});

test('retained chat and free entries report current answering eligibility', async () => {
  const data=await buildCatalog({config:{model:'pinned'},free:{models:['pinned']},catalogue:{
    list:async()=>[{id:'pinned'},{id:'hidden'},{id:'ready'}],
    listable:async id=>id==='ready',canAnswer:async id=>id==='ready',
  }});
  assert.ok(!data.some(m=>m.id==='hidden'));
  assert.equal(data.find(m=>m.id==='pinned').available,false);
  assert.equal(data.find(m=>m.id==='free/pinned').available,false);
  assert.equal(data.find(m=>m.id==='ready').available,true);
});
