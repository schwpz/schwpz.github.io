import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const OUT=path.join(ROOT,'data','faults.geojson');
const URL='https://raw.githubusercontent.com/GEMScienceTools/gem-global-active-faults/master/geojson/gem_active_faults.geojson';
const box={minLat:40.15,maxLat:41.45,minLon:26.0,maxLon:30.7};
const r=await fetch(URL,{headers:{'User-Agent':'MarmaraSeismicWatch/3.0'}});if(!r.ok)throw new Error(`GEM ${r.status}`);const data=await r.json();
const features=(data.features||[]).filter(f=>intersects(f.geometry));
const out={type:'FeatureCollection',metadata:{source:'GEM Global Active Faults Database',url:'https://github.com/GEMScienceTools/gem-global-active-faults',license:'CC BY-SA 4.0',citation:'Styron & Pagani (2020), Earthquake Spectra',updatedAt:new Date().toISOString()},features};
await fs.writeFile(OUT,JSON.stringify(out,null,2));console.log(`GEM Marmara subset: ${features.length} faults`);
function intersects(g){if(!g)return false;let minLon=Infinity,maxLon=-Infinity,minLat=Infinity,maxLat=-Infinity;walk(g.coordinates);return minLon<=box.maxLon&&maxLon>=box.minLon&&minLat<=box.maxLat&&maxLat>=box.minLat;function walk(v){if(Array.isArray(v)&&v.length>=2&&typeof v[0]==='number'&&typeof v[1]==='number'){minLon=Math.min(minLon,v[0]);maxLon=Math.max(maxLon,v[0]);minLat=Math.min(minLat,v[1]);maxLat=Math.max(maxLat,v[1]);return;}if(Array.isArray(v))for(const x of v)walk(x);}}
