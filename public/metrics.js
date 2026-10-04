// Подсчёты, которые делаются в браузере без ИИ: слова, темп, слова-паразиты, места для пометок.

const FILLERS = [
  // русский
  'ну', 'вот', 'как бы', 'типа', 'короче', 'в общем', 'в принципе', 'так сказать',
  'это самое', 'на самом деле', 'собственно', 'значит', 'э', 'ээ', 'эээ', 'эм', 'мм', 'ммм',
  // қазақша
  'жаңағы', 'әлгі', 'нетіп',
  // english
  'um', 'uh', 'er', 'you know', 'basically', 'kind of', 'sort of',
];

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Сначала длинные выражения, чтобы «в общем» не распалось на части.
const FILLER_PATTERN = new RegExp(
  `(?<![\\p{L}\\p{N}])(${[...FILLERS].sort((a, b) => b.length - a.length).map(escapeRegExp).join('|')})(?![\\p{L}\\p{N}])`,
  'giu',
);

export function countWords(text) {
  return (text.match(/[\p{L}\p{N}]+(?:[-'’][\p{L}\p{N}]+)*/gu) || []).length;
}

/** Возвращает места слов-паразитов: [{ start, end, word }]. */
export function findFillers(text) {
  const found = [];
  for (const match of text.matchAll(FILLER_PATTERN)) {
    found.push({ start: match.index, end: match.index + match[0].length, word: match[0].toLowerCase() });
  }
  return found;
}

/** Сводка по словам-паразитам: [{ word, count }] по убыванию. */
export function summarizeFillers(fillers) {
  const counts = new Map();
  for (const f of fillers) counts.set(f.word, (counts.get(f.word) || 0) + 1);
  return [...counts].map(([word, count]) => ({ word, count })).sort((a, b) => b.count - a.count);
}

export function formatDuration(seconds) {
  const total = Math.max(0, Math.round(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** Слов в минуту. Для текста длительность оцениваем по спокойному темпу 130 слов в минуту. */
export function paceWordsPerMinute(words, seconds) {
  if (!seconds || seconds < 1) return 0;
  return Math.round((words / seconds) * 60);
}

export function describePace(wpm) {
  if (!wpm) return '';
  if (wpm < 100) return 'медленно';
  if (wpm <= 150) return 'спокойный темп';
  if (wpm <= 175) return 'быстро';
  return 'слишком быстро';
}

/**
 * Ищет цитаты из замечаний в тексте речи.
 * Возвращает непересекающиеся отрезки [{ start, end, index }], где index это номер замечания.
 */
export function locateQuotes(text, quotes) {
  const lower = text.toLowerCase();
  const ranges = [];
  quotes.forEach((quote, index) => {
    const needle = (quote || '').trim().replace(/^[«"“„']+|[»"”'.…]+$/g, '');
    if (needle.length < 3) return;
    let start = text.indexOf(needle);
    if (start === -1) start = lower.indexOf(needle.toLowerCase());
    if (start === -1) return;
    const end = start + needle.length;
    if (ranges.some((r) => start < r.end && end > r.start)) return;
    ranges.push({ start, end, index });
  });
  return ranges.sort((a, b) => a.start - b.start);
}

/**
 * Делит текст на куски для показа: обычный текст, пометки замечаний и слова-паразиты.
 * Возвращает [{ text, type: 'plain' | 'mark' | 'filler', index? }].
 */
export function segmentText(text, quoteRanges, fillers) {
  const spans = quoteRanges.map((r) => ({ ...r, type: 'mark' }));
  for (const f of fillers) {
    if (!spans.some((s) => f.start < s.end && f.end > s.start)) spans.push({ ...f, type: 'filler' });
  }
  spans.sort((a, b) => a.start - b.start);

  const segments = [];
  let cursor = 0;
  for (const span of spans) {
    if (span.start > cursor) segments.push({ text: text.slice(cursor, span.start), type: 'plain' });
    segments.push({ text: text.slice(span.start, span.end), type: span.type, index: span.index });
    cursor = span.end;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), type: 'plain' });
  return segments;
}
