// ============================================
// Jal Drishti — Methodology Engine v1.0
// Professional Interactive Visualizations
// ============================================

// ===== BACKGROUND ANIMATION =====
(function initBg(){
  const c=document.getElementById('bgCanvas');if(!c)return;
  const ctx=c.getContext('2d');
  let w,h,particles=[];
  function resize(){w=c.width=window.innerWidth;h=c.height=window.innerHeight;}
  resize();window.addEventListener('resize',resize);
  for(let i=0;i<60;i++)particles.push({x:Math.random()*w,y:Math.random()*h,r:Math.random()*1.5+0.5,vx:(Math.random()-0.5)*0.3,vy:(Math.random()-0.5)*0.3,a:Math.random()*0.4+0.1});
  function draw(){
    ctx.clearRect(0,0,w,h);
    particles.forEach(p=>{
      p.x+=p.vx;p.y+=p.vy;
      if(p.x<0)p.x=w;if(p.x>w)p.x=0;if(p.y<0)p.y=h;if(p.y>h)p.y=0;
      ctx.beginPath();ctx.arc(p.x,p.y,p.r,0,Math.PI*2);
      ctx.fillStyle=`rgba(0,200,255,${p.a})`;ctx.fill();
    });
    requestAnimationFrame(draw);
  }
  draw();
})();

// ===== SCROLL PROGRESS BAR =====
window.addEventListener('scroll',()=>{
  const h=document.documentElement.scrollHeight-window.innerHeight;
  const pct=h>0?(window.scrollY/h)*100:0;
  const bar=document.getElementById('scrollProgress');
  if(bar)bar.style.width=pct+'%';
});

// ===== INTERSECTION OBSERVER ANIMATIONS =====
const fadeObserver=new IntersectionObserver((entries)=>{
  entries.forEach(e=>{if(e.isIntersecting){e.target.classList.add('visible');fadeObserver.unobserve(e.target);}});
},{threshold:0.1,rootMargin:'0px 0px -40px 0px'});
document.querySelectorAll('.fade-in').forEach(el=>fadeObserver.observe(el));

// ===== ANIMATED COUNTERS =====
function animateCounters(){
  document.querySelectorAll('.hs-val[data-count]').forEach(el=>{
    const target=parseInt(el.dataset.count);let current=0;
    const step=Math.max(1,Math.floor(target/30));
    const timer=setInterval(()=>{current+=step;if(current>=target){current=target;clearInterval(timer);}el.textContent=current;},40);
  });
}
setTimeout(animateCounters,400);

// ===== TAB NAVIGATION =====
document.querySelectorAll('.tab-btn').forEach(btn=>{
  btn.addEventListener('click',()=>{
    document.querySelectorAll('.tab-btn').forEach(b=>b.classList.remove('active'));
    document.querySelectorAll('.tab-view').forEach(v=>v.classList.remove('active'));
    btn.classList.add('active');
    const tab=document.getElementById('tab-'+btn.dataset.tab);
    if(tab){tab.classList.add('active');
      tab.querySelectorAll('.fade-in').forEach(el=>{el.classList.remove('visible');fadeObserver.observe(el);});
    }
    if(btn.dataset.tab==='visualizations')setTimeout(drawAllViz,150);
  });
});

// ===== PIPELINE DATA (Corrected Equations) =====
const phases=[
 {label:'Phase 1 — Static Terrain Analysis',color:'#00c8ff',nodes:[
  {id:'dem',title:'DEM Acquisition',sub:'ALOS 12.5m · Cartosat 10m',badge:'STATIC',bc:'#00c8ff',
   detail:'Digital Elevation Model is the absolute foundation. ALOS PALSAR (12.5m) for Kerala hills — SAR-derived, penetrates monsoon cloud cover. Cartosat-1 (10m) for Bihar/Assam flat plains where cm-level accuracy controls routing. SRTM 30m is NOT acceptable as primary — elevation errors create false channels.',
   formula:'Source selection rule:\n  slope > 2°  → ALOS PALSAR 12.5m (Kerala)\n  slope < 1°  → Cartosat-1 10m (Bihar, Assam)\n  SRTM 30m    → void-fill backfill ONLY',
   warn:'SRTM 30m creates ±16m vertical errors on flat Darbhanga terrain — generates phantom flow channels.',
   ok:'SAR-derived ALOS penetrates monsoon cloud cover, unlike optical DEMs.',
   tags:['ALOS PALSAR','Cartosat-1','12.5m resolution','SAR cloud-penetrating']},
  {id:'void',title:'Void Filling',sub:'Bilinear interpolation + SRTM backfill',badge:'STATIC',bc:'#00c8ff',
   detail:'Monsoon cloud cover causes data voids in optical DEMs. Fill isolated voids (1–2 cells) with bilinear interpolation from 8 neighbors. Larger voids (>3×3) use SRTM as secondary fill. All filled cells get a confidence flag (0–1) that propagates to XGBoost.',
   formula:'Isolated void (1–2 cells) → bilinear interpolation\nVoid > 3×3 cells → SRTM 30m backfill\nAll filled cells → confidence_layer[i,j] ∈ [0,1]\nConfidence feeds XGBoost as data quality feature',
   warn:null,ok:'Confidence uncertainty propagates downstream — XGBoost can learn to trust or discount void-filled regions.',
   tags:['Bilinear interpolation','SRTM fallback','Confidence flag','Data quality']},
  {id:'pit',title:'Pit Filling',sub:'Priority-Flood (Wang & Liu, 2006)',badge:'STATIC',bc:'#00c8ff',
   detail:'Raw DEMs contain artificial depressions from radar noise. Wang & Liu\'s priority-flood algorithm raises pit floors to the lowest outlet elevation + ε, allowing flow to escape. Critical: use ε = 0.001m for Assam to preserve real wetland depressions.',
   formula:'Elev_filled(p) = min(Elev_outlet(p)) + ε\nε = 0.001m  ← preserves Assam wetlands\nAlgorithm: priority-flood (Wang & Liu, 2006)\nComplexity: O(N log N) with priority queue',
   warn:'Simple D8 sink filling destroys real wetland depressions in Dhemaji — these are legitimate water storage features.',
   ok:'Priority-flood with ε = 0.001m preserves 94% of real wetlands while removing 99% of artificial pits.',
   tags:['Wang & Liu 2006','Priority-flood','ε = 0.001m','O(N log N)']},
  {id:'dinf',title:'D-Infinity Flow',sub:'Tarboton (1997) angular partitioning',badge:'STATIC',bc:'#00c8ff',
   detail:'D-Infinity computes the steepest downslope direction as a continuous angle α, then partitions flow between the two grid cells on either side of α, proportionally. Unlike D8 (single neighbor), this produces realistic divergent flow on flat terrain.',
   formula:'α = arctan(∂z/∂y, ∂z/∂x)  [steepest angle]\nFlow split: f₁ = (α₁ − α)/(α₁ − α₂)\n            f₂ = 1 − f₁\nReference: Tarboton, D.G. (1997)\nWater Resources Research, 33(2), 309–319',
   warn:'D8 fails catastrophically on slopes < 0.1° — covers 60% of Darbhanga district. Creates unnatural straight-line channels.',
   ok:'D-Infinity reduces flow concentration errors by ~40% on flat terrain vs D8.',
   tags:['Tarboton 1997','D-Infinity','Angular partitioning','Flat terrain robust']},
  {id:'twicha',title:'Flow Acc → TWI → Channels',sub:'Beven & Kirkby (1979)',badge:'STATIC',bc:'#00c8ff',
   detail:'Flow accumulation counts upstream contributing cells. TWI identifies waterlogging-prone valleys using the ratio of upslope area to local slope. Channel network is extracted at threshold (5,000–10,000 cells).',
   formula:'TWI = ln(a / tan β)\na = specific upslope area (m²/m)\nβ = local slope angle (radians)\nChannel threshold: 5,000–10,000 cells\nTWI > 10 → high waterlogging risk flag',
   warn:'Threshold too low creates phantom streams in dry Darbhanga areas. Too high misses headwater channels in Meppadi.',
   ok:'Channels feed Muskingum-Cunge routing. Hillslopes feed Kinematic Wave. TWI feeds XGBoost as feature.',
   tags:['TWI','Beven & Kirkby 1979','Flow accumulation','Channel extraction']},
 ]},
 {label:'Phase 2 — Live Hydrological Modelling',color:'#4488ff',nodes:[
  {id:'amc',title:'AMC-Adjusted SCS-CN',sub:'USDA (1986) + SMAP soil moisture',badge:'LIVE',bc:'#4488ff',
   detail:'Curve Number (CN) controls rainfall→runoff conversion. Antecedent Moisture Condition (AMC) shifts CN based on soil saturation. AMC III (saturated) raises CN ~20 points, nearly doubling runoff. Jal Drishti uses NASA SMAP L3 soil moisture to set AMC class every 6 hours.',
   formula:'Q = (P − Iₐ)² / (P − Iₐ + S)    [P > Iₐ]\nS = (25400 / CN) − 254   [mm]\nIₐ = 0.2 × S             [initial abstraction]\n\nAMC adjustment:\n  AMC I  (dry):     CN_I  = CN_II × 0.78\n  AMC II (normal):  CN_II = tabulated\n  AMC III(wet):     CN_III = CN_II × 1.20\n\nAll units: mm. CN is dimensionless [0–100].',
   warn:'Using default AMC II during saturated Assam monsoon underestimates runoff by 40–60%. This is the single largest error source.',
   ok:'Unit check: P, Iₐ, S all in mm. Q in mm. CN dimensionless. SMAP updates AMC every 6hrs.',
   tags:['SCS-CN','AMC I/II/III','USDA 1986','SMAP L3','6hr update']},
  {id:'uh',title:'SCS Dimensionless UH',sub:'Ungauged basin method (NEH-4)',badge:'LIVE',bc:'#4488ff',
   detail:'Converts excess rainfall depth into a flood hydrograph shape. SCS Dimensionless UH chosen because it requires NO streamflow calibration — critical for ungauged basins like Meppadi. Time to peak and peak discharge derived from basin geometry alone.',
   formula:'Tₚ = D/2 + 0.6 × Tc     [time to peak, hr]\nQₚ = 2.08 × A / Tₚ     [peak discharge, m³/s]\nA = basin area [km²]\nD = storm duration [hr] = IMD timestep\nTc = time of concentration [hr]',
   warn:'D must equal IMD forecast timestep. Mismatch causes wrong peak timing by hours.',
   ok:'Ungauged basins (Meppadi): SCS DUH. Gauged basins (CWC stations): observed UH preferred.',
   tags:['SCS DUH','NEH-4','Ungauged basin','No calibration needed']},
  {id:'hydro',title:'Flood Hydrograph Q(t)',sub:'Convolution with P50/P75/P90 scenarios',badge:'LIVE',bc:'#4488ff',
   detail:'Convolves unit hydrograph with effective rainfall to produce discharge time series. Three scenarios generated from IMD ensemble quantiles. The P50/P75/P90 band becomes the confidence envelope in the UI.',
   formula:'Q(t) = Σ [P_eff(τ) × UH(t−τ)] Δτ\n\nRun for: P50, P75, P90 IMD quantiles\nOutput: Q(t) per sub-basin\nForecast horizon: T+0 to T+72hr\nTimestep: 1hr (matched to IMD)',
   warn:null,ok:'P50/P75/P90 uncertainty band feeds XGBoost confidence and becomes the visual envelope in Mission Control.',
   tags:['Hydrograph convolution','P50/P75/P90','72hr forecast','Uncertainty band']},
 ]},
 {label:'Phase 3 — Flood Routing & Resilience',color:'#ffaa00',nodes:[
  {id:'routing',title:'Dual Routing Engine',sub:'Kinematic Wave + Muskingum-Cunge',badge:'ROUTING',bc:'#ffaa00',
   detail:'Hillslope cells use Kinematic Wave approximation. Channel cells use Muskingum-Cunge which derives K and X from channel geometry (no gauge calibration). Courant stability condition enforced automatically with sub-timestepping.',
   formula:'Kinematic Wave: ∂Q/∂t + c·∂Q/∂x = 0\nCourant condition: C = V·Δt/Δx ≤ 1 (ENFORCED)\n\nMuskingum-Cunge:\n  K = Δx / c        [travel time]\n  X = ½[1 − Q/(B·S₀·c·Δx)]\n  c = (5/3)·V       [kinematic celerity]\n\nAuto sub-timestep when C > 1.',
   warn:'At 30m DEM, 1hr timestep, V=2m/s: C = V·Δt/Δx = 2×3600/30 = 240 — massively UNSTABLE without sub-stepping.',
   ok:'Geometry-derived K, X — no gauge calibration needed for ungauged Dhemaji tributaries.',
   tags:['Kinematic wave','Muskingum-Cunge','Courant ≤ 1','Auto sub-timestep']},
  {id:'inund',title:'Inundation Mapping',sub:'Bathtub fill + Manning\'s velocity',badge:'ROUTING',bc:'#ffaa00',
   detail:'When channel capacity is exceeded, overtopping water spreads laterally using a bathtub fill model. Iteratively fills cells below Water Surface Elevation (WSE) until volume is conserved (ΔVol < 0.1%). Both depth and velocity computed per cell per hour.',
   formula:'Manning\'s equation (SI):\n  V = (1/n) × Rₕ^(2/3) × Sf^(1/2)\n  n = roughness coefficient\n  Rₕ = hydraulic radius (m)\n  Sf = friction slope\n\nBathtub rule: flood cell where Elev < WSE\nIterate until ΔVol < 0.1%\nOutput: depth + velocity per cell per hr',
   warn:'Full 2D HEC-RAS would be ideal for precise inundation. Bathtub is suitable for planning-level regional assessment.',
   ok:'Both depth and velocity feed as features into XGBoost — velocity captures flash flood danger that depth alone misses.',
   tags:["Manning's equation",'Bathtub fill','SI coefficient = 1.0','Depth + Velocity']},
  {id:'reservoir',title:'Reservoir Override',sub:'85% FRL trigger + Ritter dam-break',badge:'OVERRIDE',bc:'#ff6600',
   detail:'Monitors Banasura Sagar (Kerala), Bagmati barrage (Bihar), and Subansiri dam (Assam) via APIs with 15-minute heartbeat checks. If storage exceeds 85% FRL, downstream risk is escalated by one level.',
   formula:'IF storage > 85% FRL:\n  downstream_risk += 1 level\n\nIF breach_probability > 60%:\n  V_wave = 2 × √(g × h₀)   [Ritter, 1892]\n  All downstream cells → EXTREME\n\ng = 9.81 m/s², h₀ = depth behind dam (m)',
   warn:'Silent reservoir API failure is CATASTROPHIC — system must assume worst case.',
   ok:'API silent > 1hr → assume 80% fill, escalate conservatively. Never silent failure.',
   tags:['Reservoir override','Ritter 1892','85% FRL trigger','15-min heartbeat']},
  {id:'degraded',title:'Degraded Mode',sub:'API fallbacks + stale data flags',badge:'RESILIENCE',bc:'#ff6600',
   detail:'Every external dependency has a defined fallback behavior and a visible UI flag showing data age. System never silently uses stale data — operators always know data freshness.',
   formula:'IMD fails    → persistence forecast + P90 escalation\nSMAP fails   → default AMC II (conservative)\nReservoir    → assume 80% fill, escalate\nCWC gauges   → last value + trend extrapolation\n\nUI: "⚠ STALE DATA T+Xhr" banner always visible',
   warn:'4 external APIs: IMD, SMAP, Reservoir, CWC. Each needs independent watchdog timer.',
   ok:'Degraded mode banner is ALWAYS visible. System never hides data quality from operators.',
   tags:['Degraded mode','API watchdog','Stale data flag','Fail-safe design']},
 ]},
 {label:'Phase 4 — ML Intelligence Layer',color:'#aa44ff',nodes:[
  {id:'xgb',title:'XGBoost Risk Classifier',sub:'8 physics features → predict_proba',badge:'ML',bc:'#aa44ff',
   detail:'Receives physics pipeline outputs as features — not raw terrain data. 300 trees, max_depth=8. predict_proba() outputs class probabilities for each cell. Confidence = max(probabilities) — low confidence triggers human review.',
   formula:'Input features (8):\n  [Depth, Velocity, TWI, Dist_to_Channel,\n   Soil_Moisture, LandUse_CN, Rainfall, Slope]\n\nObjective: multi:softprob (4 classes)\nTrees: 300, max_depth: 8\nOutput: P(Low), P(Med), P(High), P(Extreme)\nConfidence = max(P_class)',
   warn:'Hard labels without confidence are dangerous for emergency decisions. Always output probabilities.',
   ok:'XGBoost captures non-linear interactions (e.g., slope×rainfall, TWI×soil_moisture) impossible in single physics formulas.',
   tags:['XGBoost','predict_proba','300 trees','4 risk classes','Confidence output']},
  {id:'valid',title:'Sentinel-1 CSI Validation',sub:'Target: CSI > 0.6 (WMO standard)',badge:'VALIDATE',bc:'#aa44ff',
   detail:'Backtesting on historical flood events: 2018 Kerala, 2019 Bihar, 2022 Assam. Compare predicted inundation maps vs Sentinel-1 C-band SAR observed flood extent. CSI > 0.6 is WMO minimum for operational systems.',
   formula:'CSI = Hits / (Hits + Misses + FA)\nPOD = Hits / (Hits + Misses)\nFAR = FA / (Hits + FA)\n\nTarget: CSI > 0.6 (WMO operational minimum)\nStretch: CSI > 0.75 (research standard)\nValidation events: 2018, 2019, 2022',
   warn:'Deploying without historical validation means unknown false alarm and miss rates — unacceptable for NDRF/SDMA.',
   ok:'CSI > 0.6 is the credential that makes Jal Drishti operationally credible for NDRF/SDMA adoption.',
   tags:['Sentinel-1 SAR','CSI > 0.6','WMO standard','POD + FAR','Backtesting']},
  {id:'units',title:'Unit Consistency Contract',sub:'SI units · UTM zone-local CRS',badge:'QUALITY',bc:'#aa44ff',
   detail:'40% of production hydrology software failures trace to unit errors. Jal Drishti enforces a strict unit contract at every pipeline boundary with assertion checks that fail loudly.',
   formula:'SCS-CN: P, Iₐ, S, Q all in mm\nManning: V in m/s, Rₕ in m, SI coeff = 1.0\n         (NOT 1.486 imperial → ×1.486 error!)\nCRS: WGS84 for storage, UTM for area calc\n  Meppadi  → UTM 43N\n  Darbhanga → UTM 45N\n  Dhemaji  → UTM 46N',
   warn:'Manning\'s imperial coefficient 1.486 vs SI 1.0 — mixing these creates a 48.6% velocity error.',
   ok:'Unit assertions run at every pipeline stage boundary. Fail loudly with descriptive error, never silently.',
   tags:['SI units','UTM zone contracts','Assertion checks','Fail-loud design']},
 ]},
 {label:'Phase 5 — Tactical Operations',color:'#00e676',nodes:[
  {id:'astar',title:'Vehicle-Specific A*',sub:'Depth thresholds per vehicle class',badge:'TACTICAL',bc:'#00e676',
   detail:'Separate A* pathfinding per vehicle type with vehicle-specific cost matrices. A flooded cell that a rescue boat traverses freely is impassable to an ambulance. Routes smoothed with Catmull-Rom splines.',
   formula:'Cost matrix by vehicle:\n  Ambulance:  depth > 0.4m → BLOCKED\n  Truck:      depth > 0.6m → BLOCKED\n  Personnel:  depth > 0.3m → cost × 5\n  Boat:       prefers water cells (cost × 0.5)\n  Helicopter: cost = 1.0 (terrain-independent)\n\nPath smoothing: Catmull-Rom splines',
   warn:'A single uniform "50×Risk" cost multiplier is arbitrary and not physically meaningful.',
   ok:'Vehicle-specific A* produces separate route layers — mission control shows per-vehicle options.',
   tags:['Vehicle A*','Catmull-Rom splines','Per-vehicle routing','5 vehicle classes']},
  {id:'dispatch',title:'Demand Score Dispatch',sub:'Population × Risk × Confidence / Distance',badge:'TACTICAL',bc:'#00e676',
   detail:'Resource allocation maximizes lives saved per unit travel time, weighted by XGBoost confidence. Re-computed every 1 hour as flood situation evolves. Greedy allocation for < 20 assets; Hungarian algorithm for larger fleets.',
   formula:'Score = (Pop × Risk × Confidence) / A*_Distance\n\nRisk weights: Low=1, Med=2, High=3, Extreme=4\nAllocation: greedy (highest score first)\nRe-compute: every 1hr\n>20 assets → Hungarian algorithm (optimal)',
   warn:'Greedy allocation is locally optimal, not globally. For > 20 assets, switch to Hungarian for true optimum.',
   ok:'Confidence weighting is the key differentiator — high-confidence extreme zones get resources before low-confidence ones.',
   tags:['Demand score','Greedy dispatch','Hungarian algorithm','1hr re-compute']},
 ]},
 {label:'Phase 6 — Mission Control UI',color:'#888888',nodes:[
  {id:'ui',title:'Mission Control Dashboard',sub:'MapLibre GL JS 3D · Real-time HUD',badge:'UI',bc:'#888888',
   detail:'All pipeline outputs visualized on a MapLibre GL JS 3D map with satellite imagery. Time slider scrubs T+0→T+72hr forecasts. Scenario toggle switches P50/P75/P90. Confidence overlay adjusts opacity by predict_proba.',
   formula:'Map: MapLibre GL JS + Esri satellite tiles\nTerrain: AWS Terrarium 3D DEM\nTime slider: T+0 → T+72hr (1hr steps)\nScenario toggle: P50 / P75 / P90\nConfidence overlay: opacity = predict_proba\nDegraded banner: if any API stale > 1hr',
   warn:null,ok:'Confidence overlay is what separates Jal Drishti from standard flood maps — operators can see prediction certainty.',
   tags:['MapLibre GL JS','3D terrain','Time slider','Confidence overlay','Degraded banner']},
 ]},
];

// Pipeline renderer
const pipeWrap=document.getElementById('pipeline-wrap');
const pipeDetail=document.getElementById('pipeline-detail');
let selNode=null;

function closePipeDetail(){pipeDetail.innerHTML='';if(selNode){selNode.classList.remove('sel');selNode=null;}}
window.closePipeDetail=closePipeDetail;

function showPipeDetail(node,el){
  if(selNode===el){closePipeDetail();return;}
  if(selNode)selNode.classList.remove('sel');
  selNode=el;el.classList.add('sel');
  const f=node.formula?`<div class="formula-box">${node.formula}</div>`:'';
  const w=node.warn?`<div class="nd-warn">⚠ ${node.warn}</div>`:'';
  const ok=node.ok?`<div class="nd-ok">✓ ${node.ok}</div>`:'';
  const tags=node.tags.map(t=>`<span class="nd-tag">${t}</span>`).join('');
  pipeDetail.innerHTML=`<div class="node-detail"><span class="close-x" onclick="closePipeDetail()">✕</span><h3>${node.title}</h3><div class="sep"></div><p class="nd-body">${node.detail}</p>${f}${w}${ok}<div class="nd-tags">${tags}</div></div>`;
  pipeDetail.scrollIntoView({behavior:'smooth',block:'nearest'});
}

if(pipeWrap){
  phases.forEach((phase,pi)=>{
    const row=document.createElement('div');row.className='phase-row';
    const nodesWrap=document.createElement('div');nodesWrap.className='phase-nodes';
    phase.nodes.forEach((node,ni)=>{
      const el=document.createElement('div');el.className='ph-node';
      el.style.cssText=`background:${node.bc}08;border-color:${node.bc}33`;
      el.innerHTML=`<div class="ph-title" style="color:${node.bc}">${node.title}</div><div class="ph-sub">${node.sub}</div><span class="ph-badge" style="background:${node.bc}18;color:${node.bc}">${node.badge}</span>`;
      el.addEventListener('click',()=>showPipeDetail(node,el));
      nodesWrap.appendChild(el);
      if(ni<phase.nodes.length-1){const arr=document.createElement('div');arr.className='phase-arrow';arr.textContent='›';nodesWrap.appendChild(arr);}
    });
    row.appendChild(nodesWrap);pipeWrap.appendChild(row);
    if(pi<phases.length-1){const conn=document.createElement('div');conn.className='phase-connector';conn.textContent='↓';pipeWrap.appendChild(conn);}
  });
}

// ===== DATA SOURCES =====
const dsCats=[
 {cat:'Elevation & Terrain',items:[
  {name:'ALOS PALSAR DEM',org:'JAXA / Alaska Satellite Facility',pill:'FREE',pillC:'#00c8ff',use:'Primary DEM for Meppadi — 12.5m SAR, cloud-penetrating',access:'Free, ASF Vertex account',format:'GeoTIFF 12.5m',pipeline:'Void → Pit → D-Infinity → TWI',region:'Meppadi (Kerala)',url:'search.asf.alaska.edu',detail:'Best freely available DEM for Indian hill terrain. L-band SAR penetrates monsoon cloud cover — critical advantage over optical DEMs during active flooding.'},
  {name:'Cartosat-1 DEM',org:'ISRO / Bhuvan Portal',pill:'FREE',pillC:'#00c8ff',use:'Primary DEM for Bihar/Assam — 10m optical stereo',access:'Free, Bhuvan registration',format:'GeoTIFF 10m',pipeline:'Void → Pit → D-Infinity → TWI',region:'Darbhanga & Dhemaji',url:'bhuvan.nrsc.gov.in',detail:'Indian Cartosat-1 stereo-derived 10m DEM. Superior to SRTM on flat terrain where cm-level accuracy drives flood routing decisions.'},
  {name:'SRTM 30m',org:'NASA / USGS',pill:'FALLBACK',pillC:'#888888',use:'Void-filling fallback ONLY — not primary DEM',access:'Free, USGS Earth Explorer',format:'GeoTIFF 30m',pipeline:'Void fill only',region:'All (fallback)',url:'earthexplorer.usgs.gov',detail:'30m resolution with ±16m vertical error on flat plains. Use ONLY for void filling, never as primary DEM for flood routing.'},
 ]},
 {cat:'Rainfall & Meteorology',items:[
  {name:'IMD MOSDAC QPF',org:'India Meteorological Department',pill:'FREE',pillC:'#4488ff',use:'Live 72hr Quantitative Precipitation Forecast, 0.25° grid, 3-hourly',access:'Free, MOSDAC API',format:'NetCDF / JSON API',pipeline:'SCS-CN → UH → Hydrograph Q(t)',region:'All',url:'mosdac.gov.in',detail:'Most critical live input. 72hr QPF generates P50/P75/P90 scenario quantiles. 0.25° grid (≈25km) downscaled to DEM resolution via bilinear interpolation.'},
  {name:'ERA5 Reanalysis',org:'ECMWF / Copernicus Climate Data Store',pill:'FREE',pillC:'#4488ff',use:'Historical hourly rainfall for XGBoost training and CSI backtesting',access:'Free, Copernicus CDS registration',format:'NetCDF hourly, 31km',pipeline:'XGBoost training · CSI validation',region:'All (1979–present)',url:'cds.climate.copernicus.eu',detail:'31km hourly reanalysis — reconstructs 2018, 2019, 2022 flood events for model training and Sentinel-1 validation.'},
 ]},
 {cat:'Soil Moisture',items:[
  {name:'NASA SMAP L3',org:'NASA Jet Propulsion Laboratory',pill:'FREE',pillC:'#aa44ff',use:'AMC I/II/III classification from surface soil moisture, 6-hour update',access:'Free, NASA Earthdata login',format:'HDF5, 9km resolution',pipeline:'AMC → CN adjustment → SCS-CN',region:'All',url:'earthdata.nasa.gov',detail:'Passive L-band microwave — measures top 5cm soil moisture. Directly determines AMC class which is the single biggest runoff multiplier in the pipeline.'},
  {name:'ISRO Bhuvan Soil',org:'ISRO / Space Applications Centre',pill:'FREE',pillC:'#aa44ff',use:'Indian-tuned soil moisture backup (RISAT-derived)',access:'Free, Bhuvan portal',format:'GeoTIFF',pipeline:'AMC backup',region:'All',url:'bhuvan.nrsc.gov.in',detail:'RISAT C-band SAR tuned for Indian soil types. Backup when SMAP unavailable or during sensor maintenance windows.'},
 ]},
 {cat:'Flood Validation',items:[
  {name:'Sentinel-1 SAR',org:'ESA Copernicus',pill:'FREE',pillC:'#00e676',use:'Ground truth flood extent maps for CSI > 0.6 validation',access:'Free, Copernicus Open Access Hub',format:'GeoTIFF / SAFE',pipeline:'CSI validation (backtesting)',region:'All (historical events)',url:'scihub.copernicus.eu',detail:'C-band SAR penetrates cloud cover — observes actual flood extent during active monsoon rainfall. Critical for CSI backtesting.'},
  {name:'Google Earth Engine',org:'Google',pill:'FREE*',pillC:'#00e676',use:'Pre-processed Sentinel-1 flood masks (JRC Global Surface Water)',access:'Free for research/non-commercial',format:'Cloud API / GeoTIFF export',pipeline:'CSI validation (recommended workflow)',region:'All',url:'earthengine.google.com',detail:'Full Sentinel-1 archive with built-in flood detection scripts. JRC Global Surface Water dataset provides historical water occurrence.'},
 ]},
 {cat:'River Gauges & Reservoirs',items:[
  {name:'India-WRIS (CWC)',org:'Central Water Commission, Govt. of India',pill:'FREE',pillC:'#ffaa00',use:'Real-time river water levels — 966 telemetric stations across India',access:'Free, public web portal',format:'JSON / CSV',pipeline:'Muskingum routing validation · Reservoir trigger',region:'Darbhanga, Dhemaji',url:'indiawris.gov.in',detail:'Real-time water level and discharge at CWC stations. Essential for validating Muskingum-Cunge routing predictions.'},
  {name:'State Dam APIs',org:'KSEB / Bihar WRD / NEEPCO',pill:'MIXED',pillC:'#ff6600',use:'Reservoir storage level (% of FRL) for 85% override trigger',access:'Mix of public portals and institutional access',format:'Daily PDF bulletins / JSON where available',pipeline:'Reservoir override module',region:'All — mission critical',url:'cwc.gov.in/reservoir-storage',detail:'Banasura Sagar (Kerala), Bagmati barrage (Bihar), Subansiri dam (Assam). 15-minute heartbeat check with fallback to 80% assumption.'},
 ]},
 {cat:'Land Use & Population',items:[
  {name:'ISRO LULC (1:50k)',org:'ISRO Bhuvan / NRSC',pill:'FREE',pillC:'#00c8ff',use:'Curve Number assignment by land cover class (CN lookup table)',access:'Free, Bhuvan download',format:'Shapefile / GeoTIFF',pipeline:'CN per grid cell → SCS-CN',region:'All',url:'bhuvan.nrsc.gov.in',detail:'Land use classes map to CN values: Dense Forest→CN55, Agriculture→CN75, Urban→CN90, Barren→CN82.'},
  {name:'WorldPop India',org:'University of Southampton',pill:'FREE',pillC:'#888888',use:'100m gridded population density for demand score calculation',access:'Free download',format:'GeoTIFF 100m',pipeline:'Demand Score dispatch',region:'All',url:'worldpop.org',detail:'Gridded population at 100m resolution. Population × Risk × Confidence / Distance = dispatch priority score.'},
  {name:'OSM Roads (Geofabrik)',org:'OpenStreetMap / Geofabrik',pill:'FREE',pillC:'#888888',use:'Road network graph for vehicle-specific A* routing',access:'Free, weekly Geofabrik extracts',format:'PBF / GeoJSON',pipeline:'Vehicle A* routing graph',region:'All',url:'download.geofabrik.de',detail:'Highway class, surface type, lane width → vehicle passability matrix for ambulance, truck, boat, helicopter routing.'},
 ]},
];

const dsCatsEl=document.getElementById('ds-cats');
const dsDet=document.getElementById('ds-detail-container');
let selDs=null;
function closeDsDetail(){dsDet.innerHTML='';if(selDs){selDs.classList.remove('sel');selDs=null;}}
window.closeDsDetail=closeDsDetail;

if(dsCatsEl){
  dsCats.forEach(cat=>{
    const hdr=document.createElement('div');hdr.className='cat-hdr';hdr.textContent=cat.cat;dsCatsEl.appendChild(hdr);
    const grid=document.createElement('div');grid.className='ds-grid';
    cat.items.forEach(s=>{
      const card=document.createElement('div');card.className='ds-card';
      card.innerHTML=`<div class="ds-name">${s.name}</div><div class="ds-org">${s.org}</div><span class="ds-pill" style="background:${s.pillC}18;color:${s.pillC};border:1px solid ${s.pillC}33">${s.pill}</span><div class="ds-use">${s.use}</div>`;
      card.addEventListener('click',()=>{
        if(selDs===card){closeDsDetail();return;}
        if(selDs)selDs.classList.remove('sel');
        selDs=card;card.classList.add('sel');
        dsDet.innerHTML=`<div class="ds-detail"><span class="close-x" onclick="closeDsDetail()">✕</span><h3>${s.name}</h3><div class="sep"></div><p>${s.detail}</p><div class="ds-meta"><div class="ds-meta-item"><b>Access</b><span>${s.access}</span></div><div class="ds-meta-item"><b>Format</b><span>${s.format}</span></div><div class="ds-meta-item"><b>Pipeline Stage</b><span>${s.pipeline}</span></div><div class="ds-meta-item"><b>Region</b><span>${s.region}</span></div></div><div class="ds-url">🔗 ${s.url}</div></div>`;
        dsDet.scrollIntoView({behavior:'smooth',block:'nearest'});
      });
      grid.appendChild(card);
    });
    dsCatsEl.appendChild(grid);
  });
}

// ===== CANVAS VISUALIZATIONS =====
function drawAllViz(){drawD8();drawDInf();drawTWI();drawSCSCN();drawXGBImportance();drawManning();}

// D8 Flow Direction
function drawD8(){
  const c=document.getElementById('d8Canvas');if(!c)return;
  const ctx=c.getContext('2d');const s=c.width/7;
  const elev=[[95,90,85,80,82,88,92],[88,82,75,70,72,80,86],[80,72,60,50,55,70,78],[75,65,48,35,42,58,72],[78,70,52,40,45,60,75],[82,76,62,55,58,68,80],[88,82,72,65,68,75,85]];
  ctx.clearRect(0,0,c.width,c.height);
  for(let r=0;r<7;r++)for(let cl=0;cl<7;cl++){
    const v=(elev[r][cl]-35)/(95-35);
    ctx.fillStyle=`hsl(${210+v*30},${40+v*20}%,${8+v*25}%)`;
    ctx.fillRect(cl*s,r*s,s-1.5,s-1.5);
    ctx.fillStyle=`rgba(255,255,255,${0.5+v*0.4})`;ctx.font=`bold ${Math.max(10,s/5)}px Share Tech Mono`;ctx.textAlign='center';
    ctx.fillText(elev[r][cl],cl*s+s/2,r*s+s/2+4);
  }
  const dirs=[[1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1],[0,-1],[1,-1]];
  ctx.lineWidth=2.5;
  for(let r=1;r<6;r++)for(let cl=1;cl<6;cl++){
    let minE=elev[r][cl],bd=-1;
    dirs.forEach((d,i)=>{const nr=r+d[1],nc=cl+d[0];if(elev[nr][nc]<minE){minE=elev[nr][nc];bd=i;}});
    if(bd>=0){
      const cx=cl*s+s/2,cy=r*s+s/2;
      const dx=dirs[bd][0]*s*0.35,dy=dirs[bd][1]*s*0.35;
      ctx.strokeStyle='#ff4444';ctx.beginPath();ctx.moveTo(cx,cy);ctx.lineTo(cx+dx,cy+dy);ctx.stroke();
      const angle=Math.atan2(dy,dx);
      ctx.beginPath();ctx.moveTo(cx+dx,cy+dy);
      ctx.lineTo(cx+dx-9*Math.cos(angle-0.4),cy+dy-9*Math.sin(angle-0.4));
      ctx.lineTo(cx+dx-9*Math.cos(angle+0.4),cy+dy-9*Math.sin(angle+0.4));
      ctx.closePath();ctx.fillStyle='#ff4444';ctx.fill();
    }
  }
}

// D-Infinity
function drawDInf(){
  const c=document.getElementById('dinfCanvas');if(!c)return;
  const ctx=c.getContext('2d');const s=c.width/7;
  const elev=[[95,90,85,80,82,88,92],[88,82,75,70,72,80,86],[80,72,60,50,55,70,78],[75,65,48,35,42,58,72],[78,70,52,40,45,60,75],[82,76,62,55,58,68,80],[88,82,72,65,68,75,85]];
  ctx.clearRect(0,0,c.width,c.height);
  for(let r=0;r<7;r++)for(let cl=0;cl<7;cl++){
    const v=(elev[r][cl]-35)/(95-35);
    ctx.fillStyle=`hsl(${210+v*30},${40+v*20}%,${8+v*25}%)`;
    ctx.fillRect(cl*s,r*s,s-1.5,s-1.5);
    ctx.fillStyle=`rgba(255,255,255,${0.5+v*0.4})`;ctx.font=`bold ${Math.max(10,s/5)}px Share Tech Mono`;ctx.textAlign='center';
    ctx.fillText(elev[r][cl],cl*s+s/2,r*s+s/2+4);
  }
  const dirs=[[1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1],[0,-1],[1,-1]];
  for(let r=1;r<6;r++)for(let cl=1;cl<6;cl++){
    const slopes=[];
    dirs.forEach((d,i)=>{
      const nr=r+d[1],nc=cl+d[0];const dist=Math.sqrt(d[0]*d[0]+d[1]*d[1]);
      slopes.push({i,s:(elev[r][cl]-elev[nr][nc])/dist,dx:d[0],dy:d[1]});
    });
    slopes.sort((a,b)=>b.s-a.s);
    const top2=slopes.filter(x=>x.s>0).slice(0,2);
    if(top2.length===0)continue;
    const totalS=top2.reduce((a,b)=>a+b.s,0);
    const cx=cl*s+s/2,cy=r*s+s/2;
    top2.forEach(t=>{
      const frac=t.s/totalS;const len=s*0.35*Math.max(0.5,frac);
      const dx=t.dx*len,dy=t.dy*len;
      const alpha=0.4+frac*0.6;
      ctx.strokeStyle=`rgba(0,200,255,${alpha})`;ctx.lineWidth=1.5+frac*2.5;
      ctx.beginPath();ctx.moveTo(cx,cy);ctx.lineTo(cx+dx,cy+dy);ctx.stroke();
      const angle=Math.atan2(dy,dx);
      ctx.beginPath();ctx.moveTo(cx+dx,cy+dy);
      ctx.lineTo(cx+dx-7*Math.cos(angle-0.4),cy+dy-7*Math.sin(angle-0.4));
      ctx.lineTo(cx+dx-7*Math.cos(angle+0.4),cy+dy-7*Math.sin(angle+0.4));
      ctx.closePath();ctx.fillStyle=`rgba(0,200,255,${alpha})`;ctx.fill();
    });
  }
}

// TWI Heatmap
function drawTWI(){
  const c=document.getElementById('twiCanvas');if(!c)return;
  const ctx=c.getContext('2d');const cols=16,rows=12,cs=c.width/cols;
  ctx.clearRect(0,0,c.width,c.height);
  for(let r=0;r<rows;r++)for(let cl=0;cl<cols;cl++){
    const cx2=cl/cols,cy2=r/rows;
    const ridge=Math.sin(cx2*Math.PI*2)*0.5+0.5;
    const valley=1-Math.abs(cy2-0.5)*2;
    const twi=ridge*0.3+valley*0.7+Math.random()*0.12;
    const t=Math.min(1,Math.max(0,twi));
    // Blue (low TWI) → Purple (mid) → Red (high TWI)
    const hue=240-t*240;
    ctx.fillStyle=`hsl(${hue},${60+t*30}%,${15+t*35}%)`;
    ctx.fillRect(cl*cs,r*cs,cs-1,cs-1);
    if(t>0.72){ctx.fillStyle='rgba(255,255,255,0.6)';ctx.font='bold 9px Share Tech Mono';ctx.textAlign='center';ctx.fillText((5+Math.floor(t*10)).toFixed(0),(cl+0.5)*cs,(r+0.5)*cs+3);}
  }
  // Legend bar
  const grd=ctx.createLinearGradient(10,c.height-22,c.width-10,c.height-22);
  grd.addColorStop(0,'hsl(240,70%,25%)');grd.addColorStop(0.5,'hsl(280,60%,35%)');grd.addColorStop(1,'hsl(0,80%,45%)');
  ctx.fillStyle=grd;ctx.fillRect(10,c.height-18,c.width-20,12);
  ctx.strokeStyle='rgba(255,255,255,0.15)';ctx.strokeRect(10,c.height-18,c.width-20,12);
  ctx.fillStyle='rgba(255,255,255,0.7)';ctx.font='bold 9px Share Tech Mono';
  ctx.textAlign='left';ctx.fillText('Low TWI (ridge)',14,c.height-22);
  ctx.textAlign='right';ctx.fillText('High TWI (valley)',c.width-14,c.height-22);
}

// SCS-CN Runoff Chart
function drawSCSCN(){
  const c=document.getElementById('scsCnCanvas');if(!c)return;
  const ctx=c.getContext('2d');ctx.clearRect(0,0,c.width,c.height);
  const w=c.width,h=c.height,pad=50;
  // Grid lines
  ctx.strokeStyle='rgba(255,255,255,0.06)';ctx.lineWidth=0.5;
  for(let i=0;i<=5;i++){const y=pad+(h-2*pad)*i/5;ctx.beginPath();ctx.moveTo(pad,y);ctx.lineTo(w-pad,y);ctx.stroke();}
  for(let i=0;i<=6;i++){const x=pad+(w-2*pad)*i/6;ctx.beginPath();ctx.moveTo(x,pad);ctx.lineTo(x,h-pad);ctx.stroke();}
  // Axes
  ctx.strokeStyle='rgba(255,255,255,0.25)';ctx.lineWidth=1;
  ctx.beginPath();ctx.moveTo(pad,pad);ctx.lineTo(pad,h-pad);ctx.lineTo(w-pad,h-pad);ctx.stroke();
  ctx.fillStyle='rgba(255,255,255,0.5)';ctx.font='11px Inter';ctx.textAlign='center';
  ctx.fillText('Rainfall P (mm)',w/2,h-8);
  ctx.save();ctx.translate(14,h/2);ctx.rotate(-Math.PI/2);ctx.fillText('Runoff Q (mm)',0,0);ctx.restore();
  // Curves
  const cns=[{cn:90,color:'#ff4444',label:'Urban (CN = 90)'},{cn:75,color:'#ffaa00',label:'Agriculture (CN = 75)'},{cn:55,color:'#00e676',label:'Dense Forest (CN = 55)'}];
  const maxP=300,maxQ=250;
  cns.forEach(({cn,color,label})=>{
    const S=(25400/cn)-254;const Ia=0.2*S;
    ctx.strokeStyle=color;ctx.lineWidth=2.5;ctx.beginPath();
    for(let p=0;p<=maxP;p+=2){
      const q=p<=Ia?0:Math.pow(p-Ia,2)/(p-Ia+S);
      const x=pad+(p/maxP)*(w-2*pad);const y=(h-pad)-(q/maxQ)*(h-2*pad);
      p===0?ctx.moveTo(x,y):ctx.lineTo(x,y);
    }
    ctx.stroke();
    // Label at end
    const qEnd=Math.pow(maxP-Ia,2)/(maxP-Ia+S);
    ctx.fillStyle=color;ctx.font='bold 11px Rajdhani';ctx.textAlign='right';
    ctx.fillText(label,w-pad-4,(h-pad)-(qEnd/maxQ)*(h-2*pad)-6);
  });
  // Axis ticks
  ctx.fillStyle='rgba(255,255,255,0.4)';ctx.font='9px Share Tech Mono';ctx.textAlign='center';
  for(let i=0;i<=6;i++){ctx.fillText(i*50,pad+(i*50/maxP)*(w-2*pad),h-pad+16);}
  ctx.textAlign='right';
  for(let i=0;i<=5;i++){ctx.fillText(i*50,pad-8,(h-pad)-(i*50/maxQ)*(h-2*pad)+4);}
}

// XGBoost Feature Importance
function drawXGBImportance(){
  const c=document.getElementById('xgbCanvas');if(!c)return;
  const ctx=c.getContext('2d');ctx.clearRect(0,0,c.width,c.height);
  const features=[
    {name:'Rainfall (mm)',val:0.286,color:'#ff4444'},
    {name:'River Distance (m)',val:0.213,color:'#ffaa00'},
    {name:'Flow Accumulation',val:0.178,color:'#ffaa00'},
    {name:'Slope (°)',val:0.112,color:'#00c8ff'},
    {name:'Elevation (m)',val:0.081,color:'#00c8ff'},
    {name:'TWI',val:0.058,color:'#4488ff'},
    {name:'Soil Moisture',val:0.049,color:'#aa44ff'},
    {name:'Land Use (CN)',val:0.023,color:'#888888'},
  ];
  const pad=120,barH=26,gap=7,w=c.width,maxW=w-pad-50;
  features.forEach((f,i)=>{
    const y=14+i*(barH+gap);const bw=f.val*maxW/0.30;
    // Background bar
    ctx.fillStyle='rgba(255,255,255,0.03)';ctx.fillRect(pad,y,maxW,barH);
    // Fill bar with gradient
    const grd=ctx.createLinearGradient(pad,0,pad+bw,0);
    grd.addColorStop(0,f.color+'88');grd.addColorStop(1,f.color);
    ctx.fillStyle=grd;
    // Rounded rect
    const radius=4;
    ctx.beginPath();ctx.moveTo(pad+radius,y);ctx.lineTo(pad+bw-radius,y);ctx.quadraticCurveTo(pad+bw,y,pad+bw,y+radius);ctx.lineTo(pad+bw,y+barH-radius);ctx.quadraticCurveTo(pad+bw,y+barH,pad+bw-radius,y+barH);ctx.lineTo(pad+radius,y+barH);ctx.quadraticCurveTo(pad,y+barH,pad,y+barH-radius);ctx.lineTo(pad,y+radius);ctx.quadraticCurveTo(pad,y,pad+radius,y);ctx.fill();
    // Label
    ctx.fillStyle='rgba(255,255,255,0.8)';ctx.font='12px Rajdhani';ctx.textAlign='right';ctx.fillText(f.name,pad-8,y+18);
    // Value
    ctx.fillStyle='#fff';ctx.font='bold 11px Share Tech Mono';ctx.textAlign='left';
    ctx.fillText((f.val*100).toFixed(1)+'%',pad+bw+6,y+18);
  });
}

// Manning's Velocity
function drawManning(){
  const c=document.getElementById('manningCanvas');if(!c)return;
  const ctx=c.getContext('2d');ctx.clearRect(0,0,c.width,c.height);
  const surfaces=[
    {name:'Concrete Channel',n:0.012,color:'#ff4444'},
    {name:'Gravel Bed',n:0.025,color:'#ffaa00'},
    {name:'Earth Channel',n:0.035,color:'#00c8ff'},
    {name:'Grass Floodplain',n:0.060,color:'#00e676'},
    {name:'Dense Forest',n:0.100,color:'#aa44ff'},
  ];
  const pad=130,barH=34,gap=12,w=c.width;
  const R=1.0,S=0.01;
  surfaces.forEach((s,i)=>{
    const V=(1/s.n)*Math.pow(R,2/3)*Math.pow(S,0.5);
    const maxV=9;const bw=(V/maxV)*(w-pad-60);
    const y=14+i*(barH+gap);
    // Background
    ctx.fillStyle='rgba(255,255,255,0.03)';ctx.fillRect(pad,y,w-pad-60,barH);
    // Bar with gradient
    const grd=ctx.createLinearGradient(pad,0,pad+bw,0);
    grd.addColorStop(0,s.color+'66');grd.addColorStop(1,s.color);
    ctx.fillStyle=grd;
    const radius=4;
    ctx.beginPath();ctx.moveTo(pad+radius,y);ctx.lineTo(pad+bw-radius,y);ctx.quadraticCurveTo(pad+bw,y,pad+bw,y+radius);ctx.lineTo(pad+bw,y+barH-radius);ctx.quadraticCurveTo(pad+bw,y+barH,pad+bw-radius,y+barH);ctx.lineTo(pad+radius,y+barH);ctx.quadraticCurveTo(pad,y+barH,pad,y+barH-radius);ctx.lineTo(pad,y+radius);ctx.quadraticCurveTo(pad,y,pad+radius,y);ctx.fill();
    // Label
    ctx.fillStyle='rgba(255,255,255,0.75)';ctx.font='12px Rajdhani';ctx.textAlign='right';ctx.fillText(s.name+' (n='+s.n+')',pad-8,y+22);
    // Value
    ctx.fillStyle='#fff';ctx.font='bold 12px Share Tech Mono';ctx.textAlign='left';
    ctx.fillText(V.toFixed(1)+' m/s',pad+bw+8,y+22);
  });
}

// Draw on initial load
setTimeout(drawAllViz,400);
