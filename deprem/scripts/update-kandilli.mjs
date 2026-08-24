import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {KANDILLI_API, normalizeKandilliPayload, dedupeSameCatalog, samePhysicalEvent, inMarmara} from '../kandilli-normalize.mjs';
import {buildAnalysis} from './seismic-analysis.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const DATA=path.join(ROOT,'data');
const ARCHIVE=path.join(DATA,'archive');
const couplingPath=path.join(DATA,'coupling-zones.geojson');
const analoguesPath=path.join(DATA,'analogues.json');

await fs.mkdir(ARCHIVE,{recursive:true});

const response=await fetch(`${KANDILLI_API}&_=${Date.now()}`,{
  headers:{'accept':'application/json','user-agent':'MarmaraSeismicWatch/7.0 (+GitHub Actions)'}
});
if(!response.ok) throw new Error(`Kandilli API HTTP ${response.status}`);
const payload=await response.json();
const latest=normalizeKandilliPayload(payload);
if(!latest.length) throw new Error('Kandilli API yanıtından hiçbir deprem parse edilemedi. API alan adları değişmiş olabilir.');

console.log(`Kandilli API: ${latest.length} normalized events`);
console.log('Sample:', JSON.stringify(latest[0],null,2));

let changed=false;
const byMonth=new Map();
for(const e of latest){
  const month=monthKey(e.time);
  if(!byMonth.has(month)) byMonth.set(month,[]);
  byMonth.get(month).push(e);
}

for(const [month,incoming] of byMonth){
  const file=path.join(ARCHIVE,`${month}.json`);
  const old=await readJson(file,{month,events:[]});
  const merged=mergeArchive(old.events||[],incoming);
  if(!sameEvents(old.events||[],merged)){
    await writeJson(file,{month,updatedAt:new Date().toISOString(),source:'KANDILLI_API_MIRROR',events:merged});
    console.log(`${month}: ${(old.events||[]).length} -> ${merged.length}`);
    changed=true;
  }
}

// Always keep a compact fallback for browsers where direct CORS access fails.
const fallbackPath=path.join(DATA,'live-fallback.json');
const fallback={generatedAt:new Date().toISOString(),source:'KANDILLI_API_MIRROR',events:latest.filter(inMarmara)};
const oldFallback=await readJson(fallbackPath,{events:[]});
if(!sameEvents(oldFallback.events||[],fallback.events)){
  await writeJson(fallbackPath,fallback);
  changed=true;
}

if(!changed){
  console.log('No new/revised Kandilli events. Repository data left unchanged.');
  process.exit(0);
}

const months=await archiveMonths();
await writeJson(path.join(ARCHIVE,'index.json'),{
  generatedAt:new Date().toISOString(),
  source:'KANDILLI_API_MIRROR',
  months
});

const cutoff=Date.now()-365*86400e3;
let history=[];
for(const m of months){
  const j=await readJson(path.join(ARCHIVE,m.file),{events:[]});
  for(const e of j.events||[]){
    const t=new Date(e.time).getTime();
    if(t>=cutoff && inMarmara(e)) history.push(e);
  }
}
history=dedupeSameCatalog(history).sort((a,b)=>new Date(b.time)-new Date(a.time));
await writeJson(path.join(DATA,'history-marmara.json'),{
  generatedAt:new Date().toISOString(),windowDays:365,source:'KANDILLI_API_MIRROR',events:history
});

const coupling=await readJson(couplingPath,null);
const analogueDB=await readJson(analoguesPath,null);
const analysis=await buildAnalysis(history,{coupling,analogueDB,nowMs:Date.now()});
analysis.generatedAt=new Date().toISOString();
analysis.source='KANDILLI_ONLY';
analysis.historyEvents=history.length;
await writeJson(path.join(DATA,'analysis.json'),analysis);
console.log(`Marmara 365d history: ${history.length} events; analysis written.`);

function monthKey(iso){
  const d=new Date(iso);
  return new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Istanbul',year:'numeric',month:'2-digit'}).format(d).replace('/','-');
}

function eventCore(e){
  return {id:e.id,sourceId:e.sourceId,time:e.time,latitude:e.latitude,longitude:e.longitude,depth:e.depth,magnitude:e.magnitude,place:e.place};
}
function sameEvents(a,b){
  if(a.length!==b.length) return false;
  const aa=[...a].sort((x,y)=>String(x.sourceId).localeCompare(String(y.sourceId)));
  const bb=[...b].sort((x,y)=>String(x.sourceId).localeCompare(String(y.sourceId)));
  return JSON.stringify(aa.map(eventCore))===JSON.stringify(bb.map(eventCore));
}
function mergeArchive(existing,incoming){
  const out=dedupeSameCatalog(existing);
  for(const e of incoming){
    let idx=out.findIndex(o=>o.sourceId===e.sourceId);
    if(idx<0){
      idx=out.findIndex(o=>samePhysicalEvent(o,e));
    }
    if(idx<0) out.push(e);
    else out[idx]={...out[idx],...e,id:out[idx].id||e.id,sourceId:out[idx].sourceId||e.sourceId};
  }
  return dedupeSameCatalog(out).sort((a,b)=>new Date(b.time)-new Date(a.time));
}
async function archiveMonths(){
  const files=(await fs.readdir(ARCHIVE)).filter(f=>/^\d{4}-\d{2}\.json$/.test(f)).sort();
  const rows=[];
  for(const file of files){
    const j=await readJson(path.join(ARCHIVE,file),{events:[]});
    rows.push({month:file.slice(0,7),file,count:(j.events||[]).length,updatedAt:j.updatedAt||null});
  }
  return rows;
}
async function readJson(file,fallback){try{return JSON.parse(await fs.readFile(file,'utf8'));}catch{return fallback;}}
async function writeJson(file,obj){await fs.writeFile(file,JSON.stringify(obj,null,2)+'\n');}
