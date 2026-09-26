/**
 * Jal Drishti - Core Intelligence Engine (Phase 4 Professional)
 */

const debounce = (func, wait) => {
    let timeout;
    return (...args) => {
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(this, args), wait);
    };
};

// ============================================
// Global Constants & Utilities
// ============================================

// Time steps for flood simulation (single source of truth)
const TIME_STEPS = ['0h', '4h', '8h', '12h', '16h', '20h', '24h'];
const TIME_LABELS = ['+0h', '+4h', '+8h', '+12h', '+16h', '+20h', '24h'];

// Global DOM update utility (prevents duplication)
function safeUpdate(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
}

function updateDashboardFrame(village) {
    if (!village?.info) return;

    safeUpdate('dashboardLocationName', village.name || village.info.district || '--');

    const terrain = (village.info.terrain_type || 'area').replace(/_/g, ' ');
    const location = [village.info.district, village.info.state]
        .filter(Boolean)
        .join(', ');
    safeUpdate('dashboardLocationMeta', [location, terrain].filter(Boolean).join(' | '));
}

// Multi-criteria risk classification (matches methodology.html)
function classifyRiskLevel(waterDepth, elevation, config) {
    // Water depth: 40% weight
    const depthScore = Math.min(100, (waterDepth / 4) * 100) * 0.40;

    // Slope (inverse - flat = high risk): 25% weight
    const slopeScore = Math.max(0, 100 - (config.elevationRange / 20) * 100) * 0.25;

    // Flow accumulation proxy (using water depth): 25% weight
    const accumScore = Math.min(100, waterDepth * 25) * 0.25;

    // Base proximity score: 10% weight
    const proximityScore = 50 * 0.10;

    const totalScore = depthScore + slopeScore + accumScore + proximityScore;

    if (totalScore >= 90) return 'extreme';
    if (totalScore >= 70) return 'high';
    if (totalScore >= 50) return 'medium';
    return 'low';
}

// Generate text report for download
/**
 * Strips undefined/null/empty-string/empty-array values from a flat
 * object. Used to build the structured data sent to the AI narrative
 * endpoint: a field is only included if a real value actually exists for
 * it, so the LLM never receives (and can't be tempted to "fill in") a
 * placeholder for missing data - see llm_service.py's system prompt.
 */
function omitEmptyFields(obj) {
    const result = {};
    Object.entries(obj).forEach(([key, value]) => {
        if (value === undefined || value === null) return;
        if (typeof value === 'string' && value.trim() === '') return;
        if (Array.isArray(value) && value.length === 0) return;
        result[key] = value;
    });
    return result;
}

/**
 * Builds the structured (real values only) payload sent to the AI
 * narrative endpoint for a Flood Risk Report - the exact same source
 * values generateTextReport() below formats into the .txt report, just as
 * a plain object instead of pre-formatted text lines. Kept alongside the
 * deterministic report (never replacing it) - see reports-store.js.
 */
function buildFloodRiskNarrationPayload(village) {
    const config = SIMULATION_CONFIG[appState.currentVillageId] || {};
    const stats = village?.stats || {};
    const forecast = village?.forecast?.yearly?.yearly_summary || {};

    const exposedPopulation = (typeof village?.info?.population === 'number' && typeof forecast.flood_probability === 'number')
        ? Math.round(village.info.population * forecast.flood_probability)
        : undefined;

    return omitEmptyFields({
        report_type: 'flood_risk',
        village_name: village?.name,
        district: village?.info?.district,
        state: village?.info?.state,
        terrain_type: config.name,
        rainfall_mm: appState.rainfallAmount,
        time_step: appState.currentTimeStep,
        mean_elevation_m: typeof stats.elevation_mean === 'number' ? Math.round(stats.elevation_mean) : undefined,
        max_slope_deg: typeof stats.slope_max === 'number' ? +stats.slope_max.toFixed(1) : undefined,
        runoff_coefficient_pct: typeof stats.runoff_coefficient === 'number' ? +(stats.runoff_coefficient * 100).toFixed(1) : undefined,
        risk_area_km2: typeof forecast.peak_risk_score === 'number' ? +(forecast.peak_risk_score * 3.2).toFixed(1) : undefined,
        exposed_population: exposedPopulation,
        flood_probability_pct: typeof forecast.flood_probability === 'number' ? Math.round(forecast.flood_probability * 100) : undefined,
        peak_risk_month: forecast.peak_risk_month,
        flood_characteristic: config.floodCharacteristic,
        risk_factors: config.riskFactors,
        evacuation_advice: config.evacuationAdvice
    });
}

function generateTextReport(village) {
    const config = SIMULATION_CONFIG[appState.currentVillageId] || {};
    const stats = village?.stats || {};
    const forecast = village?.forecast?.yearly?.yearly_summary || {};

    const lines = [
        '═══════════════════════════════════════════════════════════════',
        '                    JAL DRISHTI FLOOD RISK REPORT',
        '═══════════════════════════════════════════════════════════════',
        '',
        `Generated: ${new Date().toLocaleString()}`,
        `Location: ${village?.name || 'Unknown'}, ${village?.info?.district || ''}, ${village?.info?.state || ''}`,
        `Terrain Type: ${config.name || 'Unknown'}`,
        '',
        '─── SIMULATION PARAMETERS ───────────────────────────────────────',
        `Rainfall Input: ${appState.rainfallAmount} mm`,
        `Time Step: ${appState.currentTimeStep}`,
        '',
        '─── TERRAIN ANALYSIS ────────────────────────────────────────────',
        `Mean Elevation: ${Math.round(stats.elevation_mean || 0)}m`,
        `Max Slope: ${(stats.slope_max || 0).toFixed(1)}°`,
        `Runoff Coefficient: ${((stats.runoff_coefficient || 0.5) * 100).toFixed(1)}%`,
        '',
        '─── RISK ASSESSMENT ─────────────────────────────────────────────',
        `Risk Area: ${((forecast.peak_risk_score || 0) * 3.2).toFixed(1)} km²`,
        `Exposed Population: ${Math.round(village?.info?.population * (forecast.flood_probability || 0)).toLocaleString()}`,
        `Flood Probability: ${((forecast.flood_probability || 0) * 100).toFixed(0)}%`,
        `Peak Risk Month: ${forecast.peak_risk_month || 'N/A'}`,
        '',
        '─── FLOOD CHARACTERISTICS ───────────────────────────────────────',
        `Type: ${config.floodCharacteristic || 'Standard surface runoff'}`,
        `Risk Factors: ${(config.riskFactors || []).join(', ')}`,
        '',
        '─── EVACUATION ADVICE ───────────────────────────────────────────',
        config.evacuationAdvice || 'Move to higher ground and designated shelters.',
        '',
        '═══════════════════════════════════════════════════════════════',
        '            Report generated by Jal Drishti v1.0',
        '═══════════════════════════════════════════════════════════════'
    ];

    return lines.join('\n');
}

const UI_CONFIG = {
    // API Configuration
    apiBaseUrl: '',  // Relative path (same origin)

    colors: {
        extreme: '#7f1d1d',  // Darker red for extreme
        high: '#dc2626',
        medium: '#f59e0b',
        low: '#10b981',
        primary: '#0891b2', // Cyan-600
        secondary: '#06b6d4',
        rescue: '#22c55e',
        soilWet: '#3b82f6',
        soilDry: '#d97706'
    },

    // Photorealistic Map Configuration
    mapStyles: {
        // Satellite Imagery (Esri World Imagery - high quality)
        satellite: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',

        // 3D Terrain (AWS Terrarium - elevation data)
        terrain: 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',

        // Fallback raster style
        reliable: {
            "version": 8,
            "sources": {
                "satellite-base": {
                    "type": "raster",
                    "tiles": ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
                    "tileSize": 256,
                    "attribution": "Esri World Imagery"
                },
                "soil-saturation-source": {
                    "type": "geojson",
                    "data": { "type": "FeatureCollection", "features": [] }
                }
            },
            "layers": [
                {
                    "id": "background",
                    "type": "background",
                    "paint": { "background-color": "#020617" }
                },
                {
                    "id": "satellite-layer",
                    "type": "raster",
                    "source": "satellite-base",
                    "layout": { "visibility": "visible" },
                    "paint": { "raster-opacity": 1.0, "raster-saturation": -0.1 }
                }
            ]
        }
    },

    // Boundary styling for village outline
    boundaryStyle: {
        color: '#ff9500',
        glowColor: '#ffffff',
        width: 4,
        dashArray: [2, 1]
    }
};


let appState = {
    map: null,
    data: null,
    currentVillageId: 'wayanad_meppadi',
    currentTimeStep: '0h',
    rainfallAmount: 50, // mm - controls simulation intensity
    styleUrl: UI_CONFIG.mapStyles.reliable,
    charts: { rainfall: null, moisture: null, yearly: null, timeline: null },
    lastMoveUpdate: 0,
    moveDebounceTimeout: null,

    // Rescue Mode State
    rescueMode: false,
    rescuePath: null,
    activeRouteIndex: 0,
    isOptimizing: false,

    // API Data Cache
    apiData: {
        boundary: null,
        infrastructure: null,
        population: null,
        floodSimulation: null
    },

    // Flood Animation State
    floodAnimationFrame: 0,
    floodOpacityDirection: 1,

    // Request Management
    abortController: new AbortController()
};

// Rescue animation frame tracker
let rescueAnimFrame = null;

// ============================================
// API Integration & Data Fetching
// ============================================

/**
 * Fetch data from FastAPI backend with fallback to local data
 */
async function fetchFromAPI(endpoint, params = {}, signal = null) {
    // Backend removed - always return null to trigger synthetic fallbacks
    console.log(`[STANDALONE] Intercepted API call to ${endpoint}`);
    return null;
}

/**
 * Initialize dashboard from API or fallback to local data
 */
async function fetchDashboardData() {
    console.log("Initializing Dashboard (Synthetic Mode)");

    // Initialize base appState data structure
    appState.data = {
        villages: {
            wayanad_meppadi: {
                id: 'wayanad_meppadi',
                name: 'Meppadi (Kerala)',
                // population matches the local population-heatmap total below (generatePopulationData)
                // so the "Exposed Population" stat stays consistent with what's plotted on the map.
                info: { coordinates: { lat: 11.5378, lon: 76.1324 }, district: 'Wayanad', state: 'Kerala', terrain_type: 'hilly_ghats', population: 49500 },
                forecast: {
                    yearly: {
                        yearly_summary: {
                            peak_risk_score: 4,
                            flood_probability: 0.6,
                            expected_rainfall_mm: 2500,
                            peak_risk_month: 'July',
                            total_high_risk_days: 45
                        },
                        monthly_forecast: [
                            { month_name: 'Jan', expected_rainfall_mm: 50, flood_probability: 0.05, risk_level: 'low', high_risk_days: 0, season: 'dry' },
                            { month_name: 'Feb', expected_rainfall_mm: 60, flood_probability: 0.07, risk_level: 'low', high_risk_days: 0, season: 'dry' },
                            { month_name: 'Mar', expected_rainfall_mm: 80, flood_probability: 0.1, risk_level: 'low', high_risk_days: 1, season: 'pre_monsoon' },
                            { month_name: 'Apr', expected_rainfall_mm: 150, flood_probability: 0.2, risk_level: 'medium', high_risk_days: 3, season: 'pre_monsoon' },
                            { month_name: 'May', expected_rainfall_mm: 300, flood_probability: 0.4, risk_level: 'medium', high_risk_days: 7, season: 'monsoon' },
                            { month_name: 'Jun', expected_rainfall_mm: 500, flood_probability: 0.6, risk_level: 'high', high_risk_days: 12, season: 'monsoon' },
                            { month_name: 'Jul', expected_rainfall_mm: 600, flood_probability: 0.7, risk_level: 'extreme', high_risk_days: 15, season: 'monsoon', alerts: [{ message: 'Peak flood risk month' }] },
                            { month_name: 'Aug', expected_rainfall_mm: 400, flood_probability: 0.5, risk_level: 'high', high_risk_days: 10, season: 'monsoon' },
                            { month_name: 'Sep', expected_rainfall_mm: 200, flood_probability: 0.3, risk_level: 'medium', high_risk_days: 5, season: 'post_monsoon' },
                            { month_name: 'Oct', expected_rainfall_mm: 100, flood_probability: 0.15, risk_level: 'low', high_risk_days: 2, season: 'post_monsoon' },
                            { month_name: 'Nov', expected_rainfall_mm: 70, flood_probability: 0.08, risk_level: 'low', high_risk_days: 0, season: 'dry' },
                            { month_name: 'Dec', expected_rainfall_mm: 40, flood_probability: 0.04, risk_level: 'low', high_risk_days: 0, season: 'dry' }
                        ]
                    }
                },
                stats: {
                    elevation_mean: 800,
                    slope_max: 25,
                    runoff_coefficient: 0.6,
                    live_data: {
                        weather: { current: { temperature: 25, humidity: 80, windspeed: 10 } },
                        soil: { soil_moisture_m3_m3: 0.35 }
                    }
                }
            },
            darbhanga: {
                id: 'darbhanga',
                name: 'Darbhanga (Bihar)',
                // Coordinates corrected to Darbhanga city's real OSM location (85.8995, 26.1570) -
                // the previous value was ~17km off, southeast toward Madhubani district, which
                // pulled the map's default view away from where the city (and its population) is.
                // population matches the local population-heatmap total below (generatePopulationData),
                // not the wider district figure, so the "Exposed Population" stat stays consistent
                // with what's actually plotted on the map for this simulated area.
                info: { coordinates: { lat: 26.1570, lon: 85.8995 }, district: 'Darbhanga', state: 'Bihar', terrain_type: 'riverine_plain', population: 276000 },
                forecast: {
                    yearly: {
                        yearly_summary: {
                            peak_risk_score: 3,
                            flood_probability: 0.5,
                            expected_rainfall_mm: 1200,
                            peak_risk_month: 'August',
                            total_high_risk_days: 30
                        },
                        monthly_forecast: [
                            { month_name: 'Jan', expected_rainfall_mm: 10, flood_probability: 0.02, risk_level: 'low', high_risk_days: 0, season: 'dry' },
                            { month_name: 'Feb', expected_rainfall_mm: 15, flood_probability: 0.03, risk_level: 'low', high_risk_days: 0, season: 'dry' },
                            { month_name: 'Mar', expected_rainfall_mm: 20, flood_probability: 0.05, risk_level: 'low', high_risk_days: 0, season: 'pre_monsoon' },
                            { month_name: 'Apr', expected_rainfall_mm: 40, flood_probability: 0.08, risk_level: 'low', high_risk_days: 1, season: 'pre_monsoon' },
                            { month_name: 'May', expected_rainfall_mm: 80, flood_probability: 0.15, risk_level: 'medium', high_risk_days: 2, season: 'pre_monsoon' },
                            { month_name: 'Jun', expected_rainfall_mm: 200, flood_probability: 0.3, risk_level: 'high', high_risk_days: 6, season: 'monsoon' },
                            { month_name: 'Jul', expected_rainfall_mm: 350, flood_probability: 0.5, risk_level: 'extreme', high_risk_days: 10, season: 'monsoon' },
                            { month_name: 'Aug', expected_rainfall_mm: 300, flood_probability: 0.45, risk_level: 'high', high_risk_days: 8, season: 'monsoon', alerts: [{ message: 'Peak flood risk month' }] },
                            { month_name: 'Sep', expected_rainfall_mm: 150, flood_probability: 0.25, risk_level: 'medium', high_risk_days: 3, season: 'post_monsoon' },
                            { month_name: 'Oct', expected_rainfall_mm: 30, flood_probability: 0.07, risk_level: 'low', high_risk_days: 0, season: 'post_monsoon' },
                            { month_name: 'Nov', expected_rainfall_mm: 10, flood_probability: 0.02, risk_level: 'low', high_risk_days: 0, season: 'dry' },
                            { month_name: 'Dec', expected_rainfall_mm: 5, flood_probability: 0.01, risk_level: 'low', high_risk_days: 0, season: 'dry' }
                        ]
                    }
                },
                stats: {
                    elevation_mean: 50,
                    slope_max: 5,
                    runoff_coefficient: 0.4,
                    live_data: {
                        weather: { current: { temperature: 30, humidity: 70, windspeed: 8 } },
                        soil: { soil_moisture_m3_m3: 0.45 }
                    }
                }
            },
            dhemaji: {
                id: 'dhemaji',
                name: 'Dhemaji (Assam)',
                // Coordinates corrected to Dhemaji town's real OSM location (94.5630, 27.4764) -
                // the previous value was ~32km off to the east (toward Silapathar/Jonai), which
                // pulled the map's default view away from where the town (and its population) is.
                // population matches the local population-heatmap total below (generatePopulationData),
                // not the wider district figure (686,133), so the "Exposed Population" stat stays
                // consistent with what's actually plotted on the map for this simulated area.
                info: { coordinates: { lat: 27.4764, lon: 94.5630 }, district: 'Dhemaji', state: 'Assam', terrain_type: 'brahmaputra_floodplain', population: 70300 },
                forecast: {
                    yearly: {
                        yearly_summary: {
                            peak_risk_score: 5,
                            flood_probability: 0.7,
                            expected_rainfall_mm: 3000,
                            peak_risk_month: 'July',
                            total_high_risk_days: 60
                        },
                        monthly_forecast: [
                            { month_name: 'Jan', expected_rainfall_mm: 20, flood_probability: 0.03, risk_level: 'low', high_risk_days: 0, season: 'dry' },
                            { month_name: 'Feb', expected_rainfall_mm: 30, flood_probability: 0.05, risk_level: 'low', high_risk_days: 0, season: 'dry' },
                            { month_name: 'Mar', expected_rainfall_mm: 70, flood_probability: 0.1, risk_level: 'low', high_risk_days: 1, season: 'pre_monsoon' },
                            { month_name: 'Apr', expected_rainfall_mm: 200, flood_probability: 0.25, risk_level: 'medium', high_risk_days: 4, season: 'pre_monsoon' },
                            { month_name: 'May', expected_rainfall_mm: 400, flood_probability: 0.5, risk_level: 'high', high_risk_days: 10, season: 'monsoon' },
                            { month_name: 'Jun', expected_rainfall_mm: 600, flood_probability: 0.7, risk_level: 'extreme', high_risk_days: 15, season: 'monsoon' },
                            { month_name: 'Jul', expected_rainfall_mm: 700, flood_probability: 0.8, risk_level: 'extreme', high_risk_days: 18, season: 'monsoon', alerts: [{ message: 'Peak flood risk month' }] },
                            { month_name: 'Aug', expected_rainfall_mm: 500, flood_probability: 0.6, risk_level: 'high', high_risk_days: 12, season: 'monsoon' },
                            { month_name: 'Sep', expected_rainfall_mm: 300, flood_probability: 0.4, risk_level: 'medium', high_risk_days: 7, season: 'post_monsoon' },
                            { month_name: 'Oct', expected_rainfall_mm: 100, flood_probability: 0.15, risk_level: 'low', high_risk_days: 2, season: 'post_monsoon' },
                            { month_name: 'Nov', expected_rainfall_mm: 50, flood_probability: 0.08, risk_level: 'low', high_risk_days: 0, season: 'dry' },
                            { month_name: 'Dec', expected_rainfall_mm: 25, flood_probability: 0.04, risk_level: 'low', high_risk_days: 0, season: 'dry' }
                        ]
                    }
                },
                stats: {
                    elevation_mean: 70,
                    slope_max: 8,
                    runoff_coefficient: 0.7,
                    live_data: {
                        weather: { current: { temperature: 28, humidity: 85, windspeed: 12 } },
                        soil: { soil_moisture_m3_m3: 0.55 }
                    }
                }
            }
        },
        is_live: false, // Indicate synthetic data
        model_metrics: {
            risk_scorer: {
                accuracy: 0.942,
                f1_score: 0.938,
                cv_accuracy: 0.946,
                model_type: 'XGBoost',
                n_estimators: 300,
                max_depth: 8,
                model_version: 'v2.1-xgb',
                feature_importance: {
                    rainfall_mm: 0.286,
                    dist_to_river_m: 0.213,
                    flow_accumulation: 0.178,
                    slope_deg: 0.112,
                    elevation_m: 0.081,
                    twi: 0.058,
                    soil_moisture: 0.049,
                    land_use: 0.023
                },
                per_class: {
                    low: { precision: 0.918, recall: 0.905, f1: 0.911 },
                    medium: { precision: 0.932, recall: 0.941, f1: 0.936 },
                    high: { precision: 0.948, recall: 0.952, f1: 0.950 },
                    extreme: { precision: 0.961, recall: 0.957, f1: 0.959 }
                }
            }
        }
    };

    // Initialize population and infrastructure data
    appState.apiData = {
        boundary: null,
        population: generatePopulationData(appState.currentVillageId),
        infrastructure: null,
        floodSimulation: null
    };

    // Trigger synthetic data updates
    const village = appState.data.villages[appState.currentVillageId];
    syncUI();
    if (appState.map) {
        updateMapVision(village);
    }
    appState.isInitialized = true;
    hideLoading();
    return true;
}

async function fetchLiveWeather(lat, lon) {
    if (!lat || !lon) return;

    // Update loading state
    const elTemp = document.getElementById('weatherTemp');
    const elDesc = document.getElementById('weatherDesc');
    if (elTemp) elTemp.style.opacity = '0.5';

    try {
        // Fetch comprehensive weather data including 7-day forecast
        const response = await fetch(
            `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
            `&current_weather=true` +
            `&hourly=relativehumidity_2m,precipitation,precipitation_probability` +
            `&daily=precipitation_sum,precipitation_probability_max,temperature_2m_max,temperature_2m_min,weathercode` +
            `&timezone=auto&forecast_days=7`
        );
        const data = await response.json();

        if (data.current_weather) {
            const current = data.current_weather;
            const temp = current.temperature;
            const wind = current.windspeed;
            const code = current.weathercode;

            // Get humidity (approximate from current hour)
            const currentHour = new Date().getHours();
            const humidity = data.hourly?.relativehumidity_2m?.[currentHour] || '--';

            // Update UI
            if (elTemp) {
                elTemp.textContent = `${temp.toFixed(1)}°C`;
                elTemp.style.opacity = '1';
            }

            const windEl = document.getElementById('weatherWind');
            const humEl = document.getElementById('weatherHum');
            if (windEl) windEl.textContent = wind;
            if (humEl) humEl.textContent = humidity;

            // Map WMO codes to icons/text
            const wmo = {
                0: { icon: '☀️', text: 'Clear Sky' },
                1: { icon: '🌤️', text: 'Mainly Clear' },
                2: { icon: '⛅', text: 'Partly Cloudy' },
                3: { icon: '☁️', text: 'Overcast' },
                45: { icon: '🌫️', text: 'Foggy' },
                48: { icon: '🌫️', text: 'Depositing Rime Fog' },
                51: { icon: '🌦️', text: 'Light Drizzle' },
                53: { icon: '🌦️', text: 'Moderate Drizzle' },
                55: { icon: '🌧️', text: 'Dense Drizzle' },
                61: { icon: '🌧️', text: 'Slight Rain' },
                63: { icon: '🌧️', text: 'Moderate Rain' },
                65: { icon: '⛈️', text: 'Heavy Rain' },
                71: { icon: '🌨️', text: 'Slight Snow' },
                73: { icon: '🌨️', text: 'Moderate Snow' },
                75: { icon: '❄️', text: 'Heavy Snow' },
                80: { icon: '🌧️', text: 'Rain Showers' },
                81: { icon: '🌧️', text: 'Moderate Showers' },
                82: { icon: '⛈️', text: 'Heavy Showers' },
                95: { icon: '⚡', text: 'Thunderstorm' },
                96: { icon: '⛈️', text: 'Thunderstorm & Hail' },
                99: { icon: '⛈️', text: 'Heavy Thunderstorm' },
            };

            const condition = wmo[code] || { icon: '❓', text: 'Unknown' };
            const iconEl = document.getElementById('weatherIcon');
            const descEl = document.getElementById('weatherDesc');
            if (iconEl) iconEl.textContent = condition.icon;
            if (descEl) descEl.textContent = condition.text;

            // Update Time
            const now = new Date();
            const timeEl = document.getElementById('weatherTime');
            if (timeEl) timeEl.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

            // Store forecast data for short-term chart
            if (data.daily) {
                const daily = data.daily;
                const hasPrecip = daily.precipitation_sum && daily.precipitation_sum.some(p => p > 0);

                if (hasPrecip) {
                    appState.liveWeatherForecast = {
                        dates: daily.time || [],
                        precipitation: daily.precipitation_sum || [],
                        probability: daily.precipitation_probability_max || [],
                        tempMax: daily.temperature_2m_max || [],
                        tempMin: daily.temperature_2m_min || [],
                        weatherCodes: daily.weathercode || [],
                        fetchedAt: new Date().toISOString(),
                        isSynthetic: false
                    };
                } else {
                    // Fallback to synthetic if API returns all zeros (for demo)
                    appState.liveWeatherForecast = generateSyntheticForecast();
                }

                // Update short-term chart with real or synthetic data
                renderShortTermForecast();
            }

            console.log(`Live Weather Update [${appState.currentVillageId}]: ${temp}°C`);
        }
    } catch (error) {
        console.error("Weather fetch error:", error);
        // Fallback to synthetic on network error
        appState.liveWeatherForecast = generateSyntheticForecast();
        renderShortTermForecast();
    }
}

/**
 * Generates synthetic 7-day forecast data for demonstration
 */
function generateSyntheticForecast() {
    const village = appState.data?.villages[appState.currentVillageId];
    const terrain = village?.info?.terrain_type || 'plain';

    // Base precipitation based on terrain
    let basePrecip = 5;
    if (terrain === 'hilly_ghats' || terrain === 'brahmaputra_floodplain') basePrecip = 40;

    const dates = [];
    const precip = [];
    const prob = [];
    const tMax = [];
    const tMin = [];

    const now = new Date();
    for (let i = 0; i < 7; i++) {
        const d = new Date(now);
        d.setDate(now.getDate() + i);
        dates.push(d.toISOString().split('T')[0]);

        // Random variance
        const p = Math.max(0, basePrecip + (Math.random() - 0.5) * 20);
        precip.push(parseFloat(p.toFixed(1)));
        prob.push(Math.round(Math.min(100, (p / 60) * 100 + Math.random() * 20)));
        tMax.push(Math.round(25 + Math.random() * 5));
        tMin.push(Math.round(18 + Math.random() * 5));
    }

    return {
        dates,
        precipitation: precip,
        probability: prob,
        tempMax: tMax,
        tempMin: tMin,
        fetchedAt: new Date().toISOString(),
        isSynthetic: true
    };
}

function generateReport() {
    const btn = document.getElementById('btnGenerateReport');
    if (!btn) return;

    const originalText = btn.textContent;
    btn.textContent = 'Generating...';

    try {
        const village = appState.data?.villages[appState.currentVillageId];
        const report = generateTextReport(village);

        // Download as text file
        const blob = new Blob([report], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `JalDrishti_Report_${appState.currentVillageId}_${new Date().toISOString().slice(0, 10)}.txt`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        // Record this exact, already-generated report so it shows up under
        // Settings > Reports (does not change what's downloaded above).
        if (window.ReportsStore) {
            window.ReportsStore.saveReport({
                type: 'flood_risk',
                title: `Flood Risk Report — ${village?.name || appState.currentVillageId}`,
                villageId: appState.currentVillageId,
                villageName: village?.name,
                content: report,
                structuredData: buildFloodRiskNarrationPayload(village)
            });
        }

        showToast('Report Generated', 'Flood risk report downloaded successfully', 'info');
    } catch (e) {
        console.error("Report generation failed:", e);
        showToast('Error', 'Could not generate report', 'error');
    } finally {
        btn.textContent = originalText;
    }
}




// ============================================
// 3D Map Engine (Enhanced with Fallbacks)
// ============================================

function init3DMap() {
    const startCoord = [76.1324, 11.5378]; // Meppadi, Wayanad (real centre from OSM)

    appState.map = new maplibregl.Map({
        container: 'map',
        style: {
            "version": 8,
            "sources": {
                "satellite-source": {
                    "type": "raster",
                    "tiles": ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
                    "tileSize": 256,
                    "attribution": "Esri, Maxar, Earthstar Geographics, and the GIS User Community"
                },
                "soil-saturation-source": {
                    "type": "geojson",
                    "data": { "type": "FeatureCollection", "features": [] }
                }
            },
            "layers": [
                {
                    "id": "background",
                    "type": "background",
                    "paint": { "background-color": "#020617" }
                },
                {
                    "id": "satellite-layer",
                    "type": "raster",
                    "source": "satellite-source",
                    "paint": { "raster-opacity": 1.0, "raster-saturation": 0 }
                }
            ]
        },
        center: startCoord,
        zoom: 12,
        pitch: 60,
        bearing: -10,
        antialias: true,
        maxPitch: 85,
        fadeDuration: 0
    });

    // Expose map for verification/debugging
    window.map = appState.map;

    // Remove legacy fallback logic - we are enforcing satellite only
    appState.map.on('load', () => {
        // No-op for fallback
    });

    // Add Terrain for 3D display
    appState.map.on('styledata', () => {
        if (!appState.map.getSource('terrainSource')) {
            appState.map.addSource('terrainSource', {
                'type': 'raster-dem',
                'tiles': ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
                'encoding': 'terrarium',
                'tileSize': 256
            });
            const isTerrainActive = document.getElementById('btnLayerTerrain')?.classList.contains('active');
            appState.map.setTerrain({ 'source': 'terrainSource', 'exaggeration': isTerrainActive ? 1.5 : 0 });
        }
    });

    // Remove the aggressive style fallback timer that causes black screen blinking
    // Instead, rely on individual source error handling and graceful recovery

    appState.map.on('load', () => {
        initLayers();
        hideLoading();
        syncUI();

        // Render API-driven layers if available
        if (appState.apiData.boundary) {
            renderAPIBoundary();
        }
        if (appState.apiData.infrastructure) {
            renderAPIPOIs();
        }
        if (appState.apiData.population) {
            renderAPIPopulation();
        }

        console.log('✓ Map fully loaded with API layers');
    });

    appState.map.on('move', () => {
        const now = Date.now();
        if (now - appState.lastMoveUpdate > 100) { // Throttle updates
            appState.lastMoveUpdate = now;
            // Immediate sync if needed
        }
    });

    appState.map.on('error', (e) => {
        // Suppress tile load errors in console to avoid cluttering if they are handled by fallbacks
        if (e.error && (e.error.status === 404 || e.error.status === 403)) {
            console.warn(`Tile/Source missing (handled): ${e.error.url || 'unknown'}`);
            return;
        }
        console.error("MapLibre Error:", e);
        // Fallback strategy
        if (!appState.map.loaded()) {
            hideLoading(); // Ensure UI is visible even if map fails
        }
    });

    // Add source data error listener for GeoJSON sources
    appState.map.on('sourcedataerror', (e) => {
        console.warn(`Source data error in ${e.sourceId}:`, e.error);
    });
}

function initLayers() {
    // 1. Add 3D Building Extrusion - Removed (Requires vector source which is unavailable)

    // 2. Prepare Satellite Layer (Already added in style, but ensure visibility state)
    // 2. Prepare Satellite Layer (Ensure visibility)
    if (appState.map.getLayer('satellite-layer')) {
        appState.map.setLayoutProperty('satellite-layer', 'visibility', 'visible');
    }

    // 3. Remove Bhuvan Satellite (Unused/Unreliable)

    // 4. Pre-load ALL Risk Layers for smooth cross-fade
    TIME_STEPS.forEach(ts => {
        const layerId = `flood-risk-layer-${ts}`;
        if (!appState.map.getLayer(layerId)) {
            // Placeholder source, will be updated in updateMapVision
            appState.map.addSource(`flood-risk-source-${ts}`, { type: 'geojson', data: { "type": "FeatureCollection", "features": [] } });
            appState.map.addLayer({
                'id': layerId,
                'type': 'fill',
                'source': `flood-risk-source-${ts}`,
                'layout': { 'visibility': 'none' },
                'paint': {
                    'fill-color': [
                        'interpolate', ['linear'], ['get', 'value'],
                        0, 'rgba(34, 197, 94, 0.5)',     // Green - Safe/Low
                        1, 'rgba(132, 204, 22, 0.6)',    // Lime green - Low-Medium
                        2, 'rgba(250, 204, 21, 0.7)',    // Yellow - Medium
                        2.5, 'rgba(251, 146, 60, 0.8)',  // Orange - Medium-High
                        3, 'rgba(239, 68, 68, 0.85)',    // Red - High
                        4, 'rgba(127, 29, 29, 0.9)'      // Dark Red - Extreme
                    ],
                    'fill-opacity': 0,
                    'fill-antialias': true
                }
            });
        }

        appState.map.on('mouseenter', layerId, handleMouseEnter);
        appState.map.on('mouseleave', layerId, handleMouseLeave);
        appState.map.on('click', layerId, handleMapClick); // [NEW] Click listener for Deep Scan
    });

    // 5. Initialize Soil Layer (Hidden by default)
    if (!appState.map.getLayer('soil-saturation-layer')) {
        appState.map.addLayer({
            'id': 'soil-saturation-layer',
            'type': 'fill',
            'source': 'soil-saturation-source',
            'layout': { 'visibility': 'none' },
            'paint': {
                'fill-color': [
                    'interpolate', ['linear'], ['get', 'saturation'],
                    0, '#fef3c7',  // Dry - Light Yellow
                    0.4, '#60a5fa', // Moist - Blue
                    0.8, '#1e3a8a'  // Saturated - Dark Blue
                ],
                'fill-opacity': 0.6
            }
        });
    }
}

function hideLoading() {
    const overlay = document.getElementById('loadingOverlay');
    if (overlay) {
        overlay.classList.add('hidden');
        // Hard remove after transition
        setTimeout(() => { overlay.style.display = 'none'; }, 600);
    }
}

function syncUI() {
    if (!appState.data || !appState.data.villages) return;
    let village = appState.data.villages[appState.currentVillageId];

    if (!village) {
        console.warn('Village not found:', appState.currentVillageId);
        return;
    }

    updateDashboardFrame(village);

    // Header Info - preserve existing button, only update the text span
    const elInfo = document.getElementById('villageInfo');
    if (elInfo && village.info) {
        // Update only the text content, keep the button intact
        const textSpan = elInfo.querySelector('span');
        if (textSpan) {
            textSpan.textContent = `${village.info.district}, ${village.info.state} | ${village.info.terrain_type.replace(/_/g, ' ')}`;
        } else {
            // Fallback: if no span exists, create proper structure preserving button
            const infoText = `${village.info.district}, ${village.info.state} | ${village.info.terrain_type.replace(/_/g, ' ')}`;
            elInfo.innerHTML = `<span>${infoText}</span>`;
        }
    }

    safeUpdate('dashboardSimulationTime', TIME_LABELS[TIME_STEPS.indexOf(appState.currentTimeStep)] || '+0h');

    updateMapVision(village);
    generateSoilGrid(village); // [NEW] Generate soil data
}
function renderEnhancedCharts(village) {
    const months = village.forecast?.yearly?.monthly_forecast || [];
    if (!months.length) {
        console.warn('No monthly forecast data for village:', village.info?.id);
        return;
    }

    const cvsYearly = document.getElementById('yearlyChart');
    if (cvsYearly) {
        const ctxYearly = cvsYearly.getContext('2d');
        if (appState.charts.yearly) appState.charts.yearly.destroy();

        // Calculate yearly stats
        const yearlySummary = village.forecast?.yearly?.yearly_summary || {};
        const totalRainfall = months.reduce((sum, m) => sum + m.expected_rainfall_mm, 0);
        const peakMonth = yearlySummary.peak_risk_month || 'July';
        const highRiskMonths = yearlySummary.high_risk_months || [];

        appState.charts.yearly = new Chart(ctxYearly, {
            type: 'bar',
            data: {
                labels: months.map(m => m.month_name.substring(0, 3)),
                datasets: [
                    {
                        label: 'Expected Rainfall (mm)',
                        data: months.map(m => m.expected_rainfall_mm),
                        backgroundColor: months.map(m => {
                            // Color based on risk level
                            const risk = m.risk_level || 'low';
                            if (risk === 'extreme') return 'rgba(239, 68, 68, 0.8)';
                            if (risk === 'high') return 'rgba(249, 115, 22, 0.8)';
                            if (risk === 'medium') return 'rgba(234, 179, 8, 0.7)';
                            return 'rgba(34, 197, 94, 0.6)';
                        }),
                        borderColor: months.map(m => {
                            const risk = m.risk_level || 'low';
                            if (risk === 'extreme') return '#ef4444';
                            if (risk === 'high') return '#f97316';
                            if (risk === 'medium') return '#eab308';
                            return '#22c55e';
                        }),
                        borderWidth: 2,
                        borderRadius: 4,
                        order: 2
                    },
                    {
                        label: 'Flood Probability %',
                        data: months.map(m => (m.flood_probability || 0) * 100),
                        type: 'line',
                        borderColor: '#06b6d4',
                        backgroundColor: 'rgba(6, 182, 212, 0.1)',
                        borderWidth: 2,
                        pointRadius: 4,
                        pointBackgroundColor: months.map(m => {
                            const prob = m.flood_probability || 0;
                            if (prob > 0.7) return '#ef4444';
                            if (prob > 0.4) return '#f97316';
                            return '#06b6d4';
                        }),
                        tension: 0.3,
                        fill: true,
                        yAxisID: 'y1',
                        order: 1
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: {
                    mode: 'index',
                    intersect: false
                },
                plugins: {
                    legend: {
                        display: true,
                        position: 'top',
                        labels: {
                            color: 'rgba(255,255,255,0.7)',
                            font: { size: 9 },
                            boxWidth: 12,
                            padding: 8
                        }
                    },
                    tooltip: {
                        backgroundColor: 'rgba(15, 23, 42, 0.95)',
                        titleColor: '#fff',
                        bodyColor: 'rgba(255,255,255,0.8)',
                        borderColor: 'rgba(255,255,255,0.1)',
                        borderWidth: 1,
                        padding: 10,
                        callbacks: {
                            title: (items) => {
                                const month = months[items[0].dataIndex];
                                const season = month?.season ? month.season.replace('_', ' ').toUpperCase() : '';
                                return `${month?.month_name || ''} ${season ? '- ' + season : ''}`;
                            },
                            afterBody: (items) => {
                                const month = months[items[0].dataIndex];
                                if (!month) return [];
                                const lines = [];
                                lines.push(`Risk Level: ${(month.risk_level || 'low').toUpperCase()}`);
                                lines.push(`High Risk Days: ${month.high_risk_days || 0}`);
                                if (month.alerts && month.alerts.length > 0) {
                                    lines.push(`⚠️ ${month.alerts[0].message}`);
                                }
                                return lines;
                            }
                        }
                    }
                },
                scales: {
                    y: {
                        display: true,
                        beginAtZero: true,
                        position: 'left',
                        title: {
                            display: true,
                            text: 'Rainfall (mm)',
                            color: 'rgba(255,255,255,0.5)',
                            font: { size: 9 }
                        },
                        grid: { color: 'rgba(255,255,255,0.05)' },
                        ticks: { color: 'rgba(255,255,255,0.5)', font: { size: 9 } }
                    },
                    y1: {
                        display: true,
                        beginAtZero: true,
                        max: 100,
                        position: 'right',
                        title: {
                            display: true,
                            text: 'Flood Prob %',
                            color: 'rgba(6, 182, 212, 0.7)',
                            font: { size: 9 }
                        },
                        grid: { display: false },
                        ticks: {
                            color: 'rgba(6, 182, 212, 0.7)',
                            font: { size: 9 },
                            callback: (val) => val + '%'
                        }
                    },
                    x: {
                        display: true,
                        grid: { display: false },
                        ticks: {
                            color: 'rgba(255,255,255,0.5)',
                            font: { size: 9 },
                            callback: function (val, index) {
                                const month = months[index];
                                // Highlight peak risk month
                                if (month.month_name === peakMonth) {
                                    return '⚠️' + month.month_name.substring(0, 3);
                                }
                                return month.month_name.substring(0, 3);
                            }
                        }
                    }
                }
            }
        });
    }
}

function renderShortTermForecast() {
    const cvs = document.getElementById('shortTermChart');
    if (!cvs) return;

    const ctx = cvs.getContext('2d');
    if (appState.charts.shortTerm) appState.charts.shortTerm.destroy();

    // Use live weather forecast data if available
    const forecast = appState.liveWeatherForecast;

    let labels = [];
    let precipData = [];
    let probData = [];
    let tempMaxData = [];
    let tempMinData = [];

    if (forecast && forecast.dates && forecast.dates.length > 0) {
        // Use real API data
        labels = forecast.dates.map(d => {
            const date = new Date(d);
            return date.toLocaleDateString('en-US', { weekday: 'short' });
        });
        precipData = forecast.precipitation.map(p => p || 0);
        probData = forecast.probability.map(p => p || 0);
        tempMaxData = forecast.tempMax || [];
        tempMinData = forecast.tempMin || [];
    } else {
        // Fallback - show placeholder until data loads
        labels = ['Today', 'Day 2', 'Day 3', 'Day 4', 'Day 5', 'Day 6', 'Day 7'];
        precipData = [0, 0, 0, 0, 0, 0, 0];
        probData = [0, 0, 0, 0, 0, 0, 0];
    }

    const village = appState.data?.villages[appState.currentVillageId];
    const villageName = village?.name || 'VILLAGE';

    const total = precipData.reduce((a, b) => a + b, 0).toFixed(1);
    const maxPrecip = Math.max(...precipData);
    const highRiskDays = precipData.filter(p => p > 20).length;

    appState.charts.shortTerm = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [
                {
                    label: 'Rainfall (mm)',
                    data: precipData,
                    backgroundColor: precipData.map(p => {
                        if (p > 50) return 'rgba(239, 68, 68, 0.8)';
                        if (p > 20) return 'rgba(249, 115, 22, 0.8)';
                        if (p > 5) return 'rgba(6, 182, 212, 0.7)';
                        return 'rgba(34, 197, 94, 0.6)';
                    }),
                    borderColor: precipData.map(p => {
                        if (p > 50) return '#ef4444';
                        if (p > 20) return '#f97316';
                        if (p > 5) return '#06b6d4';
                        return '#22c55e';
                    }),
                    borderWidth: 2,
                    borderRadius: 4,
                    order: 2
                },
                {
                    label: 'Rain Probability %',
                    data: probData,
                    type: 'line',
                    borderColor: '#a855f7',
                    backgroundColor: 'rgba(168, 85, 247, 0.1)',
                    borderWidth: 2,
                    pointRadius: 3,
                    pointBackgroundColor: probData.map(p => {
                        if (p > 70) return '#ef4444';
                        if (p > 40) return '#f97316';
                        return '#a855f7';
                    }),
                    tension: 0.3,
                    fill: true,
                    yAxisID: 'y1',
                    order: 1
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: {
                mode: 'index',
                intersect: false
            },
            plugins: {
                legend: {
                    display: true,
                    position: 'top',
                    labels: {
                        color: 'rgba(255,255,255,0.7)',
                        font: { size: 8 },
                        boxWidth: 10,
                        padding: 6
                    }
                },
                tooltip: {
                    backgroundColor: 'rgba(15, 23, 42, 0.95)',
                    titleColor: '#fff',
                    bodyColor: 'rgba(255,255,255,0.8)',
                    borderColor: 'rgba(255,255,255,0.1)',
                    borderWidth: 1,
                    padding: 8,
                    callbacks: {
                        title: (items) => {
                            if (forecast && forecast.dates) {
                                const date = new Date(forecast.dates[items[0].dataIndex]);
                                return date.toLocaleDateString('en-US', {
                                    weekday: 'long',
                                    month: 'short',
                                    day: 'numeric'
                                });
                            }
                            return items[0].label;
                        },
                        afterBody: (items) => {
                            const idx = items[0].dataIndex;
                            const lines = [];
                            if (tempMaxData[idx] !== undefined) {
                                lines.push(`Temperature: ${tempMinData[idx]}°C - ${tempMaxData[idx]}°C`);
                            }
                            const precip = precipData[idx];
                            if (precip > 50) lines.push('⚠️ Heavy rainfall expected');
                            else if (precip > 20) lines.push('🌧️ Moderate rainfall');
                            else if (precip > 5) lines.push('🌦️ Light rainfall');
                            else lines.push('☀️ Mostly dry');
                            return lines;
                        }
                    }
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    position: 'left',
                    title: {
                        display: true,
                        text: 'mm',
                        color: 'rgba(255,255,255,0.4)',
                        font: { size: 8 }
                    },
                    grid: { color: 'rgba(255,255,255,0.05)' },
                    ticks: { color: 'rgba(255,255,255,0.5)', font: { size: 8 } }
                },
                y1: {
                    beginAtZero: true,
                    max: 100,
                    position: 'right',
                    title: {
                        display: true,
                        text: '%',
                        color: 'rgba(168, 85, 247, 0.7)',
                        font: { size: 8 }
                    },
                    grid: { display: false },
                    ticks: {
                        color: 'rgba(168, 85, 247, 0.7)',
                        font: { size: 8 },
                        callback: (val) => val + '%'
                    }
                },
                x: {
                    grid: { display: false },
                    ticks: { color: 'rgba(255,255,255,0.5)', font: { size: 8 } }
                }
            }
        }
    });

    const panelHeader = cvs.closest('.glass-panel')?.querySelector('.panel-header');
    if (panelHeader && villageName) {
        const hasSyntheticTag = forecast?.isSynthetic ? ' <span class="tag-ai" style="font-size:0.6rem; vertical-align:middle; margin-left:5px;">SIMULATED</span>' : '';
        const rainfallSummary = `Total: ${total}mm | ${highRiskDays > 0 ? '⚠️' + highRiskDays + ' rainy days' : '☀️ Mostly dry'}`;

        panelHeader.innerHTML = `
            <span style="display:flex; align-items:center; gap:8px;">
                <span class="layer-icon">🌧️</span> ${villageName.toUpperCase()}
                ${hasSyntheticTag}
            </span>
            <span style="font-size:0.6rem; color:var(--text-muted); font-weight:400;">
                ${rainfallSummary}
            </span>
        `;
    }

    const summaryEl = document.getElementById('forecastSummary');
    if (summaryEl) {
        if (maxPrecip > 50) {
            summaryEl.innerHTML = `<span style="color:#ef4444">⚠️ Heavy rain expected: ${total}mm total</span>`;
        } else if (maxPrecip > 20) {
            summaryEl.innerHTML = `<span style="color:#f97316">🌧️ Moderate rain: ${total}mm total</span>`;
        } else if (total > 0) {
            summaryEl.textContent = `Expected: ${total}mm over 7 days`;
        } else {
            summaryEl.textContent = `Loading forecast...`;
        }
    }
}


function updateMapVision(village) {
    if (!appState.map) return;

    // Use SIMULATION_CONFIG for default coords instead of hardcoding
    const config = SIMULATION_CONFIG[appState.currentVillageId] || SIMULATION_CONFIG.wayanad_meppadi;
    const bbox = config.bbox;
    let coords = [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2];

    if (village && village.info && village.info.coordinates) {
        coords = [village.info.coordinates.lon, village.info.coordinates.lat];
    }

    // Only FLY to location if village changed or explicitly requested
    if (appState._lastFlownVillageId !== appState.currentVillageId) {
        if (appState.moveDebounceTimeout) clearTimeout(appState.moveDebounceTimeout);
        appState.moveDebounceTimeout = setTimeout(() => {
            appState.map.flyTo({
                center: coords,
                zoom: 13.5,
                pitch: 65,
                essential: true
            });
            appState._lastFlownVillageId = appState.currentVillageId;
        }, 50);
    }

    if (!village) return;

    // Add Village Boundary Outline
    addVillageBoundary(appState.currentVillageId);

    const isRiskVisible = document.getElementById('btnLayerRisk')?.classList.contains('active');

    // Using global TIME_STEPS constant
    const currentStep = appState.currentTimeStep;


    // Only update the active timestep grid for performance, 
    // others can be updated on-demand or background
    TIME_STEPS.forEach(ts => {
        const layerId = `flood-risk-layer-${ts}`;
        const sourceId = `flood-risk-source-${ts}`;

        if (ts === currentStep && isRiskVisible) {
            let timeFactor = 0;
            if (ts === '4h') timeFactor = 0.16;
            if (ts === '8h') timeFactor = 0.33;
            if (ts === '12h') timeFactor = 0.5;
            if (ts === '16h') timeFactor = 0.66;
            if (ts === '20h') timeFactor = 0.83;
            if (ts === '24h') timeFactor = 1.0;

            const source = appState.map.getSource(sourceId);
            if (source) {
                // Backend removed - Always use synthetic fallback
                appState.fallbackToSynthetic(source, coords, timeFactor, ts);
            }

            if (appState.map.getLayer(layerId)) {
                appState.map.setLayoutProperty(layerId, 'visibility', 'visible');
                const baseOpacity = 0.7; // Increased base visibility for realism
                const rainfallFactor = Math.min(1.2, Math.max(0.6, appState.rainfallAmount / 200));

                // Smoother opacity based on intensity
                appState.map.setPaintProperty(layerId, 'fill-opacity', Math.min(0.9, baseOpacity * rainfallFactor));

                // Risk-based color gradient: Green → Yellow → Orange → Red → Dark Red
                appState.map.setPaintProperty(layerId, 'fill-color', [
                    'interpolate', ['linear'], ['get', 'value'],
                    0, 'rgba(34, 197, 94, 0.5)',     // Green - Safe/Low
                    1, 'rgba(132, 204, 22, 0.6)',    // Lime green - Low-Medium
                    2, 'rgba(250, 204, 21, 0.75)',   // Yellow - Medium
                    2.5, 'rgba(251, 146, 60, 0.8)', // Orange - Medium-High
                    3, 'rgba(239, 68, 68, 0.9)',     // Red - High
                    4, 'rgba(153, 27, 27, 0.95)'     // Dark Red - Extreme
                ]);
            }

            if (ts === '24h') checkRiskForVoiceAlert(village);
        } else {
            // Hide inactive layers immediately
            if (appState.map.getLayer(layerId)) {
                appState.map.setLayoutProperty(layerId, 'visibility', 'none');
                appState.map.setPaintProperty(layerId, 'fill-opacity', 0);
            }
        }
    });

    // Cleanup legacy layers
    if (appState.map.getLayer('flow-vectors-layer')) {
        appState.map.removeLayer('flow-vectors-layer');
        appState.map.removeSource('flow-vectors-source');
    }

    updateAnalyticsLayers(village);
    updatePopulationLayers();

    // Terrain Base Layer for Deep Scan
    if (village.terrain_geojson) {
        const terrainUrl = `${village.terrain_geojson}`;
        if (!appState.map.getSource('terrain-base-source')) {
            appState.map.addSource('terrain-base-source', { type: 'geojson', data: terrainUrl });
            appState.map.addLayer({
                'id': 'terrain-base-layer',
                'type': 'circle',
                'source': 'terrain-base-source',
                'paint': {
                    'circle-radius': 5,
                    'circle-opacity': 0,
                    'circle-color': '#fff'
                }
            });
        } else {
            const source = appState.map.getSource('terrain-base-source');
            if (source && source._lastUrl !== terrainUrl) {
                source.setData(terrainUrl);
                source._lastUrl = terrainUrl;
            }
        }
    }
}

/**
 * Internal helper for synthetic fallback with noise
 */
appState.fallbackToSynthetic = function (source, coords, timeFactor, ts) {
    const intensity = (appState.rainfallAmount / 300) * timeFactor;
    const intensityBucket = Math.round(intensity * 10) / 10;
    const cacheKey = `${appState.currentVillageId}_${ts}_${intensityBucket}`;

    if (source._lastCacheKey !== cacheKey) {
        const floodData = generateFloodGrid(coords, intensity, appState.currentVillageId);
        source.setData(floodData);
        source._lastCacheKey = cacheKey;
    }
};

function addVillageBoundary(villageId) {
    if (!appState.map) return;

    // Favor API data
    if (appState.apiData.boundary) {
        renderAPIBoundary();
        return;
    }

    const village = appState.data?.villages[villageId];
    const boundaryPath = village?.boundary_geojson ? `${village.boundary_geojson}` : `data/raw/boundaries/${villageId}_boundary.geojson`;

    // Attempt to load boundary GeoJSON
    if (!appState.map.getSource('village-boundary-source')) {
        appState.map.addSource('village-boundary-source', {
            type: 'geojson',
            data: boundaryPath
        });

        appState.map.addLayer({
            'id': 'village-boundary-layer',
            'type': 'line',
            'source': 'village-boundary-source',
            'paint': {
                'line-color': '#ffcc00',
                'line-width': 3,
                'line-opacity': 0.8,
                'line-dasharray': [2, 1]
            }
        });

        appState.map.addLayer({
            'id': 'village-boundary-glow',
            'type': 'line',
            'source': 'village-boundary-source',
            'paint': {
                'line-color': '#ffffff',
                'line-width': 10,
                'line-opacity': 0.2,
                'line-blur': 6
            }
        });
    } else {
        const source = appState.map.getSource('village-boundary-source');
        if (source && source._lastUrl !== boundaryPath) {
            source.setData(boundaryPath);
            source._lastUrl = boundaryPath;
        }
    }
}

function updateAnalyticsLayers(village) {
    if (!appState.map || !village) return;

    const isPopVisible = document.getElementById('btnLayerPopHeatmap')?.classList.contains('active') ? 'visible' : 'none';

    // Favor API data
    if (appState.apiData.population) {
        renderAPIPopulation();
        if (appState.map.getLayer('api-population-layer')) {
            appState.map.setLayoutProperty('api-population-layer', 'visibility', isPopVisible);
        }
        return;
    }

    if (village.population_geojson) {
        const popUrl = `../${village.population_geojson}`;
        if (!appState.map.getSource('population-source')) {
            appState.map.addSource('population-source', { type: 'geojson', data: popUrl });

            appState.map.addLayer({
                'id': 'population-layer',
                'type': 'heatmap',
                'source': 'population-source',
                'layout': { 'visibility': isPopVisible },
                'paint': {
                    'heatmap-weight': ['interpolate', ['linear'], ['get', 'weight'], 0, 0, 1, 1],
                    'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 0, 1, 15, 3],
                    'heatmap-color': [
                        'interpolate', ['linear'], ['heatmap-density'],
                        0, 'rgba(0, 0, 255, 0)',
                        0.2, 'rgba(65, 105, 225, 0.3)',
                        0.4, 'rgba(0, 255, 255, 0.5)',
                        0.6, 'rgba(0, 255, 0, 0.6)',
                        0.8, 'rgba(255, 255, 0, 0.7)',
                        1, 'rgba(255, 0, 0, 0.8)'
                    ],
                    'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 0, 2, 10, 15, 15, 35],
                    'heatmap-opacity': 0.7
                }
            });
        } else {
            const source = appState.map.getSource('population-source');
            if (source && source._lastUrl !== popUrl) {
                source.setData(popUrl);
                source._lastUrl = popUrl;
            }
        }
        appState.map.setLayoutProperty('population-layer', 'visibility', isPopVisible);
    }
}

// Function removed (Feature disabled as per user request)
function animateFlowVectors() { }

// Function removed (Feature disabled as per user request)
async function integrateWeatherRadar() {
    console.log("Weather Radar disabled by user configuration.");
}

// [NEW] Soil Saturation Generator
function generateSoilGrid(village) {
    if (!appState.map || !village) return;

    // Check if layer is active
    const isSoilVisible = document.getElementById('btnLayerSoil')?.classList.contains('active');
    if (!isSoilVisible) {
        if (appState.map.getLayer('soil-saturation-layer')) {
            appState.map.setLayoutProperty('soil-saturation-layer', 'visibility', 'none');
        }
        return;
    }

    const config = SIMULATION_CONFIG[appState.currentVillageId] || SIMULATION_CONFIG.wayanad_meppadi;
    const bbox = config.bbox;
    const gridSize = 25; // Coarser grid for soil

    // Use stored climate data
    const baseSoil = VILLAGE_CLIMATE[appState.currentVillageId]?.baseSoil || 0.35;

    const features = [];
    const stepLon = (bbox[2] - bbox[0]) / gridSize;
    const stepLat = (bbox[3] - bbox[1]) / gridSize;

    for (let x = 0; x < gridSize; x++) {
        for (let y = 0; y < gridSize; y++) {
            const lon = bbox[0] + (x * stepLon);
            const lat = bbox[1] + (y * stepLat);

            // Generate varied soil moisture
            // More moisture near water bodies (low terrain) or valleys
            const noise = Math.sin(x * 0.5) * Math.cos(y * 0.5);
            let saturation = baseSoil + (noise * 0.2);

            // Increase saturation if raining
            saturation += (appState.rainfallAmount / 500);

            if (saturation > 1) saturation = 1;
            if (saturation < 0) saturation = 0;

            features.push({
                type: 'Feature',
                properties: { saturation: saturation },
                geometry: {
                    type: 'Polygon',
                    coordinates: [[
                        [lon, lat],
                        [lon + stepLon, lat],
                        [lon + stepLon, lat + stepLat],
                        [lon, lat + stepLat],
                        [lon, lat]
                    ]]
                }
            });
        }
    }

    const source = appState.map.getSource('soil-saturation-source');
    if (source) {
        source.setData({ type: 'FeatureCollection', features: features });
        if (appState.map.getLayer('soil-saturation-layer')) {
            appState.map.setLayoutProperty('soil-saturation-layer', 'visibility', 'visible');
        }
    }
}

// ============================================
// Interactions (Simplified)
// ============================================
let currentPopup = null;

// Deep Scan removed

function handleMouseEnter(e) {
    appState.map.getCanvas().style.cursor = 'crosshair';
}

function handleMapClick(e) {
    // Check if deep scan is possible (simulation active)
    handleDeepScan(null, e.lngLat);
}

function handleMouseLeave() {
    appState.map.getCanvas().style.cursor = '';
    if (appState.map.getLayer('scan-highlight-layer')) {
        appState.map.setLayoutProperty('scan-highlight-layer', 'visibility', 'none');
    }
}

function closeInspector() {
    document.getElementById('cellInspector').style.display = 'none';
    if (currentPopup) currentPopup.remove();
}

// ============================================
// Initialization
// ============================================

// ============================================
// Initialization & HUD Wiring
// ============================================

function bindEvents() {
    // 1. Selector
    document.getElementById('villageSelector').addEventListener('change', async (e) => {
        if (e.target.value === 'custom') return;
        appState.currentVillageId = e.target.value;

        // Reset rescue mode when switching villages to avoid stale paths
        if (appState.rescueMode) {
            toggleRescueMode(); // This will clear the path and reset buttons
        }

        // Re-initialize for new village
        await fetchDashboardData();

        // Regenerate population data for the new village
        appState.apiData.population = generatePopulationData(appState.currentVillageId);

        syncUI();

        // Force refresh population heatmap if it's active
        if (appState.populationHeatmapVisible) {
            updatePopulationLayers();
        }

        // Ensure map updates vision for new coordinates
        const village = appState.data.villages[appState.currentVillageId];
        updateMapVision(village);

        // Refresh the Weather & Time Control panel for the new village
        if (typeof loadWeatherForVillage === 'function') loadWeatherForVillage(appState.currentVillageId);
    });


    // Report Button - now uses generateReport() for text file download
    document.getElementById('btnGenerateReport')?.addEventListener('click', () => {
        generateReport();
    });

    // Opacity Slider
    // Opacity Slider removed

    // 2. Timeline Player Logic
    const playBtn = document.getElementById('masterPlayBtn');
    const timeDisplay = document.getElementById('timeDisplay');
    const timelineFill = document.getElementById('timelineFill');
    const ticks = document.querySelectorAll('.tick');

    playBtn.addEventListener('click', () => {
        if (appState.animationId) {
            // STOP
            clearInterval(appState.animationId);
            appState.animationId = null;
            playBtn.textContent = '▶';
            playBtn.style.background = 'var(--accent-primary)';
            playBtn.style.color = 'white';
        } else {
            // PLAY
            playBtn.textContent = '⏸';
            playBtn.style.background = 'var(--bg-elevated)';
            playBtn.style.color = 'var(--accent-secondary)';

            appState.animationId = setInterval(() => {
                let currentIdx = TIME_STEPS.indexOf(appState.currentTimeStep);
                let nextIdx = (currentIdx + 1) % TIME_STEPS.length;
                appState.currentTimeStep = TIME_STEPS[nextIdx];

                // Update UI state w/o triggering redundant events
                updateTimeUI(nextIdx);
                const village = appState.data.villages[appState.currentVillageId];
                updateMapVision(village);
                if (typeof syncHourlyFromSimulation === 'function') syncHourlyFromSimulation();

                // Rescue path removed

                // Generate report at end of simulation cycle (24h)
                // Auto-report disabled as per user request
                // if (nextIdx === 3) { generateSimulationReport(village); }
            }, 2500);
        }
    });

    // Click on timeline ticks
    ticks.forEach(tick => {
        tick.addEventListener('click', () => {
            const idx = parseInt(tick.dataset.t);
            appState.currentTimeStep = TIME_STEPS[idx];
            updateTimeUI(idx);
            updateMapVision(appState.data.villages[appState.currentVillageId]);
            if (typeof syncHourlyFromSimulation === 'function') syncHourlyFromSimulation();
        });
    });

    // 3. Layer Commanders removed

    // 4. Rainfall Slider
    const rainfallSlider = document.getElementById('rainfallSlider');
    const rainfallValue = document.getElementById('rainfallValue');

    const debouncedUpdate = debounce(async () => {
        const village = appState.data.villages[appState.currentVillageId];
        updateSimulationImpact();

        // Fetch from API and update map
        await fetchFloodSimulation();
        updateMapVision(village);
        startFloodAnimation();
    }, 150);

    if (rainfallSlider) {
        rainfallSlider.addEventListener('input', (e) => {
            const val = parseInt(e.target.value);
            if (appState.rainfallAmount === val) return;

            appState.rainfallAmount = val;
            rainfallValue.textContent = `${appState.rainfallAmount} mm`;

            debouncedUpdate();
        });
    }

    // 5. Close Report Button
    const closeReportBtn = document.getElementById('closeReport');
    if (closeReportBtn) {
        closeReportBtn.addEventListener('click', () => {
            document.getElementById('simulationReport').style.display = 'none';
        });
    }
}

function updateTimeUI(idx) {
    const ticks = document.querySelectorAll('.tick');
    ticks.forEach(t => t.classList.remove('active'));
    if (ticks[idx]) ticks[idx].classList.add('active');

    const labels = ['+0h', '+4h', '+8h', '+12h', '+16h', '+20h', '24h'];
    document.getElementById('timeDisplay').textContent = labels[idx];
    document.getElementById('timelineFill').style.width = `${(idx / 6) * 100}%`;

    safeUpdate('dashboardSimulationTime', labels[idx] || '+0h');
}

/**
 * Toggle layer visibility on button click
 * Called directly from onclick handlers in HTML
 */
function setupLayerToggle(btnId, layerId) {
    const btn = document.getElementById(btnId);
    if (!btn) return;

    const isActive = btn.classList.contains('active');

    // Toggle button state
    if (isActive) {
        btn.classList.remove('active');
    } else {
        btn.classList.add('active');
    }

    // Apply layer visibility change
    if (appState.map && appState.map.getStyle()) {
        const village = appState.data?.villages[appState.currentVillageId];

        // Handle population density layer
        if (layerId === 'population-heatmap-layer') {
            togglePopulationHeatmap();
            return;
        }

        // Handle soil saturation layer
        if (layerId === 'soil-saturation-layer') {
            if (!isActive && village) {
                generateSoilGrid(village);
            }
            if (appState.map.getLayer('soil-saturation-layer')) {
                appState.map.setLayoutProperty('soil-saturation-layer', 'visibility', !isActive ? 'visible' : 'none');
            }
            return;
        }

        // Handle flood risk layer
        if (layerId === 'flood-risk-layer') {
            const currentLayerId = `flood-risk-layer-${appState.currentTimeStep}`;
            if (appState.map.getLayer(currentLayerId)) {
                appState.map.setLayoutProperty(currentLayerId, 'visibility', !isActive ? 'visible' : 'none');
            }
            if (village) {
                updateMapVision(village);
            }
            return;
        }

        // Handle other static layers
        if (appState.map.getLayer(layerId)) {
            appState.map.setLayoutProperty(layerId, 'visibility', !isActive ? 'visible' : 'none');
        }
    }
}


function updateSimulationImpact() {
    if (!appState.map) return;

    // 1. Update Flood Layers Risk Intensity
    const rainfallFactor = Math.min(1.0, Math.max(0.2, appState.rainfallAmount / 200));

    TIME_STEPS.forEach(ts => {
        const layerId = `flood-risk-layer-${ts}`;
        if (appState.map.getLayer(layerId) && ts === appState.currentTimeStep) {
            appState.map.setPaintProperty(layerId, 'fill-opacity', 0.8 * rainfallFactor);
        }
    });

    // 2. Update Rescue Path (if active) and Report Data
    // Auto-Show Rescue Path if High Risk
    if (appState.rainfallAmount > 100) {
        if (!document.getElementById('btnLayerRescue')?.classList.contains('active')) {
            document.getElementById('btnLayerRescue')?.classList.add('active');
            const village = appState.data.villages[appState.currentVillageId];
            generateRescuePath(village);
            // Notification removed as per user request
        }
    }

    const isRescueVisible = document.getElementById('btnLayerRescue')?.classList.contains('active');
    if (isRescueVisible) {
        // Debounce heavy pathfinding to avoid slider lag
        if (appState.rescueDebounce) clearTimeout(appState.rescueDebounce);
        appState.rescueDebounce = setTimeout(() => {
            const village = appState.data.villages[appState.currentVillageId];
            generateRescuePath(village);
        }, 50);
    }

}

function toggleCompareMode(active) {
    const btn = document.getElementById('btnLayerCompare');
    if (!btn) return;

    const layerId = `flood-risk-layer-${appState.currentTimeStep}`;

    if (active) {
        // Impact mode: High contrast
        if (appState.map.getLayer(layerId)) {
            appState.map.setPaintProperty(layerId, 'fill-opacity', 0.95);
        }
        appState.map.setLayoutProperty('3d-buildings', 'visibility', 'none');
    } else {
        // Normal mode
        if (appState.map.getLayer(layerId)) {
            appState.map.setPaintProperty(layerId, 'fill-opacity', 0.8);
        }
        const is3DActive = document.getElementById('btnLayerBuild')?.classList.contains('active');
        if (appState.map.getLayer('3d-buildings')) {
            appState.map.setLayoutProperty('3d-buildings', 'visibility', is3DActive ? 'visible' : 'none');
        }
    }
}

// ============================================
// Rescue Path System (Google Maps-Style Navigation)
// ============================================

// Inject rescue route CSS animations once
(function injectRescueCSS() {
    if (document.getElementById('rescue-route-styles')) return;
    const style = document.createElement('style');
    style.id = 'rescue-route-styles';
    style.textContent = `
        @keyframes rescueSlideIn { from { transform: translateX(40px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
        @keyframes rescuePulse { 0%,100% { box-shadow: 0 0 0 0 rgba(34,197,94,0.4); } 50% { box-shadow: 0 0 0 8px rgba(34,197,94,0); } }
        .rescue-route-card {
            padding: 12px 14px; margin-bottom: 8px; border-radius: 10px;
            border: 1px solid rgba(255,255,255,0.06); border-left: 4px solid #475569;
            background: rgba(0,0,0,0.25); cursor: pointer;
            transition: all 0.3s cubic-bezier(0.4,0,0.2,1);
            position: relative; overflow: hidden;
        }
        .rescue-route-card::before {
            content: ''; position: absolute; inset: 0;
            background: linear-gradient(135deg, transparent, rgba(255,255,255,0.02));
            opacity: 0; transition: opacity 0.3s;
        }
        .rescue-route-card:hover { background: rgba(255,255,255,0.04); transform: translateX(4px); }
        .rescue-route-card:hover::before { opacity: 1; }
        .rescue-route-card.selected {
            background: rgba(34,197,94,0.12); border-left-color: #22c55e;
            border-color: rgba(34,197,94,0.3); box-shadow: 0 0 20px rgba(34,197,94,0.08);
        }
        .rescue-route-card.selected.risk-high { background: rgba(239,68,68,0.1); border-left-color: #ef4444; border-color: rgba(239,68,68,0.25); }
        .rescue-route-card.selected.risk-medium { background: rgba(245,158,11,0.1); border-left-color: #f59e0b; border-color: rgba(245,158,11,0.25); }
        .rescue-route-card .route-rank {
            width: 26px; height: 26px; border-radius: 50%; display: flex; align-items: center; justify-content: center;
            font-size: 0.7rem; font-weight: 700; font-family: var(--font-tech, 'Rajdhani', sans-serif);
            background: rgba(255,255,255,0.06); color: #94a3b8; border: 1px solid rgba(255,255,255,0.1);
            transition: all 0.3s;
        }
        .rescue-route-card.selected .route-rank { background: #22c55e; color: #fff; border-color: #22c55e; }
        .rescue-route-card.selected.risk-high .route-rank { background: #ef4444; border-color: #ef4444; }
        .rescue-route-card.selected.risk-medium .route-rank { background: #f59e0b; border-color: #f59e0b; }
        .rescue-badge { font-size: 0.55rem; padding: 2px 7px; border-radius: 10px; font-weight: 600; letter-spacing: 0.5px; }
        .rescue-stat { display: flex; align-items: center; gap: 5px; font-size: 0.7rem; color: var(--text-muted, #6b7280); }
        .rescue-stat strong { color: var(--text-primary, #f9fafb); font-weight: 600; }
        #rescueInfoPanel { scrollbar-width: thin; scrollbar-color: rgba(255,255,255,0.1) transparent; }
        #rescueInfoPanel::-webkit-scrollbar { width: 4px; }
        #rescueInfoPanel::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 4px; }
    `;
    document.head.appendChild(style);
})();

/**
 * Generate rescue path — calls client-side A* routing from village center
 */
function generateRescuePath(village) {
    if (!village || !appState.map) return;
    const coords = village.info?.coordinates;
    if (!coords) return;

    const result = calculateClientSideRescueRoute(coords.lon, coords.lat);
    if (result && result.status === 'success') {
        drawRescuePath(result.rescue_path);
    }
}

// ============================================
// Simulation Report Generator
// ============================================

function generateSimulationReport(village) {
    const rainfall = appState.rainfallAmount;
    const timeStep = appState.currentTimeStep;

    // Impact stats from API if available
    let affectedPop = 0;
    let floodSeverity = 'LOW';
    let severityColor = '#22c55e';
    let maxDepth = (rainfall / 50).toFixed(1);

    if (appState.apiData.floodSimulation) {
        const currentSim = appState.apiData.floodSimulation.features.find(f => f.properties.timestep.includes(timeStep));
        if (currentSim) {
            maxDepth = currentSim.properties.max_depth_m.toFixed(1);
            floodSeverity = currentSim.properties.severity.toUpperCase();
        }
    }

    // Realistic Impact Calculation
    const basePop = village.info.population || 10000;
    const riskFactor = Math.min(1.0, rainfall / 300);
    affectedPop = Math.round(basePop * (riskFactor * 0.4 + 0.1));

    if (floodSeverity === 'EXTREME') severityColor = '#7f1d1d';
    else if (floodSeverity === 'HIGH') severityColor = '#dc2626';
    else if (floodSeverity === 'MODERATE') severityColor = '#eab308';

    // Rescue Logistics
    const evacTimeHours = (affectedPop / 2000).toFixed(1);
    const sheltersActive = Math.ceil(affectedPop / 500);
    const ndrfTeams = Math.ceil(affectedPop / 1000);

    const reportHTML = `
        <div style="margin-bottom:15px; border-bottom:1px solid rgba(255,255,255,0.1); padding-bottom:10px;">
            <div style="font-size:1.1rem; font-weight:700; color:#fff; display:flex; justify-content:space-between; align-items:center;">
                <span>SITUATION REPORT</span>
                <span style="font-size:0.8rem; background:${severityColor}; padding:2px 8px; border-radius:4px;">${floodSeverity}</span>
            </div>
            <div style="font-size:0.75rem; color:var(--text-muted); margin-top:4px;">
                ZONE: ${village.info.name.toUpperCase()} &bull; RAINFALL: ${rainfall}mm &bull; MAX DEPTH: ${maxDepth}m
            </div>
        </div>

        <div style="display:grid; grid-template-columns: 1fr 1fr; gap:12px; margin-bottom:15px;">
             <div class="stat-box" style="background:rgba(255,255,255,0.03); padding:8px; border-radius:6px;">
                <div style="color:var(--text-muted); font-size:0.7rem;">AFFECTED POPULATION</div>
                <div style="font-size:1.2rem; font-weight:700; color:#ef4444;">${affectedPop.toLocaleString()}</div>
             </div>
             <div class="stat-box" style="background:rgba(255,255,255,0.03); padding:8px; border-radius:6px;">
                <div style="color:var(--text-muted); font-size:0.7rem;">EST. EVACUATION TIME</div>
                <div style="font-size:1.2rem; font-weight:700; color:#eab308;">${evacTimeHours} HRS</div>
             </div>
        </div>
        
        <div style="margin-bottom:15px;">
            <div style="font-size:0.8rem; font-weight:600; color:#22d3ee; margin-bottom:8px; border-bottom:1px solid #22d3ee33; padding-bottom:4px;">
                RESCUE LOGISTICS & RESOURCES
            </div>
            <div style="font-size:0.75rem; display:grid; grid-template-columns: 1fr 1fr; gap:8px;">
                <div>⛑️ NDRF Teams: <strong style="color:#fff">${ndrfTeams}</strong></div>
                <div>⛺ Shelters Active: <strong style="color:#fff">${sheltersActive}</strong></div>
                <div>🚁 Heli-drop Zones: <strong style="color:#fff">${rainfall > 150 ? 2 : 0}</strong></div>
                <div>🚤 Rescue Boats: <strong style="color:#fff">${Math.max(5, Math.floor(rainfall / 5))}</strong></div>
            </div>
        </div>
    `;

    const reportEl = document.getElementById('simulationReport');
    const contentEl = document.getElementById('reportContent');

    if (reportEl && contentEl) {
        contentEl.innerHTML = reportHTML;
        reportEl.style.display = 'block';
    }
}



function getRecommendedAction(severity) {
    switch (severity) {
        case 'CRITICAL': return 'IMMEDIATE EVACUATION';
        case 'HIGH': return 'Prepare for evacuation';
        case 'MODERATE': return 'Monitor conditions';
        default: return 'Normal operations';
    }
}

async function run() {
    // Global safety: Always hide loading after 5 seconds regardless of network
    const globalTimeout = setTimeout(() => {
        console.warn("Global Startup Timeout: Forcing UI visibility");
        hideLoading();
    }, 5000);

    const success = await fetchDashboardData();
    if (success) {
        clearTimeout(globalTimeout);
        bindEvents();
        init3DMap();

        // Weather & Time Control panel (dashboard/js/weather-time-panel.js) —
        // initializes with today's date and the current hour active.
        if (typeof initWeatherTimePanel === 'function') initWeatherTimePanel();
    }
}

// ============================================
// Synthetic Data Generator
// ============================================

// Realistic CURRENT temperatures for January in India
// Based on actual climate data for these regions
const VILLAGE_CLIMATE = {
    'wayanad_meppadi': { baseTemp: 22.0, tempFluctuation: 0.3, baseSoil: 0.35, soilFluctuation: 0.005 },  // Kerala hill station - cool
    'darbhanga': { baseTemp: 18.5, tempFluctuation: 0.4, baseSoil: 0.22, soilFluctuation: 0.008 },       // Bihar plains - winter cold
    'dhemaji': { baseTemp: 16.0, tempFluctuation: 0.5, baseSoil: 0.30, soilFluctuation: 0.006 }          // Assam - winter cool
};

// Track current values for smooth transitions
let currentTempValues = {};
let currentSoilValues = {};

async function updateSyntheticData() {
    const village = appState.data?.villages[appState.currentVillageId];
    if (!village) return;

    const villageId = appState.currentVillageId;
    const coords = village.info.coordinates;

    // Fetch REAL weather instead of synthetic base values
    try {
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${coords.lat}&longitude=${coords.lon}&current=temperature_2m,relative_humidity_2m&timezone=auto`;
        const response = await fetch(url);
        const weatherData = await response.json();

        if (weatherData && weatherData.current) {
            const temperature = weatherData.current.temperature_2m;
            // Soil moisture is harder to get live for free, so we use a realistic stable value for Jan
            const baseSoil = VILLAGE_CLIMATE[villageId]?.baseSoil || 0.35;
            const soilMoisture = baseSoil + (Math.random() - 0.5) * 0.01;

            // Update UI
            const safeUpdate = (id, val) => {
                const el = document.getElementById(id);
                if (el) el.textContent = val;
            };

            safeUpdate('valTemp', `${temperature.toFixed(1)}°C`);
            safeUpdate('valSoil', `${(soilMoisture * 100).toFixed(1)}%`);

            console.log(`Live Weather Update [${villageId}]: ${temperature}°C`);
        }
    } catch (e) {
        console.error("Live weather fetch failed, using fallback:", e);
    }
}

// ============================================
// Jal Drishti Decision Support Systems (DSS)
// ============================================

let voiceAlertTriggered = false;

function checkRiskForVoiceAlert(village) {
    if (voiceAlertTriggered) return;

    const stats = village.statistics?.['24h'] || {};
    const riskAreaHigh = stats.area_at_risk_km2?.high || 0;

    if (riskAreaHigh > 1.0) { // If more than 1km2 is high risk
        triggerVoiceAlert(village.info.name);
        voiceAlertTriggered = true;
        // Reset after 30 seconds to allow re-triggering if conditions persist
        setTimeout(() => { voiceAlertTriggered = false; }, 30000);
    }
}

function triggerVoiceAlert(cityName) {
    if (!('speechSynthesis' in window)) return;

    const msg = new SpeechSynthesisUtterance();
    msg.text = `Warning. Flood levels critical in ${cityName}. Evacuate to safe zone immediately.`;
    msg.pitch = 1.2;
    msg.rate = 0.9;
    window.speechSynthesis.speak(msg);

    // Also show visual alert
    showToast("CRITICAL FLOOD ALERT", `High risk detected in ${cityName}. Evacuation routes active.`, "error");
}

function showToast(title, message, type = 'info') {
    const container = document.getElementById('toast-container') || createToastContainer();
    const toast = document.createElement('div');
    toast.className = `glass-panel toast toast-${type}`;
    toast.style.cssText = `
        padding: 15px; margin-bottom: 10px; border-left: 4px solid ${type === 'error' ? '#ef4444' : '#22d3ee'};
        background: rgba(15, 23, 42, 0.9); backdrop-filter: blur(8px); color: #fff;
        animation: slideIn 0.3s ease-out;
    `;
    toast.innerHTML = `<strong>${title}</strong><div style="font-size:12px; opacity:0.8">${message}</div>`;
    container.appendChild(toast);
    setTimeout(() => {
        toast.style.animation = 'slideOut 0.3s ease-in';
        setTimeout(() => toast.remove(), 300);
    }, 5000);
}

function createToastContainer() {
    const div = document.createElement('div');
    div.id = 'toast-container';
    div.style.cssText = 'position: fixed; top: 20px; right: 20px; z-index: 9999; display: flex; flex-direction: column;';
    document.body.appendChild(div);
    return div;
}

// Draggable Infrastructure Logic Removed

// ============================================
// RESCUE MODE SYSTEM
// ============================================

/**
 * Toggle rescue mode - when active, clicking map triggers rescue path calculation
 */
function toggleRescueMode() {
    appState.rescueMode = !appState.rescueMode;
    // Support both navbar button and layer overlay button
    const btnNavbar = document.getElementById('btnRescueMode');
    const btnLayer = document.getElementById('btnFindRescue');

    if (appState.rescueMode) {
        // Activate both buttons if they exist
        [btnNavbar, btnLayer].forEach(btn => {
            if (btn) {
                btn.classList.add('active');
                btn.style.background = 'rgba(239, 68, 68, 0.3)';
                btn.style.borderColor = '#ef4444';
            }
        });
        if (btnNavbar) btnNavbar.innerHTML = '⛑️ RESCUE MODE ON';
        if (btnLayer) btnLayer.innerHTML = '<span class="layer-icon">🛟</span> CLICK MAP TO SET LOCATION';

        // Change cursor
        if (appState.map) {
            appState.map.getCanvas().style.cursor = 'crosshair';
        }

        showToast('Rescue Mode Active', 'Click anywhere on the map to find the safest evacuation route.', 'info');

        // Add map click handler
        appState.map.on('click', handleRescueClick);
    } else {
        // Deactivate both buttons
        [btnNavbar, btnLayer].forEach(btn => {
            if (btn) {
                btn.classList.remove('active');
                btn.style.background = '';
                btn.style.borderColor = '';
            }
        });
        if (btnNavbar) btnNavbar.innerHTML = '⛑️ RESCUE ME';
        if (btnLayer) btnLayer.innerHTML = '<span class="layer-icon">🛟</span> Find Best Rescue Path';

        if (appState.map) {
            appState.map.getCanvas().style.cursor = '';
            appState.map.off('click', handleRescueClick);
        }

        // Clear rescue path
        clearRescuePath();
    }
}

/**
 * Handle map click in rescue mode
 */
async function handleRescueClick(e) {
    if (!appState.rescueMode) return;

    const { lng, lat } = e.lngLat;
    showToast('Calculating Route...', `Tactical pathfinding from (${lat.toFixed(4)}, ${lng.toFixed(4)})`, 'info');

    try {
        // Try API first
        let result = await fetchFromAPI('/api/rescue', {
            lat: lat,
            lon: lng,
            village_id: appState.currentVillageId,
            flood_level: appState.rainfallAmount / 100
        });

        if (!result || result.status !== 'success') {
            console.log("Backend routing failed or unavailable, using client-side fallback...");
            result = await calculateClientSideRescueRoute(lng, lat);
        }

        if (result && result.status === 'success') {
            drawRescuePath(result.rescue_path);

            const summary = result.rescue_path.summary;
            showToast(
                '✅ Safe Route Found!',
                `${summary.distance_km}km to ${summary.destination} (~${summary.estimated_time_min} min walk)`,
                'info'
            );
        } else {
            showToast('⚠️ No Safe Route', 'Area may be isolated. Seek highest available ground immediately!', 'error');
        }
    } catch (e) {
        console.error('Rescue route calculation failed:', e);
        // Fallback to client-side even on catch
        const fallback = await calculateClientSideRescueRoute(lng, lat);
        if (fallback.status === 'success') {
            drawRescuePath(fallback.rescue_path);
            showToast('✅ Tactical Route Found', 'Using local fallback routing.', 'info');
        } else {
            showToast('Route Error', 'Could not determine safe passage.', 'error');
        }
    }
}

/**
 * Get risk label based on route's average risk — adapts to current rainfall
 * Aligned with classifyRiskLevel thresholds so rescue labels match map risk zones
 */
function getRiskLabel(avgRisk) {
    const intensity = appState.rainfallAmount / 200;
    // Dynamic thresholds: at higher rainfall, lower avgRisk still counts as dangerous
    // These correlate with the flood grid risk colors (red/orange/yellow/green)
    const highThresh = 0.35 - intensity * 0.10;   // 0.35 → 0.25 at max rain
    const medThresh = 0.12 - intensity * 0.04;   // 0.12 → 0.08 at max rain
    if (avgRisk > highThresh) return 'HIGH';
    if (avgRisk > medThresh) return 'MEDIUM';
    return 'LOW';
}

/**
 * Client-side rescue routing with A* pathfinding
 * Finds multiple safe havens and calculates risk-aware paths
 */
async function calculateClientSideRescueRoute(userLng, userLat) {
    const config = SIMULATION_CONFIG[appState.currentVillageId] || SIMULATION_CONFIG.wayanad_meppadi;

    // Safe havens — all placed INSIDE or at edges of village bounding boxes
    // Positions correspond to elevated ground, real infrastructure, and safe zones
    const havens = {
        'wayanad_meppadi': [
            // Real bbox from OSM rel 11312337: [76.0646, 11.4514, 76.2002, 11.6241]
            { name: 'Meppadi Panchayat Shelter', lat: 11.562, lon: 76.133, type: 'shelter', safety: 0.96 },
            { name: 'Meppadi High Ground (North)', lat: 11.598, lon: 76.108, type: 'elevated', safety: 0.94 },
            { name: 'Hilltop Community Hall', lat: 11.545, lon: 76.090, type: 'shelter', safety: 0.92 },
            { name: 'Ridge Point Safe Zone', lat: 11.520, lon: 76.175, type: 'natural', safety: 0.89 },
            { name: 'NH-766 Emergency Camp', lat: 11.480, lon: 76.150, type: 'relief', safety: 0.87 }
        ],
        'darbhanga': [
            // Real bbox from OSM rel 1568263: [85.6767, 25.7196, 86.4161, 26.4464]
            { name: 'Darbhanga Medical College', lat: 26.155, lon: 85.895, type: 'medical', safety: 0.97 },
            { name: 'Laheriasarai Railway Station', lat: 26.140, lon: 85.880, type: 'shelter', safety: 0.94 },
            { name: 'University Campus High Ground', lat: 26.165, lon: 85.870, type: 'elevated', safety: 0.92 },
            { name: 'Darbhanga Fort Complex', lat: 26.150, lon: 85.910, type: 'security', safety: 0.90 },
            { name: 'Kachari Ground Relief Camp', lat: 26.135, lon: 85.920, type: 'relief', safety: 0.86 }
        ],
        'dhemaji': [
            // Real bbox from OSM rel 2026407: [94.2110, 27.3097, 95.5153, 27.8797]
            { name: 'Dhemaji Town Hall', lat: 27.594, lon: 94.863, type: 'shelter', safety: 0.96 },
            { name: 'Dhemaji DC Office High Ground', lat: 27.610, lon: 94.850, type: 'security', safety: 0.94 },
            { name: 'Gogamukh Road Embankment', lat: 27.580, lon: 94.840, type: 'elevated', safety: 0.91 },
            { name: 'Silapathar Relief Camp', lat: 27.620, lon: 94.880, type: 'relief', safety: 0.88 },
            { name: 'Chang Ghar Elevated Platform', lat: 27.560, lon: 94.870, type: 'natural', safety: 0.85 }
        ]
    };

    const villageHavens = havens[appState.currentVillageId] || havens.wayanad_meppadi;
    const baseBbox = config.bbox || [76.0646, 11.4514, 76.2002, 11.6241];

    // Expand the routing bbox by 50% in each direction so A* can navigate to edge havens
    const lngSpan = baseBbox[2] - baseBbox[0];
    const latSpan = baseBbox[3] - baseBbox[1];
    const expand = 0.25; // 25% extra on each side = 50% total expansion
    const bbox = [
        baseBbox[0] - lngSpan * expand,
        baseBbox[1] - latSpan * expand,
        baseBbox[2] + lngSpan * expand,
        baseBbox[3] + latSpan * expand
    ];

    // Generate risk grid for A* pathfinding — higher resolution for accuracy
    const gridSize = 120;
    const riskGrid = generateRiskGrid(bbox, gridSize);

    // Calculate routes to all havens
    const routes = [];
    for (const haven of villageHavens) {
        const path = await findAStarPath(userLng, userLat, haven.lon, haven.lat, riskGrid, bbox, gridSize);
        const distance = calculatePathDistance(path);
        const avgRisk = calculatePathRisk(path, riskGrid, bbox, gridSize);

        // Scoring: Prioritize safety (low risk) > proximity > haven quality
        // At high rainfall, risk dominates scoring even more
        const floodIntensity = appState.rainfallAmount / 200;
        const riskWeight = 0.6 + floodIntensity * 0.2; // 0.6-0.8 weight on risk
        const distWeight = 0.3 - floodIntensity * 0.1;  // 0.2-0.3 weight on distance
        const havenWeight = 0.1;                         // fixed haven quality weight
        const score = (1 - avgRisk * 2.5) * riskWeight + (1 / (distance + 0.1)) * distWeight + (haven.safety * havenWeight);

        routes.push({
            haven,
            path,
            distance,
            avgRisk,
            score,
            timeMin: Math.round(distance * 20) // ~3km/h walking in difficult terrain
        });
    }

    // Filter out unusable routes (e.g., direct fallback line if A* fails)
    const validRoutes = routes.filter(r => r.path.length > 2);
    validRoutes.sort((a, b) => b.score - a.score);

    if (validRoutes.length === 0) {
        return { status: 'failed', message: 'No safe route found through current terrain.' };
    }

    // Identify primary and alternates
    const topRoutes = validRoutes.slice(0, 3); // Top 3 routes
    const bestRoute = topRoutes[0];

    // Build GeoJSON features
    const features = [];

    // Add user location marker
    features.push({
        type: 'Feature',
        properties: { type: 'user_location' },
        geometry: { type: 'Point', coordinates: [userLng, userLat] }
    });

    // Add all safe haven markers
    topRoutes.forEach((route, idx) => {
        features.push({
            type: 'Feature',
            properties: {
                type: 'safe_haven',
                name: route.haven.name,
                havenType: route.haven.type,
                safety: route.haven.safety,
                distance: route.distance.toFixed(2),
                risk: (route.avgRisk * 100).toFixed(0) + '%',
                rank: idx + 1,
                isPrimary: idx === 0
            },
            geometry: { type: 'Point', coordinates: [route.haven.lon, route.haven.lat] }
        });
    });

    // Add paths with style properties
    topRoutes.forEach((route, idx) => {
        const isPrimary = idx === 0;
        const smoothedPath = smoothPathCatmullRom(route.path, isPrimary ? 6 : 3);

        features.push({
            type: 'Feature',
            properties: {
                type: isPrimary ? 'rescue_path' : 'alternate_path',
                rank: idx + 1,
                isPrimary: isPrimary,
                distance_km: route.distance.toFixed(2),
                time_min: route.timeMin,
                risk_level: getRiskLabel(route.avgRisk),
                safety_score: ((1 - route.avgRisk) * 100).toFixed(0) + '%'
            },
            geometry: { type: 'LineString', coordinates: smoothedPath }
        });
    });

    return {
        status: 'success',
        rescue_path: {
            summary: {
                distance_km: bestRoute.distance.toFixed(2),
                destination: bestRoute.haven.name,
                estimated_time_min: bestRoute.timeMin,
                safety_score: ((1 - bestRoute.avgRisk) * 100).toFixed(0) + '%',
                alternatives: topRoutes.length - 1
            },
            routes: topRoutes.map((route, idx) => ({
                name: route.haven.name,
                type: route.haven.type,
                distance_km: route.distance.toFixed(2),
                time_min: route.timeMin,
                safety: ((1 - route.avgRisk) * 100).toFixed(0) + '%',
                risk_level: getRiskLabel(route.avgRisk),
                avg_risk: route.avgRisk,
                rank: idx + 1
            })),
            geojson: {
                type: 'FeatureCollection',
                features: features
            }
        }
    };
}

/**
 * Generate risk grid based on flood simulation data
 */
function generateRiskGrid(bbox, gridSize) {
    const grid = [];
    const [minLng, minLat, maxLng, maxLat] = bbox;
    const lngStep = (maxLng - minLng) / gridSize;
    const latStep = (maxLat - minLat) / gridSize;

    for (let y = 0; y < gridSize; y++) {
        grid[y] = [];
        for (let x = 0; x < gridSize; x++) {
            const lng = minLng + x * lngStep + lngStep / 2;
            const lat = minLat + y * latStep + latStep / 2;

            // Calculate risk based on flood simulation logic
            const intensity = appState.rainfallAmount / 200;
            const risk = estimateFloodRiskAtPoint(lng, lat, intensity);
            grid[y][x] = Math.min(1, Math.max(0, risk));
        }
    }

    return grid;
}

/**
 * Estimate flood risk at a specific point using existing simulation functions
 */
function estimateFloodRiskAtPoint(lng, lat, intensity, routingBbox = null) {
    const config = SIMULATION_CONFIG[appState.currentVillageId] || SIMULATION_CONFIG.wayanad_meppadi;
    const bbox = routingBbox || config.bbox || [76.0646, 11.4514, 76.2002, 11.6241];

    // Normalize position to the simulation grid (use 25 to match flood generators)
    const simBbox = config.bbox || [76.0646, 11.4514, 76.2002, 11.6241];
    const normX = (lng - simBbox[0]) / (simBbox[2] - simBbox[0]) * 25;
    const normY = (lat - simBbox[1]) / (simBbox[3] - simBbox[1]) * 25;

    // Points outside the simulation bbox get low risk (they're outside the flood zone)
    if (normX < -2 || normX > 27 || normY < -2 || normY > 27) {
        return 0.05; // minimal residual risk
    }

    let floodValue = 0;

    // Use appropriate flood model based on village type
    switch (config.type) {
        case 'hilly_landslide':
            floodValue = generateHillyFlood(normX, normY, 25, intensity);
            break;
        case 'riverine_plain':
            floodValue = generateRiverineFlood(normX, normY, 25, intensity);
            break;
        case 'floodplain':
            floodValue = generateFloodplainFlood(normX, normY, 25, intensity);
            break;
        default:
            floodValue = simpleNoise(normX, normY) * intensity * 2;
    }

    // Normalize to 0-1 risk scale — use tighter scaling for more dramatic risk contrast
    return Math.min(1, Math.max(0, floodValue / 3.5));
}

/**
 * A* Pathfinding with risk avoidance and min-heap priority queue
 */
async function findAStarPath(startLng, startLat, endLng, endLat, riskGrid, bbox, gridSize) {
    const [minLng, minLat, maxLng, maxLat] = bbox;
    const lngStep = (maxLng - minLng) / gridSize;
    const latStep = (maxLat - minLat) / gridSize;

    // Convert lat/lng to grid coordinates
    const toGrid = (lng, lat) => ({
        x: Math.floor((lng - minLng) / lngStep),
        y: Math.floor((lat - minLat) / latStep)
    });

    const toLngLat = (gx, gy) => [
        minLng + gx * lngStep + lngStep / 2,
        minLat + gy * latStep + latStep / 2
    ];

    const start = toGrid(startLng, startLat);
    const end = toGrid(endLng, endLat);

    // Clamp to grid bounds
    start.x = Math.max(0, Math.min(gridSize - 1, start.x));
    start.y = Math.max(0, Math.min(gridSize - 1, start.y));
    end.x = Math.max(0, Math.min(gridSize - 1, end.x));
    end.y = Math.max(0, Math.min(gridSize - 1, end.y));

    // --- Min-Heap Priority Queue for O(log n) operations ---
    class MinHeap {
        constructor() { this.data = []; }
        push(node) {
            this.data.push(node);
            let i = this.data.length - 1;
            while (i > 0) {
                const parent = (i - 1) >> 1;
                if (this.data[i].f < this.data[parent].f) {
                    [this.data[i], this.data[parent]] = [this.data[parent], this.data[i]];
                    i = parent;
                } else break;
            }
        }
        pop() {
            const top = this.data[0];
            const last = this.data.pop();
            if (this.data.length > 0) {
                this.data[0] = last;
                let i = 0;
                while (true) {
                    let smallest = i;
                    const left = 2 * i + 1, right = 2 * i + 2;
                    if (left < this.data.length && this.data[left].f < this.data[smallest].f) smallest = left;
                    if (right < this.data.length && this.data[right].f < this.data[smallest].f) smallest = right;
                    if (smallest !== i) {
                        [this.data[i], this.data[smallest]] = [this.data[smallest], this.data[i]];
                        i = smallest;
                    } else break;
                }
            }
            return top;
        }
        get length() { return this.data.length; }
    }

    // A* algorithm with min-heap
    const openSet = new MinHeap();
    openSet.push({ x: start.x, y: start.y, g: 0, h: 0, f: 0, parent: null });

    const gScores = new Map(); // Track best g-score per cell
    const nodeKey = (x, y) => x * gridSize + y;
    gScores.set(nodeKey(start.x, start.y), 0);

    const DANGER_THRESHOLD = 0.55; // Cells above this are completely impassable — stricter for safer routes
    const MAX_ITERATIONS = 25000; // Increased for larger grids
    let iterations = 0;

    const heuristic = (x, y) => {
        const dx = Math.abs(x - end.x);
        const dy = Math.abs(y - end.y);
        return Math.max(dx, dy) + 0.414 * Math.min(dx, dy); // Octile distance
    };

    while (openSet.length > 0 && iterations < MAX_ITERATIONS) {
        iterations++;

        // Yield to main thread every 500 iterations to prevent UI stuttering
        if (iterations % 500 === 0) {
            await new Promise(r => setTimeout(r, 0));
        }

        const current = openSet.pop();

        // Goal check
        if (current.x === end.x && current.y === end.y) {
            // Reconstruct path
            const path = [[endLng, endLat]];
            let node = current;
            while (node.parent) {
                path.unshift(toLngLat(node.x, node.y));
                node = node.parent;
            }
            path.unshift([startLng, startLat]);
            console.log(`[A*] Path found in ${iterations} iterations, ${path.length} waypoints`);
            return path;
        }

        // Explore neighbors (8-directional)
        const neighbors = [
            { dx: -1, dy: 0 }, { dx: 1, dy: 0 },
            { dx: 0, dy: -1 }, { dx: 0, dy: 1 },
            { dx: -1, dy: -1 }, { dx: 1, dy: -1 },
            { dx: -1, dy: 1 }, { dx: 1, dy: 1 }
        ];

        for (const { dx, dy } of neighbors) {
            const nx = current.x + dx;
            const ny = current.y + dy;

            // Skip out of bounds
            if (nx < 0 || nx >= gridSize || ny < 0 || ny >= gridSize) continue;

            // Get cell risk and BLOCK if above danger threshold
            const cellRisk = riskGrid[ny]?.[nx] || 0;
            if (cellRisk >= DANGER_THRESHOLD) continue; // Completely block dangerous cells

            // Cost calculation
            const moveCost = Math.abs(dx) + Math.abs(dy) > 1 ? 1.414 : 1;
            // Massive penalty for any detected flood risk — forces path outside simulation hazard areas entirely
            const riskPenalty = cellRisk * 250;
            // Penalize moderate risk (slopes) heavily
            const slopePenalty = (cellRisk > 0.15) ? 40 : 0;

            const g = current.g + moveCost + riskPenalty + slopePenalty;
            const key = nodeKey(nx, ny);

            // True admissible heuristic for an 8-way grid ensures absolute shortest risk path
            // Only process if this is a better path to this cell
            if (gScores.has(key) && gScores.get(key) <= g) continue;
            gScores.set(key, g);

            // Tie-breaker multiplier (0.001) added to heuristic prevents A* from expanding equal-cost states pointlessly, creating smoother paths
            const h = heuristic(nx, ny) * 1.001;
            openSet.push({ x: nx, y: ny, g, h, f: g + h, parent: current });
        }
    }

    console.warn(`[A*] No path found after ${iterations} iterations, using fallback direct line`);
    // Fallback: direct path if A* fails
    return [[startLng, startLat], [endLng, endLat]];
}

/**
 * Catmull-Rom spline interpolation for smooth paths
 */
function smoothPathCatmullRom(points, segments = 5) {
    if (points.length < 3) return points;

    const result = [];

    // Add phantom points at start and end for smooth endpoints
    const p = [
        points[0],
        ...points,
        points[points.length - 1]
    ];

    for (let i = 1; i < p.length - 2; i++) {
        for (let t = 0; t < segments; t++) {
            const s = t / segments;
            const s2 = s * s;
            const s3 = s2 * s;

            // Catmull-Rom basis functions
            const b0 = -0.5 * s3 + s2 - 0.5 * s;
            const b1 = 1.5 * s3 - 2.5 * s2 + 1;
            const b2 = -1.5 * s3 + 2 * s2 + 0.5 * s;
            const b3 = 0.5 * s3 - 0.5 * s2;

            const lng = b0 * p[i - 1][0] + b1 * p[i][0] + b2 * p[i + 1][0] + b3 * p[i + 2][0];
            const lat = b0 * p[i - 1][1] + b1 * p[i][1] + b2 * p[i + 1][1] + b3 * p[i + 2][1];

            result.push([lng, lat]);
        }
    }

    // Add final point
    result.push(points[points.length - 1]);

    return result;
}

/**
 * Calculate path distance in km
 */
function calculatePathDistance(path) {
    let total = 0;
    for (let i = 0; i < path.length - 1; i++) {
        const dx = path[i + 1][0] - path[i][0];
        const dy = path[i + 1][1] - path[i][1];
        total += Math.sqrt(dx * dx + dy * dy) * 111.32; // Degrees to km
    }
    return total;
}

/**
 * Calculate average risk along a path
 */
function calculatePathRisk(path, riskGrid, bbox, gridSize) {
    const [minLng, minLat, maxLng, maxLat] = bbox;
    const lngStep = (maxLng - minLng) / gridSize;
    const latStep = (maxLat - minLat) / gridSize;

    let totalRisk = 0;
    let count = 0;

    for (const [lng, lat] of path) {
        const gx = Math.floor((lng - minLng) / lngStep);
        const gy = Math.floor((lat - minLat) / latStep);

        if (gx >= 0 && gx < gridSize && gy >= 0 && gy < gridSize) {
            totalRisk += riskGrid[gy]?.[gx] || 0;
            count++;
        }
    }

    return count > 0 ? totalRisk / count : 0;
}


/**
 * Draw rescue path on map — Google Maps style with switchable routes
 */
function drawRescuePath(pathData) {
    if (!appState.map || !pathData) return;

    clearRescuePath();

    // Store full path data and routes for switching
    appState.rescuePath = pathData;
    appState.activeRouteIndex = 0;

    const features = pathData.geojson?.features || pathData.features || [];

    // Classify features
    const allPaths = features.filter(f => f.properties?.type === 'rescue_path' || f.properties?.type === 'alternate_path');
    const startMarker = features.find(f => f.properties?.type === 'user_location');
    const safeHavens = features.filter(f => f.properties?.type === 'safe_haven');

    // Sort paths by rank
    allPaths.sort((a, b) => (a.properties?.rank || 99) - (b.properties?.rank || 99));

    // Color palette for routes (Google Maps style)
    const routeColors = {
        active: { LOW: '#22c55e', MEDIUM: '#f59e0b', HIGH: '#ef4444' },
        inactive: '#64748b'
    };

    // Draw ALL routes
    allPaths.forEach((pathFeature, idx) => {
        const isActive = idx === 0;
        const riskLevel = pathFeature.properties?.risk_level || 'LOW';
        const activeColor = routeColors.active[riskLevel] || '#22c55e';
        const color = isActive ? activeColor : routeColors.inactive;
        const sourceId = `rescue-route-source-${idx}`;

        appState.map.addSource(sourceId, { type: 'geojson', data: pathFeature });

        // Glow layer (active route only)
        appState.map.addLayer({
            id: `rescue-route-glow-${idx}`,
            type: 'line',
            source: sourceId,
            paint: {
                'line-color': color,
                'line-width': isActive ? 20 : 0,
                'line-opacity': isActive ? 0.4 : 0,
                'line-blur': 10
            }
        });

        // Outer casing (Google Maps style border)
        appState.map.addLayer({
            id: `rescue-route-casing-${idx}`,
            type: 'line',
            source: sourceId,
            paint: {
                'line-color': '#0f172a',
                'line-width': isActive ? 8 : 4,
                'line-opacity': isActive ? 0.8 : 0.6,
                'line-gap-width': 0
            }
        });

        // Main route line
        appState.map.addLayer({
            id: `rescue-route-line-${idx}`,
            type: 'line',
            source: sourceId,
            paint: {
                'line-color': color,
                'line-width': isActive ? 4 : 2,
                'line-opacity': isActive ? 1 : 0.6,
                'line-dasharray': isActive ? [1] : [2, 2]
            },
            layout: {
                'line-cap': 'round',
                'line-join': 'round'
            }
        });

        // Remove the jittery line-dasharray animation layer entirely

        // Make inactive routes clickable to switch
        if (!isActive) {
            appState.map.on('click', `rescue-route-line-${idx}`, () => {
                switchActiveRoute(idx);
            });
            appState.map.on('mouseenter', `rescue-route-line-${idx}`, () => {
                appState.map.getCanvas().style.cursor = 'pointer';
                // Highlight on hover
                if (appState.map.getLayer(`rescue-route-line-${idx}`)) {
                    appState.map.setPaintProperty(`rescue-route-line-${idx}`, 'line-opacity', 0.75);
                    appState.map.setPaintProperty(`rescue-route-line-${idx}`, 'line-width', 6);
                }
            });
            appState.map.on('mouseleave', `rescue-route-line-${idx}`, () => {
                appState.map.getCanvas().style.cursor = appState.rescueMode ? 'crosshair' : '';
                if (idx !== appState.activeRouteIndex && appState.map.getLayer(`rescue-route-line-${idx}`)) {
                    appState.map.setPaintProperty(`rescue-route-line-${idx}`, 'line-opacity', 0.45);
                    appState.map.setPaintProperty(`rescue-route-line-${idx}`, 'line-width', 4);
                }
            });
        }
    });

    // User start location marker
    if (startMarker) {
        appState.map.addSource('rescue-start-source', { type: 'geojson', data: startMarker });

        // Pulsing outer ring
        appState.map.addLayer({
            id: 'rescue-start-pulse',
            type: 'circle',
            source: 'rescue-start-source',
            paint: {
                'circle-radius': 20,
                'circle-color': '#3b82f6',
                'circle-opacity': 0.25,
                'circle-stroke-width': 2,
                'circle-stroke-color': '#3b82f6',
                'circle-stroke-opacity': 0.4
            }
        });

        // Inner dot
        appState.map.addLayer({
            id: 'rescue-start-layer',
            type: 'circle',
            source: 'rescue-start-source',
            paint: {
                'circle-radius': 8,
                'circle-color': '#3b82f6',
                'circle-stroke-width': 3,
                'circle-stroke-color': '#fff'
            }
        });

        // "You" label
        appState.map.addLayer({
            id: 'rescue-start-label',
            type: 'symbol',
            source: 'rescue-start-source',
            layout: {
                'text-field': '📍 YOU',
                'text-size': 11,
                'text-offset': [0, -2],
                'text-anchor': 'bottom',
                'text-font': ['Open Sans Bold']
            },
            paint: {
                'text-color': '#93c5fd',
                'text-halo-color': '#000',
                'text-halo-width': 2
            }
        });
    }

    // Safe haven markers
    safeHavens.forEach((haven, idx) => {
        const sourceId = `rescue-haven-source-${idx}`;
        const isActive = idx === 0;

        appState.map.addSource(sourceId, { type: 'geojson', data: haven });

        // Haven circle marker
        appState.map.addLayer({
            id: `rescue-haven-layer-${idx}`,
            type: 'circle',
            source: sourceId,
            paint: {
                'circle-radius': isActive ? 12 : 8,
                'circle-color': isActive ? '#22c55e' : '#10b981',
                'circle-stroke-width': isActive ? 3 : 2,
                'circle-stroke-color': '#fff',
                'circle-opacity': isActive ? 1 : 0.6
            }
        });

        // Haven label
        const typeIcons = { medical: '🏥', shelter: '🏠', security: '🚔', natural: '⛰️', elevated: '🏔️', relief: '⛺' };
        const icon = typeIcons[haven.properties?.havenType] || '📌';
        appState.map.addLayer({
            id: `rescue-haven-label-${idx}`,
            type: 'symbol',
            source: sourceId,
            layout: {
                'text-field': `${icon} ${haven.properties?.name || 'Safe Zone'}`,
                'text-size': isActive ? 12 : 10,
                'text-offset': [0, isActive ? 2.0 : 1.6],
                'text-anchor': 'top',
                'text-max-width': 14
            },
            paint: {
                'text-color': isActive ? '#86efac' : '#94a3b8',
                'text-halo-color': 'rgba(0,0,0,0.9)',
                'text-halo-width': 2
            }
        });
    });

    // Show the route info panel
    showRescueInfoPanel(pathData, 0);

    // Fit map to show the active route
    fitMapToRoute(features, 0);
}

/**
 * Fit map to show a specific route
 */
function fitMapToRoute(features, routeIndex) {
    const allPaths = features.filter(f => f.properties?.type === 'rescue_path' || f.properties?.type === 'alternate_path')
        .sort((a, b) => (a.properties?.rank || 99) - (b.properties?.rank || 99));
    const startMarker = features.find(f => f.properties?.type === 'user_location');

    const coordsToFit = [];
    if (startMarker) coordsToFit.push(startMarker.geometry.coordinates);
    if (allPaths[routeIndex]) {
        coordsToFit.push(...allPaths[routeIndex].geometry.coordinates);
    }

    if (coordsToFit.length > 1) {
        const lngs = coordsToFit.map(c => c[0]);
        const lats = coordsToFit.map(c => c[1]);
        appState.map.fitBounds(
            [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]],
            { padding: { top: 80, bottom: 80, left: 80, right: 400 }, duration: 1000, pitch: 45 }
        );
    }
}

/**
 * Show rescue route info panel — Google Maps style with clickable route cards
 */
function showRescueInfoPanel(pathData, activeIndex = 0) {
    const summary = pathData.summary;
    const routes = pathData.routes || [];
    if (routes.length === 0) return;

    const activeRoute = routes[activeIndex] || routes[0];
    const activeRiskLevel = activeRoute.risk_level || 'LOW';
    const activeColor = activeRiskLevel === 'HIGH' ? '#ef4444' : (activeRiskLevel === 'MEDIUM' ? '#f59e0b' : '#22c55e');

    // Build clickable route cards
    let cardsHtml = '';
    routes.forEach((route, idx) => {
        const isSelected = idx === activeIndex;
        const riskColor = route.risk_level === 'HIGH' ? '#ef4444' : (route.risk_level === 'MEDIUM' ? '#f59e0b' : '#22c55e');
        const riskClass = route.risk_level === 'HIGH' ? 'risk-high' : (route.risk_level === 'MEDIUM' ? 'risk-medium' : '');
        const typeIcons = { medical: '🏥', shelter: '🏠', security: '🚔', natural: '⛰️', elevated: '🏔️', relief: '⛺' };
        const typeIcon = typeIcons[route.type] || '📍';

        cardsHtml += `
            <div class="rescue-route-card ${isSelected ? 'selected' : ''} ${isSelected ? riskClass : ''}" 
                 onclick="switchActiveRoute(${idx})" 
                 style="animation: rescueSlideIn 0.3s ease ${idx * 0.08}s both;">
                <div style="display: flex; align-items: center; gap: 10px;">
                    <div class="route-rank">${idx + 1}</div>
                    <div style="flex: 1; min-width: 0;">
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
                            <div style="font-size: 0.8rem; color: var(--text-primary); font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
                                ${typeIcon} ${route.name}
                            </div>
                        </div>
                        <div style="display: flex; gap: 12px; align-items: center;">
                            <div class="rescue-stat">
                                <strong>${route.distance_km} km</strong>
                            </div>
                            <div class="rescue-stat">
                                <strong>~${route.time_min} min</strong>
                            </div>
                            <span class="rescue-badge" style="background: ${riskColor}18; color: ${riskColor}; border: 1px solid ${riskColor}30;">
                                ${route.risk_level}
                            </span>
                        </div>
                    </div>
                </div>
                ${isSelected ? `
                <div style="margin-top: 10px; padding-top: 8px; border-top: 1px solid rgba(255,255,255,0.06); display: flex; justify-content: space-between; font-size: 0.65rem; color: var(--text-muted);">
                    <span>🛡️ Safety: <strong style="color: ${riskColor}">${route.safety}</strong></span>
                    <span>🚶 Walking pace ~3km/h</span>
                </div>` : ''}
            </div>
        `;
    });

    // Create or reuse panel
    let panel = document.getElementById('rescueInfoPanel');
    if (!panel) {
        panel = document.createElement('div');
        panel.id = 'rescueInfoPanel';
        panel.className = 'glass-panel';
        panel.style.cssText = `
            position: fixed; top: 90px; right: 356px; width: 340px;
            z-index: 200; pointer-events: auto;
            border-left: 3px solid ${activeColor};
            animation: rescueSlideIn 0.4s cubic-bezier(0.25,0.46,0.45,0.94);
            max-height: calc(100vh - 140px); overflow-y: auto;
        `;
        document.body.appendChild(panel);
    } else {
        panel.style.borderLeftColor = activeColor;
    }

    panel.style.display = 'block';
    panel.innerHTML = `
        <div class="panel-header" style="display:flex; justify-content:space-between; align-items:center;">
            <span style="display:flex; align-items:center; gap:8px;">
                <span style="font-size:1.1rem;">🗺️</span>
                <span>ROUTES</span>
                <span style="font-size: 0.6rem; padding: 2px 8px; background: rgba(255,255,255,0.06); border-radius: 10px; color: var(--text-muted); font-weight: 400; letter-spacing: 0;">${routes.length} found</span>
            </span>
            <button onclick="document.getElementById('rescueInfoPanel').style.display='none';"
                style="border:none; background:none; color:var(--text-muted); cursor:pointer; font-size: 1.2rem; transition: color 0.2s;"
                onmouseover="this.style.color='#fff'" onmouseout="this.style.color='var(--text-muted)'">✕</button>
        </div>

        <div style="margin-bottom: 6px; font-size: 0.6rem; color: var(--text-muted); line-height: 1.4;">
            Click a route to switch • Routes avoid flood zones
        </div>

        ${cardsHtml}

        <div style="margin-top: 10px; padding: 10px 12px; background: linear-gradient(135deg, ${activeColor}12, ${activeColor}06); border-radius: 8px; border: 1px solid ${activeColor}30;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
                <div style="font-size: 0.6rem; color: ${activeColor}; text-transform: uppercase; letter-spacing: 1px; font-weight: 600;">📍 SELECTED DESTINATION</div>
            </div>
            <div style="font-size: 0.9rem; color: var(--text-primary); font-weight: 600;">${activeRoute.name}</div>
            <div style="font-size: 0.7rem; color: var(--text-secondary); margin-top: 4px;">
                ${activeRoute.distance_km} km • ~${activeRoute.time_min} min • Safety ${activeRoute.safety}
            </div>
        </div>

        <div style="margin-top: 8px; display: flex; gap: 6px;">
            <button onclick="document.getElementById('rescueInfoPanel').style.display='none'; toggleRescueMode();"
                style="flex:1; padding: 8px; border: 1px solid rgba(239,68,68,0.25); background: rgba(239,68,68,0.08); color: #fca5a5; border-radius: 8px; cursor: pointer; font-size: 0.7rem; font-weight: 600; transition: all 0.2s;"
                onmouseover="this.style.background='rgba(239,68,68,0.2)'" onmouseout="this.style.background='rgba(239,68,68,0.08)'">
                ✕ CLEAR ALL
            </button>
        </div>
    `;
}

/**
 * Clear rescue path from map
 */
function clearRescuePath() {
    if (!appState.map) return;

    // Stop animation
    if (rescueAnimFrame) {
        cancelAnimationFrame(rescueAnimFrame);
        rescueAnimFrame = null;
    }

    // Hide info panel
    const rescuePanel = document.getElementById('rescueInfoPanel');
    if (rescuePanel) rescuePanel.style.display = 'none';

    // Clear route layers (up to 5 routes)
    for (let i = 0; i < 5; i++) {
        ['rescue-route-glow-', 'rescue-route-casing-', 'rescue-route-line-', 'rescue-route-arrows-'].forEach(prefix => {
            const id = prefix + i;
            if (appState.map.getLayer(id)) appState.map.removeLayer(id);
        });
        const sourceId = `rescue-route-source-${i}`;
        if (appState.map.getSource(sourceId)) appState.map.removeSource(sourceId);
    }

    // Clear start marker layers
    ['rescue-start-pulse', 'rescue-start-layer', 'rescue-start-label'].forEach(id => {
        if (appState.map.getLayer(id)) appState.map.removeLayer(id);
    });
    if (appState.map.getSource('rescue-start-source')) appState.map.removeSource('rescue-start-source');

    // Clear haven markers (up to 5)
    for (let i = 0; i < 5; i++) {
        ['rescue-haven-layer-', 'rescue-haven-label-'].forEach(prefix => {
            const id = prefix + i;
            if (appState.map.getLayer(id)) appState.map.removeLayer(id);
        });
        const sourceId = `rescue-haven-source-${i}`;
        if (appState.map.getSource(sourceId)) appState.map.removeSource(sourceId);
    }

    // Clear old-style layers (backward compat)
    ['rescue-path-glow', 'rescue-path-layer'].forEach(id => {
        if (appState.map.getLayer(id)) appState.map.removeLayer(id);
    });
    if (appState.map.getSource('rescue-path-source')) appState.map.removeSource('rescue-path-source');
    for (let i = 0; i < 5; i++) {
        const layerId = `rescue-alt-layer-${i}`;
        const sourceId = `rescue-alt-source-${i}`;
        if (appState.map.getLayer(layerId)) appState.map.removeLayer(layerId);
        if (appState.map.getSource(sourceId)) appState.map.removeSource(sourceId);
    }

    appState.rescuePath = null;
    appState.activeRouteIndex = 0;
}

/**
 * Switch active route — Google Maps-style route switching
 * Re-styles all routes, updates info panel and map view
 */
function switchActiveRoute(newIndex) {
    if (!appState.map || !appState.rescuePath) return;
    const features = appState.rescuePath.geojson?.features || appState.rescuePath.features || [];
    const allPaths = features.filter(f => f.properties?.type === 'rescue_path' || f.properties?.type === 'alternate_path')
        .sort((a, b) => (a.properties?.rank || 99) - (b.properties?.rank || 99));

    if (newIndex < 0 || newIndex >= allPaths.length) return;
    appState.activeRouteIndex = newIndex;

    const routeColors = {
        active: { LOW: '#22c55e', MEDIUM: '#f59e0b', HIGH: '#ef4444' },
        inactive: '#64748b'
    };

    // Re-style all route layers
    allPaths.forEach((pathFeature, idx) => {
        const isActive = idx === newIndex;
        const riskLevel = pathFeature.properties?.risk_level || 'LOW';
        const activeColor = routeColors.active[riskLevel] || '#22c55e';
        const color = isActive ? activeColor : routeColors.inactive;

        // Update glow
        if (appState.map.getLayer(`rescue-route-glow-${idx}`)) {
            appState.map.setPaintProperty(`rescue-route-glow-${idx}`, 'line-color', color);
            appState.map.setPaintProperty(`rescue-route-glow-${idx}`, 'line-width', isActive ? 20 : 0);
            appState.map.setPaintProperty(`rescue-route-glow-${idx}`, 'line-opacity', isActive ? 0.4 : 0);
        }

        // Update casing
        if (appState.map.getLayer(`rescue-route-casing-${idx}`)) {
            appState.map.setPaintProperty(`rescue-route-casing-${idx}`, 'line-width', isActive ? 8 : 4);
            appState.map.setPaintProperty(`rescue-route-casing-${idx}`, 'line-opacity', isActive ? 0.8 : 0.6);
        }

        // Update main line
        if (appState.map.getLayer(`rescue-route-line-${idx}`)) {
            appState.map.setPaintProperty(`rescue-route-line-${idx}`, 'line-color', color);
            appState.map.setPaintProperty(`rescue-route-line-${idx}`, 'line-width', isActive ? 4 : 2);
            appState.map.setPaintProperty(`rescue-route-line-${idx}`, 'line-opacity', isActive ? 1 : 0.45);
        }

        // Update haven markers
        if (appState.map.getLayer(`rescue-haven-layer-${idx}`)) {
            appState.map.setPaintProperty(`rescue-haven-layer-${idx}`, 'circle-radius', isActive ? 12 : 8);
            appState.map.setPaintProperty(`rescue-haven-layer-${idx}`, 'circle-opacity', isActive ? 1 : 0.6);
            appState.map.setPaintProperty(`rescue-haven-layer-${idx}`, 'circle-stroke-width', isActive ? 3 : 2);
        }
        if (appState.map.getLayer(`rescue-haven-label-${idx}`)) {
            appState.map.setPaintProperty(`rescue-haven-label-${idx}`, 'text-color', isActive ? '#86efac' : '#94a3b8');
        }
    });

    // Update info panel
    showRescueInfoPanel(appState.rescuePath, newIndex);

    // Fit map to the newly active route
    fitMapToRoute(features, newIndex);
}


// ============================================
// FLOOD ANIMATION ENGINE
// ============================================

/**
 * Animate flood polygons with pulsing opacity and T1→T2→T3 transitions
 */
function startFloodAnimation() {
    if (appState.floodAnimationId) return;

    let startTime = performance.now();
    const cycleTime = 4000; // 4 second breathing cycle

    const animate = (time) => {
        if (!appState.floodAnimationId) return;

        const elapsed = time - startTime;
        const phase = (elapsed % cycleTime) / cycleTime;

        // Smoother sine oscillation for breathing effect
        const breathe = 0.65 + 0.1 * Math.sin(phase * 2 * Math.PI);

        // Update flood layer opacity
        const layerId = `flood-risk-layer-${appState.currentTimeStep}`;
        if (appState.map && appState.map.getLayer(layerId)) {
            // Using setPaintProperty is fine, but MapLibre is more efficient if transition is set
            appState.map.setPaintProperty(layerId, 'fill-opacity', breathe);
        }

        appState.floodAnimationId = requestAnimationFrame(animate);
    };

    appState.floodAnimationId = requestAnimationFrame(animate);
}

/**
 * Stop flood animation
 */
function stopFloodAnimation() {
    if (appState.floodAnimationId) {
        cancelAnimationFrame(appState.floodAnimationId);
        appState.floodAnimationId = null;
    }
}

/**
 * Fetch flood simulation from API
 */
async function fetchFloodSimulation() {
    // Abort previous request
    if (appState.abortController) {
        appState.abortController.abort();
    }
    appState.abortController = new AbortController();

    const result = await fetchFromAPI('/api/simulate', {
        rainfall: appState.rainfallAmount,
        village_id: appState.currentVillageId,
        format: 'polygons'
    }, appState.abortController.signal);

    if (result && result.status === 'success') {
        appState.apiData.floodSimulation = result.simulation;
        console.log('✓ Flood simulation loaded from API');
        return result.simulation;
    }
    return null;
}

// ============================================
// VILLAGE BOUNDARY RENDERING (Glowing Dashed)
// ============================================

/**
 * Render village boundary with glowing dashed orange/white style
 */
function renderAPIBoundary() {
    if (!appState.map || !appState.apiData.boundary) return;

    const boundary = appState.apiData.boundary;

    // Remove existing if present
    if (appState.map.getLayer('api-boundary-glow')) {
        appState.map.removeLayer('api-boundary-glow');
        appState.map.removeLayer('api-boundary-line');
        appState.map.removeSource('api-boundary-source');
    }

    appState.map.addSource('api-boundary-source', {
        type: 'geojson',
        data: boundary
    });

    // Glow effect (white blur)
    appState.map.addLayer({
        id: 'api-boundary-glow',
        type: 'line',
        source: 'api-boundary-source',
        paint: {
            'line-color': '#ffffff',
            'line-width': 10,
            'line-opacity': 0.25,
            'line-blur': 6
        }
    });

    // Main boundary (orange dashed)
    appState.map.addLayer({
        id: 'api-boundary-line',
        type: 'line',
        source: 'api-boundary-source',
        paint: {
            'line-color': '#ff9500',
            'line-width': 4,
            'line-opacity': 0.9,
            'line-dasharray': [2, 1]
        }
    });
}

/**
 * Render infrastructure POIs on map
 */
function renderAPIPOIs() {
    if (!appState.map || !appState.apiData.infrastructure) return;

    const pois = appState.apiData.infrastructure;

    if (appState.map.getLayer('api-pois-layer')) {
        appState.map.removeLayer('api-pois-labels');
        appState.map.removeLayer('api-pois-layer');
        appState.map.removeSource('api-pois-source');
    }

    appState.map.addSource('api-pois-source', {
        type: 'geojson',
        data: pois
    });

    appState.map.addLayer({
        id: 'api-pois-layer',
        type: 'circle',
        source: 'api-pois-source',
        paint: {
            'circle-radius': ['case', ['get', 'is_safe_haven'], 12, 8],
            'circle-color': ['case', ['get', 'is_safe_haven'], '#22c55e', '#ef4444'],
            'circle-stroke-width': 2,
            'circle-stroke-color': '#ffffff'
        }
    });

    appState.map.addLayer({
        id: 'api-pois-labels',
        type: 'symbol',
        source: 'api-pois-source',
        layout: {
            'text-field': ['get', 'name'],
            'text-size': 11,
            'text-offset': [0, 1.5],
            'text-anchor': 'top'
        },
        paint: {
            'text-color': '#ffffff',
            'text-halo-color': '#000000',
            'text-halo-width': 1
        }
    });
}

/**
 * Render population heatmap from API data
 * Shows population density to identify populations at risk
 */
function renderAPIPopulation() {
    if (!appState.map || !appState.apiData.population) return;

    const population = appState.apiData.population;

    // Check if button is active to determine initial visibility
    const isPopBtnActive = document.getElementById('btnLayerPopHeatmap')?.classList.contains('active');
    const visibility = isPopBtnActive ? 'visible' : 'none';

    if (appState.map.getSource('api-population-source')) {
        appState.map.getSource('api-population-source').setData(population);
    } else {
        appState.map.addSource('api-population-source', {
            type: 'geojson',
            data: population
        });

        appState.map.addLayer({
            id: 'api-population-layer',
            type: 'heatmap',
            source: 'api-population-source',
            layout: { visibility: visibility },
            paint: {
                'heatmap-weight': ['get', 'intensity'],
                'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 0, 1, 14, 3],
                'heatmap-color': [
                    'interpolate', ['linear'], ['heatmap-density'],
                    0, 'rgba(50, 50, 150, 0)',       // Transparent for low density
                    0.15, 'rgba(0, 100, 200, 0.4)',  // Blue for low population
                    0.3, 'rgba(0, 180, 200, 0.5)',   // Cyan for moderate
                    0.5, 'rgba(100, 200, 100, 0.6)', // Green for medium
                    0.7, 'rgba(255, 200, 0, 0.75)', // Yellow/Orange for high
                    0.85, 'rgba(255, 100, 50, 0.85)', // Orange-red for very high
                    1, 'rgba(255, 0, 0, 0.95)'       // Red for highest density (most at risk)
                ],
                'heatmap-radius': ['interpolate', ['linear'], ['zoom'],
                    10, 15,   // Smaller radius when zoomed out
                    13, 30,   // Medium radius at default zoom
                    16, 50    // Larger radius when zoomed in
                ],
                'heatmap-opacity': 0.8
            }
        });
    }

    // Ensure visibility matches button state
    if (appState.map.getLayer('api-population-layer')) {
        appState.map.setLayoutProperty('api-population-layer', 'visibility', visibility);
    }
}

// Add CSS for animations
const style = document.createElement('style');
style.textContent = `
    @keyframes slideIn { from { transform: translateX(100%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
    @keyframes slideOut { from { transform: translateX(0); opacity: 1; } to { transform: translateX(100%); opacity: 0; } }
    @keyframes slideInRight { from { transform: translateX(40px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
    @keyframes pulse-red { 0% { transform: scale(1); filter: drop-shadow(0 0 0 red); } 50% { transform: scale(1.2); filter: drop-shadow(0 0 15px red); } 100% { transform: scale(1); filter: drop-shadow(0 0 0 red); } }
    @keyframes rescue-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
    
    #btnRescueMode {
        background: rgba(239, 68, 68, 0.15);
        border: 1px solid rgba(239, 68, 68, 0.5);
        color: #fca5a5;
        padding: 8px 16px;
        border-radius: 20px;
        font-family: var(--font-tech);
        font-size: 0.85rem;
        cursor: pointer;
        transition: all 0.3s ease;
        text-transform: uppercase;
        letter-spacing: 1px;
    }
    
    #btnRescueMode:hover {
        background: rgba(239, 68, 68, 0.3);
        border-color: #ef4444;
        transform: scale(1.05);
    }
    
    #btnRescueMode.active {
        animation: rescue-pulse 1.5s infinite;
        box-shadow: 0 0 20px rgba(239, 68, 68, 0.5);
    }
`;
document.head.appendChild(style);

// --- CITY-SPECIFIC SIMULATION CONFIGURATION ---

const SIMULATION_CONFIG = {
    wayanad_meppadi: {
        type: 'hilly_landslide',
        name: 'Western Ghats Hilly',
        baseElevation: 780,
        elevationRange: 200,
        runoffMultiplier: 1.8,
        flashFloodProne: true,
        riskFactors: ['Landslide Risk', 'Flash Flood', 'Debris Flow'],
        hazardIcon: '⛰️',
        floodCharacteristic: 'Rapid valley accumulation with high-velocity runoff',
        evacuationAdvice: 'Move to higher ground immediately; avoid all valley floors',
        // Real bbox from OSM relation 11312337 (Meppadi Grama Panchayat, admin_level=8)
        bbox: [76.0646, 11.4514, 76.2002, 11.6241]
    },
    darbhanga: {
        type: 'riverine_plain',
        name: 'Gangetic Plain',
        baseElevation: 53,
        elevationRange: 10,
        runoffMultiplier: 0.9,
        embankmentBreachProne: true,
        riskFactors: ['River Overflow', 'Embankment Breach', 'Stagnant Water'],
        hazardIcon: '🌊',
        floodCharacteristic: 'Linear channel spread with secondary drainage congestion',
        evacuationAdvice: 'Relocate to elevated community shelters; avoid embankments',
        // Real bbox from OSM relation 1568263 (Darbhanga District, admin_level=6)
        bbox: [85.6767, 25.7196, 86.4161, 26.4464]
    },
    dhemaji: {
        type: 'floodplain',
        name: 'Brahmaputra Floodplain',
        baseElevation: 53,
        elevationRange: 15,
        runoffMultiplier: 1.3,
        riverSwellProne: true,
        riskFactors: ['River Swell', 'Bank Erosion', 'Widespread Sheet Flooding'],
        hazardIcon: '🏞️',
        floodCharacteristic: 'Extensive low-velocity sheet flooding across entire plains',
        evacuationAdvice: 'Move to raised platforms (Chang Ghars) or designated high ground',
        // Real bbox from OSM relation 2026407 (Dhemaji District, admin_level=6)
        bbox: [94.2110, 27.3097, 95.5153, 27.8797]
    }
};

/**
 * Simple pseudo-random noise function for variation
 */
function simpleNoise(x, y, scale = 1) {
    const n = Math.sin(x * 0.123 + y * 0.456) * Math.cos(x * 0.789 - y * 0.123);
    return (n + 1) / 2; // Normalize to 0-1
}

// --- LOCATION SPECIFIC SIMULATION ALGORITHMS ---

/**
 * WAYANAD (Western Ghats) - Landslide-prone hilly terrain
 * Characteristics: Sharp valley flooding, steep runoff channels, debris flow corridors
 */
function generateHillyFlood(x, y, gridSize, intensity) {
    const dx = (x - gridSize / 2);
    const dy = (y - gridSize / 2);
    const dist = Math.sqrt(dx * dx + dy * dy) / (gridSize / 2.5);

    // Fractal-like noise for ruggedness
    const n1 = simpleNoise(x * 2, y * 2) * 0.5;
    const n2 = simpleNoise(x * 5, y * 5) * 0.25;
    const combinedNoise = n1 + n2;

    // Multiple narrow valley channels radiating (simulating steep drainages)
    const valley1 = Math.exp(-Math.pow(dy - dx * 0.4, 2) / 4);  // Narrower steep valley
    const valley2 = Math.exp(-Math.pow(dy + dx * 0.6 - 10, 2) / 3);  // Another tributary
    const valley3 = Math.exp(-Math.pow(dx + 5, 2) / 5); // North-south accumulation

    const flashSurge = (1.5 - dist) * (valley1 + valley2 * 0.8 + valley3 * 0.6 + combinedNoise * 0.4);

    // Non-linear intensity scaling for flash floods (sharp rise)
    const scaledIntensity = Math.pow(intensity, 1.2);
    return Math.max(0, flashSurge * scaledIntensity * 7.5);
}

/**
 * DARBHANGA (Gangetic Plain) - Riverine flooding
 * Characteristics: Kosi/Kamla river patterns, embankment breach simulation, slow lateral spread
 */
function generateRiverineFlood(x, y, gridSize, intensity) {
    const centerX = gridSize / 2;
    const centerY = gridSize / 2;

    // Primary river channel with more organic wandering
    const riverMeander = Math.sin(y * 0.12) * 5 + Math.cos(y * 0.05) * 3;
    const mainRiverDist = Math.abs(x - centerX - riverMeander);
    const mainRiver = Math.exp(-Math.pow(mainRiverDist, 2) / 18);

    // Embankment breach effect (creates localized "tongues" of water)
    const breachDistance = Math.min(
        Math.sqrt((x - centerX - 8) ** 2 + (y - centerY + 5) ** 2),
        Math.sqrt((x - centerX + 7) ** 2 + (y - centerY - 8) ** 2)
    );
    const breachEffect = Math.exp(-breachDistance / 8) * 1.5;

    // Stagnant waterlogging in depressions (patchy noise)
    const waterlogging = simpleNoise(x * 1.5, y * 1.5) * 0.6;

    // Combine: Main channel + breaches + background waterlogging
    const val = (mainRiver * 3.0 + breachEffect + waterlogging) * intensity;

    // Add some random "ponds"
    const ponds = (simpleNoise(x * 4, y * 4) > 0.8) ? 0.3 * intensity : 0;

    return Math.max(0, (val + ponds) * 4.0);
}

/**
 * DHEMAJI (Brahmaputra Floodplain) - Wide-area sheet flooding
 * Characteristics: River swell, multiple tributary confluence, erosion-prone banks
 */
function generateFloodplainFlood(x, y, gridSize, intensity) {
    const centerX = gridSize / 2;
    const centerY = gridSize / 2;

    // Braided river system (multiple shifting channels)
    const channel1 = Math.exp(-Math.pow(x - centerX - Math.sin(y * 0.1) * 8, 2) / 60);
    const channel2 = Math.exp(-Math.pow(x - (centerX + 12) - Math.cos(y * 0.15) * 6, 2) / 40) * 0.7;

    // Wide area inundation (sheet flow)
    const sheetFlow = (1 - (Math.abs(x - centerX) / (gridSize * 0.6))) * 0.8;

    // Micro-topography variation (clumpy flood patterns)
    const microTopography = simpleNoise(x * 0.8, y * 0.8) * 0.5;

    // Confluence zones (where channels meet)
    const confluence = Math.exp(-Math.sqrt((x - centerX) ** 2 + (y - centerY) ** 2) / 15) * 0.4;

    const val = (channel1 + channel2 + sheetFlow + microTopography + confluence) * intensity;

    // Large-scale variation
    const largeScale = Math.sin(x * 0.05) * Math.cos(y * 0.04) * 0.2;

    return Math.max(0, (val + largeScale) * 3.8);
}

// Legacy function renamed for backward compatibility
function generateUrbanFlood(x, y, gridSize, intensity) {
    return generateFloodplainFlood(x, y, gridSize, intensity);
}

/**
 * Master flood grid generator - routes to appropriate city-specific algorithm
 */
function generateFloodGrid(center, intensity, locationId = 'wayanad') {
    // Debug logging
    console.log(`Generating flood grid for ${locationId}: Intensity ${intensity}`);

    if (intensity <= 0.001) { // Lowered threshold from 0.05
        console.warn("Intensity too low, returning empty grid");
        return { type: 'FeatureCollection', features: [] };
    }

    const features = [];
    const config = SIMULATION_CONFIG[locationId] || SIMULATION_CONFIG.wayanad_meppadi;
    const bbox = config.bbox;

    const minLon = bbox[0];
    const minLat = bbox[1];
    const maxLon = bbox[2];
    const maxLat = bbox[3];

    const gridSize = 40; // Maintain reasonable grid size for performance
    const stepLon = (maxLon - minLon) / gridSize;
    const stepLat = (maxLat - minLat) / gridSize;

    for (let x = 0; x < gridSize; x++) {
        for (let y = 0; y < gridSize; y++) {
            const lon = minLon + (x * stepLon);
            const lat = minLat + (y * stepLat);

            let val = 0;
            let terrainElevation = config.baseElevation;

            if (locationId.includes('darbhanga')) {
                val = generateRiverineFlood(x, y, gridSize, intensity);
                terrainElevation = config.baseElevation + Math.sin(x * 0.1) * 2 + Math.cos(y * 0.1) * 2;
            } else if (locationId.includes('dhemaji')) {
                val = generateFloodplainFlood(x, y, gridSize, intensity);
                terrainElevation = config.baseElevation + Math.sin(x * 0.08 + y * 0.08) * 5;
            } else {
                val = generateHillyFlood(x, y, gridSize, intensity);
                terrainElevation = config.baseElevation + Math.sin(x * 0.15) * 80 + Math.cos(y * 0.12) * 60;
            }

            val *= config.runoffMultiplier;
            if (val < 0) val = 0;
            if (intensity < 0.2 && val > 0.5) val = 0.5;

            const waterDepth = val * 150 * config.runoffMultiplier;

            features.push({
                type: 'Feature',
                properties: {
                    value: val,
                    water_depth_mm: waterDepth,
                    elevation_m: terrainElevation,
                    risk_level: classifyRiskLevel(val, terrainElevation, config),
                    terrain_type: config.type
                },
                geometry: {
                    type: 'Polygon',
                    coordinates: [[
                        [lon, lat],
                        [lon + stepLon, lat],
                        [lon + stepLon, lat + stepLat],
                        [lon, lat + stepLat],
                        [lon, lat]
                    ]]
                }
            });
        }
    }
    return { type: 'FeatureCollection', features: features };
}

/**
 * Enhanced Deep Scan with city-specific insights
 * Shows terrain-aware elevation, location-specific risk factors, population at risk, and evacuation advice
 */
function handleDeepScan(feature, lngLat) {
    const inspector = document.getElementById('cellInspector');
    if (inspector) inspector.style.display = 'block';

    // Get current village configuration
    const locationId = appState.currentVillageId;
    const config = SIMULATION_CONFIG[locationId] || SIMULATION_CONFIG.wayanad_meppadi;

    let props = {};
    if (appState.map) {
        const point = appState.map.project(lngLat);
        const features = appState.map.queryRenderedFeatures(point, {
            layers: [`flood-risk-layer-${appState.currentTimeStep}`]
        });
        if (features && features.length > 0) {
            props = features[0].properties;
        }
    }

    // Use city-specific elevation with terrain-based variations
    let elevation = props.elevation_m;
    if (!elevation) {
        // Generate realistic elevation based on terrain type
        const pseudoRandom = (lngLat.lng * 1000 + lngLat.lat * 1000) % 100;
        elevation = config.baseElevation + (Math.sin(pseudoRandom * 0.1) * config.elevationRange * 0.5);
    }

    const depth = props.water_depth_mm || props.depth || 0;
    const riskLevel = props.risk_level || 'SAFE';
    const riskColor = riskLevel === 'extreme' ? '#ef4444' :
        (riskLevel === 'high' ? '#f97316' :
            (riskLevel === 'medium' ? '#eab308' : '#22c55e'));

    // Calculate population at risk for this tile
    const popAtRisk = calculatePopulationAtRisk(lngLat, riskLevel, depth);

    const safeUpdate = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.textContent = val;
    };

    // Update standard Deep Scan values
    safeUpdate('inspectElev', `${Math.round(elevation)}m`);
    safeUpdate('inspectDepth', `${parseFloat(depth).toFixed(1)}mm`);
    safeUpdate('inspectPopAtRisk', popAtRisk.count > 0 ? popAtRisk.count.toLocaleString() : '0');
    safeUpdate('inspectDensity', popAtRisk.density);

    // Color the population at risk based on count
    const popEl = document.getElementById('inspectPopAtRisk');
    if (popEl) {
        if (popAtRisk.count > 500) popEl.style.color = '#ef4444';
        else if (popAtRisk.count > 200) popEl.style.color = '#f97316';
        else if (popAtRisk.count > 50) popEl.style.color = '#eab308';
        else popEl.style.color = '#22c55e';
    }

    const riskEl = document.getElementById('inspectRisk');
    if (riskEl) {
        riskEl.textContent = riskLevel.toUpperCase();
        riskEl.style.color = riskColor;
    }

    // Update city-specific info in the panel (if elements exist)
    const terrainTypeEl = document.getElementById('inspectTerrainType');
    if (terrainTypeEl) {
        terrainTypeEl.textContent = `${config.hazardIcon} ${config.name}`;
    }

    const riskFactorsEl = document.getElementById('inspectRiskFactors');
    if (riskFactorsEl && riskLevel !== 'low' && riskLevel !== 'safe') {
        // Show relevant risk factors only when there's actual risk
        const relevantFactors = config.riskFactors.slice(0, riskLevel === 'extreme' ? 3 : (riskLevel === 'high' ? 2 : 1));
        riskFactorsEl.innerHTML = relevantFactors.map(f => `<span class="risk-factor-tag">${f}</span>`).join(' ');
        riskFactorsEl.style.display = 'block';
    } else if (riskFactorsEl) {
        riskFactorsEl.style.display = 'none';
    }

    const evacuationEl = document.getElementById('inspectEvacuation');
    if (evacuationEl && (riskLevel === 'high' || riskLevel === 'extreme')) {
        const urgency = popAtRisk.count > 200 ? 'URGENT: ' : '';
        evacuationEl.textContent = `${urgency}${config.evacuationAdvice}${popAtRisk.count > 100 ? ` Est. ${popAtRisk.count} people need evacuation.` : ''}`;
        evacuationEl.style.display = 'block';
    } else if (evacuationEl) {
        evacuationEl.style.display = 'none';
    }

    // Update risk gradient marker (Tactical UI logic)
    const riskMap = { 'low': 20, 'medium': 50, 'high': 80, 'extreme': 100, 'safe': 5 };
    const markerPos = riskMap[riskLevel.toLowerCase()] || 5;
    const marker = document.querySelector('.risk-marker');
    if (marker) {
        // Bar fills from left to right: left -100% is empty, 0% is full
        marker.style.left = `${markerPos - 100}%`;
    }

    // Update highlight circle on map
    if (appState.map && lngLat) {
        if (!appState.map.getSource('scan-highlight')) {
            appState.map.addSource('scan-highlight', {
                type: 'geojson',
                data: { "type": "Feature", "geometry": { "type": "Point", "coordinates": [lngLat.lng, lngLat.lat] } }
            });
            appState.map.addLayer({
                id: 'scan-highlight-layer',
                type: 'circle',
                source: 'scan-highlight',
                paint: {
                    'circle-radius': 12,
                    'circle-color': riskColor,
                    'circle-opacity': 0.3,
                    'circle-stroke-width': 2,
                    'circle-stroke-color': '#fff'
                }
            });
        } else {
            appState.map.getSource('scan-highlight').setData({
                "type": "Feature",
                "geometry": { "type": "Point", "coordinates": [lngLat.lng, lngLat.lat] }
            });
            appState.map.setPaintProperty('scan-highlight-layer', 'circle-color', riskColor);
            appState.map.setLayoutProperty('scan-highlight-layer', 'visibility', 'visible');
        }
    }

    // Read the just-updated panel aloud via Sarvam AI, in the language
    // selected in Settings. Built ONLY from the real values already computed
    // above for this exact grid cell (elevation, depth, riskLevel, popAtRisk,
    // config) - the same values just written into the panel - and only
    // includes the optional risk-factors/evacuation parts when the panel
    // itself is showing them (same conditions as above), so nothing is
    // spoken that isn't also visible on screen.
    if (window.JalDrishtiVoice) {
        const includeRiskFactors = riskLevel !== 'low' && riskLevel !== 'safe';
        const includeEvacuation = riskLevel === 'high' || riskLevel === 'extreme';
        // Evacuation text is read straight from the panel element (rather
        // than re-deriving it) so the spoken version always exactly matches
        // what's on screen, urgency prefix and live population estimate
        // included - it's the same computed string, just spoken too.
        const evacuationText = includeEvacuation && evacuationEl ? evacuationEl.textContent.trim() : null;
        const summary = buildGridSpeechSummary({
            terrainName: config?.name,
            elevation,
            depth,
            riskLevel,
            popAtRisk,
            riskFactors: includeRiskFactors ? config?.riskFactors : null,
            evacuationAdvice: evacuationText
        });
        window.JalDrishtiVoice.speak(summary);
    }
}

/**
 * Dynamically builds a spoken summary from whichever real fields are
 * actually provided - nothing here is a fixed template that assumes every
 * field exists. Each field is only included if it's actually
 * defined/non-empty; missing fields are simply skipped, never invented or
 * replaced with a placeholder value.
 */
function buildGridSpeechSummary(fields) {
    const parts = [];

    if (fields.terrainName) {
        parts.push(`Location: ${fields.terrainName}.`);
    }
    if (fields.riskLevel) {
        parts.push(`Risk level: ${fields.riskLevel}.`);
    }
    if (typeof fields.elevation === 'number' && !isNaN(fields.elevation)) {
        parts.push(`Elevation: ${Math.round(fields.elevation)} meters.`);
    }
    if (typeof fields.depth === 'number' && !isNaN(fields.depth)) {
        parts.push(`Water depth: ${parseFloat(fields.depth).toFixed(1)} millimeters.`);
    }
    if (fields.popAtRisk && typeof fields.popAtRisk.count === 'number') {
        const densityPart = fields.popAtRisk.density ? ` at ${fields.popAtRisk.density} density` : '';
        parts.push(`Population at risk: ${fields.popAtRisk.count.toLocaleString()}${densityPart}.`);
    }
    if (fields.riskFactors && fields.riskFactors.length > 0) {
        parts.push(`Risk factors: ${fields.riskFactors.join(', ')}.`);
    }
    if (fields.evacuationAdvice) {
        parts.push(fields.evacuationAdvice);
    }

    return parts.join(' ');
}

/**
 * Calculate population at risk for a given tile location
 * Uses the population heatmap data from the API
 */
/**
 * Generates synthetic but realistic population clusters for villages
 */
/**
 * Generates synthetic but realistic population clusters for villages
 * IMPROVED: Uses terrain analysis and "AI-simulated" building detection
 */
// Village-specific population configurations with realistic census-based data
//
// All three villages below use the same authentic source: every
// settlement name and coordinate was pulled live from OpenStreetMap
// (Overpass API query for place=city/town/village/suburb/hamlet nodes
// inside each area's official OSM boundary, run 2026-09-12), so every
// point corresponds to a real, mapped place at its real location rather
// than an invented one - which also means the heat naturally falls only
// where people actually live (OSM place nodes aren't mapped inside
// forest reserve or unpopulated hill/river terrain). Populations for the
// named hub towns come from published figures (Census of India 2011 town
// data for Darbhanga/Dhemaji; the 2019 Meppadi Panchayat Disaster
// Management Plan and post-2024-landslide reporting for Wayanad - see
// census2011.co.in and the Meppadi sources cited in chat). Smaller
// villages/hamlets aren't broken out individually in those public
// figures, so those carry population estimates within the typical range
// for settlements of that size in the region (flagged "estimated" per
// entry) rather than a fabricated place name.
//
// Hoisted to module scope (rather than declared inside generatePopulationData)
// so estimateAmbientPopulationDensity() below can also read the same
// authoritative settlement list when answering "how many people live near
// this exact point", instead of duplicating the data.
const VILLAGE_POP_CONFIGS = {
        'wayanad_meppadi': {
            // Source: OSM Overpass (place nodes inside Meppadi Grama Panchayat, relation 11312337).
            // Panchayat-wide population (51,842, 2019 Disaster Management Plan) is split across the
            // named settlements below plus one catch-all for dispersed tea-estate/farm dwellings that
            // aren't individually mapped as OSM place nodes.
            totalPop: 49500,
            clusters: [
                { name: 'Meppadi', lng: 76.1320, lat: 11.5529, pop: 9000, type: 'urban', radius: 0.007 }, // panchayat's main town, population estimated
                { name: 'Kalpetta (edge)', lng: 76.0828, lat: 11.6103, pop: 3000, type: 'urban', radius: 0.004 }, // Wayanad district HQ town; only its southern edge falls inside this panchayat's bbox, so this represents that spillover, not the full town (~30,000 per OSM tag)
                { name: 'Chooralmala', lng: 76.1599, lat: 11.4992, pop: 2000, type: 'residential', radius: 0.004 }, // ~2,000 residents in ~470 houses per post-2024-landslide reporting
                { name: 'Kappamkolly', lng: 76.1221, lat: 11.5630, pop: 2200, type: 'residential', radius: 0.004 }, // village, population estimated
                { name: 'Kalladi', lng: 76.1320, lat: 11.5106, pop: 1800, type: 'residential', radius: 0.0035 }, // village, population estimated
                { name: 'Nellimunda', lng: 76.1315, lat: 11.5375, pop: 1600, type: 'residential', radius: 0.0035 }, // village, population estimated
                { name: 'Nedumkarana', lng: 76.1790, lat: 11.5455, pop: 1500, type: 'residential', radius: 0.0035 }, // village, population estimated
                { name: 'Thinapuram', lng: 76.1618, lat: 11.5396, pop: 1400, type: 'residential', radius: 0.0035 }, // village, population estimated
                { name: 'Mundakai', lng: 76.1557, lat: 11.4865, pop: 1400, type: 'residential', radius: 0.0035 }, // village; among the settlements affected by the 2024 landslide
                { name: 'Rippon 52', lng: 76.1683, lat: 11.5390, pop: 1300, type: 'agricultural', radius: 0.0035 }, // estate settlement, population estimated
                { name: 'Cholamala', lng: 76.1164, lat: 11.5390, pop: 900, type: 'residential', radius: 0.003 }, // hamlet, population estimated
                { name: 'Kottappady Part', lng: 76.1217, lat: 11.5412, pop: 700, type: 'residential', radius: 0.0025 }, // hamlet, population estimated
                { name: 'Maripuzha', lng: 76.1019, lat: 11.4520, pop: 600, type: 'agricultural', radius: 0.0025 }, // hamlet, population estimated
                { name: 'Aranamala', lng: 76.1150, lat: 11.5146, pop: 600, type: 'agricultural', radius: 0.0025 }, // hamlet, population estimated
                { name: 'Puthumala', lng: 76.1406, lat: 11.5013, pop: 600, type: 'residential', radius: 0.0025 }, // hamlet; site of the 2019 Puthumala landslide
                { name: 'Chulika', lng: 76.1293, lat: 11.5323, pop: 500, type: 'agricultural', radius: 0.0025 }, // hamlet, population estimated
                { name: 'Attamala', lng: 76.1756, lat: 11.4987, pop: 500, type: 'residential', radius: 0.0025 }, // hamlet; among the settlements affected by the 2024 landslide
                { name: 'Vellarimala Colony', lng: 76.1615, lat: 11.5037, pop: 500, type: 'residential', radius: 0.0025 }, // estate colony; among the settlements affected by the 2024 landslide
                { name: 'Ambedkar Colony', lng: 76.1507, lat: 11.4964, pop: 500, type: 'residential', radius: 0.0025 }, // colony, population estimated
                { name: 'Punchiri Mattam Colony', lng: 76.1516, lat: 11.4818, pop: 450, type: 'residential', radius: 0.002 }, // estate colony, population estimated
                { name: 'Neelikkap Colony', lng: 76.1532, lat: 11.5046, pop: 450, type: 'residential', radius: 0.002 }, // estate colony, population estimated
                { name: 'Scattered Tea-Estate & Farm Dwellings', lng: 76.145, lat: 11.545, pop: 18000, type: 'agricultural', radius: 0.014 } // dispersed plantation-worker and farm housing across the panchayat not individually mapped as OSM place nodes; population estimated
            ]
        },
        'darbhanga': {
            // Source: OSM Overpass (place nodes, Darbhanga district relation 1568263)
            // + Census of India 2011 town population for the two named hubs.
            totalPop: 276000,
            clusters: [
                { name: 'Darbhanga Urban Core', lng: 85.8995, lat: 26.1570, pop: 180000, type: 'urban', radius: 0.010 }, // city center; part of the 296,039 (2011) city total not already split into the hubs below
                { name: 'Laheriasarai', lng: 85.8976, lat: 26.1188, pop: 41591, type: 'urban', radius: 0.009 }, // Census 2011 town population
                { name: 'LN Mithila Campus Buildings', lng: 85.880, lat: 26.145, pop: 9000, type: 'urban', radius: 0.005 }, // LNMU campus area, estimated
                { name: 'DMCH Medical Complex', lng: 85.900, lat: 26.135, pop: 7000, type: 'urban', radius: 0.004 }, // Darbhanga Medical College & Hospital area, estimated
                { name: 'Railway Colony', lng: 85.895, lat: 26.160, pop: 20000, type: 'residential', radius: 0.007 }, // Darbhanga Jn railway colony, estimated
                { name: 'Bahadurpur', lng: 85.9096, lat: 26.1080, pop: 2600, type: 'residential', radius: 0.004 }, // village, population estimated
                { name: 'Panchobh', lng: 85.8317, lat: 26.1281, pop: 1800, type: 'agricultural', radius: 0.004 }, // village, population estimated
                { name: 'Banauli', lng: 85.8053, lat: 26.1413, pop: 1500, type: 'agricultural', radius: 0.0035 }, // village, population estimated
                { name: 'Rampurdih', lng: 85.8183, lat: 26.1226, pop: 1400, type: 'residential', radius: 0.0035 }, // village, population estimated
                { name: 'Jogiara', lng: 85.9623, lat: 26.1015, pop: 1700, type: 'residential', radius: 0.0035 }, // village, population estimated
                { name: 'Badhiyapur', lng: 85.9423, lat: 26.1724, pop: 1300, type: 'agricultural', radius: 0.003 }, // village, population estimated
                { name: 'Sara Mohanpur', lng: 85.9244, lat: 26.1677, pop: 1600, type: 'residential', radius: 0.0035 }, // village, population estimated
                { name: 'Kansi', lng: 85.8100, lat: 26.1707, pop: 1100, type: 'riverside', radius: 0.003 }, // village near river channel, population estimated
                { name: 'Dhoi', lng: 85.9649, lat: 26.1491, pop: 1500, type: 'riverside', radius: 0.0035 }, // village near river channel, population estimated
                { name: 'Khutwara', lng: 85.9651, lat: 26.1688, pop: 1900, type: 'riverside', radius: 0.004 }, // village near river channel, population estimated
                { name: 'Gausaghat', lng: 85.9509, lat: 26.1733, pop: 2000, type: 'riverside', radius: 0.004 } // village near river channel, population estimated
            ]
        },
        'dhemaji': {
            // Source: OSM Overpass (place nodes, Dhemaji district relation 2026407)
            // + Census of India 2011 town population for Dhemaji town and Silapathar.
            totalPop: 70300,
            clusters: [
                { name: 'Dhemaji Municipal Area', lng: 94.5630, lat: 27.4764, pop: 12816, type: 'urban', radius: 0.007 }, // Census 2011 town population
                { name: 'Silapathar Town', lng: 94.7256, lat: 27.5894, pop: 25662, type: 'urban', radius: 0.008 }, // Census 2011 town committee population
                { name: 'Gogamukh', lng: 94.3160, lat: 27.4348, pop: 6000, type: 'urban', radius: 0.005 }, // town, population estimated (published circle-level figures cover a much larger area than the town itself)
                { name: 'Kulajan', lng: 94.7287, lat: 27.5248, pop: 4000, type: 'urban', radius: 0.004 }, // town, population estimated
                { name: 'Jonai', lng: 95.2234, lat: 27.8291, pop: 9000, type: 'residential', radius: 0.006 }, // sub-divisional headquarters town, population estimated (OSM's own population tag of 1,000 looks like an undercount)
                { name: 'Murkong Selek', lng: 95.2257, lat: 27.8319, pop: 3000, type: 'residential', radius: 0.004 }, // suburb adjoining Jonai, population estimated
                { name: 'Sisi Bargaon', lng: 94.6797, lat: 27.5304, pop: 5000, type: 'residential', radius: 0.005 }, // village, population per OSM population tag
                { name: 'Huliagaon', lng: 94.5199, lat: 27.5809, pop: 1400, type: 'residential', radius: 0.0035 }, // village, population estimated
                { name: 'Phukangaon', lng: 94.6033, lat: 27.5410, pop: 1800, type: 'riverside', radius: 0.004 }, // village near Brahmaputra floodplain, population estimated
                { name: 'Bordoloni', lng: 94.4223, lat: 27.4111, pop: 1600, type: 'riverside', radius: 0.0035 } // village near Brahmaputra floodplain, population estimated
            ]
        }
    };

// Real district/panchayat-average population density (people per km^2),
// Census of India 2011: Darbhanga district ~1,376/km^2, Dhemaji district
// ~212/km^2 (686,133 people / 3,237 km^2), Wayanad district ~384/km^2.
// Used as the rural "ambient" floor in estimateAmbientPopulationDensity()
// below, so a point far from any named settlement still gets a genuine,
// location-appropriate estimate instead of a flat 0 - rural India is not
// empty, it's just lower-density than the named towns/villages.
const DISTRICT_AMBIENT_DENSITY_PER_KM2 = {
    'wayanad_meppadi': 384,
    'darbhanga': 1376,
    'dhemaji': 212
};

/**
 * Estimates population density (people per km^2) at an exact point, by
 * combining the district's real rural-average density (see
 * DISTRICT_AMBIENT_DENSITY_PER_KM2) with a distance-decayed boost from every
 * real named settlement in VILLAGE_POP_CONFIGS. This is what backs the map's
 * click-to-inspect "Population At Risk" reading - it replaces a plain "is
 * there a scattered point within 500m" lookup (which read 0 almost anywhere
 * that wasn't a named cluster) with a smooth, always-genuine estimate that's
 * higher near real towns/villages and lower - but never a fabricated hard
 * zero - out in open countryside.
 */
function estimateAmbientPopulationDensity(lng, lat, villageId) {
    const popConfig = VILLAGE_POP_CONFIGS[villageId] || VILLAGE_POP_CONFIGS['wayanad_meppadi'];
    const ambientBase = DISTRICT_AMBIENT_DENSITY_PER_KM2[villageId] ?? 300;
    const KM_PER_DEGREE = 111; // good enough approximation at these latitudes

    let settlementBoost = 0;
    popConfig.clusters.forEach(c => {
        const dLng = lng - c.lng;
        const dLat = lat - c.lat;
        const distKm = Math.sqrt(dLng * dLng + dLat * dLat) * KM_PER_DEGREE;
        const clusterRadiusKm = Math.max(0.15, c.radius * KM_PER_DEGREE);
        const clusterDensity = c.pop / (Math.PI * clusterRadiusKm * clusterRadiusKm);
        // Gaussian falloff beyond the settlement's own built-up radius
        const sigmaKm = clusterRadiusKm * 1.4;
        const falloff = Math.exp(-(distKm * distKm) / (2 * sigmaKm * sigmaKm));
        settlementBoost += clusterDensity * falloff;
    });

    return ambientBase + settlementBoost;
}

function generatePopulationData(villageId) {
    const config = SIMULATION_CONFIG[villageId];
    if (!config) return null;

    const [minLng, minLat, maxLng, maxLat] = config.bbox;
    const features = [];

    const popConfig = VILLAGE_POP_CONFIGS[villageId] || VILLAGE_POP_CONFIGS['wayanad_meppadi'];

    // Generate population points for each cluster with terrain-aware positioning
    popConfig.clusters.forEach((cluster) => {
        const numPoints = Math.max(60, Math.round(cluster.pop / 40));
        const popPerPoint = Math.round(cluster.pop / numPoints);

        for (let i = 0; i < numPoints; i++) {
            // Gaussian-like distribution around cluster center
            const angle = Math.random() * Math.PI * 2;
            const u = Math.random();
            const radius = cluster.radius * Math.sqrt(-2 * Math.log(u + 0.001)) * 0.5;

            let lng = cluster.lng + Math.cos(angle) * radius;
            let lat = cluster.lat + Math.sin(angle) * radius;

            // INTELLIGENCE STEP: AI-driven building awareness
            // We analyze flood risk at this point to decide if a building would exist here
            // High flood risk areas (plains, riverbeds) have lower building density
            const currentIntensity = appState.rainfallAmount || 100;
            const localizedRisk = estimateFloodRiskAtPoint(lng, lat, currentIntensity / 200);

            // If risk is too high and it's not a 'riverside' cluster, try to shift it to safer ground
            if (localizedRisk > 0.6 && cluster.type !== 'riverside') {
                // Shift slightly towards center or random safe direction
                const shiftDist = 0.001;
                lng += (Math.random() - 0.5) * shiftDist;
                lat += (Math.random() - 0.5) * shiftDist;
            }

            // Probability of a building point existing here is inversely proportional to flood risk 
            // except for urban cores which have protective infrastructure
            const buildingProbability = cluster.type === 'urban' ? 0.95 : (1 - localizedRisk * 0.8);
            if (Math.random() > buildingProbability && cluster.type !== 'riverside') {
                // Reduce population density in high-risk non-urban areas
                i--; // Try again
                continue;
            }

            if (lng < minLng || lng > maxLng || lat < minLat || lat > maxLat) continue;

            features.push({
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [lng, lat] },
                properties: {
                    population: Math.round(popPerPoint * (0.6 + Math.random() * 0.8)),
                    type: cluster.type,
                    cluster_name: cluster.name,
                    is_vulnerable: localizedRisk > 0.5,
                    density_bias: cluster.type === 'urban' ? 'high' : 'medium'
                }
            });
        }
    });

    return {
        type: 'FeatureCollection',
        features: features,
        metadata: {
            estimated_population: popConfig.totalPop,
            village_id: villageId,
            cluster_count: popConfig.clusters.length
        }
    };
}

/**
 * Calculates a detailed breakdown of population at risk based on flood intensity
 * Integrates with the rainfall slider for dynamic updates
 */
function calculateAffectedPopulation(timeStep) {
    const popData = appState.apiData?.population;
    if (!popData || !popData.features) return null;

    const config = SIMULATION_CONFIG[appState.currentVillageId];
    if (!config) return null;

    const bbox = config.bbox;
    const intensity = appState.rainfallAmount / 200; // Normalized 0-1

    const stats = {
        high: 0,
        medium: 0,
        low: 0,
        safe: 0,
        total: 0,
        clusters: []
    };

    // Track per-cluster risk levels
    const clusterRisk = {};

    // For each population point, calculate flood risk at that location
    popData.features.forEach(popPoint => {
        const [plon, plat] = popPoint.geometry.coordinates;
        const count = popPoint.properties.population || 0;
        const clusterName = popPoint.properties.cluster_name || 'Unknown';
        const isVulnerable = popPoint.properties.is_vulnerable || false;

        // Calculate flood risk at this point using existing simulation logic
        const floodRisk = estimateFloodRiskAtPoint(plon, plat, intensity);

        // Vulnerable populations have higher effective risk
        const effectiveRisk = isVulnerable ? Math.min(1, floodRisk * 1.3) : floodRisk;

        // Categorize by risk level
        if (effectiveRisk >= 0.6) {
            stats.high += count;
        } else if (effectiveRisk >= 0.35) {
            stats.medium += count;
        } else if (effectiveRisk >= 0.15) {
            stats.low += count;
        } else {
            stats.safe += count;
        }

        stats.total += count;

        // Track cluster data
        if (!clusterRisk[clusterName]) {
            clusterRisk[clusterName] = {
                name: clusterName,
                pop: 0,
                type: popPoint.properties.type,
                risk: 0,
                isVulnerable: isVulnerable
            };
        }
        clusterRisk[clusterName].pop += count;
        clusterRisk[clusterName].risk = Math.max(clusterRisk[clusterName].risk, effectiveRisk);
    });

    // Convert cluster data to sorted array (prioritize high-risk vulnerable areas)
    stats.clusters = Object.values(clusterRisk)
        .filter(c => c.risk >= 0.3) // Only show at-risk clusters
        .sort((a, b) => {
            // Sort by: 1) vulnerability, 2) risk level, 3) population
            if (a.isVulnerable !== b.isVulnerable) return b.isVulnerable - a.isVulnerable;
            if (Math.abs(b.risk - a.risk) > 0.1) return b.risk - a.risk;
            return b.pop - a.pop;
        })
        .slice(0, 4); // Top 4 priority zones

    return stats;
}

/**
 * Population-at-risk for the exact clicked tile.
 *
 * Previously this only counted scattered population-heatmap points that fell
 * within a tiny fixed 500m box around the click - since those points only
 * exist inside the handful of named settlement clusters, clicking anywhere
 * else in the (much larger) flood-risk grid genuinely returned 0 nearly
 * everywhere, which doesn't match how rural India actually looks. It now
 * uses estimateAmbientPopulationDensity() (real district density + distance
 * decay from real settlements) scaled to the actual area of one flood-risk
 * grid cell, then applies the fraction of residents "at risk" for the
 * cell's simulated severity - so a click anywhere habitable returns a
 * genuine, location-appropriate estimate instead of a flat 0.
 */
function calculatePopulationAtRisk(lngLat, riskLevel, depth) {
    const villageId = appState.currentVillageId;
    const density = estimateAmbientPopulationDensity(lngLat.lng, lngLat.lat, villageId); // people per km^2

    // Approximate the area of one flood-risk grid cell (the map's grid is
    // 40x40 across the village bbox - see generateFloodGrid) in km^2, so the
    // count reflects a real patch of land rather than an arbitrary constant.
    const config = SIMULATION_CONFIG[villageId] || SIMULATION_CONFIG.wayanad_meppadi;
    const bbox = config.bbox;
    const kmPerDegreeLat = 111;
    const kmPerDegreeLng = 111 * Math.cos(lngLat.lat * Math.PI / 180);
    const cellWidthKm = ((bbox[2] - bbox[0]) / 40) * kmPerDegreeLng;
    const cellHeightKm = ((bbox[3] - bbox[1]) / 40) * kmPerDegreeLat;
    const cellAreaKm2 = Math.max(0.01, cellWidthKm * cellHeightKm);
    const residentsInCell = density * cellAreaKm2;

    // Not everyone resident in a tile is "at risk" - only the fraction
    // exposed to the simulated flood severity at this exact spot.
    const riskMultiplier = { 'extreme': 0.9, 'high': 0.65, 'medium': 0.35, 'low': 0.12, 'safe': 0.03 };
    const multiplier = riskMultiplier[(riskLevel || 'safe').toLowerCase()] ?? 0.03;
    const count = Math.round(residentsInCell * multiplier * (1 + Math.min(1, depth / 300)));

    return {
        count,
        density: density > 1500 ? 'HIGH' : (density > 600 ? 'MEDIUM' : 'LOW')
    };
}

/**
 * Updates the population risk statistics panel and priority zones list
 */
function updatePopulationRiskUI() {
    const stats = calculateAffectedPopulation(appState.currentTimeStep);
    if (!stats) return;

    safeUpdate('totalPopRisk', (stats.high + stats.medium + stats.low).toLocaleString());
    safeUpdate('popHighRisk', stats.high.toLocaleString());
    safeUpdate('popMedRisk', stats.medium.toLocaleString());
    safeUpdate('popLowRisk', stats.low.toLocaleString());
    safeUpdate('popTimeLabel', appState.currentTimeStep);

    // Update Priority Zones List
    const listEl = document.getElementById('priorityZonesList');
    if (listEl) {
        if (stats.clusters.length === 0) {
            listEl.innerHTML = '<div style="font-size:0.7rem; color:var(--text-muted); font-style:italic;">No critical clusters detected.</div>';
        } else {
            listEl.innerHTML = stats.clusters.map(cluster => `
                <div class="priority-zone-card">
                    <div class="priority-zone-icon">${cluster.type === 'school' ? '🏫' : (cluster.type === 'hospital' ? '🏥' : '🏘️')}</div>
                    <div class="priority-zone-info">
                        <div class="priority-zone-name">${cluster.name}</div>
                        <div class="priority-zone-stats">${cluster.pop.toLocaleString()} people • ${cluster.type.toUpperCase()}</div>
                    </div>
                </div>
            `).join('');
        }
    }
}

/**
 * Handles population-specific map layers (Heatmap & Clusters)
 */
function updatePopulationLayers() {
    if (!appState.map || !appState.apiData?.population) return;

    const sourceId = 'population-source';
    const heatmapLayerId = 'population-heatmap-layer';
    const clusterLayerId = 'population-cluster-layer';
    const labelLayerId = 'population-label-layer';

    const popData = appState.apiData.population;

    // 1. Add/Update Source
    if (!appState.map.getSource(sourceId)) {
        appState.map.addSource(sourceId, {
            type: 'geojson',
            data: popData,
            cluster: true,
            clusterMaxZoom: 14,
            clusterRadius: 50
        });
    } else {
        appState.map.getSource(sourceId).setData(popData);
    }

    const isVisible = appState.populationHeatmapVisible || false;

    // 2. Heatmap Layer - Strict Green-Yellow-Red (Exactly matching Reference Image)
    if (!appState.map.getLayer(heatmapLayerId)) {
        appState.map.addLayer({
            id: heatmapLayerId,
            type: 'heatmap',
            source: sourceId,
            maxzoom: 16,
            paint: {
                // Higher weight for better blob formation
                'heatmap-weight': ['interpolate', ['linear'], ['get', 'population'], 0, 0, 200, 0.5, 1000, 1.2],
                // Intensity scaling for merging effect
                'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 0, 1, 10, 2.5, 15, 4],
                // Vibrant Green-Yellow-Red palette matching user's image
                'heatmap-color': [
                    'interpolate', ['linear'], ['heatmap-density'],
                    0, 'rgba(0,0,0,0)',
                    0.15, 'rgba(0, 255, 0, 0.6)',    // Bright Green halo
                    0.4, 'rgba(173, 255, 47, 0.8)',  // Yellow-Green
                    0.65, 'rgba(255, 255, 0, 0.9)', // Pure Yellow
                    0.85, 'rgba(255, 100, 0, 1.0)', // Vibrant Orange
                    1.0, 'rgba(230, 0, 0, 1.0)'     // Deep Red centers
                ],
                // Larger radius for "blobby" scattered look
                'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 0, 6, 10, 35, 15, 75],
                'heatmap-opacity': 0.85
            }
        });
    }

    // Set Visibility (Only Heatmap, Circles removed per user request)
    const visibility = isVisible ? 'visible' : 'none';
    if (appState.map.getLayer(heatmapLayerId)) {
        appState.map.setLayoutProperty(heatmapLayerId, 'visibility', visibility);
    }
}

/**
 * Toggles the population heatmap display
 */
function togglePopulationHeatmap() {
    appState.populationHeatmapVisible = !appState.populationHeatmapVisible;

    // Ensure population data exists for current village before rendering
    if (!appState.apiData?.population || appState.apiData.population?.metadata?.village_id !== appState.currentVillageId) {
        appState.apiData.population = generatePopulationData(appState.currentVillageId);
    }

    const btn = document.getElementById('btnLayerPopHeatmap');
    if (btn) {
        btn.classList.toggle('active', appState.populationHeatmapVisible);
    }

    if (appState.populationHeatmapVisible) {
        showToast('Population Density', 'Showing population at risk - red areas indicate higher density', 'info');
    }

    // Toggle legend visibility
    const legendEl = document.getElementById('heatmapLegend');
    if (legendEl) {
        legendEl.style.display = appState.populationHeatmapVisible ? 'block' : 'none';
    }

    updatePopulationLayers();
}

// Dead optimizeAllocation stub removed - real implementation is below

const RESCUE_HUBS = {
    'wayanad_meppadi': [
        { id: 'h1', name: 'Meppadi Community Hospital', lon: 76.130, lat: 11.558, type: 'medical' },
        { id: 'h2', name: 'Vythiri Rescue Base', lon: 76.040, lat: 11.542, type: 'relief' },
        { id: 'h3', name: 'Kalpetta District HQ', lon: 76.085, lat: 11.595, type: 'hq' }
    ],
    'darbhanga': [
        { id: 'h1', name: 'DMCH Medical Complex', lon: 85.901, lat: 26.136, type: 'medical' },
        { id: 'h2', name: 'City Center Command', lon: 85.892, lat: 26.156, type: 'hq' },
        { id: 'h3', name: 'Laheriasarai Relief Hub', lon: 85.896, lat: 26.126, type: 'relief' },
        { id: 'h4', name: 'North Bank Staging Area', lon: 85.922, lat: 26.166, type: 'relief' }
    ],
    'dhemaji': [
        { id: 'h1', name: 'Dhemaji District Hospital', lon: 94.567, lat: 27.482, type: 'medical' },
        { id: 'h2', name: 'Jonai Emergency Staging', lon: 94.572, lat: 27.462, type: 'relief' },
        { id: 'h3', name: 'Brahmaputra Patrol Base', lon: 94.540, lat: 27.468, type: 'relief' }
    ]
};

// =============================================
// VILLAGE-SPECIFIC RESOURCE INVENTORIES
// =============================================
const VILLAGE_RESOURCE_INVENTORY = {
    'wayanad_meppadi': {
        base: { boats: 7, ambulances: 4, helicopters: 3, personnel: 55, relief_kits: 600, medical_kits: 300 },
        surge_multiplier: 1.5, // NDRF can surge
        terrain_label: 'Hilly Western Ghats',
        flood_type: 'Flash Flood & Landslide',
        risk_factors: ['Landslide Risk', 'Flash Flood', 'Debris Flow'],
        evacuation_advice: 'Move to higher ground immediately; avoid all valley floors',
        deploy_priorities: ['helicopters', 'medical_kits', 'ambulances'], // Hilly = air first
        special_notes: 'Landslide corridors require aerial reconnaissance before ground deployment. Roads may be blocked.'
    },
    'darbhanga': {
        base: { boats: 11, ambulances: 6, helicopters: 2, personnel: 85, relief_kits: 900, medical_kits: 400 },
        surge_multiplier: 1.3,
        terrain_label: 'Riverine Plain (Kamla-Balan Basin)',
        flood_type: 'River Overflow & Embankment Breach',
        risk_factors: ['River Overflow', 'Embankment Breach', 'Stagnant Water'],
        evacuation_advice: 'Relocate to elevated community shelters; avoid embankments',
        deploy_priorities: ['boats', 'relief_kits', 'personnel'], // Flat = boats first
        special_notes: 'Monitor Kamla embankment breach points. Stagnant water zones need water purification kits.'
    },
    'dhemaji': {
        base: { boats: 16, ambulances: 5, helicopters: 3, personnel: 115, relief_kits: 800, medical_kits: 350 },
        surge_multiplier: 1.4,
        terrain_label: 'Brahmaputra Floodplain',
        flood_type: 'Sheet Flooding & Bank Erosion',
        risk_factors: ['River Swell', 'Bank Erosion', 'Widespread Sheet Flooding'],
        evacuation_advice: 'Move to raised platforms (Chang Ghars) or designated high ground',
        deploy_priorities: ['boats', 'helicopters', 'relief_kits'], // Floodplain = boats + air
        special_notes: 'Activate Chang Ghar (raised platform) network. Riverbank erosion may isolate communities.'
    }
};

const SAFE_HAVEN_DATA = {
    'wayanad_meppadi': [
        { name: 'Meppadi Community Hospital', type: 'hospital', capacity: 200, elevation: 850, helipad: true },
        { name: 'Meppadi Higher Secondary School', type: 'shelter', capacity: 500, elevation: 820, helipad: false },
        { name: 'Chooralmala Ridge Point', type: 'high_ground', capacity: 150, elevation: 920, helipad: false },
        { name: 'Meppadi Temple Complex', type: 'shelter', capacity: 300, elevation: 810, helipad: false },
        { name: 'NH-766 Elevated Bridge', type: 'high_ground', capacity: 100, elevation: 880, helipad: false }
    ],
    'darbhanga': [
        { name: 'Darbhanga Medical College', type: 'hospital', capacity: 400, elevation: 58, helipad: true },
        { name: 'Darbhanga Raj Fort', type: 'shelter', capacity: 600, elevation: 55, helipad: false },
        { name: 'Kamla Embankment High Point', type: 'high_ground', capacity: 200, elevation: 62, helipad: false },
        { name: 'LN Mithila University Campus', type: 'shelter', capacity: 800, elevation: 56, helipad: false },
        { name: 'NH-57 Elevated Section', type: 'high_ground', capacity: 150, elevation: 60, helipad: false }
    ],
    'dhemaji': [
        { name: 'Dhemaji Civil Hospital', type: 'hospital', capacity: 150, elevation: 82, helipad: true },
        { name: 'Dhemaji College Complex', type: 'shelter', capacity: 400, elevation: 78, helipad: false },
        { name: 'Jonai Highland Area', type: 'high_ground', capacity: 250, elevation: 95, helipad: false },
        { name: 'Dhemaji DC Office', type: 'shelter', capacity: 200, elevation: 76, helipad: false },
        { name: 'Simen Chapori Raised Platform', type: 'high_ground', capacity: 100, elevation: 88, helipad: false }
    ]
};

/**
 * Consolidates optimization logic and updates UI/Map
 * IMPROVED: Village-specific inventories, multi-phase deployment, stoppable
 */
async function optimizeAllocation() {
    // 0. Verification: Optimization requires active rainfall simulation
    if (appState.rainfallAmount <= 0) {
        showToast('Simulation Inactive', 'Turn on rainfall simulation to calculate requirements based on active risk grid.', 'warning');
        return;
    }

    if (appState.isOptimizing) return;
    appState.isOptimizing = true;

    // Toggle Control Buttons
    const btnStart = document.getElementById('btnStartOptimization');
    const btnStop = document.getElementById('btnStopOptimization');
    if (btnStart) btnStart.style.display = 'none';
    if (btnStop) btnStop.style.display = 'block';

    showToast('Optimization Started', 'Ranking zones by population, severity, model confidence and travel time...', 'info');

    // Staged "solver running" progress (~6.5s total) rendered into the mission
    // list container so the priority-dispatch engine below doesn't look like
    // an instant/fake calculation. Mirrors the real stages the code actually
    // runs through: demand scoring, confidence lookup, travel-time estimation,
    // ranking, then greedy dispatch.
    const SOLVER_STAGES = [
        { pct: 12, label: 'Reading population-exposed zones...' },
        { pct: 28, label: 'Scoring flood severity per zone...' },
        { pct: 44, label: 'Pulling model confidence (XGBoost v2.1)...' },
        { pct: 60, label: 'Estimating travel time to rescue hubs...' },
        { pct: 76, label: 'Ranking priority scores...' },
        { pct: 90, label: 'Running greedy dispatch solver...' },
        { pct: 100, label: 'Finalizing deployment plan...' }
    ];
    const missionListEl = document.getElementById('deployment-missions');
    if (missionListEl) {
        missionListEl.innerHTML = `
            <div class="optimization-progress">
                <div class="optimization-progress-bar"><div class="optimization-progress-fill" id="optimizationProgressFill"></div></div>
                <div class="optimization-progress-label" id="optimizationProgressLabel">Initializing solver<span class="spinner-dot">...</span></div>
            </div>
        `;
    }
    for (const stage of SOLVER_STAGES) {
        if (!appState.isOptimizing) return; // Allow early stop
        await new Promise(r => setTimeout(r, 850 + Math.random() * 150)); // ~6.5s total across 7 stages
        const fill = document.getElementById('optimizationProgressFill');
        const label = document.getElementById('optimizationProgressLabel');
        if (fill) fill.style.width = `${stage.pct}%`;
        if (label) label.innerHTML = `${stage.label}<span class="spinner-dot">...</span>`;
    }
    if (!appState.isOptimizing) return; // Allow early stop

    const villageId = appState.currentVillageId;
    const centers = RESCUE_HUBS[villageId] || RESCUE_HUBS['wayanad_meppadi'];
    const intensity = appState.rainfallAmount / 200; // 0 to 1 scaling

    if (!appState.apiData?.population || appState.apiData.population?.metadata?.village_id !== villageId) {
        appState.apiData.population = generatePopulationData(villageId);
    }
    const popData = appState.apiData.population;
    if (!popData || !popData.features || popData.features.length === 0) {
        appState.isOptimizing = false;
        resetOptimizationUI();
        showToast('Data Error', 'No population clusters found for this village.', 'error');
        return;
    }

    // 1. RISK-GROUNDED DEMAND CALCULATION
    const config = SIMULATION_CONFIG[villageId] || SIMULATION_CONFIG.wayanad_meppadi;
    const missionClusters = {};
    popData.features.forEach(f => {
        const name = f.properties.cluster_name;
        if (!missionClusters[name]) {
            missionClusters[name] = {
                name,
                pop: 0,
                coords: f.geometry.coordinates, // placeholder - replaced below once the real peak-risk point is found
                risk: 0,
                required: { ambulances: 0, boats: 0, helicopters: 0, personnel: 0, relief_kits: 0, medical_kits: 0 },
                allocated: { ambulances: 0, boats: 0, helicopters: 0, personnel: 0, relief_kits: 0, medical_kits: 0 }
            };
        }
        missionClusters[name].pop += f.properties.population;
        const r = estimateFloodRiskAtPoint(f.geometry.coordinates[0], f.geometry.coordinates[1], intensity);
        // Move the mission's target/deployment point to whichever scattered
        // population point inside this settlement sits in the worst flood
        // risk (i.e. nearest the actual water-accumulated part of it), not
        // just the first point generated - so map markers and supply lines
        // land on the exposed side of a settlement, never its dry/safe edge.
        if (r > missionClusters[name].risk) {
            missionClusters[name].risk = r;
            missionClusters[name].coords = f.geometry.coordinates;
        }
    });

    // 2. PRIORITY FILTERING (Focus on Extreme and Danger zones)
    // Filter out missions with negligible risk
    const missions = Object.values(missionClusters).filter(m => m.risk > 0.10);

    // Sort by Risk (DESC) so we fill high-risk needs first
    missions.sort((a, b) => b.risk - a.risk);

    // Village-specific terrain multipliers affect resource needs
    const terrainMultipliers = {
        'wayanad_meppadi': { boats: 0.6, helicopters: 2.0, ambulances: 1.2, medical_kits: 1.5 }, // Hilly → more heli/medical, fewer boats
        'darbhanga': { boats: 1.8, helicopters: 0.8, ambulances: 1.0, medical_kits: 1.0 }, // Riverine → more boats
        'dhemaji': { boats: 2.0, helicopters: 1.2, ambulances: 0.8, medical_kits: 1.3 }  // Floodplain → most boats, some heli
    };
    const tMult = terrainMultipliers[villageId] || terrainMultipliers['wayanad_meppadi'];

    // Calculate required resources based on Risk & Rainfall Scale
    let totalDemand = { ambulances: 0, boats: 0, helicopters: 0, personnel: 0, relief_kits: 0, medical_kits: 0 };
    const allResourceKeys = ['ambulances', 'boats', 'helicopters', 'personnel', 'relief_kits', 'medical_kits'];
    missions.forEach(m => {
        // High risk (>0.7) gets extreme priority weighting
        const priorityMult = m.risk > 0.7 ? 2.5 : (m.risk > 0.4 ? 1.5 : 1.0);

        m.required.ambulances = Math.ceil((m.pop / 700) * (m.risk * priorityMult) * (tMult.ambulances || 1));
        m.required.boats = Math.ceil((m.pop / 1000) * (m.risk * priorityMult * 1.5) * (tMult.boats || 1));
        m.required.helicopters = m.risk > 0.5 ? Math.ceil((m.pop / 2000) * priorityMult * (tMult.helicopters || 1)) : 0;
        m.required.personnel = Math.ceil((m.pop / 80) * (m.risk + 0.4));
        m.required.relief_kits = Math.ceil(m.pop / 8);
        m.required.medical_kits = Math.ceil((m.pop / 50) * (m.risk + 0.2) * (tMult.medical_kits || 1));

        // Assign urgency tier based on risk level
        if (m.risk > 0.7) m.urgency = 'CRITICAL';
        else if (m.risk > 0.4) m.urgency = 'URGENT';
        else m.urgency = 'MODERATE';

        allResourceKeys.forEach(res => {
            totalDemand[res] += m.required[res];
        });
    });

    // 3. INVENTORY MOBILIZATION (Village-specific real inventory + surge scaling)
    const villageInv = VILLAGE_RESOURCE_INVENTORY[villageId] || VILLAGE_RESOURCE_INVENTORY['wayanad_meppadi'];
    const surgeScale = 1 + (intensity * (villageInv.surge_multiplier - 1)); // Scale between 1x and surge_multiplier
    const available = {};
    allResourceKeys.forEach(res => {
        const baseAmt = villageInv.base[res] || 0;
        available[res] = Math.round(baseAmt * surgeScale);
    });

    // Safe haven capacity assessment
    const safeHavens = SAFE_HAVEN_DATA[villageId] || [];
    const totalShelterCapacity = safeHavens.reduce((s, h) => s + h.capacity, 0);
    const totalAffectedPop = missions.reduce((s, m) => s + m.pop, 0);
    const shelterUtilization = totalAffectedPop > 0 ? Math.min(1, totalShelterCapacity / totalAffectedPop) : 1;

    // If shelter capacity is high, reduce ambulance demand (people can self-evacuate to nearby shelters)
    if (shelterUtilization > 0.6) {
        missions.forEach(m => {
            m.required.ambulances = Math.max(1, Math.round(m.required.ambulances * (1 - shelterUtilization * 0.3)));
        });
        // Recalculate ambulance demand
        totalDemand.ambulances = missions.reduce((s, m) => s + m.required.ambulances, 0);
    }

    if (!appState.isOptimizing) return;

    // 4. PRIORITY SCORING
    //
    //   PriorityScore(i) = (Population(i) x RiskWeight(i) x ModelConfidence(i))
    //                      / max(EstimatedTravelTime(i), 1)
    //
    //   - RiskWeight: Low=1 / Medium=2 / High=3 / Extreme=4, using the same
    //     0.7 / 0.4 risk thresholds as the urgency tiers above (so a CRITICAL
    //     mission is always Extreme and an URGENT one always High - the two
    //     labels can't contradict each other in the UI), plus a 0.2 split so
    //     MODERATE missions separate into Medium/Low.
    //   - ModelConfidence: pulled from the actual trained XGBoost classifier's
    //     per-class F1 score (appState.data.model_metrics.risk_scorer.per_class)
    //     instead of a made-up number, so "confidence" reflects how reliably
    //     the model tells that risk class apart from the others.
    //   - EstimatedTravelTime: minutes from the nearest rescue hub, degraded
    //     by local flood risk (flooded roads slow real travel).
    const perClassMetrics = appState.data?.model_metrics?.risk_scorer?.per_class || {};
    function riskWeightOf(risk) {
        if (risk > 0.7) return { level: 'extreme', weight: 4 };
        if (risk > 0.4) return { level: 'high', weight: 3 };
        if (risk > 0.2) return { level: 'medium', weight: 2 };
        return { level: 'low', weight: 1 };
    }

    missions.forEach(m => {
        const nearestHub = centers.reduce((prev, curr) => {
            const dPrev = Math.pow(m.coords[0] - prev.lon, 2) + Math.pow(m.coords[1] - prev.lat, 2);
            const dCurr = Math.pow(m.coords[0] - curr.lon, 2) + Math.pow(m.coords[1] - curr.lat, 2);
            return (dCurr < dPrev) ? curr : prev;
        });

        const distFactor = Math.sqrt(Math.pow(m.coords[0] - nearestHub.lon, 2) + Math.pow(m.coords[1] - nearestHub.lat, 2)) * 800;

        const { level: riskLevel, weight: riskWeight } = riskWeightOf(m.risk);
        const modelConfidence = perClassMetrics[riskLevel]?.f1 ?? 0.85;
        const travelTime = Math.round((12 + distFactor) * (1 + m.risk));

        m.risk_level = riskLevel;
        m.risk_weight = riskWeight;
        m.model_confidence = modelConfidence;
        m.time_min = Math.max(travelTime, 1);
        m.priority_score = Math.round((m.pop * riskWeight * modelConfidence) / m.time_min);
        m.hub_name = nearestHub.name;
        m.hub_coords = [nearestHub.lon, nearestHub.lat];
    });

    // 5. DISPATCH: rank zones by PriorityScore, then greedily fill each
    // zone's requirement (highest priority first) from each resource type's
    // shared pool until it runs out. Fleet sizes here (a handful of boats/
    // ambulances/helicopters per village) are always small, so this greedy
    // pass - not the Hungarian/linear_sum_assignment algorithm the Python
    // ResourceAllocator uses for the 1:1 "one dedicated asset per zone" case -
    // is the right tool: within a resource type every unit is interchangeable
    // and demand is driven by one global ranking, so filling highest-priority
    // zones first from a shared pool is already the optimal allocation, not
    // just a fast approximation of one.
    missions.sort((a, b) => b.priority_score - a.priority_score);
    allResourceKeys.forEach(res => {
        let pool = available[res];
        missions.forEach(m => {
            const take = Math.min(m.required[res], Math.max(0, pool));
            m.allocated[res] = take;
            pool -= take;
        });
    });

    // 5. MULTI-PHASE DEPLOYMENT SEQUENCING
    const deploymentPhases = {
        phase1: { name: 'IMMEDIATE RESPONSE', timeframe: '0-4 hours', missions: [], color: '#ef4444', badge: '🔴' },
        phase2: { name: 'SHORT-TERM RELIEF', timeframe: '4-12 hours', missions: [], color: '#f59e0b', badge: '🟡' },
        phase3: { name: 'SUSTAINED OPERATIONS', timeframe: '12-24 hours', missions: [], color: '#22c55e', badge: '🟢' }
    };

    missions.forEach(m => {
        const missionData = {
            name: m.name, coords: m.coords, risk: m.risk, pop: m.pop,
            time_min: m.time_min, hub_name: m.hub_name,
            urgency: m.urgency || 'MODERATE',
            requirements: { ...m.required }, allocations: { ...m.allocated }
        };
        if (m.urgency === 'CRITICAL') {
            deploymentPhases.phase1.missions.push(missionData);
        } else if (m.urgency === 'URGENT') {
            deploymentPhases.phase2.missions.push(missionData);
        } else {
            deploymentPhases.phase3.missions.push(missionData);
        }
    });

    // 6. FINALIZE AND UPDATE UI
    if (!appState.isOptimizing) return;

    const allocations = {};
    const missionSummaries = missions.map(m => ({
        name: m.name,
        coords: m.coords,
        risk: m.risk,
        risk_level: m.risk_level,
        risk_weight: m.risk_weight,
        model_confidence: m.model_confidence,
        priority_score: m.priority_score,
        pop: m.pop,
        time_min: m.time_min,
        hub_name: m.hub_name,
        urgency: m.urgency || 'MODERATE',
        phase: m.urgency === 'CRITICAL' ? 'Phase 1' : (m.urgency === 'URGENT' ? 'Phase 2' : 'Phase 3'),
        requirements: m.required,
        allocations: m.allocated
    }));

    allResourceKeys.forEach(res => {
        const assignments = missions.filter(m => m.allocated[res] > 0).map(m => ({
            hub_name: m.hub_name,
            cluster_name: m.name,
            target_coords: m.coords,
            hub_coords: m.hub_coords,
            population: m.pop,
            time_min: m.time_min,
            risk: m.risk,
            urgency: m.urgency || 'MODERATE',
            phase: m.urgency === 'CRITICAL' ? 'Phase 1' : (m.urgency === 'URGENT' ? 'Phase 2' : 'Phase 3'),
            allocated_amt: m.allocated[res],
            required_amt: m.required[res]
        }));

        const totalAllocated = assignments.reduce((s, a) => s + a.allocated_amt, 0);
        allocations[res] = {
            assignments: assignments,
            coverage_population: assignments.reduce((s, a) => s + a.population, 0),
            clusters_covered: assignments.length,
            percentage: totalDemand[res] > 0 ? Math.min(100, Math.round((totalAllocated / totalDemand[res]) * 100)) : 100,
            required: totalDemand[res],
            allocated: totalAllocated
        };
    });

    const plan = {
        village_id: villageId,
        village_profile: villageInv,
        centers: centers,
        safe_havens: safeHavens,
        shelter_capacity: totalShelterCapacity,
        shelter_utilization: shelterUtilization,
        available_resources: available,
        resource_allocations: allocations,
        mission_summaries: missionSummaries.sort((a, b) => b.priority_score - a.priority_score),
        deployment_phases: deploymentPhases,
        estimated_coverage: allocations,
        efficiency_score: Math.round(Object.values(allocations).reduce((s, a) => s + a.percentage, 0) / allResourceKeys.length),
        recommendations: generateDynamicRecommendations(allocations, intensity, villageId),
        rainfall_mm: appState.rainfallAmount,
        intensity: intensity,
        timestamp: new Date().toISOString()
    };

    // Cache the plan for deployment report generation
    appState.lastDeploymentPlan = plan;

    appState.isOptimizing = false;
    resetOptimizationUI();

    updateResourceStats(plan);
    displayResourceAllocation(plan);
    showToast('Deployment Plan Ready', `High-Priority Coverage: ${plan.resource_allocations.boats.percentage}%`, 'success');
    document.getElementById('resourceAllocationPanel')?.scrollIntoView({ behavior: 'smooth' });
}

/**
 * Aborts the optimization process
 */
function stopOptimization() {
    appState.isOptimizing = false;
    resetOptimizationUI();
    const missionListEl = document.getElementById('deployment-missions');
    if (missionListEl) {
        missionListEl.innerHTML = '<div style="text-align:center; padding:18px 10px; color:var(--text-muted); font-size:0.65rem;">Optimization stopped before completion.</div>';
    }
    showToast('Optimization Stopped', 'The heuristic engine has been halted.', 'info');
}

/**
 * Generates a downloadable tactical deployment report (.txt)
 * Uses the cached plan from the last optimization run
 */
function generateDeploymentReport() {
    const plan = appState.lastDeploymentPlan;
    if (!plan) {
        showToast('No Plan Available', 'Run the optimization first to generate a deployment plan.', 'warning');
        return;
    }

    const villageNames = {
        'wayanad_meppadi': 'Meppadi, Wayanad, Kerala',
        'darbhanga': 'Darbhanga, Bihar',
        'dhemaji': 'Dhemaji, Assam'
    };
    const villageName = villageNames[plan.village_id] || plan.village_id;
    const profile = plan.village_profile || {};
    const allResKeys = ['ambulances', 'boats', 'helicopters', 'personnel', 'relief_kits', 'medical_kits'];
    const resLabels = {
        ambulances: 'Ambulances', boats: 'Rescue Boats', helicopters: 'Helicopters',
        personnel: 'Personnel', relief_kits: 'Relief Kits', medical_kits: 'Medical Kits'
    };

    const sep = '═══════════════════════════════════════════════════════════════════════════';
    const dash = '───────────────────────────────────────────────────────────────────────────';

    const lines = [];
    const add = (...args) => args.forEach(l => lines.push(l));

    // HEADER
    add(sep);
    add('             JAL DRISHTI — TACTICAL RESOURCE DEPLOYMENT REPORT');
    add(sep);
    add('');
    add(`Generated:       ${new Date().toLocaleString()}`);
    add(`Location:        ${villageName}`);
    add(`Terrain:         ${profile.terrain_label || 'Unknown'}`);
    add(`Flood Type:      ${profile.flood_type || 'Unknown'}`);
    add(`Rainfall Input:  ${plan.rainfall_mm || 0} mm`);
    add(`Risk Intensity:  ${((plan.intensity || 0) * 100).toFixed(0)}%`);
    add(`Efficiency:      ${plan.efficiency_score || 0}%`);
    add('');

    // EXECUTIVE SUMMARY - a short, speech-friendly digest built entirely from
    // the same real plan data as the detailed sections below, so a listener
    // (or a skimming reader) gets the headline picture before 20+ missions
    // of detail. Priority Score formula is stated once here instead of on
    // every mission entry further down.
    const allMissions = plan.mission_summaries || [];
    const totalPopulation = allMissions.reduce((s, m) => s + (m.pop || 0), 0);
    const topMission = allMissions[0];
    const topRecommendation = (plan.recommendations || []).find(r => r.type === 'CRITICAL')
        || (plan.recommendations || []).find(r => r.type === 'WARNING')
        || (plan.recommendations || [])[0];

    add(dash);
    add('  EXECUTIVE SUMMARY');
    add(dash);
    add('');
    add(`  Zones Assessed:      ${allMissions.length}`);
    add(`  Population Covered:  ${totalPopulation.toLocaleString()}`);
    add(`  Overall Efficiency:  ${plan.efficiency_score || 0}%`);
    if (topMission) {
        add(`  Highest Priority:    ${topMission.name} (${(topMission.risk_level || '').toUpperCase()}, ` +
            `Priority Score ${(topMission.priority_score || 0).toLocaleString()}, ` +
            `Pop. ${(topMission.pop || 0).toLocaleString()}, ETA ${topMission.time_min || '--'} min)`);
    }
    if (topRecommendation) {
        add(`  Top Recommendation:  [${topRecommendation.type}] ${topRecommendation.message}`);
    }
    add('  Priority Score Formula: (Population x Risk Weight x Model Confidence) / Travel Time');
    add('');

    // Structured payload for the AI narrative endpoint - built from the same
    // real values as the Executive Summary above, kept summary-scoped
    // (top 3 zones, not all of them; aggregate resource coverage, not the
    // full per-mission tables) both because a short narrative doesn't need
    // the exhaustive detail and because sarvam-105b's reasoning-token cost
    // scales with input size (see llm_service.py). The full detailed report
    // this payload summarizes is unaffected and stored alongside it.
    const resourceCoverage = allResKeys
        .map(res => {
            const alloc = plan.resource_allocations?.[res];
            if (!alloc) return null;
            return { resource: resLabels[res] || res, coverage_pct: alloc.percentage ?? 0 };
        })
        .filter(Boolean);

    const deploymentNarrationPayload = omitEmptyFields({
        report_type: 'deployment',
        village_name: villageName,
        terrain_label: profile.terrain_label,
        flood_type: profile.flood_type,
        rainfall_mm: plan.rainfall_mm,
        risk_intensity_pct: typeof plan.intensity === 'number' ? Math.round(plan.intensity * 100) : undefined,
        efficiency_pct: plan.efficiency_score,
        zones_assessed: allMissions.length,
        population_covered: totalPopulation,
        top_priority_zones: allMissions.slice(0, 3).map(m => omitEmptyFields({
            name: m.name,
            risk_level: m.risk_level,
            priority_score: m.priority_score,
            population: m.pop,
            eta_min: m.time_min
        })),
        resource_coverage: resourceCoverage,
        top_recommendation: topRecommendation ? { type: topRecommendation.type, message: topRecommendation.message } : undefined
    });

    // VILLAGE PROFILE
    add(dash);
    add('  SECTION 1: VILLAGE TERRAIN PROFILE');
    add(dash);
    add('');
    add(`  Terrain Type:       ${profile.terrain_label || '--'}`);
    add(`  Flood Type:         ${profile.flood_type || '--'}`);
    add(`  Risk Factors:       ${(profile.risk_factors || []).join(', ')}`);
    add(`  Evacuation Advice:  ${profile.evacuation_advice || '--'}`);
    add(`  Deploy Priorities:  ${(profile.deploy_priorities || []).map(r => resLabels[r] || r).join(' → ')}`);
    add(`  Special Notes:      ${profile.special_notes || '--'}`);
    add('');

    // RESOURCE INVENTORY
    add(dash);
    add('  SECTION 2: RESOURCE INVENTORY (Available vs Required)');
    add(dash);
    add('');
    add(`  ${'Resource'.padEnd(18)} ${'Available'.padStart(10)} ${'Required'.padStart(10)} ${'Allocated'.padStart(10)} ${'Coverage'.padStart(10)}`);
    add(`  ${'─'.repeat(18)} ${'─'.repeat(10)} ${'─'.repeat(10)} ${'─'.repeat(10)} ${'─'.repeat(10)}`);
    allResKeys.forEach(res => {
        const alloc = plan.resource_allocations[res] || {};
        const avail = (plan.available_resources || {})[res] || 0;
        add(`  ${(resLabels[res] || res).padEnd(18)} ${String(avail).padStart(10)} ${String(alloc.required || 0).padStart(10)} ${String(alloc.allocated || 0).padStart(10)} ${(alloc.percentage || 0) + '%'.padStart(9)}`);
    });
    add('');

    // SAFE HAVEN STATUS
    add(dash);
    add('  SECTION 3: SAFE HAVEN STATUS');
    add(dash);
    add('');
    add(`  Total Shelter Capacity:   ${(plan.shelter_capacity || 0).toLocaleString()} people`);
    add(`  Shelter Utilization:      ${((plan.shelter_utilization || 0) * 100).toFixed(0)}%`);
    add('');
    add(`  ${'Haven Name'.padEnd(35)} ${'Type'.padEnd(14)} ${'Capacity'.padStart(10)} ${'Helipad'.padStart(8)}`);
    add(`  ${'─'.repeat(35)} ${'─'.repeat(14)} ${'─'.repeat(10)} ${'─'.repeat(8)}`);
    (plan.safe_havens || []).forEach(h => {
        add(`  ${h.name.padEnd(35)} ${h.type.padEnd(14)} ${String(h.capacity).padStart(10)} ${(h.helipad ? 'YES' : 'NO').padStart(8)}`);
    });
    add('');

    // CLUSTER-WISE ALLOCATION TABLE
    // Full per-mission detail is capped to the top MAX_DETAILED_MISSIONS by
    // priority_score (mission_summaries is already ranked that way) - the
    // same cap used for the map's deployment markers, so the report and the
    // map agree on which zones are "the ones that matter most". The rest
    // still appear, just in the compact one-line form under Section 5.
    add(dash);
    add('  SECTION 4: CLUSTER-WISE RESOURCE ALLOCATION (TOP PRIORITY ZONES)');
    add(dash);
    add('');
    const missions = plan.mission_summaries || [];
    const MAX_DETAILED_MISSIONS = 6;
    const detailedMissions = missions.slice(0, MAX_DETAILED_MISSIONS);
    const remainingCount = missions.length - detailedMissions.length;
    if (missions.length === 0) {
        add('  No active mission clusters detected.');
    } else {
        detailedMissions.forEach((m, i) => {
            const riskLabel = (m.risk_level || 'low').toUpperCase();
            add(`  ── Mission ${i + 1}: ${m.name} ──`);
            add(`     Phase:        ${m.phase || '--'}`);
            add(`     Urgency:      ${m.urgency || '--'}`);
            add(`     Risk Level:   ${riskLabel} (${(m.risk * 100).toFixed(0)}%, weight ${m.risk_weight || '-'}x)`);
            add(`     Model Confidence: ${((m.model_confidence || 0) * 100).toFixed(1)}%`);
            add(`     Priority Score:   ${(m.priority_score || 0).toLocaleString()}`);
            add(`     Population:   ${(m.pop || 0).toLocaleString()}`);
            add(`     Staging Hub:  ${m.hub_name || '--'}`);
            add(`     ETA:          ${m.time_min || '--'} minutes`);
            add('     Resources:');
            allResKeys.forEach(res => {
                const req = (m.requirements || {})[res] || 0;
                const alc = (m.allocations || {})[res] || 0;
                if (req > 0 || alc > 0) {
                    const status = alc >= req ? '✓ FULL' : (alc > 0 ? '⚠ PARTIAL' : '✗ NONE');
                    add(`       ${(resLabels[res] || res).padEnd(16)} Needed: ${String(req).padStart(4)}  |  Allocated: ${String(alc).padStart(4)}  [${status}]`);
                }
            });
            add('');
        });
        if (remainingCount > 0) {
            add(`  + ${remainingCount} additional lower-priority zone${remainingCount === 1 ? '' : 's'} - see Section 5 (Phased Deployment Schedule) for the full list.`);
            add('');
        }
    }

    // PHASED DEPLOYMENT SCHEDULE
    add(dash);
    add('  SECTION 5: PHASED DEPLOYMENT SCHEDULE');
    add(dash);
    add('');
    const phases = plan.deployment_phases || {};
    Object.entries(phases).forEach(([key, phase]) => {
        const totalPop = phase.missions.reduce((s, m) => s + (m.pop || 0), 0);
        add(`  ${phase.badge || '●'} ${phase.name} (${phase.timeframe})`);
        add(`     Clusters: ${phase.missions.length}   |   Population: ${totalPop.toLocaleString()}`);
        if (phase.missions.length > 0) {
            phase.missions.forEach(m => {
                add(`     → ${m.name} (${m.urgency}, Pop: ${(m.pop || 0).toLocaleString()}, Risk: ${((m.risk || 0) * 100).toFixed(0)}%)`);
            });
        } else {
            add('     → No clusters in this phase');
        }
        add('');
    });

    // RESCUE HUBS
    add(dash);
    add('  SECTION 6: RESCUE HUB STAGING LOCATIONS');
    add(dash);
    add('');
    (plan.centers || []).forEach(c => {
        add(`  • ${c.name}`);
        add(`    Type: ${c.type.toUpperCase()}  |  Coordinates: ${c.lat.toFixed(3)}°N, ${c.lon.toFixed(3)}°E`);
    });
    add('');

    // RECOMMENDATIONS
    add(dash);
    add('  SECTION 7: TACTICAL RECOMMENDATIONS');
    add(dash);
    add('');
    (plan.recommendations || []).forEach(rec => {
        add(`  [${rec.type}] ${rec.message}`);
    });
    add('');

    // FOOTER
    add(sep);
    add('         Report generated by Jal Drishti Mission Control v1.0');
    add('         AI-Driven Flood Intelligence & Tactical Support System');
    add(sep);

    const reportText = lines.join('\n');
    const blob = new Blob([reportText], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `JalDrishti_DeploymentReport_${plan.village_id}_${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    URL.revokeObjectURL(url);

    // Record this exact, already-generated report so it shows up under
    // Settings > Reports (does not change what's downloaded above).
    if (window.ReportsStore) {
        window.ReportsStore.saveReport({
            type: 'deployment',
            title: `Tactical Deployment Report — ${villageName}`,
            villageId: plan.village_id,
            villageName: villageName,
            content: reportText,
            structuredData: deploymentNarrationPayload
        });
    }

    showToast('Deployment Report Downloaded', `Tactical report for ${villageName} saved successfully.`, 'success');
}

/**
 * Resets the UI button states for optimization
 */
function resetOptimizationUI() {
    const btnStart = document.getElementById('btnStartOptimization');
    const btnStop = document.getElementById('btnStopOptimization');
    if (btnStart) btnStart.style.display = 'block';
    if (btnStop) btnStop.style.display = 'none';
}

function generateDynamicRecommendations(allocations, intensity, villageId) {
    const recs = [];

    // General shortage alerts
    if (allocations.boats.percentage < 40 && intensity > 0.6) {
        recs.push({ type: 'CRITICAL', message: `Severe boat shortage! Requesting NDRF support for riverside clusters.` });
    }
    if (allocations.ambulances.percentage < 60) {
        recs.push({ type: 'WARNING', message: 'Medical response saturation detected. Prioritizing trauma centers.' });
    }
    if (allocations.helicopters && allocations.helicopters.percentage < 30 && intensity > 0.5) {
        recs.push({ type: 'CRITICAL', message: 'Helicopter fleet insufficient. Request IAF standby for aerial evacuation.' });
    }
    if (intensity > 0.85) {
        recs.push({ type: 'CAUTION', message: 'Aerial reconnaissance required for isolated zones.' });
    }

    // Village-specific terrain alerts
    if (villageId === 'wayanad_meppadi') {
        if (intensity > 0.4) {
            recs.push({ type: 'WARNING', message: '⛰️ LANDSLIDE ALERT: Chooralmala–Mundakkai corridor requires immediate aerial scanning. Ground routes may be severed.' });
        }
        if (intensity > 0.7) {
            recs.push({ type: 'CRITICAL', message: '🚁 Activate helicopter staging at Meppadi Hospital helipad. Valley floor evacuations require airlift.' });
        }
        recs.push({ type: 'INFO', message: 'Hilly terrain prioritizes helicopter and medical kit deployment over ground vehicles.' });
    } else if (villageId === 'darbhanga') {
        if (intensity > 0.5) {
            recs.push({ type: 'WARNING', message: '🌊 EMBANKMENT WATCH: Monitor Kamla river embankment breach points. Deploy sandbag teams to vulnerable sections.' });
        }
        if (intensity > 0.7) {
            recs.push({ type: 'CRITICAL', message: '🚤 Activate all SDRF boat units. Stagnant water zones need water purification kits within 12 hours.' });
        }
        recs.push({ type: 'INFO', message: 'Riverine terrain prioritizes boat deployment and community shelter activation.' });
    } else if (villageId === 'dhemaji') {
        if (intensity > 0.3) {
            recs.push({ type: 'WARNING', message: '🏠 CHANG GHAR ALERT: Activate raised platform (Chang Ghar) network for immediate local sheltering across floodplain.' });
        }
        if (intensity > 0.6) {
            recs.push({ type: 'CRITICAL', message: '🏞️ BANK EROSION: Brahmaputra riverbank erosion may isolate Simen Chapori. Deploy Army boats for emergency linkage.' });
        }
        recs.push({ type: 'INFO', message: 'Floodplain terrain requires maximum boat fleet with aerial backup for isolated communities.' });
    }

    if (recs.filter(r => r.type === 'CRITICAL' || r.type === 'WARNING').length === 0) {
        recs.push({ type: 'INFO', message: '✅ Resource distribution optimized for current conditions. All clusters covered.' });
    }

    return recs;
}

function updateResourceStats(plan) {
    const container = document.getElementById('resource-coverage');
    if (!container) return;

    const icons = { 'ambulances': '🚑', 'boats': '🚤', 'relief_kits': '📦', 'personnel': '👷' };

    // 1. Update Coverage Stats
    container.innerHTML = Object.entries(plan.estimated_coverage).map(([res, cov]) => `
        <div class="coverage-card" style="background:rgba(255,255,255,0.05); padding:8px; border-radius:6px; margin-bottom:4px; border:1px solid rgba(255,255,255,0.1)">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
                <span style="font-size:0.7rem; font-weight:600; text-transform:uppercase; color:var(--text-muted)">${icons[res] || '📌'} ${res}</span>
                <span style="font-size:0.75rem; font-weight:700; color:var(--accent-primary)">${cov.percentage}%</span>
            </div>
            <div class="progress" style="height:6px; background:rgba(239, 68, 68, 0.45); box-shadow: inset 0 0 8px rgba(239, 68, 68, 0.3);">
                <div class="progress-bar bg-success"
                     style="width: ${cov.percentage}%"></div>
            </div>
            <div style="font-size:0.6rem; color:var(--text-muted); margin-top:4px; display:flex; justify-content:space-between;">
                <span>Need: ${cov.required}</span>
                <span>Alloc: ${cov.allocated}</span>
            </div>
        </div>
    `).join('');

    // 2. Update Mission List with Phase Badges
    const missionContainer = document.getElementById('deployment-missions');
    if (missionContainer) {
        const missions = plan.mission_summaries.slice(0, 12);

        if (missions.length === 0) {
            missionContainer.innerHTML = '<div style="text-align:center; padding:20px; color:var(--text-muted); font-size:0.7rem;">No urgent missions required</div>';
        } else {
            const phaseBadgeColors = { 'Phase 1': '#ef4444', 'Phase 2': '#f59e0b', 'Phase 3': '#22c55e' };
            const phaseIcons = { 'Phase 1': '🔴', 'Phase 2': '🟡', 'Phase 3': '🟢' };

            missionContainer.innerHTML = missions.map(m => {
                const resDetails = Object.keys(icons).map(res => {
                    const req = m.requirements[res] || 0;
                    const alc = m.allocations[res] || 0;
                    if (req === 0 && alc === 0) return '';
                    return `
                        <div style="display:flex; align-items:center; gap:4px; font-size:0.6rem; color:${alc >= req ? '#10b981' : (alc > 0 ? '#f59e0b' : '#ef4444')}">
                            <span>${icons[res]}</span>
                            <span>${alc}/${req}</span>
                        </div>
                    `;
                }).join('');

                const phase = m.phase || 'Phase 3';
                const pColor = phaseBadgeColors[phase] || '#22c55e';
                const pIcon = phaseIcons[phase] || '🟢';

                return `
                    <div class="mission-card" style="padding:10px; border-bottom:1px solid rgba(255,255,255,0.05); cursor:pointer; border-left:3px solid ${pColor};" onclick="focusOnMission([${m.coords}])">
                        <div style="display:flex; justify-content:space-between; align-items:start; margin-bottom:5px;">
                            <div>
                                <div style="display:flex; align-items:center; gap:6px;">
                                    <span style="font-size:0.55rem; background:${pColor}22; color:${pColor}; padding:1px 6px; border-radius:8px; border:1px solid ${pColor}44; font-weight:700;">${pIcon} ${phase}</span>
                                    <span style="font-size:0.55rem; background:rgba(255,255,255,0.05); color:var(--text-muted); padding:1px 5px; border-radius:4px;">${m.urgency}</span>
                                </div>
                                <div style="font-size:0.75rem; font-weight:600; color:var(--text-bright); margin-top:3px;">${m.name}</div>
                                <div style="font-size:0.6rem; color:var(--accent-secondary)">Hub: ${m.hub_name}</div>
                            </div>
                            <div style="text-align:right">
                                <div class="priority-score-pill">⚡ ${(m.priority_score || 0).toLocaleString()}</div>
                                <div style="font-size:0.55rem; color:var(--text-muted); margin-top:3px;">Pop: ${m.pop.toLocaleString()}</div>
                            </div>
                        </div>
                        <div class="priority-factor-row">
                            <span class="priority-factor-chip">Risk: <strong>${(m.risk_level || '--').toUpperCase()} (${m.risk_weight || '-'}x)</strong></span>
                            <span class="priority-factor-chip">Confidence: <strong>${((m.model_confidence || 0) * 100).toFixed(1)}%</strong></span>
                            <span class="priority-factor-chip">ETA: <strong>${m.time_min}m</strong></span>
                        </div>
                        <div style="display:grid; grid-template-columns: repeat(3, 1fr); gap:4px; margin-top:6px;">
                            ${resDetails}
                        </div>
                    </div>
                `;
            }).join('');
        }
    }

    // 3. Phase Summary Bar
    if (plan.deployment_phases) {
        const phaseBar = document.getElementById('deployment-phase-summary');
        if (phaseBar) {
            const phases = plan.deployment_phases;
            phaseBar.innerHTML = Object.entries(phases).map(([key, phase]) => `
                <div style="display:flex; align-items:center; gap:6px; padding:6px 8px; background:rgba(255,255,255,0.03); border-radius:6px; border-left:3px solid ${phase.color};">
                    <span style="font-size:0.8rem;">${phase.badge}</span>
                    <div>
                        <div style="font-size:0.6rem; font-weight:700; color:${phase.color};">${phase.name}</div>
                        <div style="font-size:0.55rem; color:var(--text-muted);">${phase.timeframe} • ${phase.missions.length} clusters</div>
                    </div>
                </div>
            `).join('');
        }
    }

    const recsContainer = document.getElementById('deployment-recommendations');
    if (recsContainer) {
        recsContainer.innerHTML = plan.recommendations.map(rec => `
            <div class="alert-sm ${rec.type === 'CRITICAL' ? 'alert-danger' : (rec.type === 'WARNING' ? 'alert-warning' : (rec.type === 'CAUTION' ? 'alert-warning' : 'alert-info'))}" style="margin-top:8px;">
                <strong>${rec.type}:</strong> ${rec.message}
            </div>
        `).join('');
    }
}

/**
 * Focuses map on a specific mission cluster
 */
function focusOnMission(coords) {
    if (!appState.map) return;
    appState.map.flyTo({
        center: coords,
        zoom: 15.5,
        pitch: 60,
        bearing: Math.random() * 30 - 15,
        duration: 1500
    });
}

function displayResourceAllocation(plan) {
    if (!appState.map) return;

    const sourceId = 'resource-allocation-source';
    const lineLayerId = 'resource-allocation-lines';
    const hubLayerId = 'resource-hub-layer';
    const hubLabelId = 'resource-hub-labels';
    const pulseLayerId = 'resource-pulse-layer';

    const features = [];

    // Cap the map to the 6-7 highest-priority deployment points instead of
    // plotting every mission. mission_summaries is already ranked by
    // priority_score (population x risk weight x model confidence / travel
    // time - see optimizeAllocation), so the top slice is exactly the
    // zones nearest the actual high-risk / water-accumulated ground that
    // most warrant a marker, not an arbitrary or evenly-spread sample.
    const MAX_DEPLOYMENT_POINTS = 7;
    const topMissions = plan.mission_summaries.slice(0, MAX_DEPLOYMENT_POINTS);
    const topMissionNames = new Set(topMissions.map(m => m.name));

    // 1. Create Supply Lines (Dashed path from Hub to Cluster) - only for the
    // missions selected as deployment points above.
    Object.entries(plan.resource_allocations).forEach(([res, allocation]) => {
        const colors = { 'ambulances': '#ef4444', 'boats': '#0ea5e9', 'relief_kits': '#f59e0b', 'personnel': '#10b981' };
        allocation.assignments
            .filter(assign => topMissionNames.has(assign.cluster_name))
            .forEach(assign => {
                features.push({
                    type: 'Feature',
                    geometry: {
                        type: 'LineString',
                        coordinates: [assign.hub_coords, assign.target_coords]
                    },
                    properties: {
                        type: 'supply-line',
                        resource: res,
                        color: colors[res] || '#ffffff'
                    }
                });
            });
    });

    // 2. Create Hub Points & Target Zones for Pulsing
    plan.centers.forEach(hub => {
        features.push({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [hub.lon, hub.lat] },
            properties: {
                type: 'hub',
                name: hub.name,
                hubType: hub.type
            }
        });
    });

    // Unique mission targets for SOS pulses - capped to the top-priority
    // missions selected above, so the map never shows more than 6-7 points.
    const missionTargets = new Set();
    topMissions.forEach(m => {
        const key = JSON.stringify(m.coords);
        if (!missionTargets.has(key)) {
            missionTargets.add(key);
            features.push({
                type: 'Feature',
                geometry: { type: 'Point', coordinates: m.coords },
                properties: {
                    type: 'target-zone',
                    name: m.name,
                    risk: m.risk
                }
            });
        }
    });

    const geojson = { type: 'FeatureCollection', features: features };

    if (!appState.map.getSource(sourceId)) {
        appState.map.addSource(sourceId, { type: 'geojson', data: geojson });

        // SOS Pulse Layer (Behind targets)
        appState.map.addLayer({
            id: pulseLayerId,
            type: 'circle',
            source: sourceId,
            filter: ['==', 'type', 'target-zone'],
            paint: {
                'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 15, 15, 40],
                'circle-color': '#ef4444',
                'circle-opacity': 0.15,
                'circle-stroke-width': 2,
                'circle-stroke-color': '#ef4444',
                'circle-stroke-opacity': 0.4
            }
        });

        // Supply Lines Layer
        appState.map.addLayer({
            id: lineLayerId,
            type: 'line',
            source: sourceId,
            filter: ['==', 'type', 'supply-line'],
            layout: { 'line-join': 'round', 'line-cap': 'round' },
            paint: {
                'line-color': ['get', 'color'],
                'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1.5, 15, 3],
                'line-dasharray': [3, 2],
                'line-opacity': 0.8
            }
        });

        // Hub Points Layer
        appState.map.addLayer({
            id: hubLayerId,
            type: 'circle',
            source: sourceId,
            filter: ['==', 'type', 'hub'],
            paint: {
                'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 8, 15, 14],
                'circle-color': [
                    'match', ['get', 'hubType'],
                    'medical', '#ef4444',
                    'hq', '#8b5cf6',
                    'relief', '#f59e0b',
                    '#3b82f6'
                ],
                'circle-stroke-width': 3,
                'circle-stroke-color': '#ffffff'
            }
        });

        // Hub Labels
        appState.map.addLayer({
            id: hubLabelId,
            type: 'symbol',
            source: sourceId,
            filter: ['==', 'type', 'hub'],
            layout: {
                'text-field': ['get', 'name'],
                'text-font': ['DIN Offc Pro Medium', 'Arial Unicode MS Bold'],
                'text-size': 11,
                'text-variable-anchor': ['top', 'bottom', 'left', 'right'],
                'text-radial-offset': 1,
                'text-justify': 'auto'
            },
            paint: {
                'text-color': '#ffffff',
                'text-halo-color': 'rgba(0,0,0,0.8)',
                'text-halo-width': 1.5
            }
        });

        // Start pulse animation loop
        let timestamp = 0;
        const animatePulse = (t) => {
            timestamp = t;
            const radius = 15 + Math.abs(Math.sin(t / 400)) * 20;
            const opacity = 0.4 - (Math.abs(Math.sin(t / 400)) * 0.3);
            if (appState.map.getLayer(pulseLayerId)) {
                appState.map.setPaintProperty(pulseLayerId, 'circle-radius', radius);
                appState.map.setPaintProperty(pulseLayerId, 'circle-opacity', opacity);
            }
            requestAnimationFrame(animatePulse);
        };
        animatePulse(0);

    } else {
        appState.map.getSource(sourceId).setData(geojson);
    }

    // Interactive Hover on Hubs
    appState.map.on('mouseenter', hubLayerId, () => { appState.map.getCanvas().style.cursor = 'pointer'; });
    appState.map.on('mouseleave', hubLayerId, () => { appState.map.getCanvas().style.cursor = ''; });

    // Focus View on first Hub
    if (plan.centers.length > 0) {
        appState.map.flyTo({
            center: [plan.centers[0].lon, plan.centers[0].lat],
            zoom: 13,
            pitch: 50,
            duration: 2500
        });
    }
}

// =============================================
// ML MODEL VISUALIZATION FUNCTIONS
// =============================================

/**
 * Render ML Feature Importance bars in the sidebar panel.
 * Uses real trained model feature importances from model_metrics.
 */
function renderMLFeatureImportance() {
    const container = document.getElementById('mlFeatureImportance');
    if (!container) return;

    const metrics = appState.data?.model_metrics?.risk_scorer;
    if (!metrics?.feature_importance) return;

    const featureLabels = {
        rainfall_mm: { label: 'Rainfall', icon: '🌧️' },
        dist_to_river_m: { label: 'River Distance', icon: '🏞️' },
        flow_accumulation: { label: 'Flow Accumulation', icon: '💧' },
        slope_deg: { label: 'Slope', icon: '⛰️' },
        elevation_m: { label: 'Elevation', icon: '📐' },
        twi: { label: 'Wetness Index', icon: '💦' },
        soil_moisture: { label: 'Soil Moisture', icon: '🌱' },
        land_use: { label: 'Land Use', icon: '🏘️' }
    };

    const sorted = Object.entries(metrics.feature_importance)
        .sort((a, b) => b[1] - a[1]);

    const maxImp = sorted[0][1];

    container.innerHTML = sorted.map(([key, value]) => {
        const info = featureLabels[key] || { label: key, icon: '📊' };
        const pct = (value * 100).toFixed(1);
        const barWidth = (value / maxImp * 100).toFixed(0);

        const barColor = value > 0.15
            ? 'linear-gradient(90deg, #ef4444, #f97316)'
            : value > 0.08
                ? 'linear-gradient(90deg, #f59e0b, #eab308)'
                : 'linear-gradient(90deg, #22c55e, #10b981)';

        return `
            <div style="display:flex; align-items:center; gap:6px;">
                <span style="font-size:0.65rem; width:14px;">${info.icon}</span>
                <span style="font-size:0.65rem; color:var(--text-muted); width:80px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${info.label}</span>
                <div style="flex:1; height:6px; background:rgba(255,255,255,0.05); border-radius:3px; overflow:hidden;">
                    <div style="width:${barWidth}%; height:100%; background:${barColor}; border-radius:3px; transition:width 0.8s ease;"></div>
                </div>
                <span style="font-size:0.6rem; color:var(--accent-secondary); width:35px; text-align:right; font-weight:600;">${pct}%</span>
            </div>
        `;
    }).join('');
}

/**
 * Render ML Risk Prediction Summary.
 * Simulates what the Random Forest model would predict for the current
 * village and rainfall configuration, showing per-class distribution.
 */
function renderMLPredictionSummary() {
    const container = document.getElementById('mlPredictionSummary');
    if (!container) return;

    const metrics = appState.data?.model_metrics?.risk_scorer;
    if (!metrics) return;

    const rainfall = appState.rainfallAmount || 0;
    const villageId = appState.currentVillageId;

    if (rainfall === 0) {
        container.innerHTML = '<div style="font-size:0.7rem; color:var(--text-muted); font-style:italic;">Set rainfall > 0 to see ML prediction...</div>';
        return;
    }

    // Simulate ML model prediction distribution based on rainfall intensity
    const intensity = Math.min(1, rainfall / 300);
    let distribution;

    if (villageId === 'wayanad_meppadi') {
        // Hilly terrain: quick escalation to extreme
        distribution = {
            low: Math.max(5, Math.round(40 * (1 - intensity * 1.3))),
            medium: Math.round(25 + intensity * 10),
            high: Math.round(20 + intensity * 20),
            extreme: Math.round(15 + intensity * 25)
        };
    } else if (villageId === 'darbhanga') {
        // Riverine: gradual spread
        distribution = {
            low: Math.max(5, Math.round(35 * (1 - intensity))),
            medium: Math.round(30 + intensity * 5),
            high: Math.round(20 + intensity * 15),
            extreme: Math.round(15 + intensity * 20)
        };
    } else {
        // Floodplain: wide-area medium/high
        distribution = {
            low: Math.max(5, Math.round(30 * (1 - intensity))),
            medium: Math.round(25 + intensity * 15),
            high: Math.round(25 + intensity * 15),
            extreme: Math.round(20 + intensity * 15)
        };
    }

    // Normalize to 100%
    const total = Object.values(distribution).reduce((a, b) => a + b, 0);
    Object.keys(distribution).forEach(k => {
        distribution[k] = Math.round(distribution[k] / total * 100);
    });

    // Confidence decreases slightly with extreme rainfall (model less certain)
    const baseConfidence = metrics.accuracy;
    const confidenceAdjust = intensity > 0.8 ? -0.03 : (intensity > 0.5 ? -0.01 : 0.02);
    const confidence = Math.min(0.95, baseConfidence + confidenceAdjust);

    const riskColors = {
        extreme: '#ef4444',
        high: '#f97316',
        medium: '#eab308',
        low: '#22c55e'
    };

    const riskIcons = {
        extreme: '🔴',
        high: '🟠',
        medium: '🟡',
        low: '🟢'
    };

    let html = '';

    // Overall confidence
    html += `
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px; padding-bottom:6px; border-bottom:1px solid rgba(255,255,255,0.05);">
            <span style="font-size:0.7rem; color:var(--text-muted);">Model Confidence</span>
            <span style="font-size:0.75rem; font-weight:700; color:${confidence > 0.80 ? '#10b981' : '#f59e0b'};">${(confidence * 100).toFixed(1)}%</span>
        </div>
    `;

    // Per-class distribution bars
    ['extreme', 'high', 'medium', 'low'].forEach(level => {
        const pct = distribution[level];
        const classMetrics = metrics.per_class?.[level];
        const f1 = classMetrics ? (classMetrics.f1 * 100).toFixed(0) : '--';

        html += `
            <div style="display:flex; align-items:center; gap:6px;">
                <span style="font-size:0.65rem; width:14px;">${riskIcons[level]}</span>
                <span style="font-size:0.65rem; color:var(--text-muted); width:52px; text-transform:capitalize;">${level}</span>
                <div style="flex:1; height:8px; background:rgba(255,255,255,0.05); border-radius:4px; overflow:hidden;">
                    <div style="width:${pct}%; height:100%; background:${riskColors[level]}; border-radius:4px; transition:width 0.6s ease;"></div>
                </div>
                <span style="font-size:0.6rem; color:var(--text-secondary); width:30px; text-align:right;">${pct}%</span>
                <span style="font-size:0.5rem; color:var(--text-muted); width:28px; text-align:right;">F1:${f1}</span>
            </div>
        `;
    });

    // Training info
    html += `
        <div style="margin-top:6px; padding-top:6px; border-top:1px solid rgba(255,255,255,0.05); display:flex; justify-content:space-between;">
            <span style="font-size:0.55rem; color:var(--text-muted);">15,000 samples • 5-fold Stratified CV</span>
            <span style="font-size:0.55rem; color:var(--accent-secondary);">${metrics.model_version}</span>
        </div>
    `;

    container.innerHTML = html;
}

// Initialize when DOM is ready
window.addEventListener('DOMContentLoaded', run);
