/*
   plusReminder.js — the email that goes out the day before the trial ends.

   Every purchase opens seven free days of Lignaggio Plus and then bills
   19 €/month. Until now nobody was told the day before it happened. This is
   that notice: what they are about to pay for, when, how much, and how to
   stop it — written so that someone who does not want it can cancel with one
   reply, and someone who does knows what arrives on the 1st.

   Only the rendering and the timing rule live here, so both can be tested
   without Stripe or SMTP. The sweep that lists trials and sends is in
   server/index.js.
*/

'use strict';

/* The reminder goes out once, in a window around 24 hours before the first
   charge. The window is wide (12–36 h) because the sweep runs hourly and the
   server restarts: a trial must never slip through the gap between two runs. */
const WINDOW_MIN_MS = 12 * 60 * 60 * 1000;
const WINDOW_MAX_MS = 36 * 60 * 60 * 1000;

/**
 * Is this trial ending in the reminder window?
 * @param {number} trialEndSec  Stripe's `trial_end`, Unix seconds
 * @param {number} [nowMs]
 * @returns {boolean}
 */
function endsWithinWindow(trialEndSec, nowMs) {
  const now  = nowMs === undefined ? Date.now() : nowMs;
  const left = Number(trialEndSec) * 1000 - now;
  return left >= WINDOW_MIN_MS && left <= WINDOW_MAX_MS;
}

/**
 * A date the way an Italian customer reads it: "martedì 15 settembre".
 * @param {number} trialEndSec
 * @returns {string}
 */
function formatItalianDate(trialEndSec) {
  return new Intl.DateTimeFormat('it-IT', {
    timeZone: 'Europe/Rome', weekday: 'long', day: 'numeric', month: 'long',
  }).format(new Date(Number(trialEndSec) * 1000));
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Renders the reminder.
 * @param {{trialEndSec: number, name?: string, support: string, amountEur?: number}} args
 * @returns {{subject: string, html: string}}
 */
function renderTrialReminder(args) {
  const when    = formatItalianDate(args.trialEndSec);
  const support = escapeHtml(args.support);
  const name    = (args.name || '').trim();
  const amount  = String(args.amountEur === undefined ? 19 : args.amountEur).replace('.', ',');

  const subject = 'Domani inizia Lignaggio Plus — ' + amount + ' € al mese, salvo disdetta';

  const html = `
    <div style="font-family:sans-serif;max-width:600px;margin:auto;color:#222;line-height:1.6">
      <div style="background:linear-gradient(135deg,#2a1d05 0%,#1a1207 100%);padding:26px 32px;border-radius:8px 8px 0 0">
        <p style="margin:0 0 6px 0;color:#e8c96a;font-size:11px;letter-spacing:0.22em;text-transform:uppercase">Lignaggio Plus &middot; promemoria</p>
        <p style="margin:0;color:#fff;font-size:21px;font-weight:700">I tuoi 7 giorni di prova finiscono ${escapeHtml(when)}</p>
      </div>
      <div style="background:#fff;padding:30px 32px;border:1px solid #e5e7eb;border-top:0;border-radius:0 0 8px 8px">
        <p>Ciao${name ? ' ' + escapeHtml(name) : ''},</p>
        <p>con la tua lettura di coppia si sono aperti sette giorni gratuiti di <strong>Lignaggio Plus</strong>.
        Finiscono <strong>${escapeHtml(when)}</strong>: da quel giorno l&rsquo;abbonamento costa
        <strong>${amount} &euro; al mese</strong>, e si rinnova da solo finch&eacute; non lo disdici.</p>

        <div style="margin:22px 0;padding:18px 20px;background:#faf6ea;border-left:3px solid #e8c96a;border-radius:0 8px 8px 0">
          <p style="margin:0 0 8px;font-weight:700;color:#3a3320">Che cosa ricevi con Plus</p>
          <p style="margin:0;color:#3a3320">Il <strong>primo di ogni mese</strong> una lettura personale sul mese che inizia,
          costruita sulla <strong>tua data di nascita</strong>: nove sezioni &mdash; il tema del mese, amore, energia,
          lavoro e denaro, l&rsquo;ombra da cui guardarsi, i <strong>giorni chiave</strong>, una pratica concreta,
          una domanda da portarti dietro e un consiglio di chiusura.</p>
        </div>

        <div style="margin:22px 0;padding:18px 20px;background:#f3f0fa;border-left:3px solid #6b21a8;border-radius:0 8px 8px 0">
          <p style="margin:0 0 8px;font-weight:700;color:#2a1a45">Non lo vuoi? Basta una riga</p>
          <p style="margin:0;color:#2a1a45">Rispondi a questa email con <strong>&laquo;disdici&raquo;</strong>, oppure scrivi a
          <a href="mailto:${support}?subject=Disdetta%20Lignaggio%20Plus" style="color:#6b21a8">${support}</a>,
          <strong>entro ${escapeHtml(when)}</strong>. La disdetta &egrave; immediata, senza domande, e non ti verr&agrave;
          addebitato nulla. La lettura di coppia che hai gi&agrave; pagato resta tua.</p>
        </div>

        <p style="font-size:13px;color:#666">Se invece vuoi continuare non devi fare niente: la prima lettura mensile
        arriver&agrave; il primo del mese, e potrai disdire in qualsiasi momento allo stesso indirizzo.</p>

        <p style="margin-top:28px;font-size:12px;color:#999;text-align:center">
          Lignaggio Plus &middot; ${amount} &euro; al mese dopo la prova &middot; disdetta scrivendo a ${support}
        </p>
      </div>
    </div>`;

  return { subject: subject, html: html };
}

module.exports = {
  WINDOW_MIN_MS,
  WINDOW_MAX_MS,
  endsWithinWindow,
  formatItalianDate,
  renderTrialReminder,
};
