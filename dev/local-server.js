// Локальный сервер без зависимостей: раздаёт public/ и обслуживает POST /api/analyze.
// На Vercel этот файл не используется, там работает api/analyze.js.
// Лежит в dev/, а не в корне: файл server.js в корне Vercel принимает за серверное приложение.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze } from '../lib/gemini.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PUBLIC_DIR = join(ROOT, 'public');
const MAX_BODY_BYTES = 4.5 * 1024 * 1024;

// Читаем .env, если он есть.
const envPath = join(ROOT, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match && !line.trim().startsWith('#') && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
    }
  }
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('too large'), { tooLarge: true }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/api/analyze') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'Используйте POST.' });
    try {
      const body = JSON.parse(await readBody(req));
      const result = await analyze(body);
      return sendJson(res, result.status, result.body);
    } catch (err) {
      if (err.tooLarge) return sendJson(res, 413, { error: 'Запись слишком большая. Сократите её до 10 минут.' });
      if (err instanceof SyntaxError) return sendJson(res, 400, { error: 'Запрос должен быть в формате JSON.' });
      console.error(err);
      return sendJson(res, 500, { error: 'Внутренняя ошибка сервера. Попробуйте ещё раз.' });
    }
  }

  const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const filePath = normalize(join(PUBLIC_DIR, relative));
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + sep)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  try {
    const file = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': TYPES[extname(filePath)] || 'application/octet-stream' });
    res.end(file);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Страница не найдена');
  }
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 3000;
  server.listen(port, () => {
    console.log(`Трибуна запущена: http://localhost:${port}`);
    if (!process.env.GEMINI_API_KEY) console.log('Внимание: GEMINI_API_KEY не задан, разбор работать не будет.');
  });
}
