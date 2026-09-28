/**
 * Кейс access-integrations-007: «Авторизоваться» у MCP-сервера отвечает словами
 * на каждый исход, молчащей кнопки нет.
 *
 * Живой случай 28.09: у figma (локальный Dev Mode, sse на 127.0.0.1:3845)
 * кнопка не делала ничего. Сервер входа не требует, старт отвечал `authorized`,
 * карточка молча закрывала окно; значка «Авторизован» не появлялось — токена
 * нет и не будет, — и кнопка оставалась на месте.
 *
 * Серверы настоящие, на своих портах, ничего не подменено:
 *  - `local-sse` — SSE без входа на SDK MCP (так отвечает Dev Mode Figma);
 *  - `remote-oauth` — HTTP-сервер за 401 с обнаружением (RFC 9728 / 8414) и
 *    регистрацией клиента (RFC 7591); окно входа уходит на его `/authorize`;
 *  - `dead-sse` — адрес, на котором не слушает никто.
 * Панель и фронт — одноразовый стенд (`throwaway-stand.mjs`): настоящий
 * `~/.claude` человека не затрагивается.
 *
 * `SHOTS=<каталог>` — снимки карточек до и после нажатия (для до/после).
 * Запуск: `node tools/qa/check-mcp-authorize.mjs` (стенд поднимается сам).
 */
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { REPO, freePort, runOnStand, wait } from './throwaway-stand.mjs';

const SHOTS = process.env.SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

// SDK MCP живёт в зависимостях сервера панели, не в корне воркспейса.
const serverRequire = createRequire(join(REPO, 'apps', 'server', 'package.json'));
const sdk = async (path) =>
  import(pathToFileURL(serverRequire.resolve(`@modelcontextprotocol/sdk/${path}`)).href);
const { McpServer } = await sdk('server/mcp.js');
const { SSEServerTransport } = await sdk('server/sse.js');

const listen = (server) =>
  new Promise((done) =>
    server.listen(0, '127.0.0.1', () => done(`http://127.0.0.1:${server.address().port}`)),
  );

/** Локальный SSE без входа — как Dev Mode Figma. */
function localSse() {
  const sessions = new Map();
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/sse') {
      const transport = new SSEServerTransport('/messages', res);
      sessions.set(transport.sessionId, transport);
      res.on('close', () => sessions.delete(transport.sessionId));
      const mcp = new McpServer({ name: 'dev-mode', version: '1.0.0' });
      mcp.tool('ping', 'ответ «pong»', async () => ({ content: [{ type: 'text', text: 'pong' }] }));
      await mcp.connect(transport);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/messages') {
      const transport = sessions.get(url.searchParams.get('sessionId') ?? '');
      if (!transport) return void res.writeHead(404).end();
      await transport.handlePostMessage(req, res);
      return;
    }
    res.writeHead(404).end();
  });
}

/** Удалённый сервер с OAuth; `authorizeHits` — запросы окна входа к `/authorize`. */
function remoteOAuth(base, authorizeHits) {
  const json = (res, status, body) =>
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  return createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
      return json(res, 200, { resource: `${base()}/mcp`, authorization_servers: [base()] });
    }
    if (url.pathname.startsWith('/.well-known/oauth-authorization-server')) {
      return json(res, 200, {
        issuer: base(),
        authorization_endpoint: `${base()}/authorize`,
        token_endpoint: `${base()}/token`,
        registration_endpoint: `${base()}/register`,
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
      });
    }
    if (url.pathname === '/register' && req.method === 'POST') {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => json(res, 201, { ...JSON.parse(raw || '{}'), client_id: 'qa-client' }));
      return;
    }
    if (url.pathname === '/authorize') {
      authorizeHits.push(url);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return void res.end('<!doctype html><title>QA sign-in</title><h1>QA sign-in</h1>');
    }
    if (url.pathname === '/mcp') {
      return void res
        .writeHead(401, {
          'www-authenticate': `Bearer resource_metadata="${base()}/.well-known/oauth-protected-resource"`,
        })
        .end('unauthorized');
    }
    res.writeHead(404).end();
  });
}

/**
 * SSE за токеном: с `Bearer qa-token` — тот же сервер, что локальный, без него —
 * 401 с обнаружением. Так отвечает сервер, которому вход нужен и уже выполнен.
 */
function gatedSse(base) {
  const inner = localSse();
  return createServer((req, res) => {
    if (req.headers.authorization === 'Bearer qa-token')
      return void inner.emit('request', req, res);
    res
      .writeHead(401, {
        'www-authenticate': `Bearer resource_metadata="${base()}/.well-known/oauth-protected-resource"`,
      })
      .end('unauthorized');
  });
}

const local = localSse();
const localUrl = await listen(local);
const authorizeHits = [];
let remoteUrl = '';
const remote = remoteOAuth(() => remoteUrl, authorizeHits);
remoteUrl = await listen(remote);
const deadUrl = `http://127.0.0.1:${await freePort()}`;
let gatedUrl = '';
gatedUrl = await listen(gatedSse(() => gatedUrl));

// Серверы живут в этом процессе: runOnStand завершает его сам (process.exit),
// поэтому их закрывает выход процесса, а не finally, который не выполнился бы.
await runOnStand({ label: 'mcp-authorize' }, async (stand, check) => {
  const names = {};
  const add = async (name, transport, url) => {
    const { status, body } = await stand.api('/mcp', {
      method: 'POST',
      body: { name, transport, url },
    });
    check(`сервер ${name} заведён`, status < 300, `${status} ${JSON.stringify(body)}`);
    const id = body?.id ?? name;
    names[id] = name;
    return id;
  };
  const localId = await add('local-sse', 'sse', `${localUrl}/sse`);
  const remoteId = await add('remote-oauth', 'http', `${remoteUrl}/mcp`);
  const deadId = await add('dead-sse', 'sse', `${deadUrl}/sse`);
  const gatedId = await add('gated-sse', 'sse', `${gatedUrl}/sse`);
  // Вход у него уже выполнен: токен лежит в хранилище одноразовой панели так же,
  // как его кладёт завершённый OAuth (`mcp-oauth.json` в каталоге данных).
  const location = await stand.api('/location');
  const appData = location.body?.paths?.appData;
  mkdirSync(appData, { recursive: true });
  writeFileSync(
    join(appData, 'mcp-oauth.json'),
    `${JSON.stringify({ [gatedId]: { tokens: { access_token: 'qa-token', token_type: 'Bearer' } } }, null, 2)}
`,
  );

  const browser = await chromium.launch();
  try {
    const page = await stand.newPage(browser, { width: 1440, height: 1100 });
    await page.goto(`${stand.webUrl}/mcp`, { waitUntil: 'domcontentloaded' });
    // Карточка — ближайший предок имени, в котором есть «Проверить»: без опоры на
    // служебные атрибуты, чтобы та же проверка шла и по коду до правки.
    const card = (id) =>
      page
        .getByText(names[id], { exact: true })
        .locator('xpath=ancestor::*[.//button[normalize-space()="Проверить"]][1]');
    const authorizeOf = (id) => card(id).getByRole('button', { name: 'Авторизоваться' });
    const shown = await card(localId)
      .waitFor({ timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    if (!shown) {
      check(
        'карточки серверов на странице',
        false,
        `${page.errors.join(' | ')} :: ${(await page.locator('body').innerText()).slice(0, 400)}`,
      );
      return;
    }
    await wait(800);
    if (SHOTS) await card(localId).screenshot({ path: join(SHOTS, '01-local-before.png') });

    // ── Сервер без входа ────────────────────────────────────────────────────
    const popups = [];
    page.context().on('page', (opened) => popups.push(opened));
    await authorizeOf(localId).click();
    const notRequired = card(localId).getByText('Сервер отвечает без входа');
    await notRequired.waitFor({ timeout: 30_000 }).catch(() => undefined);
    check(
      'без входа: карточка говорит, что авторизация не нужна',
      (await notRequired.count()) === 1,
      (await card(localId).innerText()).replace(/\s+/g, ' '),
    );
    await card(localId)
      .getByText(/^Отвечает/)
      .waitFor({ timeout: 60_000 })
      .catch(() => undefined);
    const localText = await card(localId).innerText();
    check(
      'без входа: связь проверена сама — «Отвечает: 1 инструментов»',
      /Отвечает: 1 инструментов/.test(localText),
      localText.replace(/\s+/g, ' '),
    );
    check(
      'без входа: кнопки «Авторизоваться» больше нет (входить некуда)',
      (await authorizeOf(localId).count()) === 0,
    );
    check('без входа: значка «Авторизован» нет', !/Авторизован\b/.test(localText));
    await wait(500);
    check(
      'без входа: окно входа закрыто, не висит пустым',
      popups.every((opened) => opened.isClosed()),
      `${popups.length} окон, открыто ${popups.filter((opened) => !opened.isClosed()).length}`,
    );
    const listed = await stand.api('/mcp');
    const localEntry = (Array.isArray(listed.body) ? listed.body : []).find(
      (server) => server.id === localId,
    );
    check(
      'без входа: токена в хранилище нет (hasOAuth false)',
      localEntry?.hasOAuth === false,
      JSON.stringify(localEntry),
    );
    if (SHOTS) await card(localId).screenshot({ path: join(SHOTS, '02-local-after.png') });

    // ── Сервер с OAuth ──────────────────────────────────────────────────────
    const popupOpened = page.waitForEvent('popup', { timeout: 30_000 });
    await authorizeOf(remoteId).click();
    const popup = await popupOpened;
    await popup
      .waitForURL((url) => url.pathname === '/authorize', { timeout: 30_000 })
      .catch(() => undefined);
    const hit = authorizeHits.at(-1);
    check(
      'OAuth: окно ушло на /authorize сервера с client_id, PKCE и state',
      hit?.searchParams.get('client_id') === 'qa-client' &&
        hit?.searchParams.get('code_challenge_method') === 'S256' &&
        Boolean(hit?.searchParams.get('state')),
      hit ? hit.search : 'окно на /authorize не пришло',
    );
    const waiting = card(remoteId).getByText('Завершите вход в открывшемся окне');
    check('OAuth: карточка говорит, где продолжить', (await waiting.count()) === 1);
    if (SHOTS) await card(remoteId).screenshot({ path: join(SHOTS, '03-oauth-popup.png') });
    await popup.close();
    await waiting.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => undefined);
    check('OAuth: окно закрыто — подсказка ушла', (await waiting.count()) === 0);
    check(
      'OAuth: кнопка «Авторизоваться» на месте (вход не завершён)',
      (await authorizeOf(remoteId).count()) === 1,
    );

    // ── Сервер не отвечает ──────────────────────────────────────────────────
    await authorizeOf(deadId).click();
    const failed = card(deadId).getByRole('alert').filter({ hasText: 'Вход не начался' });
    await failed.waitFor({ timeout: 30_000 }).catch(() => undefined);
    const failedText = (await failed.count()) === 1 ? await failed.innerText() : '';
    check(
      'нет связи: отказ словами у кнопки, с причиной сервера',
      /^Вход не начался: .{8,}/.test(failedText),
      failedText || (await card(deadId).innerText()).replace(/\s+/g, ' '),
    );
    const reason = failedText.replace(/^Вход не начался: /, '').slice(0, 40);
    await wait(800);
    const echoes = reason ? await page.getByText(reason, { exact: false }).count() : -1;
    check('нет связи: причина одна — общего тоста рядом нет', echoes === 1, `${echoes} копий`);
    if (SHOTS) await card(deadId).screenshot({ path: join(SHOTS, '04-dead-after.png') });

    // ── Выход у сервера, которому нужен вход (F-84) ─────────────────────────
    // Токен стёрт, а прежний статус «Отвечает» — ещё со временем входа: без
    // новой проверки карточка оставалась без «Выйти» и без «Авторизоваться».
    const signOut = card(gatedId).getByRole('button', { name: 'Выйти' });
    await card(gatedId).getByRole('button', { name: 'Проверить' }).click();
    await card(gatedId)
      .getByText(/^Отвечает/)
      .waitFor({ timeout: 60_000 })
      .catch(() => undefined);
    check(
      'с токеном: сервер отвечает, у карточки «Выйти»',
      /Отвечает/.test(await card(gatedId).innerText()) && (await signOut.count()) === 1,
      (await card(gatedId).innerText()).replace(/s+/g, ' '),
    );
    if (SHOTS) await card(gatedId).screenshot({ path: join(SHOTS, '05-gated-signed-in.png') });
    await signOut.click();
    const reauth = await authorizeOf(gatedId)
      .waitFor({ timeout: 60_000 })
      .then(() => true)
      .catch(() => false);
    check(
      'после «Выйти»: связь перепроверена, у карточки снова «Авторизоваться»',
      reauth,
      (await card(gatedId).innerText()).replace(/s+/g, ' '),
    );
    if (SHOTS) await card(gatedId).screenshot({ path: join(SHOTS, '06-gated-signed-out.png') });

    check('страница без необработанных ошибок', page.errors.length === 0, page.errors.join(' | '));
  } finally {
    await browser.close();
  }
});
