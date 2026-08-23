import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAnalysis } from './seismic-analysis.mjs';

const __dirname=path.dirname(fileURLToPath(import.meta.url));
const ROOT=path.resolve(__dirname,'..');
const DATA=path.join(ROOT,'data');
const ARCHIVE=path.join(DATA,'archive');
const BBOX={minLat:40.25,maxLat:41.35,minLon:26.15,maxLon:30.55};
const KANDILLI='https://api.demirhanomerdemir.com/Deprem/KandilliRasathanesi?limit=5000';
const USGS='https://earthquake.usgs.gov/fdsnws/event/1/query';
const RETAIN_DAYS=400;

await fs.mkdir(ARCHIVE,{recursive:true});
const now=new Date();
const start=new Date(now.getTime()-30*86400e3).toISOString();
const end=now.toISOString();
const usgsUrl=`${USGS}?format=geojson&starttime=${encodeURIComponent(start)}&endtime=${encodeURIComponent(end)}&minlatitude=${BBOX.minLat}&maxlatitude=${BBOX.maxLat}&minlongitude=${BBOX.minLon}&maxlongitude=${BBOX.maxLon}&minmagnitude=0&orderby=time&limit=20000`;

const [kRaw,uRaw]=await Promise.all([getJSON(KANDILLI),getJSON(usgsUrl)]);
const kEvents=extractArray(kRaw).map(normalizeKandilli).filter(Boolean).filter(inBox);
const uEvents=(uRaw.features||[]).map(normalizeUSGS).filter(Boolean).filter(inBox);
console.log(`Kandilli: ${kEvents.length}, USGS: ${uEvents.length}`);

const sourceEvents=[...kEvents,...uEvents];
const archiveChanged=await updateMonthlyArchive(sourceEvents);
if(!archiveChanged && await currentIsFresh(60)){
  console.log('No catalog changes and current snapshot is <60 min old; leaving repository unchanged.');
  process.exit(0);
}
const recentRaw=await loadRecentArchive(RETAIN_DAYS);
const merged=dedupe(recentRaw).filter(e=>Date.now()-new Date(e.time).getTime()<=30*86400e3).sort((a,b)=>new Date(b.time)-new Date(a.time));

const current={generatedAt:new Date().toISOString(),bbox:{minLatitude:BBOX.minLat,maxLatitude:BBOX.maxLat,minLongitude:BBOX.minLon,maxLongitude:BBOX.maxLon},sources:['KANDILLI','USGS'],seed:false,events:merged};
await fs.writeFile(path.join(DATA,'current.json'),JSON.stringify(current,null,2));
const analysis=await buildAnalysis(dedupe(recentRaw),{couplingPath:path.join(DATA,'coupling-zones.geojson'),analoguesPath:path.join(DATA,'analogues.json')});
await fs.writeFile(path.join(DATA,'analysis.json'),JSON.stringify(analysis,null,2));
console.log(`current.json: ${merged.length} merged events`);

async function getJSON(url){
  const r=await fetch(url,{headers:{'User-Agent':'MarmaraSeismicWatch/3.0 (GitHub Pages personal seismic monitor)','Accept':'application/json'}});
  if(!r.ok) throw new Error(`${r.status} ${r.statusText}: ${url}`);
  return r.json();
}
function extractArray(p){
  if(Array.isArray(p))return p;
  if(!p||typeof p!=='object')return [];
  for(const k of ['result','data','events','earthquakes','Earthquakes','items','list']) if(Array.isArray(p[k]))return p[k];
  for(const v of Object.values(p)) if(Array.isArray(v))return v;
  return [];
}
function pick(o,keys){
  const low=Object.fromEntries(Object.entries(o||{}).map(([k,v])=>[k.toLowerCase(),v]));
  for(const k of keys){const v=o?.[k]??low[k.toLowerCase()];if(v!==undefined&&v!==null&&v!==''&&v!=='-')return v;}return null;
}
function num(v){if(v===null||v===undefined||v===''||v==='-')return null;const n=Number(String(v).replace(',','.'));return Number.isFinite(n)?n:null;}
function parseTR(o){
  let d=pick(o,['date','tarih','Date','Tarih','originTime','datetime','date_time']);
  let t=pick(o,['time','saat','hour','Time','Saat','clock']);
  let s=d?String(d).trim():'';if(t&&s&&!s.includes(':'))s+=' '+String(t).trim();if(!s&&t)s=String(t).trim();
  let m=s.match(/^(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?/);
  if(m)return `${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:${m[6]||'00'}+03:00`;
  m=s.match(/^(\d{4})[.-](\d{2})[.-](\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?/);
  if(m)return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]||'00'}+03:00`;
  const parsed=new Date(s);return Number.isNaN(parsed.getTime())?null:parsed.toISOString();
}
function normalizeKandilli(o){
  const lat=num(pick(o,['latitude','lat','enlem','ENLEM'])),lon=num(pick(o,['longitude','lon','lng','boylam','BOYLAM']));
  const time=parseTR(o);if(lat===null||lon===null||!time)return null;
  const md=num(pick(o,['md','MD'])),ml=num(pick(o,['ml','ML'])),mw=num(pick(o,['mw','MW'])),generic=num(pick(o,['magnitude','mag','buyukluk','büyüklük']));
  const magnitude=mw??ml??md??generic??0, depth=num(pick(o,['depth','derinlik','DERINLIK']))??0,place=String(pick(o,['location','yer','place','title','region','YER'])||'');
  const rawId=pick(o,['id','eventID','eventId','eventid','earthquake_id','earthquakeId']);
  const sourceId=rawId?String(rawId):sha(`${time}|${lat.toFixed(4)}|${lon.toFixed(4)}|${magnitude.toFixed(2)}|${place}`);
  return {source:'KANDILLI',sourceId,time,latitude:lat,longitude:lon,depth,magnitude,place,md,ml,mw};
}
function normalizeUSGS(f){
  const c=f.geometry?.coordinates||[],p=f.properties||{};if(c.length<2||!p.time)return null;
  return {source:'USGS',sourceId:String(f.id),time:new Date(p.time).toISOString(),latitude:+c[1],longitude:+c[0],depth:+c[2]||0,magnitude:+p.mag||0,place:p.place||'',magType:p.magType||null,status:p.status||null,url:p.url||null};
}
function inBox(e){return e.latitude>=BBOX.minLat&&e.latitude<=BBOX.maxLat&&e.longitude>=BBOX.minLon&&e.longitude<=BBOX.maxLon;}
function sha(s){return crypto.createHash('sha1').update(s).digest('hex').slice(0,20);}
function monthKey(iso){return iso.slice(0,7);}
async function updateMonthlyArchive(events){
  let changed=false;
  const byMonth=new Map();for(const e of events){const k=monthKey(e.time);if(!byMonth.has(k))byMonth.set(k,[]);byMonth.get(k).push(e);}
  for(const [month,newEvents] of byMonth){
    const file=path.join(ARCHIVE,`${month}.json`);let old=[];try{old=JSON.parse(await fs.readFile(file,'utf8')).events||[]}catch{}
    const map=new Map(old.map(e=>[`${e.source}:${e.sourceId}`,e]));
    for(const e of newEvents){
      const key=`${e.source}:${e.sourceId}`, prev=map.get(key);
      if(!prev || JSON.stringify(prev)!==JSON.stringify(e)){changed=true;map.set(key,e);}
    }
    if(changed || old.length!==map.size){
      const payload={month,updatedAt:new Date().toISOString(),events:[...map.values()].sort((a,b)=>new Date(a.time)-new Date(b.time))};
      await fs.writeFile(file,JSON.stringify(payload,null,2));
    }
  }
  return changed;
}
async function currentIsFresh(minutes){
  try{const cur=JSON.parse(await fs.readFile(path.join(DATA,'current.json'),'utf8'));const t=new Date(cur.generatedAt).getTime();return Number.isFinite(t)&&Date.now()-t<minutes*60000&&!cur.seed;}catch{return false;}
}
async function loadRecentArchive(days){
  const cutoff=Date.now()-days*86400e3;let files=[];try{files=(await fs.readdir(ARCHIVE)).filter(x=>/^\d{4}-\d{2}\.json$/.test(x));}catch{}
  const all=[];for(const f of files){try{const p=JSON.parse(await fs.readFile(path.join(ARCHIVE,f),'utf8'));for(const e of p.events||[])if(new Date(e.time).getTime()>=cutoff)all.push(e);}catch{}}
  return all;
}
function dedupe(raw){
  const sorted=[...raw].sort((a,b)=>new Date(a.time)-new Date(b.time));const out=[];
  for(const e of sorted){
    let match=null;
    for(let i=out.length-1;i>=0;i--){
      const o=out[i],dt=Math.abs(new Date(e.time)-new Date(o.time))/1000;
      if(dt>75)break;
      // Never collapse two events reported by the same catalog. Cross-catalog matching only.
      if(o.sources?.includes(e.source))continue;
      if(distanceKm(e,o)<=8&&Math.abs((e.magnitude||0)-(o.magnitude||0))<=0.5){match=o;break;}
    }
    if(!match){out.push({id:`evt-${sha(`${e.time}|${e.latitude.toFixed(3)}|${e.longitude.toFixed(3)}`)}`,time:e.time,latitude:e.latitude,longitude:e.longitude,depth:e.depth,magnitude:e.magnitude,place:e.place,sources:[e.source],catalogs:{[e.source]:catalogView(e)}});}
    else{
      match.catalogs[e.source]=catalogView(e);if(!match.sources.includes(e.source))match.sources.push(e.source);
      // Prefer Kandilli location/magnitude for local Marmara microseismicity when available.
      if(e.source==='KANDILLI'){Object.assign(match,{time:e.time,latitude:e.latitude,longitude:e.longitude,depth:e.depth,magnitude:e.magnitude,place:e.place||match.place});}
    }
  }
  return out;
}
function catalogView(e){return {sourceId:e.sourceId,time:e.time,latitude:e.latitude,longitude:e.longitude,depth:e.depth,magnitude:e.magnitude,place:e.place,url:e.url||null};}
function distanceKm(a,b){const R=6371,lat1=a.latitude*Math.PI/180,lat2=b.latitude*Math.PI/180,dlat=(b.latitude-a.latitude)*Math.PI/180,dlon=(b.longitude-a.longitude)*Math.PI/180;const q=Math.sin(dlat/2)**2+Math.cos(lat1)*Math.cos(lat2)*Math.sin(dlon/2)**2;return 2*R*Math.asin(Math.sqrt(q));}

function distancePointLine(e,coords){let best=Infinity;for(let i=0;i<coords.length-1;i++)best=Math.min(best,pointSegmentKm(e,coords[i],coords[i+1]));return best;}
function pointSegmentKm(e,a,b){const lat0=e.latitude*Math.PI/180,kx=111.32*Math.cos(lat0),ky=110.57;const px=(e.longitude-a[0])*kx,py=(e.latitude-a[1])*ky,bx=(b[0]-a[0])*kx,by=(b[1]-a[1])*ky;const den=bx*bx+by*by;const t=den?Math.max(0,Math.min(1,(px*bx+py*by)/den)):0;return Math.hypot(px-t*bx,py-t*by);}
