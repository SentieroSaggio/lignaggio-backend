/*
   plusDunning.js — the e-mail a Lignaggio Plus subscriber gets when a renewal
   could not be charged (subscription past_due).

   Stripe keeps retrying on its own schedule; what was missing was a word to
   the person: nothing was charged, here is the secure page to update the
   card, and one reply cancels everything. The e-mail never touches the
   subscription itself. Pure render function; the sweep lives in server/index.js.
*/

'use strict';

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatEur(n) {
  return Number(n).toFixed(2).replace('.', ',').replace(/,00$/, '') + ' €';
}

/**
 * @param {{name?: string, amountEur: number, payUrl: string, support: string}} p
 * @returns {{subject: string, html: string}}
 */
function renderPastDueEmail(p) {
  const name = String(p.name || '').trim().split(/\s+/)[0];
  const amount = escapeHtml(formatEur(p.amountEur));
  const support = escapeHtml(p.support);
  const html = `
    <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:auto;color:#222;line-height:1.6">
      <div style="background:#141233;padding:22px 28px;border-radius:10px 10px 0 0">
        <div style="color:#e8c96a;font-size:12px;letter-spacing:0.18em;text-transform:uppercase;margin-bottom:6px">Lignaggio Plus</div>
        <h1 style="color:#fff;font-size:20px;margin:0;font-weight:600">Il rinnovo non è andato a buon fine</h1>
      </div>
      <div style="background:#fff;padding:28px;border:1px solid #e5e7eb;border-top:0;border-radius:0 0 10px 10px">
        <p>Ciao${name ? ' ' + escapeHtml(name) : ''},</p>
        <p>la tua banca non ha approvato il rinnovo di Lignaggio Plus (${amount} al mese). <strong>Nessun importo è stato addebitato.</strong></p>
        <p>Per continuare a ricevere la lettura mensile basta aggiornare il metodo di pagamento sulla pagina sicura di Stripe:</p>
        <p style="text-align:center;margin:26px 0">
          <a href="${escapeHtml(p.payUrl)}" style="background:#7c5cff;color:#fff;padding:14px 30px;border-radius:999px;text-decoration:none;font-weight:600;font-size:16px;display:inline-block">Aggiorna il pagamento</a>
        </p>
        <p style="font-size:14px;color:#555">Se hai già sistemato, ignora questo messaggio. Se invece non vuoi continuare, rispondi a questa e-mail scrivendo <strong>disdici</strong>: chiudiamo tutto, senza altri addebiti.</p>
        <p style="margin-top:28px;font-size:12px;color:#888;line-height:1.6">Ricevi questa e-mail perché hai un abbonamento Lignaggio Plus. Per qualsiasi cosa scrivi a ${support}.</p>
      </div>
    </div>`;
  return {
    subject: 'Lignaggio Plus: il rinnovo non è andato a buon fine',
    html:    html,
  };
}

module.exports = { renderPastDueEmail, formatEur };
