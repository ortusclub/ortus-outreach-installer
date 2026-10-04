import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createSharedGoLogin} from '../src/shared-gologin.js';
const url='https://gateway.test/gologin/shared';
test('fallback requires verified Google connection, caches in memory and clears on disconnect',async()=>{
 let connected=false,calls=0,time=1000,changes=0;const env={};
 const connection={status:()=>({connected,email:'person@ortusclub.com'}),token:async()=>'google-identity'};
 const p=createSharedGoLogin({connection,url,env,now:()=>time,onChange:()=>changes++,request:async(u,o)=>{calls++;assert.equal(u,url);assert.equal(o.headers.Authorization,'Bearer google-identity');assert.equal(o.redirect,'error');return Response.json({tokens:{ortus:'shared-ortus',marketing:'shared-marketing',other:'ignored'}});}});
 await p.ensure();assert.equal(calls,0);assert.equal(p.token('ortus'),'');
 connected=true;await Promise.all([p.ensure(),p.ensure()]);assert.equal(calls,1);assert.equal(p.token('ortus'),'shared-ortus');assert.equal(p.token('other'),'');assert.deepEqual(env,{});assert.equal(changes,1);
 await p.ensure();assert.equal(calls,1);time+=300001;assert.equal(p.token('ortus'),'');await p.ensure();assert.equal(calls,2);
 connected=false;assert.equal(p.token('ortus'),'');await p.ensure();connected=true;assert.equal(p.token('ortus'),'');
});
test('manual tokens skip server when both set; failures stay empty and back off',async()=>{
 let calls=0,time=1000;const env={GOLOGIN_API_TOKEN:'manual',GOLOGIN_API_TOKEN_MARKETING:'manual-marketing'};
 const p=createSharedGoLogin({connection:{status:()=>({connected:true,email:'person@ortusclub.com'}),token:async()=>'id'},env,url,now:()=>time,request:async()=>{calls++;return Response.json({error:'PRIVATE'},{status:503});}});
 await p.ensure();assert.equal(calls,0);delete env.GOLOGIN_API_TOKEN_MARKETING;await p.ensure();assert.equal(calls,1);assert.equal(env.GOLOGIN_API_TOKEN,'manual');assert.equal(p.token('marketing'),'');assert.doesNotMatch(p.status('marketing').message,/PRIVATE/);await p.ensure();assert.equal(calls,1);time+=30001;await p.ensure();assert.equal(calls,2);
});
test('an in-flight response cannot restore tokens after a Google-account switch',async()=>{
 let email='one@ortusclub.com',resolve;const p=createSharedGoLogin({connection:{status:()=>({connected:true,email}),token:async()=>'id'},url,env:{},request:()=>new Promise(r=>resolve=r)});
 const pending=p.ensure();await new Promise(r=>setImmediate(r));email='two@ortusclub.com';resolve(Response.json({tokens:{ortus:'old-account-token'}}));await pending;assert.equal(p.token('ortus'),'');
});
