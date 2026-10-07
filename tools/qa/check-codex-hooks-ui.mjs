/**
 * Раздел «Хуки» при активном Codex — что видит и нажимает человек (MAP 26).
 *
 * Серверная половина проверена настоящим codex (`check-codex-hooks-skills.mjs`:
 * `hooks/list` видит записанное с тем же матчером и таймаутом). Здесь — экран:
 *   - карточка одобрения: без `/hooks` внутри Codex правило не исполнится;
 *   - рубильник `[features] hooks = false` назван словами Codex, а не Qwen;
 *   - таблицы `[[hooks.…]]` в config.toml названы с путём;
 *   - подпись таймаута — секунды и СВОИ границы события: у Interrupt 1–3, по
 *     умолчанию 1; у PreToolUse 1–3600, по умолчанию 600; подсказка поля — то же
 *     умолчание;
 *   - сохранение уходит одним PUT с правилами в секундах;
 *   - отказ сервера (Interrupt 4 с) показан текстом, где назван Codex.
 *
 * Контроль — тот же редактор у Qwen Code: ни карточки одобрения, ни таблиц
 * config.toml, таймаут в миллисекундах. Без него «карточка есть» не умела бы
 * краснеть. Вариация по времени: сводка хуков приходит с задержкой — до неё на
 * экране нет ни карточки одобрения, ни подписей чужих границ.
 *
 * Настройки панели НЕ переключаются: активный провайдер и сводка подменяются в
 * браузере, запись перехватывается и на сервер не уходит.
 *
 * Запуск: `node tools/qa/check-codex-hooks-ui.mjs` при поднятом `pnpm dev`.
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

const CONFIG = 'C:/Users/me/.codex/config.toml';
const BASE_INFO = {
  scope: 'global',
  shape: 'event-rules',
  present: true,
  fileEdited: [],
  sessionCompleted: [],
  preservedEvents: [],
  preservedExperimental: [],
  preservedRules: [],
  readOnly: false,
};
const SPECS = {
  codex: {
    ...BASE_INFO,
    providerId: 'codex',
    providerName: 'Codex (OpenAI)',
    format: 'codex-json',
    filePath: 'C:/Users/me/.codex/hooks.json',
    events: [
      { name: 'PreToolUse', supportsMatcher: true },
      { name: 'Stop', supportsMatcher: false },
      { name: 'Interrupt', supportsMatcher: false, timeoutMax: 3, timeoutDefault: 1 },
    ],
    rules: [
      { event: 'PreToolUse', matcher: '^Bash$', command: 'node guard.js', timeout: 30 },
      { event: 'Interrupt', command: 'node int.js' },
    ],
    timeoutUnit: 's',
    timeoutMin: 1,
    timeoutMax: 3600,
    timeoutDefault: 600,
    trustRequired: true,
    disableAll: true,
    alsoDefinedIn: CONFIG,
  },
  qwen: {
    ...BASE_INFO,
    providerId: 'qwen',
    providerName: 'Qwen Code',
    format: 'qwen-json',
    filePath: 'C:/Users/me/.qwen/settings.json',
    events: [{ name: 'PreToolUse', supportsMatcher: true }],
    rules: [{ event: 'PreToolUse', matcher: '^Bash$', command: 'node guard.js' }],
    timeoutUnit: 'ms',
    timeoutMin: 1,
    timeoutMax: 600000,
    timeoutDefault: 60000,
    disableAll: true,
  },
};

const REFUSAL = {
  error: 'invalid_draft',
  message: 'x',
  messageCode: 'hooks-draft-invalid-foreign',
};

async function openHooks(browser, providerId, scheme, { delayMs = 0, refuse = false } = {}) {
  const spec = SPECS[providerId];
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: scheme,
  });
  const page = await context.newPage();
  const errors = [];
  const writes = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.route('**/api/providers', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    const body = await response.json();
    const providers = (body.providers ?? []).map((item) =>
      item.id === providerId
        ? { ...item, hooksModel: 'config', capabilities: { ...item.capabilities, hooks: 'ready' } }
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
  let release;
  const gate = new Promise((done) => (release = done));
  await page.route('**/api/provider-hooks', async (route) => {
    const request = route.request();
    if (request.method() === 'PUT') {
      writes.push(request.postDataJSON());
      return refuse
        ? route.fulfill({ status: 400, json: REFUSAL })
        : route.fulfill({ json: { ok: true, backupPath: 'b', needsRestart: true } });
    }
    if (delayMs) await gate;
    return route.fulfill({ json: spec });
  });

  await page.goto(`${BASE}/hooks`, { waitUntil: 'domcontentloaded' });
  await page
    .getByRole('heading', { name: `Хуки · ${spec.providerName}` })
    .waitFor({ timeout: 20_000 });
  return { context, page, errors, writes, release };
}

const browser = await chromium.launch();
try {
  console.log('\nCodex (codex-json)');
  {
    const { context, page, errors, writes } = await openHooks(browser, 'codex', 'light');
    await page
      .getByText('node guard.js')
      .first()
      .waitFor({ timeout: 5000 })
      .catch(() => {});
    check(
      'подзаголовок называет hooks.json, а не settings.json',
      (await page
        .getByText('Хуки Codex (OpenAI): правила в hooks.json — событие, матчер, команда')
        .count()) === 1,
    );
    check(
      'карточка одобрения называет /hooks',
      (await page
        .getByText(/Codex запускает хук только после одобрения: откройте \/hooks/)
        .count()) === 1,
    );
    check(
      'рубильник назван словами Codex, а не Qwen',
      (await page.getByText(/В config\.toml рядом стоит \[features\] hooks = false/).count()) ===
        1 && (await page.getByText(/disableAllHooks: true/).count()) === 0,
    );
    check(
      'таблицы [[hooks.…]] названы с путём config.toml',
      (await page
        .getByText(new RegExp(`\\[\\[hooks\\.…\\]\\] в ${CONFIG.replace(/[.]/g, '\\.')}`))
        .count()) === 1,
    );
    const preLabel = page.getByLabel('Таймаут, с (1–3600, по умолчанию 600)');
    const intLabel = page.getByLabel('Таймаут, с (1–3, по умолчанию 1)');
    check('PreToolUse: подпись 1–3600, по умолчанию 600', (await preLabel.count()) === 1);
    check('Interrupt: подпись своих границ 1–3, по умолчанию 1', (await intLabel.count()) === 1);
    check(
      'подсказка поля Interrupt — его умолчание 1',
      (await intLabel.getAttribute('placeholder')) === '1',
      String(await intLabel.getAttribute('placeholder')),
    );
    check('значение 30 у PreToolUse на месте', (await preLabel.inputValue()) === '30');

    await intLabel.fill('2');
    await page.getByRole('button', { name: 'Сохранить' }).click();
    await page.waitForTimeout(500);
    check(
      'сохранение — один PUT с правилами в секундах',
      writes.length === 1 &&
        JSON.stringify(writes[0]?.rules) ===
          JSON.stringify([
            { event: 'PreToolUse', command: 'node guard.js', matcher: '^Bash$', timeout: 30 },
            { event: 'Interrupt', command: 'node int.js', timeout: 2 },
          ]),
      JSON.stringify(writes),
    );
    check('без ошибок страницы', errors.length === 0, errors.join(' | '));
    await context.close();
  }

  console.log('\nОтказ сервера: Interrupt 4 с');
  {
    const { context, page, writes } = await openHooks(browser, 'codex', 'light', { refuse: true });
    const intLabel = page.getByLabel('Таймаут, с (1–3, по умолчанию 1)');
    await intLabel.fill('4');
    await page.getByRole('button', { name: 'Сохранить' }).click();
    await page.waitForTimeout(800);
    check('PUT ушёл с 4', writes.at(-1)?.rules?.at(-1)?.timeout === 4, JSON.stringify(writes));
    check(
      'отказ показан текстом, где назван Codex',
      (await page.getByText(/Qwen, Kimi и Codex: событие/).count()) > 0,
    );
    await context.close();
  }

  console.log('\nВремя: сводка хуков приходит с задержкой');
  {
    const { context, page, release } = await openHooks(browser, 'codex', 'light', { delayMs: 1 });
    await page.waitForTimeout(600);
    check(
      'до сводки — ни карточки одобрения, ни подписи границ',
      (await page.getByText(/после одобрения: откройте \/hooks/).count()) === 0 &&
        (await page.getByLabel(/Таймаут, с/).count()) === 0,
    );
    release();
    await page.getByText(/после одобрения: откройте \/hooks/).waitFor({ timeout: 5000 });
    check('после сводки карточка появилась', true);
    await context.close();
  }

  console.log('\nКонтроль: Qwen Code (qwen-json)');
  {
    const { context, page, errors } = await openHooks(browser, 'qwen', 'light');
    await page
      .getByText('node guard.js')
      .first()
      .waitFor({ timeout: 5000 })
      .catch(() => {});
    check(
      'подзаголовок Qwen называет settings.json',
      (await page
        .getByText('Хуки Qwen Code: правила в settings.json — событие, матчер, команда')
        .count()) === 1,
    );
    check(
      'карточки одобрения нет',
      (await page.getByText(/после одобрения: откройте \/hooks/).count()) === 0,
    );
    check(
      'рубильник назван словами Qwen',
      (await page.getByText(/disableAllHooks: true/).count()) === 1,
    );
    check('таблиц config.toml нет', (await page.getByText(/\[\[hooks\.…\]\]/).count()) === 0);
    check(
      'таймаут в миллисекундах',
      (await page.getByLabel('Таймаут, мс (по умолчанию 60000)').count()) === 1,
    );
    check('без ошибок страницы', errors.length === 0, errors.join(' | '));
    await context.close();
  }

  if (SHOTS) {
    mkdirSync(SHOTS, { recursive: true });
    for (const scheme of ['light', 'dark']) {
      const { context, page } = await openHooks(browser, 'codex', scheme);
      await page
        .getByText('node guard.js')
        .first()
        .waitFor({ timeout: 5000 })
        .catch(() => {});
      await page.screenshot({ path: join(SHOTS, `codex-hooks-${scheme}.png`), fullPage: true });
      await context.close();
    }
    console.log(`\nСнимки: ${SHOTS}`);
  }
} finally {
  await browser.close();
}

console.log(bad === 0 ? '\nВсё сходится.' : `\nПровалов: ${bad}`);
process.exitCode = bad === 0 ? 0 : 1;
