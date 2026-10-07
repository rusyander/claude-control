/**
 * Раздел «Плагины» при активном Codex — рынки и плагины (MAP 25).
 *
 * Серверная половина проверена настоящим codex (`check-codex-plugins.mjs`);
 * здесь — что видит и нажимает человек: подзаголовок про рынки, блок рынков с
 * «Обновить снимок» и отключением через подтверждение именем, форма
 * «Подключить рынок» с проверкой источника, список «Можно поставить» с
 * предупреждением о доверии, поставленные плагины с отметкой рынка, кнопкой
 * «Выключить»/«Включить» и удалением. Каждое действие уходит своим запросом;
 * адрес и тело читаются из перехваченного запроса — действие над плагином
 * обязано адресовать его как `имя@рынок`, а не голым именем.
 *
 * Контроль — тот же экран у Qwen Code: рынков и «Можно поставить» нет, форма
 * расширения есть. Без него проверка «блок рынков есть» не умела бы краснеть.
 *
 * Настройки панели НЕ переключаются: активный провайдер и сводка подменяются в
 * браузере, действия перехватываются и на сервер не уходят.
 *
 * Запуск: `node tools/qa/check-codex-plugins-ui.mjs` при поднятом `pnpm dev`.
 * `SHOTS=<каталог>` — снимок страницы Codex в светлой и тёмной теме.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

const BASE = process.env.APP_URL ?? 'http://localhost:8888';
const SHOTS = process.env.SHOTS;

let bad = 0;
const check = (text, ok, detail) => {
  console.log(`${ok ? '✓' : '✗'} ${text}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) bad += 1;
};

const plugin = (extra) => ({
  hasSkills: false,
  mcpServers: [],
  hookCount: 0,
  hasCommands: false,
  ...extra,
});

const CACHE = 'C:/Users/me/.codex/plugins/cache/qa-mkt';
const SPECS = {
  codex: {
    providerName: 'Codex (OpenAI)',
    format: 'codex-plugins',
    pluginsDir: 'C:/Users/me/.codex/plugins',
    configPath: 'C:/Users/me/.codex/config.toml',
    installedActions: true,
    marketplaceActions: true,
    marketplaces: [{ name: 'qa-mkt', root: 'C:/work/mkt' }],
    available: [
      plugin({
        id: 'other@qa-mkt',
        name: 'other',
        marketplace: 'qa-mkt',
        version: '2.0.0',
        description: 'Other plugin',
        manifestPath: 'C:/work/mkt/plugins/other',
      }),
    ],
    installed: [
      plugin({
        id: 'hello@qa-mkt',
        name: 'hello',
        displayName: 'Hello',
        marketplace: 'qa-mkt',
        version: '1.0.0',
        description: 'Hello plugin',
        manifestPath: `${CACHE}/hello/1.0.0/.codex-plugin/plugin.json`,
        enabled: true,
        hasSkills: true,
        mcpServers: ['db'],
      }),
      plugin({
        id: 'quiet@qa-mkt',
        name: 'quiet',
        marketplace: 'qa-mkt',
        manifestPath: `${CACHE}/quiet/1.0.0`,
        enabled: false,
      }),
    ],
  },
  qwen: {
    providerName: 'Qwen Code',
    format: 'qwen-extensions',
    pluginsDir: 'C:/Users/me/.qwen/extensions',
    installedActions: true,
    installed: [
      plugin({
        id: 'alpha',
        name: 'alpha',
        manifestPath: 'C:/Users/me/.qwen/extensions/alpha/qwen-extension.json',
        enabled: true,
      }),
    ],
  },
};

async function openPlugins(browser, providerId, scheme) {
  const spec = SPECS[providerId];
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: scheme,
  });
  const page = await context.newPage();
  const errors = [];
  const actions = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.route('**/api/providers', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    const body = await response.json();
    const providers = (body.providers ?? []).map((item) =>
      item.id === providerId
        ? {
            ...item,
            pluginsModel: 'files',
            capabilities: { ...item.capabilities, plugins: 'ready' },
          }
        : item,
    );
    return route.fulfill({ response, json: { ...body, active: providerId, providers } });
  });
  await page.route('**/api/settings', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    const body = await response.json();
    return route.fulfill({ response, json: { ...body, provider: providerId } });
  });
  await page.route('**/api/provider-plugins', (route) =>
    route.fulfill({
      json: {
        providerId,
        scope: 'global',
        sections: ['installed'],
        dirExists: true,
        files: [],
        ignored: [],
        filesReadOnly: true,
        packagesPresent: false,
        packages: [],
        preservedPackages: [],
        packagesReadOnly: true,
        available: [],
        marketplaces: [],
        marketplaceActions: false,
        ...spec,
      },
    }),
  );
  const record = (route) => {
    const request = route.request();
    actions.push({
      method: request.method(),
      path: new URL(request.url()).pathname,
      body: request.postDataJSON?.() ?? null,
    });
    return route.fulfill({ json: { ok: true, output: 'done', needsRestart: true } });
  };
  await page.route('**/api/provider-plugins/installed**', record);
  await page.route('**/api/provider-plugins/marketplaces**', record);

  await page.goto(`${BASE}/plugins`, { waitUntil: 'domcontentloaded' });
  await page
    .getByRole('heading', { name: `Плагины · ${spec.providerName}` })
    .waitFor({ timeout: 20_000 });
  return { context, page, errors, actions };
}

const last = (actions) => {
  const item = actions.at(-1);
  return item ? `${item.method} ${item.path}` : '';
};

const browser = await chromium.launch();
try {
  console.log('\nCodex (codex-plugins)');
  {
    const { context, page, errors, actions } = await openPlugins(browser, 'codex', 'light');
    check(
      'подзаголовок про рынки и команды CLI',
      (await page
        .getByText('Плагины Codex (OpenAI): рынки, установка и включение командами CLI')
        .count()) > 0,
    );
    check(
      'пояснение называет config.toml и одобрение хуков',
      (await page.getByText(/таблице \[plugins\."имя@рынок"\] файла config\.toml/).count()) > 0 &&
        (await page.getByText(/одобрения в \/hooks/).count()) > 0,
    );
    check(
      'блок рынков: qa-mkt и его корень',
      (await page.getByText('Рынки плагинов').count()) === 1 &&
        (await page.getByText('C:/work/mkt', { exact: true }).count()) === 1,
    );
    check(
      'формы расширения Qwen нет',
      (await page.getByText('Установить расширение').count()) === 0,
    );
    check(
      'доверие над «Можно поставить», other@qa-mkt в списке',
      (await page.getByText(/ставьте только с рынка, которому доверяете/).count()) === 1 &&
        (await page.getByText('Other plugin').count()) === 1,
    );
    check(
      'отметки рынка у доступного и обоих поставленных',
      (await page.getByText('рынок: qa-mkt', { exact: true }).count()) === 3,
    );
    check(
      '«включено» у hello, «выключено» у quiet',
      (await page.getByText('включено', { exact: true }).count()) === 1 &&
        (await page.getByText('выключено', { exact: true }).count()) === 1,
    );

    await page.getByRole('button', { name: 'Поставить: other@qa-mkt' }).click();
    await page.waitForTimeout(400);
    check(
      'Поставить → POST installed { source: other@qa-mkt }',
      last(actions) === 'POST /api/provider-plugins/installed' &&
        actions.at(-1)?.body?.source === 'other@qa-mkt',
      JSON.stringify(actions.at(-1)),
    );

    await page.getByRole('button', { name: 'Выключить' }).click();
    await page.waitForTimeout(400);
    check(
      'Выключить адресует hello@qa-mkt, а не hello',
      last(actions) === 'POST /api/provider-plugins/installed/hello%40qa-mkt/disable',
      JSON.stringify(actions.at(-1)),
    );
    await page.getByRole('button', { name: 'Включить' }).click();
    await page.waitForTimeout(400);
    check(
      'Включить → quiet@qa-mkt/enable',
      last(actions) === 'POST /api/provider-plugins/installed/quiet%40qa-mkt/enable',
      JSON.stringify(actions.at(-1)),
    );

    await page.getByRole('button', { name: 'Удалить: hello' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByPlaceholder('hello').fill('hello');
    await dialog.getByRole('button', { name: 'Удалить' }).click();
    await page.waitForTimeout(400);
    check(
      'удаление плагина после подтверждения — DELETE hello@qa-mkt',
      last(actions) === 'DELETE /api/provider-plugins/installed/hello%40qa-mkt',
      JSON.stringify(actions.at(-1)),
    );

    const field = page.getByPlaceholder('owner/repo');
    const add = page.getByRole('button', { name: 'Подключить рынок' });
    await field.fill('-x');
    check(
      'источник «-x»: ошибка поля, кнопка заперта',
      (await page.getByText('Источник — одна строка и не начинается с «-».').count()) === 1 &&
        (await add.isDisabled()),
    );
    await field.fill('  owner/repo@main  ');
    await add.click();
    await page.waitForTimeout(400);
    check(
      'Подключить рынок → POST marketplaces с обрезанным источником',
      last(actions) === 'POST /api/provider-plugins/marketplaces' &&
        actions.at(-1)?.body?.source === 'owner/repo@main',
      JSON.stringify(actions.at(-1)),
    );

    await page.getByRole('button', { name: 'Обновить снимок: qa-mkt' }).click();
    await page.waitForTimeout(400);
    check(
      'Обновить снимок → POST marketplaces/qa-mkt/upgrade',
      last(actions) === 'POST /api/provider-plugins/marketplaces/qa-mkt/upgrade',
      JSON.stringify(actions.at(-1)),
    );

    await page.getByRole('button', { name: 'Удалить: qa-mkt' }).click();
    const marketDialog = page.getByRole('dialog');
    await marketDialog.getByPlaceholder('qa-mkt').fill('qa-mkt');
    await marketDialog.getByRole('button', { name: 'Удалить' }).click();
    await page.waitForTimeout(400);
    check(
      'отключение рынка после подтверждения — DELETE marketplaces/qa-mkt',
      last(actions) === 'DELETE /api/provider-plugins/marketplaces/qa-mkt',
      JSON.stringify(actions.at(-1)),
    );
    check('без ошибок страницы', errors.length === 0, errors.join(' | '));
    await context.close();
  }

  console.log('\nКонтроль: Qwen Code (qwen-extensions)');
  {
    const { context, page, errors } = await openPlugins(browser, 'qwen', 'light');
    check('блока рынков нет', (await page.getByText('Рынки плагинов').count()) === 0);
    check('«Можно поставить» нет', (await page.getByText('Можно поставить').count()) === 0);
    check(
      'форма расширения на месте',
      (await page.getByText('Установить расширение').count()) === 1,
    );
    check('без ошибок страницы', errors.length === 0, errors.join(' | '));
    await context.close();
  }

  if (SHOTS) {
    mkdirSync(SHOTS, { recursive: true });
    for (const scheme of ['light', 'dark']) {
      const { context, page } = await openPlugins(browser, 'codex', scheme);
      await page.screenshot({ path: join(SHOTS, `codex-plugins-${scheme}.png`), fullPage: true });
      await context.close();
    }
    console.log(`\nСнимки: ${SHOTS}`);
  }
} finally {
  await browser.close();
}

console.log(bad === 0 ? '\nВсё сходится.' : `\nПровалов: ${bad}`);
process.exitCode = bad === 0 ? 0 : 1;
