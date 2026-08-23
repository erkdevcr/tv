/* ============================================================
   SALA · Videoteca de Google Drive para Google TV
   Todo se guarda localmente (localStorage). No hay backend.
   ============================================================ */

const STORAGE_KEY = "sala_videoteca_v1";
const SOURCES_KEY = "sala_sources_v1";
const SOURCES_SEEDED_KEY = "sala_sources_seeded_v1";
const APIKEY_KEY = "sala_apikey_v1";
const GAIN_KEY = "sala_gain_db_v1";

// Fuente por defecto: se precarga una única vez en el primer arranque de la app
// (si el usuario la borra, no vuelve a aparecer sola).
const DEFAULT_SOURCE_LINK = "https://drive.google.com/drive/folders/1JqI8IrzxAnegVfoEuar2CdI4iv39O2Kw";

// API Key de Google Drive incrustada por defecto (restringida solo a Drive API).
// Si el usuario pega otra en el modal de Fuentes, esa tiene prioridad y queda guardada en su navegador.
const DEFAULT_API_KEY = "AIzaSyDln7Y-S4MEXqNzqi_YqBM4pAVkjzpdoqo";

/** @typedef {{
 *  id:string, title:string, link:string, fileId:string,
 *  favorite:boolean, playCount:number, lastPosition:number,
 *  duration:number, lastWatchedAt:number|null, addedAt:number
 * }} VideoEntry
 */

let library = loadLibrary();
let sources = loadSources();
let apiKey = loadApiKey();
let currentSort = "recent";
let filterFavoritesOnly = false;
let searchTerm = "";
let activeVideoId = null;
let controlsHideTimer = null;

// ---------- Persistencia ----------
function loadLibrary() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    console.error("No se pudo leer la videoteca guardada", e);
    return [];
  }
}

function saveLibrary() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(library));
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ---------- Fuentes (carpetas de Drive) ----------
function loadSources() {
  try {
    const raw = localStorage.getItem(SOURCES_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) { console.error("No se pudieron leer las fuentes", e); }

  // Primer arranque: sembrar la fuente por defecto una sola vez.
  if (!localStorage.getItem(SOURCES_SEEDED_KEY)) {
    localStorage.setItem(SOURCES_SEEDED_KEY, "1");
    const folderId = extractDriveFolderId(DEFAULT_SOURCE_LINK);
    if (folderId) {
      const seeded = [{ id: uid(), link: DEFAULT_SOURCE_LINK, folderId, label: "Carpeta principal", lastCount: null }];
      localStorage.setItem(SOURCES_KEY, JSON.stringify(seeded));
      return seeded;
    }
  }
  return [];
}

function saveSources() {
  localStorage.setItem(SOURCES_KEY, JSON.stringify(sources));
}

function loadApiKey() {
  const stored = localStorage.getItem(APIKEY_KEY);
  return stored !== null && stored !== "" ? stored : DEFAULT_API_KEY;
}

function saveApiKey(key) {
  apiKey = key.trim();
  localStorage.setItem(APIKEY_KEY, apiKey);
}

// ---------- Extraer ID de archivo / carpeta de Google Drive ----------
function extractDriveFileId(link) {
  if (!link) return null;
  const patterns = [
    /\/file\/d\/([a-zA-Z0-9_-]{10,})/,      // .../file/d/ID/view
    /[?&]id=([a-zA-Z0-9_-]{10,})/,           // ...?id=ID  o open?id=ID
    /\/d\/([a-zA-Z0-9_-]{10,})/,             // .../d/ID
  ];
  for (const re of patterns) {
    const m = link.match(re);
    if (m) return m[1];
  }
  return null;
}

function extractDriveFolderId(link) {
  if (!link) return null;
  const m = link.match(/\/folders\/([a-zA-Z0-9_-]{10,})/);
  if (m) return m[1];
  // Permitir que también peguen solo el ID de la carpeta.
  if (/^[a-zA-Z0-9_-]{15,}$/.test(link.trim())) return link.trim();
  return null;
}

function stripVideoExtension(name) {
  return name.replace(/\.(mp4|mov|mkv|avi|webm|m4v|wmv|flv|mpg|mpeg)$/i, "");
}

// ---------- Google Drive API: listar videos de una carpeta ----------
async function fetchFolderVideos(folderId, key) {
  const files = [];
  let pageToken = "";
  let pages = 0;
  const q = encodeURIComponent(`'${folderId}' in parents and trashed = false and mimeType contains 'video/'`);
  const fields = encodeURIComponent("nextPageToken, files(id,name,mimeType,thumbnailLink,videoMediaMetadata(durationMillis))");

  do {
    const url = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=${fields}&pageSize=1000&key=${encodeURIComponent(key)}${pageToken ? `&pageToken=${pageToken}` : ""}`;
    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const msg = body?.error?.message || `Error HTTP ${res.status}`;
      throw new Error(msg);
    }
    const data = await res.json();
    (data.files || []).forEach(f => files.push(f));
    pageToken = data.nextPageToken || "";
    pages++;
  } while (pageToken && pages < 10);

  return files;
}

// ---------- Sincronizar todas las fuentes con la biblioteca ----------
async function syncAllSources({ silent = false } = {}) {
  const statusEl = document.getElementById("syncStatus");
  if (sources.length === 0) {
    if (!silent && statusEl) { statusEl.textContent = "No hay fuentes agregadas todavía."; statusEl.className = "sync-status"; }
    return;
  }
  if (!apiKey) {
    if (!silent && statusEl) {
      statusEl.textContent = "Falta la API Key de Google Drive para poder leer las carpetas.";
      statusEl.className = "sync-status error";
    }
    if (!silent) showToast("Agrega tu API Key de Google Drive para leer las carpetas");
    return;
  }

  if (statusEl) { statusEl.textContent = "Actualizando desde Google Drive…"; statusEl.className = "sync-status"; }

  let totalNew = 0;
  let errorCount = 0;
  let lastError = "";

  for (const source of sources) {
    try {
      const files = await fetchFolderVideos(source.folderId, apiKey);
      source.lastCount = files.length;
      files.forEach(f => {
        const existing = library.find(v => v.fileId === f.id);
        if (existing) {
          // Actualiza metadata "de catálogo" sin tocar el progreso/historial ya guardado.
          existing.title = existing.title || stripVideoExtension(f.name);
          existing.thumbnailLink = f.thumbnailLink || existing.thumbnailLink || null;
          existing.sourceId = source.id;
          return;
        }
        totalNew++;
        library.push({
          id: uid(),
          title: stripVideoExtension(f.name),
          link: null,
          fileId: f.id,
          sourceId: source.id,
          thumbnailLink: f.thumbnailLink || null,
          favorite: false,
          playCount: 0,
          lastPosition: 0,
          duration: f.videoMediaMetadata?.durationMillis ? Number(f.videoMediaMetadata.durationMillis) / 1000 : 0,
          lastWatchedAt: null,
          addedAt: Date.now(),
        });
      });
    } catch (err) {
      errorCount++;
      lastError = err.message || String(err);
    }
  }

  saveLibrary();
  saveSources();
  renderSourceList();
  renderLibrary();

  if (statusEl) {
    if (errorCount > 0 && totalNew === 0) {
      statusEl.textContent = `No se pudo leer alguna fuente: ${lastError}`;
      statusEl.className = "sync-status error";
    } else if (errorCount > 0) {
      statusEl.textContent = `Se agregaron ${totalNew} video(s) nuevo(s), pero hubo errores en otra fuente: ${lastError}`;
      statusEl.className = "sync-status error";
    } else {
      statusEl.textContent = totalNew > 0 ? `Listo: ${totalNew} video(s) nuevo(s) agregado(s).` : "Listo: no hay videos nuevos.";
      statusEl.className = "sync-status success";
    }
  }
  if (!silent) showToast(totalNew > 0 ? `${totalNew} video(s) nuevo(s) agregado(s) a la videoteca` : "Videoteca ya está al día");
}

function driveDirectUrl(fileId) {
  return `https://drive.google.com/uc?export=download&id=${fileId}`;
}
function drivePreviewUrl(fileId) {
  return `https://drive.google.com/file/d/${fileId}/preview`;
}

// ---------- Utilidades ----------
function formatTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function showToast(msg, ms = 2200) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => { t.hidden = true; }, ms);
}

// ============================================================
// DROPDOWN DE ORDEN (propio, no <select> nativo)
// ============================================================
// El <select> nativo del navegador abre un picker del sistema operativo/plataforma que
// no se puede estilizar y, en varias TVs, no navega bien con el mando (flechas/OK).
// Este dropdown propio es solo botones y una lista, así que se comporta igual que el
// resto de la UI con el control remoto: flechas arriba/abajo mueven el foco, OK/Enter
// selecciona, Atrás/Escape cierra.
function initSortDropdown() {
  const btn = document.getElementById("sortSelectBtn");
  const list = document.getElementById("sortSelectList");
  const label = document.getElementById("sortSelectLabel");
  const items = Array.from(list.querySelectorAll("li"));

  function positionList() {
    // La lista es position:fixed (para no quedar recortada por el overflow-x:auto
    // del topbar), así que su posición se calcula en JS según dónde está el botón.
    const rect = btn.getBoundingClientRect();
    list.style.top = `${rect.bottom + 8}px`;
    list.style.left = `${rect.left}px`;
    list.style.minWidth = `${rect.width}px`;
  }
  function openList() {
    positionList();
    list.hidden = false;
    btn.setAttribute("aria-expanded", "true");
    const current = items.find(i => i.dataset.value === currentSort) || items[0];
    current.focus();
  }
  function closeList(returnFocus = true) {
    list.hidden = true;
    btn.setAttribute("aria-expanded", "false");
    if (returnFocus) btn.focus();
  }
  function selectValue(value) {
    currentSort = value;
    const opt = items.find(i => i.dataset.value === value);
    label.textContent = opt ? opt.textContent : "";
    items.forEach(i => i.setAttribute("aria-selected", String(i.dataset.value === value)));
    renderLibrary();
  }

  btn.addEventListener("click", () => {
    if (list.hidden) openList(); else closeList(false);
  });
  btn.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
      e.preventDefault();
      openList();
    }
  });

  items.forEach((item, idx) => {
    item.addEventListener("click", () => { selectValue(item.dataset.value); closeList(); });
    item.addEventListener("keydown", (e) => {
      switch (e.key) {
        case "Enter":
        case " ":
          e.preventDefault(); selectValue(item.dataset.value); closeList(); break;
        case "ArrowDown":
          e.preventDefault(); (items[idx + 1] || items[0]).focus(); break;
        case "ArrowUp":
          e.preventDefault(); (items[idx - 1] || items[items.length - 1]).focus(); break;
        case "Escape":
        case "Backspace":
          e.preventDefault(); closeList(); break;
      }
    });
  });

  document.addEventListener("click", (e) => {
    if (!list.hidden && !btn.contains(e.target) && !list.contains(e.target)) closeList(false);
  });
  window.addEventListener("resize", () => {
    if (!list.hidden) closeList(false);
  });
}

// ============================================================
// RENDER DE LA BIBLIOTECA
// ============================================================
function getFilteredSorted() {
  let list = [...library];

  if (filterFavoritesOnly) list = list.filter(v => v.favorite);
  if (searchTerm.trim()) {
    const q = searchTerm.trim().toLowerCase();
    list = list.filter(v => v.title.toLowerCase().includes(q));
  }

  switch (currentSort) {
    case "recent":
      list.sort((a, b) => b.addedAt - a.addedAt);
      break;
    case "lastwatched":
      list.sort((a, b) => (b.lastWatchedAt || 0) - (a.lastWatchedAt || 0));
      break;
    case "mostplayed":
      list.sort((a, b) => b.playCount - a.playCount);
      break;
    case "az":
      list.sort((a, b) => a.title.localeCompare(b.title, "es"));
      break;
    case "favorites":
      list.sort((a, b) => (b.favorite - a.favorite) || (b.addedAt - a.addedAt));
      break;
  }
  return list;
}

function buildCard(video) {
  const tmpl = document.getElementById("cardTemplate");
  const node = tmpl.content.firstElementChild.cloneNode(true);
  node.dataset.id = video.id;
  node.classList.toggle("is-fav", !!video.favorite);

  node.querySelector(".card-title").textContent = video.title;

  if (video.thumbnailLink) {
    const img = document.createElement("img");
    img.className = "card-thumb-img";
    img.src = video.thumbnailLink;
    img.alt = "";
    img.loading = "lazy";
    img.onerror = () => img.remove();
    node.querySelector(".card-thumb").prepend(img);
  }

  const meta = node.querySelector(".card-meta");
  const bits = [];
  if (video.playCount > 0) bits.push(`${video.playCount} reproducción${video.playCount === 1 ? "" : "es"}`);
  if (video.lastWatchedAt) bits.push(`visto ${timeAgo(video.lastWatchedAt)}`);
  meta.textContent = bits.length ? bits.join(" · ") : "Sin reproducir";

  if (video.duration > 0 && video.lastPosition > 0) {
    const pct = Math.min(100, (video.lastPosition / video.duration) * 100);
    node.querySelector(".card-progress-fill").style.width = pct + "%";
  }

  node.addEventListener("click", () => openPlayer(video.id));
  node.addEventListener("keydown", (e) => {
    if (e.key === "Enter") openPlayer(video.id);
  });

  node.querySelector(".fav-toggle").addEventListener("click", (e) => {
    e.stopPropagation();
    toggleFavorite(video.id);
  });

  return node;
}

function timeAgo(ts) {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "hace un momento";
  if (min < 60) return `hace ${min} min`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `hace ${hrs} h`;
  const days = Math.floor(hrs / 24);
  return `hace ${days} d`;
}

// Botón "Biblioteca": limpia búsqueda y filtro de favoritos, y vuelve a la vista completa.
// Pensado para navegación con el mando de la TV: siempre queda un botón fijo y visible
// que regresa a un estado conocido, sin depender de borrar texto del buscador con teclas.
function goToLibrary() {
  filterFavoritesOnly = false;
  searchTerm = "";
  const searchInput = document.getElementById("searchInput");
  searchInput.value = "";
  document.getElementById("filterFavBtn").setAttribute("aria-pressed", "false");
  renderLibrary();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function renderLibrary() {
  const mainGrid = document.getElementById("mainGrid");
  const continueRow = document.getElementById("continueRow");
  const continueGrid = document.getElementById("continueGrid");
  const emptyState = document.getElementById("emptyState");
  const gridTitle = document.getElementById("gridTitle");

  mainGrid.innerHTML = "";
  continueGrid.innerHTML = "";

  if (library.length === 0) {
    emptyState.hidden = false;
    continueRow.hidden = true;
    mainGrid.parentElement.hidden = true;
    return;
  }
  emptyState.hidden = true;
  mainGrid.parentElement.hidden = false;

  // Fila "continuar viendo": progreso entre 3% y 92% de la duración
  const inProgress = library.filter(v =>
    v.duration > 0 && v.lastPosition > Math.min(15, v.duration * 0.03) &&
    v.lastPosition < v.duration * 0.92
  ).sort((a, b) => (b.lastWatchedAt || 0) - (a.lastWatchedAt || 0));

  if (inProgress.length > 0 && !filterFavoritesOnly && !searchTerm.trim()) {
    continueRow.hidden = false;
    inProgress.forEach(v => continueGrid.appendChild(buildCard(v)));
  } else {
    continueRow.hidden = true;
  }

  const list = getFilteredSorted();
  gridTitle.textContent = filterFavoritesOnly ? "Tus favoritos" :
    (searchTerm.trim() ? `Resultados para “${searchTerm.trim()}”` : "Tu videoteca");

  if (list.length === 0) {
    const p = document.createElement("p");
    p.style.color = "var(--text-muted)";
    p.textContent = "No encontramos nada con esos filtros.";
    mainGrid.appendChild(p);
    return;
  }

  list.forEach(v => mainGrid.appendChild(buildCard(v)));
}

function toggleFavorite(id) {
  const v = library.find(x => x.id === id);
  if (!v) return;
  v.favorite = !v.favorite;
  saveLibrary();
  renderLibrary();
  if (activeVideoId === id) syncPlayerFavIcon();
  showToast(v.favorite ? "Agregado a favoritos" : "Quitado de favoritos");
}

// ============================================================
// MODAL: FUENTES (CARPETAS DE DRIVE)
// ============================================================
function renderSourceList() {
  const list = document.getElementById("sourceList");
  const tmpl = document.getElementById("sourceRowTemplate");
  list.innerHTML = "";

  if (sources.length === 0) {
    const p = document.createElement("p");
    p.style.color = "var(--text-muted)";
    p.style.fontSize = ".85rem";
    p.textContent = "Todavía no agregas ninguna carpeta.";
    list.appendChild(p);
    return;
  }

  sources.forEach(source => {
    const node = tmpl.content.firstElementChild.cloneNode(true);
    node.querySelector(".source-label").textContent = source.label || "Carpeta sin nombre";
    node.querySelector(".source-link").textContent = source.link;
    node.querySelector(".source-count").textContent =
      source.lastCount === null || source.lastCount === undefined ? "sin sincronizar" : `${source.lastCount} video(s)`;
    node.querySelector(".source-del").addEventListener("click", () => removeSource(source.id));
    list.appendChild(node);
  });
}

function openSourcesModal() {
  document.getElementById("inputApiKey").value = apiKey;
  document.getElementById("inputSourceLink").value = "";
  document.getElementById("inputSourceLabel").value = "";
  document.getElementById("sourceHint").textContent = "";
  document.getElementById("syncStatus").textContent = "";
  document.getElementById("syncStatus").className = "sync-status";
  renderSourceList();
  document.getElementById("sourcesModal").hidden = false;
}

function closeSourcesModal() {
  document.getElementById("sourcesModal").hidden = true;
}

function addSource() {
  const link = document.getElementById("inputSourceLink").value.trim();
  const label = document.getElementById("inputSourceLabel").value.trim();
  const hint = document.getElementById("sourceHint");

  const folderId = extractDriveFolderId(link);
  if (!folderId) {
    hint.textContent = "Pega un link válido de carpeta de Google Drive (o su ID).";
    hint.classList.add("error");
    return;
  }
  if (sources.some(s => s.folderId === folderId)) {
    hint.textContent = "Esa carpeta ya está agregada como fuente.";
    hint.classList.add("error");
    return;
  }

  sources.push({ id: uid(), link, folderId, label: label || "Carpeta sin nombre", lastCount: null });
  saveSources();
  renderSourceList();
  document.getElementById("inputSourceLink").value = "";
  document.getElementById("inputSourceLabel").value = "";
  hint.textContent = "Fuente agregada. Dale a \"Actualizar biblioteca ahora\" para leer sus videos.";
  hint.classList.remove("error");
}

function removeSource(id) {
  sources = sources.filter(s => s.id !== id);
  saveSources();
  renderSourceList();
  showToast("Fuente quitada. Los videos ya agregados a tu videoteca no se borran.");
}

// ============================================================
// MODAL: AGREGAR VIDEO
// ============================================================
function openAddModal() {
  document.getElementById("inputLink").value = "";
  document.getElementById("inputTitle").value = "";
  document.getElementById("linkHint").textContent = "";
  document.getElementById("linkHint").classList.remove("error");
  document.getElementById("addModal").hidden = false;
  document.getElementById("inputLink").focus();
}

function closeAddModal() {
  document.getElementById("addModal").hidden = true;
}

function handleLinkInput() {
  const link = document.getElementById("inputLink").value.trim();
  const hint = document.getElementById("linkHint");
  if (!link) { hint.textContent = ""; return; }
  const id = extractDriveFileId(link);
  if (id) {
    hint.textContent = "Link de Drive reconocido ✓";
    hint.classList.remove("error");
  } else {
    hint.textContent = "No reconocemos este formato de link de Google Drive.";
    hint.classList.add("error");
  }
}

function saveNewVideo() {
  const link = document.getElementById("inputLink").value.trim();
  const title = document.getElementById("inputTitle").value.trim();
  const hint = document.getElementById("linkHint");

  const fileId = extractDriveFileId(link);
  if (!fileId) {
    hint.textContent = "Pega un link válido para compartir de Google Drive.";
    hint.classList.add("error");
    return;
  }
  if (!title) {
    hint.textContent = "Ponle un título a la función.";
    hint.classList.add("error");
    return;
  }
  if (library.some(v => v.fileId === fileId)) {
    hint.textContent = "Este video ya está en tu videoteca.";
    hint.classList.add("error");
    return;
  }

  const entry = {
    id: uid(), title, link, fileId,
    favorite: false, playCount: 0, lastPosition: 0, duration: 0,
    lastWatchedAt: null, addedAt: Date.now(),
  };
  library.push(entry);
  saveLibrary();
  renderLibrary();
  closeAddModal();
  showToast("Video agregado a la videoteca");
}

// ============================================================
// REPRODUCTOR
// ============================================================
const videoEl = document.getElementById("videoEl");
const fallbackFrame = document.getElementById("fallbackFrame");
let saveProgressTimer = null;
let controlsVisible = true;

function openPlayer(id) {
  const v = library.find(x => x.id === id);
  if (!v) return;
  activeVideoId = id;

  document.getElementById("playerView").hidden = false;
  document.getElementById("playerTitle").textContent = v.title;
  syncPlayerFavIcon();
  updatePlayCountLabel(v);

  document.getElementById("playerLoading").hidden = false;
  document.getElementById("playerError").hidden = true;
  fallbackFrame.hidden = true;
  fallbackFrame.src = "";
  videoEl.hidden = false;
  videoEl.src = driveDirectUrl(v.fileId);
  videoEl.playbackRate = 1;
  setActiveSpeedChip(1);
  setFallbackMode(false);

  videoEl.load();
  videoEl.play().catch(() => {/* el usuario deberá darle play manualmente en algunos TVs */});
  requestPlayerFullscreen();
  ensureAudioGraph();
  applyGain();

  showControls();
}

// Pantalla completa al abrir un video: se pide sobre todo el contenedor del reproductor
// (no solo el <video>) para que cubra igual el modo nativo y el iframe de Drive.
// Requiere gesto del usuario (el clic en la tarjeta lo es), por eso se llama aquí mismo.
function requestPlayerFullscreen() {
  const el = document.getElementById("playerView");
  const request = el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen;
  if (!request) return;
  try {
    const result = request.call(el);
    if (result && typeof result.catch === "function") {
      result.catch(() => {/* algunas plataformas de TV no lo permiten */});
    }
  } catch (e) { /* algunas plataformas de TV no lo permiten */ }
}

function exitPlayerFullscreen() {
  const inFullscreen = document.fullscreenElement || document.webkitFullscreenElement || document.msFullscreenElement;
  if (!inFullscreen) return;
  const exit = document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen;
  if (!exit) return;
  try {
    const result = exit.call(document);
    if (result && typeof result.catch === "function") result.catch(() => {});
  } catch (e) { /* ignore */ }
}

// Modo "reproductor de Drive": el iframe de Drive trae sus propios controles
// (play/pausa, avance, progreso, velocidad) y su propia lógica de mostrar/ocultarlos.
// La app no debe superponer nada encima ni decidir cuándo ocultarse — se quita
// por completo el overlay propio y se le deja todo el manejo al iframe.
// Para volver a la videoteca sigue funcionando el botón "Atrás"/Escape del control
// remoto (manejado a nivel de teclado, sin depender de un botón visible en pantalla).
let fallbackModeActive = false;
function setFallbackMode(active) {
  fallbackModeActive = active;
  const overlay = document.getElementById("playerOverlay");
  overlay.hidden = active;
  clearTimeout(controlsHideTimer);
  overlay.classList.remove("hidden-controls");
  const blocker = document.getElementById("driveBtnBlocker");
  if (blocker) blocker.hidden = !active;
}

function updatePlayCountLabel(v) {
  document.getElementById("playCountLabel").textContent =
    v.playCount > 0 ? `${v.playCount} reproducción${v.playCount === 1 ? "" : "es"}` : "Primera vez";
}

function syncPlayerFavIcon() {
  const v = library.find(x => x.id === activeVideoId);
  document.getElementById("favBtnPlayer").classList.toggle("active", !!(v && v.favorite));
}

function closePlayer() {
  videoEl.pause();
  videoEl.removeAttribute("src");
  videoEl.load();
  fallbackFrame.src = "";
  document.getElementById("playerView").hidden = true;
  activeVideoId = null;
  clearInterval(saveProgressTimer);
  setFallbackMode(false);
  exitPlayerFullscreen();
  renderLibrary();
}

// ============================================================
// GANANCIA DE AUDIO (botón de engranaje)
// El <video> nativo no puede pasar de 100% de volumen, así que se usa
// Web Audio API para amplificar de verdad. Solo aplica al reproductor
// propio: en modo Drive (iframe) el overlay ya está oculto y este botón
// nunca se muestra, así que no hace falta excluirlo aparte.
// ============================================================
let audioCtx = null;
let gainNode = null;
let mediaSourceNode = null; // createMediaElementSource solo puede llamarse UNA vez por <video>

// Por defecto se sube +6 dB (los videos se oían bajos); si el usuario ya guardó
// un valor propio (incluido 0), ese tiene prioridad y se respeta siempre.
const DEFAULT_GAIN_DB = 6;

function loadGainDB() {
  const raw = localStorage.getItem(GAIN_KEY);
  if (raw === null) return DEFAULT_GAIN_DB;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? Math.min(12, Math.max(-12, n)) : DEFAULT_GAIN_DB;
}

function saveGainDB(db) {
  localStorage.setItem(GAIN_KEY, String(db));
}

let currentGainDB = loadGainDB();

function dbToLinear(db) {
  return Math.pow(10, db / 20);
}

function ensureAudioGraph() {
  if (mediaSourceNode) return; // ya conectado a este <video>, no repetir
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    audioCtx = new AudioCtx();
    mediaSourceNode = audioCtx.createMediaElementSource(videoEl);
    gainNode = audioCtx.createGain();
    mediaSourceNode.connect(gainNode);
    gainNode.connect(audioCtx.destination);
  } catch (e) { /* algunos navegadores de TV no soportan Web Audio API */ }
}

function applyGain() {
  if (!gainNode) return;
  gainNode.gain.value = dbToLinear(currentGainDB);
  if (audioCtx && audioCtx.state === "suspended") {
    audioCtx.resume().catch(() => {});
  }
}

// Puede haber más de un control de ganancia visible a la vez (el del home,
// junto a "Agregar video", y el del reproductor, junto a Favorito). Todos
// comparten el mismo valor guardado, así que se registran aquí para
// actualizarlos y abrirlos/cerrarlos en conjunto.
const gainPanelInstances = [];

function updateGainLabel() {
  document.querySelectorAll(".gain-value").forEach(label => {
    label.textContent = `${currentGainDB > 0 ? "+" : ""}${currentGainDB} dB`;
  });
}

function changeGain(delta) {
  currentGainDB = Math.min(12, Math.max(-12, currentGainDB + delta));
  saveGainDB(currentGainDB);
  updateGainLabel();
  applyGain();
}

function positionGainPanel(panel, btn) {
  // El panel es position:fixed (para no quedar recortado por overflow-x:auto
  // del topbar u otros contenedores), así que su posición se calcula en JS.
  const rect = btn.getBoundingClientRect();
  panel.style.top = `${rect.bottom + 10}px`;
  const left = Math.min(rect.right - 220, window.innerWidth - 232);
  panel.style.left = `${Math.max(12, left)}px`;
}

function closeAllGainPanels(except) {
  gainPanelInstances.forEach(({ panel, btn }) => {
    if (panel === except) return;
    panel.hidden = true;
    btn.setAttribute("aria-expanded", "false");
  });
}

function toggleGainPanelInstance(panel, btn, forceState) {
  const open = forceState !== undefined ? forceState : panel.hidden;
  closeAllGainPanels(open ? panel : null);
  if (open) positionGainPanel(panel, btn);
  panel.hidden = !open;
  btn.setAttribute("aria-expanded", open ? "true" : "false");
}

function setupGainInstance(btnId, panelId, upId, downId) {
  const btn = document.getElementById(btnId);
  const panel = document.getElementById(panelId);
  const upBtn = document.getElementById(upId);
  const downBtn = document.getElementById(downId);
  if (!btn || !panel || !upBtn || !downBtn) return;

  gainPanelInstances.push({ btn, panel });

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleGainPanelInstance(panel, btn);
  });
  upBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    changeGain(1);
  });
  downBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    changeGain(-1);
  });
}

function initGainControls() {
  updateGainLabel();
  setupGainInstance("gainBtnHome", "gainPanelHome", "gainUpBtnHome", "gainDownBtnHome");
  setupGainInstance("gainBtn", "gainPanel", "gainUpBtn", "gainDownBtn");

  document.addEventListener("click", (e) => {
    const insideAny = gainPanelInstances.some(({ panel, btn }) => panel.contains(e.target) || btn.contains(e.target));
    if (!insideAny) closeAllGainPanels(null);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" || e.key === "Backspace") closeAllGainPanels(null);
  });
  window.addEventListener("resize", () => closeAllGainPanels(null));
}

// Si el usuario sale de pantalla completa por otro medio (control remoto de la TV,
// gesto del sistema, etc.) en vez de usar el botón/tecla de la app, se cierra el
// reproductor igual para no dejarlo "a medias" con el overlay o el video de fondo.
["fullscreenchange", "webkitfullscreenchange", "msfullscreenchange"].forEach(evt => {
  document.addEventListener(evt, () => {
    const inFullscreen = document.fullscreenElement || document.webkitFullscreenElement || document.msFullscreenElement;
    const playerOpen = !document.getElementById("playerView").hidden;
    if (!inFullscreen && playerOpen) closePlayer();
  });
});

function useFallbackPlayer() {
  const v = library.find(x => x.id === activeVideoId);
  if (!v) return;
  document.getElementById("playerError").hidden = true;
  videoEl.hidden = true;
  fallbackFrame.hidden = false;
  fallbackFrame.src = drivePreviewUrl(v.fileId);
  setFallbackMode(true);
}

// ---- Eventos del <video> ----
videoEl.addEventListener("loadedmetadata", () => {
  document.getElementById("playerLoading").hidden = true;
  const v = library.find(x => x.id === activeVideoId);
  if (!v) return;
  v.duration = videoEl.duration || 0;

  // Continuar donde quedó
  if (v.lastPosition > 5 && v.lastPosition < v.duration - 5) {
    videoEl.currentTime = v.lastPosition;
    showToast(`Continuando en ${formatTime(v.lastPosition)}`);
  }
  saveLibrary();
  updateScrubUI();

  clearInterval(saveProgressTimer);
  saveProgressTimer = setInterval(persistProgress, 4000);
});

videoEl.addEventListener("error", () => {
  document.getElementById("playerLoading").hidden = true;
  // En vez de mostrar la pantalla de error con los dos botones, se pasa
  // directo al reproductor embebido de Google Drive.
  useFallbackPlayer();
});

videoEl.addEventListener("play", () => setPlayIcon(true));
videoEl.addEventListener("pause", () => setPlayIcon(false));

// Si el video se queda sin buffer a mitad de la reproducción, algunos navegadores
// (sobre todo en TV) muestran su propio ícono nativo de carga justo encima del
// video, en el mismo punto donde está nuestro botón grande de play/pausa. Para
// que nunca se vean pegados/superpuestos, ocultamos nuestro ícono mientras dura
// el "waiting" y lo devolvemos apenas retoma la reproducción.
videoEl.addEventListener("waiting", () => {
  document.getElementById("playPauseBtn").classList.add("buffering");
});
videoEl.addEventListener("playing", () => {
  document.getElementById("playPauseBtn").classList.remove("buffering");
});

videoEl.addEventListener("timeupdate", updateScrubUI);

videoEl.addEventListener("ended", () => {
  const v = library.find(x => x.id === activeVideoId);
  if (!v) return;
  v.playCount += 1;
  v.lastWatchedAt = Date.now();
  v.lastPosition = 0;
  saveLibrary();
  updatePlayCountLabel(v);
  showToast("¡Función terminada! Reproducción contabilizada.");
});

function persistProgress() {
  const v = library.find(x => x.id === activeVideoId);
  if (!v || videoEl.hidden) return;
  v.lastPosition = videoEl.currentTime || 0;
  v.duration = videoEl.duration || v.duration;
  v.lastWatchedAt = Date.now();
  saveLibrary();
}

function setPlayIcon(isPlaying) {
  document.getElementById("iconPlay").hidden = isPlaying;
  document.getElementById("iconPause").hidden = !isPlaying;
}

function updateScrubUI() {
  if (!videoEl.duration) return;
  const pct = (videoEl.currentTime / videoEl.duration) * 100;
  document.getElementById("scrubFill").style.width = pct + "%";
  document.getElementById("scrubHandle").style.left = pct + "%";
  document.getElementById("scrubTrack").setAttribute("aria-valuenow", Math.round(pct));
  document.getElementById("curTime").textContent = formatTime(videoEl.currentTime);
  document.getElementById("durTime").textContent = formatTime(videoEl.duration);
}

function togglePlayPause() {
  if (videoEl.hidden) return;
  if (videoEl.paused) videoEl.play(); else videoEl.pause();
}

function skip(seconds) {
  if (videoEl.hidden || !videoEl.duration) return;
  videoEl.currentTime = Math.min(Math.max(0, videoEl.currentTime + seconds), videoEl.duration);
  persistProgress();
}

function setSpeed(speed) {
  videoEl.playbackRate = speed;
  setActiveSpeedChip(speed);
}

function setActiveSpeedChip(speed) {
  document.querySelectorAll(".chip").forEach(c => {
    c.classList.toggle("active", parseFloat(c.dataset.speed) === speed);
  });
}

function seekToPercent(pct) {
  if (!videoEl.duration) return;
  videoEl.currentTime = (pct / 100) * videoEl.duration;
  persistProgress();
}

// ---- Auto-ocultar controles ----
function showControls() {
  const overlay = document.getElementById("playerOverlay");
  overlay.classList.remove("hidden-controls");
  controlsVisible = true;
  clearTimeout(controlsHideTimer);
  if (fallbackModeActive) return; // en modo Drive el overlay propio está oculto, no aplica
  controlsHideTimer = setTimeout(() => {
    overlay.classList.add("hidden-controls");
    controlsVisible = false;
  }, 5000);
}

// ============================================================
// EVENTOS DE UI
// ============================================================
document.getElementById("sourcesBtn").addEventListener("click", openSourcesModal);
document.getElementById("closeSourcesBtn").addEventListener("click", closeSourcesModal);
document.getElementById("addSourceBtn").addEventListener("click", addSource);
document.getElementById("syncSourcesBtn").addEventListener("click", () => syncAllSources());
document.getElementById("inputApiKey").addEventListener("change", (e) => saveApiKey(e.target.value));
document.getElementById("inputApiKey").addEventListener("blur", (e) => saveApiKey(e.target.value));

document.getElementById("addVideoBtn").addEventListener("click", openAddModal);
document.getElementById("emptyAddBtn").addEventListener("click", openAddModal);
document.getElementById("cancelModalBtn").addEventListener("click", closeAddModal);
document.getElementById("saveVideoBtn").addEventListener("click", saveNewVideo);
document.getElementById("inputLink").addEventListener("input", handleLinkInput);

document.getElementById("searchInput").addEventListener("input", (e) => {
  searchTerm = e.target.value;
  renderLibrary();
});
initSortDropdown();
initGainControls();
document.getElementById("filterFavBtn").addEventListener("click", (e) => {
  filterFavoritesOnly = !filterFavoritesOnly;
  e.currentTarget.setAttribute("aria-pressed", String(filterFavoritesOnly));
  renderLibrary();
});
document.getElementById("libraryBtn").addEventListener("click", goToLibrary);

document.getElementById("backBtn").addEventListener("click", closePlayer);
document.getElementById("errorBackBtn").addEventListener("click", closePlayer);
document.getElementById("useFallbackBtn").addEventListener("click", useFallbackPlayer);
document.getElementById("playPauseBtn").addEventListener("click", () => { togglePlayPause(); showControls(); });
document.getElementById("rewindBtn").addEventListener("click", () => { skip(-10); showControls(); });
document.getElementById("forwardBtn").addEventListener("click", () => { skip(10); showControls(); });
document.getElementById("favBtnPlayer").addEventListener("click", () => {
  if (activeVideoId) toggleFavorite(activeVideoId);
});

document.querySelectorAll(".chip").forEach(chip => {
  chip.addEventListener("click", () => setSpeed(parseFloat(chip.dataset.speed)));
});

const scrubTrack = document.getElementById("scrubTrack");
scrubTrack.addEventListener("click", (e) => {
  const rect = scrubTrack.getBoundingClientRect();
  const pct = ((e.clientX - rect.left) / rect.width) * 100;
  seekToPercent(Math.min(100, Math.max(0, pct)));
  showControls();
});

document.getElementById("playerView").addEventListener("mousemove", showControls);
document.getElementById("playerView").addEventListener("click", (e) => {
  if (e.target.id === "videoEl") { togglePlayPause(); showControls(); }
});

// ---- Navegación con control remoto / teclado ----
document.addEventListener("keydown", (e) => {
  const playerOpen = !document.getElementById("playerView").hidden;
  const modalOpen = !document.getElementById("addModal").hidden ||
    !document.getElementById("sourcesModal").hidden;

  if (modalOpen) {
    if (e.key === "Escape") {
      document.getElementById("addModal").hidden = true;
      document.getElementById("sourcesModal").hidden = true;
    }
    return;
  }

  if (playerOpen) {
    showControls();
    switch (e.key) {
      case "Enter":
      case " ":
        togglePlayPause(); e.preventDefault(); break;
      case "ArrowLeft":
        skip(-10); e.preventDefault(); break;
      case "ArrowRight":
        skip(10); e.preventDefault(); break;
      case "ArrowUp":
        setSpeed(Math.min(2, (videoEl.playbackRate + 0.25))); e.preventDefault(); break;
      case "ArrowDown":
        setSpeed(Math.max(0.5, (videoEl.playbackRate - 0.25))); e.preventDefault(); break;
      case "Escape":
      case "Backspace":
        closePlayer(); e.preventDefault(); break;
      case "MediaPlayPause":
        togglePlayPause(); break;
      case "MediaPlay":
        videoEl.play(); break;
      case "MediaPause":
        videoEl.pause(); break;
      case "MediaTrackNext":
      case "MediaFastForward":
        skip(10); break;
      case "MediaTrackPrevious":
      case "MediaRewind":
        skip(-10); break;
    }
  }
});

// ============================================================
// PWA: SERVICE WORKER
// ============================================================
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("service-worker.js").catch(err => {
      console.warn("No se pudo registrar el service worker:", err);
    });
  });
}

// ---------- Arranque ----------
renderLibrary();

// Si ya hay API Key guardada, sincroniza las fuentes en silencio al abrir la app.
if (apiKey && sources.length > 0) {
  syncAllSources({ silent: true });
}
