/* =========================================================
   GBA Web – biblioteca + partidas guardadas + avance rápido
   Usa EmulatorJS (núcleo mGBA) desde su CDN.
   ========================================================= */

const CDN = 'https://cdn.emulatorjs.org/stable/data/';
const SLOTS = [
  { id: 0, nombre: 'Autoguardado', auto: true },
  { id: 1, nombre: 'Slot 1' },
  { id: 2, nombre: 'Slot 2' },
  { id: 3, nombre: 'Slot 3' },
];

/* ---------- Atajos al DOM ---------- */
const $ = (id) => document.getElementById(id);
const vistaBiblioteca = $('vista-biblioteca');
const vistaJuego = $('vista-juego');
const listaJuegos = $('lista-juegos');
const vacio = $('vacio');
const inputRom = $('rom');
const zonaDrop = $('zona-drop');
const contSlots = $('slots');
const btnFF = $('btn-ff');
const selFF = $('sel-ff');
const chkLigero = $('chk-ligero');
const selSalto = $('sel-salto');
const selZip = $('sel-zip');

// Recordar de qué consola son los archivos comprimidos
try {
  const z = localStorage.getItem('pokeemu-zip');
  if (z) selZip.value = z;
} catch (_) {}
selZip.addEventListener('change', () => {
  try { localStorage.setItem('pokeemu-zip', selZip.value); } catch (_) {}
});
const estadoHilos = $('estado-hilos');

/* Multihilo: solo disponible si el servidor envía las cabeceras COOP/COEP
   (ver servidor.js). Con hilos, el emulador reparte el trabajo entre varios
   núcleos del procesador y rinde mucho más. */
const hilosOk = window.crossOriginIsolated === true && typeof SharedArrayBuffer !== 'undefined';
if (estadoHilos) {
  estadoHilos.textContent = hilosOk
    ? '⚡ Multihilo activado'
    : 'Multihilo desactivado (opcional: agregá sw.js junto al index.html)';
  estadoHilos.classList.toggle('ok', hilosOk);
}

/* Opcional: si existe sw.js en la misma carpeta, un service worker agrega las
   cabeceras necesarias y la página se recarga una sola vez con multihilo.
   Si el archivo no está, todo sigue funcionando igual que antes. */
if (!hilosOk && 'serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker
    .register('sw.js')
    .then(() => navigator.serviceWorker.ready)
    .then(() => {
      let yaRecargo = false;
      try { yaRecargo = sessionStorage.getItem('coi-recargado') === '1'; } catch (_) {}
      if (!window.crossOriginIsolated && !yaRecargo) {
        try { sessionStorage.setItem('coi-recargado', '1'); } catch (_) {}
        location.reload();
      }
    })
    .catch(() => { /* sin sw.js: se sigue sin multihilo */ });
}

// Recordar la preferencia de rendimiento
try {
  const v = localStorage.getItem('gba-ligero');
  if (v !== null) chkLigero.checked = v === '1';
} catch (_) {}
try {
  const v = localStorage.getItem('gba-salto-v2');
  if (v !== null) selSalto.value = v;
} catch (_) {}
selSalto.addEventListener('change', () => {
  try { localStorage.setItem('gba-salto-v2', selSalto.value); } catch (_) {}
});
chkLigero.addEventListener('change', () => {
  try { localStorage.setItem('gba-ligero', chkLigero.checked ? '1' : '0'); } catch (_) {}
});

/* ---------- Estado ---------- */
let juegoActual = null;      // { id, nombre }
let emuListo = false;
let ffActivo = false;
const urlsTemporales = [];

/* =========================================================
   IndexedDB
   ========================================================= */
let dbPromesa = null;

function db() {
  if (!dbPromesa) {
    dbPromesa = new Promise((res, rej) => {
      const r = indexedDB.open('gba-web', 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        d.createObjectStore('roms', { keyPath: 'id' });
        d.createObjectStore('saves', { keyPath: 'key' });
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  return dbPromesa;
}

async function dbOp(store, modo, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(store, modo);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => res(req ? req.result : undefined);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });
}

const romsGuardar = (rom) => dbOp('roms', 'readwrite', (s) => s.put(rom));
const romsObtener = (id) => dbOp('roms', 'readonly', (s) => s.get(id));
const romsTodas = () => dbOp('roms', 'readonly', (s) => s.getAll());
const romsBorrar = (id) => dbOp('roms', 'readwrite', (s) => s.delete(id));

const saveGuardar = (obj) => dbOp('saves', 'readwrite', (s) => s.put(obj));
const saveObtener = (key) => dbOp('saves', 'readonly', (s) => s.get(key));
const saveBorrar = (key) => dbOp('saves', 'readwrite', (s) => s.delete(key));

/* =========================================================
   Utilidades
   ========================================================= */
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('visible');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('visible'), 2200);
}

const limpiarNombre = (n) => n.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ');
const tamano = (b) => (b / 1048576).toFixed(1) + ' MB';
const fecha = (ts) =>
  new Date(ts).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' });

function descargar(blob, nombre) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = nombre;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/* =========================================================
   Biblioteca
   ========================================================= */
/* Extensión → consola (los nombres coinciden con los núcleos de EmulatorJS) */
const SISTEMAS = {
  gb:  { sistema: 'gb',  etiqueta: 'GB'  },
  gbc: { sistema: 'gb',  etiqueta: 'GBC' },
  gba: { sistema: 'gba', etiqueta: 'GBA' },
  nds: { sistema: 'nds', etiqueta: 'DS'  },
  z64: { sistema: 'n64', etiqueta: 'N64' },
  n64: { sistema: 'n64', etiqueta: 'N64' },
  v64: { sistema: 'n64', etiqueta: 'N64' },
};
const ETIQUETA_SISTEMA = { gb: 'GB', gba: 'GBA', nds: 'DS', n64: 'N64' };

function detectarSistema(nombre) {
  const ext = (nombre.split('.').pop() || '').toLowerCase();
  if (SISTEMAS[ext]) return SISTEMAS[ext];
  if (ext === 'zip' || ext === '7z') {
    const sis = selZip.value;
    return { sistema: sis, etiqueta: ETIQUETA_SISTEMA[sis] || sis.toUpperCase() };
  }
  return null; // formato no soportado
}

async function agregarArchivos(files) {
  let n = 0;
  for (const f of files) {
    const info = detectarSistema(f.name);
    if (!info) continue;

    const id = `${f.name}-${f.size}`;
    await romsGuardar({
      id,
      sistema: info.sistema,
      etiqueta: info.etiqueta,
      nombre: limpiarNombre(f.name),
      archivo: f.name,
      size: f.size,
      blob: f,
      fecha: Date.now(),
    });
    n++;
  }
  if (n) toast(n === 1 ? 'Juego agregado' : `${n} juegos agregados`);
  else toast('Formato no soportado. Usá .gb .gbc .gba .nds .z64 .n64 .v64 .zip o .7z');
  renderBiblioteca();
}

/* Carátulas: se piden en el momento al servidor público de miniaturas de
   Libretro (no se guardan en el proyecto). Los nombres siguen la nomenclatura
   No-Intro, como los de tus archivos. Si no existe la imagen, se muestra el
   recuadro de color de siempre. */
const CARPETA_LIBRETRO = {
  gb: 'Nintendo - Game Boy',
  gbc: 'Nintendo - Game Boy Color',
  gba: 'Nintendo - Game Boy Advance',
  nds: 'Nintendo - Nintendo DS',
  n64: 'Nintendo - Nintendo 64',
};

function urlPortadaOnline(r) {
  const sis = r.sistema || 'gba';
  const clave = sis === 'gb' && r.etiqueta === 'GBC' ? 'gbc' : sis;
  const carpeta = CARPETA_LIBRETRO[clave];
  if (!carpeta || !r.archivo) return null;

  let nombre = r.archivo.replace(/\.[^.]+$/, '');   // sin extensión
  nombre = nombre.replace(/^\d{1,5}\s*-\s*/, '');    // quita prefijos tipo "4833 - "
  nombre = nombre.replace(/[&*\/:`<>?\\|]/g, '_');  // caracteres que Libretro reemplaza
  return `https://thumbnails.libretro.com/${encodeURIComponent(carpeta)}/Named_Boxarts/${encodeURIComponent(nombre)}.png`;
}

/* ---------- Búsqueda automática de carátulas ----------
   Se identifica el juego por su nombre (en español o inglés) y se busca la
   carátula en la lista pública de Libretro, eligiendo la mejor región
   (España > Europa > USA). Si no se puede leer la lista, se prueban nombres
   conocidos. El resultado se recuerda para no buscar de nuevo. */
const JUEGOS = [
  // [clave, regex sobre el nombre sin espacios ni símbolos, nombre en inglés para el plan B]
  ['firered',   /firered|rojofuego/,                        'Pokemon - FireRed Version'],
  ['leafgreen', /leafgreen|verdehoja/,                      'Pokemon - LeafGreen Version'],
  ['heartgold', /heartgold/,                                'Pokemon - HeartGold Version'],
  ['soulsilver',/soulsilver/,                               'Pokemon - SoulSilver Version'],
  ['platinum',  /platinum|platino/,                         'Pokemon - Platinum Version'],
  ['diamond',   /diamond|diamante/,                         'Pokemon - Diamond Version'],
  ['pearl',     /pearl|perla/,                              'Pokemon - Pearl Version'],
  ['black2',    /black2|negra2/,                            'Pokemon - Black Version 2'],
  ['white2',    /white2|blanca2/,                           'Pokemon - White Version 2'],
  ['black',     /black|negra/,                              'Pokemon - Black Version'],
  ['white',     /white|blanca/,                             'Pokemon - White Version'],
  ['emerald',   /emerald|esmeralda/,                        'Pokemon - Emerald Version'],
  ['ruby',      /ruby|rubi/,                                'Pokemon - Ruby Version'],
  ['sapphire',  /sapphire|zafiro/,                          'Pokemon - Sapphire Version'],
  ['crystal',   /crystal|cristal/,                          'Pokemon - Crystal Version'],
  ['gold',      /goldversion|edicionoro|pokemongold/,       'Pokemon - Gold Version'],
  ['silver',    /silverversion|edicionplata|pokemonsilver/, 'Pokemon - Silver Version'],
  ['yellow',    /yellow|amarilla/,                          'Pokemon - Yellow Version - Special Pikachu Edition'],
  ['red',       /redversion|edicionroja|pokemonred/,        'Pokemon - Red Version'],
  ['blue',      /blueversion|edicionazul|pokemonblue/,      'Pokemon - Blue Version'],
  ['stadium2',  /stadium2/,                                 'Pokemon Stadium 2'],
  ['stadium',   /stadium/,                                  'Pokemon Stadium'],
  ['snap',      /snap/,                                     'Pokemon Snap'],
  ['pinball',   /pinball/,                                  'Pokemon Pinball'],
  ['puzzle',    /puzzle/,                                   'Pokemon Puzzle League'],
];
// Cómo se reconoce cada juego dentro de los nombres de Libretro (inglés o español)
const BUSCAR_EN_LIBRETRO = {
  firered: /firered|rojofuego/, leafgreen: /leafgreen|verdehoja/,
  heartgold: /heartgold/, soulsilver: /soulsilver/,
  platinum: /platinum|platino/, diamond: /diamond|diamante/, pearl: /pearl|perla/,
  black2: /black2|negra2/, white2: /white2|blanca2/,
  black: /black(?!2)|negra(?!2)/, white: /white(?!2)|blanca(?!2)/,
  emerald: /emerald|esmeralda/, ruby: /ruby|rubi/, sapphire: /sapphire|zafiro/,
  crystal: /crystal|cristal/, gold: /goldversion|edicionoro/, silver: /silverversion|edicionplata/,
  yellow: /yellow|amarilla/, red: /redversion|edicionroja/, blue: /blueversion|edicionazul/,
  stadium2: /stadium2/, stadium: /stadium(?!2)/, snap: /snap/, pinball: /pinball/, puzzle: /puzzle/,
};

function sinTildes(t) { return t.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); }
function aplanar(t) { return sinTildes(t).toLowerCase().replace(/[^a-z0-9]/g, ''); }

function carpetasLibretro(r) {
  const sis = r.sistema || 'gba';
  if (sis === 'gb') return [CARPETA_LIBRETRO.gbc, CARPETA_LIBRETRO.gb];
  const c = CARPETA_LIBRETRO[sis];
  return c ? [c] : [];
}

/* Las carátulas de Libretro también están en GitHub (organización libretro-thumbnails).
   Desde ahí sí se puede leer la lista de archivos y cargar las imágenes. */
const listados = {};   // carpeta -> promesa con la lista de archivos (o null si no se pudo leer)

function repoDe(carpeta) { return carpeta.replace(/ /g, '_'); }

function listarCarpeta(carpeta) {
  if (!listados[carpeta]) {
    listados[carpeta] = (async () => {
      const repo = repoDe(carpeta);
      const claveCache = `lista-libretro:${repo}`;
      try {
        const c = JSON.parse(localStorage.getItem(claveCache) || 'null');
        if (c && Date.now() - c.t < 30 * 864e5 && c.lista.length) return c.lista;
      } catch (_) {}
      try {
        const api = `https://api.github.com/repos/libretro-thumbnails/${repo}/git/trees/`;
        const raiz = await (await fetch(api + 'master')).json();
        const dir = (raiz.tree || []).find((x) => x.path === 'Named_Boxarts');
        if (!dir) return null;
        const sub = await (await fetch(dir.url)).json();
        const lista = (sub.tree || [])
          .map((x) => x.path)
          .filter((n) => /\.png$/i.test(n) && /pokemon/i.test(aplanar(n)));
        if (!lista.length) return null;
        try { localStorage.setItem(claveCache, JSON.stringify({ t: Date.now(), lista })); } catch (_) {}
        return lista;
      } catch (_) { return null; }
    })();
  }
  return listados[carpeta];
}

function puntuar(nombreArchivo) {
  if (/\((Beta|Proto|Demo|Sample|Kiosk|Unl)/i.test(nombreArchivo)) return -100;
  let p = 0;
  if (/\(Spain/i.test(nombreArchivo)) p += 30;
  else if (/\(Europe/i.test(nombreArchivo)) p += 20;
  else if (/\(USA/i.test(nombreArchivo)) p += 10;
  if (/Rev/i.test(nombreArchivo)) p += 1;
  return p;
}

function urlLibretro(carpeta, archivo) {
  return `https://raw.githubusercontent.com/libretro-thumbnails/${repoDe(carpeta)}/master/Named_Boxarts/${encodeURIComponent(archivo)}`;
}

function probarImagen(url) {
  return new Promise((ok) => {
    const i = new Image();
    i.referrerPolicy = 'no-referrer';
    i.onload = () => ok(true);
    i.onerror = () => ok(false);
    i.src = url;
  });
}

async function buscarPortada(r) {
  const clave = `portada3-url:${r.id}`;
  try {
    const g = localStorage.getItem(clave);
    if (g && g !== '-') return g;
    if (g === '-' && Date.now() - Number(localStorage.getItem(clave + ':t') || 0) < 864e5) return null;
  } catch (_) {}

  const carpetas = carpetasLibretro(r);
  const plano = aplanar(r.nombre || r.archivo || '');
  const juego = JUEGOS.find(([, re]) => re.test(plano));
  const nombreExacto = (r.archivo || '').replace(/\.[^.]+$/, '').replace(/^\d{1,5}\s*-\s*/, '').trim();
  let encontrada = null;

  // 2) Lista de Libretro: se elige la mejor carátula de ese juego
  if (!encontrada) {
    const re = juego ? BUSCAR_EN_LIBRETRO[juego[0]] : null;
    const exacto = nombreExacto.replace(/[&*\/:`<>?\\|]/g, '_') + '.png';
    let mejor = null;
    for (const c of carpetas) {
      const lista = await listarCarpeta(c);
      if (!lista) continue;
      for (const f of lista) {
        if (f === exacto) { mejor = { c, f, p: 1000 }; break; }
        const n = aplanar(f.replace(/\.png$/i, ''));
        if (!re || !n.includes('pokemon') || !re.test(n)) continue;
        const p = puntuar(f);
        if (p > -100 && (!mejor || p > mejor.p)) mejor = { c, f, p };
      }
    }
    if (mejor) encontrada = urlLibretro(mejor.c, mejor.f);
  }

  // 3) Plan B (si la lista no se pudo leer): nombres conocidos en inglés
  if (!encontrada && juego) {
    const regiones = [' (Spain)', ' (Europe)', ' (USA, Europe)', ' (USA)', ' (USA, Europe) (Rev 1)'];
    const extras = ['', ' (SGB Enhanced)', ' (SGB Enhanced) (GB Compatible)', ' (CGB+SGB Enhanced)'];
    busqueda:
    for (const c of carpetas) {
      for (const reg of regiones) {
        for (const ex of extras) {
          const u = urlLibretro(c, `${juego[2]}${reg}${ex}.png`);
          if (await probarImagen(u)) { encontrada = u; break busqueda; }
        }
      }
    }
  }

  try {
    localStorage.setItem(clave, encontrada || '-');
    if (!encontrada) localStorage.setItem(clave + ':t', String(Date.now()));
  } catch (_) {}
  return encontrada;
}

async function renderBiblioteca() {
  const roms = (await romsTodas()).sort((a, b) => b.fecha - a.fecha);
  listaJuegos.innerHTML = '';
  vacio.classList.toggle('oculto', roms.length > 0);

  for (const r of roms) {
    const card = document.createElement('div');
    card.className = 'juego';
    const sis = r.sistema || 'gba';
    card.innerHTML = `
      <div class="cart ${sis}">
        <img class="portada" alt="" referrerpolicy="no-referrer" hidden>
        <span class="etiqueta">${r.etiqueta || ETIQUETA_SISTEMA[sis] || sis.toUpperCase()}</span>
        <button class="cambiar-foto" title="Elegir una foto propia para este juego">🖼</button>
      </div>
      <div>
        <h3></h3>
        <small>${tamano(r.size)}</small>
      </div>
      <div class="acciones">
        <button class="btn grande" data-jugar>Jugar</button>
        <button class="btn peligro" data-borrar title="Quitar de la biblioteca">✕</button>
      </div>`;
    card.querySelector('h3').textContent = r.nombre;

    // --- Portada: foto propia (si la hay) o carátula online; si falla, queda el recuadro de color ---
    const img = card.querySelector('.portada');
    const propia = await saveObtener(`portada:${r.id}`);
    const mostrar = (src) => {
      img.onload = async () => {
        try { await img.decode(); } catch (_) {}
        img.hidden = false;
        card.classList.add('con-foto');
        // Chrome sin GPU a veces no dibuja la imagen hasta que algo fuerza un repintado
        const cart = card.querySelector('.cart');
        cart.style.display = 'none';
        void cart.offsetHeight;
        cart.style.display = '';
        requestAnimationFrame(() => requestAnimationFrame(() => {
          img.style.transform = 'translateZ(0)';
        }));
      };
      img.onerror = () => img.remove();
      img.src = src;
    };
    if (propia && propia.blob) {
      const src = URL.createObjectURL(propia.blob);
      urlsTemporales.push(src);
      mostrar(src);
    } else {
      // Búsqueda en segundo plano: no frena la carga de la biblioteca
      buscarPortada(r).then((src) => (src ? mostrar(src) : img.remove()));
    }

    // --- Botón para elegir una foto propia ---
    const inputFoto = document.createElement('input');
    inputFoto.type = 'file';
    inputFoto.accept = 'image/*';
    inputFoto.hidden = true;
    card.appendChild(inputFoto);
    card.querySelector('.cambiar-foto').onclick = () => inputFoto.click();
    inputFoto.onchange = async () => {
      const f = inputFoto.files[0];
      if (!f) return;
      try {
        const bmp = await createImageBitmap(f);
        const blob = await reducir(bmp, 400);
        await saveGuardar({ key: `portada:${r.id}`, blob });
        toast('Foto actualizada');
        renderBiblioteca();
      } catch (err) {
        console.error(err);
        toast('No se pudo usar esa imagen');
      }
    };

    card.querySelector('[data-jugar]').onclick = () => jugar(r.id);
    card.querySelector('[data-borrar]').onclick = async () => {
      if (!confirm(`¿Quitar "${r.nombre}" de la biblioteca?\nSus partidas guardadas también se borran.`)) return;
      await romsBorrar(r.id);
      for (const s of SLOTS) await saveBorrar(`${r.id}:${s.id}`);
      await saveBorrar(`portada:${r.id}`);
      try { localStorage.removeItem(`portada3-url:${r.id}`); } catch (_) {}
      renderBiblioteca();
    };
    listaJuegos.appendChild(card);
  }
}

inputRom.addEventListener('change', (e) => {
  agregarArchivos([...e.target.files]);
  inputRom.value = '';
});

['dragenter', 'dragover'].forEach((ev) =>
  zonaDrop.addEventListener(ev, (e) => {
    e.preventDefault();
    zonaDrop.classList.add('activo');
  })
);
['dragleave', 'drop'].forEach((ev) =>
  zonaDrop.addEventListener(ev, (e) => {
    e.preventDefault();
    zonaDrop.classList.remove('activo');
  })
);
zonaDrop.addEventListener('drop', (e) => agregarArchivos([...e.dataTransfer.files]));

/* =========================================================
   Arrancar el emulador
   ========================================================= */
async function jugar(id) {
  const rom = await romsObtener(id);
  if (!rom) return toast('No se encontró el juego');

  const sistema = rom.sistema || 'gba';
  juegoActual = {
    id: rom.id,
    nombre: rom.nombre,
    sistema,
    etiqueta: rom.etiqueta || ETIQUETA_SISTEMA[sistema] || sistema.toUpperCase(),
  };
  $('titulo-juego').textContent = rom.nombre;
  vistaBiblioteca.classList.add('oculto');
  vistaJuego.classList.remove('oculto');
  document.body.classList.add('jugando');
  $('pantalla').dataset.sistema = sistema;
  $('pantalla').classList.toggle('ds', sistema === 'nds');
  $('nota-ds').classList.toggle('oculto', sistema !== 'nds');
  renderSlots();

  const url = URL.createObjectURL(rom.blob);
  urlsTemporales.push(url);

  // --- Configuración de EmulatorJS ---
  window.EJS_player = '#game';
  window.EJS_core = sistema;   // 'gb', 'gba', 'nds' o 'n64'
  window.EJS_gameName = rom.nombre;
  window.EJS_gameUrl = url;
  window.EJS_pathtodata = CDN;
  window.EJS_startOnLoaded = true;
  // Con ?sinhilos en la dirección se fuerza el modo de un solo hilo (útil si un juego no arranca)
  window.EJS_threads = hilosOk && !new URLSearchParams(location.search).has('sinhilos');
  if (new URLSearchParams(location.search).has('debug')) window.EJS_DEBUG_XX = true;
  window.EJS_color = '#7c5cff';
  window.EJS_defaultOptions = opcionesEmulador(chkLigero.checked, sistema);
  // Solo dejamos los botones que no duplican los nuestros
  window.EJS_Buttons = {
    saveSavFiles: true,
    loadSavFiles: true,
    playPause: true,
    restart: true,
    mute: true,
    settings: true,
    fullscreen: false,
    saveState: false,
    loadState: false,
    quickSave: false,
    quickLoad: false,
    screenRecord: false,
    gamepad: true,
    cheat: false,
    netplay: false,
    exitEmulation: false,
    cacheManager: false,
  };
  window.EJS_onGameStart = () => {
    emuListo = true;
    toast('Juego listo');
  };

  const s = document.createElement('script');
  s.src = CDN + 'loader.js';
  s.onerror = () =>
    toast('No se pudo cargar el emulador. Revisá tu conexión o el bloqueador de anuncios.');
  document.body.appendChild(s);
}

/* Opciones del emulador. En el modo rendimiento se apagan filtros y se
   permite saltar cuadros automáticamente cuando la CPU no llega a 60 FPS. */
function opcionesEmulador(ligero, sistema) {
  const base = { shader: 'disabled' };
  // Las opciones de salto de cuadros de abajo son del núcleo de GBA (mGBA)
  if (!ligero || sistema !== 'gba') return base;
  let salto = { mgba_frameskip: 'disabled' };
  if (selSalto.value === 'auto') salto = { mgba_frameskip: 'auto' };
  else if (selSalto.value === '1' || selSalto.value === '2')
    salto = { mgba_frameskip: 'fixed_interval', mgba_frameskip_interval: selSalto.value };
  return {
    ...base,
    ...salto,
    mgba_audio_low_pass_filter: 'disabled',
    mgba_interframe_blending: 'disabled',
    mgba_skip_bios: 'ON',
  };
}

const gm = () => window.EJS_emulator && window.EJS_emulator.gameManager;

/* =========================================================
   Avance rápido
   ========================================================= */
function setFF(activo) {
  const g = gm();
  if (!g || !emuListo) return;
  ffActivo = activo;
  const e = window.EJS_emulator;
  const ratio = parseFloat(selFF.value);
  try {
    if (typeof g.setFastForwardRatio === 'function' && typeof g.toggleFastForward === 'function') {
      g.setFastForwardRatio(ratio);
      g.toggleFastForward(activo ? 1 : 0);
    } else if (e && typeof e.changeSettingOption === 'function') {
      e.changeSettingOption('ff-ratio', ratio.toFixed(1));
      e.changeSettingOption('fastForward', activo ? 'enabled' : 'disabled');
    } else {
      toast('Esta versión del emulador no permite avance rápido');
    }
    console.log(`[avance rápido] ${activo ? 'ON' : 'OFF'} · ${ratio}x`);
  } catch (err) {
    console.warn('Avance rápido no disponible:', err);
    toast('No se pudo activar el avance rápido');
  }
  btnFF.classList.toggle('activo', activo);
  btnFF.textContent = activo ? `⏩ ${selFF.value}x activo` : '⏩ Avance rápido';
}

btnFF.addEventListener('click', () => setFF(!ffActivo));
selFF.addEventListener('change', () => ffActivo && setFF(true));

/* =========================================================
   Partidas guardadas (slots)
   ========================================================= */
/* Pausar el emulador mientras se lee o escribe un estado evita copias a medias
   o desactualizadas mientras el juego sigue avanzando. */
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

function pausarEmu() {
  const e = window.EJS_emulator;
  try {
    if (e && !e.paused) {
      e.pause(true);
      return true;
    }
  } catch (err) {
    console.warn('No se pudo pausar:', err);
  }
  return false;
}

function reanudarEmu() {
  try { window.EJS_emulator.play(true); } catch (err) { console.warn('No se pudo reanudar:', err); }
}

// Huella corta del estado: sirve para comprobar que cada guardado es distinto
function firmaEstado(bytes) {
  let h = 2166136261;
  for (let i = 0; i < bytes.length; i += 7) {
    h ^= bytes[i];
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

let guardando = false;

// Espera una promesa, pero no más de `ms` milisegundos (devuelve null si se pasa)
const conTiempo = (p, ms) =>
  Promise.race([Promise.resolve(p), new Promise((r) => setTimeout(() => r(null), ms))]);

/* ---------- Captura de pantalla para la miniatura del slot ---------- */
let metodoCapturaOk = null; // se recuerda el método que funcionó

async function aBitmap(x) {
  if (!x) return null;
  if (x instanceof HTMLCanvasElement) return createImageBitmap(x);
  if (x instanceof Uint8Array || x instanceof ArrayBuffer) {
    return createImageBitmap(new Blob([x], { type: 'image/png' }));
  }
  return createImageBitmap(x); // Blob
}

// Descarta imágenes totalmente negras (un canvas WebGL leído fuera de tiempo)
function bitmapValido(bmp) {
  const c = document.createElement('canvas');
  c.width = 24;
  c.height = 24;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0, 24, 24);
  const d = ctx.getImageData(0, 0, 24, 24).data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i] > 14 || d[i + 1] > 14 || d[i + 2] > 14) return true;
  }
  return false;
}

// Reduce la imagen para que ocupe poco espacio
function reducir(bmp, anchoMax = 320) {
  const esc = Math.min(1, anchoMax / bmp.width);
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(bmp.width * esc));
  c.height = Math.max(1, Math.round(bmp.height * esc));
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise((res) => c.toBlob((b) => res(b), 'image/jpeg', 0.82));
}

async function capturarPantalla() {
  const e = window.EJS_emulator;
  const g = gm();
  const metodos = {
    retroarch: () => new Promise((res) => e.screenshot((b) => res(b), 'retroarch')),
    gameManager: () => g.screenshot(),
    canvasEJS: () => new Promise((res) => e.screenshot((b) => res(b), 'canvas')),
    canvas: () => document.querySelector('#game canvas'),
  };
  const orden = Object.keys(metodos);
  if (metodoCapturaOk) orden.sort((a, b) => (a === metodoCapturaOk ? -1 : b === metodoCapturaOk ? 1 : 0));

  for (const nombre of orden) {
    try {
      const crudo = await conTiempo(metodos[nombre](), 900);
      const bmp = await aBitmap(crudo);
      if (bmp && bmp.width > 8 && bitmapValido(bmp)) {
        metodoCapturaOk = nombre;
        console.log(`[captura] método que funcionó: ${nombre}`);
        return await reducir(bmp);
      }
    } catch (err) {
      console.log(`[captura] ${nombre} no funcionó:`, err && err.message);
    }
  }
  console.warn('[captura] ningún método devolvió una imagen');
  return null;
}

async function guardarSlot(slot, silencioso = false) {
  const g = gm();
  if (!g || !emuListo || !juegoActual || guardando) return;
  guardando = true;
  const key = `${juegoActual.id}:${slot}`;
  let estabaCorriendo = false;

  try {
    // 1) La captura se toma ANTES de pausar: el emulador tiene que estar
    //    corriendo para poder entregar la imagen del cuadro actual.
    let captura = null;
    if (!silencioso) captura = await conTiempo(capturarPantalla(), 3000);

    // 2) Se pausa y se lee el estado
    estabaCorriendo = pausarEmu();
    await esperar(80); // deja terminar el cuadro en curso
    const crudo = g.getState();
    if (!crudo || !crudo.length) throw new Error('El emulador devolvió un estado vacío');

    // Se copia el estado: el buffer original pertenece al emulador y puede cambiar
    const copia = new Uint8Array(crudo);
    const firma = firmaEstado(copia);
    console.log(`[guardado] slot ${slot} · ${copia.length} bytes · huella ${firma}`);

    await saveGuardar({
      key,
      romId: juegoActual.id,
      slot,
      estado: new Blob([copia]),
      firma,
      captura,
      fecha: Date.now(),
    });
    renderSlots();
    if (!silencioso) toast(slot === 1 ? 'Guardado rápido listo' : 'Partida guardada');
  } catch (err) {
    console.error('Error al guardar:', err);
    if (!silencioso) toast('No se pudo guardar (mirá la consola F12)');
  } finally {
    if (estabaCorriendo) reanudarEmu();
    guardando = false;
  }
}

async function cargarSlot(slot) {
  const g = gm();
  if (!g || !emuListo || !juegoActual) return;
  const reg = await saveObtener(`${juegoActual.id}:${slot}`);
  if (!reg) return toast('Ese slot está vacío');
  const estabaCorriendo = pausarEmu();
  try {
    const buf = await reg.estado.arrayBuffer();
    await esperar(80);
    g.loadState(new Uint8Array(buf));
    console.log(`[carga] slot ${slot} · huella ${reg.firma || '?'}`);
    toast('Partida cargada');
  } catch (err) {
    console.error(err);
    toast('No se pudo cargar');
  } finally {
    if (estabaCorriendo) reanudarEmu();
  }
}

async function exportarSlot(slot) {
  const reg = await saveObtener(`${juegoActual.id}:${slot}`);
  if (!reg) return toast('Ese slot está vacío');
  descargar(reg.estado, `${juegoActual.nombre} - slot${slot}.state`);
}

async function borrarSlot(slot) {
  await saveBorrar(`${juegoActual.id}:${slot}`);
  renderSlots();
}

async function renderSlots() {
  if (!juegoActual) return;
  contSlots.innerHTML = '';
  contSlots.dataset.sistema = juegoActual.sistema;

  for (const s of SLOTS) {
    const reg = await saveObtener(`${juegoActual.id}:${s.id}`);
    const el = document.createElement('div');
    el.className = 'slot';

    let miniHTML = '<div class="mini vacio-slot">Vacío</div>';
    if (reg && reg.captura) {
      const u = URL.createObjectURL(reg.captura);
      urlsTemporales.push(u);
      miniHTML = `<div class="mini"><img src="${u}" alt=""></div>`;
    } else if (reg) {
      miniHTML = `<div class="mini ph ${juegoActual.sistema}">${juegoActual.etiqueta}</div>`;
    }

    el.innerHTML = `
      <div class="slot-top">
        ${miniHTML}
        <div class="info">
          <b>${s.nombre}</b>
          <small>${reg ? fecha(reg.fecha) : 'Sin datos'}</small>
        </div>
      </div>
      <div class="botones">
        ${s.auto ? '' : '<button class="btn" data-g>Guardar</button>'}
        <button class="btn sec" data-c ${reg ? '' : 'disabled'}>Cargar</button>
        <button class="btn sec" data-e ${reg ? '' : 'disabled'} title="Descargar archivo .state">⬇</button>
        <button class="btn peligro" data-b ${reg ? '' : 'disabled'} title="Borrar">✕</button>
      </div>`;

    const q = (sel) => el.querySelector(sel);
    if (q('[data-g]')) q('[data-g]').onclick = () => guardarSlot(s.id);
    q('[data-c]').onclick = () => cargarSlot(s.id);
    q('[data-e]').onclick = () => exportarSlot(s.id);
    q('[data-b]').onclick = () => borrarSlot(s.id);
    contSlots.appendChild(el);
  }
}

/* ---------- Importar un .state desde el disco ---------- */
$('btn-importar').addEventListener('click', () => $('archivo-estado').click());
$('archivo-estado').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f || !gm() || !emuListo) return;
  const estabaCorriendo = pausarEmu();
  try {
    const datos = new Uint8Array(await f.arrayBuffer());
    await esperar(80);
    gm().loadState(datos);
    console.log(`[importar] ${datos.length} bytes · huella ${firmaEstado(datos)}`);
    toast('Estado importado');
  } catch (err) {
    console.error(err);
    toast('Archivo de estado inválido');
  } finally {
    if (estabaCorriendo) reanudarEmu();
  }
});

/* =========================================================
   Teclado y otros
   ========================================================= */
document.addEventListener('keydown', (e) => {
  if (vistaJuego.classList.contains('oculto')) return;

  if (e.key === 'Tab') {
    e.preventDefault();
    if (!e.repeat && !ffActivo) setFF(true);
  } else if (e.key === 'F5') {
    e.preventDefault();
    if (!e.repeat) guardarSlot(1);
  } else if (e.key === 'F7') {
    e.preventDefault();
    if (!e.repeat) cargarSlot(1);
  }
});

document.addEventListener('keyup', (e) => {
  if (e.key === 'Tab' && ffActivo) setFF(false);
});

// Autoguardado al cambiar de pestaña o cerrar
document.addEventListener('visibilitychange', () => {
  if (document.hidden && emuListo) guardarSlot(0, true);
});

$('btn-fullscreen').addEventListener('click', () => {
  const el = $('pantalla');
  if (document.fullscreenElement) document.exitFullscreen();
  else if (el.requestFullscreen) el.requestFullscreen();
});

$('btn-volver').addEventListener('click', async () => {
  if (emuListo) await guardarSlot(0, true);
  // EmulatorJS no se reinicia limpio: recargamos para liberar memoria
  location.reload();
});

/* ---------- Inicio ---------- */
renderBiblioteca();