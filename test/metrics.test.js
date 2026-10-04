import test from 'node:test';
import assert from 'node:assert/strict';
import {
  countWords, findFillers, summarizeFillers, formatDuration,
  paceWordsPerMinute, locateQuotes, segmentText,
} from '../public/metrics.js';

test('считает слова на русском, казахском и английском', () => {
  assert.equal(countWords('Привет, как дела?'), 3);
  assert.equal(countWords('Сәлем, қалайсың? Well-known fact.'), 4);
  assert.equal(countWords(''), 0);
});

test('находит слова-паразиты только как отдельные слова', () => {
  const fillers = findFillers('Ну, в общем, это номер. Вот так, как бы.');
  assert.deepEqual(fillers.map((f) => f.word), ['ну', 'в общем', 'вот', 'как бы']);
  assert.equal(findFillers('Внук понял новость').length, 0);
  assert.deepEqual(summarizeFillers(findFillers('ну ну вот'))[0], { word: 'ну', count: 2 });
});

test('форматирует время и темп', () => {
  assert.equal(formatDuration(75), '1:15');
  assert.equal(paceWordsPerMinute(130, 60), 130);
  assert.equal(paceWordsPerMinute(10, 0), 0);
});

test('находит цитаты и делит текст на куски без потерь', () => {
  const text = 'Наш проект очень уникальный. Ну, спасибо за внимание.';
  const ranges = locateQuotes(text, ['«проект очень уникальный»', 'нет такой фразы', 'СПАСИБО за внимание.']);
  assert.deepEqual(ranges.map((r) => r.index), [0, 2]);
  const segments = segmentText(text, ranges, findFillers(text));
  assert.equal(segments.map((s) => s.text).join(''), text);
  assert.deepEqual(segments.filter((s) => s.type !== 'plain').map((s) => s.type), ['mark', 'filler', 'mark']);
});
