/**
 * Вкладка «Тесты → Прогоны»: агентский прогон, прошедший через ядро, открывается ЗАДАЧЕЙ ЯДРА
 * (`/core?id=<coreTaskId>`), а не разговором чата. Сессия такого прогона — сессия ядра, чата с
 * этим id нет, ссылка «Открыть разговор» вела в пустоту (этап 10, зона F6). Прогон без задачи
 * ядра (старая запись) по-прежнему ведёт в чат по `sessionId`.
 *
 * Стенд свой (`runOnStand`), записи прогонов подложены в проект стенда — настоящий конфиг и
 * `pnpm dev` не нужны, после себя ничего не оставляет. Код выхода: 0 — сходится, 1 — провал.
 * `--shot <png>` — снимок вкладки (пары до/после).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';
import { runOnStand, wait } from './throwaway-stand.mjs';

const shotAt = process.argv.indexOf('--shot');
const shot = shotAt > 0 ? process.argv[shotAt + 1] : '';
const CORE_SESSION = '01a19b30-aaaa-7000-8000-000000000001';
const CORE_TASK = '01a19b30-bbbb-7000-8000-000000000002';
const CHAT_SESSION = '01a19b30-cccc-7000-8000-000000000003';
let project = '';

function runRecord(id, startedAt, extra) {
  return `${JSON.stringify(
    {
      id,
      mode: 'run',
      actor: 'agent',
      groupId: 'gui',
      status: 'done',
      startedAt,
      finishedAt: startedAt.replace(':00.000Z', ':10.000Z'),
      provider: 'claude',
      tokens: 1200,
      costUsd: 0,
      results: [],
      summary: { total: 0, passed: 0, failed: 0, blocked: 0, skipped: 0 },
      ...extra,
    },
    null,
    2,
  )}\n`;
}

await runOnStand(
  {
    label: 'runs-core-link',
    seed: ({ root }) => {
      project = join(root, 'project');
      const tests = join(project, '.agent', 'tests');
      mkdirSync(join(tests, 'runs'), { recursive: true });
      writeFileSync(
        join(tests, 'gui.tests.json'),
        `${JSON.stringify({ version: 1, title: 'gui', cases: [{ id: 'gui-001', type: 'case', title: 'Вход', steps: [{ action: 'открыть', expected: 'открыто' }] }] }, null, 2)}\n`,
      );
      writeFileSync(
        join(tests, 'runs', 'run-core.run.json'),
        runRecord('run-core', '2026-11-02T09:00:00.000Z', {
          sessionId: CORE_SESSION,
          coreTaskId: CORE_TASK,
        }),
      );
      writeFileSync(
        join(tests, 'runs', 'run-chat.run.json'),
        runRecord('run-chat', '2026-11-01T09:00:00.000Z', { sessionId: CHAT_SESSION }),
      );
      execFileSync('git', ['init', '-q'], { cwd: project });
    },
  },
  async (stand, check) => {
    const added = await stand.api('/projects', { method: 'POST', body: { path: project } });
    check('проект добавлен', added.status < 300, added.text);
    const browser = await chromium.launch();
    try {
      const page = await stand.newPage(browser, { width: 1440, height: 900 });
      await page.goto(`${stand.webUrl}/tests?project=${encodeURIComponent(project)}&tab=runs`);
      await page
        .locator('[class*=runLink]')
        .first()
        .waitFor({ timeout: 20_000 })
        .catch(() => undefined);
      await wait(800);
      if (shot) {
        mkdirSync(dirname(shot), { recursive: true });
        await page.screenshot({ path: shot, fullPage: false });
      }
      const hrefs = await page
        .locator('a')
        .evaluateAll((as) => as.map((a) => a.getAttribute('href') ?? ''));
      check(
        'прогон через ядро ведёт в задачу ядра',
        hrefs.includes(`/core?id=${CORE_TASK}`),
        hrefs.join('\n'),
      );
      check(
        'прогон через ядро не ведёт в чат по сессии ядра',
        !hrefs.some((href) => href.includes(CORE_SESSION)),
        hrefs.filter((href) => href.includes(CORE_SESSION)).join('\n'),
      );
      check(
        'прогон без задачи ядра по-прежнему ведёт в чат',
        hrefs.includes(`/chat?id=${CHAT_SESSION}`),
        hrefs.join('\n'),
      );
      check('страница без ошибок', page.errors.length === 0, page.errors.join('\n'));
    } finally {
      await browser.close();
    }
  },
);
