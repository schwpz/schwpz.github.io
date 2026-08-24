import {detectBestSwarm,computeMigration,computeDepthMigration,estimateB,compareAnalogues,computeLockDepthInteraction} from './seismic-analysis.mjs';
import {normalizeKandilliPayload} from '../kandilli-normalize.mjs';
import fs from 'node:fs/promises';

const parsed=normalizeKandilliPayload({data:[
  {Tarih:'24.08.2026',Saat:'00:56:00',Enlem:'40.78',Boylam:'29.09',Derinlik:'4.8',ML:'1.8',Yer:'ADALAR (ISTANBUL)'}
]});
if(parsed.length!==1||parsed[0].magnitude!==1.8||parsed[0].depth!==4.8) throw new Error(`Kandilli parser failed ${JSON.stringify(parsed)}`);

const trace=[[29.0,40.8],[29.3,40.75]];
const t0=Date.parse('2026-08-20T00:00:00Z');
const ev=[];
for(let i=0;i<40;i++){
  const f=i/39;
  ev.push({
    id:`s${i}`,time:new Date(t0+i*18*60e3).toISOString(),
    latitude:40.79-0.006*f+0.0006*Math.sin(i),longitude:29.06+0.045*f+0.0005*Math.cos(i),
    depth:12-3*f+0.2*Math.sin(i/2),magnitude:1.0+1.5*f+0.12*Math.sin(i),
    sources:['KANDILLI'],catalogs:{KANDILLI:{time:new Date(t0+i*18*60e3).toISOString(),depth:12-3*f,magnitude:1.0+1.5*f}}
  });
}
const swarm=detectBestSwarm(ev),mig=computeMigration(ev,trace),depth=computeDepthMigration(ev);
if(!swarm.detected||swarm.count!==40)throw new Error('swarm detector failed');
if(!mig.valid||mig.r2<0.8||mig.displacementKm<2)throw new Error(`migration failed ${JSON.stringify(mig)}`);
if(!depth.valid||depth.r2<0.7||depth.direction!=='shallower')throw new Error(`depth migration failed ${JSON.stringify(depth)}`);
const mags=[];for(let i=0;i<120;i++)mags.push({magnitude:1+(i%30)*.1});
const b=estimateB(mags,{minN:50}); if(!b.valid)throw new Error(`b-value failed ${JSON.stringify(b)}`);

const ldEvents=ev.slice(0,12).map((e,i)=>({...e,catalogs:{KANDILLI:{depth:i<6?8:14,magnitude:e.magnitude,time:e.time}},sources:['KANDILLI']}));
const wrapped=ldEvents.map(e=>({e,proj:{distanceKm:1.2}}));
const ld=computeLockDepthInteraction({nearby:wrapped,h24:wrapped,d7:wrapped,properties:{lockDepthMinKm:0,lockDepthMaxKm:12,lockDepthBufferKm:5,lockDepthScoreEligible:true}});
if(!ld.available||ld.within24h!==6||ld.below24h!==6)throw new Error(`lock-depth failed ${JSON.stringify(ld)}`);

const db=JSON.parse(await fs.readFile(new URL('../data/analogues.json',import.meta.url),'utf8'));
const sim=compareAnalogues({eventCountNorm:.95,maxMagnitudeNorm:.38,durationNorm:.5,swarmness:1,spatialConcentration:.95,migrationStrength:.9,depthMigrationStrength:.8,magnitudeAcceleration:.35,quiescence:.2,bDrop:0,rateAnomaly:.8,lockedContext:1},db.profiles);
if(sim.benignBest?.id!=='princes-2007')throw new Error('analogue matching failed');
console.log('Self-test OK', {parser:parsed[0],swarm:swarm.score,migration:mig,depth,b,benign:sim.benignBest});
