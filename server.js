require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
const DB_FILE = path.join(__dirname, 'data', 'businesses.json');
const PREFS_FILE = path.join(__dirname, 'data', 'preferences.json');
const FAVS_FILE = path.join(__dirname, 'data', 'favourites.json');
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
if (!fs.existsSync(path.join(__dirname, 'data'))) fs.mkdirSync(path.join(__dirname, 'data'));
if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify([]));
if (!fs.existsSync(PREFS_FILE)) fs.writeFileSync(PREFS_FILE, JSON.stringify({}));
if (!fs.existsSync(FAVS_FILE)) fs.writeFileSync(FAVS_FILE, JSON.stringify([]));

function readDB() { try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { return []; } }
function writeDB(data) { fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2)); }
function readPrefs() { try { return JSON.parse(fs.readFileSync(PREFS_FILE, 'utf8')); } catch { return {}; } }
function writePrefs(data) { fs.writeFileSync(PREFS_FILE, JSON.stringify(data, null, 2)); }
function readFavs() { try { return JSON.parse(fs.readFileSync(FAVS_FILE, 'utf8')); } catch { return []; } }
function writeFavs(data) { fs.writeFileSync(FAVS_FILE, JSON.stringify(data, null, 2)); }
function upsertBusiness(biz) { const db = readDB(); const idx = db.findIndex(b => b.id === biz.id); if (idx >= 0) db[idx] = { ...db[idx], ...biz }; else db.push(biz); writeDB(db); return biz; }

// Haversine distance in km
function distanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2-lat1) * Math.PI/180;
  const dLon = (lon2-lon1) * Math.PI/180;
  const a = Math.sin(dLat/2)*Math.sin(dLat/2) + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)*Math.sin(dLon/2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// Geocode a location string using Google Maps Geocoding API
async function geocodeLocation(query) {
  if (!process.env.GOOGLE_MAPS_KEY) return null;
  try {
    const resp = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', {
      params: { address: query, key: process.env.GOOGLE_MAPS_KEY }
    });
    const result = resp.data.results[0];
    if (!result) return null;
    return { lat: result.geometry.location.lat, lng: result.geometry.location.lng, formatted: result.formatted_address };
  } catch { return null; }
}

// Verify a business is actually in the right location by checking their website
async function verifyBusinessLocation(url, searchLat, searchLng, radiusKm) {
  if (!process.env.GOOGLE_MAPS_KEY) return true; // skip verification if no key
  try {
    // Try to extract address from website
    const resp = await axios.get(url, { timeout: 6000, headers: { 'User-Agent': 'Mozilla/5.0' } });
    const cheerio = require('cheerio');
    const $ = cheerio.load(resp.data);
    $('script,style').remove();
    const text = $('body').text().replace(/\s+/g,' ').slice(0,2000);
    
    // Ask Claude to extract the address
    const msg = await client.messages.create({
      model: 'claude-sonnet-4-20250514', max_tokens: 200,
      system: 'Extract ONLY the physical street address from this website text. Return just the address in one line, or "NOT_FOUND" if no clear address exists.',
      messages: [{ role: 'user', content: text }]
    });
    const address = msg.content.map(c=>c.text||'').join('').trim();
    if (!address || address === 'NOT_FOUND') return true; // can't verify, allow through
    
    // Geocode the extracted address
    const geo = await geocodeLocation(address);
    if (!geo) return true;
    
    const dist = distanceKm(searchLat, searchLng, geo.lat, geo.lng);
    console.log(url, 'distance:', Math.round(dist) + 'km, address:', address);
    return dist <= radiusKm * 1.5; // 50% buffer
  } catch {
    return true; // if verification fails, allow through
  }
}

const INDUSTRY_QUERIES = {
  Hotels: ['small boutique hotel', 'hotel boutique pequeño', 'posada colonial', 'hotel familiar', 'guesthouse'],
  Restaurants: ['restaurante local', 'restaurante familiar', 'bistro local', 'cocina local', 'mariscos local'],
  Gyms: ['gym local', 'crossfit box local', 'yoga studio boutique', 'gimnasio local', 'pilates boutique'],
  Legal: ['abogados locales', 'despacho juridico local', 'bufete pequeño', 'notario', 'lawyer small firm'],
  'Real Estate': ['inmobiliaria local', 'bienes raices boutique', 'agente inmobiliario independiente'],
  Veterinary: ['veterinaria local', 'clinica veterinaria pequeña', 'animal hospital local']
};

const SKIP = ['tripadvisor','booking.com','airbnb','yelp','facebook','instagram','google','maps','wikipedia',
  'expedia','hotels.com','agoda','timeout','foursquare','zomato','marriott','hilton','hyatt','starwood',
  'ihg','wyndham','accor','bestwestern','radisson','sheraton','westin','doubletree','holiday inn','secrets',
  'excellence','palace resorts','iberostar','riu','barcelo','fiesta americana','camino real'];

const PACKAGES = {
  starter: { name: 'Starter', range: '$12,000–$18,000 MXN', timeline: '5–7 days', features: ['5-page bilingual website','Mobile responsive','Basic SEO setup','Contact form','30-day support'] },
  growth: { name: 'Growth', range: '$25,000–$40,000 MXN', timeline: '10–14 days', features: ['8-page bilingual website','Booking or e-commerce integration','Blog section','Full SEO + Analytics','Bilingual copywriting','60-day support'] },
  premium: { name: 'Premium', range: '$50,000–$80,000 MXN', timeline: '3–4 weeks', features: ['Custom design unlimited pages','Custom booking/payment system','Full SEO strategy + content plan','Google Ads setup','3-month care plan','Dedicated PM'] },
  custom: { name: 'Custom Quote', range: 'TBC', timeline: 'To be confirmed', features: ['Complex booking systems','E-commerce with custom logic','API integrations','Multi-location','Advanced functionality'] }
};

app.post('/api/search', async (req, res) => {
  const { industry, location = 'Puerto Vallarta', radius = 15 } = req.body;
  const queries = (INDUSTRY_QUERIES[industry] || [industry]).slice(0, 3);
  const prefs = readPrefs();
  const now = Date.now();

  // Geocode the search location
  const searchGeo = await geocodeLocation(location + ', Mexico');
  const searchLat = searchGeo ? searchGeo.lat : 20.6534;
  const searchLng = searchGeo ? searchGeo.lng : -105.2253;

  if (process.env.GOOGLE_API_KEY && process.env.GOOGLE_CX) {
    try {
      const allResults = []; const seenUrls = new Set();
      for (const kw of queries) {
        try {
          const resp = await axios.get('https://www.googleapis.com/customsearch/v1', {
            params: { key: process.env.GOOGLE_API_KEY, cx: process.env.GOOGLE_CX, q: kw + ' ' + location + ' Mexico', num: 10, gl: 'mx' }
          });
          for (const item of (resp.data.items || [])) {
            if (seenUrls.has(item.link)) continue;
            if (SKIP.some(s => item.link.toLowerCase().includes(s))) continue;
            const pref = prefs[item.link];
            if (pref && pref.verdict === 'not_good' && (now - pref.date) < 30 * 24 * 60 * 60 * 1000) continue;
            seenUrls.add(item.link);
            allResults.push({ id: Buffer.from(item.link+Date.now()).toString('base64').slice(0,20).replace(/[^a-zA-Z0-9]/g,'x'), name: item.title.split('|')[0].split('-')[0].split('–')[0].trim().slice(0,60), url: item.link, snippet: (item.snippet||'').slice(0,200), industry, location, searchLat, searchLng, radius, status: 'pending', addedAt: new Date().toISOString() });
          }
        } catch(e) { console.log('Query failed:', e.message); }
        await new Promise(r => setTimeout(r, 300));
      }
      allResults.forEach(upsertBusiness);
      return res.json({ results: allResults, source: 'google', searchLat, searchLng });
    } catch(e) { console.log('Google error:', e.message); }
  }

  try {
    const msg = await client.messages.create({ model: 'claude-sonnet-4-20250514', max_tokens: 1500, system: 'Return ONLY a valid JSON array. No markdown.', messages: [{ role: 'user', content: 'List 12 SMALL independent ' + industry + ' businesses specifically in ' + location + ', Mexico (NOT other cities) with websites. EXCLUDE big chains. Local family-owned only. JSON: [{name,url,industry,location}]' }] });
    const text = msg.content.map(c=>c.text||'').join('').trim().replace(/```json|```/g,'');
    const parsed = JSON.parse(text.match(/\[[\s\S]*\]/)[0]);
    const results = parsed
      .filter(b => { const p = prefs[b.url]; return !(p && p.verdict === 'not_good' && (now - p.date) < 30*24*60*60*1000); })
      .map(b => ({ id: Buffer.from(b.url+Math.random()).toString('base64').slice(0,20).replace(/[^a-zA-Z0-9]/g,'x'), name: b.name, url: b.url, industry: b.industry||industry, location: b.location||location, searchLat, searchLng, radius, status: 'pending', addedAt: new Date().toISOString() }));
    results.forEach(upsertBusiness);
    return res.json({ results, source: 'claude', searchLat, searchLng });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Verify location of a specific business
app.post('/api/verify/:id', async (req, res) => {
  const db = readDB(); const biz = db.find(b => b.id === req.params.id);
  if (!biz) return res.status(404).json({ error: 'Not found' });
  try {
    const inRange = await verifyBusinessLocation(biz.url, biz.searchLat || 20.6534, biz.searchLng || -105.2253, biz.radius || 15);
    const updated = upsertBusiness({ ...biz, locationVerified: inRange, locationCheckedAt: new Date().toISOString() });
    res.json(updated);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/audit/:id', async (req, res) => {
  const db = readDB(); const biz = db.find(b => b.id === req.params.id);
  if (!biz) return res.status(404).json({ error: 'Not found' });
  let siteContent = '';
  try { const resp = await axios.get(biz.url, { timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0' } }); const cheerio = require('cheerio'); const $ = cheerio.load(resp.data); $('script,style,img,svg,nav,footer').remove(); siteContent = $('body').text().replace(/\s+/g,' ').slice(0,3000); } catch { siteContent = 'Could not fetch. Domain: ' + biz.url + ', Type: ' + biz.industry; }
  try {
    const msg = await client.messages.create({ model: 'claude-sonnet-4-20250514', max_tokens: 2000, system: 'You are a web conversion and UX expert. Return ONLY raw JSON, no markdown.', messages: [{ role: 'user', content: 'Audit this ' + biz.industry + ' business website: ' + biz.url + '\nBusiness: ' + biz.name + '\nContent: ' + siteContent + '\n\nReturn ONLY this JSON:\n{"overall_score":0,"detected_location":"city/region from website content","summary":"2-3 sentences on how weaknesses hurt revenue","revenue_impact":"specific estimate of lost leads/revenue","recommended_package":"starter|growth|premium|custom","package_reasoning":"1 sentence why","scores":{"ux_ui":0,"lead_generation":0,"navigation":0,"mobile":0},"findings":[{"title":"string","priority":"high","description":"actionable finding with revenue impact"}]}\n\nPackage guide: starter=$12k-18k MXN simple sites, growth=$25k-40k MXN needs booking/integration, premium=$50k-80k MXN full custom, custom=TBC complex systems.\nScores 0-100, priority=high/medium/low, 5-7 findings.' }] });
    const text = msg.content.filter(c=>c.type==='text').map(c=>c.text).join('').trim();
    const match = text.replace(/```json|```/g,'').match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON');
    const audit = JSON.parse(match[0]);
    res.json(upsertBusiness({ ...biz, audit, status: audit.overall_score<=50?'weak':'ok', auditedAt: new Date().toISOString() }));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/proposal/:id', async (req, res) => {
  const { language = 'English' } = req.body; const db = readDB(); const biz = db.find(b=>b.id===req.params.id);
  if (!biz || !biz.audit) return res.status(400).json({ error: 'Audit required first' });
  const pkg = PACKAGES[biz.audit.recommended_package] || PACKAGES.growth;
  const findings = biz.audit.findings.map(f=>'- [' + f.priority.toUpperCase() + '] ' + f.title + ': ' + f.description).join('\n');
  try {
    const msg = await client.messages.create({ model: 'claude-sonnet-4-20250514', max_tokens: 1500, messages: [{ role: 'user', content: 'Write a professional web proposal in ' + language + ' from Sunset Web Studio, a boutique web agency in Puerto Vallarta (hello@sunsetwebstudio.mx).\n\nClient: ' + biz.name + ' | Industry: ' + biz.industry + ' | Current score: ' + biz.audit.overall_score + '/100\nSummary: ' + biz.audit.summary + '\nRevenue impact: ' + biz.audit.revenue_impact + '\nKey findings:\n' + findings + '\n\nRecommended package: ' + pkg.name + ' (' + pkg.range + ', delivered in ' + pkg.timeline + ')\nReasoning: ' + (biz.audit.package_reasoning||'') + '\nIncludes: ' + pkg.features.join(', ') + '\n\nStructure: personalised opening, what their site is costing them, top 3 findings with impact, recommended solution with investment range, timeline, clear CTA.\nTone: warm, confident. ~450 words. No placeholders. Plain text with short bold headings.' }] });
    const proposal = msg.content.map(c=>c.text||'').join('').trim();
    res.json({ proposal, package: pkg, business: upsertBusiness({ ...biz, proposal, proposalGeneratedAt: new Date().toISOString() }) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Verdict: good find / not good find
app.post('/api/verdict/:id', (req, res) => {
  const { verdict } = req.body;
  const db = readDB(); const biz = db.find(b=>b.id===req.params.id);
  if (!biz) return res.status(404).json({ error: 'Not found' });
  const prefs = readPrefs();
  prefs[biz.url] = { verdict, date: Date.now(), name: biz.name };
  writePrefs(prefs);
  res.json(upsertBusiness({ ...biz, verdict, verdictAt: new Date().toISOString() }));
});

// Favourites
app.post('/api/favourites/:id', (req, res) => {
  const db = readDB(); const biz = db.find(b=>b.id===req.params.id);
  if (!biz) return res.status(404).json({ error: 'Not found' });
  const favs = readFavs();
  if (!favs.find(f=>f.id===biz.id)) { favs.push({ ...biz, savedAt: new Date().toISOString() }); writeFavs(favs); }
  res.json(upsertBusiness({ ...biz, saved: true }));
});
app.delete('/api/favourites/:id', (req, res) => {
  writeFavs(readFavs().filter(f=>f.id!==req.params.id));
  const db = readDB(); const biz = db.find(b=>b.id===req.params.id);
  if (biz) upsertBusiness({ ...biz, saved: false });
  res.json({ ok: true });
});
app.get('/api/favourites', (req, res) => res.json(readFavs()));

app.get('/api/config', (req, res) => res.json({ mapsKey: process.env.GOOGLE_MAPS_KEY || '' }));
app.get('/api/businesses', (req, res) => res.json(readDB()));
app.get('/api/businesses/:id', (req, res) => { const biz = readDB().find(b=>b.id===req.params.id); biz ? res.json(biz) : res.status(404).json({ error: 'Not found' }); });
app.delete('/api/businesses/:id', (req, res) => { writeDB(readDB().filter(b=>b.id!==req.params.id)); res.json({ ok: true }); });
app.delete('/api/businesses', (req, res) => { writeDB([]); res.json({ ok: true }); });
app.get('/{*splat}', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
const PORT = process.env.PORT || 3333;
app.listen(PORT, () => console.log('Sunset Audit Tool running at http://localhost:' + PORT));
