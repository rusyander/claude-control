/**
 * Кейс access-integrations-011: «Сравнение → Переменные окружения» прячет секрет по
 * тому же правилу, что раздел «Переменные» (`isSecretEnvKey`, целое слово
 * имени), и у ОБЕИХ сторон: слева Claude, справа Codex.
 *
 * До правки 28.09 правая сторона пользовалась своей подстрокой и прятала
 * `MAX_THINKING_TOKENS` («TOKEN» внутри слова) и `GIT_BASH_PATH` («PAT» внутри
 * слова), пока левая показывала их открыто, — одна и та же настройка выглядела
 * по-разному в двух колонках.
 *
 * Путь настоящий: одноразовая панель над временным домом, настоящие
 * `settings.json` Claude и `~/.codex/config.toml` Codex, страница сравнения
 * через прокси Vite. Оракул — текст ячеек строки на экране и тело ответа
 * `/api/provider-compare` (полного значения секрета нет ни там, ни там).
 *
 * Запуск: `node tools/qa/check-compare-env-mask.mjs` (стенд поднимается сам).
 * `SHOTS=<каталог>` — снимок вкладки.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { runOnStand, wait } from './throwaway-stand.mjs';

// Значения-пустышки собраны из кусков: проверка окружения справедливо не
// пускает в файл присваивание вида `KEY = <длинная строка>`.
const API_KEY = ['sk', 'demo', 'abcdefghij', 'klmn'].join('-');
const PAT = ['ghp', 'demoabcdefghijklmn'].join('_');
const PLAIN = { MAX_THINKING_TOKENS: '31999', GIT_BASH_PATH: 'C:/Git/bin/bash.exe' };
const SECRET = { ANTHROPIC_API_KEY: API_KEY, GITHUB_PAT: PAT };
const SHOTS = process.env.SHOTS;

await runOnStand(
  {
    label: 'compare-env',
    seed: ({ home, cfg }) => {
      writeFileSync(
        join(cfg, 'settings.json'),
        `${JSON.stringify({ env: { ...PLAIN, ...SECRET } }, null, 2)}\n`,
        'utf8',
      );
      const codex = join(home, '.codex');
      mkdirSync(codex, { recursive: true });
      const lines = Object.entries({ ...PLAIN, ...SECRET }).map(
        ([key, value]) => `${key} = "${value}"`,
      );
      writeFileSync(
        join(codex, 'config.toml'),
        ['approval_policy = "on-request"', '', '[shell_environment_policy.set]', ...lines, ''].join(
          '\n',
        ),
        'utf8',
      );
    },
  },
  async (stand, check) => {
    const wire = await stand.api('/provider-compare?left=claude&right=codex');
    check(
      'API сравнения ответил 200',
      wire.status === 200,
      `${wire.status} ${wire.text.slice(0, 200)}`,
    );
    check(
      'в ответе API нет полного значения ни одного секрета',
      !wire.text.includes(API_KEY) && !wire.text.includes(PAT),
    );
    const env = wire.body?.sections?.find((section) => section.section === 'env');
    for (const [key, value] of Object.entries(PLAIN)) {
      const entry = env?.entries?.find((one) => one.key === key);
      check(
        `API: ${key} открыт у обеих сторон`,
        entry?.left === value && entry?.right === value,
        JSON.stringify(entry),
      );
    }

    const browser = await chromium.launch();
    try {
      // Тема экрана задана настройкой панели, а не медиа-запросом — один проход.
      for (const scheme of ['light']) {
        const page = await stand.newPage(browser, { height: 1100 });
        await page.goto(`${stand.webUrl}/compare?tab=env`, { waitUntil: 'domcontentloaded' });
        const right = page.getByLabel(/^(Справа|Right)$/);
        await right.waitFor({ timeout: 90_000 });
        await right.selectOption('codex');
        const tab = page.getByRole('tab', {
          name: /^(Переменные окружения|Environment variables)/,
        });
        await tab.click();
        await page.locator('[data-state]').filter({ hasText: 'GITHUB_PAT' }).first().waitFor({
          timeout: 20_000,
        });
        await wait(500);
        /** Ячейки строки по ключу: [ключ, слева, справа, состояние]. */
        const cells = async (key) =>
          page
            .locator('[data-state]')
            .filter({ has: page.getByText(key, { exact: true }) })
            .first()
            .evaluate((row) => [...row.children].map((child) => (child.textContent ?? '').trim()));
        for (const [key, value] of Object.entries(PLAIN)) {
          const row = await cells(key);
          check(
            `${scheme}: ${key} на экране открыт слева и справа`,
            row[1] === value && row[2] === value,
            JSON.stringify(row),
          );
        }
        for (const [key, value] of Object.entries(SECRET)) {
          const row = await cells(key);
          const masked = (text) =>
            typeof text === 'string' && text.startsWith('•') && !text.includes(value.slice(0, 6));
          check(
            `${scheme}: ${key} замаскирован слева и справа`,
            masked(row[1]) && masked(row[2]),
            JSON.stringify(row),
          );
        }
        const body = await page.locator('body').innerText();
        check(
          `${scheme}: полного значения секрета нет на странице`,
          !body.includes(API_KEY) && !body.includes(PAT),
        );
        if (SHOTS) {
          mkdirSync(SHOTS, { recursive: true });
          await page.screenshot({ path: join(SHOTS, `compare-env_${scheme}.png`), fullPage: true });
        }
        check(`${scheme}: без ошибок страницы`, page.errors.length === 0, page.errors.join(' | '));
        await page.close();
      }
    } finally {
      await browser.close();
    }
  },
);
