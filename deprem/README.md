# Marmara Seismic Watch v6

Static GitHub Pages dashboard for monitoring Marmara seismicity, published fault-coupling interpretations, swarms, migration, b-value changes and **behavioural similarity** to selected historical right-lateral strike-slip sequences.

> **Not an earthquake prediction system.** `Attention` and `Precursor resemblance` are descriptive monitoring scores, not probabilities.

## Seismic catalogs — only two

1. **Kandilli Observatory (KOERI)** via the API mirror linked by Nahrimed:
   `https://api.demirhanomerdemir.com/Deprem/KandilliRasathanesi?limit=5000`
2. **USGS ComCat** via the official FDSN Event API:
   `https://earthquake.usgs.gov/fdsnws/event/1/query`

There is **no AFAD feed or fallback**.

The updater preserves both catalog solutions. Close time/location/magnitude matches are merged so the same earthquake is not double-counted. For local merged events the dashboard uses Kandilli as the display solution and keeps USGS under `catalogs.USGS`.

## Signal Engine v6

The GitHub Action computes the following for every Main Marmara Fault segment corridor.

### 1. Swarm detector

A simple space-time connected-component detector links events when they are within **5 km** and **12 hours**. Components with at least **8 events** are scored using:

- event count,
- spatial compactness,
- duration,
- and whether seismic moment is dominated by one mainshock or distributed among many events.

This intentionally distinguishes a compact swarm-like sequence from a classic one-mainshock/aftershock sequence.

### 2. Migration vector

For the active cluster, epicentres are converted to local Cartesian coordinates. PCA finds the dominant spatial axis, then event position along that axis is regressed against time.

The output includes:

- migration azimuth,
- km/day,
- total inferred displacement,
- R²,
- and a 0–1 migration strength.

A second regression projects events along the mapped MMF segment and reports along-strike speed/R². The map draws the free migration vector only when the signal passes minimum duration/spatial-spread checks.

**Catalog locations are not double-difference relocations**, so small apparent migrations can be location error. This metric is a screening tool.

### 3. Depth migration

Depth is regressed against time inside the active sequence. The engine reports:

- deeper / shallower,
- km/day,
- net depth change,
- R²,
- strength.

Depth migration is intentionally down-weighted because routine catalog depths can have kilometre-scale uncertainty.

### 4. b-value

b-value uses **Kandilli magnitudes only** to avoid mixing magnitude scales.

- completeness magnitude `Mc`: maximum-curvature estimate + 0.2 magnitude units,
- b: Aki-style maximum-likelihood estimate with bin-width correction,
- uncertainty: Shi–Bolt style estimate,
- minimum: **50 events above Mc**.

The current 30-day value is compared with a 31–365 day baseline. Only a statistically supported **downward** change contributes to Attention. If the local archive is not long/dense enough, the UI says `yetersiz veri` and adds no b-value signal.

### 5. Quiescence and magnitude acceleration

The engine also keeps two supporting features because they appear in some historical sequences:

- post-burst rate reduction (last 6 h vs previous 18 h),
- magnitude-vs-time positive trend inside the active sequence.

Neither is treated as diagnostic by itself.

## Right-lateral analogue engine

`data/analogues.json` contains a transparent, editable reference library. The current sequence is converted to a normalized feature vector and compared with each profile using weighted Gaussian similarity.

Current reference profiles:

- **1999 İzmit Mw7.6** — 26 M0.9–2.8 foreshocks in 44 min, systematic west→east migration toward the hypocentre. Ellsworth & Bulut (2018), DOI `10.1038/s41561-018-0145-1`.
- **2025 Kumburgaz/Silivri Mw6.2** — right-lateral Marmara rupture; ~M4 foreshock ~36 min before at essentially the same location, without a dense 2007-style swarm. DOI `10.32858/temblor.361`; forecasting preprint DOI `10.31223/x5w78x`.
- **2016 Kumamoto M7.3** — right-lateral/oblique system; M6.5/M6.4 foreshocks, ~28 h to M7.3, reported relative quiescence and deeper migration toward the hypocentre. DOI `10.1186/s40623-017-0756-6` plus Japanese Earthquake Research Committee evaluation.
- **2007 Prens Adaları swarm — benign control** — 77 events in <20 h and ~2.5 km², lateral/upward migration, Mmax 2.5, then decay **without a large mainshock**. Bulut et al. (2011), DOI `10.1785/0120100215`.
- **2004 Parkfield Mw6.0 — null-control** — dense monitoring/high-resolution work found no clear precursor at the rupture section; some activity/b-value changes occurred away in the creeping section. DOI `10.1785/0120050827`, `10.1785/0220220206`.

### Why benign/null controls matter

A pattern that resembles İzmit but resembles the 2007 benign Prens Adaları swarm even more should **not** strongly increase Attention. Therefore:

`analogue uplift ≈ positive-mainshock similarity – 0.70 × benign similarity – safety margin`

and the uplift is capped at **+14 points** and multiplied by data-quality confidence.

So historical similarity can nudge Attention; it can never dominate it.

## What “Precursor resemblance 70/100” means

It means only:

> the currently observed catalogue feature vector resembles the literature-derived feature vector of one or more historical sequences by that amount under this heuristic metric.

It does **not** mean:

- 70% earthquake probability,
- 70% chance of M7,
- a countdown,
- or a validated forecasting skill score.

Published precursor studies use different networks, magnitude completeness, relocation methods and time windows. They cannot honestly be treated as one homogeneous machine-learning training set. The analogue library is therefore explicit and auditable rather than a black-box “AI prediction” model.

## Fault geometry and coupling are separate layers

- **Active-fault geometry:** GEM Global Active Faults Database, clipped to Marmara by a weekly GitHub Action.
- **Coupling interpretation:** `data/coupling-zones.geojson` is an approximate literature-based corridor interpretation, not a live sensor product or survey-grade locking polygon.

Key references:

- Bohnhoff et al. (2013), *Nature Communications*, DOI `10.1038/ncomms2999`.
- Géli/Yamamoto et al. (2019), *Nature Communications*, DOI `10.1038/s41467-019-11016-z`.
- Becker et al. (2023), *GRL*, DOI `10.1029/2022GL101471`.
- Martínez-Garzón et al. (2026), *Science*, DOI `10.1126/science.adz0072`.

## Deploy on GitHub Pages

1. Create a **public** GitHub repository.
2. Upload this folder to repository root and push to `main`.
3. **Settings → Pages → Deploy from branch → main / root**.
4. **Actions → Update seismic data → Run workflow** once.
5. **Actions → Refresh GEM fault layer → Run workflow** once.
6. The seismic workflow then runs every 10 minutes; the GEM layer refreshes weekly.

GitHub scheduled workflows can be delayed. The dashboard displays the generated timestamp.

## Archive

Source events are stored in `data/archive/YYYY-MM.json`. The archive is append/update-by-source-ID, so a rolling upstream API does not erase previously collected events.

- `data/current.json` — deduplicated 30-day browser view.
- `data/analysis.json` — segment signal engine output.
- `data/analogues.json` — human-readable historical analogue definitions.

b-value baseline quality improves as this archive grows.

## Developer check

Run locally only if you want to test code changes:

```bash
node scripts/self-test.mjs
```

Deployment itself does not require Python or a local server.


## Locked-depth comparison (v6)

v6 compares **Kandilli hypocentral depths only** against literature-derived locking-depth reference bands for segments where a defensible depth range exists. USGS is still retained for catalog cross-checking but is not used for this depth-overlap calculation.

Reference bands currently encoded:

- **Princes Islands:** 0–10 km aseismic/locked patch in Bohnhoff et al. (2013); a 2026 GNSS+InSAR regional inversion places the eastern Main Marmara Fault, including Princes Islands, as mostly locked to ~12 km. The app uses 0–12 km as the broad monitoring band and displays the 10 km direct seismic observation separately.
- **Kumburgaz is split in v6:** the western Silivri High / western-Kumburgaz corridor is shown as a **transition/nucleation zone**, while the eastern Kumburgaz section is shown as **locked**. 2019 seafloor geodesy directly found no measurable creep beneath the Kumburgaz network and supports locking to at least 3 km, presumably ~5.5 km. The 2025 Mw6.3 study places nucleation at the transition between partially creeping Central Basin and the locked Kumburgaz segment and reports that the locked eastern part remained quiescent. For scoring, v6 conservatively uses **0–5.5 km** for the locked Kumburgaz depth-overlap test; a broader ~10 km interpretation is displayed but not treated as equally direct evidence.
- **Ganos / west of 27.5°E:** 2026 regional GNSS+InSAR inversion indicates the fault is mostly locked to ~12 km. This is a regional model, not a local 3-D asperity boundary.
- **Central Basin / Tekirdağ transition:** no single locking-depth band is imposed because creep/transition behavior is depth-dependent and a single number would be misleading.

For each Kandilli event within 5 km of a segment with a depth reference, v6 classifies it as **within**, **above**, or **below** the nominal locked-depth band. A red ring on the map marks events that are horizontally near the segment and vertically inside the reference band.

Important: routine catalog hypocentral depths can be uncertain by several kilometres. A point falling inside a nominal locking-depth band **does not show that the locked asperity itself is breaking**; it can be on a nearby secondary structure or move across the boundary after relocation.

Primary references: Bohnhoff et al. 2013, Nature Communications 4:1999; Schmittbuhl et al. 2016, G3; Géli/Yamamoto et al. 2019, Nature Communications 10:3006; Klein et al. 2026, EGU26-18025.

## Near-live refresh behavior

- `.github/workflows/update-seismic.yml` is scheduled every **5 minutes**.
- GitHub scheduled workflows can occasionally start late depending on runner load, so this is **near-live**, not second-by-second telemetry.
- An already-open dashboard tab re-fetches `current.json`, `analysis.json`, fault, and coupling layers every **60 seconds** without a page reload.
- Returning to a backgrounded tab triggers an immediate refresh.


## M4+ browser alarm
The dashboard includes an opt-in **M4.0+** browser alarm. The user must click “Alarmı etkinleştir” once so the browser can authorize audio/notifications. Existing M4+ events are baselined and do not fire retroactively; only newly published event IDs trigger. M5+ uses a more urgent sound pattern. This is a catalogue notification, **not earthquake early warning**; GitHub Actions and upstream catalogue latency can delay it by minutes, and it does not work after the page is fully closed.
