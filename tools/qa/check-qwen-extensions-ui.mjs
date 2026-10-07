/**
 * Раздел «Плагины» при активном Qwen Code — экран расширений (MAP 25).
 *
 * Серверная половина проверена настоящим qwen (`check-qwen-extensions.mjs`);
 * здесь — что видит и нажимает человек: подзаголовок называет расширения, форма
 * установки с предупреждением о доверии, отметки «включено»/«выключено» ровно
 * так, как их назвал сервер, кнопка «Выключить»/«Включить» по состоянию, у
 * строки без известного состояния кнопки переключения нет, удаление — через
 * подтверждение именем. Каждое действие уходит своим запросом, и его адрес и
 * тело читаются из перехваченного запроса.
 *
 * Контроль — тот же экран у Kimi Code (`installedActions: false`): ни формы, ни
 * кнопок, текст «только для показа». Без него проверка «кнопки есть» не умела
 * бы краснеть.
 *
 * Настройки панели НЕ переключаются: активный провайдер и сводка подменяются в
 * браузере, действия перехватываются и на сервер не уходят.
 *
 * Запуск: `node tools/qa/check-qwen-extensions-ui.mjs` при поднятом `pnpm dev`.
 * `SHOTS=<каталог>` — снимок страницы Qwen в светлой и тёмной теме.
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

const SPECS = {
  qwen: {
    providerName: 'Qwen Code',
    format: 'qwen-extensions',
    pluginsDir: 'C:/Users/me/.qwen/extensions',
    installedActions: true,
    installed: [
      plugin({
        id: 'alpha',
        name: 'alpha',
        version: '0.1.0',
        description: 'Alpha ext',
        manifestPath: 'C:/Users/me/.qwen/extensions/alpha/qwen-extension.json',
        enabled: true,
        source: 'https://github.com/o/alpha',
        sourceType: 'git',
        hasCommands: true,
        hasAgents: true,
        contextFiles: ['ALPHA.md'],
      }),
      plugin({
        id: 'beta',
        name: 'beta',
        manifestPath: 'C:/Users/me/.qwen/extensions/beta/qwen-extension.json',
        enabled: false,
        mcpServers: ['db'],
      }),
      plugin({
        id: 'gamma',
        name: 'gamma',
        manifestPath: 'C:/Users/me/.qwen/extensions/gamma/qwen-extension.json',
      }),
    ],
  },
  kimi: {
    providerName: 'Kimi Code',
    format: 'kimi-plugins',
    pluginsDir: 'C:/Users/me/.kimi-code/plugins/managed',
    installedActions: false,
    installed: [
      plugin({
        id: 'tools',
        name: 'tools',
        manifestPath: 'C:/Users/me/.kimi-code/plugins/managed/tools/kimi.plugin.json',
        hasSkills: true,
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
        ...spec,
      },
    }),
  );
  await page.route('**/api/provider-plugins/installed**', (route) => {
    const request = route.request();
    actions.push({
      method: request.method(),
      path: new URL(request.url()).pathname,
      body: request.postDataJSON?.() ?? null,
    });
    return route.fulfill({ json: { ok: true, output: 'done', needsRestart: true } });
  });

  await page.goto(`${BASE}/plugins`, { waitUntil: 'domcontentloaded' });
  await page
    .getByRole('heading', { name: `Плагины · ${spec.providerName}` })
    .waitFor({ timeout: 20_000 });
  return { context, page, errors, actions };
}

const browser = await chromium.launch();
try {
  console.log('\nQwen Code (qwen-extensions)');
  {
    const { context, page, errors, actions } = await openPlugins(browser, 'qwen', 'light');
    check(
      'подзаголовок про расширения и команды CLI',
      (await page
        .getByText('Расширения Qwen Code: установка, включение и удаление командами CLI')
        .count()) > 0,
    );
    check(
      'предупреждение о доверии и --consent над кнопкой',
      (await page.getByText(/подтверждает установку за вас \(--consent\)/).count()) > 0,
    );
    check(
      '«включено» — ровно у одного',
      (await page.getByText('включено', { exact: true }).count()) === 1,
    );
    check(
      '«выключено» — ровно у одного',
      (await page.getByText('выключено', { exact: true }).count()) === 1,
    );
    check(
      'кнопок переключения две (у gamma состояние не известно)',
      (await page.getByRole('button', { name: /^(Выключить|Включить)$/ }).count()) === 2,
    );
    check(
      'бейджи: субагенты, контекст, источник',
      (await page.getByText('приносит субагентов').count()) === 1 &&
        (await page.getByText('контекст: ALPHA.md').count()) === 1 &&
        (await page.getByText('источник: https://github.com/o/alpha (git)').count()) === 1,
    );

    await page.getByRole('button', { name: 'Выключить' }).click();
    await page.getByRole('button', { name: 'Включить' }).click();
    await page.waitForTimeout(400);
    check(
      'Выключить → disable alpha, Включить → enable beta',
      actions.map((item) => `${item.method} ${item.path}`).join(' | ') ===
        'POST /api/provider-plugins/installed/alpha/disable | POST /api/provider-plugins/installed/beta/enable',
      JSON.stringify(actions),
    );

    const field = page.getByPlaceholder('https://github.com/owner/repo');
    const install = page.getByRole('button', { name: 'Установить' });
    await field.fill('--help');
    check(
      'источник «--help»: ошибка поля, кнопка заперта',
      (await page.getByText('Источник — одна строка и не начинается с «-».').count()) === 1 &&
        (await install.isDisabled()),
    );
    await field.fill('  https://github.com/o/new  ');
    await install.click();
    await page.waitForTimeout(400);
    const posted = actions.at(-1);
    check(
      'установка: POST installed с обрезанным источником',
      posted?.method === 'POST' &&
        posted.path === '/api/provider-plugins/installed' &&
        posted.body?.source === 'https://github.com/o/new',
      JSON.stringify(posted),
    );

    await page.getByRole('button', { name: 'Удалить: beta' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByPlaceholder('beta').fill('beta');
    await dialog.getByRole('button', { name: 'Удалить' }).click();
    await page.waitForTimeout(400);
    check(
      'удаление после подтверждения именем — DELETE beta',
      actions.at(-1)?.method === 'DELETE' &&
        actions.at(-1)?.path === '/api/provider-plugins/installed/beta',
      JSON.stringify(actions.at(-1)),
    );
    check('без ошибок страницы', errors.length === 0, errors.join(' | '));
    await context.close();
  }

  console.log('\nКонтроль: Kimi Code (kimi-plugins)');
  {
    const { context, page, errors } = await openPlugins(browser, 'kimi', 'light');
    check(
      'подзаголовок «только показ»',
      (await page.getByText('Установленные плагины Kimi Code — только показ').count()) > 0,
    );
    check(
      'формы установки нет',
      (await page.getByRole('button', { name: 'Установить' }).count()) === 0,
    );
    check(
      'кнопок действий нет',
      (await page.getByRole('button', { name: /^(Выключить|Включить)$|^Удалить:/ }).count()) === 0,
    );
    check(
      'текст «только для показа» на месте',
      (await page.getByText(/Раздел только для показа/).count()) === 1,
    );
    check('без ошибок страницы', errors.length === 0, errors.join(' | '));
    await context.close();
  }

  if (SHOTS) {
    mkdirSync(SHOTS, { recursive: true });
    for (const scheme of ['light', 'dark']) {
      const { context, page } = await openPlugins(browser, 'qwen', scheme);
      await page.screenshot({ path: join(SHOTS, `qwen-extensions-${scheme}.png`), fullPage: true });
      await context.close();
    }
    console.log(`\nСнимки: ${SHOTS}`);
  }
} finally {
  await browser.close();
}

console.log(bad === 0 ? '\nВсё сходится.' : `\nПровалов: ${bad}`);
process.exitCode = bad === 0 ? 0 : 1;
