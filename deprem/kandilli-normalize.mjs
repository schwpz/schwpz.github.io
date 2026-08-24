export const KANDILLI_API = 'https://api.demirhanomerdemir.com/Deprem/KandilliRasathanesi?limit=1000';
export const MARMARA_BBOX = {minLat:40.15,maxLat:41.45,minLon:26.0,maxLon:30.70};

const keyNorm = s => String(s ?? '')
  .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
  .toLowerCase().replace(/[^a-z0-9]/g,'');

function flatten(obj, prefix='', out={}){
  if(!obj || typeof obj!=='object' || Array.isArray(obj)) return out;
  for(const [k,v] of Object.entries(obj)){
    const nk=keyNorm(k);
    const path=prefix?`${prefix}.${nk}`:nk;
    if(v && typeof v==='object' && !Array.isArray(v)) flatten(v,path,out);
    else {
      if(!(nk in out)) out[nk]=v;
      out[path]=v;
    }
  }
  return out;
}

function pickFlat(flat, aliases){
  for(const a of aliases){
    const k=keyNorm(a);
    if(flat[k]!==undefined && flat[k]!==null && flat[k]!=='') return flat[k];
  }
  for(const [k,v] of Object.entries(flat)){
    for(const a of aliases){
      const n=keyNorm(a);
      if(k.endsWith(`.${n}`) && v!==null && v!=='') return v;
    }
  }
  return null;
}

function num(v){
  if(v===null||v===undefined||v==='') return null;
  if(typeof v==='string') v=v.trim().replace(',','.');
  const n=Number(v); return Number.isFinite(n)?n:null;
}

function parseEpoch(v){
  const n=num(v); if(n===null) return null;
  if(n>1e12) return new Date(n).toISOString();
  if(n>1e9) return new Date(n*1000).toISOString();
  return null;
}

function parseTRDateTime(flat){
  const epoch=pickFlat(flat,['timestamp','epochtime','unix','timeunix','timestamputc']);
  const e=parseEpoch(epoch); if(e) return e;

  const combined=pickFlat(flat,['datetime','datetimestamp','tarihsaat','origintime','eventtime','time','date']);
  const dateOnly=pickFlat(flat,['tarih','date','eventdate','origindate']);
  const timeOnly=pickFlat(flat,['saat','hour','clock','eventhour']);
  const candidates=[];
  if(combined) candidates.push(String(combined).trim());
  if(dateOnly && timeOnly) candidates.push(`${String(dateOnly).trim()} ${String(timeOnly).trim()}`);
  if(dateOnly) candidates.push(String(dateOnly).trim());

  for(let s of candidates){
    if(!s) continue;
    let m=s.match(/^(\d{2})[.\/-](\d{2})[.\/-](\d{4})[ T]+(\d{2}):(\d{2})(?::(\d{2}))?/);
    if(m) return `${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:${m[6]||'00'}+03:00`;
    m=s.match(/^(\d{4})[.\/-](\d{2})[.\/-](\d{2})[ T]+(\d{2}):(\d{2})(?::(\d{2}))?/);
    if(m) return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]||'00'}+03:00`;
    // API sometimes returns ISO or JS-parseable strings.
    const d=new Date(s);
    if(!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return null;
}

function simpleHash(input){
  let h1=0x811c9dc5;
  for(let i=0;i<input.length;i++){
    h1 ^= input.charCodeAt(i);
    h1 = Math.imul(h1,0x01000193) >>> 0;
  }
  return h1.toString(16).padStart(8,'0');
}

function cleanPlace(v){ return String(v ?? '').trim().replace(/\s+/g,' '); }

export function normalizeKandilliObject(o){
  if(!o || typeof o!=='object') return null;
  const flat=flatten(o);
  const lat=num(pickFlat(flat,['latitude','lat','enlem']));
  const lon=num(pickFlat(flat,['longitude','lon','lng','boylam']));
  const time=parseTRDateTime(flat);
  if(lat===null||lon===null||!time || lat<-90||lat>90||lon<-180||lon>180) return null;

  const ml=num(pickFlat(flat,['ml','localmagnitude','magnitudeml','buyuklukml']));
  const mw=num(pickFlat(flat,['mw','momentmagnitude','magnitudemw','buyuklukmw']));
  const md=num(pickFlat(flat,['md','durationmagnitude','magnitudemd','buyuklukmd']));
  const generic=num(pickFlat(flat,['magnitude','mag','buyukluk','depremsiddeti']));
  const magnitude = ml ?? mw ?? md ?? generic;
  if(magnitude===null || magnitude<0 || magnitude>10) return null;

  const depth=num(pickFlat(flat,['depth','derinlik','depthkm'])) ?? 0;
  const place=cleanPlace(pickFlat(flat,['location','yer','place','region','lokasyon','bolge','title']));
  const rawId=pickFlat(flat,['id','eventid','earthquakeid','depremid','guid','code']);
  const sourceId=rawId!==null
    ? String(rawId)
    : `k-${simpleHash(`${time}|${lat.toFixed(4)}|${lon.toFixed(4)}|${keyNorm(place)}`)}`;

  return {
    id: sourceId,
    source:'KANDILLI', sourceId,
    time, latitude:lat, longitude:lon,
    depth:+depth.toFixed(2), magnitude:+magnitude.toFixed(2), place,
    catalogs:{KANDILLI:{time,latitude:lat,longitude:lon,depth:+depth.toFixed(2),magnitude:+magnitude.toFixed(2),place,ml,mw,md}},
    sources:['KANDILLI']
  };
}

function arrayScore(arr){
  if(!Array.isArray(arr)||!arr.length) return -1;
  const sample=arr.slice(0,Math.min(5,arr.length));
  let valid=0;
  for(const o of sample){
    if(o&&typeof o==='object'){
      const f=flatten(o);
      if(pickFlat(f,['latitude','lat','enlem'])!==null && pickFlat(f,['longitude','lon','lng','boylam'])!==null) valid++;
    }
  }
  return valid*100000 + arr.length;
}

export function extractKandilliArray(payload){
  if(Array.isArray(payload)) return payload;
  const candidates=[];
  const walk=(v,depth=0)=>{
    if(depth>5 || v===null||v===undefined) return;
    if(Array.isArray(v)){ candidates.push(v); for(const x of v.slice(0,3)) if(x&&typeof x==='object') walk(x,depth+1); return; }
    if(typeof v==='object') for(const x of Object.values(v)) walk(x,depth+1);
  };
  walk(payload);
  candidates.sort((a,b)=>arrayScore(b)-arrayScore(a));
  return candidates[0] || [];
}

export function normalizeKandilliPayload(payload){
  const arr=extractKandilliArray(payload);
  const out=[];
  for(const o of arr){ const e=normalizeKandilliObject(o); if(e) out.push(e); }
  return dedupeSameCatalog(out).sort((a,b)=>new Date(b.time)-new Date(a.time));
}

export function distanceKm(a,b){
  const R=6371, p=Math.PI/180;
  const lat1=a.latitude*p,lat2=b.latitude*p,dlat=(b.latitude-a.latitude)*p,dlon=(b.longitude-a.longitude)*p;
  const q=Math.sin(dlat/2)**2+Math.cos(lat1)*Math.cos(lat2)*Math.sin(dlon/2)**2;
  return 2*R*Math.asin(Math.sqrt(q));
}

function quality(e){ return (e.magnitude>0?3:0)+(e.depth>0?1:0)+(e.place?1:0); }

export function samePhysicalEvent(a,b){
  const dt=Math.abs(new Date(a.time)-new Date(b.time))/1000;
  if(dt>10) return false;
  return distanceKm(a,b)<=2;
}

export function dedupeSameCatalog(events){
  const sorted=[...events].sort((a,b)=>new Date(a.time)-new Date(b.time));
  const out=[];
  for(const e of sorted){
    let idx=out.findIndex(o=>o.sourceId===e.sourceId);
    if(idx<0){
      for(let i=out.length-1;i>=0;i--){
        const dt=Math.abs(new Date(e.time)-new Date(out[i].time))/1000;
        if(dt>15) break;
        if(samePhysicalEvent(e,out[i])){idx=i;break;}
      }
    }
    if(idx<0) out.push(e);
    else if(quality(e)>=quality(out[idx])) out[idx]={...out[idx],...e,id:out[idx].id||e.id,sourceId:out[idx].sourceId||e.sourceId};
  }
  return out;
}

export function inMarmara(e){
  return e.latitude>=MARMARA_BBOX.minLat&&e.latitude<=MARMARA_BBOX.maxLat&&e.longitude>=MARMARA_BBOX.minLon&&e.longitude<=MARMARA_BBOX.maxLon;
}
