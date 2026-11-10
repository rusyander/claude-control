import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Стенд для прохода — свой HTTP-сервер на 127.0.0.1, порт от ОС, только для тестов (никакого
 * настоящего сайта). Страницы — ровно те случаи, что судят проверки ядра:
 * - `/login` — форма входа (подпись «Password», кнопка «Sign in»); ответ `/welcome` печатает
 *   sha256 введённого пароля, но не сам пароль: так тест видит, что значение дошло до стенда;
 * - `/broken` — кнопка «Break», которая пишет ошибку в консоль и зовёт `/api/missing` (404);
 * - `/inert` — кнопка «Nothing», которая ничего не делает (страница не откликается);
 * - `/blank` — пустая страница;
 * - `/echo` — поле «Token», чьё значение страница при вводе пишет в консоль (эхо секрета);
 * - `/upload` — кнопка «Attach», открывающая выбор файла;
 * - `/away?to=` — 302 на любой адрес, `/link?to=` — ссылка «Go» на любой адрес (ворота источника).
 */

/** Сервер-счётчик на 127.0.0.1: сколько запросов до него дошло (ворота источника — ноль). */
export interface HitCounter {
  port: number;
  hits(): number;
  close(): Promise<void>;
}

export async function startHitCounter(): Promise<HitCounter> {
  let hits = 0;
  const server: Server = createServer((_req, res) => {
    hits += 1;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page('Away', '<h1>Away</h1><label for="p">Password</label><input id="p">'));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return {
    port: (server.address() as AddressInfo).port,
    hits: () => hits,
    close: () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}

const page = (title: string, body: string): string =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;

export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

const PAGES: Record<string, string> = {
  '/login': page(
    'Login',
    `<h1>Sign in</h1><form method="post" action="/welcome">
      <label for="u">User</label><input id="u" name="user">
      <label for="p">Password</label><input id="p" name="password" type="password">
      <button type="submit">Sign in</button></form>`,
  ),
  '/broken': page(
    'Broken',
    `<h1>Broken</h1><button id="b">Break</button><script>
      document.getElementById('b').addEventListener('click', () => {
        console.error('boom from the stand');
        fetch('/api/missing');
      });</script>`,
  ),
  '/inert': page('Inert', `<h1>Inert</h1><button>Nothing</button>`),
  // Числовое поле: ввод текста Playwright отказывает, и его ошибка несёт набранное значение.
  '/amount': page(
    'Amount',
    `<h1>Amount</h1><label for="n">Amount</label><input id="n" type="number">`,
  ),
  '/blank': page('Blank', ''),
  '/echo': page(
    'Echo',
    `<h1>Echo</h1><label for="t">Token</label><input id="t" type="password"><script>
      document.getElementById('t').addEventListener('input', (e) => {
        console.error('typed ' + e.target.value);
      });</script>`,
  ),
  '/upload': page(
    'Upload',
    `<h1>Upload</h1><input id="f" type="file" hidden><button id="a">Attach</button><script>
      document.getElementById('a').addEventListener('click', () => document.getElementById('f').click());
    </script>`,
  ),
};

export interface StandSite {
  url: string;
  close(): Promise<void>;
}

export async function startStandSite(): Promise<StandSite> {
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]!;
    if (req.method === 'POST' && path === '/welcome') {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
      req.on('end', () => {
        const password = new URLSearchParams(body).get('password') ?? '';
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(page('Welcome', `<h1>Welcome</h1><p data-testid="hash">${sha256(password)}</p>`));
      });
      return;
    }
    // Переход сервера на любой адрес (`/away?to=<url>`): проверка «перенаправление увело за
    // пределы зарегистрированных стендов» (ворота источника прохода).
    if (path === '/away') {
      const to = new URLSearchParams((req.url ?? '').split('?')[1] ?? '').get('to') ?? '/';
      res.writeHead(302, { location: to });
      res.end();
      return;
    }
    // Ссылка на любой адрес (`/link?to=<url>`): клик модели уводит страницу (переход по ссылке).
    if (path === '/link') {
      const to = new URLSearchParams((req.url ?? '').split('?')[1] ?? '').get('to') ?? '/';
      const href = to.replace(/[&"<>]/g, (c) => `&#${c.charCodeAt(0)};`);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page('Link', `<h1>Link</h1><a href="${href}">Go</a>`));
      return;
    }
    // Новое окно на любой адрес (`/popup?to=<url>`): ссылка `target=_blank` «Pop» и кнопка
    // `window.open` «Window» — окно, которого проход не видит, не должно ходить никуда.
    if (path === '/popup') {
      const to = new URLSearchParams((req.url ?? '').split('?')[1] ?? '').get('to') ?? '/';
      const href = to.replace(/[&"<>']/g, (c) => `&#${c.charCodeAt(0)};`);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        page(
          'Popup',
          `<h1>Popup</h1><a href="${href}" target="_blank">Pop</a>
          <button onclick="window.open(this.dataset.to)" data-to="${href}">Window</button>`,
        ),
      );
      return;
    }
    const html = PAGES[path];
    if (!html) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}
