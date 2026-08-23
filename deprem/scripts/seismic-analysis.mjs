import fs from 'node:fs/promises';

const DAY=86400e3;
const clamp=(v,a=0,b=1)=>Math.max(a,Math.min(b,v));
const finite=v=>Number.isFinite(v);

export async function buildAnalysis(events,{couplingPath,analoguesPath,nowMs=Date.now()}={}){
  const coupling=JSON.parse(await fs.readFile(couplingPath,'utf8'));
  const analogueDB=JSON.parse(await fs.readFile(analoguesPath,'utf8'));
  const segments=[];
  let nearLocked5=0;
  let insideLockedDepth24h=0;

  for(const f of coupling.features||[]){
    const p=f.properties, trace=f.geometry.coordinates;
    const nearby=events.map(e=>({e,proj:projectPointToPolyline(e,trace)})).filter(x=>x.proj.distanceKm<=12);
    const sortAsc=a=>[...a].sort((x,y)=>new Date(x.e.time)-new Date(y.e.time));
    const age=x=>nowMs-new Date(x.e.time).getTime();
    const h24=nearby.filter(x=>age(x)<=DAY);
    const d7=nearby.filter(x=>age(x)<=7*DAY);
    const d30=nearby.filter(x=>age(x)<=30*DAY);
    const d365=nearby.filter(x=>age(x)<=365*DAY);
    if(p.state==='locked') nearLocked5+=h24.filter(x=>x.proj.distanceKm<=5).length;

    const lockDepth=computeLockDepthInteraction({nearby,h24,d7,properties:p});
    if(p.lockDepthScoreEligible) insideLockedDepth24h+=lockDepth.within24h;

    const prev29=d30.filter(x=>age(x)>DAY).length;
    const baselineDaily=Math.max(0.15,prev29/29);
    const rateRatio=h24.length/baselineDaily;
    const max24=h24.reduce((m,x)=>Math.max(m,x.e.magnitude||0),0);

    const swarm=detectBestSwarm(sortAsc(d7).map(x=>x.e));
    const signalEvents=swarm.detected?swarm.events:sortAsc(nearby.filter(x=>age(x)<=72*3600e3)).map(x=>x.e);
    const migration=computeMigration(signalEvents,trace);
    const depthMigration=computeDepthMigration(signalEvents);
    const magnitudeTrend=computeMagnitudeTrend(signalEvents);
    const quiescence=computeQuiescence(sortAsc(d7).map(x=>x.e),swarm,nowMs);
    const bValue=computeBValueState(d365.map(x=>x.e),nowMs);
    const featureVector=makeFeatureVector({swarm,migration,depthMigration,magnitudeTrend,quiescence,bValue,rateRatio,max24,state:p.state});
    const analogues=compareAnalogues(featureVector,analogueDB.profiles||[]);

    const density=Math.min(1,h24.length/20);
    const anomaly=Math.min(1,Math.max(0,(rateRatio-1)/8));
    const magnitude=Math.min(1,max24/5);
    const lockedBoost=p.state==='locked'?0.15:p.state==='transition'?0.08:0;
    const baseAttention=Math.round(Math.min(100,(density*.34+anomaly*.30+magnitude*.18+lockedBoost)*100));

    const advancedSignal=100*(
      0.18*(swarm.score/100)+
      0.18*migration.strength+
      0.08*depthMigration.strength+
      0.13*magnitudeTrend.accelerationStrength+
      0.12*quiescence.score+
      0.16*bValue.dropStrength+
      0.15*(p.state==='locked'?1:p.state==='transition'?.55:.15)
    );
    const positive=analogues.positiveBest?.similarity||0;
    const benign=analogues.benignBest?.similarity||0;
    // Analogue similarity is deliberately a small modifier. A benign swarm match actively cancels it.
    const evidenceQuality=signalQuality({swarm,migration,bValue,signalEvents});
    const analogueMargin=Math.max(0,positive-0.70*benign-0.15);
    const analogueUplift=Math.round(14*analogueMargin*evidenceQuality);
    // Locked-depth overlap is a small attention modifier, never a probability term.
    // It uses Kandilli depth only and is enabled only for segments with a defensible locking-depth reference.
    const lockingDepthUplift=Math.round(6*lockDepth.strength*(p.state==='locked'?1:p.state==='transition'?0.35:0));
    const attention=Math.round(clamp(0.64*baseAttention+0.36*advancedSignal+analogueUplift+lockingDepthUplift,0,100));

    segments.push({
      id:p.id,name:p.name,state:p.state,
      events24h:h24.length,events7d:d7.length,events30d:d30.length,maxMagnitude24h:max24,
      baselineDaily:+baselineDaily.toFixed(2),rateRatio:+rateRatio.toFixed(2),
      baseAttention,advancedSignal:+advancedSignal.toFixed(1),analogueUplift,lockingDepthUplift,attention,
      swarm:publicSwarm(swarm),migration,depthMigration,magnitudeTrend,quiescence,bValue,lockDepth,
      precursorSimilarity:Math.round(100*positive),benignSimilarity:Math.round(100*benign),
      analogueEvidenceQuality:+evidenceQuality.toFixed(2),analogues:analogues.top,
      featureVector
    });
  }

  const lead=[...segments].sort((a,b)=>b.attention-a.attention)[0]||null;
  const overall=lead?.attention||0;
  return {
    generatedAt:new Date(nowMs).toISOString(),seed:false,
    methodology:{
      version:'5.0',
      warning:'Attention and analogue resemblance are behavioural monitoring scores, not earthquake probabilities or predictions.',
      bValue:'Kandilli-only magnitudes; MAXC+0.2 completeness; Aki-style maximum likelihood; minimum 50 events above Mc.',
      migration:'PCA/free-vector plus projection along the mapped segment; linear trend confidence expressed with R².',
      swarm:'Space-time connected components (5 km / 12 h), event dominance and compactness.',
      analogues:'Literature-derived right-lateral strike-slip fingerprints; positive and benign/null controls are both included.',
      lockDepth:'Kandilli-only depth comparison against literature-derived locking-depth reference bands. Horizontal corridor defaults to 5 km. Catalog depth uncertainty can be several km; overlap is not evidence that the locked asperity itself is failing.'
    },
    overall:{
      attention:overall,
      label:overall>=70?'Yüksek inceleme seviyesi':overall>=45?'Belirgin aktivite':overall>=20?'Hafif aktivite':'Arka plan seviyesi',
      summary:lead?`${lead.name}: swarm ${lead.swarm.score}/100 · migration ${Math.round(lead.migration.strength*100)}/100 · precursor resemblance ${lead.precursorSimilarity}/100. Olasılık değildir.`:'Yeterli veri yok.',
      eventsNearLocked5km:nearLocked5,
      eventsInsideLockedDepth24h:insideLockedDepth24h,
      leadSegmentId:lead?.id||null
    },
    segments
  };
}


export function computeLockDepthInteraction({nearby=[],h24=[],d7=[],properties={}}={}){
  const min=Number(properties.lockDepthMinKm), max=Number(properties.lockDepthMaxKm);
  const available=Number.isFinite(min)&&Number.isFinite(max)&&max>min;
  const buffer=Number.isFinite(+properties.lockDepthBufferKm)?+properties.lockDepthBufferKm:5;
  if(!available){return {available:false,source:'KANDILLI_ONLY',minKm:null,maxKm:null,bufferKm:buffer,within24h:0,within7d:0,below24h:0,below7d:0,kandilli24h:0,kandilli7d:0,medianDepth24h:null,closest:null,strength:0,label:properties.lockDepthLabel||null,citation:properties.lockDepthCitation||null,confidence:properties.lockDepthConfidence||null,scoreEligible:false};}
  const rows=arr=>arr.map(x=>{
    const depth=getKandilliDepth(x.e);
    return {x,depth};
  }).filter(r=>r.x.proj.distanceKm<=buffer&&Number.isFinite(r.depth));
  const r24=rows(h24), r7=rows(d7);
  const inside=r=>r.filter(v=>v.depth>=min&&v.depth<=max);
  const below=r=>r.filter(v=>v.depth>max);
  const in24=inside(r24),in7=inside(r7),below24=below(r24),below7=below(r7);
  const med=median(r24.map(v=>v.depth));
  const all=rows(nearby).sort((a,b)=>{
    const da=Math.max(0,a.depth-max,min-a.depth),db=Math.max(0,b.depth-max,min-b.depth);
    return (a.x.proj.distanceKm+da)-(b.x.proj.distanceKm+db);
  });
  const c=all[0];
  const closest=c?{eventId:c.x.e.id,time:c.x.e.time,magnitude:c.x.e.magnitude,depthKm:+c.depth.toFixed(1),horizontalDistanceKm:+c.x.proj.distanceKm.toFixed(2),relation:c.depth<min?'above':c.depth>max?'below':'within'}:null;
  const strength=clamp(.65*clamp(in24.length/4)+.35*clamp(in7.length/12));
  return {available:true,source:'KANDILLI_ONLY',minKm:min,maxKm:max,observedKm:finite(+properties.lockDepthObservedKm)?+properties.lockDepthObservedKm:null,modelKm:finite(+properties.lockDepthModelKm)?+properties.lockDepthModelKm:null,bufferKm:buffer,kandilli24h:r24.length,kandilli7d:r7.length,within24h:in24.length,within7d:in7.length,below24h:below24.length,below7d:below7.length,medianDepth24h:med===null?null:+med.toFixed(1),closest,strength:+strength.toFixed(3),label:properties.lockDepthLabel||null,citation:properties.lockDepthCitation||null,confidence:properties.lockDepthConfidence||null,scoreEligible:!!properties.lockDepthScoreEligible,warning:'Kandilli routine catalog depth; km-scale location/depth uncertainty may move an event across a nominal locking-depth boundary.'};
}
function getKandilliDepth(e){
  const v=e?.catalogs?.KANDILLI?.depth;
  if(Number.isFinite(+v))return +v;
  if(e?.sources?.includes?.('KANDILLI')&&Number.isFinite(+e.depth))return +e.depth;
  return NaN;
}
function median(a){if(!a.length)return null;const s=[...a].sort((x,y)=>x-y),m=Math.floor(s.length/2);return s.length%2?s[m]:(s[m-1]+s[m])/2;}

function signalQuality({swarm,migration,bValue,signalEvents}){
  const n=signalEvents.length;
  const nQ=clamp(n/30);
  const locQ=swarm.detected?clamp(swarm.count/30):nQ*.7;
  const migQ=migration.valid?clamp((migration.count-5)/20):.2;
  const bQ=bValue.recent?.valid&&bValue.baseline?.valid?1:.35;
  return clamp(.35*locQ+.30*migQ+.20*bQ+.15*nQ,.15,1);
}

function publicSwarm(s){
  const {events,...rest}=s; return rest;
}

export function detectBestSwarm(events,{spaceKm=5,timeHours=12,minEvents=8}={}){
  if(events.length<minEvents)return emptySwarm();
  const arr=[...events].sort((a,b)=>new Date(a.time)-new Date(b.time));
  const n=arr.length, parent=Array.from({length:n},(_,i)=>i);
  const find=i=>parent[i]===i?i:(parent[i]=find(parent[i]));
  const union=(a,b)=>{a=find(a);b=find(b);if(a!==b)parent[b]=a;};
  for(let i=0;i<n;i++){
    const ti=new Date(arr[i].time).getTime();
    for(let j=i+1;j<n;j++){
      const dt=(new Date(arr[j].time).getTime()-ti)/3600e3;
      if(dt>timeHours)break;
      if(distanceKm(arr[i],arr[j])<=spaceKm)union(i,j);
    }
  }
  const groups=new Map();
  for(let i=0;i<n;i++){const r=find(i);if(!groups.has(r))groups.set(r,[]);groups.get(r).push(arr[i]);}
  const candidates=[...groups.values()].filter(g=>g.length>=minEvents).map(clusterStats).sort((a,b)=>b.score-a.score);
  return candidates[0]||emptySwarm();
}
function emptySwarm(){return {detected:false,score:0,count:0,durationHours:0,radiusKm:null,areaKm2:null,maxMagnitude:null,secondMagnitude:null,largestMomentFraction:null,centroid:null,start:null,end:null,events:[]};}
function clusterStats(events){
  const times=events.map(e=>new Date(e.time).getTime());
  const durationHours=(Math.max(...times)-Math.min(...times))/3600e3;
  const centroid={latitude:mean(events.map(e=>e.latitude)),longitude:mean(events.map(e=>e.longitude))};
  const d=events.map(e=>distanceKm(e,centroid)).sort((a,b)=>a-b);
  const radiusKm=quantile(d,.90)||0;
  const areaKm2=Math.PI*radiusKm*radiusKm;
  const mags=events.map(e=>e.magnitude||0).sort((a,b)=>b-a), maxMagnitude=mags[0]||0,secondMagnitude=mags[1]||0;
  const moments=mags.map(m=>10**(1.5*m)),total=ssum(moments),largestMomentFraction=total?moments[0]/total:1;
  const compact=clamp(1-radiusKm/6), countScore=clamp(Math.log10(events.length+1)/2), dominance=clamp(1-largestMomentFraction), durationScore=clamp(1-Math.max(0,durationHours-72)/168);
  const score=Math.round(100*(.38*countScore+.28*compact+.24*dominance+.10*durationScore));
  return {detected:true,score,count:events.length,durationHours:+durationHours.toFixed(2),radiusKm:+radiusKm.toFixed(2),areaKm2:+areaKm2.toFixed(2),maxMagnitude:+maxMagnitude.toFixed(2),secondMagnitude:+secondMagnitude.toFixed(2),largestMomentFraction:+largestMomentFraction.toFixed(3),centroid,start:new Date(Math.min(...times)).toISOString(),end:new Date(Math.max(...times)).toISOString(),events};
}

export function computeMigration(events,trace){
  if(events.length<6)return emptyMigration('insufficient_events',events.length);
  const arr=[...events].sort((a,b)=>new Date(a.time)-new Date(b.time));
  const lat0=mean(arr.map(e=>e.latitude)),lon0=mean(arr.map(e=>e.longitude));
  const xy=arr.map(e=>toXY(e,lat0,lon0));
  const cov=cov2(xy); const eig=principalEigenvector(cov);
  let projections=xy.map(p=>p.x*eig.x+p.y*eig.y);
  const t=arr.map(e=>(new Date(e.time).getTime()-new Date(arr[0].time).getTime())/DAY);
  let reg=linreg(t,projections);
  let vx=eig.x,vy=eig.y;
  if(reg.slope<0){vx*=-1;vy*=-1;projections=projections.map(v=>-v);reg=linreg(t,projections);}
  const along=arr.map(e=>projectPointToPolyline(e,trace).alongKm);
  const alongReg=linreg(t,along);
  const durationDays=Math.max(...t)-Math.min(...t);
  const displacementKm=Math.abs(reg.slope)*durationDays;
  const spatialSpread=std(projections);
  const valid=durationDays>=.02&&spatialSpread>=.25&&finite(reg.r2);
  const strength=valid?clamp(reg.r2)*clamp(displacementKm/2.5)*clamp(arr.length/20):0;
  const azimuth=(Math.atan2(vx,vy)*180/Math.PI+360)%360;
  const centroid={latitude:lat0,longitude:lon0};
  return {
    valid,count:arr.length,reason:valid?null:'low_spread_or_duration',
    speedKmPerDay:valid?+Math.abs(reg.slope).toFixed(2):null,
    displacementKm:valid?+displacementKm.toFixed(2):null,
    azimuthDeg:valid?+azimuth.toFixed(1):null,
    r2:valid?+reg.r2.toFixed(3):null,
    strength:+strength.toFixed(3),centroid,
    alongStrikeSpeedKmPerDay:finite(alongReg.slope)?+alongReg.slope.toFixed(2):null,
    alongStrikeR2:finite(alongReg.r2)?+alongReg.r2.toFixed(3):null,
    durationHours:+(durationDays*24).toFixed(2)
  };
}
function emptyMigration(reason,count=0){return {valid:false,count,reason,speedKmPerDay:null,displacementKm:null,azimuthDeg:null,r2:null,strength:0,centroid:null,alongStrikeSpeedKmPerDay:null,alongStrikeR2:null,durationHours:null};}

export function computeDepthMigration(events){
  if(events.length<6)return {valid:false,count:events.length,slopeKmPerDay:null,r2:null,netChangeKm:null,strength:0,direction:null};
  const arr=[...events].sort((a,b)=>new Date(a.time)-new Date(b.time));
  const t0=new Date(arr[0].time).getTime(), t=arr.map(e=>(new Date(e.time).getTime()-t0)/DAY), z=arr.map(e=>+e.depth||0);
  const reg=linreg(t,z),duration=Math.max(...t)-Math.min(...t),net=reg.slope*duration,spread=std(z);
  const valid=duration>=.02&&spread>=.7&&finite(reg.r2);
  const strength=valid?clamp(reg.r2)*clamp(Math.abs(net)/2)*clamp(arr.length/20):0;
  return {valid,count:arr.length,slopeKmPerDay:valid?+reg.slope.toFixed(2):null,r2:valid?+reg.r2.toFixed(3):null,netChangeKm:valid?+net.toFixed(2):null,strength:+strength.toFixed(3),direction:!valid?null:reg.slope>0?'deeper':'shallower'};
}
export function computeMagnitudeTrend(events){
  if(events.length<6)return {valid:false,count:events.length,slopePerDay:null,r2:null,accelerationStrength:0};
  const arr=[...events].sort((a,b)=>new Date(a.time)-new Date(b.time));
  const t0=new Date(arr[0].time).getTime(),t=arr.map(e=>(new Date(e.time).getTime()-t0)/DAY),m=arr.map(e=>e.magnitude||0),reg=linreg(t,m),duration=Math.max(...t)-Math.min(...t);
  const net=reg.slope*duration;
  const valid=duration>=.02&&finite(reg.r2);
  const accelerationStrength=valid&&reg.slope>0?clamp(reg.r2)*clamp(net/.8)*clamp(arr.length/20):0;
  return {valid,count:arr.length,slopePerDay:valid?+reg.slope.toFixed(3):null,r2:valid?+reg.r2.toFixed(3):null,netChange:valid?+net.toFixed(2):null,accelerationStrength:+accelerationStrength.toFixed(3)};
}

export function computeQuiescence(events,swarm,nowMs){
  if(!swarm.detected)return {valid:false,score:0,recent6h:0,previous18h:0,ratio:null};
  const recent=events.filter(e=>nowMs-new Date(e.time).getTime()<=6*3600e3).length;
  const prev=events.filter(e=>{const a=nowMs-new Date(e.time).getTime();return a>6*3600e3&&a<=24*3600e3;}).length;
  const recentRate=recent/6,prevRate=prev/18;
  if(prev<4)return {valid:false,score:0,recent6h:recent,previous18h:prev,ratio:null};
  const ratio=recentRate/Math.max(.01,prevRate),score=clamp((.55-ratio)/.55);
  return {valid:true,score:+score.toFixed(3),recent6h:recent,previous18h:prev,ratio:+ratio.toFixed(2)};
}

export function computeBValueState(events,nowMs){
  const kandilli=events.map(toKandilliMagnitude).filter(Boolean).sort((a,b)=>new Date(a.time)-new Date(b.time));
  const recent=kandilli.filter(e=>nowMs-new Date(e.time).getTime()<=30*DAY);
  const baseline=kandilli.filter(e=>{const a=nowMs-new Date(e.time).getTime();return a>30*DAY&&a<=365*DAY;});
  const r=estimateB(recent),b=estimateB(baseline);
  let delta=null,dropStrength=0,z=null;
  if(r.valid&&b.valid){
    delta=r.b-b.b;
    const se=Math.sqrt(r.sigma*r.sigma+b.sigma*b.sigma);
    z=se?delta/se:null;
    // Only statistically supported downward shifts add to the signal; upward/ambiguous changes do not.
    dropStrength=clamp((b.b-r.b)/.35)*clamp((-(z??0)-1)/2);
  }
  return {recent:r,baseline:b,delta:delta===null?null:+delta.toFixed(3),z:z===null?null:+z.toFixed(2),dropStrength:+dropStrength.toFixed(3),source:'KANDILLI_ONLY'};
}
function toKandilliMagnitude(e){
  const c=e.catalogs?.KANDILLI;if(!c)return null;const m=+c.magnitude;if(!finite(m))return null;return {time:c.time||e.time,magnitude:m};
}
export function estimateB(events,{bin=.1,minN=50}={}){
  const mags=events.map(e=>+e.magnitude).filter(finite);
  if(mags.length<minN)return {valid:false,n:mags.length,reason:'insufficient_events',mc:null,b:null,sigma:null};
  const hist=new Map();for(const m of mags){const k=Math.round(m/bin)*bin;hist.set(k,(hist.get(k)||0)+1);}
  const mode=[...hist.entries()].sort((a,b)=>b[1]-a[1]||a[0]-b[0])[0]?.[0];
  if(!finite(mode))return {valid:false,n:mags.length,reason:'no_mc',mc:null,b:null,sigma:null};
  const mc=+(mode+.2).toFixed(1),complete=mags.filter(m=>m>=mc);
  if(complete.length<minN)return {valid:false,n:complete.length,reason:'insufficient_above_mc',mc,b:null,sigma:null,total:mags.length};
  const meanM=mean(complete),den=meanM-(mc-bin/2);
  if(den<=0)return {valid:false,n:complete.length,reason:'invalid_denominator',mc,b:null,sigma:null,total:mags.length};
  const b=Math.LOG10E/den;
  const sq=ssum(complete.map(m=>(m-meanM)**2));
  const sigma=2.30*b*b*Math.sqrt(sq/(complete.length*(complete.length-1)));
  return {valid:true,n:complete.length,total:mags.length,mc,b:+b.toFixed(3),sigma:+sigma.toFixed(3)};
}

function makeFeatureVector({swarm,migration,depthMigration,magnitudeTrend,quiescence,bValue,rateRatio,max24,state}){
  const duration=swarm.detected?swarm.durationHours:(migration.durationHours||72);
  return {
    eventCountNorm:clamp(Math.log10((swarm.count||0)+1)/2),
    maxMagnitudeNorm:clamp((swarm.maxMagnitude??max24??0)/6.5),
    durationNorm:clamp(Math.log10(Math.max(.1,duration)+1)/Math.log10(169)),
    swarmness:clamp(swarm.score/100),
    spatialConcentration:swarm.radiusKm===null?0:clamp(1-swarm.radiusKm/6),
    migrationStrength:clamp(migration.strength),
    depthMigrationStrength:clamp(depthMigration.strength),
    magnitudeAcceleration:clamp(magnitudeTrend.accelerationStrength),
    quiescence:clamp(quiescence.score),
    bDrop:clamp(bValue.dropStrength),
    rateAnomaly:clamp(Math.log10(Math.max(1,rateRatio))/1.2),
    lockedContext:state==='locked'?1:state==='transition'?.55:.15
  };
}

export function compareAnalogues(current,profiles){
  const scored=profiles.map(p=>{
    let wsum=0,ss=0,used=0;
    for(const [key,spec] of Object.entries(p.features||{})){
      const v=current[key];if(!finite(v))continue;
      const tol=Math.max(.05,+spec.tolerance||.3),w=+spec.weight||1;
      const d=Math.abs(v-(+spec.target||0));
      const local=Math.exp(-0.5*(d/tol)**2);
      ss+=w*local;wsum+=w;used++;
    }
    const similarity=wsum?ss/wsum:0;
    return {id:p.id,name:p.name,outcome:p.outcome,mainshockMagnitude:p.mainshockMagnitude,mechanism:p.mechanism,similarity:+similarity.toFixed(3),featuresUsed:used,summary:p.summary,sources:p.sources};
  }).sort((a,b)=>b.similarity-a.similarity);
  const positive=scored.filter(x=>x.outcome==='large_mainshock');
  const benign=scored.filter(x=>x.outcome==='no_large_mainshock');
  const nullControls=scored.filter(x=>x.outcome.includes('without_clear'));
  return {top:scored.slice(0,4),positiveBest:positive[0]||null,benignBest:benign[0]||null,nullBest:nullControls[0]||null};
}

export function projectPointToPolyline(e,coords){
  let best={distanceKm:Infinity,alongKm:0,closest:null};let cumulative=0;
  for(let i=0;i<coords.length-1;i++){
    const a=coords[i],b=coords[i+1],lat0=e.latitude*Math.PI/180,kx=111.32*Math.cos(lat0),ky=110.57;
    const px=(e.longitude-a[0])*kx,py=(e.latitude-a[1])*ky,bx=(b[0]-a[0])*kx,by=(b[1]-a[1])*ky;
    const len=Math.hypot(bx,by),den=len*len,t=den?clamp((px*bx+py*by)/den):0;
    const dx=px-t*bx,dy=py-t*by,d=Math.hypot(dx,dy);
    if(d<best.distanceKm)best={distanceKm:d,alongKm:cumulative+t*len,closest:[a[0]+t*(b[0]-a[0]),a[1]+t*(b[1]-a[1])]};
    cumulative+=len;
  }
  return best;
}

function toXY(e,lat0,lon0){return {x:(e.longitude-lon0)*111.32*Math.cos(lat0*Math.PI/180),y:(e.latitude-lat0)*110.57};}
function cov2(pts){const mx=mean(pts.map(p=>p.x)),my=mean(pts.map(p=>p.y));return {xx:mean(pts.map(p=>(p.x-mx)**2)),yy:mean(pts.map(p=>(p.y-my)**2)),xy:mean(pts.map(p=>(p.x-mx)*(p.y-my)))};}
function principalEigenvector(c){const theta=.5*Math.atan2(2*c.xy,c.xx-c.yy);return {x:Math.cos(theta),y:Math.sin(theta)};}
function linreg(x,y){
  if(x.length!==y.length||x.length<2)return {slope:NaN,intercept:NaN,r2:NaN};
  const mx=mean(x),my=mean(y),sxx=ssum(x.map(v=>(v-mx)**2)),sxy=ssum(x.map((v,i)=>(v-mx)*(y[i]-my)));
  if(sxx===0)return {slope:0,intercept:my,r2:0};
  const slope=sxy/sxx,intercept=my-slope*mx,pred=x.map(v=>intercept+slope*v),ssTot=ssum(y.map(v=>(v-my)**2)),ssRes=ssum(y.map((v,i)=>(v-pred[i])**2));
  return {slope,intercept,r2:ssTot?clamp(1-ssRes/ssTot,0,1):0};
}
function distanceKm(a,b){const R=6371,lat1=a.latitude*Math.PI/180,lat2=b.latitude*Math.PI/180,dlat=(b.latitude-a.latitude)*Math.PI/180,dlon=(b.longitude-a.longitude)*Math.PI/180,q=Math.sin(dlat/2)**2+Math.cos(lat1)*Math.cos(lat2)*Math.sin(dlon/2)**2;return 2*R*Math.asin(Math.sqrt(q));}
function mean(a){return a.length?ssum(a)/a.length:0;}function ssum(a){return a.reduce((s,v)=>s+v,0);}function std(a){if(a.length<2)return 0;const m=mean(a);return Math.sqrt(ssum(a.map(v=>(v-m)**2))/(a.length-1));}
function quantile(a,q){if(!a.length)return null;const i=(a.length-1)*q,lo=Math.floor(i),hi=Math.ceil(i);return lo===hi?a[lo]:a[lo]+(a[hi]-a[lo])*(i-lo);}
