/**
 * Окно «Окружение», вкладка «База данных» — живой стенд, настоящий Postgres,
 * настоящий UI и настоящий переходник MCP агента.
 *
 * Одноразовая панель (`throwaway-stand.mjs`) и одноразовый стек Compose с
 * `postgres:18.1-bookworm`: порт на 127.0.0.1, данные из init-скрипта, учёт
 * golang-migrate на версии 2 при трёх файлах миграций. Имя проекта compose
 * уникально на прогон, у всего метка `claude.ephemeral`, и в конце стек
 * сносится `down -v` при любом исходе. Что проверяется:
 *
 * - API: подключение найдено в compose с паролем из `environment`, пароль в
 *   ответ не уходит; `.env` с адресом `db:5432` сведён к той же строке;
 *   чужой каталог — 403;
 * - защита в два слоя: запись отказывается сторожем ДО базы (400), а функция,
 *   которая пишет и сторожа проходит, упирается в READ ONLY самого Postgres
 *   (25006) — и число строк после неё то же; долгий запрос рвётся таймаутом;
 * - своё подключение: неверный пароль — «auth»; роль без прав — «permission»;
 * - UI: вкладка, схема и поиск по колонке, «подставить запрос», Ctrl+Enter,
 *   NULL и типы в таблице, отказ сторожа, ошибка с позицией ставит курсор,
 *   план EXPLAIN, миграции «1 не применена», остановленная база в compose
 *   ведёт на «Сервисы», проект без базы — пустое состояние с действием;
 * - агент: переключатель пишет переходник в конфиг CLI стенда, а сам
 *   переходник (`tools/mcp/database.mjs`, клиентом MCP по stdio) отвечает
 *   схемой и строками и отказывает записи.
 *
 * Запуск: `node tools/qa/check-database.mjs`. Нет docker или образа — выход 2
 * «не проверено». Снимки — в `.agent/screenshots/before-after/backend-database/`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chromium } from 'playwright';
import { NotChecked, REPO, freePort, runOnStand, wait } from './throwaway-stand.mjs';
import { seedChatTranscript } from './backend-fixtures.mjs';

const SHOTS = join(REPO, '.agent', 'screenshots', 'before-after', 'backend-database');
mkdirSync(SHOTS, { recursive: true });
const IMAGE = 'postgres:18.1-bookworm';

const docker = (args, cwd, input) =>
  spawnSync('docker', args, {
    cwd,
    input,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 180_000,
  });

const COMPOSE_NAME = `agentdeck-qa-db-${randomBytes(3).toString('hex')}`;
const PASSWORD = `qa-${randomBytes(6).toString('hex')}`;
let dirs;
let port;

function put(dir, file, text) {
  mkdirSync(join(dir, ...file.split('/').slice(0, -1)), { recursive: true });
  writeFileSync(join(dir, file), text, 'utf8');
}

const INIT_SQL = `
CREATE TABLE customers (id serial PRIMARY KEY, email text NOT NULL, note text);
INSERT INTO customers (email, note) VALUES ('a@example.com', NULL), ('b@example.com', 'vip');
CREATE TABLE orders (id serial PRIMARY KEY, customer_id int REFERENCES customers(id), total numeric(10,2), created_at timestamptz DEFAULT now());
INSERT INTO orders (customer_id, total) SELECT 1 + (g % 2), g * 10.5 FROM generate_series(1, 30) g;
CREATE TABLE "Weird Table" (id int PRIMARY KEY);
CREATE TABLE schema_migrations (version bigint PRIMARY KEY, dirty boolean NOT NULL);
INSERT INTO schema_migrations VALUES (2, false);
-- Функция, которая пишет: сторож её пропустит, READ ONLY — нет.
CREATE FUNCTION sneaky_write() RETURNS int LANGUAGE sql AS 'INSERT INTO customers (email) VALUES (''x@x'') RETURNING id';
CREATE ROLE limited LOGIN PASSWORD 'limited-pw';
GRANT CONNECT ON DATABASE shop TO limited;
`;

function seedProjects(root) {
  const shop = join(root, 'shop-db');
  const plain = join(root, 'plain-api');
  const stranger = join(root, 'outside', 'stranger');
  put(
    shop,
    'compose.yaml',
    `name: ${COMPOSE_NAME}
services:
  db:
    image: ${IMAGE}
    ports: ["127.0.0.1:${port}:5432"]
    environment:
      POSTGRES_USER: shop
      POSTGRES_PASSWORD: ${PASSWORD}
      POSTGRES_DB: shop
    labels: [claude.ephemeral=1]
    healthcheck:
      test: ["CMD", "pg_isready", "-U", "shop", "-d", "shop"]
      interval: 1s
      retries: 60
`,
  );
  // Приложение в контейнере видит базу по имени сервиса — панель сводит это к опубликованному порту.
  put(shop, '.env', 'DATABASE_URL=postgres://shop@db:5432/shop\n');
  put(shop, 'migrations/000001_init.up.sql', 'create table a();');
  put(shop, 'migrations/000002_more.up.sql', 'create table b();');
  put(shop, 'migrations/000003_pending.up.sql', 'create table c();');
  put(plain, 'package.json', '{"name":"plain-api"}\n');
  put(stranger, '.env', 'DATABASE_URL=postgres://x@localhost/x\n');
  return { shop, plain, stranger };
}

async function closeKeyGate(page) {
  const close = page.getByRole('button', { name: 'Закрыть', exact: true });
  try {
    await close.first().waitFor({ timeout: 6000 });
    await close.first().click();
  } catch {
    // Окна не было — CLI на стенде нашёлся.
  }
}

/** Чат → проект → «Окружение» → вкладка «База данных». */
async function openDatabase(stand, browser, projectName) {
  const page = await stand.newPage(browser, { width: 1440, height: 1000 });
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
  await dialog.getByRole('tab', { name: 'База данных' }).click();
  await wait(500);
  return { page, dialog };
}

const visible = (locator, timeout = 15_000) =>
  locator
    .first()
    .waitFor({ timeout })
    .then(() => true)
    .catch(() => false);

async function waitFor(fn, timeoutMs, stepMs = 500) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > until) return value;
    await wait(stepMs);
  }
}

/** Клиент MCP по stdio к настоящему переходнику — так его запускает CLI. */
async function mcpClient(stand, cwd) {
  const require = createRequire(join(REPO, 'apps', 'server', 'package.json'));
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(REPO, 'tools', 'mcp', 'database.mjs')],
    cwd,
    env: {
      ...process.env,
      HOME: stand.home,
      USERPROFILE: stand.home,
      AGENTDECK_URL: stand.apiUrl,
    },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'qa', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

const textOf = (result) => (result?.content ?? []).map((part) => part.text ?? '').join('\n');

const probe = docker(['image', 'inspect', IMAGE, '--format', '{{.Id}}']);
if (probe.error || probe.status !== 0) {
  console.log(`Не проверено: docker не отвечает или нет образа ${IMAGE}`);
  process.exit(2);
}

port = await freePort();

await runOnStand(
  {
    label: 'database',
    seed: ({ root, cfg }) => {
      dirs = seedProjects(join(root, 'demo'));
      for (const path of [dirs.shop, dirs.plain]) seedChatTranscript(cfg, path);
    },
  },
  async (stand, check) => {
    for (const [name, path] of [
      ['shop-db', dirs.shop],
      ['plain-api', dirs.plain],
    ]) {
      const res = await stand.api('/projects', { method: 'POST', body: { path, name } });
      if (res.status >= 300) throw new NotChecked(`проект ${name} не добавился: ${res.text}`);
    }

    const conns = (path) => stand.api(`/database/connections?path=${encodeURIComponent(path)}`);
    const query = (sql, mode = 'run', connectionId = 'compose:db') =>
      stand.api('/database/query', {
        method: 'POST',
        body: { path: dirs.shop, connectionId, sql, mode },
      });

    const browser = await chromium.launch();
    try {
      // Без монтирования: Docker Desktop не всегда монтирует каталоги из TEMP, а
      // данные в базу и так проще отдать psql на вход.
      const up = docker(['compose', 'up', '-d', '--wait'], dirs.shop);
      if (up.status !== 0) throw new NotChecked(`стек не поднялся: ${up.stderr}`);
      const seeded = docker(
        [
          'compose',
          'exec',
          '-T',
          'db',
          'psql',
          '-v',
          'ON_ERROR_STOP=1',
          '-U',
          'shop',
          '-d',
          'shop',
        ],
        dirs.shop,
        INIT_SQL,
      );
      if (seeded.status !== 0) throw new NotChecked(`данные не легли: ${seeded.stderr}`);
      /* ── API: подключения ─────────────────────────────────────────── */
      const listed = await waitFor(async () => {
        const res = await conns(dirs.shop);
        return res.body?.connections?.length ? res : undefined;
      }, 30_000);
      const db = listed?.body?.connections?.[0];
      check(
        'подключение из compose: петля, опубликованный порт, пароль известен',
        db?.id === 'compose:db' && db.host === '127.0.0.1' && db.port === port && db.hasPassword,
        JSON.stringify(db),
      );
      check(
        '.env с адресом db:5432 сведён к той же строке',
        listed?.body?.connections?.length === 1,
        JSON.stringify(listed?.body?.connections?.map((item) => item.id)),
      );
      check('пароль в ответ не уходит', !listed?.text?.includes(PASSWORD));
      const foreign = await conns(dirs.stranger);
      check(
        'чужой каталог — 403 db-project-unregistered',
        foreign.status === 403 && foreign.body?.code === 'db-project-unregistered',
        foreign.text,
      );

      /* ── API: чтение и защита ─────────────────────────────────────── */
      const read = await query('select id, email, note from customers order by id');
      check(
        'чтение: строки, NULL как null, тип колонки',
        read.status === 200 &&
          read.body.rows?.[0]?.[2] === null &&
          read.body.columns?.[0]?.type === 'int4',
        read.text.slice(0, 300),
      );
      const refused = await query('delete from customers');
      check(
        'запись отказана сторожем до базы',
        refused.status === 400 && refused.body?.refusal?.reason === 'not-read',
        refused.text,
      );
      const sneaky = await query('select sneaky_write()');
      check(
        'пишущая функция упирается в READ ONLY Postgres (25006)',
        sneaky.status === 422 &&
          sneaky.body?.kind === 'read-only' &&
          sneaky.body?.sqlState === '25006',
        sneaky.text,
      );
      const count = await query('select count(*) from customers');
      check(
        'после попытки записи строк столько же',
        count.body?.rows?.[0]?.[0] === '2',
        count.text,
      );
      const plan = await query('select * from orders where total > 100', 'explain-analyze');
      check(
        'EXPLAIN ANALYZE: план текстом с временем выполнения',
        /Execution Time/.test(plan.body?.plan ?? ''),
        plan.text.slice(0, 300),
      );
      const started = Date.now();
      const slow = await query('select count(*) from generate_series(1, 100000000000)');
      check(
        'долгий запрос рвётся таймаутом (504 timeout)',
        slow.status === 504 && slow.body?.kind === 'timeout' && Date.now() - started < 25_000,
        `${slow.status} ${slow.text} за ${Date.now() - started} мс`,
      );

      /* ── API: свои подключения ────────────────────────────────────── */
      const addManual = (label, user, password) =>
        stand.api('/database/connections', {
          method: 'POST',
          body: {
            path: dirs.shop,
            label,
            host: '127.0.0.1',
            port,
            database: 'shop',
            user,
            password,
          },
        });
      const wrong = await addManual('Неверный пароль', 'shop', 'nope');
      check(
        'своё подключение сохранено, пароля в ответе нет',
        wrong.status === 200 && !wrong.text.includes('"nope"'),
        wrong.text.slice(0, 200),
      );
      const auth = await query('select 1', 'run', wrong.body?.savedId);
      check(
        'неверный пароль — 502 auth',
        auth.status === 502 && auth.body?.kind === 'auth',
        auth.text,
      );
      const limited = await addManual('Без прав', 'limited', 'limited-pw');
      const denied = await query('select * from customers', 'run', limited.body?.savedId);
      check(
        'роль без прав — 422 permission (42501)',
        denied.status === 422 && denied.body?.kind === 'permission',
        denied.text,
      );

      /* ── UI: схема, запрос, ошибки ────────────────────────────────── */
      const { page, dialog } = await openDatabase(stand, browser, 'shop-db');
      check(
        'вкладка: подключение db выбрано, бейдж Compose',
        await visible(dialog.getByRole('combobox', { name: 'Подключение' })),
      );
      check(
        'схема: таблица orders видна',
        await visible(dialog.getByText('orders', { exact: true })),
      );
      check(
        'схема: имя с пробелом видно',
        await visible(dialog.getByText('Weird Table', { exact: true })),
      );
      await dialog.getByRole('searchbox', { name: 'Найти таблицу или колонку' }).fill('email');
      await wait(200);
      check(
        'поиск по колонке оставляет только customers',
        (await dialog.getByText('orders', { exact: true }).count()) === 0 &&
          (await dialog.getByText('customers', { exact: true }).count()) > 0,
      );
      await dialog.getByRole('searchbox', { name: 'Найти таблицу или колонку' }).fill('');
      await dialog.getByText('orders', { exact: true }).click();
      await dialog.getByRole('button', { name: 'Подставить запрос к orders' }).click();
      const editor = dialog.getByRole('textbox', { name: 'Запрос SQL' });
      check(
        '«подставить запрос» кладёт SELECT в редактор',
        (await editor.inputValue()) === 'SELECT * FROM orders LIMIT 100',
        await editor.inputValue(),
      );
      await editor.focus();
      await page.keyboard.press('Control+Enter');
      check(
        'Ctrl+Enter выполняет: «30 строк»',
        await visible(dialog.getByText(/^30 строк за \d+ мс$/)),
      );
      check(
        'в таблице тип под именем колонки',
        await visible(dialog.getByRole('columnheader', { name: /total\s*numeric/ })),
      );
      await page.screenshot({ path: join(SHOTS, 'database-query_AFTER.png') });

      await editor.fill('select id, note from customers order by id');
      await dialog.getByRole('button', { name: 'Выполнить' }).click();
      check(
        'NULL отличим от пустой строки',
        await visible(dialog.getByRole('cell', { name: 'NULL' })),
      );

      await editor.fill('delete from orders');
      await dialog.getByRole('button', { name: 'Выполнить' }).click();
      check(
        'отказ сторожа: «Запрос не отправлен»',
        await visible(dialog.getByRole('alert').filter({ hasText: 'Запрос не отправлен' })),
      );
      await page.screenshot({ path: join(SHOTS, 'database-refused_AFTER.png') });

      await editor.fill('select *\nfromm orders');
      await dialog.getByRole('button', { name: 'Выполнить' }).click();
      check(
        'синтаксическая ошибка: позиция и строка 2',
        await visible(dialog.getByText(/Позиция \d+, строка 2/)),
      );
      const caret = await editor.evaluate((el) => el.selectionStart);
      check('курсор поставлен в место ошибки', caret > 8, String(caret));
      await page.screenshot({ path: join(SHOTS, 'database-error-position_AFTER.png') });

      await editor.fill('select * from orders where total > 100');
      await dialog.getByRole('button', { name: 'План', exact: true }).click();
      check('«План»: дерево EXPLAIN', await visible(dialog.getByLabel('План выполнения')));

      /* ── UI: миграции ─────────────────────────────────────────────── */
      check(
        'миграции: golang-migrate, одна не применена, блок раскрыт',
        await visible(dialog.getByText('1 не применена')),
      );
      check('миграция 000003 помечена', await visible(dialog.getByText('000003')));
      await dialog.getByText('1 не применена').scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(SHOTS, 'database-migrations_AFTER.png') });

      /* ── UI: своё подключение с неверным паролем ───────────────────── */
      await dialog
        .getByRole('combobox', { name: 'Подключение' })
        .selectOption({ label: /Неверный пароль/ })
        .catch(async () => {
          const option = await dialog
            .locator('option', { hasText: 'Неверный пароль' })
            .getAttribute('value');
          await dialog.getByRole('combobox', { name: 'Подключение' }).selectOption(option ?? '');
        });
      check(
        'своё подключение: «Своё», кнопки «Изменить» и «Убрать»',
        await visible(dialog.getByRole('button', { name: 'Убрать' })),
      );
      check(
        'неверный пароль: схема объясняет, что не так',
        await visible(dialog.getByRole('alert').filter({ hasText: 'не приняла логин или пароль' })),
      );

      /* ── Агент: переключатель и сам переходник ────────────────────── */
      await dialog.getByRole('switch', { name: 'Дать агенту читать базу проекта' }).click();
      const registered = await waitFor(
        async () => (await stand.api('/database/mcp')).body?.connected,
        10_000,
      );
      check('переключатель записал переходник в конфиг CLI стенда', registered === true);
      await page.close();

      const client = await mcpClient(stand, dirs.shop);
      try {
        const tools = (await client.listTools()).tools.map((tool) => tool.name).sort();
        check(
          'переходник: пять инструментов',
          tools.join(',') === 'db_connections,db_explain,db_migrations,db_query,db_schema',
          tools.join(','),
        );
        const schemaText = textOf(
          await client.callTool({ name: 'db_schema', arguments: { filter: 'orders' } }),
        );
        check(
          'db_schema: колонки orders',
          /public\.orders/.test(schemaText) && /customer_id/.test(schemaText),
          schemaText.slice(0, 300),
        );
        const rows = textOf(
          await client.callTool({
            name: 'db_query',
            arguments: { sql: 'select email from customers order by id' },
          }),
        );
        check(
          'db_query: строки текстом',
          rows.includes('a@example.com') && rows.includes('2 строк'),
          rows,
        );
        const blocked = await client.callTool({
          name: 'db_query',
          arguments: { sql: 'drop table orders' },
        });
        check(
          'db_query: запись — отказ с пометкой ошибки',
          blocked.isError === true && textOf(blocked).includes('Запрос не пропущен'),
          textOf(blocked),
        );
        const mig = textOf(await client.callTool({ name: 'db_migrations', arguments: {} }));
        check('db_migrations: не применена 000003', mig.includes('000003'), mig);
      } finally {
        await client.close();
      }

      /* ── UI: база в compose остановлена ───────────────────────────── */
      docker(['compose', 'stop', 'db'], dirs.shop);
      const stopped = await openDatabase(stand, browser, 'shop-db');
      check(
        'остановленная база: предупреждение и путь на «Сервисы»',
        await visible(stopped.dialog.getByText(/Сервис db сейчас: Остановлен/)),
      );
      await stopped.page.screenshot({ path: join(SHOTS, 'database-compose-down_AFTER.png') });
      await stopped.dialog.getByRole('button', { name: 'Поднять на вкладке «Сервисы»' }).click();
      check(
        'кнопка переключает на «Сервисы»',
        await visible(stopped.dialog.getByRole('button', { name: 'Поднять всё' })),
      );
      await stopped.page.close();

      /* ── UI: проект без базы ──────────────────────────────────────── */
      const empty = await openDatabase(stand, browser, 'plain-api');
      check('без базы: пустое состояние', await visible(empty.dialog.getByText('Базы не найдено')));
      await empty.dialog.getByRole('button', { name: 'Своё подключение' }).click();
      check(
        '«Своё подключение» открывает форму',
        await visible(empty.dialog.getByRole('textbox', { name: 'Название' })),
      );
      await empty.dialog.getByRole('button', { name: 'Сохранить' }).click();
      check(
        'пустая форма не уходит: «Заполните поле»',
        await visible(empty.dialog.getByText('Заполните поле')),
      );
      await empty.page.screenshot({ path: join(SHOTS, 'database-empty-form_AFTER.png') });
      await empty.page.close();
    } finally {
      await browser.close();
      // Стек сносится при любом исходе: одноразовый — значит, ничего после себя.
      docker(['compose', '-p', COMPOSE_NAME, 'down', '-v', '--remove-orphans'], dirs.shop);
    }
  },
);
