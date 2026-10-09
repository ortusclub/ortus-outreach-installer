import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { dataPath } from './paths.js';
import { emailCompany } from '../public/js/company-access.mjs';
const file=()=>dataPath('caller-provider-credentials.json');
function read(){return existsSync(file())?JSON.parse(readFileSync(file(),'utf8')):{};}
function company(email){const key=emailCompany(email);if(!key)throw Object.assign(new Error('Sign in with a supported company account.'),{status:403});return key;}
export function callerProviderStatus(email){const saved=read()[company(email)]||{};return {vapiConfigured:!!saved.vapiToken};}
export function saveCallerProvider(email,input){
 const key=company(email);if(typeof input.vapiToken!=='string'||input.vapiToken.length>4096||/\s/.test(input.vapiToken.trim()))throw Object.assign(new Error('Enter a valid private Vapi API key without spaces.'),{status:400});
 const saved=read();saved[key]={vapiToken:input.vapiToken.trim()};
 writeFileSync(`${file()}.tmp`,JSON.stringify(saved),{mode:0o600});renameSync(`${file()}.tmp`,file());return callerProviderStatus(email);
}
export async function listCallerProviderOptions(email,request=fetch){
 const token=read()[company(email)]?.vapiToken;
 if(!token)throw Object.assign(new Error('Add your private Vapi API key in Settings → Accounts & connections → Vapi access.'),{status:409});
 async function list(path){
  const response=await request(`https://api.vapi.ai/${path}?limit=1000`,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(15000),redirect:'error'});
  if(!response.ok)throw Object.assign(new Error(response.status===401||response.status===403?'Vapi rejected this key. Check the private key in Settings.':'Could not load Vapi options. Try again.'),{status:502});
  const items=await response.json();if(!Array.isArray(items))throw new Error('Unexpected Vapi response.');return items;
 }
 const [assistants,numbers]=await Promise.all([list('assistant'),list('phone-number')]);
 return {assistants:assistants.map(a=>({id:a.id,name:a.name||a.id})),numbers:numbers.map(n=>({id:n.id,name:n.number||n.name||n.id}))};
}
export function installCallerProviderRoutes(app){
 app.get('/api/caller/provider', (req,res)=>{try{res.set('Cache-Control','no-store').json(callerProviderStatus(req.user));}catch(error){res.status(error.status||500).json({error:'Could not read caller credentials.'});}});
 app.post('/api/caller/provider',(req,res)=>{try{res.set('Cache-Control','no-store').json(saveCallerProvider(req.user,req.body||{}));}catch(error){res.status(error.status||500).json({error:error.status?error.message:'Could not save caller credentials.'});}});
 app.get('/api/caller/provider/options',async(req,res)=>{try{res.set('Cache-Control','no-store').json(await listCallerProviderOptions(req.user));}catch(error){res.status(error.status||502).json({error:error.status?error.message:'Could not load Vapi options.'});}});
}
