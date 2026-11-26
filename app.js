"use strict";

/* =====================================================================
   Panel de administración · 24 Días de Nosotros
   - Login con Supabase Auth (solo tú)
   - Todo pasa por funciones admin_* protegidas en el servidor
   ===================================================================== */

const { SUPABASE_URL, SUPABASE_ANON_KEY, BUCKET } = window.ADVIENTO;
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
));
const pad = (n) => String(n).padStart(2, "0");

const CAT = {
  CARTA:      { emoji: "💌", label: "Carta" },
  PLAYLIST:   { emoji: "🎧", label: "Playlist" },
  CUPON:      { emoji: "🎟️", label: "Cupón especial" },
  RETO:       { emoji: "🎯", label: "Misión" },
  RECUERDO:   { emoji: "📸", label: "Recuerdo" },
  GRAN_FINAL: { emoji: "⭐", label: "Gran final" },
};
const REACT = { LOVE: "❤️", LAUGH: "😂", TEARS: "🥹", WOW: "😍", FIRE: "🔥" };
const MEDIA_ICON = { IMAGE: "📷", AUDIO: "🎵", VIDEO: "🎬" };
const MIME_BY_EXT = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp",
  mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac", ogg: "audio/ogg", wav: "audio/wav",
  mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm",
};
const TYPE_BY_EXT = {
  jpg: "IMAGE", jpeg: "IMAGE", png: "IMAGE", webp: "IMAGE",
  mp3: "AUDIO", m4a: "AUDIO", aac: "AUDIO", ogg: "AUDIO", wav: "AUDIO",
  mp4: "VIDEO", mov: "VIDEO", webm: "VIDEO",
};
const MAX_BYTES = 50 * 1024 * 1024;
const LINT_RE = /te quiero|\bquerer/gi;

const state = {
  signedIn: false, days: [], log: [], settings: { include_text: false, has_topic: false },
  config: null, files: [], filesOk: false, filter: "all", tab: "days", timer: null,
};
let editing = null;
let dirty = false;

/* ---------- utilidades ---------- */
let toastTimer;
function toast(msg, kind = "") {
  const t = $("#toast");
  t.textContent = msg;
  t.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = "toast"), kind === "error" ? 4500 : 2400);
}

async function rpc(name, args) {
  const { data, error } = await sb.rpc(name, args);
  if (error) throw new Error(error.message || "Error de conexión");
  return data;
}

const fmt = (iso) => iso
  ? new Date(iso).toLocaleString("es-PE", {
      timeZone: "America/Lima", day: "numeric", month: "short", hour: "numeric", minute: "2-digit",
    })
  : "";
const dayLabel = (iso) => new Date(iso).toLocaleDateString("es-PE", {
  timeZone: "America/Lima", weekday: "long", day: "numeric", month: "long",
});
const publicUrl = (path, bust) => {
  const u = sb.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
  return bust ? `${u}?t=${bust}` : u;
};
const lintHits = (...texts) => {
  const hits = new Set();
  texts.forEach((t) => (String(t || "").match(LINT_RE) || []).forEach((m) => hits.add(m.toLowerCase())));
  return [...hits];
};

function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch { /* sin almacenamiento */ } }

/* ---------- sesión ---------- */
async function boot() {
  const { data } = await sb.auth.getSession();
  if (data.session) await enter(data.session.user);
  else showLogin();
  sb.auth.onAuthStateChange((event) => {
    if (event === "SIGNED_OUT" && state.signedIn) showLogin();
  });
}

function showLogin(msg = "") {
  state.signedIn = false;
  clearInterval(state.timer);
  $("#app").hidden = true;
  $("#login").hidden = false;
  $("#loginMsg").textContent = msg;
  $("#loginPass").value = "";
}

async function enter(user) {
  try {
    const ok = await rpc("is_admin");
    if (!ok) {
      await sb.auth.signOut();
      showLogin("Esta cuenta no tiene permiso de administrador.");
      return;
    }
    state.signedIn = true;
    $("#userEmail").textContent = user.email || "";
    $("#login").hidden = true;
    $("#app").hidden = false;
    await loadAll();
    clearInterval(state.timer);
    state.timer = setInterval(() => { if (!document.hidden && !$("#editor").open) refreshLive(); }, 45000);
  } catch (e) {
    showLogin("No se pudo conectar: " + e.message);
  }
}

$("#loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("#loginBtn");
  btn.disabled = true;
  btn.textContent = "Entrando…";
  $("#loginMsg").textContent = "";
  const { data, error } = await sb.auth.signInWithPassword({
    email: $("#loginEmail").value.trim(),
    password: $("#loginPass").value,
  });
  btn.disabled = false;
  btn.textContent = "Entrar";
  if (error) {
    $("#loginMsg").textContent = "Correo o contraseña incorrectos.";
    return;
  }
  await enter(data.user);
});

$("#logoutBtn").addEventListener("click", async () => { await sb.auth.signOut(); });

/* ---------- carga de datos ---------- */
async function listFiles() {
  const { data, error } = await sb.storage.from(BUCKET).list("", {
    limit: 1000, sortBy: { column: "name", order: "asc" },
  });
  state.filesOk = !error;
  return error ? [] : data.filter((f) => f.name && f.id);
}

async function fetchConfig() {
  const { data, error } = await sb.from("app_config").select("*").eq("id", 1).single();
  if (error) throw new Error(error.message);
  return data;
}

async function loadAll() {
  const [days, log, settings, config, files] = await Promise.all([
    rpc("admin_get_days"), rpc("admin_get_log", { lim: 300 }), rpc("admin_get_settings"),
    fetchConfig(), listFiles(),
  ]);
  Object.assign(state, { days, log, settings, config, files });
  renderAll();
}

async function refreshLive() {
  try {
    const [days, log] = await Promise.all([rpc("admin_get_days"), rpc("admin_get_log", { lim: 300 })]);
    Object.assign(state, { days, log });
    renderAll();
  } catch { /* sin conexión: se reintenta */ }
}

function renderAll() {
  renderDays();
  renderActivity();
  renderDelivery();
  renderSettings();
  renderBadges();
}

/* ---------- pestañas ---------- */
$("#tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-tab]");
  if (b) goTab(b.dataset.tab);
});

function goTab(name) {
  state.tab = name;
  $$("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  $$(".tab").forEach((s) => (s.hidden = s.id !== `tab-${name}`));
  if (name === "activity") {
    if (state.log.length) lsSet("lastSeenLog", String(Math.max(...state.log.map((l) => l.id))));
    renderBadges();
  }
  window.scrollTo({ top: 0 });
}

function renderBadges() {
  const seen = Number(lsGet("lastSeenLog") || 0);
  const fresh = state.log.filter((l) => l.id > seen).length;
  const a = $("#badgeActivity");
  a.hidden = state.tab === "activity" || fresh === 0;
  a.textContent = fresh;
  const bad = buildChecks().filter((c) => c.status === "bad").length;
  const d = $("#badgeDelivery");
  d.hidden = bad === 0;
  d.textContent = bad;
}

/* ---------- pestaña: días ---------- */
function dayCard(d) {
  const c = CAT[d.category] || { emoji: "•", label: d.category };
  const tags = [];
  if (d.is_opened) tags.push(`<span class="tag ok">✓ abierto</span>`);
  if (d.is_redeemed) tags.push(`<span class="tag ok">🎟️ canjeado</span>`);
  if (d.partner_reply) tags.push(`<span class="tag pink">💬 nota</span>`);
  if (d.reaction) tags.push(`<span class="tag">${REACT[d.reaction] || ""}</span>`);
  if (d.media_path) tags.push(`<span class="tag">${MEDIA_ICON[d.media_type] || "📎"}</span>`);
  else if (d.category === "RECUERDO") tags.push(`<span class="tag bad">sin archivo</span>`);
  if (d.category === "PLAYLIST" && !d.external_link) tags.push(`<span class="tag bad">sin enlace</span>`);
  return `<button class="day ${d.category === "GRAN_FINAL" ? "final" : ""}" data-n="${d.day_number}">
    <span class="n">${d.day_number}</span>
    <span class="ttl">${esc(d.title)}</span>
    <span class="cat">${c.emoji} ${esc(c.label)}</span>
    <span class="tags">${tags.join("")}</span>
  </button>`;
}

function renderDays() {
  const d = state.days;
  $("#tab-days").innerHTML = `
    <div class="section-title"><h2>Los 24 días</h2>
      <button class="btn small" id="reloadAll">↻ Actualizar</button></div>
    <div class="stats">
      <span class="stat">🚪 ${d.filter((x) => x.is_opened).length}/24 abiertos</span>
      <span class="stat">🎟️ ${d.filter((x) => x.is_redeemed).length} cupones canjeados</span>
      <span class="stat">💬 ${d.filter((x) => x.partner_reply).length} notas</span>
    </div>
    <div class="grid">${d.map(dayCard).join("")}</div>`;
}

$("#tab-days").addEventListener("click", async (e) => {
  if (e.target.closest("#reloadAll")) {
    try { await loadAll(); toast("Actualizado ✓"); } catch (err) { toast(err.message, "error"); }
    return;
  }
  const card = e.target.closest(".day");
  if (card) openEditor(Number(card.dataset.n));
});

/* ---------- pestaña: actividad ---------- */
function logItem(l) {
  const day = state.days.find((x) => x.day_number === l.day_number);
  const dayTitle = day ? ` · ${esc(day.title)}` : "";
  const time = `<div class="time">${esc(fmt(l.created_at))}${dayTitle}</div>`;
  let ico = "•", title = "", extra = "";
  if (l.kind === "OPENED") { ico = "🚪"; title = `Abrió el día ${l.day_number}`; }
  else if (l.kind === "REDEEMED") {
    ico = "🎟️"; title = `Canjeó el cupón del día ${l.day_number}`;
    if (l.detail) extra = `<div>${esc(l.detail)}</div>`;
  } else if (l.kind === "REACTION") {
    ico = REACT[l.detail] || "❤️"; title = `Reaccionó en el día ${l.day_number}`;
  } else if (l.kind === "REPLY") {
    const text = l.detail || "";
    if (text.startsWith("✅ Misión cumplida")) {
      ico = "🎯"; title = `Misión cumplida · día ${l.day_number}`;
      const note = text.replace("✅ Misión cumplida", "").replace(/^ · /, "").trim();
      if (note) extra = `<p class="quote">${esc(note)}</p>`;
    } else {
      ico = "💬"; title = `Nota en el día ${l.day_number}`;
      extra = `<p class="quote">${esc(text)}</p>`;
    }
  }
  return `<div class="log-item"><div class="log-ico">${ico}</div>
    <div class="log-main"><div class="t">${title}</div>${extra}${time}</div></div>`;
}

function renderActivity() {
  const filters = [["all", "Todo"], ["REPLY", "Notas"], ["OPENED", "Aperturas"], ["REDEEMED", "Cupones"], ["REACTION", "Reacciones"]];
  const rows = state.log.filter((l) => state.filter === "all" || l.kind === state.filter);
  let html = `<div class="section-title"><h2>Lo que ella hace</h2>
    <button class="btn small" id="reloadLog">↻ Actualizar</button></div>
    <div class="chips" style="margin-bottom:6px">${filters.map(([k, t]) =>
      `<button class="chip ${state.filter === k ? "active" : ""}" data-f="${k}">${t}</button>`).join("")}</div>`;
  if (!rows.length) {
    html += `<div class="empty">Todavía no hay actividad. Cuando ella abra un día, canjee un cupón o te deje una nota, aparecerá aquí. 💌</div>`;
  } else {
    let last = "";
    rows.forEach((l) => {
      const dl = dayLabel(l.created_at);
      if (dl !== last) { html += `<div class="date-head">${esc(dl)}</div>`; last = dl; }
      html += logItem(l);
    });
  }
  $("#tab-activity").innerHTML = html;
}

$("#tab-activity").addEventListener("click", async (e) => {
  const chip = e.target.closest(".chip");
  if (chip) { state.filter = chip.dataset.f; renderActivity(); return; }
  if (e.target.closest("#reloadLog")) { await refreshLive(); toast("Actualizado ✓"); }
});

/* ---------- pestaña: entrega (checklist) ---------- */
function buildChecks() {
  if (!state.config) return [];
  const d = state.days;
  const files = new Set(state.files.map((f) => f.name));
  const list = [];
  const add = (status, title, days = [], go = null) => list.push({ status, title, days, go });

  const force = state.config.force_unlock_all;
  add(force ? "bad" : "ok", force ? "El modo prueba está ENCENDIDO (todos los días abiertos)" : "Modo prueba apagado", [], force ? "settings" : null);

  const touched = d.filter((x) => x.is_opened || x.is_redeemed || x.partner_reply || x.reaction);
  add(touched.length ? "bad" : "ok",
    touched.length ? "Quedan datos de pruebas (aperturas, notas o canjes). Reinicia el progreso" : "Progreso en cero",
    touched.map((x) => x.day_number), touched.length ? "settings" : null);

  const empty = d.filter((x) => !String(x.message_body || "").trim());
  add(empty.length ? "bad" : "ok", empty.length ? "Días sin texto de carta" : "Todos los días tienen su carta", empty.map((x) => x.day_number));

  const noMedia = d.filter((x) => x.category === "RECUERDO" && (x.media_type === "NONE" || !x.media_path));
  add(noMedia.length ? "bad" : "ok", noMedia.length ? "Recuerdos sin foto, audio o video" : "Todos los recuerdos tienen su archivo", noMedia.map((x) => x.day_number));

  if (state.filesOk) {
    const missing = d.filter((x) => x.media_path && !files.has(x.media_path));
    add(missing.length ? "bad" : "ok", missing.length ? "Días que apuntan a un archivo que no existe" : "Todos los archivos existen en el almacenamiento", missing.map((x) => x.day_number));
  }

  const noLink = d.filter((x) => x.category === "PLAYLIST" && !x.external_link);
  add(noLink.length ? "bad" : "ok", noLink.length ? "Playlists sin enlace de Spotify" : "Las playlists tienen su enlace", noLink.map((x) => x.day_number));

  const badLink = d.filter((x) => x.external_link && !/^https?:\/\//i.test(x.external_link));
  if (badLink.length) add("bad", "Enlaces que no empiezan con https://", badLink.map((x) => x.day_number));

  const noCoupon = d.filter((x) => ["CUPON", "GRAN_FINAL"].includes(x.category) && (!x.coupon_title || !x.coupon_code));
  add(noCoupon.length ? "bad" : "ok", noCoupon.length ? "Cupones sin título o sin código" : "Todos los cupones están completos", noCoupon.map((x) => x.day_number));

  const quiero = d.filter((x) => lintHits(x.title, x.subtitle, x.message_body, x.coupon_title).length);
  add(quiero.length ? "bad" : "ok", quiero.length ? 'Textos con "te quiero" (para ella es "te amo")' : 'Ningún texto dice "te quiero"', quiero.map((x) => x.day_number));

  if (state.filesOk) {
    const intro = files.has("intro.jpg");
    add(intro ? "ok" : "warn", intro ? "Foto de la intro subida" : "Falta la foto de la intro (intro.jpg)", [], intro ? null : "settings");
  }
  add(state.settings.has_topic ? "ok" : "warn",
    state.settings.has_topic ? "Avisos a tu teléfono configurados" : "No hay tema de avisos (ntfy): no te llegarán notificaciones");
  return list;
}

function renderDelivery() {
  const checks = buildChecks();
  const bad = checks.filter((c) => c.status === "bad").length;
  const warn = checks.filter((c) => c.status === "warn").length;
  const ICON = { ok: "✅", bad: "⛔", warn: "⚠️" };
  const banner = bad === 0
    ? `<div class="banner ok">🎁 Todo listo para entregar${warn ? ` (con ${warn} aviso${warn > 1 ? "s" : ""})` : ""}</div>`
    : `<div class="banner bad">Faltan ${bad} cosa${bad > 1 ? "s" : ""} antes de entregarla</div>`;
  $("#tab-delivery").innerHTML = `
    <div class="section-title"><h2>Checklist de entrega</h2>
      <button class="btn small" id="reloadChecks">↻ Revisar de nuevo</button></div>
    ${banner}
    ${checks.map((c) => `<div class="check"><div class="ico">${ICON[c.status]}</div>
      <div><div class="t">${esc(c.title)}</div>
        ${c.days.length ? `<ul><li>${c.days.map((n) => `<button class="tag" data-day="${n}" style="cursor:pointer;border:none">Día ${n}</button>`).join(" ")}</li></ul>` : ""}
      </div>
      ${c.go && c.status !== "ok" ? `<button class="btn small go" data-go="${c.go}">Ir a ajustes</button>` : ""}
    </div>`).join("")}`;
}

$("#tab-delivery").addEventListener("click", async (e) => {
  const day = e.target.closest("[data-day]");
  if (day) return openEditor(Number(day.dataset.day));
  const go = e.target.closest("[data-go]");
  if (go) return goTab(go.dataset.go);
  if (e.target.closest("#reloadChecks")) {
    try { await loadAll(); toast("Revisado ✓"); } catch (err) { toast(err.message, "error"); }
  }
});

/* ---------- pestaña: ajustes ---------- */
function renderSettings() {
  const c = state.config;
  if (!c) return;
  const introHas = state.files.some((f) => f.name === "intro.jpg");
  $("#tab-settings").innerHTML = `
    <div class="section-title"><h2>Ajustes</h2></div>

    <div class="card">
      <h3>Modo prueba</h3>
      <p class="muted">Si está encendido, TODOS los días se pueden abrir sin esperar la fecha. Solo para probar.</p>
      <label class="switch warn"><input type="checkbox" id="swForce" ${c.force_unlock_all ? "checked" : ""}>
        <span>Abrir todos los días</span></label>
      ${c.force_unlock_all ? `<div class="alert">⚠ Está encendido: ella podría ver todo. Apágalo antes de entregar.</div>` : ""}
    </div>

    <div class="card">
      <h3>Avisos a tu teléfono</h3>
      <p class="muted">Cuando ella te deje una nota, ¿quieres ver el texto en la notificación o solo "Te dejó una nota"?</p>
      <label class="switch"><input type="checkbox" id="swText" ${state.settings.include_text ? "checked" : ""}>
        <span>Mostrar el texto de sus notas en la notificación</span></label>
    </div>

    <div class="card">
      <h3>Textos de la app</h3>
      <form id="cfgForm">
        <label>Título de la app<input id="cTitle" value="${esc(c.couple_title)}" maxlength="60" required></label>
        <label>Mensaje de bienvenida<textarea id="cWelcome" rows="3">${esc(c.welcome_message)}</textarea></label>
        <label>Año del calendario<input id="cYear" type="number" min="2024" max="2100" value="${esc(c.target_year)}" required></label>
        <button class="btn primary" type="submit">Guardar textos</button>
      </form>
    </div>

    <div class="card">
      <h3>Foto de la intro</h3>
      <p class="muted">Es la foto que aparece en la carta de bienvenida (Polaroid). Se guarda como <code>intro.jpg</code>.</p>
      ${introHas ? `<img class="intro-preview" alt="Foto de la intro" src="${publicUrl("intro.jpg", state.introBust || 1)}">` : `<p class="muted">Aún no hay foto.</p>`}
      <label class="file-btn btn"><span>📎 ${introHas ? "Reemplazar foto" : "Subir foto"}</span>
        <input id="introFile" type="file" accept="image/*" hidden></label>
    </div>

    <div class="card danger-zone">
      <h3>Reiniciar el progreso</h3>
      <p class="muted">Borra aperturas, canjes, notas, reacciones y el historial. NO borra los textos ni los archivos. Úsalo justo antes de entregar.</p>
      <label>Escribe <b>REINICIAR</b> para confirmar<input id="resetText" autocomplete="off"></label>
      <button class="btn danger" id="resetBtn" disabled>Reiniciar progreso</button>
    </div>`;
}

const settingsRoot = $("#tab-settings");

settingsRoot.addEventListener("change", async (e) => {
  try {
    if (e.target.id === "swForce") {
      await rpc("admin_set_force_unlock", { v: e.target.checked });
      state.config.force_unlock_all = e.target.checked;
      toast(e.target.checked ? "Modo prueba ENCENDIDO" : "Modo prueba apagado ✓");
      renderSettings(); renderDelivery(); renderBadges();
    } else if (e.target.id === "swText") {
      await rpc("admin_set_include_text", { v: e.target.checked });
      state.settings.include_text = e.target.checked;
      toast("Guardado ✓");
    } else if (e.target.id === "introFile") {
      await uploadIntro(e.target.files[0]);
    }
  } catch (err) {
    toast(err.message, "error");
    await loadAll().catch(() => {});
  }
});

settingsRoot.addEventListener("input", (e) => {
  if (e.target.id === "resetText") $("#resetBtn").disabled = e.target.value.trim() !== "REINICIAR";
});

settingsRoot.addEventListener("submit", async (e) => {
  if (e.target.id !== "cfgForm") return;
  e.preventDefault();
  try {
    await rpc("admin_save_config", {
      p: { couple_title: $("#cTitle").value, welcome_message: $("#cWelcome").value, target_year: Number($("#cYear").value) },
    });
    state.config = await fetchConfig();
    toast("Guardado ✓");
  } catch (err) { toast(err.message, "error"); }
});

settingsRoot.addEventListener("click", async (e) => {
  if (e.target.id !== "resetBtn") return;
  if (!confirm("¿Seguro? Se borrará todo el progreso de ella (aperturas, canjes, notas y reacciones).")) return;
  try {
    await rpc("admin_reset_progress");
    toast("Progreso reiniciado ✓");
    await loadAll();
  } catch (err) { toast(err.message, "error"); }
});

async function uploadIntro(file) {
  if (!file) return;
  if (!file.type.startsWith("image/") || /heic|heif/i.test(file.type + file.name)) {
    return toast("Usa una foto JPG o PNG (las HEIC de iPhone no funcionan).", "error");
  }
  if (file.size > MAX_BYTES) return toast("La foto pesa más de 50 MB.", "error");
  toast("Subiendo foto…");
  const { error } = await sb.storage.from(BUCKET).upload("intro.jpg", file, {
    upsert: true, contentType: file.type, cacheControl: "3600",
  });
  if (error) throw new Error(error.message);
  state.introBust = Date.now();
  state.files = await listFiles();
  renderSettings(); renderDelivery(); renderBadges();
  toast("Foto de la intro lista ✓");
}

/* ---------- editor de día ---------- */
const dlg = $("#editor");

$("#fCategory").innerHTML = Object.entries(CAT)
  .map(([k, v]) => `<option value="${k}">${v.emoji} ${v.label}</option>`).join("");

function readForm() {
  return {
    title: $("#fTitle").value,
    subtitle: $("#fSubtitle").value,
    category: $("#fCategory").value,
    message_body: $("#fBody").value,
    media_type: editing.media_type,
    media_path: editing.media_path || "",
    external_link: $("#fLink").value,
    coupon_title: $("#fCouponTitle").value,
    coupon_code: $("#fCouponCode").value,
  };
}

function openEditor(n) {
  const d = state.days.find((x) => x.day_number === n);
  if (!d) return;
  editing = { n, media_type: d.media_type, media_path: d.media_path, oldPath: d.media_path, bust: 0 };
  dirty = false;
  $("#editorTitle").textContent = `Día ${n} · ${n} de diciembre`;
  $("#fTitle").value = d.title;
  $("#fSubtitle").value = d.subtitle || "";
  $("#fCategory").value = d.category;
  $("#fBody").value = d.message_body || "";
  $("#fLink").value = d.external_link || "";
  $("#fCouponTitle").value = d.coupon_title || "";
  $("#fCouponCode").value = d.coupon_code || "";
  $("#saveStatus").textContent = "";

  const info = [];
  if (d.is_opened) info.push(`🚪 Ella lo abrió el ${esc(fmt(d.opened_at))}`);
  if (d.reaction) info.push(`Reacción: ${REACT[d.reaction] || ""}`);
  if (d.is_redeemed) info.push(`🎟️ Cupón canjeado el ${esc(fmt(d.redeemed_at))}`);
  if (d.partner_reply) info.push(`💬 Su nota (${esc(fmt(d.replied_at))}):<p class="quote">${esc(d.partner_reply)}</p>`);
  $("#progressInfo").innerHTML = info.length ? info.join("<br>") : "";

  syncEditor();
  dlg.showModal();
  $(".editor-body").scrollTop = 0;
}

function syncEditor() {
  const n = editing.n;
  const cat = $("#fCategory").value;
  $("#couponFields").hidden = !(cat === "CUPON" || cat === "GRAN_FINAL");
  $("#mediaName").textContent = `dia_${pad(n)}.ext`;

  const p = editing.media_path, t = editing.media_type;
  const box = $("#mediaPreview");
  if (p && t === "IMAGE") box.innerHTML = `<img alt="" src="${esc(publicUrl(p, editing.bust))}">`;
  else if (p && t === "AUDIO") box.innerHTML = `<audio controls preload="metadata" src="${esc(publicUrl(p, editing.bust))}"></audio>`;
  else if (p && t === "VIDEO") box.innerHTML = `<video controls preload="metadata" src="${esc(publicUrl(p, editing.bust))}"></video>`;
  else box.innerHTML = `<p class="muted small">Este día no tiene archivo.</p>`;
  $("#mediaRemove").hidden = !p;
  $("#bodyCount").textContent = `${$("#fBody").value.length} caracteres`;
  refreshPreview();
  refreshLint();
}

function refreshPreview() {
  const v = readForm();
  const c = CAT[v.category] || { emoji: "•", label: "" };
  const paras = v.message_body.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
  const showCoupon = (v.category === "CUPON" || v.category === "GRAN_FINAL") && v.coupon_title.trim();
  const media = editing.media_path
    ? (editing.media_type === "IMAGE"
        ? `<img alt="" src="${esc(publicUrl(editing.media_path, editing.bust))}" style="width:100%;border-radius:8px;margin-bottom:12px">`
        : `<p class="muted small">${MEDIA_ICON[editing.media_type] || "📎"} Archivo adjunto</p>`)
    : "";
  $("#paper").innerHTML = `
    <div class="seal">${c.emoji}</div>
    <span class="chip-cat">DÍA ${editing.n} · ${esc(c.label.toUpperCase())}</span>
    <div class="date">${editing.n} de diciembre de ${esc(state.config.target_year)}</div>
    <h4>${esc(v.title) || "…"}</h4>
    ${v.subtitle.trim() ? `<div class="sub">${esc(v.subtitle)}</div>` : ""}
    <hr>${media}
    ${paras.map((p) => `<p>${esc(p)}</p>`).join("")}
    <div class="firma">Con todo mi amor,<br>Jhair</div>
    ${showCoupon ? `<div class="ticket"><small>VALE POR</small><b>${esc(v.coupon_title)}</b>${v.coupon_code.trim() ? `<small style="margin-top:6px">CÓDIGO ${esc(v.coupon_code)}</small>` : ""}</div>` : ""}
    ${v.external_link.trim() ? `<span class="linkbtn">${v.category === "PLAYLIST" ? "🎧 Abrir en Spotify" : "Abrir enlace"}</span>` : ""}`;
}

function refreshLint() {
  const v = readForm();
  const hits = lintHits(v.title, v.subtitle, v.message_body, v.coupon_title);
  const el = $("#lint");
  el.hidden = hits.length === 0;
  if (hits.length) el.textContent = `Ojo: encontré «${hits.join("», «")}». Para ella es "te amo", no "te quiero".`;
}

function markDirty() {
  dirty = true;
  $("#saveStatus").textContent = "Cambios sin guardar";
  $("#bodyCount").textContent = `${$("#fBody").value.length} caracteres`;
  $("#couponFields").hidden = !(["CUPON", "GRAN_FINAL"].includes($("#fCategory").value));
  refreshPreview();
  refreshLint();
}
["fTitle", "fSubtitle", "fCategory", "fBody", "fLink", "fCouponTitle", "fCouponCode"]
  .forEach((id) => $("#" + id).addEventListener("input", markDirty));

function setBusy(b) {
  ["editorSave", "editorCancel", "editorClose", "mediaRemove"].forEach((id) => ($("#" + id).disabled = b));
}

function tryClose() {
  if (dirty && !confirm("Tienes cambios sin guardar. ¿Descartarlos?")) return;
  dirty = false;
  dlg.close();
}
$("#editorClose").addEventListener("click", tryClose);
$("#editorCancel").addEventListener("click", tryClose);
dlg.addEventListener("cancel", (e) => {
  if (dirty && !confirm("Tienes cambios sin guardar. ¿Descartarlos?")) e.preventDefault();
  else dirty = false;
});

async function saveDay() {
  const n = editing.n;
  const p = readForm();
  setBusy(true);
  $("#saveStatus").textContent = "Guardando…";
  try {
    await rpc("admin_save_day", { n, p });
    const d = state.days.find((x) => x.day_number === n);
    Object.assign(d, {
      title: p.title.trim(), subtitle: p.subtitle.trim() || null, category: p.category,
      message_body: p.message_body, media_type: p.media_type,
      media_path: p.media_type === "NONE" ? null : (p.media_path.trim() || null),
      external_link: p.external_link.trim() || null,
      coupon_title: p.coupon_title.trim() || null, coupon_code: p.coupon_code.trim() || null,
    });
    // si reemplazó el archivo por uno con otra extensión, borra el viejo
    if (editing.oldPath && editing.oldPath !== d.media_path && /^dia_\d\d\./.test(editing.oldPath)) {
      await sb.storage.from(BUCKET).remove([editing.oldPath]);
      state.files = await listFiles();
    }
    editing.oldPath = d.media_path;
    dirty = false;
    $("#saveStatus").textContent = "Guardado ✓";
    renderDays(); renderDelivery(); renderBadges(); renderSettings();
    return true;
  } catch (err) {
    $("#saveStatus").textContent = "";
    toast(err.message, "error");
    return false;
  } finally {
    setBusy(false);
  }
}

$("#editorForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (await saveDay()) { toast("Guardado ✓"); dlg.close(); }
});

$("#fFile").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  e.target.value = "";
  if (!f) return;
  const ext = (f.name.split(".").pop() || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (/heic|heif/.test(ext) || /heic|heif/i.test(f.type)) {
    return toast("Las fotos HEIC de iPhone no funcionan en Android. Conviértela a JPG.", "error");
  }
  const type = f.type.startsWith("image/") ? "IMAGE" : f.type.startsWith("audio/") ? "AUDIO"
    : f.type.startsWith("video/") ? "VIDEO" : TYPE_BY_EXT[ext];
  if (!type) return toast("Solo se aceptan fotos, audios o videos.", "error");
  if (f.size > MAX_BYTES) {
    return toast(`Pesa ${(f.size / 1048576).toFixed(0)} MB; el máximo es 50 MB. Comprímelo antes de subirlo.`, "error");
  }
  const path = `dia_${pad(editing.n)}.${ext || "bin"}`;
  setBusy(true);
  $("#saveStatus").textContent = "Subiendo archivo…";
  const { error } = await sb.storage.from(BUCKET).upload(path, f, {
    upsert: true, contentType: f.type || MIME_BY_EXT[ext] || "application/octet-stream", cacheControl: "3600",
  });
  setBusy(false);
  if (error) {
    $("#saveStatus").textContent = "";
    return toast("No se pudo subir: " + error.message, "error");
  }
  editing.media_type = type;
  editing.media_path = path;
  editing.bust = Date.now();
  state.files = await listFiles();
  markDirty();
  syncEditor();
  await saveDay(); // guarda de una vez para no dejar el archivo huérfano
  toast("Archivo subido y guardado ✓");
});

$("#mediaRemove").addEventListener("click", async () => {
  if (!confirm("¿Quitar el archivo de este día? También se borra del almacenamiento.")) return;
  editing.media_type = "NONE";
  editing.media_path = null;
  markDirty();
  syncEditor();
  if (await saveDay()) toast("Archivo quitado ✓");
});

boot();
