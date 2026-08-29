/**
 * services/traffic.js
 * ─────────────────────────────────────────────────────────────
 * Our own traffic labels — the `?src=` marker we put on a link before handing
 * it to a reel, a story, a bio link or a DM autoresponder.
 *
 * Deliberately separate from services/keitaro.js. A label from this module is
 * never reported to the partner's tracker: Keitaro only accepts click ids it
 * issued itself, and feeding it ours would pollute the partner's dashboard and
 * mislabel our organic sales as paid traffic.
 *
 * The one rule here is the shape of a label, and it is the same rule the
 * browser applies in public/attribution.js. Keep the two in step.
 * ─────────────────────────────────────────────────────────────
 */

'use strict';

/**
 * Labels are opaque tokens chosen by us, but they still arrive through the
 * browser and are shown in the admin panel, so they are treated as untrusted:
 * only characters that cannot carry markup, quotes, SQL or shell payloads, and
 * a hard length cap.
 * @type {RegExp}
 */
const SOURCE_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Accept only the safe shape, reject everything else outright rather than
 * trying to repair it.
 * @param {*} value
 * @returns {string} '' when the value is not a usable label
 */
function sanitizeSource(value) {
  if (typeof value !== 'string') { return ''; }
  const trimmed = value.trim();
  return SOURCE_RE.test(trimmed) ? trimmed : '';
}

module.exports = {
  sanitizeSource,
  SOURCE_RE,
};
