/**
 * Окно «Окружение», вкладка «API» — живой стенд, настоящий HTTP-сервис,
 * настоящий UI.
 *
 * Одноразовая панель (`throwaway-stand.mjs`) и крошечный сервис на свободном
 * порту прямо в этом процессе: отдаёт свой контракт `/openapi.json`, `/health`,
 * `/orders/{id}` (заказ 1 — по контракту, заказ 2 — с тремя расхождениями) и
 * `POST /orders`; каждый пришедший запрос запоминается, так что подстановка
 * авторизации видна со стороны сервиса, а не из ответа панели. Что проверяется:
 *
 * - API: контракт-файл YAML найден в проекте; эндпоинты с тегами; ответ сверен
 *   со схемой (совпал / три вида расхождения); авторизация уходит сервису
 *   целиком, а в ответ панели и в историю — только маской; чужой каталог — 403;
 *   закрытый порт — «connect», запрещённый fetch порт — «bad-url»; адрес-источник
 *   проверяется до добавления; Postman: импорт, отказ OpenAPI под видом
 *   коллекции, удаление;
 * - UI: вкладка, поиск, параметр пути, Ctrl+Enter, вердикт и расхождения,
 *   «Спросить агента» кладёт просьбу в поле чата и закрывает окно, история
 *   повторяет запрос, свой запрос по адресу, авторизация маской, проект без
 *   контракта — пустое состояние;
 * - axe в светлой и тёмной теме.
 *
 * Запуск: `node tools/qa/check-api-explorer.mjs`. Снимки — в
 * `.agent/screenshots/before-after/backend-api/`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';
import { NotChecked, REPO, freePort, runOnStand, wait } from './throwaway-stand.mjs';
import { seedChatTranscript } from './backend-fixtures.mjs';

const SHOTS = join(REPO, '.agent', 'screenshots', 'before-after', 'backend-api');
mkdirSync(SHOTS, { recursive: true });
const SECRET = `Bearer qa-secret-${Date.now().toString(36)}-tail`;

let port;
let dirs;
const seen = [];

const spec = () => ({
  openapi: '3.0.3',
  info: { title: 'Shop API', version: '1.2.0' },
  servers: [{ url: `http://127.0.0.1:${port}` }],
  paths: {
    '/health': {
      get: { tags: ['system'], summary: 'Liveness', responses: { 200: { description: 'ok' } } },
    },
    '/orders/{id}': {
      get: {
        tags: ['orders'],
        summary: 'Get order',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'integer' }, example: 1 },
        ],
        responses: {
          200: {
            description: 'order',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Order' } } },
          },
        },
      },
    },
    '/orders': {
      post: {
        tags: ['orders'],
        summary: 'Create order',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/Order' },
              example: { id: 3, total: 1, status: 'new' },
            },
          },
        },
        responses: {
          201: {
            description: 'created',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Order' } } },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      Order: {
        type: 'object',
        required: ['id', 'total', 'status'],
        properties: {
          id: { type: 'integer' },
          total: { type: 'number' },
          status: { type: 'string', enum: ['new', 'paid'] },
        },
      },
    },
  },
});

/** Тот же контракт YAML-ом — файл проекта читается как YAML, адрес — как JSON. */
function toYaml(value, indent = 0) {
  const pad = ' '.repeat(indent);
  if (Array.isArray(value)) {
    return value
      .map((item) =>
        typeof item === 'object'
          ? `${pad}-\n${toYaml(item, indent + 2)}`
          : `${pad}- ${JSON.stringify(item)}`,
      )
      .join('\n');
  }
  return Object.entries(value)
    .map(([key, item]) =>
      item !== null && typeof item === 'object'
        ? `${pad}${JSON.stringify(key)}:\n${toYaml(item, indent + 2)}`
        : `${pad}${JSON.stringify(key)}: ${JSON.stringify(item)}`,
    )
    .join('\n');
}

function startService() {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      const json = (status, value) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(value));
      };
      if (req.url === '/openapi.json') return json(200, spec());
      if (req.url === '/health') return json(200, { status: 'ok' });
      if (req.url === '/orders/1') return json(200, { id: 1, total: 10.5, status: 'paid' });
      // Три расхождения: id строкой, total нет, status не из списка.
      if (req.url === '/orders/2') return json(200, { id: '2', status: 'lost' });
      if (req.url === '/orders' && req.method === 'POST') {
        return json(201, { ...JSON.parse(body || '{}'), status: 'new' });
      }
      return json(404, { error: 'not found' });
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

const POSTMAN = JSON.stringify({
  info: {
    name: 'Shop collection',
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  variable: [{ key: 'base', value: 'http://127.0.0.1' }],
  item: [
    { name: 'Health', request: { method: 'GET', url: '{{base}}/health' } },
    {
      name: 'Create',
      request: {
        method: 'POST',
        url: '{{base}}/orders',
        header: [{ key: 'Content-Type', value: 'application/json' }],
        body: { mode: 'raw', raw: '{"id":9}' },
      },
    },
  ],
});

async function closeKeyGate(page) {
  const close = page.getByRole('button', { name: 'Закрыть', exact: true });
  try {
    await close.first().waitFor({ timeout: 6000 });
    await close.first().click();
  } catch {
    // Окна не было — CLI на стенде нашёлся.
  }
}

/** Чат → проект → «Окружение» → вкладка «API». Свой контекст: axe не разбирает страницы из browser.newPage(). */
async function openApi(stand, browser, projectName, context) {
  const own = context ?? (await browser.newContext({ viewport: { width: 1440, height: 1000 } }));
  const page = await own.newPage();
  page.errors = [];
  page.on('pageerror', (error) => page.errors.push(error.message));
  await page.goto(`${stand.webUrl}/chat`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('nav');
  await closeKeyGate(page);
  await page.getByRole('tab', { name: 'Проекты' }).first().click({ timeout: 15_000 });
  await page
    .getByRole('button', { name: new RegExp(projectName) })
    .first()
    .click({ timeout: 15_000 });
  await page
    .getByRole('button', { name: /^Окружение$/ })
    .first()
    .click({ timeout: 15_000 });
  const dialog = page.getByRole('dialog', { name: 'Окружение проекта' });
  await dialog.waitFor({ timeout: 15_000 });
  await dialog.getByRole('tab', { name: 'API' }).click();
  await wait(500);
  return { page, dialog };
}

async function axe(page) {
  await wait(600);
  const results = await new AxeBuilder({ page })
    .include('[role="dialog"]')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  return results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
}

const visible = (locator, timeout = 15_000) =>
  locator
    .first()
    .waitFor({ timeout })
    .then(() => true)
    .catch(() => false);

port = await freePort();
const closedPort = await freePort();
const service = await startService();

await runOnStand(
  {
    label: 'api',
    settings: { theme: 'system' },
    seed: ({ root, cfg }) => {
      const shop = join(root, 'demo', 'shop-api');
      const plain = join(root, 'demo', 'plain-api');
      const stranger = join(root, 'outside', 'stranger');
      for (const dir of [shop, plain, stranger]) mkdirSync(dir, { recursive: true });
      writeFileSync(join(shop, 'openapi.yaml'), `${toYaml(spec())}\n`, 'utf8');
      writeFileSync(join(shop, 'package.json'), '{"name":"shop-api"}\n', 'utf8');
      // Стенд в .env — подсказка базового адреса; секретный ключ наружу не выходит.
      writeFileSync(
        join(shop, '.env'),
        `DEV_SHOP_URL=http://localhost:${port}\nAPI_TOKEN=https://secret-token.example.com\n`,
        'utf8',
      );
      writeFileSync(join(plain, 'package.json'), '{"name":"plain-api"}\n', 'utf8');
      writeFileSync(join(stranger, 'openapi.yaml'), `${toYaml(spec())}\n`, 'utf8');
      dirs = { shop, plain, stranger };
      for (const path of [shop, plain]) seedChatTranscript(cfg, path);
    },
  },
  async (stand, check) => {
    for (const [name, path] of [
      ['shop-api', dirs.shop],
      ['plain-api', dirs.plain],
    ]) {
      const res = await stand.api('/projects', { method: 'POST', body: { path, name } });
      if (res.status >= 300) throw new NotChecked(`проект ${name} не добавился: ${res.text}`);
    }
    const q = (path) => `path=${encodeURIComponent(path)}`;
    const info = (path = dirs.shop) => stand.api(`/api-explorer?${q(path)}`);
    const send = (body) =>
      stand.api('/api-explorer/send', {
        method: 'POST',
        body: { path: dirs.shop, headers: [], ...body },
      });

    /* ── API: контракт ────────────────────────────────────────────── */
    const first = await info();
    const fileSource = first.body?.sources?.find((item) => item.kind === 'file');
    check(
      'контракт-файл YAML найден в проекте',
      fileSource?.id === 'file:openapi.yaml',
      first.text.slice(0, 300),
    );
    const specRes = await stand.api(
      `/api-explorer/spec?${q(dirs.shop)}&sourceId=${encodeURIComponent('file:openapi.yaml')}`,
    );
    const ids = (specRes.body?.endpoints ?? []).map((item) => item.id).sort();
    check(
      'эндпоинты контракта: три, с тегами, сервер из контракта',
      ids.join(',') === 'GET /health,GET /orders/{id},POST /orders' &&
        specRes.body?.servers?.[0] === `http://127.0.0.1:${port}`,
      `${ids.join(',')} ${JSON.stringify(specRes.body?.servers)}`,
    );
    const foreign = await info(dirs.stranger);
    check(
      'чужой каталог — 403 api-project-unregistered',
      foreign.status === 403 && foreign.body?.code === 'api-project-unregistered',
      foreign.text,
    );

    /* ── API: отправка и сверка ───────────────────────────────────── */
    const viaSpec = { sourceId: 'file:openapi.yaml', endpointId: 'GET /orders/{id}' };
    const ok = await send({ method: 'get', url: `http://127.0.0.1:${port}/orders/1`, ...viaSpec });
    check(
      'ответ по контракту — verdict ok против 200',
      ok.status === 200 && ok.body?.status === 200 && ok.body?.check?.verdict === 'ok',
      ok.text.slice(0, 300),
    );
    const bad = await send({ method: 'get', url: `http://127.0.0.1:${port}/orders/2`, ...viaSpec });
    const kinds = (bad.body?.check?.issues ?? []).map((issue) => issue.kind).sort();
    check(
      'ответ с расхождениями — mismatch: type, required, enum',
      bad.body?.check?.verdict === 'mismatch' && kinds.join(',') === 'enum,required,type',
      JSON.stringify(bad.body?.check),
    );

    /* ── API: авторизация ─────────────────────────────────────────── */
    const saved = await stand.api('/api-explorer/settings', {
      method: 'PUT',
      body: { path: dirs.shop, auth: { header: 'Authorization', value: SECRET } },
    });
    check('авторизация сохранена', saved.status === 200, saved.text);
    const masked = await info();
    check(
      'в ответе панели — только маска',
      masked.body?.auth?.header === 'Authorization' && !masked.text.includes(SECRET),
      JSON.stringify(masked.body?.auth),
    );
    seen.length = 0;
    const authed = await send({
      method: 'get',
      url: `http://127.0.0.1:${port}/health`,
      useAuth: true,
    });
    check(
      'сервис получил заголовок целиком',
      authed.status === 200 && seen.at(-1)?.headers?.authorization === SECRET,
      JSON.stringify(seen.at(-1)?.headers),
    );
    const history = await stand.api(`/api-explorer/history?${q(dirs.shop)}`);
    check(
      'история: запросы есть, секрета нет',
      history.status === 200 &&
        (Array.isArray(history.body) ? history.body : []).length >= 3 &&
        !history.text.includes(SECRET),
      `${history.status} n=${(Array.isArray(history.body) ? history.body : []).length} secret=${history.text.includes(SECRET)} ${history.text.slice(0, 200)}`,
    );

    /* ── API: ошибки отправки ─────────────────────────────────────── */
    const refused = await send({ method: 'get', url: `http://127.0.0.1:${closedPort}/x` });
    check(
      'закрытый порт — 502 connect',
      refused.status === 502 && refused.body?.kind === 'connect',
      refused.text,
    );
    const badPort = await send({ method: 'get', url: 'http://127.0.0.1:6000/x' });
    check(
      'запрещённый fetch порт — 400 bad-url bad-port',
      badPort.status === 400 &&
        badPort.body?.kind === 'bad-url' &&
        badPort.body?.detail === 'bad-port',
      badPort.text,
    );

    /* ── API: источники ───────────────────────────────────────────── */
    const notSpec = await stand.api('/api-explorer/sources', {
      method: 'POST',
      body: { path: dirs.shop, url: `http://127.0.0.1:${port}/health` },
    });
    check('адрес без контракта не добавляется', notSpec.status >= 400, notSpec.text);
    const urlSource = await stand.api('/api-explorer/sources', {
      method: 'POST',
      body: { path: dirs.shop, url: `http://127.0.0.1:${port}/openapi.json` },
    });
    check(
      'адрес с контрактом добавлен',
      urlSource.status === 200 &&
        urlSource.body?.sources?.some((item) => item.kind === 'url' && item.removable),
      urlSource.text.slice(0, 300),
    );
    const notPostman = await stand.api('/api-explorer/postman', {
      method: 'POST',
      body: { path: dirs.shop, content: JSON.stringify(spec()) },
    });
    check(
      'OpenAPI под видом коллекции — 422 api-not-postman',
      notPostman.status === 422 && notPostman.body?.code === 'api-not-postman',
      notPostman.text,
    );
    const imported = await stand.api('/api-explorer/postman', {
      method: 'POST',
      body: { path: dirs.shop, content: POSTMAN },
    });
    const postmanId = imported.body?.sourceId;
    const postmanSpec = postmanId
      ? await stand.api(
          `/api-explorer/spec?${q(dirs.shop)}&sourceId=${encodeURIComponent(postmanId)}`,
        )
      : undefined;
    const create = postmanSpec?.body?.endpoints?.find((item) => item.method === 'post');
    check(
      'Postman: два запроса, переменная подставлена, тело и заголовок с собой',
      postmanSpec?.body?.endpoints?.length === 2 &&
        create?.preset?.body === '{"id":9}' &&
        postmanSpec.body.servers?.includes('http://127.0.0.1'),
      postmanSpec?.text.slice(0, 400),
    );
    const removed = await stand.api('/api-explorer/sources/remove', {
      method: 'POST',
      body: { path: dirs.shop, sourceId: postmanId ?? 'postman:none' },
    });
    check(
      'Postman: коллекция убрана из источников',
      removed.status === 200 && !removed.body?.sources?.some((item) => item.id === postmanId),
      removed.text.slice(0, 300),
    );
    const fileRemove = await stand.api('/api-explorer/sources/remove', {
      method: 'POST',
      body: { path: dirs.shop, sourceId: 'file:openapi.yaml' },
    });
    check(
      'файл проекта панель не убирает — 400',
      fileRemove.status === 400 && fileRemove.body?.code === 'api-source-not-removable',
      fileRemove.text,
    );
    await stand.api('/api-explorer/history/clear', { method: 'POST', body: { path: dirs.shop } });

    /* ── UI ───────────────────────────────────────────────────────── */
    const browser = await chromium.launch();
    try {
      const { page, dialog } = await openApi(stand, browser, 'shop-api');
      check(
        'вкладка: контракт и счётчик эндпоинтов',
        await visible(dialog.getByText(/Shop API 1.2.0 · OpenAPI 3.0 · эндпоинтов: 3/)),
      );
      check(
        'базовый адрес взят из контракта',
        (await dialog.getByLabel('Базовый адрес').inputValue()) === `http://127.0.0.1:${port}`,
        await dialog.getByLabel('Базовый адрес').inputValue(),
      );
      const chips = dialog.getByRole('group', { name: 'Подсказки' });
      const envChip = chips.getByRole('button', { name: `Взять адрес http://localhost:${port}` });
      check(
        'подсказки: адрес из .env с файлом и ключом, секретного ключа нет',
        (await visible(envChip)) &&
          /\.env · DEV_SHOP_URL/.test(await envChip.innerText()) &&
          !(await dialog.textContent()).includes('secret-token'),
        await chips.innerText().catch(() => ''),
      );
      await envChip.click();
      check(
        'подсказка нажата: адрес в поле и сохранён',
        (await dialog.getByLabel('Базовый адрес').inputValue()) === `http://localhost:${port}` &&
          (await visible(dialog.getByText('Сохранено'))) &&
          (await envChip.getAttribute('aria-pressed')) === 'true',
      );
      await chips.getByRole('button', { name: `Взять адрес http://127.0.0.1:${port}` }).click();
      await visible(dialog.getByText('Сохранено'));

      // Форма заголовка: кнопки на линии поля, а не ниже пояснения (замечание 12.10).
      await dialog.getByRole('button', { name: 'Изменить' }).click();
      const valueBox = await dialog.getByLabel('Значение', { exact: true }).boundingBox();
      const headerBox = await dialog.getByLabel('Заголовок', { exact: true }).boundingBox();
      const saveBox = await dialog.getByRole('button', { name: 'Сохранить' }).boundingBox();
      const bottom = (box) => (box ? box.y + box.height : NaN);
      check(
        'форма авторизации: поля на одной линии, «Сохранить» по низу поля',
        Math.abs((headerBox?.y ?? 0) - (valueBox?.y ?? 99)) <= 2 &&
          Math.abs(bottom(saveBox) - bottom(valueBox)) <= 6,
        `header.y=${headerBox?.y} value.y=${valueBox?.y} save.bottom=${bottom(saveBox)} value.bottom=${bottom(valueBox)}`,
      );
      await dialog.getByRole('button', { name: 'Отмена' }).click();

      check(
        'авторизация — маской',
        (await visible(dialog.getByText(/Authorization/).first())) &&
          !(await dialog.textContent()).includes(SECRET),
      );
      const search = dialog.getByRole('searchbox', { name: 'Найти эндпоинт' });
      await search.fill('liveness');
      await wait(200);
      check(
        'поиск по описанию оставляет только /health',
        (await dialog.getByRole('button', { name: /\/orders/ }).count()) === 0 &&
          (await dialog.getByRole('button', { name: /\/health/ }).count()) === 1,
      );
      await search.fill('');
      await dialog.getByRole('button', { name: /GET\s*\/orders\/\{id\}/ }).click();
      const idField = dialog.getByRole('textbox', { name: /\{id\}/ });
      check('параметр пути подставлен из примера', (await idField.inputValue()) === '1');
      await idField.fill('');
      check(
        'пустой параметр пути — отправка закрыта и названа',
        (await dialog.getByRole('button', { name: 'Отправить' }).isDisabled()) &&
          (await visible(dialog.getByText('Заполните параметры пути: id'))),
      );
      await idField.fill('2');
      await idField.press('Control+Enter');
      const response = dialog.getByRole('region', { name: 'Ответ' });
      check('Ctrl+Enter отправляет: 200 OK', await visible(response.getByText('200 OK')));
      check(
        'вердикт: расходится, три пункта',
        (await visible(response.getByText(/Ответ расходится со схемой контракта \(200\): 3/))) &&
          (await visible(response.getByText(/\$\.status: "lost" — не из списка/))),
      );
      await page.screenshot({ path: join(SHOTS, 'api-mismatch_AFTER.png') });

      const violationsLight = await axe(page);
      check(
        'axe (светлая, ответ с расхождением): без серьёзных',
        violationsLight.length === 0,
        violationsLight.map((v) => `${v.id}: ${v.nodes[0]?.target}`).join(', '),
      );

      await response.getByRole('button', { name: 'Спросить агента о расхождении' }).click();
      const composer = page.locator('[data-chat-input]');
      check(
        '«Спросить агента»: окно закрылось',
        (await dialog.isHidden({ timeout: 5000 }).catch(() => false)) ||
          !(await dialog.isVisible()),
      );
      const draftText = await composer.first().evaluate((el) => el.value ?? el.textContent ?? '');
      check(
        '«Спросить агента»: просьба в поле чата, с расхождениями, ничего не отправлено',
        draftText.includes('GET /orders/{id}') &&
          draftText.includes('не совпал со схемой') &&
          draftText.includes('$.status'),
        draftText.slice(0, 200),
      );
      check(
        'фокус в поле чата',
        await composer.first().evaluate((el) => el === document.activeElement),
      );
      await page.screenshot({ path: join(SHOTS, 'api-ask-agent_AFTER.png') });

      await page
        .getByRole('button', { name: /^Окружение$/ })
        .first()
        .click();
      await dialog.waitFor();
      await dialog.getByRole('tab', { name: 'API' }).click();
      const replay = dialog.getByRole('button', { name: /Повторить GET .*\/orders\/2/ });
      check('история: запрос виден', await visible(replay));
      await dialog.getByRole('button', { name: 'Свой запрос' }).click();
      const url = dialog.getByRole('textbox', { name: 'Адрес', exact: true });
      await url.fill('/health');
      check(
        'свой запрос: итоговый адрес собран из базы',
        await visible(dialog.getByText(`GET http://127.0.0.1:${port}/health`)),
      );
      seen.length = 0;
      await dialog.getByRole('button', { name: 'Отправить' }).click();
      check(
        'свой запрос: 200, авторизация подставлена сервером',
        (await visible(dialog.getByRole('region', { name: 'Ответ' }).getByText('200 OK'))) &&
          seen.at(-1)?.headers?.authorization === SECRET,
      );
      await replay.first().click();
      check(
        'повтор из истории: эндпоинт и id вернулись',
        (await dialog
          .getByRole('textbox', { name: /\{id\}/ })
          .inputValue()
          .catch(() => '')) === '2',
      );
      await page.screenshot({ path: join(SHOTS, 'api-history_AFTER.png') });
      check('страница без ошибок JS', page.errors.length === 0, page.errors.join(' | '));
      await page.context().close();

      const darkContext = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
        colorScheme: 'dark',
      });
      const dark = await openApi(stand, browser, 'shop-api', darkContext);
      await dark.dialog.getByRole('button', { name: /POST\s*\/orders/ }).click();
      check(
        'тело: пример из контракта, тип JSON',
        await visible(dark.dialog.getByText('Тип: application/json')),
      );
      await dark.dialog.getByRole('textbox', { name: 'Тело' }).fill('{"id":');
      check(
        'тело не JSON — предупреждение, отправить всё же можно',
        (await visible(dark.dialog.getByText(/Это не JSON/))) &&
          !(await dark.dialog.getByRole('button', { name: 'Отправить' }).isDisabled()),
      );
      await dark.dialog.getByRole('button', { name: 'Пример из контракта' }).click();
      await dark.dialog.getByRole('button', { name: 'Отправить' }).click();
      check(
        'POST по контракту: 201 и verdict ok',
        (await visible(dark.dialog.getByText('201 Created'))) &&
          (await visible(dark.dialog.getByText(/Ответ совпал со схемой контракта \(201\)/))),
      );
      // Карточки различимы на тёмной теме: фон запроса не равен фону окна.
      const surfaces = await dark.dialog.evaluate((node) => {
        const editor = node.querySelector('section[aria-labelledby] h3')?.closest('section');
        return [
          getComputedStyle(node).backgroundColor,
          editor ? getComputedStyle(editor).backgroundColor : '',
        ];
      });
      check(
        'тёмная: карточка запроса отличается от фона окна',
        Boolean(surfaces[1]) && surfaces[0] !== surfaces[1],
        surfaces.join(' / '),
      );

      const autofill = dark.dialog.getByRole('button', { name: 'Заполнить примером' });
      const bodyField = dark.dialog.getByRole('textbox', { name: 'Тело' });
      await autofill.click();
      const first = await bodyField.inputValue();
      await autofill.click();
      const second = await bodyField.inputValue();
      let sample;
      try {
        sample = JSON.parse(second);
      } catch {
        sample = undefined;
      }
      check(
        '«Заполнить примером»: тело по схеме Order, каждое нажатие — новое',
        Boolean(sample) &&
          Number.isInteger(sample.id) &&
          typeof sample.total === 'number' &&
          ['new', 'paid'].includes(sample.status) &&
          first !== second &&
          (await visible(dark.dialog.getByText(/^Заполнено примером: \d+$/))),
        second,
      );
      // Ответ в пути — скелетон на месте карточки ответа, не одна строка текста.
      await dark.page.route('**/api/api-explorer/send', async (route) => {
        await wait(1500);
        await route.continue();
      });
      seen.length = 0;
      await dark.dialog.getByRole('button', { name: 'Отправить' }).click();
      check(
        'ответ в пути: скелетон карточки «Жду ответ…»',
        await visible(dark.dialog.getByRole('status', { name: 'Жду ответ…' }), 1200),
      );
      check(
        'тело примера дошло до сервиса как есть',
        (await visible(dark.dialog.getByText('201 Created'))) &&
          JSON.stringify(JSON.parse(seen.at(-1)?.body ?? 'null')) === JSON.stringify(sample),
        seen.at(-1)?.body,
      );
      await dark.page.unroute('**/api/api-explorer/send');

      // Имени нет в DNS — причина называется, без совета про порт.
      await dark.dialog.getByRole('button', { name: 'Свой запрос' }).click();
      await dark.dialog
        .getByRole('textbox', { name: 'Адрес', exact: true })
        .fill('http://agentdeck-qa.invalid/x');
      await dark.dialog.getByRole('button', { name: 'Отправить' }).click();
      const dnsAlert = dark.dialog.getByRole('alert').filter({ hasText: 'не найден (DNS)' });
      check(
        'имя не найдено: текст про DNS с хостом, без «Порт тот?»',
        (await visible(dnsAlert)) &&
          /agentdeck-qa\.invalid/.test(await dnsAlert.innerText()) &&
          !/Порт тот/.test(await dnsAlert.innerText()),
        await dnsAlert.innerText().catch(() => ''),
      );

      const violationsDark = await axe(dark.page);
      check(
        'axe (тёмная, POST с ответом): без серьёзных',
        violationsDark.length === 0,
        violationsDark.map((v) => `${v.id}: ${v.nodes[0]?.target}`).join(', '),
      );
      await dark.page.screenshot({ path: join(SHOTS, 'api-post-dark_AFTER.png') });
      await darkContext.close();

      const empty = await openApi(stand, browser, 'plain-api');
      check(
        'без контракта: пустое состояние и путь к своему запросу',
        await visible(empty.dialog.getByText('Контракт не найден')),
      );
      await empty.page.screenshot({ path: join(SHOTS, 'api-empty_AFTER.png') });
      await empty.page.context().close();
    } finally {
      await browser.close();
      service.close();
    }
  },
);
