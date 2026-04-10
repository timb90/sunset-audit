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
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Ensure data dir exists
if (!fs.existsSync(path.join(__dirname, 'data'))) {
  fs.mkdirSync(path.join(__dirname, 'data'));
}
if (!fs.existsSync(DB_FILE)) {
  fs.writeFileSync(DB_FILE, JSON.stringify([]));
}

function readDB() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch { return []; }
}

function writeDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

function upsertBusiness(biz) {
  const db = readDB();
  const idx = db.findIndex(b => b.id === biz.id);
  if (idx >= 0) db[idx] = { ...db[idx], ...biz };
  else db.push(biz);
  writeDB(db);
  return biz;
}

// ── SEARCH: Use Google Custom Search or fallback to curated PV list ──
app.post('/api/search', async (req, res) => {
  const { industry, location = 'Puerto Vallarta' } = req.body;
  
  // Try Google Custom Search if keys exist
  if (process.env.GOOGLE_API_KEY && process.env.GOOGLE_CX) {
    try {
      const query = `${industry} ${location} website`;
      const resp = await axios.get('https://www.googleapis.com/customsearch/v1', {
        params: { key: process.env.GOOGLE_API_KEY, cx: process.env.GOOGLE_CX, q: query, num: 10 }
      });
      const results = (resp.data.items || []).map(item => ({
        id: Buffer.from(item.link).toString('base64').slice(0, 16),
        name: item.title.split('|')[0].split('-')[0].trim(),
        url: item.link,
        industry,
        location,
        status: 'pending',
        addedAt: new Date().toISOString()
      }));
      results.forEach(upsertBusiness);
      return res.json({ results, source: 'google' });
    } catch (e) {
      console.log('Google search failed, using Claude fallback:', e.message);
    }
  }

  // Fallback: ask Claude to generate a realistic list
  try {
    const msg = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      system: 'Return ONLY a JSON array, no other text.',
      messages: [{
        role: 'user',
        content: `Generate a realistic list of 8 real or plausible ${industry} businesses in ${location}, Mexico that would have websites. For each include: name (string), url (string - real or plausible domain), industry ("${industry}"), location ("${location}"). Return JSON array only.`
      }]
    });
    
    const text = msg.content.map(c => c.text || '').join('').trim();
    const clean = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);
    
    const results = parsed.map(b => ({
      id: Buffer.from(b.url).toString('base64').slice(0, 16),
      name: b.name,
      url: b.url,
      industry: b.industry || industry,
      location: b.location || location,
      status: 'pending',
      addedAt: new Date().toISOString()
    }));
    results.forEach(upsertBusiness);
    return res.json({ results, source: 'claude' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── AUDIT a single business ──
app.post('/api/audit/:id', async (req, res) => {
  const db = readDB();
  const biz = db.find(b => b.id === req.params.id);
  if (!biz) return res.status(404).json({ error: 'Not found' });

  // Try to fetch the site
  let siteContent = '';
  try {
    const resp = await axios.get(biz.url, { timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0' } });
    const cheerio = require('cheerio');
    const $ = cheerio.load(resp.data);
    $('script, style, img, svg').remove();
    siteContent = $('body').text().replace(/\s+/g, ' ').slice(0, 3000);
  } catch {
    siteContent = `Could not fetch site. Infer from domain: ${biz.url} and business type: ${biz.industry} in ${biz.location}`;
  }

  try {
    const msg = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1500,
      system: 'You are a web conversion and UX expert. Return ONLY a raw JSON object, no markdown, no backticks, no explanation.',
      messages: [{
        role: 'user',
        content: `Audit this ${biz.industry} business website for: ${biz.url}
Business: ${biz.name}, Industry: ${biz.industry}, Location: ${biz.location}
Site content sample: ${siteContent}

Return ONLY this JSON (no other text):
{
  "overall_score": 0,
  "summary": "2-3 sentence summary explaining how current website weaknesses are impacting revenue and lead generation",
  "revenue_impact": "1-2 sentence specific estimate of how much revenue/leads they may be losing due to poor website",
  "scores": {
    "ux_ui": 0,
    "lead_generation": 0,
    "navigation": 0,
    "mobile": 0
  },
  "findings": [
    {"title": "string", "priority": "high", "description": "specific actionable finding with revenue impact"}
  ]
}

Rules: all scores 0-100, priority = high/medium/low, 5-7 findings, focus on UX/UI/lead gen/navigation weaknesses and how they affect revenue. Be industry-specific for ${biz.industry}. Tailor revenue impact to the specific business type.`
      }]
    });

    const text = msg.content.filter(c => c.type === 'text').map(c => c.text).join('').trim();
    const clean = text.replace(/```json|```/g, '').trim();
    const match = clean.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON in response');
    const audit = JSON.parse(match[0]);

    const updated = upsertBusiness({
      ...biz,
      audit,
      status: audit.overall_score <= 50 ? 'weak' : 'ok',
      auditedAt: new Date().toISOString()
    });
    res.json(updated);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GENERATE PROPOSAL ──
app.post('/api/proposal/:id', async (req, res) => {
  const { language = 'English' } = req.body;
  const db = readDB();
  const biz = db.find(b => b.id === req.params.id);
  if (!biz || !biz.audit) return res.status(400).json({ error: 'Audit required first' });

  const findings = biz.audit.findings.map(f => `- [${f.priority.toUpperCase()}] ${f.title}: ${f.description}`).join('\n');

  try {
    const msg = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1200,
      messages: [{
        role: 'user',
        content: `Write a professional web project proposal in ${language} on behalf of Sunset Web Studio, a boutique web agency in Puerto Vallarta, Mexico (hello@sunsetwebstudio.mx).

Client: ${biz.name}
Industry: ${biz.industry}
Location: ${biz.location}
Website score: ${biz.audit.overall_score}/100
Audit summary: ${biz.audit.summary}
Revenue impact: ${biz.audit.revenue_impact}
Key findings:
${findings}

The proposal should:
1. Open referencing their specific situation and audit score
2. Explain the revenue being lost due to website issues (use the revenue_impact)
3. Outline what Sunset Web Studio will deliver (tailored to the findings)
4. State a realistic investment range and 6-8 week timeline
5. Close with a clear CTA

Tone: confident, warm, not salesy. ~400 words. Ready to send — no placeholders. Plain text with short headings.`
      }]
    });

    const proposal = msg.content.map(c => c.text || '').join('').trim();
    const updated = upsertBusiness({ ...biz, proposal, proposalGeneratedAt: new Date().toISOString() });
    res.json({ proposal, business: updated });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── DATA endpoints ──
app.get('/api/debug', (req, res) => res.json({ env: Object.keys(process.env).filter(k=>k.includes('GOOGLE')), mapsKey: process.env.GOOGLE_MAPS_KEY, len: (process.env.GOOGLE_MAPS_KEY||{}).length }));
app.get('/api/config', (req, res) => res.json({ mapsKey: process.env.GOOGLE_MAPS_KEY || '' }));
app.get('/api/businesses', (req, res) => res.json(readDB()));
app.get('/api/businesses/:id', (req, res) => {
  const biz = readDB().find(b => b.id === req.params.id);
  biz ? res.json(biz) : res.status(404).json({ error: 'Not found' });
});
app.delete('/api/businesses/:id', (req, res) => {
  const db = readDB().filter(b => b.id !== req.params.id);
  writeDB(db);
  res.json({ ok: true });
});
app.delete('/api/businesses', (req, res) => {
  writeDB([]);
  res.json({ ok: true });
});

app.get('/{*splat}', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3333;
app.listen(PORT, () => console.log(`\n🌅 Sunset Audit Tool running at http://localhost:${PORT}\n`));
