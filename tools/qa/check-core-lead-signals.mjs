/**
 * Сигнал ожидания места и отказы снимка трекера на экране (этап 11, волна 3, правка F-03/F-04) —
 * настоящая дорога: одноразовая панель + своё ядро (`runOnStand({ core })`), браузер ходит через
 * прокладку панели, ответы ядра и панели не перехватываются. Трекер — заглушка Jira на loopback
 * этого процесса (настоящего трекера нет и быть не должно).
 *
 * Что видно:
 *   - оценка задачи ведущего пишет в журнал `lead-session-wait`; лента задачи `/core?id=` рисует его
 *     ИЗВЕСТНЫМ сигналом: заголовок шаблона на ru и на en, факты, а не ключи JSON (отрицательный:
 *     `data-signal-known="false"` или сырой id вместо заголовка — провал);
 *   - английский интерфейс: ключ не того вида и пустой ответ Jira на снимок — английский текст
 *     отказа по коду, ни одной кириллической буквы (отрицательный: русская строка сервера — провал).
 *
 * Запуск: `node tools/qa/check-core-lead-signals.mjs` (стенд свой, `pnpm dev` не нужен).
 * `SHOTS=<dir>` — кадры в обеих темах. Код выхода: 0 — сходится, 1 — провал, 2 — стенд не поднялся.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { runOnStand } from './throwaway-stand.mjs';

const SHOTS = process.env.SHOTS || '';
// Дороге `cli` нужен найденный CLI, иначе оценка — отказ предпроверки. Модель стенду не нужна.
const FAKE_CLAUDE = `process.stderr.write('stand: no model here\\n'); process.exit(1);\n`;
const EMPTY_KEY = 'PROJ-77';
const CYRILLIC = /[А-Яа-яЁё]/;
const TITLE = {
  ru: 'Ожидание места для первого сеанса',
  en: 'Wait for a seat for the first session',
};

/** Заглушка Jira: `EMPTY_KEY` — 200 с пустым телом (отказ «тело пустое»), прочее — 404. */
function startJiraStub() {
  const calls = [];
  const server = createServer((req, res) => {
    calls.push(`${req.method} ${req.url}`);
    if ((req.url ?? '').includes(`/issue/${EMPTY_KEY}`)) {
      res.writeHead(200);
      res.end();
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ errorMessages: ['Issue does not exist'] }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        calls,
        stop: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

async function shoot(page, name) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  for (const theme of ['light', 'dark']) {
    await page.evaluate((t) => {
      document.documentElement.dataset.theme = t;
      document.documentElement.style.colorScheme = t;
    }, theme);
    await page.waitForTimeout(200);
    await page.screenshot({ path: join(SHOTS, `${name}-${theme}.png`), fullPage: true });
  }
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'light';
    document.documentElement.style.colorScheme = 'light';
  });
}

let repo = '';
const jira = await startJiraStub();
try {
  await runOnStand(
    {
      label: 'core-lead-signals',
      core: true,
      fakeCli: { claude: FAKE_CLAUDE },
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
      },
    },
    async (stand, check) => {
      const browser = await chromium.launch();
      try {
        const page = await stand.newPage(browser, { width: 1440, height: 3200 });
        await page.goto(`${stand.webUrl}/core/launch`);
        const form = page.locator('[data-core-launch-form]');
        await form.waitFor({ timeout: 120_000 });

        // ── оценка задачи ведущего: в журнал ложится ожидание места ──────────────────────────
        await form.getByLabel('Название', { exact: true }).fill('Ведущий: ожидание места');
        await form.getByLabel('Требования').fill('Добавить строку в a.txt.');
        await form.getByLabel('Путь к репозиторию').fill(repo);
        await form.getByLabel('Сценарий').selectOption('preset:lead');
        const answered = page.waitForResponse((r) => r.url().includes('/api/core/estimate'), {
          timeout: 180_000,
        });
        await page.locator('[data-estimate-button]').click();
        const response = await answered.catch(() => null);
        const reply = response ? await response.json().catch(() => null) : null;
        const taskId = reply?.taskId ?? '';
        if (
          !check(`оценка ведущего ответила задачей (${response?.status() ?? 0})`, Boolean(taskId))
        )
          return;

        // ── лента задачи: сигнал известен, заголовок шаблона, факты ─────────────────────────
        const signalOn = async (lng) => {
          await page.goto(`${stand.webUrl}/core?id=${taskId}`);
          const row = page.locator('[data-signal-id="lead-session-wait"]').first();
          const seen = await row
            .waitFor({ timeout: 60_000 })
            .then(() => true)
            .catch(() => false);
          if (!check(`${lng}: строка lead-session-wait в ленте задачи`, seen)) return;
          await row.scrollIntoViewIfNeeded();
          const known = await row.getAttribute('data-signal-known');
          const detail = await row.getAttribute('data-signal-detail');
          const title = (await row.locator('[data-signal-title]').innerText()).trim();
          check(
            `${lng}: сигнал известен, заголовок «${title}», деталь ${detail}`,
            known === 'true' && title === TITLE[lng] && detail === 'facts',
          );
          await shoot(page, `lead-session-wait-${lng}`);
        };
        await signalOn('ru');
        const en = await stand.api('/settings', { method: 'PATCH', body: { language: 'en' } });
        check('язык интерфейса переключён на en', en.status === 200, en.text);
        await page.reload();
        await page.waitForFunction(() => document.documentElement.lang === 'en', null, {
          timeout: 20_000,
        });
        await signalOn('en');

        // ── английский интерфейс: отказы снимка трекера — по коду, без кириллицы ───────────
        const put = await stand.api('/integrations/jira', {
          method: 'PUT',
          body: {
            settings: { enabled: true, baseUrl: jira.url, email: '', deployment: 'server' },
            token: 'stub-token',
          },
        });
        check(`Jira стенда — заглушка на loopback (${put.status})`, put.status === 200);
        await page.goto(`${stand.webUrl}/core/launch`);
        await form.waitFor({ timeout: 120_000 });
        await form.locator('[data-source-picker] select').first().selectOption('tracker');
        const refusal = async (key, want, name) => {
          await form.getByLabel('Tracker issue key').fill(key);
          const got = page.waitForResponse(
            (r) => r.url().includes('/core-intake/tracker-snapshot'),
            {
              timeout: 20_000,
            },
          );
          await form.locator('[data-source-tracker-read]').click();
          await got.catch(() => undefined);
          const alert = form.locator('[data-source-error]');
          await alert.waitFor({ timeout: 10_000 }).catch(() => undefined);
          const text = (await alert.innerText().catch(() => '')).trim();
          check(`en: ${name} — «${text}»`, text === want && !CYRILLIC.test(text));
          await shoot(page, `tracker-${name}-en`);
        };
        await refusal(
          'not a key',
          'Request rejected: a tracker issue key like PROJ-12 is required (key).',
          'key-invalid',
        );
        await refusal(
          EMPTY_KEY,
          `Jira returned no issue ${EMPTY_KEY}: the response body is empty.`,
          'issue-empty',
        );
        check(
          `ключ не того вида до Jira не дошёл (${jira.calls.join(' | ')})`,
          !jira.calls.some((c) => c.includes('not')) &&
            jira.calls.some((c) => c.includes(EMPTY_KEY)),
        );
        await stand.api('/settings', { method: 'PATCH', body: { language: 'ru' } });
      } finally {
        await browser.close();
      }
    },
  );
} finally {
  await jira.stop();
}
