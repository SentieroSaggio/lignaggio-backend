/* ============================================================
   js/report-blocks.js — la lettura, divisa in capitoli acquistabili
   ──────────────────────────────────────────────────────────────
   La consulenza completa sono quindici sezioni in un unico file. Molti non
   leggono tanto, e chi voleva sapere solo di karma e denaro pagava — o non
   pagava — per tutto il resto. Qui le sezioni sono raggruppate in blocchi che
   una persona può scegliere guardandoli.

   Un blocco non è mai in vendita: "Cosa fare". I passi concreti, il piano e
   gli esercizi entrano in OGNI file, anche in quello da un capitolo solo.
   Chi compra deve ricevere qualcosa da fare, non soltanto una descrizione —
   ed è anche ciò che rende un singolo capitolo un documento vero invece di
   una pagina strappata.

   IL LISTINO
     1 blocco      1,59 €
     2–3 blocchi   3,59 €
     4 o più       7,59 €   ← allo stesso prezzo si prendono tutti e sei
   I tre importi esistono già in Stripe: nessun prezzo nuovo da creare, e il
   gradino più alto conviene prima che si arrivi a metà catalogo.

   Caricato nel browser (window.*) e in Node (module.exports): il sito e il
   generatore del PDF devono avere lo stesso identico listino.
   ============================================================ */

(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.REPORT_BLOCKS   = api.BLOCKS;
    root.reportBlockList = api.blockList;
    root.reportPriceFor  = api.priceFor;
    root.reportSections  = api.sectionsFor;
    root.reportOwns      = api.owns;
    root.reportBundleFor = api.bundleFor;
    root.reportUnlockPriceFor = api.unlockPriceFor;
  }
}(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  /**
   * `sections` are consultation keys, in reading order.
   * `free: true` means the block is in every report and can never be bought.
   */
  var BLOCKS = {
    identita: {
      id:       'identita',
      order:    1,
      glyph:    '👤',
      label:    'Chi siete',
      sub:      'I due ritratti, uno di fronte all’altro',
      sections: ['partner1', 'partner2'],
    },
    legame: {
      id:       'legame',
      order:    2,
      glyph:    '🔗',
      label:    'Il vostro legame',
      sub:      'Perché vi siete incontrati e dove porta',
      sections: ['panorama', 'couple', 'unione', 'potentiale'],
    },
    anima: {
      id:       'anima',
      order:    3,
      glyph:    '🜂',
      label:    'Anima e karma',
      sub:      'Il legame sotto la superficie',
      sections: ['anima', 'karma'],
    },
    intimita: {
      id:       'intimita',
      order:    4,
      glyph:    '🜄',
      label:    'Intimità',
      sub:      'Vicinanza, desiderio, distanza',
      sections: ['intimita'],
    },
    finanze: {
      id:       'finanze',
      order:    5,
      glyph:    '🜔',
      label:    'Finanze',
      sub:      'Denaro, sicurezza, progetti comuni',
      sections: ['finanze'],
    },
    fiamme: {
      id:       'fiamme',
      order:    6,
      glyph:    '🔥',
      label:    'Le due fiamme',
      sub:      'Chi cerca e chi si ritira',
      sections: ['fiamma1', 'fiamma2'],
    },
    pratica: {
      id:       'pratica',
      order:    7,
      glyph:    '✦',
      label:    'Cosa fare',
      sub:      'I passi concreti e gli esercizi — sempre inclusi',
      sections: ['passi', 'consiglio', 'esercizi'],
      free:     true,
    },
  };

  /** Price keys already configured in Stripe. Nothing new to create. */
  var TIERS = [
    { upTo: 1,        key: '1.59' },
    { upTo: 3,        key: '3.59' },
    { upTo: Infinity, key: '7.59' },
  ];

  /**
   * What each price on the offer page actually buys.
   *
   * The four amounts used to unlock the identical reading, which made the
   * labels a lie and left nothing to sell afterwards. Now the cheapest price
   * buys the core chapter, the middle one three, and the top two the whole
   * reading — consistent with TIERS above, so a one-block bundle costs what a
   * one-block pick would.
   *
   * null means the whole reading. An amount that is not listed here also
   * means the whole reading: an unrecognised price must never quietly narrow
   * what somebody paid for.
   */
  var BUNDLES = {
    '1.59':  ['legame'],
    '3.59':  ['legame', 'identita', 'anima'],
    '7.59':  null,
    '17.67': null,
  };

  /**
   * Prices for chapters added AFTER the first purchase, on the result page.
   * The reading is already written, so these are cheap on purpose — and the
   * top step is "everything that is left", whatever that count is, because
   * "tutto il resto per 2,99" is an easier decision than arithmetic.
   */
  var UNLOCK_TIERS = [
    { upTo: 1,        key: '0.99' },
    { upTo: 2,        key: '1.99' },
    { upTo: Infinity, key: '2.99' },
  ];

  /** Every block, in reading order. */
  function blockList() {
    return Object.keys(BLOCKS)
      .map(function (id) { return BLOCKS[id]; })
      .sort(function (a, b) { return a.order - b.order; });
  }

  /** The blocks a visitor can actually pay for. */
  function purchasable() {
    return blockList().filter(function (b) { return !b.free; });
  }

  /**
   * What a selection costs.
   *
   * Free blocks never count towards the tier — including "Cosa fare" in the
   * total would make a one-chapter order look like a two-chapter one.
   *
   * @param {string[]} ids
   * @returns {{key: string, amount: number, count: number}|null} null for an empty selection
   */
  function priceFor(ids) {
    var paid = (ids || []).filter(function (id) {
      return BLOCKS[id] && !BLOCKS[id].free;
    });
    // A block named twice is still one block.
    var unique = paid.filter(function (id, i) { return paid.indexOf(id) === i; });
    if (unique.length === 0) { return null; }

    for (var i = 0; i < TIERS.length; i++) {
      if (unique.length <= TIERS[i].upTo) {
        return { key: TIERS[i].key, amount: parseFloat(TIERS[i].key), count: unique.length };
      }
    }
    return null;
  }

  /** Paid, known, de-duplicated block ids out of whatever was handed in. */
  function paidUnique(ids) {
    var paid = (ids || []).filter(function (id) {
      return BLOCKS[id] && !BLOCKS[id].free;
    });
    return paid.filter(function (id, i) { return paid.indexOf(id) === i; });
  }

  /**
   * The chapters a first purchase at this price includes.
   * @param {string|number} priceKey  e.g. '1.59' or 1.59
   * @returns {string[]|null}  null for the whole reading
   */
  function bundleFor(priceKey) {
    var k = String(priceKey === undefined || priceKey === null ? '' : priceKey)
      .trim().replace(',', '.');
    if (!Object.prototype.hasOwnProperty.call(BUNDLES, k)) { return null; }
    var b = BUNDLES[k];
    return b === null ? null : b.slice();
  }

  /**
   * What adding these chapters to an existing order costs.
   * @param {string[]} ids
   * @returns {{key: string, amount: number, count: number}|null} null for nothing to buy
   */
  function unlockPriceFor(ids) {
    var unique = paidUnique(ids);
    if (unique.length === 0) { return null; }
    for (var i = 0; i < UNLOCK_TIERS.length; i++) {
      if (unique.length <= UNLOCK_TIERS[i].upTo) {
        return { key: UNLOCK_TIERS[i].key, amount: parseFloat(UNLOCK_TIERS[i].key), count: unique.length };
      }
    }
    return null;
  }

  /**
   * The consultation keys a set of blocks unlocks, in reading order.
   * Free blocks are always in, whatever was bought.
   *
   * @param {string[]|null} owned  null or ['*'] means the whole reading
   * @returns {string[]}
   */
  function sectionsFor(owned) {
    var all = owned === null || owned === undefined ||
              (Array.isArray(owned) && owned.indexOf('*') !== -1);

    var keys = [];
    blockList().forEach(function (b) {
      if (all || b.free || (Array.isArray(owned) && owned.indexOf(b.id) !== -1)) {
        keys = keys.concat(b.sections);
      }
    });
    return keys;
  }

  /**
   * Does this order include that block?
   * @param {string[]|null} owned
   * @param {string} blockId
   * @returns {boolean}
   */
  function owns(owned, blockId) {
    var b = BLOCKS[blockId];
    if (!b) { return false; }
    if (b.free) { return true; }
    if (owned === null || owned === undefined) { return true; }
    if (!Array.isArray(owned)) { return false; }
    return owned.indexOf('*') !== -1 || owned.indexOf(blockId) !== -1;
  }

  return {
    BLOCKS:         BLOCKS,
    TIERS:          TIERS,
    BUNDLES:        BUNDLES,
    UNLOCK_TIERS:   UNLOCK_TIERS,
    blockList:      blockList,
    purchasable:    purchasable,
    priceFor:       priceFor,
    bundleFor:      bundleFor,
    unlockPriceFor: unlockPriceFor,
    sectionsFor:    sectionsFor,
    owns:           owns,
  };
}));
