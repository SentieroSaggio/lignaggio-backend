/* ============================================================
   js/fiamme-bond.js — Fiamme Gemelle: il tipo di legame
   ──────────────────────────────────────────────────────────────
   The reel names a bond from the DAY of the month both people were
   born on, reduced to 1–9. Someone who saw the video and types their
   two days here must get back the exact name they were shown — that
   is the whole point, and it is why the five pairs published in the
   reel are pinned first in the table below.

   This is a SECOND layer, not a replacement. compatibility-score.js
   keeps computing the archetypes (1–22), the score and the image
   band from the full dates, untouched. This file only adds a name
   and a phase on top.

   Two axes, so two couples with the same bond do not read the same:
     bond  — from the two day numbers (10 names over all 45 pairs)
     phase — from the month and year digits, the part the day number
             throws away (7 phases)

   DETERMINISTIC: same two dates → same bond and phase, always.
   No randomness, no network, no storage.

   Loads in the browser (window.*) and in Node (module.exports), so
   the funnel and the backend read one table and cannot drift apart.
   ============================================================ */

(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;                       // backend: require('./fiammeBond')
  }
  if (root) {                                   // browser: window.fiammeReading(...)
    root.FIAMME_BONDS   = api.BONDS;
    root.FIAMME_PHASES  = api.PHASES;
    root.fiammeDayNumber = api.dayNumber;
    root.fiammeBond      = api.bondFor;
    root.fiammePhase     = api.phaseFor;
    root.fiammeReading   = api.reading;
  }
}(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  // ════════════════════════════════════════════════════════════
  // THE TEN BONDS
  // ════════════════════════════════════════════════════════════

  /**
   * `name` is the headline, `subtitle` the line under it, `teaser` the two or
   * three sentences shown for free. `colors` is a gradient pair for the badge.
   *
   * The wording describes a dynamic, never a verdict on a real relationship —
   * the product's own promise is "Non è un oroscopo. È un metodo di
   * autoconoscenza", and a page that tells someone their marriage is toxic
   * breaks that promise.
   */
  var BONDS = {
    runner_chaser: {
      id:       'runner_chaser',
      glyph:    '🔥',
      name:     'RUNNER & CHASER',
      subtitle: 'L’amore che scappa',
      colors:   ['#ff7a3d', '#c2401f'],
      teaser:   'Uno sente subito la profondità del legame e cerca di avvicinarsi. L’altro, proprio quando il rapporto diventa più intenso, si chiude o scompare. Più uno rincorre, più l’altro fugge — ed è un ciclo che può durare anni.'
    },
    notte_oscura: {
      id:       'notte_oscura',
      glyph:    '🌑',
      name:     'UNIONE DELLA NOTTE OSCURA',
      subtitle: 'Il legame che apre le ferite',
      colors:   ['#6b4a8f', '#241236'],
      teaser:   'Non è l’amore che porta pace. È il legame che apre le ferite più profonde. Più vi avvicinate, più emergono paure, gelosia e dolore. Prima di potersi amare davvero, entrambi devono attraversare una trasformazione pesante.'
    },
    falsa_gemella: {
      id:       'falsa_gemella',
      glyph:    '⚡',
      name:     'FIAMMA TOSSICA — LA FALSA GEMELLA',
      subtitle: 'Intensa, ma non per forza destino',
      colors:   ['#e0455f', '#5c1030'],
      teaser:   'Attrazione fortissima, dipendenza, separazioni e ritorni. Uno continua a credere che sia “destino”, mentre il rapporto consuma entrambi. La prova è capire se state crescendo davvero insieme… oppure se state usando l’idea del destino per non lasciarvi andare.'
    },
    anime_specchio: {
      id:       'anime_specchio',
      glyph:    '🪞',
      name:     'ANIME SPECCHIO',
      subtitle: 'Il legame che ti toglie le maschere',
      colors:   ['#7fb0d9', '#2a4a6b'],
      teaser:   'Il partner sembra vedere proprio ciò che cercate di nascondere. Insicurezze, bisogno di controllo, paura dell’abbandono e vecchie ferite vengono amplificate. L’attrazione è enorme, ma anche estremamente scomoda: l’altro diventa lo specchio delle parti che non volete ancora guardare.'
    },
    ritorno: {
      id:       'ritorno',
      glyph:    '♾️',
      name:     'UNIONE DEL RITORNO',
      subtitle: 'Separati per ritrovarsi',
      colors:   ['#8c50ff', '#3a1a6b'],
      teaser:   'L’incontro è giusto, il momento no. Uno dei due non è pronto, la vita vi divide oppure il rapporto si interrompe bruscamente. La separazione può precedere il ritorno — ma solo dopo che ciascuno ha affrontato da solo ciò che il legame ha fatto emergere.'
    },
    eco: {
      id:       'eco',
      glyph:    '🜃',
      name:     'L’ECO — LO STESSO CODICE',
      subtitle: 'Nati sulla stessa vibrazione',
      colors:   ['#c9a227', '#5c4408'],
      teaser:   'Siete nati sotto lo stesso numero. Vi capite senza spiegarvi, e proprio per questo amplificate tutto: il dono dell’uno è il dono dell’altro, e la ferita dell’uno è la stessa. Nessuno dei due può fare da correttivo all’altro — e lì sta sia la forza sia il rischio.'
    },
    karmica: {
      id:       'karmica',
      glyph:    '⛓️',
      name:     'FIAMMA KARMICA — IL DEBITO ANTICO',
      subtitle: 'Qualcosa era già cominciato',
      colors:   ['#a05c3a', '#3b1a10'],
      teaser:   'Qualcosa in questo legame sembra iniziato prima di voi. Tornano gli stessi schemi, le stesse discussioni, la stessa sensazione di dover qualcosa all’altro. Finché il debito non viene visto e nominato, il ciclo si ripete identico.'
    },
    trasformazione: {
      id:       'trasformazione',
      glyph:    '🜂',
      name:     'UNIONE DELLA TRASFORMAZIONE',
      subtitle: 'Ciò che brucia, ciò che resta',
      colors:   ['#ff9d4d', '#7a2d0c'],
      teaser:   'Questo legame non vi lascia come vi ha trovati. Lavoro, casa, amicizie, il modo stesso di raccontarvi: tutto si muove. È un fuoco che crea — ma prima toglie la forma vecchia, e quella fase raramente è comoda.'
    },
    dormiente: {
      id:       'dormiente',
      glyph:    '🌙',
      name:     'FIAMMA DORMIENTE',
      subtitle: 'Il riconoscimento tardivo',
      colors:   ['#5b6ba8', '#1b2038'],
      teaser:   'Uno dei due ha capito subito. L’altro ci mette molto — a volte se ne accorge solo quando è finita. Non è indifferenza: è una fiamma che si accende in ritardo, e il tempo tra i due risvegli è la vera prova del legame.'
    },
    ancora: {
      id:       'ancora',
      glyph:    '⚓',
      name:     'UNIONE DELL’ANCORA',
      subtitle: 'Chi tiene e chi vola',
      colors:   ['#4f9d8a', '#12332c'],
      teaser:   'Uno tiene la casa, l’altro tiene l’orizzonte. Finché entrambi sanno di aver scelto il proprio ruolo, è la struttura più stabile che esista. Diventa peso nel momento in cui uno si sente lasciato indietro e l’altro si sente trattenuto.'
    }
  };

  // ════════════════════════════════════════════════════════════
  // THE MATRIX — all 45 unordered pairs of 1–9
  // ════════════════════════════════════════════════════════════

  /**
   * Written out as explicit pair lists rather than derived from a formula.
   * A formula that happened to produce the five reel pairs would be a
   * coincidence waiting to break; this way the five are simply true by
   * construction, and the assignment stays reviewable by eye.
   *
   * The reel's five, pinned:
   *   3+6 → notte_oscura   2+7 → falsa_gemella   1+9 → runner_chaser
   *   4+8 → anime_specchio 1+5 → ritorno
   */
  var MATRIX = {
    // Same number on both sides — one vibration, doubled.
    eco:            [[1,1],[2,2],[3,3],[4,4],[5,5],[6,6],[7,7],[8,8],[9,9]],

    // 5 is the number of departure and return: every pair holding a 5.
    ritorno:        [[1,5],[2,5],[3,5],[4,5],[5,6],[5,7],[5,8],[5,9]],

    // 2 and 6 hold on; 1, 3 and 4 pull towards their own horizon.
    ancora:         [[1,2],[1,6],[2,3],[2,4],[2,6]],

    // Control meeting control: nowhere left to hide.
    anime_specchio: [[1,4],[1,8],[4,7],[4,8]],

    // Duty and endings, where the wound has to open before it closes.
    notte_oscura:   [[3,6],[4,6],[6,8],[7,9]],

    // The ones who want closeness, paired with the one who dissolves.
    runner_chaser:  [[1,9],[2,9],[6,9]],

    // Dependency meeting withdrawal or dominance.
    falsa_gemella:  [[2,7],[2,8],[7,8]],

    // 9 closes cycles: the debt that was already running.
    karmica:        [[3,9],[4,9],[8,9]],

    // 3 burns the old form so a new one can be made.
    trasformazione: [[1,3],[3,4],[3,8]],

    // 7 is the one who recognises it late, or not until it is over.
    dormiente:      [[1,7],[3,7],[6,7]]
  };

  /** Flattened lookup: "a-b" (a <= b) → bond id. Built once at load. */
  var LOOKUP = (function () {
    var map = {};
    Object.keys(MATRIX).forEach(function (bondId) {
      MATRIX[bondId].forEach(function (pair) {
        var lo = Math.min(pair[0], pair[1]);
        var hi = Math.max(pair[0], pair[1]);
        map[lo + '-' + hi] = bondId;
      });
    });
    return map;
  }());

  // ════════════════════════════════════════════════════════════
  // THE SEVEN PHASES
  // ════════════════════════════════════════════════════════════

  var PHASES = [
    { id: 'riconoscimento', name: 'Riconoscimento', text: 'Vi state ancora scoprendo: tutto è nuovo e ogni coincidenza sembra un segno.' },
    { id: 'illusione',      name: 'Illusione',      text: 'State amando anche la versione ideale dell’altro. È la fase più dolce e la più fragile.' },
    { id: 'crisi',          name: 'Crisi',          text: 'Le prime crepe sono venute fuori. Non è la fine: è il punto in cui il legame chiede verità.' },
    { id: 'separazione',    name: 'Separazione',    text: 'Qualcosa vi allontana — nei fatti o dentro. Qui la distanza ha una funzione precisa.' },
    { id: 'resa',           name: 'Resa',           text: 'Avete smesso di combattere per controllare l’altro. Da qui il legame cambia natura.' },
    { id: 'guarigione',     name: 'Guarigione',     text: 'Le vecchie ferite fanno meno rumore. State imparando a stare vicini senza perdervi.' },
    { id: 'ritorno',        name: 'Ritorno',        text: 'Il cerchio si chiude e si riapre più consapevole. Ciò che torna, torna diverso.' }
  ];

  // ════════════════════════════════════════════════════════════
  // PUBLIC API
  // ════════════════════════════════════════════════════════════

  /**
   * Reduces a day of the month to 1–9 — the reel's own arithmetic.
   * 3/12/21/30 → 3, 7/16/25 → 7.
   *
   * Accepts a bare day number or an ISO "YYYY-MM-DD" birth date, because the
   * landing asks for a day while the funnel stores a full date.
   *
   * @param {string|number} dayOrDate
   * @returns {number|null} 1–9, or null when nothing usable was given
   */
  function dayNumber(dayOrDate) {
    var day = null;

    if (typeof dayOrDate === 'number') {
      day = dayOrDate;
    } else if (typeof dayOrDate === 'string') {
      var iso = dayOrDate.match(/^(\d{4})-(\d{2})-(\d{2})/);
      day = iso ? parseInt(iso[3], 10) : parseInt(dayOrDate, 10);
    }

    if (!day || isNaN(day) || day < 1 || day > 31) { return null; }

    while (day > 9) {
      var sum = 0;
      var str = String(day);
      for (var i = 0; i < str.length; i++) { sum += parseInt(str[i], 10); }
      day = sum;
    }
    return day;
  }

  /**
   * The bond for two day numbers. Order does not matter: bondFor(3, 6) and
   * bondFor(6, 3) are the same bond.
   *
   * @param {number} n1 1–9
   * @param {number} n2 1–9
   * @returns {object|null} an entry of BONDS, or null for input outside 1–9
   */
  function bondFor(n1, n2) {
    var a = parseInt(n1, 10);
    var b = parseInt(n2, 10);
    if (!a || !b || a < 1 || a > 9 || b < 1 || b > 9) { return null; }

    var key = Math.min(a, b) + '-' + Math.max(a, b);
    var id  = LOOKUP[key];
    return id ? BONDS[id] : null;
  }

  /**
   * The phase, from the month and year digits of both dates — deliberately the
   * part of the date the day number throws away, so two couples sharing a bond
   * still read differently.
   *
   * @param {string} birth1 ISO "YYYY-MM-DD"
   * @param {string} birth2 ISO "YYYY-MM-DD"
   * @returns {object|null} an entry of PHASES, or null when a date is unusable
   */
  function phaseFor(birth1, birth2) {
    var sum = 0;
    var dates = [birth1, birth2];

    for (var i = 0; i < dates.length; i++) {
      var m = String(dates[i] || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (!m) { return null; }
      var digits = m[1] + m[2];                 // year + month, never the day
      for (var j = 0; j < digits.length; j++) { sum += parseInt(digits[j], 10); }
    }

    return PHASES[((sum - 1) % PHASES.length + PHASES.length) % PHASES.length];
  }

  /**
   * Everything the pages need, from the two full birth dates.
   *
   * @param {string} birth1 ISO "YYYY-MM-DD"
   * @param {string} birth2 ISO "YYYY-MM-DD"
   * @returns {{n1:number, n2:number, bond:object, phase:object}|null}
   */
  function reading(birth1, birth2) {
    var n1 = dayNumber(birth1);
    var n2 = dayNumber(birth2);
    if (!n1 || !n2) { return null; }

    var bond = bondFor(n1, n2);
    if (!bond) { return null; }

    return { n1: n1, n2: n2, bond: bond, phase: phaseFor(birth1, birth2) };
  }

  return {
    BONDS:     BONDS,
    PHASES:    PHASES,
    MATRIX:    MATRIX,
    dayNumber: dayNumber,
    bondFor:   bondFor,
    phaseFor:  phaseFor,
    reading:   reading
  };
}));
