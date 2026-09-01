'use strict';

/**
 * pdfGenerator.js — Premium PDF consultation report generator
 * Uses Puppeteer to render HTML template → PDF
 *
 * Usage:
 *   const { generatePremiumPDF } = require('./pdfGenerator');
 *   const pdfPath = await generatePremiumPDF(data, calculationId);
 */

const path       = require('path');
const fs         = require('fs');
const puppeteer  = require('puppeteer-core');
const chromium   = require('@sparticuz/chromium');

// Paths
//
// compat-report.html follows the page architecture of the ASTREA natal report
// — A4 pages, topbar with a section tag, one idea per spread, a gold "key
// message" closing every section — repainted in this funnel's violet palette.
const TEMPLATE_PATH  = path.join(__dirname, '..', 'templates', 'compat-report.html');
const REPORTS_DIR    = path.join(__dirname, '..', 'storage', 'reports');
const FONTS_PATH     = path.join(__dirname, '..', 'templates', 'fonts-embedded.css');

/**
 * The report's typefaces, base64 into the document.
 *
 * Read once at startup, not per report: it is ~380 KB of text and every order
 * would otherwise re-read it off disk. Missing file is survivable — the report
 * then prints in fallback faces instead of not printing at all.
 */
const EMBEDDED_FONTS = (function () {
  try {
    return fs.readFileSync(FONTS_PATH, 'utf8');
  } catch (err) {
    console.warn('[pdfGenerator] fonts-embedded.css missing — report will use fallback faces');
    return '';
  }
}());

/** How long the webfonts may hold up a report before it renders without them. */
const FONT_GRACE_MS  = 8000;

/** Printing the pages is the slow step; the Puppeteer default of 30s cut it off. */
const PDF_PRINT_TIMEOUT_MS = 120000;

// Ensure storage directory exists
if (!fs.existsSync(REPORTS_DIR)) {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
}

// ── Archetype labels ────────────────────────────────────────────────────────
const ARCH_LABELS = {
  1:'Iniziatore', 2:'Intuito', 3:'Creativo', 4:'Costruttore', 5:'Avventuriero',
  6:'Armonizzatore', 7:'Ricercatore', 8:'Potere', 9:'Umanitario', 10:'Completamento',
  11:'Illuminato', 12:'Sacrificio', 13:'Trasformazione', 14:'Adattamento',
  15:'Abbondanza', 16:'Risveglio', 17:'Stella', 18:'Illusione', 19:'Sole',
  20:'Giudizio', 21:'Mondo', 22:'Mastro Costruttore',
};
function archLabel(n) {
  return n ? (ARCH_LABELS[n] ? n + ' · ' + ARCH_LABELS[n] : String(n)) : '—';
}

// ── HTML escape ──────────────────────────────────────────────────────────────
function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Rich text formatter (first sentence bold, em-dash italics) ───────────────
function formatParagraph(text) {
  const safe     = esc(text);
  const boldEnd  = safe.search(/[.!?]\s+[A-Z\u00C0-\u024F]/);
  let formatted;
  if (boldEnd > 0 && boldEnd < safe.length * 0.65) {
    formatted = '<strong>' + safe.slice(0, boldEnd + 1) + '</strong>' + safe.slice(boldEnd + 1);
  } else {
    formatted = safe;
  }
  formatted = formatted.replace(/—\s([^—]+?)\s—/g, '— <em>$1</em> —');
  formatted = formatted.replace(/«([^»]+)»/g, '«<em>$1</em>»');
  return formatted;
}

function sectionHtml(text) {
  if (!text) { return '<p class="body c-m">—</p>'; }
  return String(text).split(/\n\n+/).map(function (para) {
    para = para.trim();
    return para ? '<p class="body">' + formatParagraph(para) + '</p>' : '';
  }).filter(Boolean).join('');
}

// ── Exercises ────────────────────────────────────────────────────────────────

/**
 * The exercise written for a given section, if the reading carries one.
 * @param {object} consultation
 * @param {string} sectionKey
 * @returns {{titolo: string, durata: string, testo: string}|null}
 */
function exerciseFor(consultation, sectionKey) {
  const list = (consultation && consultation.esercizi) || [];
  return list.find(function (e) { return e && e.sezione === sectionKey; }) || null;
}

/**
 * The gold box that closes a section with something to do tonight.
 * @param {{titolo: string, durata: string, testo: string}|null} exercise
 * @returns {string}
 */
function exerciseBoxHtml(exercise) {
  if (!exercise || !exercise.testo) { return ''; }
  return `
      <div class="key-msg">
        <div class="km-title">
          <span>&#10022; Da fare insieme</span>
          ${exercise.durata ? '<span class="km-time">' + esc(exercise.durata) + '</span>' : ''}
        </div>
        <div class="km-name">${esc(exercise.titolo)}</div>
        <div class="km-text">${esc(exercise.testo)}</div>
      </div>`;
}


/**
 * How much of the cover ring stays empty.
 * The circle has r=100, so its circumference is 2π·100 ≈ 628.
 *
 * @param {number} score
 * @returns {number} stroke-dashoffset
 */
function ringOffset(score) {
  const s = Math.min(100, Math.max(0, parseInt(score, 10) || 70));
  return Math.round(628 * (1 - s / 100));
}

// ── Dimensions ───────────────────────────────────────────────────────────────

/**
 * The four axes the engine calculates. Their names depend on who the two people
 * are: the same measurement is "Intimità" between partners and "Vicinanza"
 * between a parent and a child.
 */
const DIMENSION_KEYS = ['anima', 'karma', 'intimita', 'finanze'];

const DIMENSION_LABELS = {
  coppia:   { anima: 'Anima',  karma: 'Karma',    intimita: 'Intimità',  finanze: 'Finanze'   },
  famiglia: { anima: 'Legame', karma: 'Eredità',  intimita: 'Vicinanza', finanze: 'Autonomia' },
};

/** What the report calls itself, and what the ring measures. */
const REPORT_KIND = {
  coppia:   { kind: 'Compatibilità di Coppia', ring: 'compatibilità' },
  famiglia: { kind: 'Genitori e Figli',        ring: 'sintonia'      },
};

/**
 * Reads the dimensions off the stored calculation.
 *
 * Returns null for an order placed before the engine produced them. Everything
 * downstream then omits the bars rather than printing invented percentages.
 *
 * @param {object} compat
 * @returns {Object<string, number>|null}
 */
function readDimensions(compat) {
  const d = compat && compat.dimensions;
  if (!d) { return null; }
  const out = {};
  for (const key of DIMENSION_KEYS) {
    const v = parseInt(d[key], 10);
    if (!v) { return null; }
    out[key] = Math.min(100, Math.max(0, v));
  }
  return out;
}

/**
 * The four bars on the cover.
 * @param {Object<string, number>|null} dims
 * @param {string} mode
 * @returns {string} empty when there is nothing honest to show
 */
function coverBarsHtml(dims, mode) {
  const labels = DIMENSION_LABELS[mode] || DIMENSION_LABELS.coppia;

  if (!dims) {
    return `<div class="cap" style="line-height:1.7">La ripartizione per aree è disponibile
      per le analisi più recenti. Il punteggio complessivo di questa lettura resta valido.</div>`;
  }

  return DIMENSION_KEYS.map(function (key) {
    return `
          <div class="ebar-row">
            <div class="ebar-label">${labels[key]}</div>
            <div class="ebar-track"><div class="ebar-fill" style="width:${dims[key]}%"></div></div>
            <div class="ebar-pct">${dims[key]}%</div>
          </div>`;
  }).join('');
}

/**
 * The couple archetype, stated once on the cover as the thesis of the reading.
 * @param {object} compat
 * @returns {string}
 */
function unionCardHtml(compat) {
  const num = parseInt(compat.compatibilityArchetype, 10);
  if (!num) { return ''; }

  return `
    <div class="card card-l" style="margin-top:30px;text-align:center">
      <div class="cap" style="letter-spacing:2.5px;text-transform:uppercase;font-weight:700;margin-bottom:8px">Archetipo dell'unione</div>
      <div class="h3 gl">${esc(archLabel(num))}</div>
    </div>`;
}

// ── Whole pages built here so they can be left out entirely ──────────────────

/**
 * One page per idea, in the order somebody reads them.
 *
 * `keys` are the consultation sections that go on that page; the tag colour
 * rotates so a reader flipping through sees where they are without reading.
 */
const SECTION_PAGES = [
  { tag: 'tag-a', tagText: 'Panorama',   title: 'Il quadro',        sub: 'Da dove parte tutto',            keys: ['panorama'] },
  { tag: 'tag-l', tagText: 'Ritratti',   title: 'Chi siete',        sub: 'Uno di fronte all\'altro',       keys: ['partner1', 'partner2'] },
  { tag: 'tag-a', tagText: 'Insieme',    title: 'Il campo',         sub: 'Quello che nasce fra voi due',   keys: ['couple'] },
  { tag: 'tag-l', tagText: 'Profondità', title: 'Anima e karma',    sub: 'Il legame sotto la superficie',  keys: ['anima', 'karma'] },
  { tag: 'tag-a', tagText: 'Quotidiano', title: 'Vicinanza e mezzi', sub: 'Come si vive giorno per giorno', keys: ['intimita', 'finanze'] },
  // Fiamme Gemelle. A parent-and-child reading never carries these keys, and
  // the loop below skips any page whose sections are all missing — so these
  // four cost that funnel nothing.
  { tag: 'tag-l', tagText: 'Fiamme',     title: 'Le due fiamme',    sub: 'Chi cerca e chi si ritira',      keys: ['fiamma1', 'fiamma2'] },
  { tag: 'tag-a', tagText: 'Il legame',  title: 'Il vostro legame', sub: 'Perché proprio voi due',         keys: ['unione'] },
  { tag: 'tag-g', tagText: 'Futuro',     title: 'Il potenziale',    sub: 'Dove può arrivare',              keys: ['potentiale'] },
  { tag: 'tag-g', tagText: 'Passi',      title: 'Il riavvicinamento', sub: 'Cosa fare quando si riaccende', keys: ['passi'] },
  { tag: 'tag-g', tagText: 'Piano',      title: 'Il consiglio',     sub: 'Cosa fare, in quest\'ordine',    keys: ['consiglio'] },
];

/** Italian titles for the sections, used above each block and on the exercises page. */
const SECTION_TITLES = {
  panorama:   'Panorama',
  partner1:   'Il primo ritratto',
  partner2:   'Il secondo ritratto',
  couple:     'Il campo condiviso',
  anima:      'Anima',
  karma:      'Karma',
  intimita:   'Vicinanza',
  finanze:    'Mezzi e autonomia',
  potentiale: 'Potenziale',
  fiamma1:    'La prima fiamma',
  fiamma2:    'La seconda fiamma',
  unione:     'Il legame',
  passi:      'Il riavvicinamento',
  consiglio:  'Consiglio finale',
};

/**
 * Page shell: background, blobs, topbar, content, footer.
 *
 * @param {object} opts {tag, tagText, kind, pageNo, body}
 * @returns {string}
 */
function pageShell(opts) {
  return `
<div class="page">
  <div class="page-bg"></div>
  <div class="blob" style="width:420px;height:420px;background:radial-gradient(circle,rgba(111,77,255,0.13) 0%,transparent 70%);top:-100px;right:-90px"></div>
  <div class="blob" style="width:300px;height:300px;background:radial-gradient(circle,rgba(255,141,232,0.08) 0%,transparent 70%);bottom:-60px;left:-60px"></div>
  <div class="blob" style="width:210px;height:210px;background:radial-gradient(circle,rgba(232,201,106,0.06) 0%,transparent 70%);top:46%;left:16%"></div>

  <div class="pg">
    <div class="topbar">
      <div class="logo-w"><span class="logo-glyph">&#10022;</span><span class="logo-t">LIGNAGGIO</span></div>
      <div class="tag ${opts.tag}">${esc(opts.tagText)}</div>
    </div>

${opts.body}

    <div class="pf">
      <div class="cap">${esc(opts.kind)}${opts.names ? ' · ' + esc(opts.names) : ''}</div>
      <div class="cap">${opts.pageNo}</div>
    </div>
  </div>
</div>`;
}

/**
 * Every content page, each section closing on its exercise.
 *
 * @param {object} consultation
 * @param {object|null} dims
 * @param {string} mode
 * @param {string} names
 * @returns {{html: string, nextPage: number}}
 */
function sectionPagesHtml(consultation, dims, mode, names) {
  const labels = DIMENSION_LABELS[mode] || DIMENSION_LABELS.coppia;
  const kind   = (REPORT_KIND[mode] || REPORT_KIND.coppia).kind;

  let pageNo = 2;
  const pages = [];

  for (const page of SECTION_PAGES) {
    // A page whose sections are all missing is not printed at all.
    const present = page.keys.filter(function (k) { return consultation[k]; });
    if (present.length === 0) { continue; }

    const blocks = present.map(function (key, i) {
      const pct = dims && labels[key]
        ? `<span class="c-a w7" style="font-family:'Sora',sans-serif;font-size:17px">${dims[key]}%</span>`
        : '';

      // The first section keeps the page title; a second one gets its own
      // heading so the two never read as one long text.
      const heading = i === 0 ? '' : `
      <div style="margin-top:26px">
        <div class="div da"></div>
        <div class="h4" style="display:flex;align-items:baseline;justify-content:space-between;gap:14px">
          <span>${esc(SECTION_TITLES[key] || key)}</span>${pct}
        </div>
      </div>`;

      const firstPct = (i === 0 && pct)
        ? `<div style="margin-bottom:14px">${pct}</div>`
        : '';

      return heading + firstPct + sectionHtml(consultation[key]) +
             exerciseBoxHtml(exerciseFor(consultation, key));
    }).join('\n');

    pages.push(pageShell({
      tag: page.tag, tagText: page.tagText, kind, names, pageNo: pageNo++,
      body: `    <div class="sec-title gt">${esc(page.title)}</div>
    <div class="sec-sub">${esc(page.sub)}</div>
${blocks}`,
    }));
  }

  return { html: pages.join('\n'), nextPage: pageNo };
}

/**
 * A page collecting every exercise, so the couple has the whole week in one
 * place instead of hunting through the sections.
 *
 * @param {object} consultation
 * @param {string} mode
 * @param {string} names
 * @param {number} pageNo
 * @returns {string}
 */
function exercisesPageHtml(consultation, mode, names, pageNo) {
  const list = (consultation && consultation.esercizi) || [];
  if (list.length === 0) { return ''; }

  const kind = (REPORT_KIND[mode] || REPORT_KIND.coppia).kind;

  const rows = list.map(function (ex, i) {
    const title = SECTION_TITLES[ex.sezione] || ex.sezione || '';
    return `
      <div class="ex-row">
        <div class="ex-num">${String(i + 1).padStart(2, '0')}</div>
        <div>
          <div class="ex-meta">${esc(title)}${ex.durata ? ' · ' + esc(ex.durata) : ''}</div>
          <div class="ex-name">${esc(ex.titolo)}</div>
          <div class="ex-text">${esc(ex.testo)}</div>
        </div>
      </div>`;
  }).join('');

  return pageShell({
    tag: 'tag-g', tagText: 'Pratica', kind, names, pageNo,
    body: `    <div class="sec-title gg">I vostri esercizi</div>
    <div class="sec-sub">Uno per sezione, da fare insieme</div>
    <p class="body" style="margin-bottom:18px">Non serve farli tutti. Sceglietene uno
    e fatelo davvero, questa settimana: è il passo che trasforma una lettura in un cambiamento.</p>
${rows}`,
  });
}

/**
 * The closing page: what the gift is and where to open it.
 * @param {string} calculationId
 * @param {string} mode
 * @param {string} names
 * @param {number} pageNo
 * @returns {string}
 */
function giftPageHtml(calculationId, mode, names, pageNo) {
  const site = (process.env.SITE_URL || 'https://lignaggio.it').replace(/\/$/, '');
  const url  = site + '/bonus.html?cid=' + encodeURIComponent(calculationId);
  const kind = (REPORT_KIND[mode] || REPORT_KIND.coppia).kind;

  const lenses = [
    ['Intimità', 'Cosa accende la vicinanza e cosa la spegne.'],
    ['Finanze',  'Chi porta quale energia, cosa blocca la prosperità.'],
    ['Karma',    'Il debito rimasto aperto e come chiuderlo.'],
    ['Anima',    'Cosa passa fra voi senza bisogno di parole.'],
  ].map(function (l) {
    return `
        <div class="lens-box">
          <div class="lens-name">${l[0]}</div>
          <div class="lens-desc">${l[1]}</div>
        </div>`;
  }).join('');

  return pageShell({
    tag: 'tag-g', tagText: 'Regalo', kind, names, pageNo,
    body: `    <div class="sec-title gg">Analisi Focus</div>
    <div class="sec-sub">Non compreso nel prezzo</div>

    <p class="body">Scegliete <span class="c-g w7">un solo tema</span> e riceverete un secondo
    approfondimento dedicato: cinque capitoli scritti per voi due e tre esercizi da fare insieme.
    È un regalo, e resta vostro.</p>

    <div class="lens-grid">${lenses}
    </div>

    <div class="card card-g" style="text-align:center">
      <div class="cap" style="margin-bottom:8px">Aprite questo indirizzo dal vostro telefono</div>
      <span class="gift-link">${esc(url)}</span>
    </div>

    <div style="text-align:center;margin-top:40px;font-size:26px;color:rgba(232,201,106,0.55)">&#10022; &#10022; &#10022;</div>`,
  });
}

// ── Main export ──────────────────────────────────────────────────────────────

/**
 * Generate a premium PDF report.
 *
 * @param {object} data - { partner1, partner2, compatibility, consultation }
 *   partner1/2: { name, birthDate, gender }
 *   compatibility: { compatibilityScore, compatibilityBand, partner1Archetype, partner2Archetype }
 *   consultation: { panorama, partner1, partner2, couple, anima, karma, intimita, finanze, potentiale, consiglio }
 * @param {string} calculationId
 * @returns {string} absolute path to generated PDF
 */
async function generatePremiumPDF(data, calculationId) {
  const outPath = path.join(REPORTS_DIR, 'report_' + calculationId + '.pdf');

  // Skip if already exists
  if (fs.existsSync(outPath)) {
    console.log('[pdfGenerator] Report already exists for:', calculationId);
    return outPath;
  }

  const html = buildReportHtml(data, calculationId);

  // ── Puppeteer ──────────────────────────────────────────────────────────────
  // Retry up to 3 times with 3s delay — handles `spawn ETXTBSY` that occurs
  // on Render right after deploy when the Chromium binary is still being synced.
  let browser;
  const MAX_BROWSER_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_BROWSER_ATTEMPTS; attempt++) {
    try {
      const executablePath = await chromium.executablePath();
      browser = await puppeteer.launch({
        headless: chromium.headless,
        executablePath,
        args: [
          ...chromium.args,
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--font-render-hinting=none',
        ],
      });
      break; // success
    } catch (launchErr) {
      if (launchErr.code === 'ETXTBSY' && attempt < MAX_BROWSER_ATTEMPTS) {
        console.warn('[pdfGenerator] Chromium spawn ETXTBSY on attempt', attempt, '— retrying in 3s…');
        await new Promise(function (r) { setTimeout(r, 3000); });
      } else {
        throw launchErr;
      }
    }
  }
  try {

    const page = await browser.newPage();

    // The template pulls its fonts from Google with an @import, and waiting for
    // 'networkidle0' made that request a hard dependency of the whole report:
    // on Render the chain never went quiet inside the timeout, so every single
    // buyer got "PDF generation failed: Timed out after waiting 30000ms" and no
    // file at all.
    //
    // Now the markup is enough to proceed, and the fonts get a bounded grace
    // period of their own. If they miss it the report is still produced, with
    // fallback faces — a report that looks slightly off beats no report.
    const step = function (name, t0) {
      console.log('[pdfGenerator] %s took %dms (%s)', name, Date.now() - t0, calculationId);
    };

    let t = Date.now();
    await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 45000 });
    step('setContent', t);

    // The faces are inlined, so this resolves off the local document. The race
    // stays as a guard: a report in fallback faces beats a failed order.
    t = Date.now();
    try {
      await Promise.race([
        page.evaluate(function () { return document.fonts.ready; }),
        new Promise(function (resolve) { setTimeout(resolve, FONT_GRACE_MS); }),
      ]);
    } catch (fontErr) {
      console.warn('[pdfGenerator] Fonts not ready, rendering anyway:', fontErr.message);
    }
    step('fonts', t);

    // Printing twenty-odd A4 pages of gradients on a small instance is the
    // slowest step by far, and the default 30s cap was cutting it off.
    t = Date.now();
    await page.pdf({
      path:            outPath,
      format:          'A4',
      printBackground: true,
      timeout:         PDF_PRINT_TIMEOUT_MS,
      margin: { top: '0', right: '0', bottom: '0', left: '0' },
    });
    step('print', t);

    console.log('[pdfGenerator] PDF saved:', outPath);
    return outPath;
  } finally {
    if (browser) { await browser.close(); }
  }
}

/**
 * Fills the report template. Separated from the Chromium step so the document
 * can be built and inspected without launching a browser — which is also the
 * only way to test it on a machine that has no Linux Chromium binary.
 *
 * @param {object} data           { partner1, partner2, compatibility, consultation }
 * @param {string} calculationId
 * @returns {string} complete HTML document
 */
function buildReportHtml(data, calculationId) {
  const p1     = data.partner1      || {};
  const p2     = data.partner2      || {};
  const compat = data.compatibility || {};
  const consult = data.consultation  || {};

  const score = Math.min(93, Math.max(46, parseInt(compat.compatibilityScore, 10) || 70));
  const dims  = readDimensions(compat);

  // Read template
  let html = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  html = html.replace('/* {{EMBEDDED_FONTS}}', EMBEDDED_FONTS + '\n/*');

  const mode  = data.mode === 'famiglia' ? 'famiglia' : 'coppia';
  const kind  = REPORT_KIND[mode];
  const name1 = p1.name || 'Partner A';
  const name2 = p2.name || 'Partner B';
  const names = name1 + ' & ' + name2;

  const sections = sectionPagesHtml(consult, dims, mode, names);

  // ── Substitutions ──────────────────────────────────────────────────────────
  const replacements = {
    '{{P1_NAME}}':        esc(name1),
    '{{P2_NAME}}':        esc(name2),
    '{{P1_BIRTH}}':       esc(p1.birthDate || ''),
    '{{P2_BIRTH}}':       esc(p2.birthDate || ''),
    '{{P1_ARCH_NUM}}':    String(parseInt(compat.partner1Archetype, 10) || '—'),
    '{{P2_ARCH_NUM}}':    String(parseInt(compat.partner2Archetype, 10) || '—'),
    '{{P1_ARCH_NAME}}':   esc(ARCH_LABELS[compat.partner1Archetype] || ''),
    '{{P2_ARCH_NAME}}':   esc(ARCH_LABELS[compat.partner2Archetype] || ''),
    '{{SCORE}}':          String(score),
    '{{SCORE_OFFSET}}':   String(ringOffset(score)),
    '{{SCORE_CAPTION}}':  kind.ring,
    '{{REPORT_KIND}}':    kind.kind,

    // Cover
    '{{COVER_BARS}}':     coverBarsHtml(dims, mode),
    '{{UNION_CARD}}':     unionCardHtml(compat),

    // Everything else is a whole page, so a missing part removes its page
    // rather than leaving an empty frame behind.
    '{{SECTION_PAGES}}':  sections.html,
    '{{EXERCISES_PAGE}}': exercisesPageHtml(consult, mode, names, sections.nextPage),
    '{{GIFT_PAGE}}':      giftPageHtml(calculationId, mode, names, sections.nextPage + 1),
  };

  for (const [placeholder, value] of Object.entries(replacements)) {
    // Replace all occurrences (template repeats some tokens like {{P1_NAME}})
    html = html.split(placeholder).join(value);
  }

  return html;
}

module.exports = { generatePremiumPDF, buildReportHtml };
