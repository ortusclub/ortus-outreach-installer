import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGoogleConnection } from '../src/google-auth.js';

test('loopback OAuth checks state, uses PKCE, stores privately, refreshes once and disconnects', async t => {
  const dir = mkdtempSync(join(tmpdir(),'outreach-google-'));
  const filePath = join(dir,'auth.json'); let exchanges = 0, recovered = 0;
  let reject = false;
  const request = async (url, options = {}) => {
    if (url.endsWith('/auth/config')) return {ok:true,json:async()=>({clientId:'example.apps.googleusercontent.com',clientSecret:'desktop-public'})};
    if (url.endsWith('/auth/me')) return {ok:!reject,json:async()=> reject ? {error:'Company not approved'} : {email:'user@ortusclub.com'}};
    assert.equal(url,'https://oauth2.googleapis.com/token'); exchanges++;
    const form = new URLSearchParams(options.body);
    if (form.get('grant_type') === 'authorization_code') assert.ok(form.get('code_verifier').length >= 43);
    else assert.equal(form.get('refresh_token'),'refresh-private');
    return {ok:true,json:async()=>({id_token:'id-private',refresh_token:'refresh-private',expires_in:3600})};
  };
  const auth = createGoogleConnection({filePath,request,onConnected:()=>recovered++}); t.after(()=>{ auth.disconnect(); rmSync(dir,{recursive:true,force:true}); });
  const consent = new URL(await auth.begin());
  assert.equal(consent.searchParams.get('code_challenge_method'),'S256');
  assert.equal(consent.searchParams.get('scope'),'openid email');
  const callback = new URL(consent.searchParams.get('redirect_uri')); callback.searchParams.set('code','code');
  callback.searchParams.set('state','forged'); assert.equal((await fetch(callback)).status,400); assert.equal(exchanges,0);
  callback.searchParams.set('state',consent.searchParams.get('state'));
  const success = await fetch(callback); assert.equal(success.status,200); assert.match(await success.text(),/Ortus Outreach/);
  assert.equal(auth.status().email,'user@ortusclub.com'); assert.equal(recovered,1);
  assert.doesNotMatch(JSON.stringify(auth.status()),/id-private|refresh-private|desktop-public/);
  assert.equal(statSync(filePath).mode & 0o777,0o600);
  assert.equal(JSON.parse(readFileSync(filePath)).refreshToken,'refresh-private');
  assert.equal(await auth.token(),'id-private'); assert.equal(exchanges,1);
  await Promise.all([auth.token({force:true}),auth.token({force:true})]); assert.equal(exchanges,2);
  reject = true; await assert.rejects(auth.token({force:true}),/Company not approved/);
  auth.disconnect(); assert.equal(auth.status().connected,false); assert.equal(auth.status().legacyAllowed,false);
  await assert.rejects(auth.token(),/Sign in with Google/);
  assert.doesNotMatch(readFileSync(filePath,'utf8'),/refresh-private|id-private/);
});
