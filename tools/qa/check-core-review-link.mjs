/**
 * Форма «Ревью MR по ссылке» на экране запуска ядра (этап 10, F8) — настоящая дорога браузера:
 * одноразовая панель + своё ядро (`startStand({ core: true })`), без перехвата ответов ядра.
 *
 * Что видно:
 *   - ссылка не на MR/PR — ошибка поля под ним, запрос не уходит;
 *   - годная ссылка + репозиторий — `POST /api/core/review-link` с полями `url`, `repo`, `lang` и
 *     доказательством человека (`nonce`, `page`);
 *   - remote репозитория без API форжа (у стенда нет настроек форжа) — ядро отказывает кодом
 *     `review_link_forge_unsupported`, плашка называет код и адрес remote, задача не создана.
 * Открытие задачи на открытом MR проверяет набор ядра на заглушке форжа
 * (`review-link.integration.test.ts`): стенду для этого нужны сайт форжа и ключ в хранилище панели.
 *
 * Запуск: `node tools/qa/check-core-review-link.mjs` (стенд свой, `pnpm dev` не нужен).
 * `SHOTS=<dir>` — кадры формы в обеих темах. `CORE_DIRECT=1` — обход ОДНОГО шва: запрос ревью идёт
 * из браузера прямо в ядро стенда с его токеном, мимо прокладки панели (пока в списке ручек панели
 * нет `/review-link`); вердикт кейса — только прогон без флага.
 * Код выхода: 0 — сходится, 1 — провал, 2 — стенд не поднялся.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { runOnStand } from './throwaway-stand.mjs';

const SHOTS = process.env.SHOTS || '';
const DIRECT = process.env.CORE_DIRECT === '1';
// Хост примера: у стенда нет сайта форжа с таким адресом, поэтому remote — «другой» форж без API.
const REMOTE = 'https://tracker.example.com/group/app.git';
const MR_URL = 'https://tracker.example.com/group/app/-/merge_requests/12';

let repo = '';

/**
 * Ответ ревью придержан на `HOLD_MS`: так видно промежуточное состояние (кнопка занята, второй
 * запрос не уходит). Ответ не подделан — запрос идёт дальше как есть (или прямо в ядро при
 * `CORE_DIRECT=1`).
 */
const HOLD_MS = 1500;

async function holdReview(page, stand) {
  const token = DIRECT ? readFileSync(join(stand.coreHome, 'token'), 'utf8').trim() : '';
  const core = DIRECT
    ? JSON.parse(readFileSync(join(stand.coreHome, 'procs.json'), 'utf8')).cores.at(-1)
    : null;
  await page.route(/\/api\/core\/review-link$/, async (route) => {
    await new Promise((r) => setTimeout(r, HOLD_MS));
    if (!core) return route.continue();
    const response = await route.fetch({
      url: `${core.url}/v1/review-link`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    });
    return route.fulfill({ response });
  });
}

async function shoot(page, name) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  const form = page.locator('[data-launch-section="review-link"]');
  for (const theme of ['light', 'dark']) {
    await page.evaluate((t) => {
      document.documentElement.dataset.theme = t;
      document.documentElement.style.colorScheme = t;
    }, theme);
    await page.waitForTimeout(150);
    await form.screenshot({ path: join(SHOTS, `${name}-${theme}_AFTER.png`) });
  }
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'light';
  });
}

await runOnStand(
  {
    label: 'core-review-link',
    core: true,
    seed: async ({ root }) => {
      repo = join(root, 'repo');
      mkdirSync(repo, { recursive: true });
      const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' });
      git('init', '-q', '-b', 'main');
      git('config', 'user.email', 'stand@example.com');
      git('config', 'user.name', 'stand');
      writeFileSync(join(repo, 'a.txt'), 'a\n');
      git('add', '.');
      git('commit', '-qm', 'init');
      git('remote', 'add', 'origin', REMOTE);
    },
  },
  async (stand, check) => {
    const browser = await chromium.launch();
    try {
      const page = await stand.newPage(browser, { width: 1440, height: 2400 });
      await holdReview(page, stand);
      const posts = [];
      page.on('request', (r) => {
        if (r.method() === 'POST' && r.url().includes('/api/core/review-link')) posts.push(r);
      });
      await page.goto(`${stand.webUrl}/core/launch`);
      const form = page.locator('[data-review-link-form]');
      await form.waitFor({ timeout: 30_000 });
      check('форма ревью по ссылке на экране запуска', true);

      await form
        .getByLabel('Ссылка на MR или PR')
        .fill('https://tracker.example.com/group/app/-/issues/3');
      await form.getByLabel('Путь к репозиторию').fill(repo);
      await page.locator('[data-review-link-button]').click();
      await page.waitForTimeout(400);
      const formText = await form.innerText();
      check(
        'ссылка не на MR — ошибка поля, запрос не ушёл',
        formText.includes('Это не ссылка на MR GitLab или PR GitHub.') && posts.length === 0,
        `запросов ${posts.length}\n${formText}`,
      );

      await form.getByLabel('Ссылка на MR или PR').fill(MR_URL);
      const sent = page.waitForResponse(
        (r) => r.request().method() === 'POST' && r.url().includes('/api/core/review-link'),
        { timeout: 30_000 },
      );
      const button = page.locator('[data-review-link-button]');
      // Сначала уходит запрос одноразового номера, потом сам POST — ждём именно POST.
      const issued = page.waitForRequest(
        (r) => r.method() === 'POST' && r.url().includes('/api/core/review-link'),
        { timeout: 30_000 },
      );
      await button.click();
      await issued.catch(() => null);
      // Ответ придержан: кнопка занята, повторное нажатие второго запроса не шлёт.
      const busy = await button.isDisabled();
      await button.click({ force: true }).catch(() => {});
      const response = await sent.catch(() => null);
      await page.waitForTimeout(300);
      check(
        'пока ответа нет — кнопка занята, второй запрос не ушёл',
        busy && posts.length === 1,
        `занята ${busy}, запросов ${posts.length}`,
      );
      if (!check('форма отправила ревью по ссылке', response !== null, await form.innerText()))
        return;
      const body = JSON.parse(response.request().postData() ?? '{}');
      check(
        'в теле — url, repo, lang и доказательство человека',
        body.fields?.url === MR_URL &&
          body.fields?.repo === repo &&
          body.fields?.lang === 'ru' &&
          typeof body.proof?.nonce === 'string' &&
          typeof body.proof?.page === 'string',
        JSON.stringify(body),
      );
      if (DIRECT) console.log('  · прокладка панели не проверялась: CORE_DIRECT=1');
      else
        check(
          'панель пересылает /api/core/review-link в ядро',
          response.status() !== 404,
          `статус ${response.status()}: ${await response.text().catch(() => '')}`,
        );
      const plate = page.locator('[data-review-link-refusal]');
      const shown = await plate
        .waitFor({ timeout: 20_000 })
        .then(() => true)
        .catch(() => false);
      const code = shown ? await plate.getAttribute('data-review-link-refusal') : null;
      const plateText = shown ? await plate.innerText() : '';
      check(
        'remote без API форжа — отказ review_link_forge_unsupported с адресом remote',
        response.status() === 422 &&
          code === 'review_link_forge_unsupported' &&
          plateText.includes('tracker.example.com/group/app.git'),
        `статус ${response.status()}, код ${code}\n${plateText || (await form.innerText())}`,
      );
      check(
        'карточек оценки нет — задача не создана',
        (await page.locator('[data-launch-section="estimate"]').count()) === 0,
      );
      await shoot(page, 'core-review-link-refused');
      check('страница без ошибок', page.errors.length === 0, page.errors.join('\n'));
    } finally {
      await browser.close();
    }
  },
);
