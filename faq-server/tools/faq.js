const fs = require('fs');
const path = require('path');

// FAQ перечитывается, если файл изменился (правка в панели действует сразу, без рестарта, P-03).
// Проверка — по времени изменения перед каждым поиском; битый файл не применяется, работаем со старым.
const FAQ_PATH = path.join(__dirname, '../data/faq.json');
let faqData = { faq: [] };
let faqMtime = 0;

function currentFaq() {
  let mtime = 0;
  try { mtime = fs.statSync(FAQ_PATH).mtimeMs; } catch (err) { return faqData; }
  if (mtime === faqMtime) return faqData;
  try {
    const next = JSON.parse(fs.readFileSync(FAQ_PATH, 'utf8'));
    if (!Array.isArray(next.faq)) throw new Error('нет списка faq');
    const first = faqMtime === 0;
    faqData = next;
    console.log(`[FAQ] ${first ? 'Loaded' : 'Перечитан'}: ${faqData.faq.length} записей`);
  } catch (err) {
    console.error('[FAQ] faq.json не применён (оставлена прежняя версия):', err.message);
  }
  faqMtime = mtime;
  return faqData;
}
currentFaq();

// Stop words to remove from long phrases (reduces "noise")
const STOP_WORDS = {
  ro: [
    'va', 'este', 'sunt', 'este', 'va rog', 'rog', 'multumesc', 'multumesc anticipat',
    'buna', 'buna ziua', 'salut', 'de', 'la', 'in', 'cu', 'pe', 'pentru', 'sa',
    'si', 'dar', 'ca', 'ce', 'cum', 'cand', 'unde', 'care', 'un', 'o', 'doi', 'trei',
    'imi', 'ma', 'te', 'se', 'ne', 've', 'le', 'din', 'spre', 'pana', 'dupa',
    'mai', 'foarte', 'asa', 'tot', 'toata', 'toti', 'toate', 'acest', 'aceasta',
    'puteti', 'pot', 'poti', 'putem', 'vrea', 'vreau', 'vrei', 'vrem', 'vreti'
  ],
  ru: [
    'это', 'быть', 'есть', 'был', 'была', 'было', 'были', 'пожалуйста', 'спасибо',
    'здравствуйте', 'привет', 'добрый', 'день', 'вечер', 'утро', 'в', 'на', 'с',
    'по', 'для', 'из', 'у', 'к', 'о', 'за', 'и', 'а', 'но', 'как', 'что', 'который',
    'весь', 'этот', 'мой', 'твой', 'наш', 'ваш', 'их', 'один', 'два', 'три',
    'я', 'ты', 'он', 'она', 'мы', 'вы', 'они', 'меня', 'тебя', 'его', 'ее', 'нас',
    'вас', 'их', 'мне', 'тебе', 'ему', 'ей', 'нам', 'вам', 'им', 'не', 'ни',
    'извините', 'извини', 'простите', 'прости', 'скажите', 'подскажите',
    'могли бы', 'мог', 'могу', 'можете', 'можешь', 'хочу', 'хочешь', 'хотите'
  ]
};

// Synonym dictionary for Romanian and Russian
const SYNONYMS = {
  ro: {
    'internet': ['net', 'conexiune', 'retea', 'wifi', 'wi-fi'],
    'nu merge': ['nu functioneaza', 'nu lucreaza', 'nu am', 'pica', 'cade', 'nu porneste', 'pica', 'se intampla'],
    'lent': ['incet', 'merge greu', 'trage greu', 'laguit', 'laggy'],
    'operator': ['persoana', 'om', 'cineva live', 'uman', 'cineva'],
    'program': ['orar', 'ore', 'cand lucrati', 'cand sunteti deschis', 'deschis'],
    'plata': ['platesc', 'achit', 'datorie', 'bani', 'cost', 'pret', 'tarif', 'factura'],
    'contract': ['abonament', 'serviciu', 'pachet', 'anulez', 'anulare'],
    'router': ['modem', 'aparat', 'cutie', 'echipament', 'routerul'],
    'repornesc': ['restart', 'reboot', 'pornesc din nou', 'opresc si pornesc'],
    'telefon': ['numar', 'mobil', 'celular'],
    'adresa': ['locatie', 'unde', 'strada', 'birou', 'gasesc'],
    'tehnician': ['specialist', 'master', 'om tehnic', 'reparator', 'cineva', 'vina', 'verifice'],
    'viteza': ['rapiditate', 'speed', 'megabiti', 'mb', 'gruzit'],
    'parola': ['password', 'cod', 'cheie'],
    'televiziune': ['tv', 'televizor', 'canale', 'iptv'],
    'datorie': ['datorez', 'datorii', 'sold', 'balanta'],
    'reziliere': ['anulez', 'anulare', 'renunt', 'inchide']
  },
  ru: {
    'интернет': ['нет', 'сеть', 'подключение', 'вайфай', 'wifi', 'wi-fi'],
    'не работает': ['не идет', 'нет', 'пропал', 'отключен', 'не могу', 'падает', 'фигня'],
    'медленный': ['тормозит', 'лагает', 'плохая скорость', 'низкая скорость', 'грузит'],
    'оператор': ['человек', 'живой', 'сотрудник', 'живым'],
    'график': ['время работы', 'часы', 'расписание', 'когда работаете'],
    'оплата': ['платить', 'оплатить', 'долг', 'деньги', 'цена', 'тариф', 'стоимость', 'должна', 'должен'],
    'контракт': ['договор', 'абонемент', 'услуга', 'пакет'],
    'роутер': ['модем', 'аппарат', 'коробка', 'оборудование'],
    'перезагрузить': ['перезапустить', 'ребут', 'рестарт', 'выключить и включить', 'ребутнуть'],
    'телефон': ['номер', 'мобильный'],
    'адрес': ['где вы', 'улица', 'офис', 'местонахождение'],
    'техник': ['мастер', 'специалист', 'технический'],
    'скорость': ['быстрота', 'мегабиты', 'мб', 'быстрее', 'побыстрее'],
    'пароль': ['код', 'ключ'],
    'телевидение': ['телик', 'тв', 'телевизор', 'каналы', 'iptv'],
    'долг': ['должна', 'должен', 'задолженность', 'дол']
  }
};

// Normalize text (remove diacritics, lowercase)
function normalize(text) {
  if (!text) return '';
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // remove diacritics
    .replace(/ș/g, 's')
    .replace(/ț/g, 't')
    .replace(/ă/g, 'a')
    .replace(/â/g, 'a')
    .replace(/î/g, 'i')
    .replace(/[^a-z0-9а-яё\s]/gi, ' ') // keep only letters, numbers, spaces
    .replace(/\s+/g, ' ')
    .trim();
}

// Remove stop words from word array
function removeStopWords(words, lang) {
  const stopWords = STOP_WORDS[lang] || [];
  const stopWordsNormalized = new Set(stopWords.map(w => normalize(w)));
  
  return words.filter(word => {
    // Don't remove short important words
    if (word.length <= 2) return true;
    
    // Remove stop words
    return !stopWordsNormalized.has(word);
  });
}

// Expand query with synonyms
function expandWithSynonyms(text, lang) {
  const normalized = normalize(text);
  const words = normalized.split(' ').filter(w => w.length > 0);
  
  // Remove stop words BEFORE expanding
  const cleanWords = removeStopWords(words, lang);
  const expandedWords = new Set(cleanWords);

  if (!SYNONYMS[lang]) return Array.from(expandedWords);

  // For each word, find synonyms
  for (const word of cleanWords) {
    for (const [key, synonyms] of Object.entries(SYNONYMS[lang])) {
      const keyNorm = normalize(key);

      // If word matches key or one of its synonyms
      if (word === keyNorm || synonyms.some(s => normalize(s) === word)) {
        expandedWords.add(keyNorm);
        synonyms.forEach(s => expandedWords.add(normalize(s)));
      }
    }
  }

  return Array.from(expandedWords);
}

// Enhanced keyword matching with weights
function matchKeywords(queryWords, keywords, lang) {
  if (!keywords || !Array.isArray(keywords)) return 0;

  let score = 0;
  const querySet = new Set(queryWords);

  for (const keyword of keywords) {
    const kwNorm = normalize(keyword);
    const kwWords = kwNorm.split(' ').filter(w => w.length > 0);

    // Remove stop words from keywords
    const cleanKwWords = removeStopWords(kwWords, lang);

    // Check for exact phrase match
    if (queryWords.join(' ').includes(kwNorm)) {
      score += cleanKwWords.length * 10; // big bonus for exact phrase match
      continue;
    }

    // Check individual word matches
    let matchedWords = 0;
    for (const kwWord of cleanKwWords) {
      if (querySet.has(kwWord)) {
        matchedWords++;
      }
    }

    // If all words from keyword matched
    if (matchedWords === cleanKwWords.length && cleanKwWords.length > 0) {
      score += cleanKwWords.length * 5; // all words matched
    } else if (matchedWords > 0) {
      score += matchedWords * 2; // partial match
    }
  }

  return score;
}

// Main search function
function searchFAQ(params) {
  const { query, lang = 'ro' } = params;

  if (!query) {
    return { error: true, message: 'Query is required' };
  }

  console.log(`[FAQ] Search: "${query}" (${lang})`);

  // Expand query with synonyms (stop words removed inside)
  const queryWords = expandWithSynonyms(query, lang);
  console.log(`[FAQ] Expanded words: ${queryWords.join(', ')}`);

  let bestMatch = null;
  let bestScore = 0;

  for (const item of currentFaq().faq) {
    const keywords = item.keywords[lang] || item.keywords['ro'] || [];
    const keywordsRequired = item.keywords_required ? (item.keywords_required[lang] || []) : [];

    // Calculate main score
    const mainScore = matchKeywords(queryWords, keywords, lang);

    // Check required keywords
    let requiredScore = 0;
    let hasAllRequired = keywordsRequired.length === 0;

    if (keywordsRequired.length > 0) {
      requiredScore = matchKeywords(queryWords, keywordsRequired, lang);
      hasAllRequired = requiredScore > 0;
    }

    // If there are required keywords but none matched - skip
    if (keywordsRequired.length > 0 && !hasAllRequired) {
      continue;
    }

    // Total score
    let totalScore = mainScore + requiredScore * 3; // required keywords weigh even more

    if (totalScore > bestScore) {
      bestScore = totalScore;
      bestMatch = item;
    }
  }

  // Minimum threshold for match
  const MIN_SCORE = 3;

  if (bestMatch && bestScore >= MIN_SCORE) {
    const answer = bestMatch.answers[lang] || bestMatch.answers['ro'];
    console.log(`[FAQ] Found: ${bestMatch.id} (score: ${bestScore})`);

    return {
      error: false,
      data: {
        found: true,
        id: bestMatch.id,
        answer: answer,
        score: bestScore, // for debugging
        tool: bestMatch.tool || null,
        requires_osmp: bestMatch.requires_osmp || false
      }
    };
  }

  console.log(`[FAQ] No match found (best score: ${bestScore})`);
  return {
    error: false,
    data: {
      found: false,
      answer: null,
      best_score: bestScore // for debugging
    }
  };
}

module.exports = {
  faqCount: () => currentFaq().faq.length,
  searchFAQ: {
    name: 'searchFAQ',
    description: 'Search for answer in FAQ knowledge base with synonym support and stop-word filtering',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'User question' },
        lang: { type: 'string', description: 'Language: ro or ru', default: 'ro' }
      },
      required: ['query']
    },
    execute: searchFAQ
  }
};
