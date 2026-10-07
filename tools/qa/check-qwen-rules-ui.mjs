/**
 * Раздел «Правила» при активном Qwen Code — экран (MAP 24).
 *
 * Серверная половина проверена настоящим qwen (`check-qwen-rules.mjs`); здесь —
 * что видит человек: `/rules` открывает менеджер каталога правил Qwen, а не
 * правила CLAUDE.md; у правила без шаблонов метка «постоянное»; в форме создания
 * и в редакторе НЕТ переключателя `alwaysApply`; расширение `.md` дописывается
 * само и черновик уходит без ключа `alwaysApply`; пояснение честно говорит, что
 * условные правила в чате панели (qwen serve) не подключаются.
 *
 * Контроль — тот же экран в формате Cursor (`cursor-mdc`): переключатель есть,
 * расширение `.mdc`, `alwaysApply` в черновике. Без него проверка «переключателя
 * нет» не умела бы краснеть.
 *
 * Настройки панели НЕ переключаются: активный провайдер, список и правило
 * подменяются в браузере, запись перехватывается и на сервер не уходит.
 *
 * Запуск: `node tools/qa/check-qwen-rules-ui.mjs` при поднятом `pnpm dev`.
 * `SHOTS=<каталог>` — снимок страницы Qwen в светлой и тёмной теме.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

const BASE = process.env.APP_URL ?? 'http://localhost:8888';
const SHOTS = process.env.SHOTS;
const SWITCH = 'Подключать всегда (alwaysApply)';

let bad = 0;
const check = (text, ok, detail) => {
  console.log(`${ok ? '✓' : '✗'} ${text}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) bad += 1;
};

const FORMATS = {
  'qwen-md': {
    providerId: 'qwen',
    providerName: 'Qwen Code',
    rulesDir: 'C:/Users/me/.qwen/rules',
    extension: '.md',
    rules: [
      { path: 'always.md', size: 20, frontmatterOk: true },
      {
        path: 'frontend/react.md',
        description: 'React',
        globs: 'src/**/*.tsx',
        size: 60,
        frontmatterOk: true,
      },
    ],
    rule: { path: 'frontend/react.md', description: 'React', globs: 'src/**/*.tsx' },
  },
  'cursor-mdc': {
    providerId: 'cursor',
    providerName: 'Cursor',
    rulesDir: 'C:/Users/me/.cursor/rules',
    extension: '.mdc',
    rules: [
      { path: 'always.mdc', alwaysApply: true, size: 20, frontmatterOk: true },
      {
        path: 'frontend/react.mdc',
        description: 'React',
        globs: 'src/**/*.tsx',
        alwaysApply: false,
        size: 60,
        frontmatterOk: true,
      },
    ],
    rule: {
      path: 'frontend/react.mdc',
      description: 'React',
      globs: 'src/**/*.tsx',
      alwaysApply: false,
    },
  },
};

async function openRules(browser, format, scheme) {
  const spec = FORMATS[format];
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: scheme,
  });
  const page = await context.newPage();
  const errors = [];
  const puts = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.route('**/api/providers', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    const body = await response.json();
    const providers = (body.providers ?? []).map((item) =>
      item.id === spec.providerId
        ? {
            ...item,
            rulesModel: 'files',
            capabilities: { ...item.capabilities, rules: 'ready' },
          }
        : item,
    );
    return route.fulfill({ response, json: { ...body, active: spec.providerId, providers } });
  });
  await page.route('**/api/settings', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    const body = await response.json();
    return route.fulfill({ response, json: { ...body, provider: spec.providerId } });
  });
  await page.route('**/api/provider-rules', (route) =>
    route.fulfill({
      json: {
        providerId: spec.providerId,
        providerName: spec.providerName,
        format,
        scope: 'global',
        rulesDir: spec.rulesDir,
        dirExists: true,
        rules: spec.rules.map((rule) => ({ ...rule, fullPath: `${spec.rulesDir}/${rule.path}` })),
        ignored: [],
        readOnly: false,
      },
    }),
  );
  await page.route('**/api/provider-rules/rule?*', (route) =>
    route.fulfill({
      json: {
        ...spec.rule,
        fullPath: `${spec.rulesDir}/${spec.rule.path}`,
        body: 'Только функции.\n',
        otherKeys: [],
        readOnly: false,
      },
    }),
  );
  await page.route('**/api/provider-rules/rule', (route) => {
    if (route.request().method() !== 'PUT') return route.continue();
    puts.push(route.request().postDataJSON());
    return route.fulfill({ json: { ok: true } });
  });

  await page.goto(`${BASE}/rules`, { waitUntil: 'domcontentloaded' });
  await page
    .getByRole('heading', { name: `Правила · ${spec.providerName}` })
    .waitFor({ timeout: 20_000 });
  return { context, page, errors, puts };
}

const browser = await chromium.launch();
try {
  for (const format of ['qwen-md', 'cursor-mdc']) {
    const spec = FORMATS[format];
    const isQwen = format === 'qwen-md';
    console.log(`\n${spec.providerName} (${format})`);
    const { context, page, errors, puts } = await openRules(browser, format, 'light');

    const subtitle = isQwen
      ? 'Каталог правил Qwen Code: файлы .md, шаблоны paths'
      : 'Каталог правил Cursor: файлы .mdc с frontmatter';
    check(`подзаголовок «${subtitle}»`, (await page.getByText(subtitle).count()) > 0);
    if (isQwen) {
      check(
        'пояснение называет ограничение qwen serve',
        (await page.getByText(/чат панели работает через qwen serve/).count()) > 0,
      );
    }
    const badge = isQwen ? 'постоянное' : 'подключается всегда';
    check(
      `метка «${badge}» — ровно у одного правила`,
      (await page.getByText(badge, { exact: true }).count()) === 1,
    );

    const path = page.getByPlaceholder(`frontend/react${spec.extension}`);
    check(`поле пути с примером frontend/react${spec.extension}`, (await path.count()) === 1);
    const switches = await page.getByRole('switch', { name: SWITCH }).count();
    check(
      isQwen ? 'в форме создания переключателя alwaysApply нет' : 'в форме создания он есть',
      isQwen ? switches === 0 : switches === 1,
      String(switches),
    );

    await path.fill('team/style');
    await page.getByRole('button', { name: 'Создать правило' }).click();
    await page.waitForTimeout(600);
    const draft = puts.at(-1);
    check(
      `черновик ушёл с путём team/style${spec.extension}`,
      draft?.path === `team/style${spec.extension}`,
      JSON.stringify(draft),
    );
    check(
      isQwen ? 'в черновике нет alwaysApply' : 'в черновике alwaysApply есть',
      isQwen ? draft !== undefined && !('alwaysApply' in draft) : draft?.alwaysApply === false,
      JSON.stringify(draft),
    );

    await page.getByRole('button', { name: 'Править' }).nth(1).click();
    const globsLabel = isQwen ? 'Шаблоны файлов (paths)' : 'Шаблоны файлов (globs)';
    // Ждать поле тела: оно есть только в редакторе (подпись шаблонов есть и в форме
    // создания — по ней ожидание прошло бы до того, как редактор появился).
    await page.getByLabel('Текст правила (markdown)').waitFor({ timeout: 10_000 });
    check(
      `подпись шаблонов «${globsLabel}» в форме и редакторе`,
      (await page.getByText(globsLabel, { exact: true }).count()) === 2,
    );
    const editorSwitches = await page.getByRole('switch', { name: SWITCH }).count();
    check(
      isQwen
        ? 'в редакторе переключателя alwaysApply нет'
        : 'в редакторе переключатель есть (форма + редактор)',
      isQwen ? editorSwitches === 0 : editorSwitches === 2,
      String(editorSwitches),
    );
    check('без ошибок страницы', errors.length === 0, errors.join(' | '));
    await context.close();
  }

  if (SHOTS) {
    mkdirSync(SHOTS, { recursive: true });
    for (const scheme of ['light', 'dark']) {
      const { context, page } = await openRules(browser, 'qwen-md', scheme);
      await page.screenshot({ path: join(SHOTS, `qwen-rules-${scheme}.png`), fullPage: true });
      await context.close();
    }
    console.log(`\nСнимки: ${SHOTS}`);
  }
} finally {
  await browser.close();
}

console.log(bad === 0 ? '\nВсё сходится.' : `\nПровалов: ${bad}`);
process.exitCode = bad === 0 ? 0 : 1;
