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
const TEMPLATE_PATH  = path.join(__dirname, '..', 'templates', 'premium-report.html');
const REPORTS_DIR    = path.join(__dirname, '..', 'storage', 'reports');

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
  if (!text) { return '<p style="color:rgba(180,100,255,0.4);font-size:8pt">—</p>'; }
  return String(text).split(/\n\n+/).map(function (para) {
    para = para.trim();
    return para ? '<p>' + formatParagraph(para) + '</p>' : '';
  }).filter(Boolean).join('');
}

// ── Derive dimension percentages from compatibility score ────────────────────
function deriveMetrics(score) {
  const s = Math.min(100, Math.max(0, parseInt(score, 10) || 70));
  // Vary sectors around the overall score with some spread
  const rand = function (offset) { return Math.min(97, Math.max(40, s + offset)); };
  return {
    em:  rand(+8),
    com: rand(-5),
    val: rand(+3),
    pot: rand(+6),
    int: rand(-9),
  };
}

// ── Compute SVG ring offset (circumference = 2πr, r=50 → 314) ───────────────
function ringOffset(score) {
  const s = Math.min(100, Math.max(0, parseInt(score, 10) || 70));
  return Math.round(314 * (1 - s / 100));
}

// ── Compute pie/donut chart segments (circumference = 2πr, r=68 → ~427) ─────
function pieSegments(m) {
  const C   = 427;
  const seg1 = Math.round(C * m.em  / 100);
  const seg2 = Math.round(C * m.val / 100 * 0.6);
  const seg3 = Math.round(C * m.int / 100 * 0.4);
  return {
    seg1, rest1: C - seg1,
    seg2, rest2: C - seg2,
    off2: -(seg1 * 0.7),
    seg3, rest3: C - seg3,
    off3: -(seg1 * 0.7 + seg2 * 0.5),
  };
}

// ── Trend labels from score ──────────────────────────────────────────────────
function trendLabel(score) {
  const s = parseInt(score, 10) || 70;
  if (s >= 80) { return { label: 'Ascendente', arrowClass: 'arrow-up', arrow: '▲' }; }
  if (s >= 60) { return { label: 'Stabile',    arrowClass: 'arrow-flat', arrow: '→' }; }
  return                { label: 'In Crescita', arrowClass: 'arrow-up', arrow: '▲' };
}
function growthLabel(score) {
  const s = parseInt(score, 10) || 70;
  if (s >= 75) { return { label: 'Alto',   arrowClass: 'arrow-up',   arrow: '▲' }; }
  if (s >= 55) { return { label: 'Medio',  arrowClass: 'arrow-flat', arrow: '→' }; }
  return               { label: 'Crescente', arrowClass: 'arrow-up', arrow: '▲' };
}

// ── Build the band label ─────────────────────────────────────────────────────
function bandLabel(band) {
  const map = {
    exceptional: 'Eccezionale', high: 'Alta', medium: 'Media', low: 'Bassa',
  };
  return map[String(band).toLowerCase()] || (band ? String(band) : 'Alta');
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

  const p1     = data.partner1      || {};
  const p2     = data.partner2      || {};
  const compat = data.compatibility || {};
  const consult = data.consultation  || {};

  const score   = Math.min(93, Math.max(46, parseInt(compat.compatibilityScore, 10) || 70));
  const metrics = deriveMetrics(score);
  const pie     = pieSegments(metrics);
  const trend   = trendLabel(score);
  const growth  = growthLabel(score);

  // Read template
  let html = fs.readFileSync(TEMPLATE_PATH, 'utf8');

  // ── Substitutions ──────────────────────────────────────────────────────────
  const replacements = {
    '{{P1_NAME}}':        esc(p1.name      || 'Partner A'),
    '{{P2_NAME}}':        esc(p2.name      || 'Partner B'),
    '{{P1_BIRTH}}':       esc(p1.birthDate || ''),
    '{{P2_BIRTH}}':       esc(p2.birthDate || ''),
    '{{P1_ARCH_LABEL}}':  archLabel(compat.partner1Archetype),
    '{{P2_ARCH_LABEL}}':  archLabel(compat.partner2Archetype),
    '{{SCORE}}':          String(score),
    '{{SCORE_OFFSET}}':   String(ringOffset(score)),
    '{{BAND}}':           bandLabel(compat.compatibilityBand),

    // Sector percentages
    '{{EM_PCT}}':         String(metrics.em),
    '{{COM_PCT}}':        String(metrics.com),
    '{{VAL_PCT}}':        String(metrics.val),
    '{{POT_PCT}}':        String(metrics.pot),
    '{{INT_PCT}}':        String(metrics.int),

    // Pie chart segments
    '{{CHART_SEG1}}':     String(pie.seg1),
    '{{CHART_REST1}}':    String(pie.rest1),
    '{{CHART_OFF1}}':     '0',
    '{{CHART_SEG2}}':     String(pie.seg2),
    '{{CHART_REST2}}':    String(pie.rest2),
    '{{CHART_OFF2}}':     String(pie.off2),
    '{{CHART_SEG3}}':     String(pie.seg3),
    '{{CHART_REST3}}':    String(pie.rest3),
    '{{CHART_OFF3}}':     String(pie.off3),

    // Trend indicators
    '{{TREND_LABEL}}':        trend.label,
    '{{TREND_ARROW_CLASS}}':  trend.arrowClass,
    '{{TREND_ARROW}}':        trend.arrow,
    '{{GROWTH_LABEL}}':       growth.label,
    '{{GROWTH_ARROW_CLASS}}': growth.arrowClass,
    '{{GROWTH_ARROW}}':       growth.arrow,
    '{{VAL_ARROW_CLASS}}':    metrics.val >= 70 ? 'arrow-up' : 'arrow-flat',
    '{{VAL_ARROW}}':          metrics.val >= 70 ? '▲' : '→',

    // Consultation sections (rich HTML)
    '{{PANORAMA_HTML}}':    sectionHtml(consult.panorama),
    '{{PARTNER1_HTML}}':    sectionHtml(consult.partner1),
    '{{PARTNER2_HTML}}':    sectionHtml(consult.partner2),
    '{{COUPLE_HTML}}':      sectionHtml(consult.couple),
    '{{ANIMA_HTML}}':       sectionHtml(consult.anima),
    '{{KARMA_HTML}}':       sectionHtml(consult.karma),
    '{{INTIMITA_HTML}}':    sectionHtml(consult.intimita),
    '{{FINANZE_HTML}}':     sectionHtml(consult.finanze),
    '{{POTENTIALE_HTML}}':  sectionHtml(consult.potentiale),
    '{{CONSIGLIO_HTML}}':   sectionHtml(consult.consiglio),
  };

  for (const [placeholder, value] of Object.entries(replacements)) {
    // Replace all occurrences (template repeats some tokens like {{P1_NAME}})
    html = html.split(placeholder).join(value);
  }

  // ── Puppeteer ──────────────────────────────────────────────────────────────
  let browser;
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

    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30000 });

    await page.pdf({
      path:            outPath,
      format:          'A4',
      printBackground: true,
      margin: { top: '0', right: '0', bottom: '0', left: '0' },
    });

    console.log('[pdfGenerator] PDF saved:', outPath);
    return outPath;
  } finally {
    if (browser) { await browser.close(); }
  }
}

module.exports = { generatePremiumPDF };
