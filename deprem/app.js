import {normalizeKandilliPayload, inMarmara, dedupeSameCatalog} from './kandilli-normalize.mjs';
import {buildAnalysis} from './scripts/seismic-analysis.mjs';

const KANDILLI_API = 'https://morning-frog-d5fd.schwpzzzz.workers.dev/?limit=1000';
const HISTORY_URL = './data/history-marmara.json';
const LIVE_FALLBACK_URL = './data/live-fallback.json';
const ANALYSIS_URL = './data/analysis.json';
const ANALOGUES_URL = './data/analogues.json';
const COUPLING_URL = './data/coupling-zones.geojson';
const FAULTS_URL = './data/faults.geojson';
const BOUNDS = [[26.15,40.25],[30.55,41.35]];

const state = {
  events: [],
  liveEvents: [],
  historyEvents: [],
  analysis: null,
  publishedAnalysis: null,
  analogueDB: null,
  coupling: null,
  faults: null,
  hours: 72,
  minMag: 0,
  selected: null,
  liveMode: 'connecting',
  lastLivePoll: null
};

const ALERT_MIN_MAG = 4.0;
const ALERT_SEEN_KEY = 'msw-alert-seen-v1';
const ALERT_ENABLED_KEY = 'msw-alert-enabled-v1';

let alertsEnabled =
  localStorage.getItem(ALERT_ENABLED_KEY) === '1';

let alertSeen =
  new Set(JSON.parse(localStorage.getItem(ALERT_SEEN_KEY) || '[]'));

let alertBaselineReady = false;

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const fmt1 = n =>
  Number.isFinite(+n) ? (+n).toFixed(1) : '—';

const fmt0 = n =>
  Number.isFinite(+n) ? Math.round(+n).toString() : '—';

const escapeHtml = s =>
  String(s ?? '').replace(
    /[&<>'"]/g,
    c => ({
      '&':'&amp;',
      '<':'&lt;',
      '>':'&gt;',
      "'":'&#39;',
      '"':'&quot;'
    }[c])
  );

const trDate = iso => {
  try {
    return new Intl.DateTimeFormat('tr-TR',{
      day:'2-digit',
      month:'short',
      hour:'2-digit',
      minute:'2-digit',
      timeZone:'Europe/Istanbul'
    }).format(new Date(iso));
  } catch {
    return iso;
  }
};

const ago = iso => {
  const d =
    (Date.now() - new Date(iso).getTime()) / 1000;

  if(d < 60)
    return `${Math.max(0,Math.round(d))} sn`;

  if(d < 3600)
    return `${Math.round(d/60)} dk`;

  if(d < 86400)
    return `${Math.round(d/3600)} sa`;

  return `${Math.round(d/86400)} gün`;
};


/* =========================================================
   MAP
========================================================= */

const map = new maplibregl.Map({
  container:'map',
  style:'https://tiles.openfreemap.org/styles/dark',
  center:[28.55,40.79],
  zoom:8.9,
  minZoom:7.5,
  maxZoom:15,
  attributionControl:false
});

map.addControl(
  new maplibregl.NavigationControl({
    showCompass:false
  }),
  'top-right'
);

map.addControl(
  new maplibregl.AttributionControl({
    compact:true,
    customAttribution:'OpenFreeMap · OpenStreetMap'
  }),
  'bottom-right'
);


function emptyFC(){
  return {
    type:'FeatureCollection',
    features:[]
  };
}


function eventFeature(e){
  return {
    type:'Feature',
    id:e.id,

    geometry:{
      type:'Point',
      coordinates:[
        e.longitude,
        e.latitude
      ]
    },

    properties:{
      ...e,
      catalogs:JSON.stringify(e.catalogs || {})
    }
  };
}


function sourceClass(){
  return 'KANDILLI';
}


function sourceColorExpr(){
  return '#45d9c8';
}


function magRadiusExpr(){
  return [
    'interpolate',
    ['linear'],
    ['coalesce',['to-number',['get','magnitude']],0],

    0,3.2,
    1,4.5,
    2,6,
    3,8,
    4,11,
    5,15,
    7,22
  ];
}


/* =========================================================
   MAP LOAD
========================================================= */

map.on('load', async () => {

  /* GEM active faults */

  map.addSource('faults',{
    type:'geojson',
    data:emptyFC()
  });

  map.addLayer({
    id:'gem-faults',
    type:'line',
    source:'faults',

    paint:{
      'line-color':'#95a6b0',

      'line-width':[
        'interpolate',
        ['linear'],
        ['zoom'],
        8,0.7,
        12,1.5
      ],

      'line-opacity':0.48
    }
  });


  /* Coupling / locked zones */

  map.addSource('coupling',{
    type:'geojson',
    data:emptyFC()
  });


  map.addLayer({
    id:'coupling-corridor',
    type:'line',
    source:'coupling',

    paint:{

      'line-color':[
        'match',
        ['get','state'],

        'locked','#ff6078',
        'transition','#f0b84b',
        'creep','#4e8dff',

        '#90a3ae'
      ],

      'line-width':[
        'interpolate',
        ['linear'],
        ['zoom'],
        8,12,
        12,22
      ],

      'line-opacity':0.12
    }
  });


  map.addLayer({
    id:'coupling-lines',
    type:'line',
    source:'coupling',

    paint:{

      'line-color':[
        'match',
        ['get','state'],

        'locked','#ff6078',
        'transition','#f0b84b',
        'creep','#4e8dff',

        '#90a3ae'
      ],

      'line-width':[
        'interpolate',
        ['linear'],
        ['zoom'],
        8,2.5,
        12,4.5
      ],

      'line-opacity':0.93
    }
  });


  /* Swarm / migration signals */

  map.addSource('signals',{
    type:'geojson',
    data:emptyFC()
  });


  map.addLayer({
    id:'signal-swarm-fill',
    type:'fill',
    source:'signals',

    filter:[
      '==',
      ['get','kind'],
      'swarm'
    ],

    paint:{
      'fill-color':'#55e0d3',
      'fill-opacity':0.07
    }
  });


  map.addLayer({
    id:'signal-swarm-outline',
    type:'line',
    source:'signals',

    filter:[
      '==',
      ['get','kind'],
      'swarm'
    ],

    paint:{
      'line-color':'#55e0d3',
      'line-width':1.3,
      'line-opacity':0.62,
      'line-dasharray':[2,1]
    }
  });


  map.addLayer({
    id:'signal-migration',
    type:'line',
    source:'signals',

    filter:[
      '==',
      ['get','kind'],
      'migration'
    ],

    paint:{

      'line-color':'#55e0d3',

      'line-width':[
        'interpolate',
        ['linear'],
        ['get','strength'],
        0,1.5,
        1,4
      ],

      'line-opacity':0.82,
      'line-dasharray':[2,1]
    }
  });


  map.addLayer({
    id:'signal-migration-end',
    type:'circle',
    source:'signals',

    filter:[
      '==',
      ['get','kind'],
      'migrationEnd'
    ],

    paint:{
      'circle-radius':4,
      'circle-color':'#55e0d3',
      'circle-stroke-width':2,
      'circle-stroke-color':'#07131b'
    }
  });


  /* Earthquakes */

  map.addSource('earthquakes',{
    type:'geojson',
    data:emptyFC(),
    cluster:false
  });


  map.addLayer({
    id:'earthquake-glow',
    type:'circle',
    source:'earthquakes',

    paint:{
      'circle-radius':[
        '+',
        magRadiusExpr(),
        5
      ],

      'circle-color':sourceColorExpr(),
      'circle-opacity':0.09,
      'circle-blur':0.8
    }
  });


  map.addLayer({
    id:'locked-depth-ring',
    type:'circle',
    source:'earthquakes',

    filter:[
      '==',
      ['get','lockDepthOverlap'],
      true
    ],

    paint:{
      'circle-radius':[
        '+',
        magRadiusExpr(),
        7
      ],

      'circle-color':'rgba(0,0,0,0)',
      'circle-opacity':0,

      'circle-stroke-width':1.8,
      'circle-stroke-color':'#ff6078',
      'circle-stroke-opacity':0.9
    }
  });


  map.addLayer({
    id:'earthquakes',
    type:'circle',
    source:'earthquakes',

    paint:{

      'circle-radius':
        magRadiusExpr(),

      'circle-color':
        sourceColorExpr(),

      'circle-opacity':[
        'coalesce',
        ['to-number',['get','opacity']],
        0.88
      ],

      'circle-stroke-width':[
        'case',
        ['==',['get','sourceClass'],'MERGED'],
        1.5,
        0.7
      ],

      'circle-stroke-color':[
        'case',
        ['==',['get','sourceClass'],'MERGED'],
        '#ffffff',
        '#061019'
      ]
    }
  });


  map.on(
    'click',
    'earthquakes',
    onEarthquakeClick
  );


  map.on(
    'mouseenter',
    'earthquakes',
    () => map.getCanvas().style.cursor='pointer'
  );


  map.on(
    'mouseleave',
    'earthquakes',
    () => map.getCanvas().style.cursor=''
  );


  map.on(
    'click',
    'coupling-lines',
    onCouplingClick
  );


  map.on(
    'mouseenter',
    'coupling-lines',
    () => map.getCanvas().style.cursor='pointer'
  );


  map.on(
    'mouseleave',
    'coupling-lines',
    () => map.getCanvas().style.cursor=''
  );


  await loadAll();
});


/* =========================================================
   JSON
========================================================= */

async function getJson(url){

  const sep =
    url.includes('?') ? '&' : '?';

  const r = await fetch(
    `${url}${sep}v=${Date.now()}`,
    {
      cache:'no-store'
    }
  );

  if(!r.ok)
    throw new Error(
      `${url}: HTTP ${r.status}`
    );

  return r.json();
}


/* =========================================================
   INITIAL LOAD
========================================================= */

async function loadAll(){

  setSync(
    'loading',
    'Kandilli canlı bağlantı kuruluyor'
  );

  try{

    const [
      history,
      analysis,
      coupling,
      faults,
      analogueDB
    ] = await Promise.all([

      getJson(HISTORY_URL),
      getJson(ANALYSIS_URL),
      getJson(COUPLING_URL),
      getJson(FAULTS_URL),
      getJson(ANALOGUES_URL)

    ]);


    state.historyEvents =
      (history.events || []).map(
        e => ({
          ...e,
          sourceClass:'KANDILLI'
        })
      );


    state.analysis = analysis;
    state.publishedAnalysis = analysis;
    state.analogueDB = analogueDB;
    state.coupling = coupling;
    state.faults = faults;


    map.getSource('faults')?.setData(faults);

    map.getSource('coupling')?.setData(coupling);


    $('#analysisUpdate').textContent =
      analysis.generatedAt
        ? trDate(analysis.generatedAt)
        : '—';


    await refreshLiveKandilli(true);

  }catch(err){

    console.error(err);

    setSync(
      'error',
      'Başlangıç verisi yüklenemedi'
    );

    $('#eventList').innerHTML =
      `<div class="empty">${escapeHtml(err.message)}</div>`;
  }
}


/* =========================================================
   LIVE KANDILLI
========================================================= */

async function fetchLiveKandilli(){

  const sep =
    KANDILLI_API.includes('?')
      ? '&'
      : '?';


  const r =
    await fetch(
      `${KANDILLI_API}${sep}_=${Date.now()}`,
      {
        cache:'no-store',

        headers:{
          'accept':'application/json'
        }
      }
    );


  if(!r.ok)
    throw new Error(
      `Kandilli API HTTP ${r.status}`
    );


  const payload =
    await r.json();


  const events =
    normalizeKandilliPayload(payload)
      .filter(inMarmara);


  if(!events.length)
    throw new Error(
      'Kandilli API yanıtı parse edilemedi'
    );


  return events;
}


/* =========================================================
   LIVE + ARCHIVE MERGE
========================================================= */

function mergeLiveAndHistory(
  live,
  history
){

  const merged =
    dedupeSameCatalog([
      ...(history || []),
      ...(live || [])
    ]);


  return merged
    .map(
      e => ({
        ...e,
        sourceClass:'KANDILLI'
      })
    )
    .sort(
      (a,b) =>
        new Date(b.time) -
        new Date(a.time)
    );
}


/* =========================================================
   LIVE REFRESH
========================================================= */

let liveBusy=false;


async function refreshLiveKandilli(
  initial=false
){

  if(liveBusy)
    return;


  liveBusy=true;


  try{

    const live =
      await fetchLiveKandilli();


    state.liveEvents =
      live;


    state.events =
      mergeLiveAndHistory(
        live,
        state.historyEvents
      );


    state.liveMode =
      'direct';


    state.lastLivePoll =
      new Date().toISOString();


    $('#lastUpdate').textContent =
      trDate(state.lastLivePoll);


    setSync(
      'live',
      `Kandilli LIVE · ${live.length} API olayı`
    );


    processMagnitudeAlerts(live);


    await recomputeLiveAnalysis();


    render();

  }catch(err){

    console.warn(
      'Direct Kandilli fetch failed, using GitHub fallback',
      err
    );


    try{

      const fallback =
        await getJson(
          LIVE_FALLBACK_URL
        );


      state.liveEvents =
        (fallback.events || []).map(
          e => ({
            ...e,
            sourceClass:'KANDILLI'
          })
        );


      state.events =
        mergeLiveAndHistory(
          state.liveEvents,
          state.historyEvents
        );


      state.liveMode =
        'fallback';


      state.lastLivePoll =
        fallback.generatedAt || null;


      $('#lastUpdate').textContent =
        state.lastLivePoll
          ? trDate(state.lastLivePoll)
          : '—';


      setSync(
        'loading',
        `Kandilli fallback · ${state.liveEvents.length} olay`
      );


      processMagnitudeAlerts(
        state.liveEvents
      );


      await recomputeLiveAnalysis();


      render();

    }catch(fallbackErr){

      console.error(
        fallbackErr
      );


      if(initial)
        throw fallbackErr;


      setSync(
        'error',
        'Kandilli canlı bağlantısı yok'
      );
    }

  }finally{

    liveBusy=false;
  }
}


/* =========================================================
   PUBLISHED ANALYSIS REFRESH
========================================================= */

async function refreshPublishedAnalysis(){

  if(document.hidden)
    return;


  try{

    const [
      history,
      analysis
    ] =
      await Promise.all([
        getJson(HISTORY_URL),
        getJson(ANALYSIS_URL)
      ]);


    state.historyEvents =
      (history.events || []).map(
        e => ({
          ...e,
          sourceClass:'KANDILLI'
        })
      );


    state.publishedAnalysis =
      analysis;


    state.events =
      mergeLiveAndHistory(
        state.liveEvents,
        state.historyEvents
      );


    $('#analysisUpdate').textContent =
      analysis.generatedAt
        ? trDate(analysis.generatedAt)
        : '—';


    await recomputeLiveAnalysis();


    render();

  }catch(e){

    console.warn(
      'Published analysis refresh failed',
      e
    );
  }
}


/* =========================================================
   LIVE ANALYSIS
========================================================= */

async function recomputeLiveAnalysis(){

  if(
    !state.coupling?.features ||
    !state.analogueDB?.profiles
  )
    return;


  try{

    const analysis =
      await buildAnalysis(
        state.events,
        {
          coupling:
            state.coupling,

          analogueDB:
            state.analogueDB,

          nowMs:
            Date.now()
        }
      );


    analysis.generatedAt =
      new Date().toISOString();


    analysis.source =
      'KANDILLI_LIVE_BROWSER';


    state.analysis =
      analysis;

  }catch(e){

    console.warn(
      'Live analysis failed; using last published analysis',
      e
    );


    state.analysis =
      state.publishedAnalysis ||
      state.analysis;
  }
}


/* =========================================================
   STATUS
========================================================= */

function setSync(
  mode,
  text
){

  $('#syncDot').className =
    `status-dot ${
      mode==='live'
        ? 'live'
        : mode==='error'
          ? 'error'
          : ''
    }`;


  $('#syncText').textContent =
    text;
}


/* =========================================================
   FILTERS
========================================================= */

function filteredEvents(){

  const cutoff =
    Date.now() -
    state.hours * 3600e3;


  return state.events
    .filter(e => {

      const t =
        new Date(e.time).getTime();


      if(
        !Number.isFinite(t) ||
        t < cutoff
      )
        return false;


      if(
        (+e.magnitude || 0) <
        state.minMag
      )
        return false;


      return true;
    })
    .sort(
      (a,b) =>
        new Date(b.time) -
        new Date(a.time)
    );
}


/* =========================================================
   MAIN RENDER
========================================================= */

function render(){

  renderMapEvents();
  renderOverview();
  renderSegments();
  renderSignalPanel();
  renderSignalLayers();
  renderEventList();
}


/* =========================================================
   MAP EVENTS
========================================================= */

function renderMapEvents(){

  const now =
    Date.now();


  const features =
    filteredEvents().map(
      e => {

        const ageH =
          (
            now -
            new Date(e.time).getTime()
          ) /
          3600e3;


        const opacity =
          Math.max(
            .22,
            .95 -
            ageH /
            Math.max(
              state.hours,
              24
            ) *
            .55
          );


        const ld =
          lockDepthComparisonForEvent(e);


        return eventFeature({
          ...e,

          opacity,

          lockDepthOverlap:
            !!ld?.within,

          lockDepthSegment:
            ld?.segmentId || ''
        });
      }
    );


  map
    .getSource('earthquakes')
    ?.setData({
      type:'FeatureCollection',
      features
    });


  $('#visibleCount').textContent =
    features.length;
}


/* =========================================================
   OVERVIEW
========================================================= */

function renderOverview(){

  const ev =
    state.events;


  const now =
    Date.now();


  const h24 =
    ev.filter(
      e =>
        now -
        new Date(e.time).getTime()
        <=
        24 * 3600e3
    );


  const d7 =
    ev.filter(
      e =>
        now -
        new Date(e.time).getTime()
        <=
        7 * 86400e3
    );


  const d30 =
    ev.filter(
      e =>
        now -
        new Date(e.time).getTime()
        <=
        30 * 86400e3
    );


  const max =
    d30.reduce(
      (m,e) =>
        Math.max(
          m,
          +e.magnitude || 0
        ),
      0
    );


  const a =
    state.analysis?.overall || {};


  $('#stat24').textContent =
    h24.length;


  $('#stat7d').textContent =
    d7.length;


  $('#statMax').textContent =
    max
      ? fmt1(max)
      : '—';


  $('#statLocked').textContent =
    fmt0(
      a.eventsInsideLockedDepth24h || 0
    );


  const score =
    Math.max(
      0,
      Math.min(
        100,
        +a.attention || 0
      )
    );


  $('#attentionGauge')
    .style
    .setProperty(
      '--p',
      score
    );


  $('#attentionValue').textContent =
    fmt0(score);


  $('#attentionLabel').textContent =
    a.label ||
    attentionLabel(score);


  $('#attentionSummary').textContent =
    a.summary ||
    'Bu skor yalnızca katalog davranışı ve segment yakınlığındaki aktiviteyi özetler.';
}


function attentionLabel(s){

  return s >= 70
    ? 'Yüksek inceleme seviyesi'

    : s >= 45
      ? 'Belirgin aktivite'

      : s >= 20
        ? 'Hafif aktivite'

        : 'Arka plan seviyesi';
}


/* =========================================================
   SEGMENTS
========================================================= */

function renderSegments(){

  const rows =
    state.analysis?.segments || [];


  if(!rows.length){

    $('#segmentCards').innerHTML =
      '<div class="empty">Segment analizi Action çalışınca dolacak.</div>';

    return;
  }


  $('#segmentCards').innerHTML =
    rows.map(
      s => `
      <article
        class="segment-card"
        data-segment="${escapeHtml(s.id)}"
      >

        <div class="segment-card-top">

          <strong>
            ${escapeHtml(s.name)}
          </strong>

          <span
            class="state-pill ${escapeHtml(s.state)}"
          >
            ${stateName(s.state)}
          </span>

        </div>

        <div class="segment-card-meta">

          <span>
            24s
            <b>${fmt0(s.events24h)}</b>
          </span>

          <span>
            7g
            <b>${fmt0(s.events7d)}</b>
          </span>

          <span>
            Mmax
            <b>
              ${
                s.maxMagnitude24h
                  ? fmt1(s.maxMagnitude24h)
                  : '—'
              }
            </b>
          </span>

          <span>
            Score
            <b>${fmt0(s.attention)}</b>
          </span>

        </div>

        <div class="segment-card-badges">

          <span
            class="mini-pill ${
              (+s.precursorSimilarity || 0) >= 60
                ? 'hot'
                : ''
            }"
          >
            öncü
            ${fmt0(s.precursorSimilarity)}/100
          </span>

          <span
            class="mini-pill ${
              (+s.benignSimilarity || 0) >= 60
                ? 'cool'
                : ''
            }"
          >
            benign
            ${fmt0(s.benignSimilarity)}/100
          </span>

          <span class="mini-pill">
            swarm
            ${fmt0(s.swarm?.score || 0)}
          </span>

          ${
            s.lockDepth?.available

              ? `
                <span
                  class="mini-pill ${
                    s.lockDepth.within24h
                      ? 'depth-hot'
                      : ''
                  }"
                >
                  kilit-der
                  ${fmt0(s.lockDepth.within24h)}
                </span>
              `

              : ''
          }

        </div>

        <div class="activity-bar">
          <span
            style="
              width:
              ${Math.min(100,+s.attention || 0)}%
            "
          ></span>
        </div>

      </article>
      `
    )
    .join('');


  $$('.segment-card')
    .forEach(
      el =>
        el.addEventListener(
          'click',
          () =>
            selectSegment(
              el.dataset.segment
            )
        )
    );
}


function stateName(s){

  return ({
    locked:'Kilitli',
    transition:'Geçiş',
    creep:'Creep'
  })[s] || s;
}


/* =========================================================
   SIGNAL PANEL
========================================================= */

function renderSignalPanel(){

  const rows =
    state.analysis?.segments || [];


  const leadId =
    state.analysis?.overall
      ?.leadSegmentId;


  const s =
    rows.find(
      x =>
        x.id === leadId
    )
    ||
    [...rows].sort(
      (a,b) =>
        (b.attention || 0) -
        (a.attention || 0)
    )[0];


  if(!s){

    $('#signalPanel').innerHTML =
      '<div class="empty">Analiz verisi yok.</div>';

    return;
  }


  const b =
    s.bValue || {};


  const mig =
    s.migration || {};


  const dm =
    s.depthMigration || {};


  const sw =
    s.swarm || {};


  const bText =
    b.recent?.valid

      ? `${fmt1(b.recent.b)} (Mc ${fmt1(b.recent.mc)})`

      : 'yetersiz veri';


  const migText =
    mig.valid

      ? `${fmt1(mig.speedKmPerDay)} km/g · ${fmt0(mig.azimuthDeg)}°`

      : 'tespit yok';


  const depthText =
    dm.valid

      ? `${
          dm.direction === 'deeper'
            ? 'derine'
            : 'sığa'
        } ${fmt1(Math.abs(dm.netChangeKm))} km`

      : 'tespit yok';


  $('#signalPanel').innerHTML = `

    <div class="signal-lead">

      <div class="signal-lead-top">

        <strong>
          ${escapeHtml(s.name)}
        </strong>

        <span class="signal-score">
          ${fmt0(s.attention)}/100
        </span>

      </div>

      <div class="confidence-note">
        Öncü benzerliği
        ${fmt0(s.precursorSimilarity)}/100
        · benign swarm benzerliği
        ${fmt0(s.benignSimilarity)}/100
        · analogue uplift
        +${fmt0(s.analogueUplift || 0)}.
        Bunlar olasılık değildir.
      </div>

    </div>

    <div class="metric-grid">

      ${metricTile(
        'Swarm',

        `${fmt0(sw.score || 0)}/100`,

        sw.detected
          ? `${fmt0(sw.count)} olay · ${fmt1(sw.radiusKm)} km r90`
          : 'aktif swarm yok',

        sw.score || 0
      )}


      ${metricTile(
        'Migration',

        `${fmt0((mig.strength || 0) * 100)}/100`,

        migText,

        (mig.strength || 0) * 100
      )}


      ${metricTile(
        'Depth migration',

        `${fmt0((dm.strength || 0) * 100)}/100`,

        depthText,

        (dm.strength || 0) * 100
      )}


      ${metricTile(
        'b-value',

        bText,

        b.delta === null
          ? 'baseline yok'
          : `Δb ${(+b.delta).toFixed(2)} · z ${b.z ?? '—'}`,

        (b.dropStrength || 0) * 100
      )}


      ${
        s.lockDepth?.available

          ? metricTile(
              'Locked depth',

              `${fmt0(s.lockDepth.within24h)} / 24s`,

              `Kandilli · ${fmt0(s.lockDepth.minKm)}–${fmt1(s.lockDepth.maxKm)} km · +${fmt0(s.lockingDepthUplift || 0)}`,

              (s.lockDepth.strength || 0) * 100
            )

          : metricTile(
              'Locked depth',
              '—',
              'bu segment için tek bant yok',
              0
            )
      }

    </div>

    <div class="analogue-list">

      ${
        (s.analogues || [])
          .slice(0,3)
          .map(
            a =>
              analogueRow(a)
          )
          .join('')
      }

    </div>
  `;
}


function metricTile(
  label,
  value,
  small,
  pct
){

  return `
    <div class="metric-tile">

      <span>
        ${escapeHtml(label)}
      </span>

      <strong>
        ${escapeHtml(value)}
      </strong>

      <small>
        ${escapeHtml(small)}
      </small>

      <div class="metric-bar">

        <i
          style="
            width:
            ${Math.max(
              0,
              Math.min(
                100,
                +pct || 0
              )
            )}%
          "
        ></i>

      </div>

    </div>
  `;
}


function analogueRow(a){

  const cls =
    a.outcome === 'large_mainshock'

      ? 'positive'

      : a.outcome === 'no_large_mainshock'

        ? 'benign'

        : 'control';


  const tag =
    a.outcome === 'large_mainshock'

      ? 'mainshock öncesi'

      : a.outcome === 'no_large_mainshock'

        ? 'büyük deprem yok'

        : 'belirgin öncü yok';


  return `
    <div class="analogue-row ${cls}">

      <div>

        <strong>
          ${escapeHtml(a.name)}
        </strong>

        <small>
          ${escapeHtml(tag)}
        </small>

      </div>

      <span class="analogue-score">
        ${fmt0((a.similarity || 0) * 100)}
      </span>

    </div>
  `;
}


/* =========================================================
   SIGNAL LAYERS
========================================================= */

function renderSignalLayers(){

  const features=[];


  for(
    const s of state.analysis?.segments || []
  ){

    const sw =
      s.swarm || {};


    const m =
      s.migration || {};


    if(
      sw.detected &&
      sw.centroid
    ){

      features.push({

        type:'Feature',

        geometry:
          circlePolygon(
            sw.centroid,
            Math.max(
              .15,
              +sw.radiusKm || .15
            )
          ),

        properties:{
          kind:'swarm',
          segment:s.id,
          score:sw.score,
          count:sw.count,
          radiusKm:sw.radiusKm
        }
      });
    }


    if(
      m.valid &&
      m.centroid &&
      m.strength >= 0.12
    ){

      const start=[
        m.centroid.longitude,
        m.centroid.latitude
      ];


      const end=
        destination(
          start,
          m.azimuthDeg,

          Math.min(
            6,
            Math.max(
              .4,
              m.displacementKm || 1
            )
          )
        );


      features.push({

        type:'Feature',

        geometry:{
          type:'LineString',
          coordinates:[
            start,
            end
          ]
        },

        properties:{
          kind:'migration',
          segment:s.id,
          strength:m.strength,
          speed:m.speedKmPerDay,
          r2:m.r2
        }
      });


      features.push({

        type:'Feature',

        geometry:{
          type:'Point',
          coordinates:end
        },

        properties:{
          kind:'migrationEnd',
          segment:s.id,
          strength:m.strength
        }
      });
    }
  }


  map
    .getSource('signals')
    ?.setData({
      type:'FeatureCollection',
      features
    });
}


function circlePolygon(
  center,
  radiusKm,
  steps=72
){

  const coords=[];


  for(
    let i=0;
    i<=steps;
    i++
  ){

    coords.push(
      destination(
        [
          center.longitude,
          center.latitude
        ],

        i / steps * 360,

        radiusKm
      )
    );
  }


  return {
    type:'Polygon',
    coordinates:[
      coords
    ]
  };
}


function destination(
  start,
  azimuthDeg,
  distanceKm
){

  const R=6371;

  const br=
    azimuthDeg *
    Math.PI /
    180;


  const lat1=
    start[1] *
    Math.PI /
    180;


  const lon1=
    start[0] *
    Math.PI /
    180;


  const d=
    distanceKm /
    R;


  const lat2=
    Math.asin(
      Math.sin(lat1) *
      Math.cos(d)
      +
      Math.cos(lat1) *
      Math.sin(d) *
      Math.cos(br)
    );


  const lon2=
    lon1 +
    Math.atan2(

      Math.sin(br) *
      Math.sin(d) *
      Math.cos(lat1),

      Math.cos(d)
      -
      Math.sin(lat1) *
      Math.sin(lat2)
    );


  return [
    lon2 * 180 / Math.PI,
    lat2 * 180 / Math.PI
  ];
}


/* =========================================================
   EVENT LIST
========================================================= */

function renderEventList(){

  const ev =
    filteredEvents()
      .slice(0,80);


  if(!ev.length){

    $('#eventList').innerHTML =
      '<div class="empty">Bu filtrede olay yok.</div>';

    return;
  }


  $('#eventList').innerHTML =
    ev.map(
      e => `

      <article
        class="event-row"
        data-id="${escapeHtml(e.id)}"
      >

        <div class="event-mag">
          ${fmt1(e.magnitude)}
        </div>

        <div class="event-main">

          <strong>
            ${escapeHtml(
              e.place ||
              'Marmara Bölgesi'
            )}
          </strong>

          <small>

            ${trDate(e.time)}
            ·
            ${fmt1(e.depth)} km
            ·
            ${ago(e.time)} önce

            ${
              lockDepthComparisonForEvent(e)?.within
                ? ' · LOCK-DEPTH'
                : ''
            }

          </small>

        </div>

        <span class="source-token KANDILLI">
          KOERI
        </span>

      </article>
      `
    )
    .join('');


  $$('.event-row')
    .forEach(
      el =>
        el.addEventListener(
          'click',
          () =>
            selectEvent(
              el.dataset.id,
              true
            )
        )
    );
}


/* =========================================================
   EVENT SELECT
========================================================= */

function selectEvent(
  id,
  fly=false
){

  const e =
    state.events.find(
      x =>
        x.id === id
    );


  if(!e)
    return;


  state.selected={
    type:'event',
    id
  };


  renderSelectionEvent(e);


  if(fly){

    map.flyTo({
      center:[
        e.longitude,
        e.latitude
      ],

      zoom:11.5,
      duration:650
    });
  }
}


function renderSelectionEvent(e){

  const cats =
    e.catalogs || {};


  const ld =
    lockDepthComparisonForEvent(e);


  const kd =
    cats.KANDILLI?.depth;


  const lockHtml =
    ld

      ? `
        <div
          class="
            lock-depth-card
            ${
              ld.within
                ? 'inside'
                : ld.relation === 'below'
                  ? 'below'
                  : ''
            }
          "
        >

          <div class="lock-depth-head">

            <span>
              Kilit derinlik karşılaştırması
            </span>

            <strong>

              ${
                ld.within

                  ? 'BANT İÇİNDE'

                  : ld.relation === 'below'

                    ? 'BANDIN ALTINDA'

                    : 'BANDIN ÜSTÜNDE'
              }

            </strong>

          </div>

          <div class="lock-depth-grid">

            <span>
              Segment
            </span>

            <b>
              ${escapeHtml(ld.segmentName)}
            </b>


            <span>
              Yatay uzaklık
            </span>

            <b>
              ${fmt1(ld.distanceKm)} km
            </b>


            <span>
              Kandilli derinliği
            </span>

            <b>
              ${fmt1(ld.depthKm)} km
            </b>


            <span>
              Referans bant
            </span>

            <b>
              ${fmt0(ld.minKm)}–${fmt1(ld.maxKm)} km
            </b>

          </div>

          <p>
            ${escapeHtml(ld.label || '')}
          </p>

          <small>
            Bu eşleşme yalnız Kandilli derinliğiyle yapılır;
            rutin hiposantr derinlik belirsizliği
            km mertebesinde olabilir.
          </small>

        </div>
      `

      : (
          kd === undefined

            ? `
              <div class="lock-depth-card unavailable">
                Kilit derinlik karşılaştırması için
                Kandilli kaydı yok.
              </div>
            `

            : `
              <div class="lock-depth-card unavailable">
                Bu olay 5 km içinde tanımlı bir
                kilit-derinlik referans bandına oturmuyor.
              </div>
            `
        );


  $('#selectionContent').innerHTML = `

    <div class="selection-title">

      M${fmt1(e.magnitude)}
      ·
      ${escapeHtml(e.place || 'Marmara')}

    </div>


    <div class="selection-grid">

      <div class="selection-stat">

        <span>
          Zaman
        </span>

        <strong>
          ${trDate(e.time)}
        </strong>

      </div>


      <div class="selection-stat">

        <span>
          Derinlik
        </span>

        <strong>
          ${fmt1(e.depth)} km
        </strong>

      </div>


      <div class="selection-stat">

        <span>
          Enlem
        </span>

        <strong>
          ${(+e.latitude).toFixed(4)}
        </strong>

      </div>


      <div class="selection-stat">

        <span>
          Boylam
        </span>

        <strong>
          ${(+e.longitude).toFixed(4)}
        </strong>

      </div>

    </div>

    ${lockHtml}


    <p class="selection-note">

      Kaynak:
      <strong>Kandilli Rasathanesi API aynası</strong>.

      Canlı gösterim doğrudan API’den;
      tarihsel analiz GitHub arşivinden beslenir.

    </p>


    <div class="selection-sources">

      ${
        Object.entries(cats)

          .map(
            ([k,v]) =>
              `${
                escapeHtml(k)
              }: M${
                fmt1(v.magnitude)
              } · ${
                fmt1(v.depth)
              } km`
          )

          .join('<br>')

        ||

        escapeHtml(
          (e.sources || [])
            .join(' + ')
        )
      }

    </div>
  `;
}


/* =========================================================
   SEGMENT SELECT
========================================================= */

function selectSegment(id){

  const feat =
    state.coupling
      ?.features
      ?.find(
        f =>
          f.properties?.id === id
      );


  if(!feat)
    return;


  renderSelectionSegment(
    feat.properties
  );


  const coords =
    feat.geometry.coordinates;


  const mid =
    coords[
      Math.floor(
        coords.length / 2
      )
    ];


  map.flyTo({
    center:mid,
    zoom:9.8,
    duration:650
  });
}


function renderSelectionSegment(p){

  const a =
    (
      state.analysis?.segments ||
      []
    )
    .find(
      x =>
        x.id === p.id
    );


  const sw =
    a?.swarm || {};


  const m =
    a?.migration || {};


  const dm =
    a?.depthMigration || {};


  const bv =
    a?.bValue || {};


  const analytics =
    a

      ? `
        <div class="analysis-block">

          <div class="analysis-block-title">
            Canlı davranış
          </div>


          ${analysisKV(
            'Attention',
            `${fmt0(a.attention)}/100 (+${fmt0(a.analogueUplift || 0)} analogue)`
          )}


          ${analysisKV(
            'Swarm',

            sw.detected
              ? `${fmt0(sw.score)}/100 · ${fmt0(sw.count)} olay`
              : 'tespit yok'
          )}


          ${analysisKV(
            'Göç',

            m.valid
              ? `${fmt1(m.speedKmPerDay)} km/g · R² ${m.r2}`
              : 'tespit yok'
          )}


          ${analysisKV(
            'Derinlik',

            dm.valid

              ? `${
                  dm.direction === 'deeper'
                    ? 'derine'
                    : 'sığa'
                } · ${fmt1(dm.netChangeKm)} km · R² ${dm.r2}`

              : 'tespit yok'
          )}


          ${analysisKV(
            'b-value',

            bv.recent?.valid

              ? `b ${bv.recent.b} / Mc ${bv.recent.mc} / n ${bv.recent.n}`

              : 'yetersiz veri'
          )}


          ${
            a.lockDepth?.available

              ? analysisKV(
                  'Kilit derinlik',
                  `${fmt0(a.lockDepth.minKm)}–${fmt1(a.lockDepth.maxKm)} km · ${a.lockDepth.confidence || '—'}`
                )

              : analysisKV(
                  'Kilit derinlik',
                  'tek bant yok'
                )
          }


          ${
            a.lockDepth?.available

              ? analysisKV(
                  'Kandilli overlap',

                  `${fmt0(a.lockDepth.within24h)} / 24s · ${fmt0(a.lockDepth.within7d)} / 7g · +${fmt0(a.lockingDepthUplift || 0)} score`
                )

              : ''
          }


          ${analysisKV(
            'Öncü benzerliği',
            `${fmt0(a.precursorSimilarity)}/100`
          )}


          ${analysisKV(
            'Benign swarm benzerliği',
            `${fmt0(a.benignSimilarity)}/100`
          )}


          <div class="analogue-list">

            ${
              (a.analogues || [])
                .map(
                  analogueRow
                )
                .join('')
            }

          </div>


          <div class="confidence-note">

            Öncü benzerliği yalnızca literatürdeki
            davranış vektörüne yakınlığı ölçer;

            “M7 olacak” anlamına gelmez.

          </div>

        </div>
      `

      : '';


  $('#selectionContent').innerHTML = `

    <div class="selection-title">
      ${escapeHtml(p.name)}
    </div>


    <div class="selection-grid">

      <div class="selection-stat">

        <span>
          Durum
        </span>

        <strong>
          ${stateName(p.state)}
        </strong>

      </div>


      <div class="selection-stat">

        <span>
          Güven
        </span>

        <strong>
          ${escapeHtml(p.confidence || '—')}
        </strong>

      </div>

    </div>


    <p class="selection-note">
      ${escapeHtml(p.note || '')}
    </p>


    ${
      p.lockDepthLabel

        ? `
          <div class="lock-depth-reference">

            <strong>
              Kilit derinlik referansı
            </strong>

            <p>
              ${escapeHtml(p.lockDepthLabel)}
            </p>

          </div>
        `

        : ''
    }


    ${analytics}


    <div class="selection-sources">

      Kaynaklar:
      ${escapeHtml(p.citations || '')}

    </div>
  `;
}


function analysisKV(k,v){

  return `
    <div class="analysis-kv">

      <span>
        ${escapeHtml(k)}
      </span>

      <b>
        ${escapeHtml(v)}
      </b>

    </div>
  `;
}


/* =========================================================
   LOCKED DEPTH
========================================================= */

function lockDepthComparisonForEvent(e){

  const kd =
    e?.catalogs?.KANDILLI?.depth;


  if(
    !Number.isFinite(+kd) ||
    !state.coupling?.features?.length
  )
    return null;


  let best=null;


  for(
    const f of state.coupling.features
  ){

    const p =
      f.properties || {};


    const min =
      +p.lockDepthMinKm;


    const max =
      +p.lockDepthMaxKm;


    const buffer =
      Number.isFinite(+p.lockDepthBufferKm)

        ? +p.lockDepthBufferKm

        : 5;


    if(
      !Number.isFinite(min) ||
      !Number.isFinite(max) ||
      max <= min
    )
      continue;


    const d =
      pointToPolylineKm(
        e,
        f.geometry.coordinates
      );


    if(d > buffer)
      continue;


    const depth =
      +kd;


    const relation =
      depth < min

        ? 'above'

        : depth > max

          ? 'below'

          : 'within';


    const candidate={

      segmentId:
        p.id,

      segmentName:
        p.name,

      distanceKm:
        d,

      depthKm:
        depth,

      minKm:
        min,

      maxKm:
        max,

      within:
        relation === 'within',

      relation,

      label:
        p.lockDepthLabel,

      citation:
        p.lockDepthCitation,

      state:
        p.state
    };


    if(
      !best ||
      d < best.distanceKm
    ){

      best =
        candidate;
    }
  }


  return best;
}


/* =========================================================
   DISTANCE TO FAULT
========================================================= */

function pointToPolylineKm(
  e,
  coords
){

  let best=
    Infinity;


  for(
    let i=0;
    i<coords.length-1;
    i++
  ){

    best=
      Math.min(
        best,
        pointSegKm(
          e,
          coords[i],
          coords[i+1]
        )
      );
  }


  return best;
}


function pointSegKm(
  e,
  a,
  b
){

  const lat0 =
    e.latitude *
    Math.PI /
    180;


  const kx =
    111.32 *
    Math.cos(lat0);


  const ky =
    110.57;


  const px =
    (e.longitude-a[0]) *
    kx;


  const py =
    (e.latitude-a[1]) *
    ky;


  const bx =
    (b[0]-a[0]) *
    kx;


  const by =
    (b[1]-a[1]) *
    ky;


  const den =
    bx*bx +
    by*by;


  const t =
    den

      ? Math.max(
          0,
          Math.min(
            1,
            (
              px*bx +
              py*by
            ) /
            den
          )
        )

      : 0;


  return Math.hypot(
    px -
    t*bx,

    py -
    t*by
  );
}


/* =========================================================
   MAP CLICK EVENTS
========================================================= */

function onEarthquakeClick(e){

  const p =
    e.features?.[0]?.properties;


  if(!p)
    return;


  const id =
    p.id;


  selectEvent(
    id,
    false
  );


  const ev =
    state.events.find(
      x =>
        x.id === id
    );


  if(!ev)
    return;


  new maplibregl.Popup({
    closeButton:false,
    offset:10
  })

    .setLngLat([
      ev.longitude,
      ev.latitude
    ])

    .setHTML(`

      <div class="popup-title">

        M${fmt1(ev.magnitude)}
        ·
        ${escapeHtml(ev.place)}

      </div>


      <div class="popup-grid">

        <span>
          Zaman
        </span>

        <b>
          ${trDate(ev.time)}
        </b>


        <span>
          Derinlik
        </span>

        <b>
          ${fmt1(ev.depth)} km
        </b>


        <span>
          Kaynak
        </span>

        <b>
          KANDILLI
        </b>

      </div>
    `)

    .addTo(map);
}


function onCouplingClick(e){

  const p =
    e.features?.[0]?.properties;


  if(!p)
    return;


  renderSelectionSegment(p);
}


/* =========================================================
   M4 ALERT SYSTEM
========================================================= */

function persistAlertSeen(){

  const ids =
    [...alertSeen]
      .slice(-500);


  localStorage.setItem(
    ALERT_SEEN_KEY,
    JSON.stringify(ids)
  );
}


function updateAlertButton(){

  const b =
    $('#alertBtn');


  if(!b)
    return;


  b.textContent =
    alertsEnabled

      ? '🔔 M4+ alarm açık'

      : '🔕 Alarmı etkinleştir';


  b.title =
    alertsEnabled

      ? 'Yeni M4.0+ katalog olayında ses + tarayıcı bildirimi'

      : 'M4.0+ yeni olaylarda sesli ve tarayıcı bildirimi';
}


function beepAlert(mag){

  try{

    const AC =
      window.AudioContext ||
      window.webkitAudioContext;


    if(!AC)
      return;


    const ctx =
      new AC();


    const pattern =
      mag >= 5

        ? [
            0,
            0.28,
            0.56,
            0.84
          ]

        : [
            0,
            0.34
          ];


    for(
      const t of pattern
    ){

      const o =
        ctx.createOscillator();


      const g =
        ctx.createGain();


      o.type =
        'sine';


      o.frequency.value =
        mag >= 5
          ? 880
          : 660;


      g.gain.setValueAtTime(
        0.0001,
        ctx.currentTime+t
      );


      g.gain.exponentialRampToValueAtTime(
        0.18,
        ctx.currentTime+t+0.02
      );


      g.gain.exponentialRampToValueAtTime(
        0.0001,
        ctx.currentTime+t+0.20
      );


      o.connect(g)
        .connect(ctx.destination);


      o.start(
        ctx.currentTime+t
      );


      o.stop(
        ctx.currentTime+t+0.22
      );
    }


    setTimeout(
      () =>
        ctx.close()
          .catch(()=>{}),

      1800
    );

  }catch(e){

    console.warn(
      'alert sound',
      e
    );
  }
}


function showMagnitudeAlert(e){

  beepAlert(
    +e.magnitude || 0
  );


  const title =
    `${
      (+e.magnitude || 0) >= 5
        ? '🚨'
        : '⚠️'
    } M${fmt1(e.magnitude)} deprem`;


  const body =
    `${
      e.place ||
      'Marmara'
    } · ${
      fmt1(e.depth)
    } km · Kandilli`;


  if(
    'Notification' in window &&
    Notification.permission === 'granted'
  ){

    try{

      new Notification(
        title,
        {
          body,
          tag:`quake-${e.id}`,
          renotify:false
        }
      );

    }catch{}
  }


  if(
    map &&
    Number.isFinite(+e.longitude) &&
    Number.isFinite(+e.latitude)
  ){

    map.easeTo({

      center:[
        +e.longitude,
        +e.latitude
      ],

      zoom:
        Math.max(
          map.getZoom(),
          10.5
        ),

      duration:
        900
    });
  }
}


function processMagnitudeAlerts(events){

  if(!alertsEnabled){

    updateAlertButton();

    return;
  }


  const qualifying =
    events
      .filter(
        e =>
          (+e.magnitude || 0) >=
          ALERT_MIN_MAG
      )

      .sort(
        (a,b) =>
          new Date(a.time) -
          new Date(b.time)
      );


  if(!alertBaselineReady){

    qualifying
      .forEach(
        e =>
          alertSeen.add(e.id)
      );


    persistAlertSeen();

    alertBaselineReady=true;

    updateAlertButton();

    return;
  }


  for(
    const e of qualifying
  ){

    if(
      alertSeen.has(e.id)
    )
      continue;


    alertSeen.add(e.id);


    persistAlertSeen();


    showMagnitudeAlert(e);
  }


  updateAlertButton();
}


async function enableAlerts(){

  if(alertsEnabled){

    alertsEnabled=false;


    localStorage.setItem(
      ALERT_ENABLED_KEY,
      '0'
    );


    updateAlertButton();

    return;
  }


  if(
    'Notification' in window &&
    Notification.permission === 'default'
  ){

    try{

      await Notification.requestPermission();

    }catch{}
  }


  /*
    Bu click bir user gesture.
    Browser'ın audio iznini burada açıyoruz.
  */

  try{

    const AC =
      window.AudioContext ||
      window.webkitAudioContext;


    if(AC){

      const c =
        new AC();


      await c.resume();


      await c.close();
    }

  }catch{}


  alertsEnabled=true;


  localStorage.setItem(
    ALERT_ENABLED_KEY,
    '1'
  );


  alertBaselineReady=false;


  processMagnitudeAlerts(
    state.events
  );


  updateAlertButton();
}


/* =========================================================
   UI BUTTONS
========================================================= */

$('#alertBtn')
  ?.addEventListener(
    'click',
    enableAlerts
  );


updateAlertButton();


$('#refreshBtn')
  .addEventListener(
    'click',
    () => {

      refreshLiveKandilli();

      refreshPublishedAnalysis();
    }
  );


$('#fitBtn')
  .addEventListener(
    'click',
    () =>
      map.fitBounds(
        BOUNDS,
        {
          padding:36,
          duration:700
        }
      )
  );


$('#magRange')
  .addEventListener(
    'input',
    e => {

      state.minMag =
        +e.target.value;


      $('#magLabel').textContent =
        state.minMag.toFixed(1);


      render();
    }
  );


$$('#timeFilter button')
  .forEach(
    b =>
      b.addEventListener(
        'click',
        () => {

          $$('#timeFilter button')
            .forEach(
              x =>
                x.classList.remove(
                  'active'
                )
            );


          b.classList.add(
            'active'
          );


          state.hours =
            +b.dataset.hours;


          render();
        }
      )
  );


$$('.layer-toggle input')
  .forEach(
    inp =>
      inp.addEventListener(
        'change',
        () => {

          const key =
            inp.dataset.layer;


          const vis =
            inp.checked
              ? 'visible'
              : 'none';


          if(
            key === 'earthquakes'
          ){

            [
              'earthquakes',
              'earthquake-glow',
              'locked-depth-ring'
            ]
              .forEach(
                id =>
                  map.getLayer(id) &&
                  map.setLayoutProperty(
                    id,
                    'visibility',
                    vis
                  )
              );
          }


          if(
            key === 'gemFaults' &&
            map.getLayer('gem-faults')
          ){

            map.setLayoutProperty(
              'gem-faults',
              'visibility',
              vis
            );
          }


          if(
            key === 'signals'
          ){

            [
              'signal-swarm-fill',
              'signal-swarm-outline',
              'signal-migration',
              'signal-migration-end'
            ]
              .forEach(
                id =>
                  map.getLayer(id) &&
                  map.setLayoutProperty(
                    id,
                    'visibility',
                    vis
                  )
              );
          }


          if(
            key.startsWith(
              'coupling'
            )
          ){

            updateCouplingVisibility();
          }
        }
      )
  );


function updateCouplingVisibility(){

  const l =
    $('[data-layer="couplingLocked"]')
      .checked;


  const t =
    $('[data-layer="couplingTransition"]')
      .checked;


  const c =
    $('[data-layer="couplingCreep"]')
      .checked;


  const states=[];


  if(l)
    states.push('locked');


  if(t)
    states.push('transition');


  if(c)
    states.push('creep');


  const filter =
    states.length

      ? [
          'in',
          ['get','state'],
          ['literal',states]
        ]

      : [
          '==',
          ['get','state'],
          '__none__'
        ];


  [
    'coupling-corridor',
    'coupling-lines'
  ]
    .forEach(
      id =>
        map.getLayer(id) &&
        map.setFilter(
          id,
          filter
        )
    );
}


/* =========================================================
   LIVE POLLING
========================================================= */

/*
  Kandilli canlı veri:
  Worker üzerinden her 30 saniyede bir.
*/

setInterval(
  () => {

    if(!document.hidden){

      refreshLiveKandilli();
    }

  },
  30_000
);


/*
  GitHub archive / published analysis:
  dakikada bir kontrol.
*/

setInterval(
  refreshPublishedAnalysis,
  60_000
);


/*
  Kullanıcı sekmeye geri dönerse
  hemen canlı veriyi yenile.
*/

document.addEventListener(
  'visibilitychange',
  () => {

    if(!document.hidden){

      refreshLiveKandilli();

      refreshPublishedAnalysis();
    }
  }
);
