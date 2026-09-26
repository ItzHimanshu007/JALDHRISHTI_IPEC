/**
 * Jal Drishti - Weather & Time Control Panel
 * ---------------------------------------------------------------
 * Frontend-only addition. Renders:
 *   - The "CURRENT CONDITIONS" card in the left panel. It tracks
 *     whichever day + hour is selected below (defaulting to today/now
 *     on load) rather than always showing the real current moment -
 *     see updateCurrentConditionsForSelection().
 *   - The day selector + hourly timeline in the bottom panel.
 *
 * It drives the EXISTING flood simulation state (appState.currentTimeStep)
 * through the same functions the legacy scrubber already used
 * (updateTimeUI / updateMapVision), so the map/simulation integration
 * in enhanced.js is untouched.
 *
 * Data flow:
 *   loadWeatherForVillage(villageId)
 *     -> tries live Open-Meteo data for temperature/humidity/wind (same
 *        provider already used elsewhere in this app), falling back to
 *        each village's existing terrain/climate profile if it's
 *        unavailable. Rainfall (mm) always comes from
 *        generateMonsoonRainfall() regardless - a flood-simulation demo
 *        needs real heavy-rain hours to show anything on the map, which
 *        the real forecast for "today" may not happen to have.
 *     -> builds state.days[] (7 days x 24 hours: {hour, icon, rain, temp})
 *     -> renders Current Conditions, Day Selector, Hourly Timeline
 *
 *   selectDay(index) / selectHour(hour)
 *     -> update selection state
 *     -> re-render active/now states
 *     -> applySimulationForSelection() maps {village, date, hour} to the
 *        nearest existing simulation bucket (0h/4h/8h/12h/16h/20h/24h)
 *        via resolveSimulationKey() - a single seam where a future API
 *        returning real per-hour simulation grids can be wired in
 *        without touching any UI/rendering code above it. It also feeds
 *        that hour's forecast rainfall into appState.rainfallAmount (the
 *        same input the manual slider drives), so heavy-monsoon hours vs.
 *        dry hours produce a visibly different flood layer on the map.
 */

(function () {
    'use strict';

    const FORECAST_DAYS = 7;
    const SIM_BUCKETS = [0, 4, 8, 12, 16, 20, 24]; // matches TIME_STEPS in enhanced.js

    function iconForRain(mm) {
        if (mm >= 25) return '⛈️';
        if (mm >= 10) return '🌧️';
        if (mm >= 2) return '🌦️';
        if (mm > 0) return '🌤️';
        return '☀️';
    }

    // Deterministic PRNG so synthetic data stays stable within a session
    function mulberry32(seed) {
        return function () {
            seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
            let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }
    function hashString(str) {
        let h = 0;
        for (let i = 0; i < str.length; i++) { h = (h << 5) - h + str.charCodeAt(i); h |= 0; }
        return h;
    }

    function pad2(n) { return String(n).padStart(2, '0'); }
    function dateKey(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }

    const state = {
        villageId: null,
        days: [],              // [{date, dayName, dateLabel, icon, rainSum, hours:[{hour, icon, rain, temp}]}]
        selectedDayIndex: 0,
        selectedHour: 0,
        nowDate: null,
        nowHour: 0,
        current: null,         // {temp, humidity, wind, rain, icon, desc}
        bucketToSelection: {},
        isSynthetic: true
    };

    // ------------------------------------------------------------
    // Monsoon rainfall model - the single source of the mm/hr numbers
    // shown everywhere (Current Conditions, day/hour blocks) and fed into
    // the flood engine's rainfall input. Modeled as an active monsoon:
    // most days carry 1-2 heavy convective burst windows (mm/hr high
    // enough to visibly drive the flood layer) separated by moderate
    // drizzle and dry/low stretches, rather than a smooth low-amplitude
    // curve - so scrubbing through hours/days produces real, visible
    // swings in both the readout and the map.
    //
    // This runs regardless of whether live temperature/wind/humidity data
    // is available: real forecasts for the demo dates may just show a
    // calm week, which would leave the flood simulation nothing to react
    // to. Swap this function alone if a real time-indexed rainfall/
    // simulation feed should replace it later.
    // ------------------------------------------------------------
    function generateMonsoonRainfall(villageId) {
        const village = appState.data?.villages?.[villageId];
        const terrain = village?.info?.terrain_type || 'plain';

        // Ceiling for a heavy monsoon burst (mm/hr), by terrain flood-proneness
        let heavyCeiling = 22;
        if (terrain === 'hilly_ghats' || terrain === 'brahmaputra_floodplain') heavyCeiling = 55;
        else if (terrain === 'riverine_plain') heavyCeiling = 38;

        const now = new Date();
        const rand = mulberry32(hashString(villageId + dateKey(now)));
        const days = [];

        for (let d = 0; d < FORECAST_DAYS; d++) {
            const date = new Date(now);
            date.setDate(now.getDate() + d);

            // Each day gets its own character: mostly active monsoon days,
            // some moderate days, and the occasional dry break.
            const dayRoll = rand();
            const regime = dayRoll < 0.55 ? 'monsoon' : dayRoll < 0.85 ? 'moderate' : 'dry';

            // 1-2 convective burst windows placed through the day (monsoon
            // storms cluster in the afternoon/evening more often than not).
            const burstWindows = [];
            if (regime === 'monsoon') {
                const numBursts = 1 + Math.floor(rand() * 2);
                for (let b = 0; b < numBursts; b++) {
                    const start = 9 + Math.floor(rand() * 11); // 09:00-19:00
                    const len = 2 + Math.floor(rand() * 3);    // 2-4 hours
                    burstWindows.push([start, Math.min(24, start + len)]);
                }
            } else if (regime === 'moderate') {
                const start = 11 + Math.floor(rand() * 9);
                burstWindows.push([start, Math.min(24, start + 2)]);
            }

            const hours = [];
            let daySum = 0;

            for (let h = 0; h < 24; h++) {
                const inBurst = burstWindows.some(([s, e]) => h >= s && h < e);
                let mm;
                if (regime === 'monsoon' && inBurst) {
                    mm = heavyCeiling * (0.6 + rand() * 0.4);       // heavy: 60-100% of ceiling
                } else if (regime === 'monsoon') {
                    mm = heavyCeiling * (0.06 + rand() * 0.12);     // background drizzle between bursts
                } else if (regime === 'moderate' && inBurst) {
                    mm = heavyCeiling * (0.22 + rand() * 0.2);      // moderate: ~25-45% of ceiling
                } else if (regime === 'moderate') {
                    mm = heavyCeiling * rand() * 0.08;              // light/low
                } else {
                    mm = rand() < 0.75 ? 0 : heavyCeiling * rand() * 0.06; // dry, occasional trace
                }
                if (h < 5) mm *= 0.4; // storms taper off overnight

                hours.push(+Math.max(0, mm).toFixed(1));
                daySum += hours[h];
            }

            days.push({ date: dateKey(date), rainSum: +daySum.toFixed(1), hours });
        }

        return days; // [{date, rainSum, hours: number[24]}]
    }

    function descForRain(rain) {
        if (rain >= 25) return 'Heavy Thunderstorm';
        if (rain >= 10) return 'Heavy Rain';
        if (rain >= 2) return 'Rain Showers';
        if (rain > 0) return 'Light Drizzle';
        return 'Partly Cloudy';
    }

    function buildSyntheticWeather(villageId) {
        const village = appState.data?.villages?.[villageId];
        const liveDefaults = village?.stats?.live_data?.weather?.current || { temperature: 26, humidity: 75, windspeed: 10 };
        const now = new Date();
        const rainDays = generateMonsoonRainfall(villageId);

        const days = rainDays.map((rd, d) => {
            const date = new Date(now);
            date.setDate(now.getDate() + d);
            const hours = rd.hours.map((rain, h) => ({
                hour: h,
                rain,
                icon: iconForRain(rain),
                desc: descForRain(rain),
                temp: Math.round((liveDefaults.temperature || 26) + Math.sin((h / 24) * Math.PI * 2) * 3),
                // Humidity climbs and wind gusts a little during heavier bursts - monsoon realism.
                humidity: Math.min(99, Math.round((liveDefaults.humidity ?? 75) + rain * 0.6)),
                wind: Math.round((liveDefaults.windspeed ?? 10) + Math.min(15, rain * 0.3))
            }));
            return {
                date: rd.date,
                dayName: d === 0 ? 'TODAY' : date.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase(),
                dateLabel: date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
                icon: iconForRain(rd.rainSum / 24),
                rainSum: rd.rainSum,
                hours
            };
        });

        return { isSynthetic: true, days };
    }

    // ------------------------------------------------------------
    // Live data (Open-Meteo - same provider already used elsewhere
    // in this app, e.g. fetchLiveWeather()/updateSyntheticData()).
    //
    // Temperature/humidity/wind/condition come from the live forecast.
    // Rainfall (mm) is replaced with the monsoon model above rather than
    // the real forecast's precipitation numbers: a flood-simulation demo
    // needs a real chance of heavy rain to show anything on the map, and
    // the actual forecast for "today" in the real world may just be calm.
    // ------------------------------------------------------------
    async function fetchLiveWeatherGrid(lat, lon, villageId) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 6000);

        try {
            const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
                `&hourly=temperature_2m,relativehumidity_2m,windspeed_10m` +
                `&forecast_days=${FORECAST_DAYS}&timezone=auto`;

            const res = await fetch(url, { signal: controller.signal });
            if (!res.ok) throw new Error(`Weather API ${res.status}`);
            const data = await res.json();
            if (!data.hourly) throw new Error('Incomplete weather payload');

            const hourly = data.hourly;
            const rainDays = generateMonsoonRainfall(villageId);

            const days = rainDays.map((rd, d) => {
                const date = new Date(rd.date + 'T00:00:00');
                const hours = rd.hours.map((rain, h) => {
                    const idx = d * 24 + h;
                    return {
                        hour: h,
                        rain,
                        icon: iconForRain(rain),
                        desc: descForRain(rain),
                        temp: Math.round(hourly.temperature_2m?.[idx] ?? 0),
                        humidity: Math.round(hourly.relativehumidity_2m?.[idx] ?? 0),
                        wind: Math.round(hourly.windspeed_10m?.[idx] ?? 0)
                    };
                });
                return {
                    date: rd.date,
                    dayName: d === 0 ? 'TODAY' : date.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase(),
                    dateLabel: date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
                    icon: iconForRain(rd.rainSum / 24),
                    rainSum: rd.rainSum,
                    hours
                };
            });

            return { isSynthetic: false, days };
        } finally {
            clearTimeout(timeout);
        }
    }

    // ------------------------------------------------------------
    // Data abstraction seam: (village, date, hour) -> simulation bucket.
    // The flood engine currently only exposes offset buckets (0/4/8/12/
    // 16/20/24h from "now"); this is the single place that maps a
    // wall-clock selection onto one. Swap this function's body alone
    // when a real time-indexed simulation endpoint becomes available.
    // ------------------------------------------------------------
    function resolveSimulationKey(villageId, dateStr, hour) {
        const now = new Date();
        const selected = new Date(`${dateStr}T${pad2(hour)}:00:00`);
        const diffHours = Math.round((selected - now) / 3600000);
        const clamped = Math.max(0, Math.min(24, diffHours));
        let nearest = SIM_BUCKETS[0];
        let best = Infinity;
        SIM_BUCKETS.forEach(b => {
            const dist = Math.abs(b - clamped);
            if (dist < best) { best = dist; nearest = b; }
        });
        return `${nearest}h`;
    }

    // The flood engine's rainfall input (appState.rainfallAmount, 0-300) is
    // otherwise only driven by the manual slider. Mapping the selected
    // hour's forecast rain (mm/hr) onto it is what makes a heavy monsoon
    // burst vs. a dry hour actually look different on the map.
    const RAIN_TO_SLIDER_FACTOR = 5;
    function rainfallInputFor(hourData) {
        if (!hourData) return null;
        return Math.max(0, Math.min(300, Math.round(hourData.rain * RAIN_TO_SLIDER_FACTOR)));
    }

    function applySimulationForSelection() {
        const day = state.days[state.selectedDayIndex];
        if (!day || typeof appState === 'undefined' || !appState.data) return;

        const key = resolveSimulationKey(state.villageId, day.date, state.selectedHour);
        const bucketChanged = appState.currentTimeStep !== key;

        const hourData = day.hours[state.selectedHour];
        const rainTarget = rainfallInputFor(hourData);
        const rainfallChanged = rainTarget !== null && appState.rainfallAmount !== rainTarget;

        if (!bucketChanged && !rainfallChanged) return;

        if (rainfallChanged) {
            appState.rainfallAmount = rainTarget;
            const slider = document.getElementById('rainfallSlider');
            const valueEl = document.getElementById('rainfallValue');
            if (slider) slider.value = String(rainTarget);
            if (valueEl) valueEl.textContent = `${rainTarget} mm`;
            if (typeof updateSimulationImpact === 'function') updateSimulationImpact();
        }

        if (bucketChanged) {
            appState.currentTimeStep = key;
            const idx = TIME_STEPS.indexOf(key);
            if (idx >= 0 && typeof updateTimeUI === 'function') updateTimeUI(idx);
        }

        const village = appState.data.villages?.[appState.currentVillageId];
        if (village && typeof updateMapVision === 'function') updateMapVision(village);
        if (typeof startFloodAnimation === 'function') startFloodAnimation();
        // Kept for parity with the manual slider's pipeline; currently a
        // no-op fallback since the backend is not wired up (fetchFromAPI
        // always resolves null), so it's fire-and-forget here.
        if (typeof fetchFloodSimulation === 'function') fetchFloodSimulation();
    }

    // Reverse sync: called by enhanced.js when the legacy scrubber / play
    // button moves appState.currentTimeStep directly, so the hourly
    // timeline stays visually consistent with the map it's driving.
    window.syncHourlyFromSimulation = function () {
        if (typeof appState === 'undefined' || !appState.currentTimeStep) return;
        const idx = TIME_STEPS.indexOf(appState.currentTimeStep);
        if (idx < 0) return;
        const offset = SIM_BUCKETS[idx];
        const target = state.bucketToSelection[offset];
        if (!target) return;

        state.selectedDayIndex = target.dayIndex;
        state.selectedHour = target.hour;
        renderDaySelector();
        renderHourlyTimeline();
        updateCurrentConditionsForSelection();
    };

    function buildBucketMap() {
        const now = new Date();
        state.bucketToSelection = {};
        SIM_BUCKETS.forEach(offset => {
            const target = new Date(now.getTime() + offset * 3600000);
            const dIdx = state.days.findIndex(d => d.date === dateKey(target));
            if (dIdx >= 0) state.bucketToSelection[offset] = { dayIndex: dIdx, hour: target.getHours() };
        });
    }

    // ------------------------------------------------------------
    // Rendering
    // ------------------------------------------------------------
    function setText(id, val) {
        const el = document.getElementById(id);
        if (el) el.textContent = val;
    }

    function renderCurrentConditions() {
        const c = state.current;
        if (!c) return;

        setText('weatherIcon', c.icon);
        setText('weatherTemp', `${Math.round(c.temp)}°C`);
        setText('weatherDesc', c.desc);
        setText('weatherRain', c.rain.toFixed(1));
        setText('weatherHum', `${c.humidity}%`);
        setText('weatherWind', `${Math.round(c.wind)} km/h`);

        // Labels the moment being shown (e.g. "TODAY 23:00" or "MON 07:00")
        // instead of the real wall-clock time, since this card now tracks
        // whatever day/hour is selected rather than always "right now".
        const updatedEl = document.getElementById('weatherUpdatedAt');
        if (updatedEl) {
            const day = state.days[state.selectedDayIndex];
            updatedEl.textContent = day ? `${day.dayName} ${pad2(state.selectedHour)}:00` : '--:--';
        }

        const rainRow = document.getElementById('weatherRainRow');
        if (rainRow) rainRow.classList.toggle('rain-alert', c.rain >= 10);
    }

    // Pulls Current Conditions from whichever hour is currently selected
    // (falls back to synthetic data automatically, since state.days is
    // already built from the live-or-synthetic source at load time).
    function updateCurrentConditionsForSelection() {
        const day = state.days[state.selectedDayIndex];
        const hourData = day?.hours?.[state.selectedHour];
        if (!hourData) return;
        state.current = {
            temp: hourData.temp,
            humidity: hourData.humidity,
            wind: hourData.wind,
            rain: hourData.rain,
            icon: hourData.icon,
            desc: hourData.desc
        };
        renderCurrentConditions();
    }

    function renderDaySelector() {
        const container = document.getElementById('daySelector');
        if (!container) return;
        container.innerHTML = '';

        state.days.forEach((day, i) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'day-block' + (i === state.selectedDayIndex ? ' active' : '');
            btn.setAttribute('data-day-index', String(i));
            btn.innerHTML =
                `<span class="day-name">${day.dayName}</span>` +
                `<span class="day-date">${day.dateLabel}</span>` +
                `<span class="day-icon">${day.icon}</span>` +
                `<span class="day-rain">${day.rainSum}mm</span>`;
            btn.addEventListener('click', () => selectDay(i));
            container.appendChild(btn);
        });
    }

    function renderHourlyTimeline() {
        const container = document.getElementById('hourlyTimeline');
        if (!container) return;
        const day = state.days[state.selectedDayIndex];
        if (!day) return;

        container.innerHTML = '';
        let activeEl = null;

        day.hours.forEach(h => {
            const isNow = day.date === state.nowDate && h.hour === state.nowHour;
            const isActive = h.hour === state.selectedHour;

            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'hour-block' + (isActive ? ' active' : '') + (isNow ? ' is-now' : '');
            btn.setAttribute('data-hour', String(h.hour));
            btn.innerHTML =
                (isNow ? '<span class="now-tag">NOW</span>' : '') +
                `<span class="hour-label">${pad2(h.hour)}:00</span>` +
                `<span class="hour-icon">${h.icon}</span>` +
                `<span class="hour-rain">${h.rain > 0 ? h.rain.toFixed(1) + 'mm' : '--'}</span>`;
            btn.addEventListener('click', () => selectHour(h.hour));
            container.appendChild(btn);
            if (isActive) activeEl = btn;
        });

        if (activeEl) {
            // Scroll only the local .hourly-scroll container (not scrollIntoView,
            // which can bubble up and shift the whole fixed-position HUD page).
            try {
                const scrollBox = container.parentElement;
                if (scrollBox) {
                    const target = activeEl.offsetLeft - (scrollBox.clientWidth / 2) + (activeEl.offsetWidth / 2);
                    scrollBox.scrollTo({ left: Math.max(0, target), behavior: 'smooth' });
                }
            } catch (e) { /* no-op */ }
        }
    }

    // ------------------------------------------------------------
    // Selection (central state: village + date + hour)
    // ------------------------------------------------------------
    function selectDay(index) {
        if (index === state.selectedDayIndex || !state.days[index]) return;
        state.selectedDayIndex = index;
        // Hopping to today snaps the hour back to the real current hour.
        if (state.days[index].date === state.nowDate) {
            state.selectedHour = state.nowHour;
        }
        renderDaySelector();
        renderHourlyTimeline();
        updateCurrentConditionsForSelection();
        applySimulationForSelection();
    }

    function selectHour(hour) {
        if (hour === state.selectedHour) return;
        state.selectedHour = hour;
        renderHourlyTimeline();
        updateCurrentConditionsForSelection();
        applySimulationForSelection();
    }

    // ------------------------------------------------------------
    // Village load — the single entry point that (re)builds everything
    // ------------------------------------------------------------
    async function loadWeatherForVillage(villageId) {
        const village = appState.data?.villages?.[villageId];
        if (!village) return;

        const now = new Date();
        state.villageId = villageId;
        state.nowDate = dateKey(now);
        state.nowHour = now.getHours();

        let payload;
        try {
            const coords = village.info.coordinates;
            payload = await fetchLiveWeatherGrid(coords.lat, coords.lon, villageId);
        } catch (e) {
            console.warn('[WeatherPanel] Live weather unavailable, using synthetic data:', e && e.message);
            payload = buildSyntheticWeather(villageId);
        }

        // Village may have changed again while the fetch was in flight.
        if (state.villageId !== villageId) return;

        state.days = payload.days;
        state.isSynthetic = payload.isSynthetic;
        state.selectedDayIndex = 0; // TODAY is always first
        state.selectedHour = state.nowHour;

        buildBucketMap();
        updateCurrentConditionsForSelection();
        renderDaySelector();
        renderHourlyTimeline();
        applySimulationForSelection();
    }

    // ------------------------------------------------------------
    // Forecast panel toggle — button lives in the always-visible player
    // bar; toggling it shows/hides the day + hourly timeline panel above
    // with a transition (CSS handles the actual animation).
    // ------------------------------------------------------------
    function bindForecastToggle() {
        const btn = document.getElementById('forecastToggleBtn');
        const panel = document.getElementById('weatherTimePanel');
        if (!btn || !panel) return;

        btn.addEventListener('click', () => {
            const expanded = !panel.classList.contains('collapsed');
            panel.classList.toggle('collapsed', expanded);
            btn.classList.toggle('active', !expanded);
            btn.setAttribute('aria-expanded', String(!expanded));
        });
    }
    bindForecastToggle();

    // ------------------------------------------------------------
    // Map Layers focus mode - clicking any layer control (rescue path /
    // flood risk grid / population heatmap) fades out everything except
    // the Map Layers panel and the map, so the layer just activated can
    // be read against the full screen. ".focus-exit-btn" (in the Map
    // Layers panel header) brings the rest of the dashboard back.
    // Purely additive: these listeners run alongside each button's
    // existing onclick handler in enhanced.js, untouched.
    // ------------------------------------------------------------
    function bindMapLayersFocusMode() {
        const hudContainer = document.querySelector('.hud-container');
        const exitBtn = document.getElementById('exitFocusModeBtn');
        if (!hudContainer) return;

        const enterFocusMode = () => hudContainer.classList.add('focus-mode');
        const exitFocusMode = () => hudContainer.classList.remove('focus-mode');

        ['btnFindRescue', 'btnLayerRisk', 'btnLayerPopHeatmap'].forEach(id => {
            document.getElementById(id)?.addEventListener('click', enterFocusMode);
        });
        exitBtn?.addEventListener('click', exitFocusMode);
    }
    bindMapLayersFocusMode();

    // Keep the Live Forecast button's height matched to the (always-visible)
    // flood-simulation block next to it, so the two line up exactly.
    function syncForecastButtonHeight() {
        const btn = document.getElementById('forecastToggleBtn');
        const sim = document.querySelector('.simulation-meta');
        if (!btn || !sim) return;
        const h = sim.getBoundingClientRect().height;
        if (h > 0) btn.style.height = `${h}px`;
    }
    syncForecastButtonHeight();
    // Fonts/layout can settle a frame late; re-measure once after paint.
    requestAnimationFrame(syncForecastButtonHeight);
    window.addEventListener('resize', syncForecastButtonHeight);

    window.initWeatherTimePanel = function () {
        if (appState.currentVillageId) loadWeatherForVillage(appState.currentVillageId);
    };
    window.loadWeatherForVillage = loadWeatherForVillage;
})();
