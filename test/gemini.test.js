import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze, validateInput, buildRequest, InputError, LIMITS } from '../lib/gemini.js';

const longText = 'Здравствуйте, меня зовут Алия, и сегодня я расскажу о нашем школьном проекте подробно и по порядку.';

const fakeFetch = (payload, status = 200) => async (url, init) => {
  fakeFetch.last = { url, init };
  return { ok: status < 400, status, json: async () => payload };
};

const answer = (obj) => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] });

test('отклоняет короткий текст и неизвестный режим', () => {
  assert.throws(() => validateInput({ mode: 'text', text: 'коротко' }), InputError);
  assert.throws(() => validateInput({ mode: 'video' }), InputError);
  assert.throws(() => validateInput({ mode: 'audio', audio: 'AAAA', mimeType: 'video/mp4' }), InputError);
  assert.throws(() => validateInput({ mode: 'audio', audio: 'A'.repeat(LIMITS.maxAudioBase64Chars + 4), mimeType: 'audio/webm' }), InputError);
});

test('собирает запрос с аудио и убирает параметры кодека', () => {
  const input = validateInput({ mode: 'audio', audio: 'AAAA', mimeType: 'audio/webm;codecs=opus', language: 'kk' });
  const request = buildRequest(input);
  assert.deepEqual(request.contents[0].parts[1], { inline_data: { mime_type: 'audio/webm', data: 'AAAA' } });
  assert.match(request.contents[0].parts[0].text, /казахском/);
});

test('без ключа возвращает понятную ошибку', async () => {
  const result = await analyze({ mode: 'text', text: longText }, {}, fakeFetch({}));
  assert.equal(result.status, 500);
  assert.match(result.body.error, /GEMINI_API_KEY/);
});

test('приводит ответ модели к нужному виду', async () => {
  const fetchImpl = fakeFetch(answer({
    transcript: '', summary: ' Неплохо. ', overall: 140,
    scores: { structure: 7, clarity: 11, persuasion: 0, language: 6, delivery: 0 },
    strengths: ['Хорошее начало', ''],
    weaknesses: [{ title: 'Нет цифр', quote: 'о нашем школьном проекте', why: 'Общо', fix: 'Добавьте цифру', rewrite: '' }, { title: '', fix: '' }],
    exercises: ['Упражнение'],
  }));
  const result = await analyze({ mode: 'text', text: longText }, { GEMINI_API_KEY: 'k', GEMINI_MODEL: 'm' }, fetchImpl);
  assert.equal(result.status, 200);
  assert.equal(result.body.overall, 100);
  assert.equal(result.body.transcript, longText);
  assert.deepEqual(result.body.scores, { structure: 7, clarity: 10, persuasion: 1, language: 6, delivery: null });
  assert.equal(result.body.weaknesses.length, 1);
  assert.equal(result.body.strengths.length, 1);
  assert.match(fakeFetch.last.url, /models\/m:generateContent$/);
  assert.equal(fakeFetch.last.init.headers['x-goog-api-key'], 'k');
});

test('сообщает о лимите и о неподходящем формате записи', async () => {
  const env = { GEMINI_API_KEY: 'k' };
  const limited = await analyze({ mode: 'text', text: longText }, env, fakeFetch({ error: { message: 'quota' } }, 429));
  assert.equal(limited.status, 429);
  const format = await analyze({ mode: 'audio', audio: 'AAAA', mimeType: 'audio/webm' }, env,
    fakeFetch({ error: { message: 'Unsupported MIME type: audio/webm' } }, 400));
  assert.equal(format.body.code, 'AUDIO_FORMAT');
});
