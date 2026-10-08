/**
 * Панель при другом провайдере и машине без каталога Claude Code (развилки A2, A3).
 *
 * «Обзор»: карточка каталога при выбранном не-Claude провайдере — серая, «Claude
 * Code не используется», без строк о ненайденных файлах; при выбранном Claude —
 * по-прежнему красное «не найден». Мастер первого запуска: у другого CLI шага
 * «Доступ Claude Code» нет — счётчик «из 3», и шаг доступа, сохранённый до смены
 * провайдера, становится последним из оставшихся.
 *
 * Настройки панели НЕ переключаются: провайдер, каталог и найденные CLI
 * подменяются на лету в браузере, на стенде и на диске ничего не меняется.
 *
 * Запуск: `node tools/qa/check-no-claude-ui.mjs` при поднятом `pnpm dev`.
 * `SHOTS=<каталог>` — снимки карточки и мастера в светлой и тёмной теме.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

const BASE = process.env.APP_URL ?? 'http://localhost:8888';
const SHOTS = process.env.SHOTS;

let bad = 0;
const check = (ok, text) => {
  console.log(`${ok ? '✓' : '✗'} ${text}`);
  if (!ok) bad += 1;
};

/** Ответ стенда с заплаткой поверх — только для этой вкладки. */
async function patchJson(page, pattern, patch) {
  await page.route(pattern, async (route) => {
    try {
      if (route.request().method() !== 'GET') return await route.continue();
      const response = await route.fetch();
      const body = await response.json();
      const next = typeof patch === 'function' ? patch(body) : { ...body, ...patch };
      return await route.fulfill({ response, json: next });
    } catch {
      /* вкладка закрыта — отвечать некому */
    }
  });
}

const NO_CLAUDE = (body) => ({
  ...body,
  isValid: false,
  source: 'not-found',
  missing: ['settings.json', 'CLAUDE.md'],
});
const DETECT_QWEN = (body) => ({
  ...body,
  providers: (body.providers ?? []).map((item) =>
    item.id === 'qwen' ? { ...item, cliInstalled: true } : item,
  ),
});

async function openPage({ scheme, provider, onboardingDone, storedStep }) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: scheme,
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await patchJson(page, '**/api/settings', { provider, onboardingDone });
  await patchJson(page, '**/api/location', NO_CLAUDE);
  await patchJson(page, '**/api/providers/detect/detect', DETECT_QWEN);
  await patchJson(page, '**/api/overview', (body) => ({
    ...body,
    provider:
      provider === 'claude'
        ? { id: 'claude', name: 'Claude Code' }
        : { id: provider, name: 'Qwen Code' },
  }));
  if (storedStep) {
    await page.addInitScript(
      (step) => sessionStorage.setItem('agentdeck:onboarding-step', step),
      storedStep,
    );
  }
  await page.goto(`${BASE}/`, { waitUntil: 'load' });
  return { context, page, errors };
}

const shot = async (page, name) => {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
};

const browser = await chromium.launch();

for (const scheme of ['light', 'dark']) {
  // 1. «Обзор» при Qwen без каталога Claude.
  {
    const { context, page, errors } = await openPage({
      scheme,
      provider: 'qwen',
      onboardingDone: true,
    });
    const unused = page.getByText('Claude Code не используется');
    await unused
      .first()
      .waitFor({ timeout: 15_000 })
      .catch(() => {});
    check(
      (await unused.count()) > 0,
      `[${scheme}] Qwen без ~/.claude: бейдж «Claude Code не используется»`,
    );
    check(
      (await page.getByText('Не найдены файлы').count()) === 0,
      `[${scheme}] строки «Не найдены файлы» нет`,
    );
    check(
      (await page.getByRole('dialog').count()) === 0,
      `[${scheme}] мастер не открылся — панель готова без Claude`,
    );
    check(
      errors.length === 0,
      `[${scheme}] ошибок страницы нет${errors.length ? `: ${errors[0]}` : ''}`,
    );
    await shot(page, `${scheme}-overview-qwen`);
    await context.close();
  }

  // 2. Отрицательная: выбран сам Claude — каталог обязателен, красное «не найден».
  {
    const { context, page } = await openPage({ scheme, provider: 'claude', onboardingDone: true });
    const missing = page.getByText('Не найдены файлы');
    await missing
      .first()
      .waitFor({ state: 'attached', timeout: 15_000 })
      .catch(() => {});
    check(
      (await missing.count()) > 0,
      `[${scheme}] Claude без ~/.claude: «Не найдены файлы» на месте`,
    );
    check(
      (await page.getByText('Claude Code не используется').count()) === 0,
      `[${scheme}] у Claude нет «не используется»`,
    );
    await context.close();
  }

  // 3. Мастер у Qwen: три шага; сохранённый «доступ» → последний из трёх.
  {
    const { context, page } = await openPage({ scheme, provider: 'qwen', onboardingDone: false });
    const dialog = page.getByRole('dialog');
    await dialog.waitFor({ timeout: 15_000 }).catch(() => {});
    check(
      await dialog
        .getByText('Шаг 1 из 3')
        .isVisible()
        .catch(() => false),
      `[${scheme}] мастер у Qwen: «Шаг 1 из 3»`,
    );
    await shot(page, `${scheme}-wizard-qwen`);
    await context.close();
  }
  {
    const { context, page } = await openPage({
      scheme,
      provider: 'qwen',
      onboardingDone: false,
      storedStep: 'access',
    });
    const dialog = page.getByRole('dialog');
    await dialog.waitFor({ timeout: 15_000 }).catch(() => {});
    check(
      await dialog
        .getByText('Шаг 3 из 3')
        .isVisible()
        .catch(() => false),
      `[${scheme}] сохранённый шаг доступа у Qwen → «Шаг 3 из 3»`,
    );
    check(
      (await dialog.getByText('Доступ Claude Code').count()) === 0,
      `[${scheme}] шага «Доступ Claude Code» у Qwen нет`,
    );
    await context.close();
  }

  // 4. Отрицательная: мастер у Claude — по-прежнему четыре шага.
  {
    const { context, page } = await openPage({ scheme, provider: 'claude', onboardingDone: false });
    const dialog = page.getByRole('dialog');
    await dialog.waitFor({ timeout: 15_000 }).catch(() => {});
    check(
      await dialog
        .getByText('Шаг 1 из 4')
        .isVisible()
        .catch(() => false),
      `[${scheme}] мастер у Claude: «Шаг 1 из 4»`,
    );
    await context.close();
  }
}

await browser.close();
console.log(bad ? `\n${bad} провал(ов)` : '\nчисто');
process.exit(bad ? 1 : 0);
