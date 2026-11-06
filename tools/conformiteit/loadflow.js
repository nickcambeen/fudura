/* Eigen loadflow-voorcheck blindvermogen (basispark-opbouw), Fudura.
   Geen kopie van de BLOS-tool: eigen implementatie van de NBNL RfG/ESM CVD v2.0-hoekpunten
   (PPM Type B/C/D < 300 kV) en Netcode art. 3.19. Complexe rekening per fase met lijnspanning. */
(function (G) {
  'use strict';
  const C = (re, im = 0) => ({ re, im });
  const add = (a, b) => C(a.re + b.re, a.im + b.im), sub = (a, b) => C(a.re - b.re, a.im - b.im);
  const mul = (a, b) => C(a.re * b.re - a.im * b.im, a.re * b.im + a.im * b.re);
  const div = (a, b) => { const d = b.re * b.re + b.im * b.im; return C((a.re * b.re + a.im * b.im) / d, (a.im * b.re - a.re * b.im) / d); };
  const conj = a => C(a.re, -a.im), abs = a => Math.hypot(a.re, a.im), sc = (a, k) => C(a.re * k, a.im * k);
  const R3 = Math.sqrt(3), W = 2 * Math.PI * 50;

  // Kabelbibliotheek: R (Ω/km, bij bedrijfstemperatuur), X (Ω/km), C (µF/km). Indicatief; controleer met datasheet.
  const KABELS = {
    'MS 3×1×95 Al XLPE':  { R:0.410, X:0.130, C:0.21, Iz:245 },
    'MS 3×1×150 Al XLPE': { R:0.265, X:0.122, C:0.25, Iz:315 },
    'MS 3×1×240 Al XLPE': { R:0.161, X:0.115, C:0.30, Iz:415 },
    'MS 3×1×400 Al XLPE': { R:0.102, X:0.108, C:0.36, Iz:530 },
    'MS 3×1×630 Al XLPE': { R:0.063, X:0.103, C:0.43, Iz:680 },
    'LS 4×150 Al':        { R:0.265, X:0.080, C:0, Iz:270 },
    'LS 4×240 Al':        { R:0.161, X:0.080, C:0, Iz:355 },
    'LS 1×630 Al (per fase)': { R:0.064, X:0.090, C:0, Iz:740 },
    'LS 1×630 Cu (per fase)': { R:0.039, X:0.090, C:0, Iz:960 },
    'LS 3×240 Cu (3-fase, IT)': { R:0.098, X:0.080, C:0, Iz:430 },
    'LS 3×150 Cu (3-fase, IT)': { R:0.159, X:0.080, C:0, Iz:330 },
  };

  // Hoekpunten PPM Type B/C/D<300 kV (CVD v2.0 p. 82). q > 0 = leveren (lagging), q < 0 = opnemen (leading).
  // red: 1 = P mag tot 0,93 (art. 3.19 lid 7), 2 = P mag omlaag t.b.v. stroomgrens (art. 3.19 lid 3), 3 = P mag tot 0,8 (art. 3.15 lid 9a)
  const CASES = [
    { n:1,  u:1.00, p:1.0, q:-0.33, red:1, txt:'max. opnemen' },
    { n:2,  u:1.00, p:1.0, q:+0.33, red:1, txt:'max. leveren' },
    { n:3,  u:1.00, p:0.2, q:-0.33, red:0, txt:'max. opnemen' },
    { n:4,  u:1.00, p:0.2, q:+0.33, red:0, txt:'max. leveren' },
    { n:5,  u:1.00, p:0.0, q:0,     red:0, txt:'−10 … +10 %' },
    { n:6,  u:1.10, p:1.0, q:-0.33, red:1, txt:'max. opnemen' },
    { n:7,  u:1.10, p:1.0, q:0,     red:0, txt:'0' },
    { n:8,  u:1.05, p:1.0, q:+0.33, red:1, txt:'max. leveren' },
    { n:9,  u:0.95, p:1.0, q:+0.33, red:2, txt:'max. leveren' },
    { n:10, u:0.95, p:1.0, q:-0.33, red:2, txt:'max. opnemen' },
    { n:11, u:0.90, p:1.0, q:+0.20, red:2, txt:'≥ 20 % leveren' },
    { n:12, u:0.90, p:1.0, q:0,     red:2, txt:'0' },
    { n:13, u:0.85, p:1.0, q:0,     red:3, txt:'geen eis (P ≥ 80 %)' },
    { n:14, u:1.00, p:0.4, q:+0.33, red:0, txt:'max. leveren (0,4 Pmax)' },
    { n:15, u:1.00, p:0.4, q:-0.33, red:0, txt:'max. opnemen (0,4 Pmax)' },
  ];

  function num(v, d) { const x = parseFloat(String(v ?? '').replace(',', '.')); return isFinite(x) ? x : d; }
  function cab(type, L_m, par, eigen) {
    const k = type === 'eigen' ? eigen : KABELS[type];
    if (!k || !(L_m > 0)) return { Z:C(0), B:0, Iz:Infinity };
    const L = L_m / 1000, n = Math.max(1, par | 0);
    return { Z:C(k.R * L / n, k.X * L / n), B:W * (k.C || 0) * 1e-6 * L * n, Iz:(k.Iz || Infinity) * n };
  }
  function trafoZ(t) { // Ω op primaire kV
    const S = num(t.S, 1), U = num(t.U1, 10), uk = num(t.uk, 6) / 100, pk = num(t.Pk, 0) / 1000 / S;
    const x = Math.sqrt(Math.max(uk * uk - pk * pk, 0));
    return sc(C(pk, x), U * U / S);
  }

  // Netwerk opbouwen uit invoer (MVA, kV, Ω)
  function bouw(I) {
    const ntr = Math.max(1, num(I.ntr, 1) | 0), ninv = Math.max(1, num(I.ninv, 1) | 0);
    const net = {
      Uc: num(I.Uc, 10), ntr, perTr: ninv / ntr, ninv,
      hs: I.hs_aan ? { Z:trafoZ(I.hs), U1:num(I.hs.U1, 110), U2:num(I.hs.U2, 10), P0:num(I.hs.P0, 0) / 1000, step:num(I.hs.step, 2.5) / 100, S:num(I.hs.S, 1) } : null,
      Xext: num(I.Xext, 0),
      opms: cab(I.opms.type, num(I.opms.L, 0), num(I.opms.n, 1), I.opms.eigen),
      mstr: cab(I.mstr.type, num(I.mstr.L, 0), num(I.mstr.n, 1), I.mstr.eigen),
      ls: cab(I.ls.type, num(I.ls.L, 0), num(I.ls.n, 1), I.ls.eigen),
      tr: { Z:trafoZ(I.tr), U1:num(I.tr.U1, 10), U2:num(I.tr.U2, 0.4), P0:num(I.tr.P0, 0) / 1000, step:num(I.tr.step, 2.5) / 100, S:num(I.tr.S, 1) },
      inv: { S:num(I.inv.S, 1000) / 1000, P:num(I.inv.P, num(I.inv.S, 1000)) / 1000, Un:num(I.inv.Un, 400) / 1000,
             Imax:(num(I.inv.Imax, 0) / 1000) || num(I.inv.S, 1000) / (R3 * num(I.inv.Un, 400)), Q:num(I.inv.Q, 0) / 1000 || num(I.inv.S, 1000) / 1000,
             Qo:Math.abs(num(I.inv.Qopn, 0)) / 1000 || num(I.inv.Q, 0) / 1000 || num(I.inv.S, 1000) / 1000,
             umin:num(I.inv.UminV, 0) ? num(I.inv.UminV) / num(I.inv.Un, 400) : num(I.inv.umin, 0.85), umax:num(I.inv.UmaxV, 0) ? num(I.inv.UmaxV) / num(I.inv.Un, 400) : num(I.inv.umax, 1.1) },
    };
    return net;
  }
  // Serie-element, net-zijde → omvormer-zijde. S = vermogen dat aan de net-zijde het net in gaat (productie > 0).
  function serF(V, S, Z, B) {
    S = sub(S, C(0, abs(V) ** 2 * B / 2));
    const I = conj(div(S, sc(V, R3)));
    const V2 = add(V, sc(mul(Z, I), R3));
    const S2 = sub(add(S, sc(Z, 3 * abs(I) ** 2)), C(0, abs(V2) ** 2 * B / 2));
    return { V:V2, S:S2, I:abs(I) };
  }
  function serB(V, S, Z, B) { // omvormer-zijde → net-zijde
    S = add(S, C(0, abs(V) ** 2 * B / 2));
    const I = conj(div(S, sc(V, R3)));
    const V2 = sub(V, sc(mul(Z, I), R3));
    const S2 = add(sub(S, sc(Z, 3 * abs(I) ** 2)), C(0, abs(V2) ** 2 * B / 2));
    return { V:V2, S:S2, I:abs(I) };
  }
  // Vooruit: van OP (u, P, Q) naar omvormerklemmen
  function vooruit(net, u, P, Q, tapHS, tapTR) {
    let V = C(u * net.Uc), S = C(P, Q), r, info = {};
    if (net.hs) {
      S = add(S, C(net.hs.P0));
      r = serF(V, S, net.hs.Z, 0); info.Ihs = r.I; S = r.S;
      V = sc(r.V, 1 / (net.hs.U1 * (1 + net.hs.step * tapHS) / net.hs.U2));
    }
    if (net.Xext) { r = serF(V, S, C(0, net.Xext), 0); V = r.V; S = r.S; }
    r = serF(V, S, net.opms.Z, net.opms.B); V = r.V; S = r.S; info.Iopms = r.I; info.Ums = abs(V) / net.tr.U1;
    S = sc(S, 1 / net.ntr);
    r = serF(V, S, net.mstr.Z, net.mstr.B); V = r.V; S = r.S; info.Imstr = r.I;
    S = add(S, C(net.tr.P0));
    r = serF(V, S, net.tr.Z, 0); S = r.S; info.Itr = r.I; info.Str = abs(S) / net.tr.S;
    V = sc(r.V, 1 / (net.tr.U1 * (1 + net.tr.step * tapTR) / net.tr.U2));
    r = serF(V, S, net.ls.Z, net.ls.B); V = r.V; S = r.S; info.Ils = r.I;
    info.Bopms = info.Iopms * 1000 / net.opms.Iz; info.Bmstr = info.Imstr * 1000 / net.mstr.Iz; info.Btr = info.Str; info.Bls = info.Ils * 1000 / net.ls.Iz;
    const Si = sc(S, 1 / net.perTr), Vi = abs(V), iv = net.inv;
    const Ii = abs(Si) / (R3 * Vi);
    return { u:Vi / iv.Un, s:abs(Si) / iv.S, i:Ii / iv.Imax, p:Si.re / iv.P, q:Si.im >= 0 ? Si.im / iv.Q : -Si.im / iv.Qo, Pinv:Si.re, Qinv:Si.im, info };
  }
  // Terug: van omvormerklemmen (u=1, P, Q=0) naar OP → Pmax-case
  function terug(net, uinv, Pinv, Qinv, tapHS, tapTR) {
    let V = C(uinv * net.inv.Un), S = C(Pinv * net.perTr, Qinv * net.perTr), r;
    r = serB(V, S, net.ls.Z, net.ls.B); V = r.V; S = r.S;
    V = sc(V, net.tr.U1 * (1 + net.tr.step * tapTR) / net.tr.U2);
    r = serB(V, S, net.tr.Z, 0); V = r.V; S = sub(r.S, C(net.tr.P0));
    r = serB(V, S, net.mstr.Z, net.mstr.B); V = r.V; S = sc(r.S, net.ntr);
    r = serB(V, S, net.opms.Z, net.opms.B); V = r.V; S = r.S;
    if (net.Xext) { r = serB(V, S, C(0, net.Xext), 0); V = r.V; S = r.S; }
    if (net.hs) { V = sc(V, net.hs.U1 * (1 + net.hs.step * tapHS) / net.hs.U2); r = serB(V, S, net.hs.Z, 0); V = r.V; S = sub(r.S, C(net.hs.P0)); }
    return { P:S.re, Q:S.im, u:abs(V) / net.Uc };
  }
  const EPS = 1e-4;
  function grens(r, iv) { // welke grens wordt overschreden
    const f = [];
    if (r.u > iv.umax + EPS) f.push('U hoog'); if (r.u < iv.umin - EPS) f.push('U laag');
    if (r.s > 1 + EPS) f.push('S'); if (r.i > 1 + EPS) f.push('I'); if (r.p > 1 + EPS) f.push('P'); if (r.q > 1 + EPS) f.push('Q');
    return f;
  }
  // Eén hoekpunt: eerst volle P, anders P verlagen voor zover toegestaan
  function hoekpunt(net, c, Pmax, tapHS, tapTR) {
    const Q = c.q * Pmax, P0 = c.p * Pmax;
    const pmin = c.red === 1 ? 0.93 : c.red === 2 ? 0 : c.red === 3 ? 0.8 : c.p;
    let r = vooruit(net, c.u, P0, Q, tapHS, tapTR), f = grens(r, net.inv);
    if (!f.length) return { ...c, P:P0, Q, r, ok:true, verlaagd:false, f };
    const alleenStroom = f.every(x => x === 'S' || x === 'I' || x === 'P');
    if (c.red && alleenStroom) {
      let lo = pmin * Pmax, hi = P0, rl = vooruit(net, c.u, lo, Q, tapHS, tapTR);
      if (!grens(rl, net.inv).length) {
        for (let k = 0; k < 40; k++) { const m = (lo + hi) / 2, rm = vooruit(net, c.u, m, Q, tapHS, tapTR); if (grens(rm, net.inv).length) hi = m; else { lo = m; rl = rm; } }
        return { ...c, P:lo, Q, r:rl, ok:true, verlaagd:true, f:[] };
      }
      // ook met de toegestane verlaging lukt het niet: toon de toestand bij volle P (met de grenzen die daar knellen)
    }
    return { ...c, P:P0, Q, r, ok:false, verlaagd:false, f };
  }
  function bereken(I, opt = {}) {
    const net = bouw(I);
    if (opt.mut) opt.mut(net);
    const tapHS = opt.tapHS ?? num(I.hs?.tap, 0), tapTR = opt.tapTR ?? num(I.tr.tap, 0);
    const pm = terug(net, 1, net.inv.P, 0, tapHS, tapTR);
    let Pmax = pm.P; const lim = opt.Plim ?? num(I.Plim, 0);
    if (lim > 0 && lim < Pmax) Pmax = lim;
    const auto = net.hs && (opt.hsAuto ?? (I.hs_auto === true || I.hs_auto === 'true' || I.hs_auto === '1'));
    const kand = Array.from({ length:19 }, (_, i) => i - 9).sort((a, b) => Math.abs(a - tapHS) - Math.abs(b - tapHS));
    const cases = CASES.map(c => {
      if (!auto) return hoekpunt(net, c, Pmax, tapHS, tapTR);
      let eerste = null;
      for (const a of kand) { const h = hoekpunt(net, c, Pmax, a, tapTR); h.tapHS = a; if (!eerste) eerste = h; if (h.ok && !h.verlaagd) return h; if (h.ok && (!eerste.ok)) eerste = h; }
      return eerste;
    });
    const pmc = vooruit(net, pm.u, pm.P, pm.Q, tapHS, tapTR);
    return { net, Pmax, PmaxNat:pm.P, Qpm:pm.Q, uPm:pm.u, cases, ok:cases.every(c => c.ok), nOk:cases.filter(c => c.ok).length, tapHS, tapTR, pmc, auto };
  }
  // Suggesties: zoek wat het groen maakt
  function suggesties(I) {
    const basis = bereken(I), S = [];
    if (basis.ok) return { basis, lijst:[] };
    const taps = [-2, -1, 0, 1, 2];
    // 1. stand MS/LS-trafo
    const tr = taps.map(t => ({ t, r:bereken(I, { tapTR:t }) }));
    const trOk = tr.filter(x => x.r.ok);
    if (trOk.length) S.push({ soort:'tap', titel:'Zet de aftakschakelaar MS/LS in stand ' + trOk.map(x => (x.t > 0 ? '+' : '') + x.t).join(' of '), uitleg:'Dan voldoen alle hoekpunten bij Pmax ' + f2(trOk[0].r.Pmax) + ' MW.', set:{ 'tr.tap':trOk.find(x => x.t === 0)?.t ?? trOk[0].t } });
    else {
      const ex = x => { const v = venster(x.r); return v ? Math.max(0, v.hi - x.r.net.inv.umax) + Math.max(0, x.r.net.inv.umin - v.lo) : 0; };
      const sc2 = x => x.r.nOk * 10 - ex(x), nu = sc2({ r:basis }), beste = tr.slice().sort((a, b) => sc2(b) - sc2(a))[0];
      if (beste && beste.t !== basis.tapTR && sc2(beste) > nu + 0.004 && beste.r.nOk >= basis.nOk) { const v = venster(beste.r); S.push({ soort:'tap', titel:'Stand MS/LS ' + (beste.t > 0 ? '+' : '') + beste.t + ' verbetert de spanning', uitleg:'Nog niet alles groen' + (v ? ': nodig venster ' + f2(v.lo) + '–' + f2(v.hi) + ' pu' : '') + '. Combineer met een van de andere suggesties.', set:{ 'tr.tap':beste.t } }); }
    }
    // 2. HS/MS-trap
    if (I.hs_aan) {
      const hs = [];
      for (let a = -9; a <= 9; a++) for (const t of taps) { const r = bereken(I, { tapHS:a, tapTR:t }); if (r.ok) hs.push({ a, t, r }); }
      if (hs.length && !trOk.length) { const b = hs.sort((x, y) => Math.abs(x.a) - Math.abs(y.a))[0]; S.push({ soort:'tap', titel:'HS/MS-trafo in stand ' + b.a + ' en MS/LS in stand ' + b.t, uitleg:'Alle hoekpunten groen bij Pmax ' + f2(b.r.Pmax) + ' MW. Met een online regelschakelaar mag de HS/MS-trap per hoekpunt meeregelen.', set:{ 'hs.tap':b.a, 'tr.tap':b.t } });
      }
    }
    // 3. Pmax begrenzen (beste stand)
    let best = null;
    for (const t of taps) {
      // van boven naar beneden zoeken (niet monotoon: bij heel laag P kan de spanning juist te hoog worden)
      let ok = null, fout = basis.PmaxNat;
      for (let k = 1; k <= 50; k++) { const P = basis.PmaxNat * (1 - 0.01 * k); if (bereken(I, { tapTR:t, Plim:P }).ok) { ok = P; break; } fout = P; }
      if (ok == null) continue;
      let lo = ok, hi = fout;
      for (let k = 0; k < 20; k++) { const m = (lo + hi) / 2; if (bereken(I, { tapTR:t, Plim:m }).ok) lo = m; else hi = m; }
      if (!best || lo > best.P) best = { P:lo, t };
    }
    if (best && best.P >= 0.5 * basis.PmaxNat && best.P < basis.PmaxNat - 1e-3) S.push({ soort:'pmax', titel:'Begrens Pmax op ' + f2(best.P * 0.995) + ' MW' + (best.t !== basis.tapTR ? ' (stand ' + (best.t > 0 ? '+' : '') + best.t + ')' : ''), uitleg:'Het park levert dan ' + f1(100 * (1 - best.P / basis.PmaxNat)) + ' % minder dan de ' + f2(basis.PmaxNat) + ' MW die de omvormers kunnen. Dit is het vermogen dat je in het formulier als maximumcapaciteit opgeeft.', set:{ Plim:+(best.P * 0.995).toFixed(3), 'tr.tap':best.t } });
    // 4. Grotere omvormer (S en I)
    const fac = zoekFactor(k => bereken(I, { mut:n => { n.inv.S *= k; n.inv.Imax *= k; n.inv.Q *= k; } }).ok, 1, 1.6);
    if (fac) S.push({ soort:'omv', titel:'Omvormer met ≥ ' + Math.ceil(num(I.inv.S) * fac / 10) * 10 + ' kVA (en evenredig meer stroom)', uitleg:'Zelfde werkzaam vermogen, meer ruimte voor blindvermogen. Vraag het PQ-diagram bij de leverancier.' });
    // 5. Spanningsvenster omvormer
    const b0 = basis, v = venster(basis);
    // realistische grenzen: onder 0,85 pu (20 min, Netcode art. 3.15 lid 9; getoetst voor omvormers op de NBNL-lijst), boven +12 %
    const RLO = 0.85, RHI = 1.12;
    const vReal = v && v.lo >= RLO - 1e-9 && v.hi <= RHI + 1e-9;
    if (v && !vReal) S.push({ soort:'regel', titel:'Spanning op de omvormer loopt te ver weg (' + Math.round(v.lo * 100) + '–' + Math.round(v.hi * 100) + ' % van Unom nodig)', uitleg:'Dat is meer dan een omvormer realistisch kan (85–112 %). Oplossing: een regelschakelaar die de spanning vasthoudt' + (I.hs_aan ? ' — zet bij “Niet in BLOS” de regelschakelaar HS/MS op automatisch (zie de combinaties hieronder) en vraag de netbeheerder/eigenaar of de HS/MS-trafo dat kan.' : ' — bijvoorbeeld MS/LS-trafo’s met regelschakelaar onder belasting, of een eigen HS/MS-trafo met regeling. Reken dat door in Vision.') });
    if (v && vReal) { const Un = num(I.inv.Un, 400), iv0 = b0.net.inv, lo = v.lo < iv0.umin - EPS, hi = v.hi > iv0.umax + EPS, pc = x => Math.round(x * 100) + ' %';
      const delen = [lo ? 'Umin omlaag naar ' + Math.floor(v.lo * Un) + ' V (' + pc(v.lo) + ', nu ' + Math.round(iv0.umin * Un) + ' V)' : '', hi ? 'Umax omhoog naar ' + Math.ceil(v.hi * Un) + ' V (' + pc(v.hi) + ', nu ' + Math.round(iv0.umax * Un) + ' V)' : ''].filter(Boolean);
      S.push({ soort:'venster', titel:'Spanningsvenster omvormer: ' + delen.join(' en '), uitleg:(lo && !hi ? 'Umax is voldoende; het knelt aan de onderkant (lage netspanning). Omvormers op de NBNL-lijst zijn getoetst op 0,85 pu gedurende 20 minuten (Netcode art. 3.15 lid 9), dus tot 85 % is vaak haalbaar; bevestigen bij de leverancier. ' : hi && !lo ? 'Umin is voldoende; het knelt aan de bovenkant (hoge netspanning). ' : '') + 'Vraag de leverancier of de omvormer (en de beveiliging U&lt; / U&gt;) dit toestaat.', set:{ ...(lo ? { 'inv.UminV':Math.floor(v.lo * Un) } : {}), ...(hi ? { 'inv.UmaxV':Math.ceil(v.hi * Un) } : {}) } }); }
    // 6. Meer parallelle kabels OP–MS
    if (num(I.opms.L, 0) > 0) { const r = bereken({ ...I, opms:{ ...I.opms, n:num(I.opms.n, 1) * 2 } }); if (r.ok) S.push({ soort:'kabel', titel:'Verdubbel de OP–MS-kabels (' + num(I.opms.n, 1) * 2 + ' parallel)', uitleg:'Minder spanningsval en blindvermogenverlies.', set:{ 'opms.n':num(I.opms.n, 1) * 2 } }); }
    // 7. Lagere uk MS/LS
    const uk = num(I.tr.uk, 6); if (uk > 4.5) { const r = bereken({ ...I, tr:{ ...I.tr, uk:uk - 1 } }); if (r.ok) S.push({ soort:'trafo', titel:'MS/LS-trafo met uk ' + f1(uk - 1) + ' %', uitleg:'Minder blindvermogenverbruik in de trafo.', set:{ 'tr.uk':uk - 1 } }); }
    // Combinaties (één maatregel is vaak niet genoeg: spanning én kVA)
    const kloon = o => JSON.parse(JSON.stringify(o));
    const Un = num(I.inv.Un, 400), S0 = num(I.inv.S), Im0 = num(I.inv.Imax, 0) || S0 / (R3 * Un) * 1000, Q0 = num(I.inv.Q, 0) || S0, Qo0 = Math.abs(num(I.inv.Qopn, 0)) || Q0;
    const kva = (J, k) => { J.inv.S = String(Math.ceil(S0 * k / 10) * 10); J.inv.Imax = String(Math.ceil(Im0 * k)); J.inv.Q = String(Math.ceil(Q0 * k / 10) * 10); J.inv.Qopn = String(-Math.ceil(Qo0 * k / 10) * 10); return J; };
    const setKva = J => ({ 'inv.S':J.inv.S, 'inv.Imax':J.inv.Imax, 'inv.Q':J.inv.Q, 'inv.Qopn':J.inv.Qopn });
    const zoekKva = J0 => zoekFactor(k => bereken(kva(kloon(J0), k)).ok, 1, 1.6);
    const alAuto = I.hs_auto === true || I.hs_auto === 'true' || I.hs_auto === '1';
    if (I.hs_aan && !alAuto) {
      const A = { ...kloon(I), hs_auto:true };
      if (bereken(A).ok) S.push({ soort:'combi', titel:'Regelschakelaar HS/MS regelt automatisch', uitleg:'De HS/MS-trafo (EGD) houdt de MS-spanning vast; per case kiest hij de stand. Navragen of dat zo ingesteld is.', set:{ hs_auto:'1' } });
      else { const k = zoekKva(A); if (k) { const J = kva(kloon(A), k); S.push({ soort:'combi', titel:'Combinatie: regelschakelaar HS/MS automatisch + omvormer ≥ ' + J.inv.S + ' kVA', uitleg:'De regelschakelaar lost de spanning op, de grotere omvormer het tekort aan kVA. Let op: de stroom per rij stijgt mee (trafo, LS-kabels, LS-automaat).', set:{ hs_auto:'1', ...setKva(J) } }); } }
    }
    if (v && vReal) { const W = kloon(I); W.inv.UminV = String(Math.floor(Math.min(b0.net.inv.umin, v.lo) * Un)); W.inv.UmaxV = String(Math.ceil(Math.max(b0.net.inv.umax, v.hi) * Un));
      if (!bereken(W).ok) { const k = zoekKva(W); if (k) { const J = kva(kloon(W), k); S.push({ soort:'combi', titel:'Combinatie: spanningsvenster ' + W.inv.UminV + '–' + W.inv.UmaxV + ' V + omvormer ≥ ' + J.inv.S + ' kVA', uitleg:'Beide nodig; alleen als de leverancier dit kan leveren.', set:{ 'inv.UminV':W.inv.UminV, 'inv.UmaxV':W.inv.UmaxV, ...setKva(J) } }); } } }
    const n = num(I.ninv, 1), nt = num(I.ntr, 1);
    if (n === nt) { const X = kloon(I); X.ninv = String(n + 1); X.ntr = String(nt + 1); X.inv.P = String(Math.round(num(I.inv.P) * n / (n + 1)));
      const varianten = [[X, '']]; if (I.hs_aan && !alAuto) varianten.push([{ ...kloon(X), hs_auto:true }, ' + regelschakelaar HS/MS automatisch']);
      for (const [J, extra] of varianten) if (bereken(J).ok) { S.push({ soort:'combi', titel:'Extra rij: ' + (n + 1) + ' × omvormer/trafo' + extra, uitleg:'Zelfde totaal vermogen verdeeld over ' + (n + 1) + ' rijen (Pnom ' + J.inv.P + ' kW per omvormer); stroom per rij blijft gelijk. Kost een extra PCS, trafo en MS-veld.', set:{ ninv:J.ninv, ntr:J.ntr, 'inv.P':J.inv.P, ...(extra ? { hs_auto:'1' } : {}) } }); break; } }
    if (!S.length) S.push({ soort:'geen', titel:'Geen enkele aanpassing maakt alles groen', uitleg:'Combineer: begrens Pmax én kies een andere stand, of reken met een netberekeningsprogramma (Vision).' });
    // rangschikken: eerst wat niets kost, als laatste wat vermogen kost
    const rang = x => {
      if (x.soort === 'regel') return 0;
      if (x.soort === 'combi' && /^Regelschakelaar HS\/MS regelt/.test(x.titel)) return [10, 'Instelling bij de eigenaar, geen extra hardware'];
      if (x.soort === 'tap' && /^(Zet|HS\/MS-trafo in stand)/.test(x.titel)) return [20, 'Instelling, geen extra hardware'];
      if (x.soort === 'tap') return [90, 'Deeloplossing, combineren'];
      if (x.soort === 'combi' && /regelschakelaar HS\/MS automatisch \+ omvormer/.test(x.titel)) return [30, 'Grotere omvormer; trafo, LS-kabels en LS-automaat per rij zwaarder'];
      if (x.soort === 'venster') return [40, 'Leveroptie omvormer; controle LS-componenten'];
      if (x.soort === 'combi' && /spanningsvenster/.test(x.titel)) return [45, 'Leveroptie + grotere omvormer'];
      if (x.soort === 'omv') return [50, 'Grotere omvormer; rij zwaarder uitvoeren'];
      if (x.soort === 'trafo') return [55, 'Andere trafo'];
      if (x.soort === 'kabel') return [60, 'Extra kabels'];
      if (x.soort === 'combi' && /^Extra rij/.test(x.titel)) return [70, 'Extra PCS, trafo en MS-veld'];
      if (x.soort === 'pmax') return [95, 'Kost vermogen: alleen als begrenzen mag'];
      return [99, ''];
    };
    S.forEach(x => { const r = rang(x); x.rang = Array.isArray(r) ? r[0] : r; x.kost = Array.isArray(r) ? r[1] : ''; });
    S.sort((a, b) => a.rang - b.rang);
    return { basis, lijst:S };
  }
  function zoekFactor(test, lo, hi) { if (!test(hi)) return null; for (let k = 0; k < 25; k++) { const m = (lo + hi) / 2; if (test(m)) hi = m; else lo = m; } return hi; }
  function venster(b) {
    let lo = Infinity, hi = -Infinity;
    b.cases.forEach(c => { lo = Math.min(lo, c.r.u); hi = Math.max(hi, c.r.u); });
    const iv = b.net.inv; if (lo >= iv.umin - EPS && hi <= iv.umax + EPS) return null;
    return { lo:Math.floor(lo * 100) / 100, hi:Math.ceil(hi * 100) / 100 };
  }
  const f1 = x => (Math.round(x * 10) / 10).toString().replace('.', ','), f2 = x => (Math.round(x * 100) / 100).toFixed(2).replace('.', ',');
  // Maximaal haalbaar blindvermogen op het OP (sign +1 leveren, -1 opnemen) bij spanning u en P op het OP
  function qGrens(net, u, P, sign, tapHS, tapTR, Pmax) {
    // grootste |Q| in de gevraagde richting die binnen alle grenzen past; het haalbare gebied hoeft Q = 0 niet te bevatten
    const ok = Q => !grens(vooruit(net, u, P, sign * Q, tapHS, tapTR), net.inv).length;
    const N = 48, top = 0.8 * Pmax; let best = -1, hiFail = null;
    for (let k = N; k >= 0; k--) { const Q = top * k / N; if (ok(Q)) { best = Q; break; } hiFail = Q; }
    if (best < 0) return NaN;
    if (hiFail != null) { let lo = best, hi = hiFail; for (let k = 0; k < 20; k++) { const m = (lo + hi) / 2; if (ok(m)) lo = m; else hi = m; } best = lo; }
    return sign * best;
  }
  function vensters(I) {
    const b = bereken(I), net = b.net, Pm = b.Pmax, t1 = b.tapHS, t2 = b.tapTR;
    const qGrens0 = qGrens;
    const qG = (net_, u, P, sign, a1, a2, Pm_) => { if (!b.auto) return qGrens0(net_, u, P, sign, a1, a2, Pm_); let best = NaN; for (let a = -9; a <= 9; a++) { const q = qGrens0(net_, u, P, sign, a, a2, Pm_); if (isFinite(q) && !(Math.abs(q) <= Math.abs(best))) best = q; } return best; };
    const pq = [];
    for (let i = 0; i <= 20; i++) { const p = i / 20; pq.push({ p, qp:qG(net, 1, p * Pm, 1, t1, t2, Pm) / Pm, qm:qG(net, 1, p * Pm, -1, t1, t2, Pm) / Pm }); }
    const uq = [];
    // bij lage spanning mag P zakken: 0,90–0,95 pu voor de stroomgrens (art. 3.19 lid 3), 0,85–0,90 pu tot 0,8 (art. 3.15 lid 9a)
    const pLijst = u => u > 0.95 + 1e-9 ? [0.93] : u >= 0.9 - 1e-9 ? [0.93, 0.9, 0.85, 0.8, 0.75, 0.7, 0.6, 0.5] : [0.93, 0.9, 0.85, 0.8];
    const qBest = (u, sign) => { let best = NaN; for (const pp of pLijst(u)) { const q = qG(net, u, pp * Pm, sign, t1, t2, Pm); if (isFinite(q) && !(Math.abs(q) <= Math.abs(best))) best = q; } return best; };
    for (let i = 0; i <= 25; i++) { const u = Math.round((0.85 + i * 0.01) * 100) / 100; uq.push({ u, qp:qG(net, u, 0.93 * Pm, 1, t1, t2, Pm) / Pm, qm:qG(net, u, 0.93 * Pm, -1, t1, t2, Pm) / Pm, qpR:u <= 0.95 + 1e-9 ? qBest(u, 1) / Pm : NaN, qmR:u <= 0.95 + 1e-9 ? qBest(u, -1) / Pm : NaN, qp20:qG(net, u, 0.2 * Pm, 1, t1, t2, Pm) / Pm, qm20:qG(net, u, 0.2 * Pm, -1, t1, t2, Pm) / Pm }); }
    // oorzaak per punt: welke grens knelt als je precies de eis vraagt
    const eisQ = p => p <= 0.2 ? 0.33 * p / 0.2 : p <= 0.93 ? 0.33 : 0.33 * (1 - p) / 0.07;
    const eisUp = u => u < 0.9 ? 0 : u < 0.95 ? 0.2 + 0.13 * (u - 0.9) / 0.05 : u <= 1.05 ? 0.33 : Math.max(0, 0.33 * (1.1 - u) / 0.05);
    const eisUm = u => u < 0.9 ? 0 : u >= 0.95 ? 0.33 : 0.33 * (u - 0.9) / 0.05;
    const flags = (u, P, Q) => { const taps = b.auto ? Array.from({ length:19 }, (_, i) => i - 9) : [t1]; let best = null;
      for (const a of taps) { const f = grens(vooruit(net, u, P, Q, a, t2), net.inv); if (!best || f.length < best.length) best = f; if (!f.length) break; } return best; };
    const why = { pq:{ lev:new Set(), opn:new Set() }, uq:{ lev:new Set(), opn:new Set() } };
    pq.forEach(x => { if (x.p <= 0) return; const e = eisQ(x.p);
      if (!(x.qp >= e - 1e-3)) flags(1, x.p * Pm, e * Pm).forEach(f => why.pq.lev.add(f));
      if (!(-x.qm >= e - 1e-3)) flags(1, x.p * Pm, -e * Pm).forEach(f => why.pq.opn.add(f)); });
    uq.forEach(x => { if (x.u < 0.9 - 1e-9 || x.u > 1.1 + 1e-9) return; const pp = x.u > 0.95 + 1e-9 ? 0.93 : 0.8;
      const qpB = Math.max(x.qp || -9, x.qpR || -9), qmB = Math.min(x.qm || 9, x.qmR || 9);
      if (!(qpB >= eisUp(x.u) - 1e-3)) flags(x.u, pp * Pm, eisUp(x.u) * Pm).forEach(f => why.uq.lev.add(f));
      if (!(-qmB >= eisUm(x.u) - 1e-3)) flags(x.u, pp * Pm, -eisUm(x.u) * Pm).forEach(f => why.uq.opn.add(f)); });
    return { b, pq, uq, why };
  }
  G.LF = { KABELS, CASES, bereken, suggesties, vensters, f1, f2 };
})(typeof window !== 'undefined' ? window : globalThis);
