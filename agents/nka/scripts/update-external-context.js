#!/usr/bin/env node
/**
 * NKA — update-external-context.js
 * Fetches weather (Open-Meteo + Met Éireann), events (Ticketmaster), and traffic (TomTom).
 * Derives per-county zone risks. Writes artifacts/external-context.json atomically.
 * Called by SENTINEL every cycle so all agents read consistent, pre-fetched data.
 */

// Load API keys from webui/.env
const path = require('path');
try {
  require('dotenv').config({ path: path.join(__dirname, '..', '..', '..', 'webui', '.env') });
} catch { /* dotenv optional */ }

const https = require('https');
const http  = require('http');
const fs    = require('fs');

const ARTIFACTS = path.join(__dirname, '..', '..', '..', 'artifacts');

// ---------------------------------------------------------------------------
// City / region → county mappings for Irish geography
// ---------------------------------------------------------------------------

const CITY_TO_COUNTY = {
  'Dublin': 'Dublin', 'Dún Laoghaire': 'Dublin',
  'Cork': 'Cork', 'Cobh': 'Cork', 'Kinsale': 'Cork',
  'Galway': 'Galway', 'Tuam': 'Galway',
  'Limerick': 'Limerick',
  'Waterford': 'Waterford',
  'Killarney': 'Kerry', 'Tralee': 'Kerry', 'Kenmare': 'Kerry',
  'Sligo': 'Sligo',
  'Donegal': 'Donegal', 'Letterkenny': 'Donegal',
  'Monaghan': 'Monaghan',
  'Cavan': 'Cavan',
  'Carlow': 'Carlow',
  'Wexford': 'Wexford',
  'Tipperary': 'Tipperary', 'Clonmel': 'Tipperary',
  'Roscommon': 'Roscommon',
  'Longford': 'Longford',
  'Leitrim': 'Leitrim', 'Carrick-on-Shannon': 'Leitrim',
  'Mullingar': 'Westmeath', 'Athlone': 'Westmeath',
  'Drogheda': 'Louth', 'Dundalk': 'Louth',
  'Navan': 'Meath',
  'Kilkenny': 'Kilkenny',
  'Newbridge': 'Kildare', 'Naas': 'Kildare',
  'Wicklow': 'Wicklow', 'Bray': 'Wicklow',
  'Ennis': 'Clare',
  'Castlebar': 'Mayo', 'Westport': 'Mayo',
  'Tullamore': 'Offaly',
  'Portlaoise': 'Laois',
};

const REGION_TO_COUNTIES = {
  'Connacht':    ['Galway','Mayo','Roscommon','Sligo','Leitrim'],
  'Munster':     ['Cork','Kerry','Limerick','Tipperary','Waterford','Clare'],
  'Leinster':    ['Dublin','Wicklow','Wexford','Carlow','Kilkenny','Kildare','Meath','Louth','Westmeath','Longford','Offaly','Laois'],
  'Ulster':      ['Donegal','Cavan','Monaghan'],
  'Ireland':     ['Dublin','Cork','Galway','Limerick','Waterford','Kerry','Sligo','Donegal','Monaghan','Cavan','Carlow','Wexford','Tipperary','Roscommon','Leitrim','Longford'],
  'All Counties':['Dublin','Cork','Galway','Limerick','Waterford','Kerry','Sligo','Donegal','Monaghan','Cavan','Carlow','Wexford','Tipperary','Roscommon','Leitrim','Longford'],
  'Dublin':      ['Dublin'],
  'Cork':        ['Cork'],
  'Galway':      ['Galway'],
};

const LARGE_VENUES = ['3Arena','Croke Park','Aviva Stadium','SSE Airtricity','Olympia','Marquee','TU Dublin','RDS'];

// ---------------------------------------------------------------------------
// Risk priority — higher index wins
// ---------------------------------------------------------------------------
const RISK_RANK = { 'none':0, 'event-load':1, 'high-wind':2, 'storm-warning-yellow':3, 'storm-warning-orange':4, 'storm-warning-red':5 };
function higherRisk(a, b) { return (RISK_RANK[b] ?? 0) > (RISK_RANK[a] ?? 0) ? b : a; }

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { headers: { 'User-Agent': 'NKA-PoC/1.0' } }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { reject(new Error('Invalid JSON from ' + url.slice(0, 60))); } });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error('timeout')));
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const zoneRisks = {};
  const setRisk = (county, risk) => { zoneRisks[county] = higherRisk(zoneRisks[county] ?? 'none', risk); };

  // --- 1. Weather (Open-Meteo) ---
  let weather = { risk: 'unknown' };
  try {
    const raw = await fetchJson('https://api.open-meteo.com/v1/forecast?latitude=53.3498&longitude=-6.2603&current=temperature_2m,wind_speed_10m,precipitation,weather_code&forecast_days=1');
    const c = raw.current ?? {};
    weather = {
      temp_c:    c.temperature_2m,
      wind_kmh:  c.wind_speed_10m,
      precip_mm: c.precipitation,
      code:      c.weather_code,
      risk:      c.precipitation > 5 ? 'high' : c.wind_speed_10m > 40 ? 'medium' : 'none',
    };
    // High wind nationwide → flag all zones if wind is extreme
    if (c.wind_speed_10m > 60) {
      for (const county of REGION_TO_COUNTIES['Ireland']) setRisk(county, 'high-wind');
    }
  } catch (e) {
    weather = { risk: 'unknown', error: e.message };
  }

  // --- 2. Met Éireann warnings ---
  let warnings = [];
  try {
    const raw = await fetchJson('https://www.met.ie/Open_Data/json/warning_IRELAND.json');
    if (Array.isArray(raw)) {
      warnings = raw.map(w => ({
        headline: w.headline ?? w.title ?? '',
        level:    w.level ?? w.severity ?? '',
        regions:  w.regions ?? [],
        type:     detectWarningType(w.headline ?? ''),
      }));
      for (const w of warnings) {
        const riskLevel = w.level?.toLowerCase().includes('red')    ? 'storm-warning-red'
                        : w.level?.toLowerCase().includes('orange') ? 'storm-warning-orange'
                        :                                              'storm-warning-yellow';
        for (const region of w.regions) {
          const counties = REGION_TO_COUNTIES[region] ?? [region];
          for (const county of counties) setRisk(county, riskLevel);
        }
      }
    }
  } catch { /* warnings unavailable */ }

  // --- 3. Events (Ticketmaster) ---
  let activeEvents = [];
  const tmKey = process.env.TICKETMASTER_API_KEY;
  if (tmKey) {
    try {
      const today    = new Date().toISOString().split('T')[0];
      const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];
      const url = `https://app.ticketmaster.com/discovery/v2/events.json?countryCode=IE&size=10&startDateTime=${today}T00:00:00Z&endDateTime=${tomorrow}T23:59:59Z&sort=date,asc&apikey=${tmKey}`;
      const data = await fetchJson(url);
      activeEvents = (data._embedded?.events ?? []).map(e => {
        const city         = e._embedded?.venues?.[0]?.city?.name ?? '';
        const venueName    = e._embedded?.venues?.[0]?.name ?? '';
        const county       = CITY_TO_COUNTY[city] ?? city;
        const isLargeVenue = LARGE_VENUES.some(v => venueName.includes(v));
        if (isLargeVenue && county) setRisk(county, 'event-load');
        return { name: e.name, venue: venueName, city, county, time: e.dates?.start?.localTime ?? '', isLargeVenue };
      });
    } catch { /* events unavailable */ }
  }

  // --- 4. Traffic (TomTom — summary only) ---
  let trafficSummary = [];
  const ttKey = process.env.TOMTOM_API_KEY;
  if (ttKey) {
    try {
      const fields = '{incidentDetails{fields{id,magnitudeOfDelay,from,to,roadNumbers,events{description,iconCategory}}}}';
      const url = `https://api.tomtom.com/traffic/services/5/incidentDetails?key=${ttKey}&bbox=${encodeURIComponent('-10.5,51.3,-5.5,55.4')}&fields=${encodeURIComponent(fields)}&language=en-GB`;
      const data = await fetchJson(url);
      trafficSummary = (data.incidents ?? [])
        .filter(i => (i.properties?.magnitudeOfDelay ?? 0) >= 2)
        .slice(0, 8)
        .map(i => ({
          severity:    ['unknown','minor','moderate','major','severe'][i.properties?.magnitudeOfDelay ?? 0],
          roads:       i.properties?.roadNumbers ?? [],
          from:        i.properties?.from ?? '',
          to:          i.properties?.to ?? '',
          description: i.properties?.events?.[0]?.description ?? '',
        }));
    } catch { /* traffic unavailable */ }
  }

  // --- Write output ---
  const ctx = {
    fetchedAt: new Date().toISOString(),
    weather,
    warnings,
    activeEvents,
    trafficSummary,
    zoneRisks,
    // Human-readable summary for agents to quote directly
    summary: buildSummary(weather, warnings, activeEvents, trafficSummary, zoneRisks),
  };

  const out = path.join(ARTIFACTS, 'external-context.json');
  fs.writeFileSync(out + '.tmp', JSON.stringify(ctx, null, 2));
  fs.renameSync(out + '.tmp', out);

  // Print to stdout so SENTINEL can read it in its session
  console.log(`[ext-ctx] fetched at ${ctx.fetchedAt}`);
  console.log(`[ext-ctx] weather: ${weather.temp_c}°C, ${weather.wind_kmh} km/h wind, ${weather.precip_mm}mm precip — risk: ${weather.risk}`);
  if (warnings.length) console.log(`[ext-ctx] met warnings: ${warnings.map(w => `${w.headline} (${w.level})`).join('; ')}`);
  if (activeEvents.filter(e => e.isLargeVenue).length) {
    console.log(`[ext-ctx] large-venue events: ${activeEvents.filter(e => e.isLargeVenue).map(e => `${e.name} @ ${e.venue}, ${e.county}`).join('; ')}`);
  }
  if (trafficSummary.length) console.log(`[ext-ctx] traffic incidents: ${trafficSummary.length} moderate+`);
  const riskyZones = Object.entries(zoneRisks).filter(([,r]) => r !== 'none');
  if (riskyZones.length) {
    console.log(`[ext-ctx] ZONE RISKS: ${riskyZones.map(([c,r]) => `${c}=${r}`).join(', ')}`);
  } else {
    console.log(`[ext-ctx] no zone risks`);
  }
}

function detectWarningType(headline) {
  const h = headline.toLowerCase();
  if (h.includes('wind') || h.includes('gust')) return 'wind';
  if (h.includes('rain') || h.includes('rainfall')) return 'rain';
  if (h.includes('snow') || h.includes('ice')) return 'snow-ice';
  if (h.includes('flood')) return 'flood';
  if (h.includes('storm')) return 'storm';
  return 'general';
}

function buildSummary(weather, warnings, events, traffic, zoneRisks) {
  const parts = [];

  if (weather.temp_c != null) {
    parts.push(`Weather: ${weather.temp_c}°C, ${weather.wind_kmh} km/h wind, ${weather.precip_mm}mm precip — network risk: ${weather.risk}.`);
  }

  if (warnings.length > 0) {
    parts.push(`Met Éireann warnings: ${warnings.map(w => `${w.headline} (${w.level}, ${w.regions.join('/')})`).join('; ')}.`);
  } else {
    parts.push('Met Éireann warnings: none active.');
  }

  const largeEvents = events.filter(e => e.isLargeVenue);
  if (largeEvents.length > 0) {
    parts.push(`Large-venue events today: ${largeEvents.map(e => `${e.name} at ${e.venue}, ${e.county} (${e.time.slice(0,5)})`).join('; ')}. Localised load spike likely in ${[...new Set(largeEvents.map(e => e.county))].join(', ')}.`);
  } else if (events.length > 0) {
    parts.push(`Events today: ${events.slice(0,3).map(e => `${e.name} (${e.city})`).join('; ')} — no capacity-venue events.`);
  } else {
    parts.push('Major events: none today.');
  }

  if (traffic.length > 0) {
    parts.push(`Traffic: ${traffic.length} moderate+ incident${traffic.length > 1 ? 's' : ''} — ${traffic.slice(0,2).map(t => `${t.roads.join('/')} ${t.from}→${t.to} (${t.severity})`).join('; ')}.`);
  } else {
    parts.push('Traffic: no significant incidents.');
  }

  const risky = Object.entries(zoneRisks).filter(([,r]) => r !== 'none');
  if (risky.length > 0) {
    parts.push(`Zone risks: ${risky.map(([c,r]) => `${c} (${r})`).join(', ')}.`);
  }

  return parts.join(' ');
}

main().catch(e => { console.error('[ext-ctx] fatal:', e.message); process.exit(0); /* non-fatal for SENTINEL */ });
