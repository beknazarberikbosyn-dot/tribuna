import {
  countWords, findFillers, summarizeFillers, formatDuration,
  paceWordsPerMinute, describePace, locateQuotes, segmentText,
} from './metrics.js';

const MAX_RECORD_SECONDS = 600;
const MIN_TEXT_CHARS = 80;
const DRAFT_KEY = 'tribuna-draft';

const $ = (id) => document.getElementById(id);
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const ui = {
  tabText: $('tab-text'), tabAudio: $('tab-audio'),
  panelText: $('panel-text'), panelAudio: $('panel-audio'),
  textarea: $('speech-text'), textCount: $('text-count'), textFile: $('text-file'),
  recorder: $('recorder'), recordButton: $('record-button'), recorderStatus: $('recorder-status'),
  meter: $('meter'), timer: $('timer'), playback: $('playback'), player: $('player'),
  recordAgain: $('record-again'), context: $('context'), language: $('language'),
  analyze: $('analyze-button'), notice: $('notice'), result: $('result'),
};

let mode = 'text';
let busy = false;
const recording = { recorder: null, stream: null, chunks: [], blob: null, seconds: 0, startedAt: 0, timerId: 0, frameId: 0, audioContext: null };

/* ---------- Переключение режима ---------- */

function setMode(next) {
  mode = next;
  const isText = next === 'text';
  ui.tabText.setAttribute('aria-selected', String(isText));
  ui.tabAudio.setAttribute('aria-selected', String(!isText));
  ui.tabText.tabIndex = isText ? 0 : -1;
  ui.tabAudio.tabIndex = isText ? -1 : 0;
  ui.panelText.hidden = !isText;
  ui.panelAudio.hidden = isText;
  ui.analyze.textContent = isText ? 'Разобрать речь' : 'Разобрать запись';
  setNotice('');
}

ui.tabText.addEventListener('click', () => setMode('text'));
ui.tabAudio.addEventListener('click', () => setMode('audio'));
for (const tab of [ui.tabText, ui.tabAudio]) {
  tab.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    const other = tab === ui.tabText ? ui.tabAudio : ui.tabText;
    other.focus();
    other.click();
  });
}

/* ---------- Текст ---------- */

function pluralWords(n) {
  const mod10 = n % 10, mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'слово';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'слова';
  return 'слов';
}

function updateTextCount() {
  const words = countWords(ui.textarea.value);
  const minutes = words / 130;
  ui.textCount.textContent = words
    ? `${words} ${pluralWords(words)}, примерно ${formatDuration(minutes * 60)} вслух`
    : '0 слов';
}

ui.textarea.addEventListener('input', () => {
  updateTextCount();
  try { localStorage.setItem(DRAFT_KEY, ui.textarea.value); } catch { /* хранилище недоступно */ }
});

ui.textFile.addEventListener('change', async () => {
  const file = ui.textFile.files?.[0];
  if (!file) return;
  if (file.size > 200_000) {
    setNotice('Файл слишком большой. Загрузите текстовый файл до 200 КБ.', 'error');
  } else {
    ui.textarea.value = (await file.text()).trim();
    ui.textarea.dispatchEvent(new Event('input'));
    setNotice(`Загружен файл ${file.name}.`);
  }
  ui.textFile.value = '';
});

try {
  const draft = localStorage.getItem(DRAFT_KEY);
  if (draft) ui.textarea.value = draft;
} catch { /* хранилище недоступно */ }
updateTextCount();

/* ---------- Запись голоса ---------- */

function pickRecorderType() {
  const options = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
  return options.find((type) => window.MediaRecorder?.isTypeSupported?.(type)) || '';
}

function drawMeter(analyser) {
  const canvas = ui.meter;
  const ctx = canvas.getContext('2d');
  const data = new Uint8Array(analyser.frequencyBinCount);
  const bars = 48;
  const draw = () => {
    analyser.getByteFrequencyData(data);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const step = Math.floor((data.length * 0.6) / bars);
    const barWidth = canvas.width / bars;
    for (let i = 0; i < bars; i++) {
      let sum = 0;
      for (let j = 0; j < step; j++) sum += data[i * step + j];
      const level = sum / step / 255;
      const height = Math.max(3, level * canvas.height);
      ctx.fillStyle = level > 0.55 ? '#ffd84a' : '#ffffff';
      ctx.fillRect(i * barWidth + 2, (canvas.height - height) / 2, barWidth - 4, height);
    }
    recording.frameId = requestAnimationFrame(draw);
  };
  draw();
}

function clearMeter() {
  cancelAnimationFrame(recording.frameId);
  const ctx = ui.meter.getContext('2d');
  ctx.clearRect(0, 0, ui.meter.width, ui.meter.height);
}

async function startRecording() {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    setNotice('Этот браузер не умеет записывать звук. Откройте сайт в Chrome, Edge, Firefox или Safari.', 'error');
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch {
    setNotice('Нет доступа к микрофону. Разрешите его в настройках браузера и попробуйте ещё раз.', 'error');
    return;
  }

  const mimeType = pickRecorderType();
  const recorder = new MediaRecorder(stream, { ...(mimeType && { mimeType }), audioBitsPerSecond: 32000 });
  recording.recorder = recorder;
  recording.stream = stream;
  recording.chunks = [];
  recording.blob = null;

  recorder.addEventListener('dataavailable', (event) => { if (event.data.size) recording.chunks.push(event.data); });
  recorder.addEventListener('stop', finishRecording);

  recording.audioContext = new AudioContext();
  const analyser = recording.audioContext.createAnalyser();
  analyser.fftSize = 512;
  recording.audioContext.createMediaStreamSource(stream).connect(analyser);
  drawMeter(analyser);

  recorder.start(1000);
  recording.startedAt = performance.now();
  recording.timerId = setInterval(() => {
    const seconds = (performance.now() - recording.startedAt) / 1000;
    ui.timer.textContent = formatDuration(seconds);
    if (seconds >= MAX_RECORD_SECONDS) stopRecording();
  }, 250);

  ui.recorder.dataset.state = 'recording';
  ui.recordButton.setAttribute('aria-label', 'Остановить запись');
  ui.recorderStatus.textContent = 'Идёт запись. Говорите так, как будете выступать. Нажмите на кнопку, когда закончите.';
  ui.playback.hidden = true;
  setNotice('');
}

function stopRecording() {
  if (recording.recorder?.state === 'recording') recording.recorder.stop();
}

function finishRecording() {
  clearInterval(recording.timerId);
  clearMeter();
  recording.seconds = (performance.now() - recording.startedAt) / 1000;
  recording.stream?.getTracks().forEach((track) => track.stop());
  recording.audioContext?.close();

  recording.blob = new Blob(recording.chunks, { type: recording.recorder.mimeType || 'audio/webm' });
  ui.timer.textContent = formatDuration(recording.seconds);
  ui.player.src = URL.createObjectURL(recording.blob);
  ui.playback.hidden = false;
  ui.recorder.dataset.state = 'done';
  ui.recordButton.setAttribute('aria-label', 'Запись готова');
  ui.recorderStatus.textContent = 'Запись готова. Послушайте её или сразу отправьте на разбор.';
}

function resetRecording() {
  if (ui.player.src) URL.revokeObjectURL(ui.player.src);
  ui.player.removeAttribute('src');
  recording.blob = null;
  recording.seconds = 0;
  ui.playback.hidden = true;
  ui.timer.textContent = '0:00';
  ui.recorder.dataset.state = 'idle';
  ui.recordButton.setAttribute('aria-label', 'Начать запись');
  ui.recorderStatus.textContent = 'Нажмите на кнопку и говорите. Запись до 10 минут.';
}

ui.recordButton.addEventListener('click', () => {
  if (ui.recorder.dataset.state === 'recording') stopRecording();
  else if (ui.recorder.dataset.state === 'idle') startRecording();
});
ui.recordAgain.addEventListener('click', resetRecording);

/* ---------- Подготовка аудио ---------- */

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function normalizeMime(type) {
  const base = (type || 'audio/webm').split(';')[0].trim().toLowerCase();
  return base === 'audio/mp4' || base === 'audio/x-m4a' ? 'audio/m4a' : base;
}

// Запасной путь: если Gemini не принял формат браузера, перекодируем запись в WAV 16 кГц моно.
async function blobToWav(blob) {
  const context = new AudioContext();
  try {
    const decoded = await context.decodeAudioData(await blob.arrayBuffer());
    const rate = 16000;
    const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * rate), rate);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    const samples = (await offline.startRendering()).getChannelData(0);

    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);
    const writeText = (offset, text) => { for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i)); };
    writeText(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true); writeText(8, 'WAVE');
    writeText(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    writeText(36, 'data'); view.setUint32(40, samples.length * 2, true);
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return new Blob([buffer], { type: 'audio/wav' });
  } finally {
    context.close();
  }
}

/* ---------- Запрос на разбор ---------- */

function setNotice(text, kind = '') {
  ui.notice.textContent = text;
  ui.notice.dataset.kind = kind;
}

function setBusy(value, label) {
  busy = value;
  ui.analyze.disabled = value;
  if (value) ui.analyze.textContent = label || 'Разбираю…';
  else ui.analyze.textContent = mode === 'text' ? 'Разобрать речь' : 'Разобрать запись';
}

async function postAnalyze(payload) {
  let response;
  try {
    response = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    throw new Error('Нет связи с сервером. Проверьте интернет и попробуйте ещё раз.');
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(data?.error || (response.status === 413
      ? 'Запись слишком большая. Сократите её до 10 минут.'
      : 'Сервер не ответил. Попробуйте ещё раз.'));
    error.code = data?.code;
    throw error;
  }
  return data;
}

async function analyze() {
  if (busy) return;
  const common = { language: ui.language.value, context: ui.context.value.trim() };

  try {
    let result;
    let seconds = 0;

    if (mode === 'text') {
      const text = ui.textarea.value.trim();
      if (text.length < MIN_TEXT_CHARS) {
        setNotice('Добавьте текст выступления: нужно хотя бы пара предложений.', 'error');
        ui.textarea.focus();
        return;
      }
      setBusy(true);
      setNotice('Gemini читает вашу речь. Обычно это занимает до 20 секунд.');
      result = await postAnalyze({ mode: 'text', text, ...common });
    } else {
      if (ui.recorder.dataset.state === 'recording') {
        setNotice('Сначала остановите запись.', 'error');
        return;
      }
      if (!recording.blob) {
        setNotice('Сначала запишите речь: нажмите на красную кнопку.', 'error');
        ui.recordButton.focus();
        return;
      }
      if (recording.seconds < 5) {
        setNotice('Запись слишком короткая. Говорите хотя бы 5 секунд.', 'error');
        return;
      }
      seconds = recording.seconds;
      setBusy(true);
      setNotice('Gemini слушает запись. Обычно это занимает до минуты.');
      try {
        result = await postAnalyze({
          mode: 'audio',
          audio: await blobToBase64(recording.blob),
          mimeType: normalizeMime(recording.blob.type),
          ...common,
        });
      } catch (error) {
        if (error.code !== 'AUDIO_FORMAT') throw error;
        const wav = await blobToWav(recording.blob);
        result = await postAnalyze({ mode: 'audio', audio: await blobToBase64(wav), mimeType: 'audio/wav', ...common });
      }
    }

    renderResult(result, seconds);
    setNotice('Разбор готов.');
  } catch (error) {
    setNotice(error.message || 'Что-то пошло не так. Попробуйте ещё раз.', 'error');
  } finally {
    setBusy(false);
  }
}

ui.analyze.addEventListener('click', analyze);

/* ---------- Показ разбора ---------- */

const SCORE_LABELS = {
  structure: 'Структура',
  clarity: 'Ясность',
  persuasion: 'Убедительность',
  language: 'Язык',
  delivery: 'Подача голосом',
};

function addFact(list, label, value) {
  const row = el('div');
  row.append(el('dt', '', label), el('dd', '', value));
  list.append(row);
}

function activateWeakness(index, scrollTarget) {
  document.querySelectorAll('.weakness.is-active, mark.is-active').forEach((node) => node.classList.remove('is-active'));
  const card = document.querySelector(`.weakness[data-index="${index}"]`);
  const mark = document.querySelector(`mark[data-index="${index}"]`);
  card?.classList.add('is-active');
  mark?.classList.add('is-active');
  const target = scrollTarget === 'card' ? card : mark;
  target?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function renderResult(result, seconds) {
  const transcript = result.transcript || '';
  const words = countWords(transcript);
  const fillers = findFillers(transcript);
  const isAudio = result.mode === 'audio';

  $('overall').textContent = result.overall;
  $('summary').textContent = result.summary;

  // Факты, посчитанные без ИИ
  const facts = $('facts');
  facts.replaceChildren();
  addFact(facts, 'Слов', String(words));
  if (isAudio) {
    addFact(facts, 'Длительность', formatDuration(seconds));
    const pace = paceWordsPerMinute(words, seconds);
    if (pace) addFact(facts, 'Темп', `${pace} слов в минуту, ${describePace(pace)}`);
  } else {
    addFact(facts, 'Время вслух', `около ${formatDuration((words / 130) * 60)}`);
  }
  const fillerSummary = summarizeFillers(fillers);
  addFact(facts, 'Возможные слова-паразиты', fillerSummary.length
    ? `${fillers.length}: ${fillerSummary.slice(0, 5).map((f) => `«${f.word}» ${f.count}`).join(', ')}`
    : 'не найдены');

  // Оценки
  const scores = $('scores');
  scores.replaceChildren();
  for (const [key, label] of Object.entries(SCORE_LABELS)) {
    const value = result.scores[key];
    if (value === null || value === undefined) continue;
    const item = el('div', 'score');
    const head = el('div', 'score-head');
    head.append(el('span', '', label), el('span', 'score-value', `${value} из 10`));
    const track = el('div', 'score-track');
    const fill = el('div', 'score-fill');
    fill.style.width = `${value * 10}%`;
    track.append(fill);
    item.append(head, track);
    scores.append(item);
  }

  // Речь с пометками
  $('manuscript-title').textContent = isAudio ? 'Расшифровка с пометками' : 'Ваша речь с пометками';
  const manuscript = $('manuscript');
  manuscript.replaceChildren();
  const ranges = locateQuotes(transcript, result.weaknesses.map((w) => w.quote));
  for (const segment of segmentText(transcript, ranges, fillers)) {
    if (segment.type === 'mark') {
      const mark = el('mark', '', segment.text);
      mark.dataset.index = segment.index;
      mark.tabIndex = 0;
      mark.setAttribute('role', 'button');
      mark.setAttribute('aria-label', `Замечание ${segment.index + 1}: ${segment.text}`);
      const open = () => activateWeakness(segment.index, 'card');
      mark.addEventListener('click', open);
      mark.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); } });
      manuscript.append(mark);
    } else if (segment.type === 'filler') {
      manuscript.append(el('span', 'filler', segment.text));
    } else {
      manuscript.append(segment.text);
    }
  }

  // Слабые стороны
  const weaknesses = $('weaknesses');
  weaknesses.replaceChildren();
  result.weaknesses.forEach((weakness, index) => {
    const card = el('li', 'weakness');
    card.dataset.index = index;
    card.append(el('p', 'weakness-title', weakness.title));
    if (weakness.quote) card.append(el('p', 'weakness-quote', weakness.quote));
    if (weakness.why) card.append(el('p', '', weakness.why));
    const fix = el('p');
    fix.append(el('span', 'weakness-label', 'Как исправить: '), weakness.fix);
    card.append(fix);
    if (weakness.rewrite) {
      const rewrite = el('p', 'weakness-rewrite');
      rewrite.append(el('span', 'weakness-label', 'Например: '), weakness.rewrite);
      card.append(rewrite);
    }
    if (ranges.some((r) => r.index === index)) {
      card.addEventListener('click', () => activateWeakness(index, 'mark'));
      card.style.cursor = 'pointer';
    }
    weaknesses.append(card);
  });

  const fillList = (id, items) => {
    const node = $(id);
    node.replaceChildren(...items.map((item) => el('li', '', item)));
    node.previousElementSibling.hidden = items.length === 0;
    node.hidden = items.length === 0;
  };
  fillList('strengths', result.strengths);
  fillList('exercises', result.exercises);

  ui.result.hidden = false;
  ui.result.focus({ preventScroll: true });
  ui.result.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Для проверки вёрстки без ключа: /?demo показывает разбор на примере.
if (new URLSearchParams(location.search).has('demo')) {
  import('./demo.js').then(({ demoResult }) => renderResult(demoResult, 0));
}
