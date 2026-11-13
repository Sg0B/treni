// Coincidenze live S.Benedetto del Tronto -> Giulianova -> Teramo, 13/11/2026
// Zero dipendenze. Avvio: node server.js  (PORT=8080 di default)
const http = require('http'), https = require('https');
const PORT = process.env.PORT || 8080;
const BASE = process.env.VT_BASE || 'https://www.viaggiatreno.it/infomobilita/resteasy/viaggiatreno';
const DAY = 1794524400000;            // 13/11/2026 00:00 Europe/Rome (CET, UTC+1)
const FR = { num: '8807', orig: 'S01700', label: 'Frecciarossa 8807' };
const IC = { num: '607', orig: 'S01645', label: 'Intercity 607' };
const REG_DEP = '16:13';              // partenza programmata regionale Giulianova -> Teramo
const MIN = 60000;

function get(path, asText) {
  return new Promise((res, rej) => {
    const u = new URL(BASE + path);
    const lib = u.protocol === 'http:' ? http : https;
    const rq = lib.get(u, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json,text/plain,*/*' }, timeout: 12000 }, r => {
      let b = ''; r.setEncoding('utf8'); r.on('data', c => b += c);
      r.on('end', () => {
        if (r.statusCode === 204 || (r.statusCode === 200 && !b.trim())) return res(null);
        if (r.statusCode !== 200) return rej(new Error('ViaggiaTreno HTTP ' + r.statusCode));
        if (asText) return res(b);
        try { res(JSON.parse(b)); } catch (e) { rej(new Error('Risposta non JSON da ViaggiaTreno')); }
      });
    });
    rq.on('timeout', () => rq.destroy(new Error('Timeout ViaggiaTreno')));
    rq.on('error', rej);
  });
}

const cache = new Map();
function memo(key, ttl, fn) {
  const c = cache.get(key);
  if (c && Date.now() - c.t < ttl) return c.p;
  const p = fn(); cache.set(key, { t: Date.now(), p });
  p.catch(() => cache.delete(key));
  return p;
}

const hm = ms => ms == null ? null : new Date(ms + 3600000).toISOString().substr(11, 5); // ora CET
function vtDate(ms) { // formato richiesto da /partenze, espresso in CET
  const d = new Date(ms + 3600000), W = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
    M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'], p = n => String(n).padStart(2, '0');
  return W[d.getUTCDay()] + ' ' + M[d.getUTCMonth()] + ' ' + p(d.getUTCDate()) + ' ' + d.getUTCFullYear() + ' ' +
    p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ':00 GMT+0100';
}
const at = (h, m) => DAY + (h * 60 + m) * MIN;
const andamento = (orig, num, day) => get('/andamentoTreno/' + orig + '/' + num + '/' + day);
const partenze = (id, ms) => memo('p' + id + ms, 90000, () => get('/partenze/' + id + '/' + encodeURIComponent(vtDate(ms))).then(x => x || []));

async function loadMain(cfg) {
  let raw = await andamento(cfg.orig, cfg.num, DAY), note = null;
  if (!raw) { // origine fornita non valida: cerco la corsa di oggi
    const txt = await get('/cercaNumeroTrenoTrenoAutocomplete/' + cfg.num, true) || '';
    for (const line of txt.split('\n')) {
      const m = line.match(/\|(\d+)-(S\d+)-(\d+)/);
      if (m && m[1] === cfg.num && +m[3] === DAY && m[2] !== cfg.orig) {
        raw = await andamento(m[2], cfg.num, DAY); note = 'Origine corretta automaticamente a ' + m[2]; break;
      }
    }
  }
  return norm(raw, cfg.label, cfg.num, note);
}

const bin = v => (v == null || !String(v).trim()) ? null : String(v).trim();
function normStop(f, rit) {
  const t = f.tipoFermata;
  let arrP = f.arrivo_teorico || null, depP = f.partenza_teorica || null;
  if (arrP == null && depP == null && f.programmata) { if (t === 'A') arrP = f.programmata; else depP = f.programmata; }
  const arrR = f.arrivoReale || null, depR = f.partenzaReale || null;
  let arrE = null, depE = null;
  if (rit != null) {
    if (!arrR && arrP != null) arrE = arrP + rit * MIN;
    if (!depR && depP != null) { depE = Math.max(depP, depP + rit * MIN); if (arrR && arrR > depE) depE = arrR; }
  }
  return {
    stazione: f.stazione, id: f.id, arrP, arrE, arrR, depP, depE, depR,
    binArrProg: bin(f.binarioProgrammatoArrivoDescrizione), binArrEff: bin(f.binarioEffettivoArrivoDescrizione),
    binDepProg: bin(f.binarioProgrammatoPartenzaDescrizione), binDepEff: bin(f.binarioEffettivoPartenzaDescrizione),
    soppressa: f.actualFermataType === 3
  };
}
function norm(raw, label, num, note) {
  if (!raw) return { ok: false, label, numero: num, error: 'Nessun dato ViaggiaTreno per questa corsa del 13/11/2026' };
  const now = Date.now(), fer = raw.fermate || [];
  const rit = typeof raw.ritardo === 'number' ? raw.ritardo : null;
  const stops = fer.map(f => normStop(f, rit));
  const first = stops[0], last = stops[stops.length - 1];
  const firstT = first && (first.depP || first.arrP);
  const dayOk = raw.dataPartenzaTreno === DAY || (raw.dataPartenzaTreno == null && firstT >= DAY && firstT < DAY + 86400000);
  const verified = dayOk && String(raw.numeroTreno) === String(num);
  let lastIdx = -1; stops.forEach((s, i) => { if (s.arrR || s.depR) lastIdx = i; });
  let stato = 'IN VIAGGIO';
  const soppresso = raw.provvedimento === 1;
  if (soppresso) stato = 'SOPPRESSO';
  else if (last && last.arrR) stato = 'ARRIVATO';
  else if (raw.nonPartito || lastIdx < 0) stato = 'NON PARTITO';
  let posizione = null;
  if (lastIdx >= 0 && stato === 'IN VIAGGIO') {
    const s = stops[lastIdx], n = stops[lastIdx + 1];
    posizione = (!s.depR && s.arrR) ? 'Fermo a ' + s.stazione : (n ? 'Tra ' + s.stazione + ' e ' + n.stazione : null);
  }
  const ora = raw.oraUltimoRilevamento || null;
  let stale = null;
  if (stato === 'IN VIAGGIO' && ora && now - ora > 15 * MIN) stale = 'Ultimo rilevamento vecchio di ' + Math.round((now - ora) / MIN) + ' min';
  if (stato === 'NON PARTITO' && firstT && now - firstT > 10 * MIN && !soppresso) stale = 'Nessun rilevamento dopo l\'orario di partenza: ritardo non affidabile';
  return {
    ok: true, label, numero: String(raw.numeroTreno), nome: (raw.compNumeroTreno || '').trim() || label,
    origine: raw.origine, destinazione: raw.destinazione, idOrigine: raw.idOrigine, verified, note,
    ritardo: rit, stato, soppresso, parziale: raw.provvedimento === 2, avviso: (raw.subTitle || '').trim() || null,
    ultimaStazione: bin(raw.stazioneUltimoRilevamento) === '--' ? null : bin(raw.stazioneUltimoRilevamento),
    oraUltimoRil: ora, posizione, stale, stops
  };
}
const findStop = (t, re) => t && t.ok ? t.stops.find(s => re.test(s.stazione)) || null : null;
const idxStop = (t, re) => t && t.ok ? t.stops.findIndex(s => re.test(s.stazione)) : -1;
const RE_SBT = /BENEDETTO.*TRONTO/i, RE_GIU = /GIULIANOVA/i, RE_TER = /^TERAMO/i;

async function stationId(query, re) {
  return memo('st' + query, 3600000, async () => {
    const txt = await get('/autocompletaStazione/' + encodeURIComponent(query), true) || '';
    for (const l of txt.split('\n')) { const [n, id] = l.split('|'); if (id && re.test(n)) return id.trim(); }
    return null;
  });
}

let regId = null; // identita' del regionale, memorizzata dopo la prima identificazione
async function teramoList(giuId) {
  const lists = await Promise.all([at(15, 50), at(17, 30), at(19, 30)].map(t => partenze(giuId, t).catch(() => [])));
  const seen = new Set(), out = [];
  for (const t of lists.flat()) {
    if (!/TERAMO/i.test(t.destinazione || '')) continue;
    const k = t.numeroTreno + '-' + t.dataPartenzaTreno; if (seen.has(k)) continue; seen.add(k); out.push(t);
  }
  return out.sort((a, b) => a.orarioPartenza - b.orarioPartenza);
}
async function altTrain(t, reFrom, reTo) { // dettaglio di un treno alternativo tra due stazioni
  const tr = norm(await andamento(t.codOrigine, t.numeroTreno, t.dataPartenzaTreno), (t.compNumeroTreno || '').trim(), t.numeroTreno);
  const i = idxStop(tr, reFrom), j = idxStop(tr, reTo);
  if (!tr.ok || i < 0 || j <= i || tr.soppresso || tr.stops[i].soppressa) return null;
  const a = tr.stops[i], b = tr.stops[j];
  return { nome: tr.nome, destinazione: tr.destinazione, ritardo: tr.ritardo, stato: tr.stato, verified: tr.dataPartenzaTreno !== null,
    depP: a.depP, dep: a.depR || a.depE || a.depP, depReale: !!a.depR, binProg: a.binDepProg, binEff: a.binDepEff,
    arrP: b.arrP, arr: b.arrR || b.arrE || b.arrP };
}

function level(m) { return m >= 10 ? 'green' : m >= 5 ? 'yellow' : m >= 2 ? 'orange' : 'red'; }
function conn(nome, stazione, da, A, verso, B, tB) {
  const c = { nome, stazione, da, verso, level: 'unknown', msg: 'Dati insufficienti per calcolare la coincidenza' };
  if (!A || !B) return c;
  const arr = A.arrR || A.arrE || A.arrP, dep = B.depR || B.depE || B.depP;
  if (arr == null || dep == null) return c;
  Object.assign(c, {
    arr, dep, arrBase: A.arrR ? 'effettivo' : A.arrE != null ? 'stimato' : 'programmato',
    depBase: B.depR ? 'effettivo' : B.depE != null ? 'stimato' : 'programmato',
    margine: Math.round((dep - arr) / MIN),
    margineProg: (A.arrP != null && B.depP != null) ? Math.round((B.depP - A.arrP) / MIN) : null,
    binDepProg: B.binDepProg, binDepEff: B.binDepEff, binArrProg: A.binArrProg || null, binArrEff: A.binArrEff || null, partito: !!B.depR
  });
  if ((tB && tB.soppresso) || B.soppressa) { c.level = 'lost'; c.msg = 'Treno o fermata soppressi'; }
  else if (B.depR && arr > B.depR) { c.level = 'lost'; c.msg = 'Coincidenza persa: il treno e\' gia\' partito'; }
  else if (B.depR && A.arrR) { c.level = 'done'; c.msg = 'Coincidenza riuscita secondo gli orari effettivi'; }
  else { c.level = level(c.margine); c.msg = c.margine < 0 ? 'Con i ritardi attuali il treno parte prima del tuo arrivo' : null; }
  return c;
}

async function status() {
  const errors = [];
  const [fr, ic] = await Promise.all([FR, IC].map(c => loadMain(c).catch(e => ({ ok: false, label: c.label, numero: c.num, error: e.message }))));
  if (!fr.ok && !ic.ok && /HTTP|Timeout|JSON|ENOTFOUND|ECONN|EAI/i.test((fr.error || '') + (ic.error || ''))) throw new Error(fr.error);
  const frSbt = findStop(fr, RE_SBT), icSbt = findStop(ic, RE_SBT), icGiu = findStop(ic, RE_GIU);
  if (fr.ok && !frSbt) errors.push('FR 8807: fermata S.Benedetto del Tronto non trovata nella corsa');
  if (ic.ok && !icSbt) errors.push('IC 607: fermata S.Benedetto del Tronto non trovata nella corsa');
  if (ic.ok && !icGiu) errors.push('IC 607: fermata Giulianova non trovata nella corsa');
  const sbtId = (icSbt && icSbt.id) || (frSbt && frSbt.id) || await stationId('S.BENEDETTO', RE_SBT).catch(() => null);
  const giuId = (icGiu && icGiu.id) || await stationId('GIULIANOVA', RE_GIU).catch(() => null);

  // Regionale Giulianova -> Teramo delle 16:13
  let reg = { ok: false, label: 'Regionale Giulianova-Teramo ' + REG_DEP, error: 'Stazione di Giulianova non risolta' }, terList = [];
  if (giuId) {
    try {
      terList = await teramoList(giuId);
      if (!regId) { const r = terList.find(t => hm(t.orarioPartenza) === REG_DEP); if (r) regId = { num: r.numeroTreno, orig: r.codOrigine, day: r.dataPartenzaTreno }; }
      if (regId) {
        reg = norm(await andamento(regId.orig, regId.num, regId.day), 'Regionale ' + regId.num, regId.num);
        if (reg.ok) reg.verified = regId.day === DAY || reg.verified;
      } else reg.error = 'Nessun treno per Teramo alle ' + REG_DEP + ' nel tabellone partenze di Giulianova (possibile bus sostitutivo o orario diverso)';
    } catch (e) { reg.error = e.message; }
  }
  const regGiu = findStop(reg, RE_GIU), regTer = findStop(reg, RE_TER) || (reg.ok ? reg.stops[reg.stops.length - 1] : null);

  const c1 = conn('Coincidenza 1', 'S. Benedetto del Tronto', fr.ok ? fr.nome : FR.label, frSbt, ic.ok ? ic.nome : IC.label, icSbt, ic);

  // Alternative S.Benedetto -> Giulianova (treni successivi all'IC 607)
  let altSbt = [];
  if (sbtId && giuId) altSbt = await memo('altSbt', 120000, async () => {
    const lists = await Promise.all([at(15, 15), at(16, 15), at(17, 15)].map(t => partenze(sbtId, t).catch(() => [])));
    const seen = new Set(), cand = [];
    const icDep = (icSbt && icSbt.depP) || at(15, 23);
    for (const t of lists.flat().sort((a, b) => a.orarioPartenza - b.orarioPartenza)) {
      if (String(t.numeroTreno) === IC.num || t.orarioPartenza <= icDep || seen.has(t.numeroTreno)) continue;
      seen.add(t.numeroTreno); cand.push(t);
    }
    const det = await Promise.all(cand.slice(0, 10).map(t => altTrain(t, RE_SBT, RE_GIU).catch(() => null)));
    return det.filter(Boolean).sort((a, b) => a.dep - b.dep).slice(0, 4);
  }).catch(() => []);

  // Arrivo effettivo a Giulianova: IC 607, oppure prima alternativa utile se la coincidenza 1 e' persa
  let giuArr = icGiu, viaAlt = null;
  // piano B anche quando la coincidenza non e' ancora persa ma il margine previsto e' nullo o negativo
  const pianoB = c1.level === 'lost' || (!c1.partito && c1.margine != null && c1.margine < 1);
  if (pianoB && c1.arr != null) {
    viaAlt = altSbt.find(a => !a.depReale && a.dep >= c1.arr + 2 * MIN) || null;
    giuArr = viaAlt ? { arrP: viaAlt.arrP, arrE: viaAlt.arr, arrR: null } : null;
    if (viaAlt) viaAlt = Object.assign({ certa: c1.level === 'lost', margineSbt: Math.round((viaAlt.dep - c1.arr) / MIN) }, viaAlt);
  }
  const c2 = conn('Coincidenza 2', 'Giulianova', viaAlt ? viaAlt.nome : (ic.ok ? ic.nome : IC.label), giuArr, reg.ok ? reg.nome : 'Regionale ' + REG_DEP, regGiu, reg);

  // Alternative Giulianova -> Teramo (treni successivi al 16:13)
  let altTer = [];
  const regDepP = (regGiu && regGiu.depP) || at(16, 13);
  const later = terList.filter(t => t.orarioPartenza > regDepP).slice(0, 4);
  if (later.length) altTer = await memo('altTer', 120000, async () =>
    (await Promise.all(later.map(t => altTrain(t, RE_GIU, RE_TER).catch(() => null)))).filter(Boolean)).catch(() => []);

  // Arrivo finale stimato
  let eta = null;
  const gA = giuArr ? (giuArr.arrR || giuArr.arrE || giuArr.arrP) : null;
  if (regTer && c2.level !== 'lost' && c2.level !== 'unknown' && c2.margine >= 0)
    eta = { t: regTer.arrR || regTer.arrE || regTer.arrP, prog: regTer.arrP, base: regTer.arrR ? 'effettivo' : regTer.arrE != null ? 'stimato' : 'programmato', via: reg.nome };
  else if (gA != null) {
    const a = altTer.find(x => !x.depReale && x.dep >= gA + 2 * MIN);
    if (a) eta = { t: a.arr, prog: a.arrP, base: 'stimato su alternativa', via: a.nome + ' delle ' + hm(a.depP) };
  }
  // se la coincidenza per Teramo non e' sicura, indico anche l'arrivo con il treno successivo
  if (eta && gA != null && !/green|done/.test(c2.level)) {
    const f = altTer.find(x => !x.depReale && x.dep >= gA + 2 * MIN);
    if (f && f.arr !== eta.t) eta.seSalta = { t: f.arr, via: f.nome + ' delle ' + hm(f.depP) };
  }
  if (pianoB && !viaAlt) errors.push('Nessun treno alternativo S.Benedetto-Giulianova trovato dopo il tuo arrivo: arrivo a Teramo non calcolabile');
  return { now: Date.now(), giorno: '13/11/2026', trains: { fr, ic, reg }, conns: [c1, c2], viaAlt, altSbt, altTer, eta, errors };
}

http.createServer(async (req, res) => {
  if (req.url.startsWith('/api/status')) {
    try {
      const d = await memo('status', 20000, status);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(d));
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify({ error: e.message }));
    }
    if (req.url.includes('force')) cache.delete('status');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(HTML);
}).listen(PORT, () => console.log('Coincidenze live su http://0.0.0.0:' + PORT));

const HTML = String.raw`<!doctype html><html lang="it"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="theme-color" content="#0a0e14"><title>Coincidenze → Teramo</title>
<style>
:root{--bg:#0a0e14;--card:#131a24;--line:#222c3a;--tx:#e8eef6;--mut:#8593a6;--green:#22c55e;--yellow:#facc15;--orange:#fb923c;--red:#ef4444;--blue:#38bdf8}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--tx);font:15px/1.35 -apple-system,BlinkMacSystemFont,"SF Pro Text",Segoe UI,Roboto,sans-serif;
padding:calc(env(safe-area-inset-top) + 10px) 12px calc(env(safe-area-inset-bottom) + 24px);-webkit-text-size-adjust:100%}
.num{font-variant-numeric:tabular-nums;font-feature-settings:"tnum"}
header{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px}
h1{font-size:15px;margin:0;font-weight:700;letter-spacing:.02em}.sub{color:var(--mut);font-size:12px}
button{background:#1c2633;color:var(--tx);border:1px solid var(--line);border-radius:12px;padding:10px 14px;font-size:14px;font-weight:600;min-height:44px}
button:active{background:#263345}button[disabled]{opacity:.5}
.banner{border-radius:12px;padding:10px 12px;margin-bottom:10px;font-weight:600;font-size:13px;background:#3b1212;border:1px solid var(--red);color:#fecaca}
.warn{background:#3a2a08;border-color:var(--yellow);color:#fde68a}
.hero{border-radius:18px;padding:16px;margin-bottom:10px;border:2px solid var(--c);background:linear-gradient(160deg,color-mix(in srgb,var(--c) 22%,var(--card)),var(--card))}
.hero .k{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--mut);font-weight:700}
.hero .row{display:flex;align-items:flex-end;justify-content:space-between;gap:10px;margin-top:6px}
.big{font-size:64px;line-height:.95;font-weight:800;color:var(--c)}.big small{font-size:20px;font-weight:700;margin-left:4px}
.bin{text-align:right}.bin .b{font-size:40px;font-weight:800;line-height:1}.bin .l{font-size:11px;color:var(--mut);text-transform:uppercase;letter-spacing:.06em}
.verdict{font-size:17px;font-weight:700;margin-top:8px;color:var(--c)}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:12px;margin-bottom:10px}
.card h2{font-size:12px;margin:0 0 8px;color:var(--mut);letter-spacing:.08em;text-transform:uppercase}
.eta{display:flex;justify-content:space-between;align-items:center}.eta .t{font-size:34px;font-weight:800}
.chip{display:inline-block;border-radius:999px;padding:2px 9px;font-size:12px;font-weight:700;background:#1f2937;color:var(--tx);white-space:nowrap}
.chip.g{background:#0f3d24;color:#86efac}.chip.y{background:#3f3306;color:#fde047}.chip.o{background:#43230a;color:#fdba74}.chip.r{background:#450f0f;color:#fca5a5}
.th{display:flex;justify-content:space-between;align-items:center;gap:8px}.tn{font-size:17px;font-weight:800}
.st{margin-top:10px;border-top:1px solid var(--line);padding-top:8px}.st b{font-size:13px}
.grid{display:grid;grid-template-columns:auto 1fr 1fr 1fr;gap:4px 8px;margin-top:4px;font-size:13px;align-items:baseline}
.grid .h{color:var(--mut);font-size:10px;text-transform:uppercase;letter-spacing:.06em}.grid .v{font-weight:700;font-size:15px}
.mut{color:var(--mut)}.c-row{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:8px 0;border-top:1px solid var(--line)}
.c-row:first-of-type{border-top:0}.dot{width:12px;height:12px;border-radius:50%;background:var(--c);display:inline-block;margin-right:6px}
.alt{display:flex;justify-content:space-between;gap:8px;padding:7px 0;border-top:1px solid var(--line);font-size:13px}.alt:first-of-type{border-top:0}
.tag{font-size:11px;font-weight:700;color:var(--yellow)}
</style></head><body>
<header><div><h1>S. Benedetto → Giulianova → Teramo</h1><div class="sub num" id="upd">Caricamento…</div></div>
<button id="rf">↻ Aggiorna</button></header>
<div id="ban"></div><div id="app"></div>
<script>
var D=null,lastOk=0,lastErr=null,nextAt=0,busy=false;
var COL={green:'var(--green)',yellow:'var(--yellow)',orange:'var(--orange)',red:'var(--red)',lost:'var(--red)',done:'var(--blue)',unknown:'#64748b'};
function T(ms){return ms==null?'—':new Date(ms).toLocaleTimeString('it-IT',{hour:'2-digit',minute:'2-digit',timeZone:'Europe/Rome'})}
function E(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
function dchip(r){if(r==null)return '<span class="chip">ritardo n.d.</span>';var c=r<=0?'g':r<5?'y':r<15?'o':'r';return '<span class="chip '+c+' num">'+(r>0?'+'+r+' min':r<0?r+' min':'in orario')+'</span>'}
function verdict(c){if(c.level=='lost')return 'COINCIDENZA PERSA';if(c.level=='done')return 'Coincidenza presa';if(c.level=='unknown')return 'Dati non disponibili';
 return {green:'Ce la fai',yellow:'Ce la fai, senza perdere tempo',orange:'A rischio: muoviti subito',red:c.margine<0?'Molto probabilmente persa':'Rischio altissimo'}[c.level]}
function binTxt(eff,prog){if(eff)return {b:eff,l:'binario effettivo'};if(prog)return {b:prog,l:'binario programmato'};return {b:'—',l:'binario non disponibile'}}
function hero(c){var b=binTxt(c.binDepEff,c.binDepProg),h='<div class="hero" style="--c:'+COL[c.level]+'"><div class="k">'+E(c.nome)+' · '+E(c.stazione)+'</div>';
 h+='<div style="font-weight:700;margin-top:2px">'+E(c.da)+' → '+E(c.verso)+'</div>';
 if(c.margine==null)return h+'<div class="verdict">'+E(c.msg)+'</div></div>';
 h+='<div class="row"><div class="big num">'+c.margine+'<small>min</small></div><div class="bin"><div class="l">'+b.l+'</div><div class="b num">'+E(b.b)+'</div></div></div>';
 h+='<div class="verdict">'+verdict(c)+'</div>';
 h+='<div class="sub num" style="margin-top:6px">Arrivi '+T(c.arr)+' ('+c.arrBase+')'+(c.binArrEff||c.binArrProg?' al bin. '+E(c.binArrEff||c.binArrProg)+(c.binArrEff?'':' progr.'):'')+' · Parte '+T(c.dep)+' ('+c.depBase+')'+(c.margineProg!=null?' · da orario: '+c.margineProg+' min':'')+'</div>';
 if(!c.partito)h+='<div class="sub num" data-cd="'+c.dep+'" style="margin-top:2px"></div>';
 if(c.msg)h+='<div class="sub" style="margin-top:4px;color:#fecaca">'+E(c.msg)+'</div>';return h+'</div>'}
function stopRow(s,mode){var h='<div class="st"><b>'+E(s.stazione)+'</b>'+(s.soppressa?' <span class="tag" style="color:var(--red)">FERMATA SOPPRESSA</span>':'')+'<div class="grid num"><span></span><span class="h">Progr.</span><span class="h">Stimato</span><span class="h">Effettivo</span>';
 function r(lbl,p,e,re,bp,be){return '<span class="h">'+lbl+'</span><span class="v">'+T(p)+'</span><span class="v" style="color:var(--yellow)">'+(re?'—':T(e))+'</span><span class="v" style="color:var(--green)">'+T(re)+'</span>'+
  '<span class="h">Bin.</span><span>'+E(bp||'n.d.')+'</span><span></span><span style="font-weight:700">'+E(be||'n.d.')+'</span>'}
 if(mode!='dep'&&s.arrP!=null)h+=r('Arr.',s.arrP,s.arrE,s.arrR,s.binArrProg,s.binArrEff);
 if(mode!='arr'&&s.depP!=null)h+=r('Part.',s.depP,s.depE,s.depR,s.binDepProg,s.binDepEff);return h+'</div></div>'}
function train(t,want){if(!t.ok)return '<div class="card"><div class="tn">'+E(t.label)+'</div><div class="banner" style="margin:8px 0 0">'+E(t.error)+'</div></div>';
 var h='<div class="card"><div class="th"><div><div class="tn">'+E(t.nome)+'</div><div class="sub">'+E(t.origine)+' → '+E(t.destinazione)+'</div></div><div style="text-align:right">'+dchip(t.ritardo)+'<div class="sub" style="margin-top:3px">'+E(t.stato)+'</div></div></div>';
 if(!t.verified)h+='<div class="banner warn" style="margin:8px 0 0">Corsa NON verificata come quella del 13/11/2026</div>';
 if(t.soppresso||t.parziale)h+='<div class="banner" style="margin:8px 0 0">'+(t.soppresso?'TRENO SOPPRESSO':'Treno parzialmente soppresso')+(t.avviso?': '+E(t.avviso):'')+'</div>';
 if(t.stale)h+='<div class="banner warn" style="margin:8px 0 0">⚠ Dato obsoleto — '+E(t.stale)+'</div>';
 h+='<div class="sub num" style="margin-top:8px">Ultimo rilevamento: '+(t.ultimaStazione?'<b style="color:var(--tx)">'+E(t.ultimaStazione)+'</b> alle '+T(t.oraUltimoRil):'non disponibile')+(t.posizione?'<br>Posizione: '+E(t.posizione):'')+(t.note?'<br>'+E(t.note):'')+'</div>';
 var n=0;want.forEach(function(w){var s=t.stops.filter(function(x){return w[0].test(x.stazione)})[0];if(s){h+=stopRow(s,w[1]);n++}});
 if(!n)h+='<div class="sub" style="margin-top:8px">Fermate d\'interesse non presenti in questa corsa.</div>';return h+'</div>'}
function alts(title,list,empty){var h='<div class="card"><h2>'+title+'</h2>';if(!list.length)return h+'<div class="sub">'+empty+'</div></div>';
 list.forEach(function(a){h+='<div class="alt num"><div><b>'+E(a.nome)+'</b> <span class="mut">→ '+E(a.destinazione)+'</span><br><span class="mut">Part. '+T(a.depP)+(a.dep!=a.depP?' → <b style="color:var(--yellow)">'+T(a.dep)+'</b>':'')+' · Arr. '+T(a.arr)+' · Bin. '+E(a.binEff||(a.binProg?a.binProg+' progr.':'n.d.'))+'</span></div><div>'+dchip(a.ritardo)+'</div></div>'});return h+'</div>'}
function render(){if(!D)return;var c1=D.conns[0],c2=D.conns[1],h='';
 var next=(c1.level=='done'||(c1.partito&&c1.level!='lost'))?c2:c1;
 h+=hero(next);
 if(D.viaAlt){var a=D.viaAlt;h+='<div class="banner warn">PIANO B '+(a.certa?'(IC 607 perso)':'(con i ritardi attuali perdi l\'IC 607)')+': a S. Benedetto prendi <b>'+E(a.nome)+'</b> delle '+T(a.dep)+', binario '+E(a.binEff||(a.binProg?a.binProg+' progr.':'n.d.'))+' · attesa '+a.margineSbt+' min · arrivo a Giulianova '+T(a.arr)+'</div>';if(next!==c2)h+=hero(c2)}
 h+='<div class="card eta"><div><h2 style="margin:0">Arrivo stimato a Teramo</h2><div class="sub">'+(D.eta?E(D.eta.via)+' · '+E(D.eta.base)+(D.eta.prog?' · progr. '+T(D.eta.prog):'')+(D.eta.seSalta?'<br><b style="color:var(--orange)">Se salta la coincidenza a Giulianova: '+T(D.eta.seSalta.t)+'</b> ('+E(D.eta.seSalta.via)+')':''):'Non calcolabile con i dati attuali')+'</div></div><div class="t num">'+(D.eta?T(D.eta.t):'—')+'</div></div>';
 h+='<div class="card"><h2>Coincidenze</h2>';D.conns.forEach(function(c){h+='<div class="c-row" style="--c:'+COL[c.level]+'"><div><span class="dot"></span><b>'+E(c.stazione)+'</b><div class="sub">'+E(c.da)+' → '+E(c.verso)+'</div><div class="sub num">'+(c.arr?'arr. '+T(c.arr)+' · part. '+T(c.dep)+' · bin. '+E(c.binDepEff||(c.binDepProg?c.binDepProg+' progr.':'n.d.')):E(c.msg))+'</div></div><div style="text-align:right"><div class="num" style="font-size:26px;font-weight:800;color:var(--c)">'+(c.margine!=null?c.margine+'′':'—')+'</div><div class="sub">'+verdict(c)+'</div></div></div>'});h+='</div>';
 D.errors.forEach(function(e){h+='<div class="banner warn">'+E(e)+'</div>'});
 var S=/BENEDETTO.*TRONTO/i,G=/GIULIANOVA/i,TE=/^TERAMO/i;
 h+=train(D.trains.fr,[[S,'arr']])+train(D.trains.ic,[[S,'both'],[G,'arr']])+train(D.trains.reg,[[G,'dep'],[TE,'arr']]);
 var bad1=/lost|red|orange/.test(c1.level),bad2=/lost|red|orange/.test(c2.level);
 h+=alts('Alternative S. Benedetto → Giulianova'+(bad1?' ⚠':''),D.altSbt,'Nessun treno successivo trovato su ViaggiaTreno.');
 h+=alts('Alternative Giulianova → Teramo'+(bad2?' ⚠':''),D.altTer,'Nessun treno successivo per Teramo trovato su ViaggiaTreno.');
 h+='<div class="sub" style="text-align:center">v2 · Fonte: ViaggiaTreno · corse del '+E(D.giorno)+' · stimato = programmato + ritardo attuale</div>';
 document.getElementById('app').innerHTML=h;tick()}
function tick(){var now=Date.now(),u=document.getElementById('upd'),b=document.getElementById('ban');
 var age=lastOk?Math.round((now-lastOk)/1000):null;
 u.textContent=(lastOk?'Aggiornato alle '+new Date(lastOk).toLocaleTimeString('it-IT',{timeZone:'Europe/Rome'}):'Nessun dato')+(busy?' · aggiorno…':' · prossimo tra '+Math.max(0,Math.round((nextAt-now)/1000))+'s');
 var m='';if(lastErr)m='<div class="banner">Aggiornamento fallito: '+E(lastErr)+(lastOk?' — dati fermi a '+Math.floor(age/60)+' min '+(age%60)+' s fa':'')+'</div>';
 else if(age!=null&&age>150)m='<div class="banner">⚠ DATI OBSOLETI: ultimo aggiornamento '+Math.floor(age/60)+' min fa</div>';b.innerHTML=m;
 [].forEach.call(document.querySelectorAll('[data-cd]'),function(e){var d=Math.round((+e.getAttribute('data-cd')-now)/60000);e.textContent=d>=0?'Il treno parte tra '+d+' min':'Orario di partenza stimato superato da '+(-d)+' min'})}
function load(force){if(busy)return;busy=true;document.getElementById('rf').disabled=true;
 fetch('api/status'+(force?'?force=1':'')+(force?'&':'?')+'t='+Date.now(),{cache:'no-store'}).then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error(j.error||('HTTP '+r.status));return j})})
 .then(function(j){D=j;lastOk=Date.now();lastErr=null}).catch(function(e){lastErr=e.message||'rete non disponibile'})
 .then(function(){busy=false;document.getElementById('rf').disabled=false;nextAt=Date.now()+60000;render();tick()})}
document.getElementById('rf').onclick=function(){load(true)};
setInterval(function(){if(Date.now()>=nextAt)load(false);else tick()},1000);
document.addEventListener('visibilitychange',function(){if(!document.hidden&&Date.now()-lastOk>30000)load(true)});
load(true);
</script></body></html>`;
