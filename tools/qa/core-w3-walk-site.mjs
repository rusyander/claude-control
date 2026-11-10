/**
 * Сеть сквозного обхода волны 3 (`check-core-w3-cross-zone-live.mjs`): всё на этой машине, ничего
 * настоящего снаружи.
 *   - `startW3Site()` — стенд проекта на 127.0.0.1: `/login` (подписи «User», «Password», кнопка
 *     «Sign in»; `numberMode` делает поле пароля числовым — так прогон записи падает на вводе
 *     доступа), `POST /welcome` печатает sha256 пароля (`data-testid="hash"`), `/away?to=` — 302,
 *     `/link?to=` — ссылка «Go», `/amount` — числовое поле «Amount». Счёт запросов по пути.
 *   - `startForeignCounter()` — «чужой сайт» на адресе сети этой машины (не петля, не стенд
 *     проекта): ворота источника обязаны не пустить к нему ни одного запроса; на петле его
 *     пропустило бы правило «loopback разрешён», и ноль ничего бы не доказывал.
 *   - `startFakeExpo()` — поддельный сервис push Expo: каждое сообщение — в список.
 */
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';

const page = (title, body) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;

export const sha256 = (text) => createHash('sha256').update(text).digest('hex');

const listen = (server, host) =>
  new Promise((done) => server.listen(0, host, () => done(server.address().port)));
const closer = (server) => () =>
  new Promise((done) => {
    server.closeAllConnections?.();
    server.close(() => done());
  });

export async function startW3Site(label = 'stand') {
  const state = { numberMode: false, hits: new Map(), hashes: [] };
  const server = createServer((req, res) => {
    const [path, query = ''] = (req.url ?? '/').split('?');
    state.hits.set(path, (state.hits.get(path) ?? 0) + 1);
    const html = (body) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(body);
    };
    if (req.method === 'POST' && path === '/welcome') {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk.toString('utf8')));
      req.on('end', () => {
        const password = new URLSearchParams(raw).get('password') ?? '';
        // Только отпечаток введённого: само значение доступа проверка не хранит нигде.
        state.hashes.push(sha256(password));
        html(
          page('Welcome', `<h1>Welcome ${label}</h1><p data-testid="hash">${sha256(password)}</p>`),
        );
      });
      return;
    }
    const to = new URLSearchParams(query).get('to') ?? '/';
    if (path === '/away') {
      res.writeHead(302, { location: to });
      res.end();
      return;
    }
    if (path === '/link') {
      const href = to.replace(/[&"<>]/g, (c) => `&#${c.charCodeAt(0)};`);
      html(page('Link', `<h1>Link</h1><a href="${href}">Go</a>`));
      return;
    }
    if (path === '/login') {
      const type = state.numberMode ? 'number' : 'password';
      html(
        page(
          'Login',
          `<h1>Sign in ${label}</h1><form method="post" action="/welcome">
          <label for="u">User</label><input id="u" name="user">
          <label for="p">Password</label><input id="p" name="password" type="${type}">
          <button type="submit">Sign in</button></form>`,
        ),
      );
      return;
    }
    if (path === '/amount') {
      html(
        page('Amount', '<h1>Amount</h1><label for="n">Amount</label><input id="n" type="number">'),
      );
      return;
    }
    if (path === '/' || path === '/favicon.ico') {
      html(page('Stand', `<h1>Stand ${label}</h1>`));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
  const port = await listen(server, '127.0.0.1');
  return {
    url: `http://127.0.0.1:${port}`,
    state,
    hits: (path) => state.hits.get(path) ?? 0,
    hashes: () => [...state.hashes],
    close: closer(server),
  };
}

/** Первый IPv4 сети этой машины (не петля); нет — пусто (ноль запросов тогда не доказателен). */
export function lanAddress() {
  for (const list of Object.values(networkInterfaces()))
    for (const item of list ?? [])
      if (item.family === 'IPv4' && !item.internal && !item.address.startsWith('169.254.'))
        return item.address;
  return '';
}

export async function startForeignCounter() {
  const host = lanAddress();
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(req.url ?? '/');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page('Away', '<h1>Away</h1>'));
  });
  if (!host) return { url: '', host, hits: () => 0, seen, close: async () => undefined };
  const port = await listen(server, host);
  return {
    url: `http://${host}:${port}`,
    host,
    hits: () => seen.length,
    seen,
    close: closer(server),
  };
}

export async function startFakeExpo() {
  const received = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk.toString('utf8')));
    req.on('end', () => {
      let messages = [];
      try {
        const parsed = JSON.parse(raw);
        messages = Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        // Кривое тело — проверка увидит, что push не дошёл.
      }
      received.push(...messages);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: messages.map(() => ({ status: 'ok' })) }));
    });
  });
  const port = await listen(server, '127.0.0.1');
  return {
    url: `http://127.0.0.1:${port}/--/api/v2/push/send`,
    received,
    pushesFor: (askId) => received.filter((m) => m?.data?.askId === askId),
    close: closer(server),
  };
}
