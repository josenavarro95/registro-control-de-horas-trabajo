/* Control de Horas — PWA sin servidor. Todos los datos viven en localStorage del teléfono. */
'use strict';

// ---------------------------------------------------------------- Almacenamiento
const KEY = 'controlHoras.v1';
const DEFAULT_CFG = {
  card: '',
  anyCard: false,
  dailyHours: 8,
  nightStart: '19:00',
  nightEnd: '06:00',
  sup100Start: '00:00',     // suplementarias al 100% entre esta hora y nightEnd
  breakMin: 60,
  breakAfterH: 4,
  breakMinDurH: 8.5,
  breakFrom: '04:00',
  breakTo: '13:59',
  restDays: [0, 6],         // 0=domingo ... 6=sábado
  holidays: [],             // 'YYYY-MM-DD'
  salary: '',
  hourRate: '',             // valor hora manual (si se deja vacío: sueldo / 240)
  // ---- Rol de pagos
  periodStartDay: 1,        // día en que empieza el período del rol
  mealFrom: '04:00',        // entrada entre estas horas = almuerzo; si no, cena
  mealTo: '13:59',
  bonoAlmuerzo: 5,          // ingreso "Alimentación" por turno con almuerzo
  bonoCena: 5,              // ingreso "Alimentación" por turno con cena
  comedorAlmuerzo: 1.788,   // descuento comedor (Almuerzos Valdivia) por almuerzo consumido
  comedorCena: 1.788,       // descuento comedor por cena consumida
  comedorDefault: false,    // marcar "consumí en comedor" por defecto al entrar
  iessPct: 9.45,
  anticipoPct: 30
};

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY));
    if (raw && Array.isArray(raw.shifts)) return { shifts: raw.shifts, cfg: { ...DEFAULT_CFG, ...raw.cfg }, periods: raw.periods || {} };
  } catch (e) { /* datos corruptos o almacenamiento bloqueado */ }
  return { shifts: [], cfg: { ...DEFAULT_CFG }, periods: {} };
}
let db = load();
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(db)); }
  catch (e) { toast('No se pudo guardar en el teléfono'); }
}
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

// ---------------------------------------------------------------- Utilidades
const $ = (s) => document.querySelector(s);
const pad = (n) => String(n).padStart(2, '0');
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const DAYS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
const DAYS_L = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const fmtH = (min) => { if (!min) return '0:00'; const s = min < 0 ? '-' : ''; min = Math.abs(Math.round(min)); return `${s}${Math.floor(min / 60)}:${pad(min % 60)}`; };
const fmtDec = (min) => (min / 60).toFixed(2);
const toLocalInput = (iso) => { const d = new Date(iso); return `${ymd(d)}T${hm(d)}`; };
const fromLocalInput = (v) => (v ? new Date(v).toISOString() : null);
const floorMinute = (d) => { const x = new Date(d); x.setSeconds(0, 0); return x; };
function mondayOf(d) {
  const x = new Date(d); x.setHours(0, 0, 0, 0);
  const wd = (x.getDay() + 6) % 7; x.setDate(x.getDate() - wd); return x;
}
function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), ms);
}
function feedback() {
  if (navigator.vibrate) navigator.vibrate(120);
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator(); o.frequency.value = 1200; o.connect(ctx.destination);
    o.start(); o.stop(ctx.currentTime + 0.12);
  } catch (e) {}
}
function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

// ---------------------------------------------------------------- Reglas de cálculo
function isRestDay(dateObj) {
  return db.cfg.restDays.includes(dateObj.getDay()) || db.cfg.holidays.includes(ymd(dateObj));
}
function inRange(minOfDay, fromHHMM, toHHMM) {
  const a = toMin(fromHHMM), b = toMin(toHHMM);
  return a <= b ? minOfDay >= a && minOfDay < b : minOfDay >= a || minOfDay < b;
}
function inRangeInclusive(minOfDay, fromHHMM, toHHMM) {
  const a = toMin(fromHHMM), b = toMin(toHHMM);
  return a <= b ? minOfDay >= a && minOfDay <= b : minOfDay >= a || minOfDay <= b;
}

/** Descanso (min) sugerido según la regla de Ajustes. */
function autoBreak(startISO, endISO) {
  const c = db.cfg;
  if (!c.breakMin) return 0;
  const s = new Date(startISO), e = new Date(endISO);
  const durH = (e - s) / 3600000;
  if (durH <= c.breakMinDurH) return 0;
  const sm = s.getHours() * 60 + s.getMinutes();
  return inRangeInclusive(sm, c.breakFrom, c.breakTo) ? Number(c.breakMin) : 0;
}

/**
 * Clasifica cada minuto del turno (Código del Trabajo, Ecuador):
 *  - Día de descanso / feriado (según el día de inicio): todo al 100%.
 *  - Primeras N horas (jornada): ordinarias; las que caen en horario nocturno llevan recargo 25%.
 *  - Después de N horas: suplementarias al 50%, o al 100% si caen entre 00:00 y 06:00.
 */
function classify(shift, endOverride) {
  const c = db.cfg;
  const r = { total: 0, ord: 0, n25: 0, s50: 0, x100: 0, rest: false };
  const endISO = shift.end || endOverride;
  if (!endISO) return r;
  const start = floorMinute(shift.start).getTime();
  const end = floorMinute(endISO).getTime();
  if (end <= start) return r;

  const brk = Number(shift.breakMin ?? 0);
  const brkAt = Math.round(c.breakAfterH * 60);
  const ordLimit = Math.round(c.dailyHours * 60);
  const rest = isRestDay(new Date(start));
  r.rest = rest;

  let i = 0, worked = 0;
  for (let t = start; t < end; t += 60000, i++) {
    if (brk > 0 && i >= brkAt && i < brkAt + brk) continue;
    const d = new Date(t);
    const m = d.getHours() * 60 + d.getMinutes();
    worked++;
    if (rest) { r.x100++; continue; }
    if (worked <= ordLimit) {
      r.ord++;
      if (inRange(m, c.nightStart, c.nightEnd)) r.n25++;
    } else if (inRange(m, c.sup100Start, c.nightEnd)) {
      r.x100++;
    } else {
      r.s50++;
    }
  }
  r.total = worked;
  return r;
}

function sumInto(acc, r) {
  for (const k of ['total', 'ord', 'n25', 's50', 'x100']) acc[k] += r[k];
  return acc;
}
const empty = () => ({ total: 0, ord: 0, n25: 0, s50: 0, x100: 0 });

function weekData(monday) {
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday); d.setDate(d.getDate() + i);
    days.push({ date: d, key: ymd(d), r: empty(), shifts: [] });
  }
  const from = monday.getTime(), to = from + 7 * 86400000;
  const now = new Date().toISOString();
  const shifts = db.shifts.filter((s) => { const t = new Date(s.start).getTime(); return t >= from && t < to; })
    .sort((a, b) => a.start.localeCompare(b.start));
  for (const s of shifts) {
    const day = days.find((d) => d.key === ymd(new Date(s.start)));
    const r = classify(s, s.end ? null : now);
    sumInto(day.r, r); day.shifts.push({ s, r });
  }
  const tot = days.reduce((a, d) => sumInto(a, d.r), empty());
  return { days, tot, shifts };
}

function hourRate() {
  const manual = parseFloat(db.cfg.hourRate);
  if (manual > 0) return manual;
  const sal = parseFloat(db.cfg.salary);
  return sal > 0 ? sal / 240 : 0;
}
function money(tot) {
  const vh = hourRate();
  if (!vh) return null;
  return {
    vh,
    n25: (tot.n25 / 60) * vh * 0.25,
    s50: (tot.s50 / 60) * vh * 1.5,
    x100: (tot.x100 / 60) * vh * 2
  };
}

// ---------------------------------------------------------------- Comidas
function autoMeal(startISO) {
  const d = new Date(startISO);
  return inRangeInclusive(d.getHours() * 60 + d.getMinutes(), db.cfg.mealFrom, db.cfg.mealTo) ? 'almuerzo' : 'cena';
}
const mealOf = (s) => s.meal || autoMeal(s.start);
const MEAL_LBL = { almuerzo: 'Almuerzo', cena: 'Cena', ninguna: 'Sin comida' };

// ---------------------------------------------------------------- Rol de pagos (período)
function periodOf(date) {
  const sd = Math.min(28, Math.max(1, parseInt(db.cfg.periodStartDay, 10) || 1));
  const d = new Date(date);
  let y = d.getFullYear(), m = d.getMonth();
  if (d.getDate() < sd) { m--; if (m < 0) { m = 11; y--; } }
  const from = new Date(y, m, sd, 0, 0, 0, 0);
  const to = new Date(y, m + 1, sd, 0, 0, 0, 0);
  return { from, to, key: `${y}-${pad(m + 1)}` };
}

function payroll(period) {
  const c = db.cfg;
  const now = new Date().toISOString();
  const shifts = db.shifts.filter((s) => { const t = new Date(s.start); return t >= period.from && t < period.to; })
    .sort((a, b) => a.start.localeCompare(b.start));
  const tot = shifts.reduce((a, s) => sumInto(a, classify(s, s.end ? null : now)), empty());
  const daysWorked = new Set(shifts.map((s) => ymd(new Date(s.start)))).size;
  const meals = { almuerzo: 0, cena: 0, comAlm: 0, comCena: 0 };
  for (const s of shifts) {
    const m = mealOf(s);
    if (m === 'almuerzo') { meals.almuerzo++; if (s.comedor) meals.comAlm++; }
    if (m === 'cena') { meals.cena++; if (s.comedor) meals.comCena++; }
  }
  const per = db.periods[period.key] || {};
  const paidDays = per.paidDays ?? 30;
  const sal = parseFloat(c.salary) || 0;
  const vh = hourRate();
  const r2 = (v) => Math.round(Number((v * 100).toFixed(6))) / 100;
  const h = (m) => r2(m / 60);
  const sueldo = r2((sal * paidDays) / 30);
  const vN = r2(h(tot.n25) * vh * 0.25);
  const v50 = r2(h(tot.s50) * vh * 1.5);
  const v100 = r2(h(tot.x100) * vh * 2);
  const alim = r2(meals.almuerzo * c.bonoAlmuerzo + meals.cena * c.bonoCena);
  const ingreso = r2(sueldo + vN + v50 + v100 + alim);
  const anticipo = per.anticipo ?? r2((sueldo * c.anticipoPct) / 100);
  const comedor = r2(meals.comAlm * c.comedorAlmuerzo + meals.comCena * c.comedorCena);
  const iess = r2(((sueldo + vN + v50 + v100) * c.iessPct) / 100);
  const egreso = r2(anticipo + comedor + iess);
  return { shifts, tot, daysWorked, meals, paidDays, vh, sueldo, vN, v50, v100, alim, ingreso, anticipo, comedor, iess, egreso, neto: r2(ingreso - egreso), hrs: { n25: h(tot.n25), s50: h(tot.s50), x100: h(tot.x100), total: h(tot.total) } };
}

// ---------------------------------------------------------------- Marcación
const openShift = () => db.shifts.find((s) => !s.end);

function mark(source = 'botón') {
  const now = floorMinute(new Date()).toISOString();
  const open = openShift();
  if (open) {
    if (new Date(now) <= new Date(open.start)) { toast('Espera al menos un minuto para marcar salida'); return; }
    open.end = now;
    open.breakMin = autoBreak(open.start, open.end);
    open.srcOut = source;
    save(); feedback();
    const r = classify(open);
    toast(`Salida ${hm(new Date(now))} · ${fmtH(r.total)} h trabajadas`);
  } else {
    db.shifts.push({ id: uid(), start: now, end: null, breakMin: 0, srcIn: source, note: '', meal: autoMeal(now), comedor: !!db.cfg.comedorDefault });
    save(); feedback();
    toast(`Entrada registrada ${hm(new Date(now))} · ${MEAL_LBL[autoMeal(now)].toLowerCase()}`);
  }
  renderAll();
}

function handleCode(code, mode) {
  code = String(code).trim();
  if (mode === 'link') {
    db.cfg.card = code; save(); renderSettings();
    toast('Tarjeta vinculada: ' + code); feedback();
    return;
  }
  if (db.cfg.anyCard || !db.cfg.card) {
    if (!db.cfg.card && !db.cfg.anyCard) {
      if (confirm(`No tienes tarjeta vinculada.\n¿Vincular el código ${code} y marcar ahora?`)) {
        db.cfg.card = code; save(); renderSettings();
      } else return;
    }
    mark('tarjeta'); return;
  }
  if (code === db.cfg.card) mark('tarjeta');
  else toast('Tarjeta no reconocida (' + code + ')', 3500);
}

// ---------------------------------------------------------------- Escáner de código de barras
const scanner = { stream: null, raf: 0, zx: null, mode: 'mark', busy: false };

async function openScanner(mode) {
  scanner.mode = mode; scanner.busy = false;
  $('#scanTitle').textContent = mode === 'link' ? 'Escanea para vincular' : 'Escanea tu tarjeta';
  $('#scanMsg').textContent = 'Apunta la cámara al código de barras.';
  $('#dlgScan').showModal();
  const video = $('#scanVideo');
  const constraints = { video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false };

  const onCode = (text) => {
    if (scanner.busy || !text) return;
    scanner.busy = true; closeScanner(); handleCode(text, scanner.mode);
  };

  try {
    let native = false;
    if ('BarcodeDetector' in window) {
      try {
        const fmts = await BarcodeDetector.getSupportedFormats();
        if (fmts && fmts.length) {
          const det = new BarcodeDetector({ formats: fmts });
          scanner.stream = await navigator.mediaDevices.getUserMedia(constraints);
          video.srcObject = scanner.stream; await video.play();
          native = true;
          const loop = async () => {
            if (!scanner.stream) return;
            try {
              const codes = await det.detect(video);
              if (codes.length) return onCode(codes[0].rawValue);
            } catch (e) {}
            scanner.raf = requestAnimationFrame(loop);
          };
          loop();
        }
      } catch (e) { native = false; }
    }
    if (!native) {
      if (!window.ZXing) throw new Error('Lector no disponible');
      const hints = new Map();
      hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
      scanner.zx = new ZXing.BrowserMultiFormatReader(hints);
      await scanner.zx.decodeFromConstraints(constraints, video, (res) => { if (res) onCode(res.getText()); });
    }
  } catch (err) {
    $('#scanMsg').textContent = 'No se pudo abrir la cámara. Revisa los permisos (la app debe abrirse por https).';
  }
}
function closeScanner() {
  cancelAnimationFrame(scanner.raf);
  if (scanner.zx) { try { scanner.zx.reset(); } catch (e) {} scanner.zx = null; }
  if (scanner.stream) { scanner.stream.getTracks().forEach((t) => t.stop()); scanner.stream = null; }
  const v = $('#scanVideo'); v.srcObject = null;
  if ($('#dlgScan').open) $('#dlgScan').close();
}

// ---------------------------------------------------------------- NFC (solo Chrome Android)
async function readNfc(mode) {
  try {
    const reader = new NDEFReader();
    const ctrl = new AbortController();
    await reader.scan({ signal: ctrl.signal });
    toast('Acerca la tarjeta a la parte trasera del teléfono…', 8000);
    reader.onreading = (ev) => {
      ctrl.abort();
      handleCode(ev.serialNumber || 'nfc', mode);
    };
    reader.onreadingerror = () => toast('No se pudo leer la tarjeta NFC');
    setTimeout(() => ctrl.abort(), 15000);
  } catch (e) {
    toast('NFC no disponible o sin permiso');
  }
}

// ---------------------------------------------------------------- Render: Marcar
function renderClock() {
  const now = new Date();
  $('#clock').textContent = `${hm(now)}:${pad(now.getSeconds())}`;
  const td = now.toLocaleDateString('es-EC', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  $('#today').textContent = td.charAt(0).toUpperCase() + td.slice(1);
  const open = openShift();
  if (open) {
    const ms = now - new Date(open.start);
    const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000), s = Math.floor((ms % 60000) / 1000);
    $('#statusTimer').textContent = `${pad(h)}:${pad(m)}:${pad(s)}`;
  }
}

function renderMark() {
  const open = openShift();
  const btn = $('#btnMark');
  if (open) {
    btn.textContent = 'MARCAR SALIDA'; btn.className = 'btn-mark out';
    $('#statusCard').classList.add('on');
    $('#statusLabel').textContent = 'En turno';
    const st = new Date(open.start);
    const ord = new Date(st.getTime() + db.cfg.dailyHours * 3600000);
    $('#statusSub').textContent = `Entrada: ${DAYS[st.getDay()]} ${hm(st)} · jornada ordinaria hasta ~${hm(ord)} (sin contar almuerzo)`;
  } else {
    btn.textContent = 'MARCAR ENTRADA'; btn.className = 'btn-mark in';
    $('#statusCard').classList.remove('on');
    $('#statusLabel').textContent = 'Fuera de turno';
    $('#statusTimer').textContent = '';
    const last = [...db.shifts].sort((a, b) => b.start.localeCompare(a.start))[0];
    $('#statusSub').textContent = last && last.end ? `Última salida: ${new Date(last.end).toLocaleString('es-EC', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}` : 'Presiona el botón o escanea tu tarjeta';
  }
  renderClock();

  const ref = open || [...db.shifts].sort((a, b) => b.start.localeCompare(a.start))[0];
  const mb = $('#mealBox');
  if (ref) {
    mb.hidden = false;
    $('#mealSel').value = mealOf(ref);
    $('#mealComedor').checked = !!ref.comedor;
    $('#mealFor').textContent = open ? 'Turno actual' : 'Último turno';
  } else mb.hidden = true;

  const { tot } = weekData(mondayOf(new Date()));
  $('#kpisWeekMini').innerHTML = kpisHtml(tot);

  const last = [...db.shifts].sort((a, b) => b.start.localeCompare(a.start)).slice(0, 5);
  $('#lastMarks').innerHTML = last.length ? last.map(shiftLi).join('') : '<li class="sub">Aún no hay marcaciones.</li>';
}

function kpisHtml(tot) {
  return `
    <div class="kpi"><b>${fmtH(tot.total)}</b><span>Trabajadas</span></div>
    <div class="kpi"><b>${fmtH(tot.ord)}</b><span>Ordinarias</span></div>
    <div class="kpi c25"><b>${fmtH(tot.n25)}</b><span>Nocturnas 25%</span></div>
    <div class="kpi c50"><b>${fmtH(tot.s50)}</b><span>Supl. 50%</span></div>
    <div class="kpi c100"><b>${fmtH(tot.x100)}</b><span>Extra 100%</span></div>`;
}

function shiftLi(s) {
  const st = new Date(s.start), en = s.end ? new Date(s.end) : null;
  const r = classify(s, s.end ? null : new Date().toISOString());
  const nextDay = en && ymd(en) !== ymd(st) ? ' (+1)' : '';
  const parts = [];
  if (r.n25) parts.push(`25%: ${fmtH(r.n25)}`);
  if (r.s50) parts.push(`50%: ${fmtH(r.s50)}`);
  if (r.x100) parts.push(`100%: ${fmtH(r.x100)}`);
  return `<li class="clickable" data-id="${s.id}">
    <div><div>${DAYS[st.getDay()]} ${st.getDate()}/${st.getMonth() + 1} · ${hm(st)} → ${en ? hm(en) + nextDay : '<b>en curso</b>'}</div>
    <div class="sub">${mealOf(s) !== 'ninguna' ? (s.comedor ? '🍽 ' : '') + MEAL_LBL[mealOf(s)] + ' · ' : ''}${parts.join(' · ') || 'Solo ordinarias'}${s.breakMin ? ` · −${s.breakMin} min descanso` : ''}${s.note ? ' · ' + escapeHtml(s.note) : ''}</div></div>
    <span class="tag">${fmtH(r.total)} h</span></li>`;
}
function escapeHtml(t) { return String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// ---------------------------------------------------------------- Render: Semana
let viewMonday = mondayOf(new Date());

function renderWeek() {
  const { days, tot, shifts } = weekData(viewMonday);
  const sun = new Date(viewMonday); sun.setDate(sun.getDate() + 6);
  const f = (d) => d.toLocaleDateString('es-EC', { day: 'numeric', month: 'short' });
  $('#weekLabel').textContent = `${f(viewMonday)} – ${f(sun)} ${sun.getFullYear()}`;
  $('#kpisWeek').innerHTML = kpisHtml(tot);

  const cell = (v) => `<td class="${v ? '' : 'z'}">${fmtH(v)}</td>`;
  $('#weekTable tbody').innerHTML = days.map((d) => {
    const rest = isRestDay(d.date);
    return `<tr><td class="${rest ? 'rest' : ''}">${DAYS[d.date.getDay()]} ${d.date.getDate()}${rest ? ' •' : ''}</td>
      ${cell(d.r.total)}${cell(d.r.ord)}${cell(d.r.n25)}${cell(d.r.s50)}${cell(d.r.x100)}</tr>`;
  }).join('');
  $('#weekTable tfoot').innerHTML = `<tr><td>Total</td><td>${fmtH(tot.total)}</td><td>${fmtH(tot.ord)}</td><td>${fmtH(tot.n25)}</td><td>${fmtH(tot.s50)}</td><td>${fmtH(tot.x100)}</td></tr>`;

  const m = money(tot);
  $('#moneyHint').innerHTML = (m
    ? `Estimado con valor hora $${m.vh.toFixed(2)}: recargo nocturno <b>$${m.n25.toFixed(2)}</b> · suplementarias 50% <b>$${m.s50.toFixed(2)}</b> · extraordinarias 100% <b>$${m.x100.toFixed(2)}</b> · total adicional <b>$${(m.n25 + m.s50 + m.x100).toFixed(2)}</b>.<br>`
    : '') + '• = día de descanso o feriado. Cada turno se cuenta en el día en que empieza. Horas en formato h:mm.';

  $('#weekShifts').innerHTML = shifts.length ? [...shifts].reverse().map(shiftLi).join('') : '<li class="sub">Sin turnos esta semana.</li>';
}

// ---------------------------------------------------------------- Render: Rol
let viewPeriod = periodOf(new Date());
const usd = (v) => v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function renderRol() {
  const p = viewPeriod;
  const r = payroll(p);
  const last = new Date(p.to); last.setDate(last.getDate() - 1);
  const f = (d) => d.toLocaleDateString('es-EC', { day: 'numeric', month: 'short', year: 'numeric' });
  $('#rolLabel').textContent = `${f(p.from)} – ${f(last)}`;
  const per = db.periods[p.key] || {};
  $('#rolPaidDays').value = r.paidDays;
  $('#rolAnticipo').value = per.anticipo ?? '';
  $('#rolAnticipo').placeholder = `Auto ${usd(r.anticipo)} (${db.cfg.anticipoPct}%)`;
  const row = (l, v) => `<tr><td>${l}</td><td>${v}</td></tr>`;
  const warn = !r.vh ? '<p class="hint" style="color:var(--out)">Ingresa tu sueldo o valor hora en Ajustes para calcular valores.</p>' : '';
  $('#rolBody').innerHTML = warn + `
    <table class="rol"><thead><tr><th colspan="2">Informativo</th></tr></thead><tbody>
      ${row('Días laborados (con marcación)', r.daysWorked.toFixed(2))}
      ${row('Horas suplementarias 50%', r.hrs.s50.toFixed(2))}
      ${row('Horas extraordinarias 100%', r.hrs.x100.toFixed(2))}
      ${row('Horas recargo nocturno', r.hrs.n25.toFixed(2))}
      ${row('Turnos con almuerzo / cena', `${r.meals.almuerzo} / ${r.meals.cena}`)}
      ${row('Comidas en comedor (alm. / cena)', `${r.meals.comAlm} / ${r.meals.comCena}`)}
      ${row('Valor hora', usd(r.vh))}
    </tbody></table>
    <table class="rol"><thead><tr><th colspan="2">Ingreso</th></tr></thead><tbody>
      ${row(`Sueldo ganado (${r.paidDays}/30 días)`, usd(r.sueldo))}
      ${row('Valor recargo nocturno 25%', usd(r.vN))}
      ${row('Valor horas suplementarias 50%', usd(r.v50))}
      ${row('Valor horas extraordinarias 100%', usd(r.v100))}
      ${row('Alimentación', usd(r.alim))}
    </tbody><tfoot><tr class="ing"><td>Total ingreso</td><td>${usd(r.ingreso)}</td></tr></tfoot></table>
    <table class="rol"><thead><tr><th colspan="2">Egreso</th></tr></thead><tbody>
      ${row('Anticipo quincena', usd(r.anticipo))}
      ${row('Comedor (almuerzos / cenas)', usd(r.comedor))}
      ${row(`Aporte personal IESS ${db.cfg.iessPct}%`, usd(r.iess))}
    </tbody><tfoot><tr class="egr"><td>Total egreso</td><td>${usd(r.egreso)}</td></tr></tfoot></table>
    <table class="rol"><tfoot><tr class="net"><td>TOTAL A RECIBIR (estimado)</td><td>${usd(r.neto)}</td></tr></tfoot></table>`;
}
function bindRol() {
  const shift = (n) => { const d = new Date(viewPeriod.from); d.setMonth(d.getMonth() + n); viewPeriod = periodOf(d); renderRol(); };
  $('#prevPeriod').addEventListener('click', () => shift(-1));
  $('#nextPeriod').addEventListener('click', () => shift(1));
  $('#thisPeriod').addEventListener('click', () => { viewPeriod = periodOf(new Date()); renderRol(); });
  const setPer = (k, v) => {
    const per = db.periods[viewPeriod.key] || (db.periods[viewPeriod.key] = {});
    if (v === '' || isNaN(v)) delete per[k]; else per[k] = v;
    save(); renderRol();
  };
  $('#rolPaidDays').addEventListener('change', (e) => setPer('paidDays', e.target.value === '' ? '' : Math.min(30, Math.max(0, parseFloat(e.target.value)))));
  $('#rolAnticipo').addEventListener('change', (e) => setPer('anticipo', e.target.value === '' ? '' : parseFloat(e.target.value)));
}

// ---------------------------------------------------------------- Render: Ajustes
function renderSettings() {
  const c = db.cfg;
  $('#cfgCard').value = c.card;
  $('#cfgAnyCard').checked = c.anyCard;
  $('#cfgDaily').value = c.dailyHours;
  $('#cfgNightStart').value = c.nightStart;
  $('#cfgNightEnd').value = c.nightEnd;
  $('#cfgSup100Start').value = c.sup100Start;
  $('#cfgBreak').value = c.breakMin;
  $('#cfgBreakAfter').value = c.breakAfterH;
  $('#cfgBreakMinDur').value = c.breakMinDurH;
  $('#cfgBreakFrom').value = c.breakFrom;
  $('#cfgBreakTo').value = c.breakTo;
  $('#cfgSalary').value = c.salary;
  $('#cfgHourRate').value = c.hourRate;
  $('#cfgHourRate').placeholder = c.salary ? `Auto: ${(parseFloat(c.salary) / 240).toFixed(4)}` : 'Auto (sueldo ÷ 240)';
  for (const k of ['periodStartDay', 'bonoAlmuerzo', 'bonoCena', 'comedorAlmuerzo', 'comedorCena', 'iessPct', 'anticipoPct', 'mealFrom', 'mealTo']) $('#cfg_' + k).value = c[k];
  $('#cfg_comedorDefault').checked = !!c.comedorDefault;
  const order = [1, 2, 3, 4, 5, 6, 0];
  $('#cfgRestDays').innerHTML = order.map((d) => `<label><input type="checkbox" value="${d}" ${c.restDays.includes(d) ? 'checked' : ''}><span>${DAYS[d]}</span></label>`).join('');
  const hol = [...c.holidays].sort();
  $('#holidayList').innerHTML = hol.length
    ? hol.map((h) => { const d = new Date(h + 'T12:00'); return `<li><span>${DAYS_L[d.getDay()]} ${d.toLocaleDateString('es-EC', { day: 'numeric', month: 'long', year: 'numeric' })}</span><button class="btn danger-outline" data-hol="${h}">Quitar</button></li>`; }).join('')
    : '<li class="sub">Sin feriados registrados.</li>';
  $('#storageInfo').textContent = `Todo se guarda solo en este teléfono (${db.shifts.length} turnos registrados). Si borras los datos del navegador o desinstalas la app, se pierden: haz un respaldo de vez en cuando.`;
}

function bindSettings() {
  const num = (id, key) => $(id).addEventListener('change', (e) => { const v = parseFloat(e.target.value); if (!isNaN(v)) { db.cfg[key] = v; save(); renderAll(); } });
  const txt = (id, key) => $(id).addEventListener('change', (e) => { if (e.target.value) { db.cfg[key] = e.target.value; save(); renderAll(); } });
  num('#cfgDaily', 'dailyHours'); num('#cfgBreak', 'breakMin'); num('#cfgBreakAfter', 'breakAfterH'); num('#cfgBreakMinDur', 'breakMinDurH');
  txt('#cfgNightStart', 'nightStart'); txt('#cfgNightEnd', 'nightEnd'); txt('#cfgSup100Start', 'sup100Start');
  txt('#cfgBreakFrom', 'breakFrom'); txt('#cfgBreakTo', 'breakTo');
  $('#cfgSalary').addEventListener('change', (e) => { db.cfg.salary = e.target.value; save(); renderAll(); });
  $('#cfgHourRate').addEventListener('change', (e) => { db.cfg.hourRate = e.target.value; save(); renderAll(); });
  for (const k of ['periodStartDay', 'bonoAlmuerzo', 'bonoCena', 'comedorAlmuerzo', 'comedorCena', 'iessPct', 'anticipoPct']) num('#cfg_' + k, k);
  txt('#cfg_mealFrom', 'mealFrom'); txt('#cfg_mealTo', 'mealTo');
  $('#cfg_comedorDefault').addEventListener('change', (e) => { db.cfg.comedorDefault = e.target.checked; save(); });
  const curRef = () => openShift() || [...db.shifts].sort((a, b) => b.start.localeCompare(a.start))[0];
  $('#mealSel').addEventListener('change', (e) => { const s = curRef(); if (s) { s.meal = e.target.value; save(); renderAll(); } });
  $('#mealComedor').addEventListener('change', (e) => { const s = curRef(); if (s) { s.comedor = e.target.checked; save(); renderAll(); } });
  $('#cfgCard').addEventListener('change', (e) => { db.cfg.card = e.target.value.trim(); save(); });
  $('#cfgAnyCard').addEventListener('change', (e) => { db.cfg.anyCard = e.target.checked; save(); });
  $('#cfgRestDays').addEventListener('change', () => {
    db.cfg.restDays = [...document.querySelectorAll('#cfgRestDays input:checked')].map((i) => Number(i.value));
    save(); renderAll();
  });
  $('#btnAddHoliday').addEventListener('click', () => {
    const v = $('#holidayInput').value; if (!v) return;
    if (!db.cfg.holidays.includes(v)) db.cfg.holidays.push(v);
    $('#holidayInput').value = ''; save(); renderAll();
  });
  $('#holidayList').addEventListener('click', (e) => {
    const h = e.target.dataset.hol; if (!h) return;
    db.cfg.holidays = db.cfg.holidays.filter((x) => x !== h); save(); renderAll();
  });
}

// ---------------------------------------------------------------- Editar / agregar turno
let editingId = null;
function openEdit(id) {
  editingId = id;
  const s = id ? db.shifts.find((x) => x.id === id) : null;
  $('#editTitle').textContent = s ? 'Editar turno' : 'Agregar turno manual';
  $('#edDelete').hidden = !s;
  if (s) {
    $('#edStart').value = toLocalInput(s.start);
    $('#edEnd').value = s.end ? toLocalInput(s.end) : '';
    $('#edBreak').value = s.breakMin || 0;
    $('#edNote').value = s.note || '';
    $('#edMeal').value = mealOf(s);
    $('#edComedor').checked = !!s.comedor;
  } else {
    const base = new Date(viewMonday); base.setHours(8, 0, 0, 0);
    const end = new Date(base); end.setHours(17);
    $('#edStart').value = toLocalInput(base.toISOString());
    $('#edEnd').value = toLocalInput(end.toISOString());
    $('#edBreak').value = '';
    $('#edNote').value = '';
    $('#edMeal').value = 'auto';
    $('#edComedor').checked = !!db.cfg.comedorDefault;
  }
  $('#dlgEdit').showModal();
}
function bindEdit() {
  document.body.addEventListener('click', (e) => {
    const li = e.target.closest('li.clickable'); if (li) openEdit(li.dataset.id);
  });
  $('#edCancel').addEventListener('click', () => $('#dlgEdit').close());
  $('#edDelete').addEventListener('click', () => {
    if (!confirm('¿Eliminar este turno?')) return;
    db.shifts = db.shifts.filter((x) => x.id !== editingId); save(); $('#dlgEdit').close(); renderAll(); toast('Turno eliminado');
  });
  $('#formEdit').addEventListener('submit', (e) => {
    e.preventDefault();
    const start = fromLocalInput($('#edStart').value);
    const end = fromLocalInput($('#edEnd').value);
    if (!start) return;
    if (end && new Date(end) <= new Date(start)) { toast('La salida debe ser posterior a la entrada'); return; }
    if (!end && db.shifts.some((x) => !x.end && x.id !== editingId)) { toast('Ya hay un turno abierto; indica la hora de salida'); return; }
    const brkRaw = $('#edBreak').value;
    const breakMin = brkRaw === '' ? (end ? autoBreak(start, end) : 0) : Math.max(0, parseInt(brkRaw, 10) || 0);
    const note = $('#edNote').value.trim();
    const meal = $('#edMeal').value === 'auto' ? autoMeal(start) : $('#edMeal').value;
    const comedor = $('#edComedor').checked;
    if (editingId) Object.assign(db.shifts.find((x) => x.id === editingId), { start, end, breakMin, note, meal, comedor });
    else db.shifts.push({ id: uid(), start, end, breakMin, srcIn: 'manual', note, meal, comedor });
    save(); $('#dlgEdit').close(); renderAll(); toast('Turno guardado');
  });
}

// ---------------------------------------------------------------- Exportar / respaldo / borrar
function csv(shifts) {
  const head = ['Fecha', 'Día', 'Entrada', 'Salida', 'Descanso (min)', 'Trabajadas (h)', 'Ordinarias (h)', 'Nocturnas 25% (h)', 'Suplementarias 50% (h)', 'Extraordinarias 100% (h)', 'Día descanso/feriado', 'Comida', 'Comedor', 'Nota'];
  const rows = [...shifts].sort((a, b) => a.start.localeCompare(b.start)).map((s) => {
    const st = new Date(s.start), en = s.end ? new Date(s.end) : null, r = classify(s);
    return [ymd(st), DAYS_L[st.getDay()], `${ymd(st)} ${hm(st)}`, en ? `${ymd(en)} ${hm(en)}` : 'abierto', s.breakMin || 0,
      fmtDec(r.total), fmtDec(r.ord), fmtDec(r.n25), fmtDec(r.s50), fmtDec(r.x100), r.rest ? 'sí' : 'no', MEAL_LBL[mealOf(s)], s.comedor ? 'sí' : 'no', s.note || ''];
  });
  return '﻿' + [head, ...rows].map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(';')).join('\r\n');
}
function bindData() {
  $('#btnCsvWeek').addEventListener('click', () => {
    const { shifts } = weekData(viewMonday);
    if (!shifts.length) return toast('No hay turnos en esta semana');
    download(`horas_semana_${ymd(viewMonday)}.csv`, csv(shifts), 'text/csv');
  });
  $('#btnCsvAll').addEventListener('click', () => {
    if (!db.shifts.length) return toast('No hay datos');
    download(`horas_todo_${ymd(new Date())}.csv`, csv(db.shifts), 'text/csv');
  });
  $('#btnBackup').addEventListener('click', () => download(`respaldo_horas_${ymd(new Date())}.json`, JSON.stringify(db, null, 2), 'application/json'));
  $('#btnRestore').addEventListener('click', () => $('#fileRestore').click());
  $('#fileRestore').addEventListener('change', async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (!Array.isArray(data.shifts)) throw 0;
      if (!confirm(`Se reemplazarán tus datos actuales por ${data.shifts.length} turnos del respaldo. ¿Continuar?`)) return;
      db = { shifts: data.shifts, cfg: { ...DEFAULT_CFG, ...data.cfg }, periods: data.periods || {} }; save(); renderAll(); toast('Respaldo restaurado');
    } catch (err) { toast('Archivo de respaldo no válido'); }
    e.target.value = '';
  });
  $('#btnDelWeek').addEventListener('click', () => {
    const { shifts } = weekData(viewMonday);
    if (!shifts.length) return toast('No hay turnos en esta semana');
    if (!confirm(`¿Borrar los ${shifts.length} turnos de esta semana?`)) return;
    const ids = new Set(shifts.map((s) => s.id));
    db.shifts = db.shifts.filter((s) => !ids.has(s.id)); save(); renderAll(); toast('Semana borrada');
  });
  $('#btnWipe').addEventListener('click', () => {
    if (!confirm('¿Borrar TODOS los turnos y ajustes de este teléfono? Esta acción no se puede deshacer.')) return;
    db = { shifts: [], cfg: { ...DEFAULT_CFG }, periods: {} }; save(); renderAll(); toast('Datos borrados');
  });
}

// ---------------------------------------------------------------- Navegación e instalación
function bindNav() {
  document.querySelectorAll('.tabbar button').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('.tabbar button').forEach((x) => x.classList.toggle('active', x === b));
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + b.dataset.tab));
    window.scrollTo(0, 0);
    renderAll();
  }));
  $('#prevWeek').addEventListener('click', () => { viewMonday.setDate(viewMonday.getDate() - 7); renderWeek(); });
  $('#nextWeek').addEventListener('click', () => { viewMonday.setDate(viewMonday.getDate() + 7); renderWeek(); });
  $('#thisWeek').addEventListener('click', () => { viewMonday = mondayOf(new Date()); renderWeek(); });
  $('#btnAddManual').addEventListener('click', () => openEdit(null));
  $('#btnMark').addEventListener('click', () => mark('botón'));
  $('#btnScan').addEventListener('click', () => openScanner('mark'));
  $('#btnLinkCard').addEventListener('click', () => openScanner('link'));
  $('#scanClose').addEventListener('click', closeScanner);
  $('#dlgScan').addEventListener('cancel', closeScanner);
  if ('NDEFReader' in window) {
    $('#btnNfc').hidden = false; $('#btnLinkNfc').hidden = false;
    $('#btnNfc').addEventListener('click', () => readNfc('mark'));
    $('#btnLinkNfc').addEventListener('click', () => readNfc('link'));
  }

  let deferred = null;
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; $('#btnInstall').hidden = false; });
  $('#btnInstall').addEventListener('click', async () => {
    if (!deferred) return; deferred.prompt(); await deferred.userChoice; deferred = null; $('#btnInstall').hidden = true;
  });
}

function renderAll() { renderMark(); renderWeek(); renderRol(); renderSettings(); }

// ---------------------------------------------------------------- Inicio
bindNav(); bindSettings(); bindEdit(); bindData(); bindRol();
renderAll();
setInterval(renderClock, 1000);
setInterval(renderMark, 60000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) renderAll(); });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

// Exponer para pruebas
window.__ch = { classify, weekData, autoBreak, payroll, periodOf, get db() { return db; } };
