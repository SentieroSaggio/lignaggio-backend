/*
   monthlyForecast.js — Lignaggio Plus: the monthly reading a subscription buys.

   The €19/month subscription used to deliver nothing at all. This module is
   what it delivers now: on the 1st of every month each subscriber gets a
   forecast built from their own birth date, in nine sections, with concrete
   things to do rather than atmosphere.

   Two halves, deliberately separated:

     · The anchors are computed HERE, in plain arithmetic — personal year,
       personal month, destiny number, sign, key days. They are deterministic,
       so the same birth date and the same month always produce the same spine,
       and anyone can check them by hand.

     · The prose is written by the model AROUND those anchors. The model is
       never asked to do the arithmetic; it is handed the numbers and told to
       explain them. That is the one rule that keeps a monthly product from
       drifting into horoscope noise.

   Loads in Node only. Depends on nothing but the OpenAI client passed in.
*/

'use strict';

/* ── Section contract ──────────────────────────────────────────────────────
   Nine sections. The order here is the order in the email.

   As with the couple reading, the key list is the single source of truth:
   the system prompt and the closing REQUISITI block are both generated from
   it, so the two can never ask for different things. That mismatch is exactly
   what silently dropped the Fiamme Gemelle sections once already. */
const MONTHLY_SECTION_KEYS = [
  'tema', 'amore', 'energia', 'lavoro',
  'ombra', 'giorni', 'pratica', 'domanda', 'consiglio',
];

const MONTHLY_SECTION_TITLES = {
  tema:      'Il tema del mese',
  amore:     'Amore e relazioni',
  energia:   'Energia e corpo',
  lavoro:    'Lavoro e denaro',
  ombra:     'L’ombra del mese',
  giorni:    'I giorni chiave',
  pratica:   'La pratica del mese',
  domanda:   'La domanda da portarti dietro',
  consiglio: 'Il consiglio di chiusura',
};

const MESI = [
  'gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno',
  'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre',
];

/* Sign boundaries as [month, last day of that sign]. */
const SEGNI = [
  { nome: 'Capricorno',  fino: [1, 19] },  { nome: 'Acquario',   fino: [2, 18] },
  { nome: 'Pesci',       fino: [3, 20] },  { nome: 'Ariete',     fino: [4, 19] },
  { nome: 'Toro',        fino: [5, 20] },  { nome: 'Gemelli',    fino: [6, 20] },
  { nome: 'Cancro',      fino: [7, 22] },  { nome: 'Leone',      fino: [8, 22] },
  { nome: 'Vergine',     fino: [9, 22] },  { nome: 'Bilancia',   fino: [10, 22] },
  { nome: 'Scorpione',   fino: [11, 21] }, { nome: 'Sagittario', fino: [12, 21] },
];

/* ── Arithmetic ────────────────────────────────────────────────────────────── */

/**
 * Reduces to a single digit, keeping 11 and 22 — the two master numbers the
 * couple reading already treats as significant.
 * @param {number} n
 * @returns {number}
 */
function reduceKeepingMasters(n) {
  let v = Math.abs(Math.trunc(n));
  while (v > 9 && v !== 11 && v !== 22) {
    v = String(v).split('').reduce(function (a, d) { return a + Number(d); }, 0);
  }
  return v;
}

/**
 * Reduces all the way to 1–9. Personal year and personal month are always
 * expressed in this range — a "personal month 11" is not a thing.
 * @param {number} n
 * @returns {number}
 */
function reduceToNine(n) {
  let v = Math.abs(Math.trunc(n));
  while (v > 9) {
    v = String(v).split('').reduce(function (a, d) { return a + Number(d); }, 0);
  }
  return v || 9;
}

/**
 * Parses the birth dates this codebase stores. `sessions.partner1_birth` has
 * been written by more than one version of the funnel, so both the ISO form
 * and the Italian form have to be accepted.
 * @param {string} raw  'YYYY-MM-DD' or 'DD/MM/YYYY'
 * @returns {{day: number, month: number, year: number}|null}
 */
function parseBirthDate(raw) {
  const s = String(raw || '').trim();
  if (!s) { return null; }

  let day, month, year;

  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  const ita = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);

  if (iso)      { year = +iso[1]; month = +iso[2]; day = +iso[3]; }
  else if (ita) { day = +ita[1];  month = +ita[2]; year = +ita[3]; }
  else          { return null; }

  if (month < 1 || month > 12 || day < 1 || day > 31) { return null; }
  if (year < 1900 || year > 2100) { return null; }

  return { day: day, month: month, year: year };
}

/**
 * The zodiac sign for a birth date.
 * @param {number} day
 * @param {number} month
 * @returns {string}
 */
function segnoZodiacale(day, month) {
  const i = month - 1;
  const s = SEGNI[i];
  return day <= s.fino[1] ? s.nome : SEGNI[(i + 1) % 12].nome;
}

/**
 * The days of the target month whose own reduced number matches the personal
 * month. Deterministic, and the reason "giorni chiave" can be stated as fact
 * rather than invented afresh on every generation.
 * @param {number} mesePersonale  1–9
 * @param {number} year
 * @param {number} month  1–12
 * @returns {number[]}
 */
function giorniChiave(mesePersonale, year, month) {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const out = [];
  for (let d = 1; d <= lastDay; d++) {
    if (reduceToNine(d) === mesePersonale) { out.push(d); }
  }
  return out.slice(0, 4);
}

/**
 * Everything the prose is allowed to lean on, computed once.
 *
 * @param {string} birthDate   the subscriber's birth date
 * @param {string} period      'YYYY-MM' — the month being forecast
 * @returns {object|null}      null when the birth date or period cannot be read
 */
function computeAnchors(birthDate, period) {
  const b = parseBirthDate(birthDate);
  if (!b) { return null; }

  const m = String(period || '').match(/^(\d{4})-(\d{2})$/);
  if (!m) { return null; }
  const year  = +m[1];
  const month = +m[2];
  if (month < 1 || month > 12) { return null; }

  const digits = String(b.year) +
                 String(b.month).padStart(2, '0') +
                 String(b.day).padStart(2, '0');
  const destino = reduceKeepingMasters(
    digits.split('').reduce(function (a, d) { return a + Number(d); }, 0)
  );

  const annoPersonale = reduceToNine(b.day + b.month + year);
  const mesePersonale = reduceToNine(annoPersonale + month);

  return {
    birthDate:     birthDate,
    period:        period,
    year:          year,
    month:         month,
    meseNome:      MESI[month - 1],
    destino:       destino,
    annoPersonale: annoPersonale,
    mesePersonale: mesePersonale,
    segno:         segnoZodiacale(b.day, b.month),
    giorniChiave:  giorniChiave(mesePersonale, year, month),
  };
}

/* ── Prompt ────────────────────────────────────────────────────────────────── */

const MONTHLY_SYSTEM_PROMPT = [
  'Sei un esperto di Matrice del Destino, numerologia e astrologia. Scrivi la lettura mensile personale di Lignaggio Plus: un abbonato la riceve il primo giorno di ogni mese e la usa per orientarsi nelle quattro settimane che ha davanti.',
  '',
  'REGOLE NON NEGOZIABILI:',
  '- I numeri ti vengono FORNITI già calcolati. Non ricalcolarli, non contraddirli, non inventarne altri. Il tuo lavoro è spiegare che cosa significano per questo mese.',
  '- Ogni sezione è ancorata a uno dei numeri forniti e lo cita esplicitamente.',
  '- Dai indicazioni CONCRETE ed eseguibili: che cosa fare, quando, con chi. Mai consigli generici che varrebbero per chiunque.',
  '- Parla direttamente all’abbonato, con il "tu". Tono adulto, caldo, diretto.',
  '- Non è un oroscopo: è un metodo di autoconoscenza. Non promettere eventi certi — descrivi tendenze e scelte. Mai fatalismo, mai previsioni di sventura, mai promesse di ricchezza o di guarigione.',
  '- Nessun consiglio medico, legale o finanziario. Nessuna diagnosi, nessuna raccomandazione di investimento.',
  '- Italiano naturale e scorrevole. Dentro le sezioni si scrive in prosa: niente elenchi puntati, niente markdown.',
  '- Ogni sezione: 90–150 parole. La sezione "giorni" può essere più breve.',
  '',
  'Rispondi SOLO con JSON valido, esattamente ' + MONTHLY_SECTION_KEYS.length +
    ' chiavi: ' + MONTHLY_SECTION_KEYS.join(', ') + '.',
].join('\n');

/**
 * The user half of the prompt. Built from the same key list as the system
 * half, so the two can never ask for a different number of sections.
 * @param {object} anchors  from computeAnchors()
 * @param {string} [name]
 * @returns {string}
 */
function buildMonthlyPrompt(anchors, name) {
  const chi = name ? String(name).trim() : '';
  const giorni = anchors.giorniChiave.length
    ? anchors.giorniChiave.join(', ')
    : 'nessun giorno in risonanza esatta questo mese';

  return [
    'Lettura mensile per ' + (chi || 'l’abbonato') + ' — ' + anchors.meseNome + ' ' + anchors.year + '.',
    '',
    'NUMERI GIÀ CALCOLATI (usali così come sono):',
    '- Data di nascita: ' + anchors.birthDate,
    '- Segno zodiacale: ' + anchors.segno,
    '- Numero del Destino: ' + anchors.destino,
    '- Anno Personale ' + anchors.year + ': ' + anchors.annoPersonale,
    '- Mese Personale (' + anchors.meseNome + '): ' + anchors.mesePersonale,
    '- Giorni chiave del mese: ' + giorni,
    '',
    'SEZIONI DA SCRIVERE:',
    '',
    'tema — Il tema del mese. Che cosa chiede il Mese Personale ' + anchors.mesePersonale +
      ' dentro l’Anno Personale ' + anchors.annoPersonale + '. Apri citando i due numeri e di’ in una frase che cosa questo mese vuole da ' + (chi || 'chi legge') + '.',
    '',
    'amore — Amore e relazioni. Come il Mese Personale ' + anchors.mesePersonale +
      ' si muove nei legami: coppia, famiglia, amicizie. Una dinamica precisa da riconoscere e una cosa da dire o da fare entro il mese.',
    '',
    'energia — Energia e corpo. Il ritmo fisico ed emotivo del mese secondo il numero ' + anchors.mesePersonale +
      ' e il temperamento del ' + anchors.segno + '. Quando spingere e quando fermarsi.',
    '',
    'lavoro — Lavoro e denaro. Che tipo di mese è per decisioni, progetti e spese. Che cosa conviene aprire e che cosa conviene rimandare. Nessun consiglio di investimento.',
    '',
    'ombra — L’ombra del mese. Lo schema in cui il Numero del Destino ' + anchors.destino +
      ' rischia di cadere proprio in un mese ' + anchors.mesePersonale + '. Diretto ma non colpevolizzante, e con l’uscita indicata.',
    '',
    'giorni — I giorni chiave. I giorni ' + giorni +
      ' e a che cosa servono: quali conversazioni, decisioni o pause collocarci. Concreto e breve.',
    '',
    'pratica — La pratica del mese. UN esercizio solo, eseguibile, con durata e momento della giornata. Deve nascere dal tema del mese, non essere un generico esercizio di benessere.',
    '',
    'domanda — La domanda da portarti dietro. Una sola domanda, formulata in modo che rileggerla a metà mese abbia senso. Spiega in poche righe perché è questa.',
    '',
    'consiglio — Il consiglio di chiusura. Tre o quattro frasi che chiudono il mese e lasciano qualcosa da ricordare.',
    '',
    'REQUISITI FINALI:',
    '- Rispondi SOLO con JSON valido, esattamente ' + MONTHLY_SECTION_KEYS.length +
      ' chiavi: ' + MONTHLY_SECTION_KEYS.join(', ') + '.',
    '- Ogni valore è una stringa di prosa italiana. Nessun markdown, nessun elenco puntato.',
    '- Non ricalcolare i numeri: sono già corretti.',
  ].join('\n');
}

/* ── Generation ────────────────────────────────────────────────────────────── */

/**
 * Generates one monthly forecast.
 *
 * @param {object} openai   an OpenAI client
 * @param {object} anchors  from computeAnchors()
 * @param {string} [name]
 * @returns {Promise<object>}  one string per key in MONTHLY_SECTION_KEYS
 * @throws when the model returns something that is not a usable forecast
 */
async function generateMonthlyForecast(openai, anchors, name) {
  const response = await openai.chat.completions.create({
    model:                 'gpt-5.4',
    response_format:       { type: 'json_object' },
    temperature:           0.7,
    max_completion_tokens: 4000,
    messages: [
      { role: 'system', content: MONTHLY_SYSTEM_PROMPT },
      { role: 'user',   content: buildMonthlyPrompt(anchors, name) },
    ],
  });

  const parsed = JSON.parse(response.choices[0].message.content);

  /* A forecast missing its opening or its closing is not worth sending — the
     email would arrive looking broken. Missing middle sections are tolerated
     the way the couple reading tolerates a missing `esercizi`: the renderer
     skips whatever is absent. */
  for (const key of ['tema', 'consiglio']) {
    if (!parsed[key] || typeof parsed[key] !== 'string') {
      throw new Error('monthly forecast is missing the "' + key + '" section');
    }
  }

  return parsed;
}

module.exports = {
  MONTHLY_SECTION_KEYS,
  MONTHLY_SECTION_TITLES,
  MESI,
  reduceKeepingMasters,
  reduceToNine,
  parseBirthDate,
  segnoZodiacale,
  giorniChiave,
  computeAnchors,
  buildMonthlyPrompt,
  generateMonthlyForecast,
  MONTHLY_SYSTEM_PROMPT,
};
