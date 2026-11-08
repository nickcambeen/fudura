// Getec kwartierdata 2025: alleen per dag op te vragen, nooit als heel bestand.
// De data staat versleuteld in private/getec2025.enc (AES-256-GCM); de sleutel staat alleen in de Vercel-omgevingsvariabele GETEC_DATA_KEY.
// Bereikbaar via /installaties/getec/data/dag (rewrite in vercel.json), dus achter de Getec-toegangscode van middleware.js.
// Het piek afvlakken over het hele jaar wordt hier gerekend; de browser krijgt alleen de gekozen dag en de jaartotalen.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const GETEC_HASH = '1fbf39bd330ded2b51f890570f2d5d149b19b9e69e389be7e4958aef854b4e71';
const sha = t => crypto.createHash('sha256').update(t).digest('hex');
const SESSIE = sha('getec-sessie:' + GETEC_HASH + ':' + (process.env.SESSIE_GEHEIM || ''));

let DATA = null;
function laad(){
  if(DATA) return DATA;
  const key = Buffer.from(process.env.GETEC_DATA_KEY || '', 'base64');
  const buf = fs.readFileSync(path.join(process.cwd(), 'private', 'getec2025.enc'));
  const iv = buf.subarray(0, 12), tag = buf.subarray(12, 28), enc = buf.subarray(28);
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv); d.setAuthTag(tag);
  const raw = Buffer.concat([d.update(enc), d.final()]);
  const a = new Int16Array(raw.buffer, raw.byteOffset, raw.length/2), n = a.length/3;
  DATA = {net: a.subarray(0, n), wkk: a.subarray(n, 2*n), pv: a.subarray(2*n), n};
  return DATA;
}

const BAT = {pMax: 20000, bruik: 16*5015.9*0.9, etaL: 0.95, etaO: 0.95};
const jaarCache = new Map();
function jaar(L){
  if(jaarCache.has(L)) return jaarCache.get(L);
  const d = laad(), n = d.n, B = BAT.bruik, P = BAT.pMax, m = 200, dt = 0.25;
  const p = new Float32Array(n), E = new Float32Array(n);
  let e = B, piek0 = 0, piek1 = 0, ontl = 0; const dagen = new Set();
  const mnd = Array.from({length: 12}, () => ({piek0: 0, piek1: 0}));
  const mndVan = i => new Date(Date.UTC(2025, 0, 1) + Math.floor(i/96)*864e5).getUTCMonth();
  for(let i = 0; i < n; i++){
    const g = d.net[i]; let q = 0;
    if(g > L) q = -Math.min(P, g - L, e*BAT.etaO/dt);
    else if(g < L - m && e < B) q = Math.min(P, L - m - g, (B - e)/BAT.etaL/dt);
    e = Math.max(0, Math.min(B, e + (q > 0 ? q*BAT.etaL : q/BAT.etaO)*dt));
    p[i] = q; E[i] = e;
    const met = g + q;
    piek0 = Math.max(piek0, g); piek1 = Math.max(piek1, met);
    const M = mnd[mndVan(i)]; M.piek0 = Math.max(M.piek0, g/1000); M.piek1 = Math.max(M.piek1, met/1000);
    if(met > L + 1) dagen.add(Math.floor(i/96));
    if(q < 0) ontl += -q*dt;
  }
  const r = {p, E, stats: {piek0: piek0/1000, piek1: piek1/1000, dagen: dagen.size, ontl: ontl/1000, mnd}};
  if(jaarCache.size > 30) jaarCache.clear();
  jaarCache.set(L, r);
  return r;
}

module.exports = (req, res) => {
  res.setHeader('cache-control', 'private, no-store');
  const cookies = String(req.headers.cookie || '').split(/;\s*/);
  if(!cookies.includes('fudura_getec=' + SESSIE)){ res.statusCode = 401; return res.end('{"fout":"geen toegang"}'); }
  const u = new URL(req.url, 'http://x');
  const dag = Math.round(+u.searchParams.get('d')), grens = Math.round((+u.searchParams.get('g') || 11)*2)/2;
  if(!(dag >= 0 && dag <= 364) || !(grens >= 1 && grens <= 40)){ res.statusCode = 400; return res.end('{"fout":"ongeldige dag of grens"}'); }
  let d;
  try { d = laad(); } catch(e){ res.statusCode = 500; return res.end('{"fout":"data niet beschikbaar"}'); }
  const J = jaar(grens*1000), i0 = dag*96, r1 = v => Math.round(v)/1000;
  const uit = {dag, grens, net: [], wkk: [], pv: [], p: [], E: [], jaar: J.stats};
  for(let j = 0; j < 96; j++){
    const i = i0 + j;
    uit.net.push(d.net[i]/1000); uit.wkk.push(d.wkk[i]/1000); uit.pv.push(d.pv[i]/1000);
    uit.p.push(r1(J.p[i])); uit.E.push(r1(J.E[i]));
  }
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(uit));
};
