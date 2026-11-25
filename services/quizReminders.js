/*
   quizReminders.js — the two reminder e-mails for the lineage and strega
   quizzes, and the link that reopens the result on any device.

   Who gets them: someone who left an e-mail (quiz step or analysis sheet),
   has an archetype, and has not paid — one hour later, then a day later,
   never more. Paying at any point stops the sequence (the webhook marks the
   e-mail as paid). No countdowns, no invented scarcity: the guide is simply
   still there.

   Pure functions only: nothing here touches the network or the database.
*/

'use strict';

const QUIZ = {
  lin: {
    brand:    'Matrice del Lignaggio',
    site:     process.env.QUIZ_SITE_LIN || 'https://www.lignaggio.it/',
    minPrice: '5 €',
    guide:    'la tua guida di Lignaggio',
    inside:   '5–6 pagine scritte per il tuo archetipo: il Codice di Venuta al Mondo, il compito che la tua linea ti ha affidato, le ferite che si ripetono di madre in figlio e i passi pratici per usare la tua forza.',
    accent:   '#7c5cff',
  },
  str: {
    brand:    'Archetipi della Strega',
    site:     process.env.QUIZ_SITE_STR || 'https://www.lignaggio.it/quiz-strega/',
    minPrice: '1,59 €',
    guide:    'il tuo dossier di Strega',
    inside:   '5 pagine scritte per il tuo archetipo: codice di lignaggio, dono, ombra, ferita, compito dell’anima e attivazione della forza.',
    accent:   '#b04fd6',
  },
};

const PRICE_TO_QUIZ = { '5': 'lin', '9': 'lin', '13': 'lin', '17.67': 'lin', '1.59': 'str', '3.59': 'str', '7.59': 'str' };

function known(quiz) { return Object.prototype.hasOwnProperty.call(QUIZ, String(quiz || '')); }

/** Which quiz a PaymentIntent belongs to, from its metadata ('' when unsure). */
function quizOf(metadata) {
  const m = metadata || {};
  if (known(m.quiz)) { return String(m.quiz); }
  if (m.calculation_id) { return ''; }                  // the couple quiz
  return PRICE_TO_QUIZ[String(m.selected_price || '').replace(',', '.')] || '';
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** The payload offer.js reads from ?r=…: archetype and name. Never the e-mail:
    the link lands in the address bar, and tracking pixels read that. */
function resumeToken(lead) {
  const payload = { a: Number(lead.arch), n: String(lead.name || '') };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function resumeUrl(lead) {
  const q = QUIZ[lead.quiz];
  if (!q) { return ''; }
  return q.site + 'offer.html?r=' + resumeToken(lead);
}

function firstName(name) {
  return String(name || '').trim().split(/\s+/)[0] || '';
}

function layout(q, title, bodyHtml, footerHtml) {
  return `
    <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:auto;color:#222;line-height:1.6">
      <div style="background:#141233;padding:22px 28px;border-radius:10px 10px 0 0">
        <div style="color:#e8c96a;font-size:12px;letter-spacing:0.18em;text-transform:uppercase;margin-bottom:6px">${escapeHtml(q.brand)}</div>
        <h1 style="color:#fff;font-size:20px;margin:0;font-weight:600">${title}</h1>
      </div>
      <div style="background:#fff;padding:28px;border:1px solid #e5e7eb;border-top:0;border-radius:0 0 10px 10px">
        ${bodyHtml}
        <p style="margin-top:28px;font-size:12px;color:#888;line-height:1.6">${footerHtml}</p>
      </div>
    </div>`;
}

function button(q, url, label) {
  return `
        <p style="text-align:center;margin:26px 0">
          <a href="${url}" style="background:${q.accent};color:#fff;padding:14px 30px;border-radius:999px;text-decoration:none;font-weight:600;font-size:16px;display:inline-block">${label}</a>
        </p>`;
}

/**
 * Reminder 1 (about an hour later): the result is ready and waiting.
 * @param {{quiz: string, email: string, name?: string, arch: number, arch_name?: string}} lead
 * @param {string} support
 */
function renderReminder1(lead, support) {
  const q = QUIZ[lead.quiz];
  const url = resumeUrl(lead);
  const name = firstName(lead.name);
  const archName = escapeHtml(lead.arch_name || ('Archetipo ' + lead.arch));
  const body = `
        <p>Ciao${name ? ' ' + escapeHtml(name) : ''},</p>
        <p>hai completato il test: il tuo archetipo è il <strong>${Number(lead.arch)}</strong>, <strong>${archName}</strong>.</p>
        <p>La lettura completa è pronta e ti aspetta. ${escapeHtml(q.inside)}</p>
        ${button(q, url, 'Apri il mio risultato')}
        <p style="font-size:14px;color:#555">Il PDF si apre subito dopo il contributo, da ${escapeHtml(q.minPrice)}, ed è lo stesso per ogni cifra. Se non risuona, rimborso entro 7 giorni.</p>`;
  const footer = `Ricevi questa e-mail perché hai lasciato il tuo indirizzo nel test. Riceverai al massimo un altro promemoria. Per qualsiasi cosa scrivi a ${escapeHtml(support)}.`;
  return {
    fromName: q.brand,
    subject:  'Il tuo Archetipo ' + Number(lead.arch) + ' ti aspetta ✦ ' + q.brand,
    html:     layout(q, 'Il tuo risultato è pronto', body, footer),
  };
}

/**
 * Reminder 2 (a day later): what the guide holds, and that this is the last note.
 */
function renderReminder2(lead, support) {
  const q = QUIZ[lead.quiz];
  const url = resumeUrl(lead);
  const name = firstName(lead.name);
  const archName = escapeHtml(lead.arch_name || ('Archetipo ' + lead.arch));
  const body = `
        <p>Ciao${name ? ' ' + escapeHtml(name) : ''},</p>
        <p>ieri hai scoperto di essere <strong>${archName}</strong>. ${escapeHtml(q.guide.charAt(0).toUpperCase() + q.guide.slice(1))} è ancora qui, scritta per il tuo archetipo.</p>
        <p>Dentro: ${escapeHtml(q.inside)}</p>
        ${button(q, url, 'Leggi la mia guida')}
        <p style="font-size:14px;color:#555">Contributo libero da ${escapeHtml(q.minPrice)}: il PDF è lo stesso per ogni cifra e si apre subito. Rimborso entro 7 giorni se non risuona.</p>`;
  const footer = `Questo è l’ultimo promemoria: non te ne manderemo altri. Per qualsiasi cosa scrivi a ${escapeHtml(support)}.`;
  return {
    fromName: q.brand,
    subject:  archName.replace(/&[^;]+;/g, '') + ': la tua guida resta qui ✦ ' + q.brand,
    html:     layout(q, 'La tua guida è ancora qui', body, footer),
  };
}

module.exports = { QUIZ, known, quizOf, resumeToken, resumeUrl, renderReminder1, renderReminder2 };
