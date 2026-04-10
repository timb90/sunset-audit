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
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
if (!fs.existsSync(path.join(__dirname, 'data'))) fs.mkdirSync(path.join(__dirname, 'data'));
if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify([]));
if (!fs.existsSync(PREFS_FILE)) fs.writeFileSync(PREFS_FILE, JSON.stringify({}));

function readDB() { try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { return []; } }
function writeDB(data) { fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2)); }
function readPrefs() { try { return JSON.parse(fs.readFileSync(PREFS_FILE, 'utf8')); } catch { return {}; } }
function writePrefs(data) { fs.writeFileSync(PREFS_FILE, JSON.stringify(data, null, 2)); }
function upsertBusiness(biz) { const db = readDB(); const idx = db.findIndex(b => b.id === biz.id); if (idx >= 0) db[idx] = { ...db[idx], ...biz }; else db.push(biz); writeDB(db); return biz; }

// Industry-specific queries targeting SMALL/BOUTIQUE businesses only
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

// Pricing packages
const PACKAGES = {
  starter: { name: 'Starter', range: '$12,000–$18,000 MXN', timeline: '5–7 days', features: ['5-page bilingual website','Mobile responsive','Basic SEO setup','Contact form','30-day support'] },
  growth: { name: 'Growth', range: '$25,000–$40,000 MXN', timeline: '10–14 days', features: ['8-page bilingual website','Booking or e-commerce integration','Blog section','Full SEO + Analytics','Bilingual copywriting','60-day support'] },
  premium: { name: 'Premium', range: '$50,000–$80,000 MXN', timeline: '3–4 weeks', features: ['Custom design unlimited pages','Custom booking/payment system','Full SEO strategy + content plan','Google Ads setup','3-month care plan','Dedicated PM'] },
  custom: { name: 'Custom Quote', range: 'TBC', timeline: 'To be confirmed', features: ['Complex booking systems','E-commerce with custom logic','API integrations','Multi-location','Advanced functionality'] }
};

app.post('/api/search', async (req, res) => {
  const { industry, location = 'Puerto Vallarta' } = req.body;
  const queries = (INDUSTRY_QUERIES[industry] || [industry]).slice(0, 3);
  const prefs = readPrefs();
  const now = Date.now();

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
            // Check if hidden for 30 days
            const pref = prefs[item.link];
            if (pref && pref.verdict === 'not_good' && (now - pref.date) < 30 * 24 * 60 * 60 * 1000) continue;
            seenUrls.add(item.link);
            allResults.push({ id: Buffer.from(item.link+Date.now()).toString('base64').slice(0,20).replace(/[^a-zA-Z0-9]/g,'x'), name: item.title.split('|')[0].split('-')[0].split('–')[0].trim().slice(0,60), url: item.link, snippet: (item.snippet||'').slice(0,200), industry, location, status: 'pending', addedAt: new Date().toISOString() });
          }
        } catch(e) { console.log('Query failed:', e.message); }
        await new Promise(r => setTimeout(r, 300));
      }
      allResults.forEach(upsertBusiness);
      return res.json({ results: allResults, source: 'google' });
    } catch(e) { console.log('Google error:', e.message); }
  }

  try {
    const msg = await client.messages.create({ model: 'claude-sonnet-4-20250514', max_tokens: 1500, system: 'Return ONLY a valid JSON array. No markdown.', messages: [{ role: 'user', content: 'List 12 SMALL independent ' + industry + ' businesses in ' + location + ', Mexico with websites. EXCLUDE big chains, international brands, resorts. Focus on local family-owned small businesses. JSON: [{name,url,industry,location}]' }] });
    const text = msg.content.map(c=>c.text||'').join('').trim().replace(/```json|```/g,'');
    const parsed = JSON.parse(text.match(/\[[\s\S]*\]/)[0]);
    const prefs = readPrefs(); const now = Date.now();
    const results = parsed
      .filter(b => { const p = prefs[b.url]; return !(p && p.verdict === 'not_good' && (now - p.date) < 30*24*60*60*1000); })
      .map(b => ({ id: Buffer.from(b.url+Math.random()).toString('base64').slice(0,20).replace(/[^a-zA-Z0-9]/g,'x'), name: b.name, url: b.url, industry: b.industry||industry, location: b.location||location, status: 'pending', addedAt: new Date().toISOString() }));
    results.forEach(upsertBusiness);
    return res.json({ results, source: 'claude' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/audit/:id', async (req, res) => {
  const db = readDB(); const biz = db.find(b => b.id === req.params.id);
  if (!biz) return res.status(404).json({ error: 'Not found' });
  let siteContent = '';
  try { const resp = await axios.get(biz.url, { timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0' } }); const cheerio = require('cheerio'); const $ = cheerio.load(resp.data); $('script,style,img,svg,nav,footer').remove(); siteContent = $('body').text().replace(/\s+/g,' ').slice(0,3000); } catch { siteContent = 'Could not fetch. Domain: ' + biz.url + ', Type: ' + biz.industry; }
  try {
    const msg = await client.messages.create({ model: 'claude-sonnet-4-20250514', max_tokens: 2000, system: 'You are a web conversion and UX expert. Return ONLY raw JSON, no markdown.', messages: [{ role: 'user', content: 'Audit this ' + biz.industry + ' business website: ' + biz.url + '\nBusiness: ' + biz.name + '\nContent: ' + siteContent + '\n\nReturn ONLY this JSON structure:\n{"overall_score":0,"size_assessment":"small/medium/large chain - only audit small-medium independents","summary":"2-3 sentences on how weaknesses hurt revenue","revenue_impact":"specific estimate of lost leads/revenue","recommended_package":"starter|growth|premium|custom","package_reasoning":"1 sentence why this package fits","scores":{"ux_ui":0,"lead_generation":0,"navigation":0,"mobile":0},"findings":[{"title":"string","priority":"high","description":"actionable finding with revenue impact"}]}\n\nPackage guide: starter=$12k-18k MXN (simple sites needing refresh), growth=$25k-40k MXN (needs booking/integration), premium=$50k-80k MXN (full custom build), custom=TBC (complex booking systems or multi-location).\nScores 0-100, priority=high/medium/low, 5-7 findings.' }] });
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
    const msg = await client.messages.create({ model: 'claude-sonnet-4-20250514', max_tokens: 1500, messages: [{ role: 'user', content: 'Write a professional web proposal in ' + language + ' from Sunset Web Studio, a boutique web agency in Puerto Vallarta (hello@sunsetwebstudio.mx).\n\nClient: ' + biz.name + ' | Industry: ' + biz.industry + ' | Current score: ' + biz.audit.overall_score + '/100\nSummary: ' + biz.audit.summary + '\nRevenue impact: ' + biz.audit.revenue_impact + '\nFindings:\n' + findings + '\n\nRecommended package: ' + pkg.name + ' (' + pkg.range + ', ' + pkg.timeline + ')\nPackage reasoning: ' + (biz.audit.package_reasoning||'') + '\nPackage includes: ' + pkg.features.join(', ') + '\n\nStructure the proposal as:\n1. Personalised opening referencing their specific situation\n2. What their current website is costing them (use revenue_impact)\n3. Key findings (list the top 3-4 with impact)\n4. Our recommended solution with package details and investment range\n5. Timeline\n6. Clear CTA\n\nTone: warm, confident, not salesy. ~450 words. No placeholders. Plain text with short bold headings.' }] });
    const proposal = msg.content.map(c=>c.text||'').join('').trim();
    res.json({ proposal, package: pkg, business: upsertBusiness({ ...biz, proposal, proposalGeneratedAt: new Date().toISOString() }) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Save verdict (good find / not good find)
app.post('/api/verdict/:id', (req, res) => {
  const { verdict } = req.body; // 'good' or 'not_good'
  const db = readDB(); const biz = db.find(b=>b.id===req.params.id);
  if (!biz) return res.status(404).json({ error: 'Not found' });
  const prefs = readPrefs();
  prefs[biz.url] = { verdict, date: Date.now(), name: biz.name };
  writePrefs(prefs);
  const updated = upsertBusiness({ ...biz, verdict, verdictAt: new Date().toISOString() });
  res.json(updated);
});

app.get('/api/config', (req, res) => res.json({ mapsKey: process.env.GOOGLE_MAPS_KEY || '' }));
app.get('/api/businesses', (req, res) => res.json(readDB()));
app.get('/api/preferences', (req, res) => res.json(readPrefs()));
app.get('/api/businesses/:id', (req, res) => { const biz = readDB().find(b=>b.id===req.params.id); biz ? res.json(biz) : res.status(404).json({ error: 'Not found' }); });
app.delete('/api/businesses/:id', (req, res) => { writeDB(readDB().filter(b=>b.id!==req.params.id)); res.json({ ok: true }); });
app.delete('/api/businesses', (req, res) => { writeDB([]); res.json({ ok: true }); });
app.get('/{*splat}', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
const PORT = process.env.PORT || 3333;
app.listen(PORT, () => console.log('Sunset Audit Tool running at http://localhost:' + PORT));
