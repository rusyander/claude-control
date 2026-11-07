/**
 * Настройки ведущего на экране запуска (этап 11, W3-16) — блок «Ведение задачи» на `/core/launch`,
 * настоящая дорога: одноразовая панель + своё ядро (`runOnStand({ core })`), браузер ходит через
 * прокладку панели, ответы ядра не перехватываются. Трекер — заглушка Jira на loopback этого
 * процесса (настоящего трекера нет и быть не должно): панель читает задачу своим доменом
 * `core-intake` поверх `integrations/atlassian`, как у человека.
 *
 * Что видно:
 *   - блок «Ведение задачи» держит обе карточки: настройки ведения и серверы MCP (отрицательный:
 *     карточки MCP нет — провал);
 *   - профиль меняет параллельность 2 / 4 / 6, предел машины назван; в списке усилий нет «max»;
 *   - оценка ведущего называет профиль «Сбалансировано», класс и ступени ролей; «Настроить для
 *     этого проекта» ставит область проекта задачи; «Экономно» → «Сохранить» → `config.json` ядра
 *     несёт `lead.projects[X].profile = economy`, а `lead.defaults` не тронут (отрицательный:
 *     область проекта не ушла — провал);
 *   - следующая оценка называет «Экономно» и параллельность 2;
 *   - источник «Задача трекера»: ключ → снимок панели (заголовок, критерии) → в оценку уходит
 *     `source.kind = tracker` с отпечатком;
 *   - сброс ключа обучения уходит через прокладку (`POST /api/core/learned/reset`) и ложится
 *     в обучение ядра.
 *
 * Запуск: `node tools/qa/check-core-lead-settings.mjs` (стенд свой, `pnpm dev` не нужен).
 * `SHOTS=<dir>` — кадры страницы в обеих темах. Код выхода: 0 — сходится, 1 — провал, 2 — стенд
 * не поднялся.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import {
  checkDraftKeptAcrossCards,
  checkItemsAsGroup,
  checkLeadEditing,
  checkPicksKeptAcrossCards,
  checkSavedClearsOnEdit,
  checkTrackerReRead,
  checkTrackerSecrets,
  ISSUES,
  startJiraStub,
} from './core-lead-source-steps.mjs';
import { runOnStand } from './throwaway-stand.mjs';

const ISSUE = ISSUES.plain;

const SHOTS = process.env.SHOTS || '';

// Дороге `cli` нужен найденный CLI, иначе оценка — отказ предпроверки. Модель стенду не нужна.
const FAKE_CLAUDE = `process.stderr.write('stand: no model here\\n'); process.exit(1);\n`;

let repo = '';

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

/** Сбросы обучения ядра (`learned-resets.json`, P140) где угодно в доме стенда. */
function learnedFiles(dir, depth = 0) {
  if (depth > 4 || !existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...learnedFiles(path, depth + 1));
    else if (entry.name === 'learned-resets.json') out.push(path);
  }
  return out;
}

const jira = await startJiraStub();
try {
  await runOnStand(
    {
      label: 'core-lead-settings',
      core: true,
      fakeCli: { claude: FAKE_CLAUDE },
      seed: async ({ root, cfg }) => {
        // Сервер MCP человека в конфиге Claude Code стенда: карточке MCP есть что отметить.
        writeFileSync(
          join(cfg, '.claude.json'),
          JSON.stringify({ mcpServers: { probe: { command: process.execPath, args: ['-v'] } } }),
        );
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
      const cfgPath = join(stand.coreHome, 'config.json');
      const onDisk = () => JSON.parse(readFileSync(cfgPath, 'utf8'));
      const browser = await chromium.launch();
      try {
        // Высокое окно: прокрутка у панели своя (внутренний контейнер), `fullPage` её не видит.
        const page = await stand.newPage(browser, { width: 1440, height: 5200 });
        await page.goto(`${stand.webUrl}/core/launch`);
        await page.locator('[data-core-launch-form]').waitFor({ timeout: 120_000 });
        await shoot(page, 'lead-page');

        // ── блок «Ведение задачи»: обе карточки внутри ─────────────────────────────────────
        const block = page.locator('[data-lead-block]');
        const hasBlock = await block
          .waitFor({ timeout: 30_000 })
          .then(() => true)
          .catch(() => false);
        if (!check('блок «Ведение задачи» на экране запуска', hasBlock)) return;
        const card = block.locator('[data-lead-settings]');
        await card.locator('[data-lead-profile="balanced"]').waitFor({ timeout: 60_000 });
        check(
          'карточка серверов MCP — в том же блоке',
          (await block.locator('[data-launch-section="mcp-picks"]').count()) === 1,
        );

        // ── профили: параллельность 2 / 4 / 6, предел машины назван ────────────────────────
        await card.locator('[data-lead-advanced]').click();
        const parallel = card.locator('[data-lead-parallelism] input');
        await parallel.waitFor({ timeout: 10_000 });
        const seen = {};
        for (const profile of ['economy', 'balanced', 'max-quality']) {
          await card.locator(`[data-lead-profile="${profile}"]`).check();
          seen[profile] = await parallel.inputValue();
        }
        check(
          `параллельность по профилю: ${JSON.stringify(seen)}`,
          seen.economy === '2' && seen.balanced === '4' && seen['max-quality'] === '6',
        );
        const cap = await card
          .locator('[data-lead-parallelism-cap]')
          .innerText()
          .catch(() => '');
        check(`предел машины назван (${cap})`, /6/.test(cap));
        const efforts = await card
          .locator('[data-lead-role="review"] [data-lead-role-effort] option')
          .evaluateAll((options) => options.map((o) => o.value));
        check(
          `в списке усилий нет «max» (${efforts.join(',')})`,
          efforts.length > 0 && !efforts.includes('max') && efforts.includes('xhigh'),
        );
        await checkLeadEditing(card, check);
        await card.locator('[data-lead-profile="balanced"]').check();
        await shoot(page, 'lead-advanced');
        await checkDraftKeptAcrossCards(block, card, check);

        // ── оценка ведущего: «Сбалансировано», класс, ступени ролей ────────────────────────
        const form = page.locator('[data-core-launch-form]');
        const estimateOnce = async (title, { keepText = false } = {}) => {
          // exact: у пунктов источника свои поля «Название пункта N».
          if (!keepText) {
            await form.getByLabel('Название', { exact: true }).fill(title);
            await form.getByLabel('Требования').fill('Добавить строку в a.txt.');
          }
          await form.getByLabel('Путь к репозиторию').fill(repo);
          await form.getByLabel('Сценарий').selectOption('preset:lead');
          const sent = page.waitForRequest(
            (r) => r.method() === 'POST' && r.url().includes('/api/core/estimate'),
            { timeout: 20_000 },
          );
          // Оценка идёт в настоящее ядро стенда (предпроверка CLI каждой дороги): на занятой машине
          // ответ дольше минуты — окно шире, а в подписи видно, ушёл ли запрос и сколько ждали.
          const answered = page.waitForResponse((r) => r.url().includes('/api/core/estimate'), {
            timeout: 180_000,
          });
          const started = Date.now();
          await page.locator('[data-estimate-button]').click();
          const request = await sent.catch(() => null);
          const response = await answered.catch(() => null);
          const status = response?.status() ?? 0;
          const took = `${Math.round((Date.now() - started) / 1000)} с`;
          const reply = response ? await response.json().catch(() => null) : null;
          // Запрос не ушёл — форма назвала причину: её текст в подписи шага, а не «не ушёл» вслепую.
          const why = request
            ? ''
            : await form
                .locator('[data-source-problem], [role="alert"], [aria-invalid="true"]')
                .evaluateAll((els) =>
                  els.map((el) => el.textContent || el.getAttribute('aria-label')).join(' | '),
                )
                .catch(() => '');
          return {
            request,
            status,
            reply,
            label: request ? `${status}, ${took}` : `запрос не ушёл: ${why}`,
          };
        };
        const first = await estimateOnce('Ведущий: профиль по умолчанию');
        const lead = page.locator('[data-estimate-lead]');
        const shown = await lead
          .waitFor({ timeout: 60_000 })
          .then(() => true)
          .catch(() => false);
        if (
          !check(
            `оценка ведущего (${first.label}) показывает ведение`,
            shown,
            await page.locator('[data-core-launch]').innerText(),
          )
        )
          return;
        const leadText = (await lead.innerText()).replace(/\s+/g, ' ');
        check(
          `оценка называет «Сбалансировано», класс и ступени ролей (${leadText.slice(0, 160)})`,
          leadText.includes('Сбалансировано') &&
            (await lead.locator('[data-estimate-lead-class]').count()) === 1 &&
            (await lead.locator('[data-estimate-lead-role]').count()) === 7,
        );
        check(
          'ожидание места сеанса названо',
          (await lead.locator('[data-estimate-lead-wait]').count()) === 1,
        );
        await shoot(page, 'lead-estimate-balanced');

        // ── «для этого проекта» → «Экономно» → запись настройки ядра ───────────────────────
        await lead.locator('[data-lead-scope-this]').click();
        const scope = await card.locator('[data-lead-scope] select').inputValue();
        check(`область — проект задачи (${scope})`, scope !== '' && scope.startsWith('repo-'));
        await card.locator('[data-lead-profile="economy"]').check();
        await card.locator('[data-lead-save]').click();
        const saved = await card
          .locator('[data-lead-saved]')
          .waitFor({ timeout: 20_000 })
          .then(() => true)
          .catch(() => false);
        const refused = saved
          ? ''
          : await card
              .locator('[data-lead-refused]')
              .innerText()
              .catch(() => '');
        check(`«Сохранить» — запись принята ${refused}`, saved);
        const doc = onDisk();
        check(
          `config.json: lead.projects[${scope}].profile = economy, умолчания не тронуты (${JSON.stringify(doc.lead)})`,
          doc.lead?.projects?.[scope]?.profile === 'economy' && doc.lead?.defaults === undefined,
        );
        const view = await stand.api('/core/config');
        check(
          `GET /config через прокладку называет economy (${view.status})`,
          view.body?.doc?.lead?.projects?.[scope]?.profile === 'economy',
        );
        await checkSavedClearsOnEdit(card, check);

        const second = await estimateOnce('Ведущий: проект на экономном профиле');
        await page
          .locator('[data-estimate-lead][data-lead-profile="economy"]')
          .waitFor({ timeout: 60_000 })
          .catch(() => undefined);
        const after = (await lead.innerText().catch(() => '')).replace(/\s+/g, ' ');
        check(
          `следующая оценка (${second.label}) называет «Экономно» и параллельность 2 (${after.slice(0, 160)})`,
          after.includes('Экономно') &&
            (await lead.getAttribute('data-lead-parallelism').catch(() => '')) === '2',
        );
        await shoot(page, 'lead-estimate-economy');

        // ── источник «Задача трекера»: снимок панели уходит в оценку ───────────────────────
        const put = await stand.api('/integrations/jira', {
          method: 'PUT',
          body: {
            settings: { enabled: true, baseUrl: jira.url, email: '', deployment: 'server' },
            token: 'stub-token',
          },
        });
        check(`Jira стенда — заглушка на loopback (${put.status})`, put.status === 200);
        await form.getByLabel('Источник').selectOption('tracker');
        await form.getByLabel('Ключ задачи трекера').fill(ISSUE.key);
        await form.locator('[data-source-tracker-read]').click();
        const snapshot = form.locator('[data-source-snapshot]');
        const read = await snapshot
          .first()
          .waitFor({ timeout: 20_000 })
          .then(() => true)
          .catch(() => false);
        const snapText = read ? (await snapshot.first().innerText()).replace(/\s+/g, ' ') : '';
        const error = read
          ? ''
          : await form
              .locator('[data-source-error]')
              .innerText()
              .catch(() => '');
        check(
          `снимок трекера прочитан панелью: заголовок и 2 критерия (${snapText.slice(0, 120)}${error})`,
          snapText.includes(ISSUE.fields.summary) && /2/.test(snapText),
        );
        check(
          `заглушка Jira получила запрос панели (${jira.calls.join(' | ')})`,
          jira.calls.some((c) => c.includes(`/issue/${ISSUE.key}`)),
        );
        const third = await estimateOnce('Ведущий: задача трекера');
        const body = JSON.parse(third.request?.postData() ?? '{}');
        const source = body.fields?.source;
        check(
          `в оценку ушёл снимок трекера (${third.label}): ${source?.kind} ${source?.key}, критериев ${source?.acceptance?.length}, отпечаток ${String(source?.digest).slice(0, 12)}`,
          source?.kind === 'tracker' &&
            source?.key === ISSUE.key &&
            /^[0-9a-f]{64}$/.test(source?.digest ?? '') &&
            source?.acceptance?.length === 2 &&
            // Оценка ядра принимается в работу (202), как и две предыдущие.
            third.status === 202,
        );
        await shoot(page, 'lead-source-tracker');
        await checkTrackerReRead(page, form, check);
        await checkTrackerSecrets({
          page,
          stand,
          check,
          estimate: () => estimateOnce('', { keepText: true }),
        });

        // ── источник «Несколько пунктов»: одна задача ядра, приём несёт каждый пункт ─────────
        // Текстовые пункты — одна задача (группу дают только пункты вида group-item, W3-18):
        // ядро читает `fields.sources` (`sourcesOf`) и пишет их в решение `intake`.
        const ITEMS = [
          { title: 'Экспорт CSV', body: 'Кнопка экспорта CSV в отчёте.' },
          { title: 'Экспорт XLSX', body: 'Тот же отчёт в XLSX.' },
          { title: 'Подпись файла', body: 'Имя файла — дата отчёта.' },
        ];
        await form.getByLabel('Источник').selectOption('items');
        for (const [i, item] of ITEMS.entries()) {
          if (i > 0) await form.getByRole('button', { name: 'Добавить пункт' }).click();
          await form.getByLabel(`Название пункта ${i + 1}`).fill(item.title);
          await form.getByLabel(`Текст пункта ${i + 1}`).fill(item.body);
        }
        const itemsTitle = 'Ведущий: несколько пунктов';
        const fourth = await estimateOnce(itemsTitle);
        const sent = JSON.parse(fourth.request?.postData() ?? '{}').fields?.sources ?? [];
        check(
          `в оценку ушли все пункты (${fourth.label}): ${sent.map((s) => `${s.kind}:${s.title}`).join(', ')}`,
          sent.length === ITEMS.length &&
            sent.every((s, i) => s.kind === 'text' && s.title === ITEMS[i].title) &&
            fourth.status === 202,
        );
        const taskId = fourth.reply?.taskId ?? '';
        const listed = await stand.api('/core/tasks');
        const sameTitle = (listed.body?.tasks ?? []).filter((t) => t.title === itemsTitle);
        check(
          `пункты — одна задача ядра: без группы в ответе, задач с этим названием ${sameTitle.length}`,
          Boolean(taskId) && fourth.reply?.group === undefined && sameTitle.length === 1,
        );
        // Журнал задачи — тем же потоком, что читает лента панели (`/api/core/tasks/:id/events`).
        const intake = await page.evaluate(
          async ({ id }) => {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 20_000);
            try {
              const res = await fetch(`/api/core/tasks/${encodeURIComponent(id)}/events`, {
                signal: ctrl.signal,
              });
              const reader = res.body.getReader();
              const decoder = new TextDecoder();
              let buf = '';
              for (;;) {
                const { done, value } = await reader.read();
                if (done) return null;
                buf += decoder.decode(value, { stream: true });
                for (const line of buf.split('\n')) {
                  if (!line.startsWith('data:')) continue;
                  try {
                    const row = JSON.parse(line.slice(5));
                    const rows = Array.isArray(row) ? row : [row];
                    for (const r of rows)
                      if (r?.kind === 'decision' && r.data?.class === 'intake')
                        return r.data.output;
                  } catch {
                    // строка ещё не дочитана — ждём следующий кусок
                  }
                }
              }
            } catch {
              return null;
            } finally {
              clearTimeout(timer);
              ctrl.abort();
            }
          },
          { id: taskId },
        );
        const got = intake?.sources ?? [];
        check(
          `решение intake задачи несёт каждый пункт: ${got.map((s) => s.title).join(', ') || 'решения нет'}`,
          got.length === ITEMS.length &&
            got.every((s, i) => s.title === ITEMS[i].title && /^[0-9a-f]{64}$/.test(s.digest)) &&
            got.map((s) => s.digest).join() === sent.map((s) => s.digest).join(),
        );
        await shoot(page, 'lead-source-items');
        await checkItemsAsGroup({ page, form, stand, check, estimate: estimateOnce, items: ITEMS });
        await shoot(page, 'lead-source-group');

        // ── сброс ключа обучения через прокладку ───────────────────────────────────────────
        const reset = card.locator('[data-learned-reset]');
        await reset.getByLabel('Проект').fill(scope);
        await reset.getByLabel('Вид шага').selectOption('work');
        await reset.getByLabel('CLI').fill('claude');
        await reset.getByLabel('Маршрут').fill('claude-subscription');
        const resetCall = page.waitForResponse((r) => r.url().includes('/api/core/learned/reset'), {
          timeout: 20_000,
        });
        await reset.locator('[data-learned-reset-submit]').click();
        const resetStatus = (await resetCall.catch(() => null))?.status() ?? 0;
        const done = await reset
          .locator('[data-learned-reset-done]')
          .waitFor({ timeout: 20_000 })
          .then(() => true)
          .catch(() => false);
        const files = learnedFiles(stand.coreHome);
        const learned = files.map((f) => readFileSync(f, 'utf8')).join('\n');
        check(
          `сброс ключа обучения через прокладку (${resetStatus}) лёг в learned-resets.json (${files.length})`,
          resetStatus === 200 && done && learned.includes(scope),
          await reset.innerText().catch(() => ''),
        );
        await checkPicksKeptAcrossCards(block, card, check);
        check('страница без ошибок', page.errors.length === 0, page.errors.join('\n'));
      } finally {
        await browser.close();
      }
    },
  );
} finally {
  await jira.stop();
}
