/**
 * Скиллы, хуки и MCP каждого агента — в чате и в карточке группы.
 *
 * Что проверяется на живом интерфейсе одноразового стенда:
 * 1. Сервер по засеянным транскриптам: хронология главного агента и субагента
 *    (`/api/chat/:id/extensions`, `/agents/:agentId/extensions`) — скилл и MCP
 *    с итогом и временем от вызова до результата, хук с замером CLI, отказ хука
 *    перед вызовом; сводки в прогрессе разговора. Чужой id — 400, нет агента
 *    или разговора — 404 с кодом.
 * 2. «План агента»: строка главного агента и значки узла субагента — имена
 *    скиллов, серверы MCP, число хуков и отказов.
 * 3. Окно: открывается с узла на этом агенте, три группы с итогом и
 *    длительностью (меньше секунды — в мс), переключение на главного агента и
 *    на агента без срабатываний; пока хронология читается — «Читаю
 *    транскрипт…» (ответ сервера задержан); Escape закрывает и возвращает фокус.
 * 4. Карточка группы в хабе: значки всей группы, щелчок — то же окно.
 * 5. axe (WCAG 2.1 AA) по окну и строкам значков. Обе темы, без ошибок страницы.
 *
 * Данные — синтетика `subagent-tree-fixture.mjs`, всё остальное отдаёт
 * настоящий сервер стенда; подменён только хаб родителя.
 *
 * Запуск: `node tools/qa/check-agent-extensions.mjs`; `SHOTS=<папка>` — снимки
 * обеих тем (справка «Чат» и «Группы»).
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';
import { runOnStand } from './throwaway-stand.mjs';
import { bypassOnboarding } from './bypass-onboarding.mjs';
import { AGENT_IDS, TREE_SESSION, seedSubagentTree } from './subagent-tree-fixture.mjs';
import { GROUP_SESSION, PARENT, PROJECT_DIR, openChat, stubHub } from './subagent-tree-hub.mjs';

const START = Date.now() - 12 * 60_000;
const BUILD = AGENT_IDS.build;

async function axeIssues(page, selectors) {
  let builder = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']);
  for (const selector of selectors) builder = builder.include(selector);
  const { violations } = await builder.analyze();
  return violations
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .map(
      (violation) => `${violation.id}: ${violation.nodes.map((node) => node.target).join(', ')}`,
    );
}

async function shot(locator, name) {
  if (!process.env.SHOTS) return;
  mkdirSync(process.env.SHOTS, { recursive: true });
  await locator.first().scrollIntoViewIfNeeded();
  await locator.first().screenshot({ path: join(process.env.SHOTS, `${name}.png`) });
}

const textOf = async (locator) =>
  (await locator.count()) ? ((await locator.first().textContent()) ?? '') : '';

await runOnStand(
  {
    label: 'agent-extensions',
    seed: ({ cfg, home }) => {
      const cwd = join(home, PROJECT_DIR);
      mkdirSync(cwd, { recursive: true });
      seedSubagentTree({ cfg, cwd, start: START });
      seedSubagentTree({ cfg, cwd, sessionId: GROUP_SESSION, start: START });
    },
  },
  async (stand, check) => {
    const cwd = join(stand.home, PROJECT_DIR);

    // 1. Сервер.
    const main = await stand.api(`/chat/${TREE_SESSION}/extensions`);
    const mainItems = main.body?.items ?? [];
    const plan = mainItems.find((item) => item.kind === 'skill' && item.name === 'reports-plan');
    const brief = mainItems.find((item) => item.kind === 'hook' && item.name === 'session-brief');
    check(
      'сервер: главный — скилл reports-plan прошёл за 6 с, хук session-brief 240 мс',
      main.status === 200 &&
        plan?.outcome === 'ok' &&
        plan?.durationMs === 6000 &&
        brief?.outcome === 'ok' &&
        brief?.durationMs === 240 &&
        mainItems.every((item) => item.kind !== 'mcp'),
      main.text.slice(0, 400),
    );
    const build = await stand.api(`/chat/${TREE_SESSION}/agents/${BUILD}/extensions`);
    const items = build.body?.items ?? [];
    const pick = (kind, name) => items.find((item) => item.kind === kind && item.name === name);
    check(
      'сервер: «Сборка» — скилл, MCP tracker/get_issue за 30 с, отказ git-guard, два хука',
      build.status === 200 &&
        build.body?.agentId === BUILD &&
        pick('skill', 'reports-build')?.outcome === 'ok' &&
        pick('mcp', 'tracker/get_issue')?.durationMs === 30_000 &&
        pick('hook', 'git-guard')?.outcome === 'denied' &&
        pick('hook', 'gate-at-end')?.durationMs === 85 &&
        pick('hook', 'context-watch')?.outcome === 'context' &&
        build.body?.total === 5,
      build.text.slice(0, 500),
    );
    const progress = await stand.api(`/chat/${TREE_SESSION}/progress`);
    const buildNode = (progress.body?.agents ?? []).find((agent) => agent.agentId === BUILD);
    const hooks = (buildNode?.extensions ?? []).filter((row) => row.kind === 'hook');
    check(
      'сервер: сводки в прогрессе — у главного и у «Сборки», отказ посчитан',
      (progress.body?.extensions ?? []).some((row) => row.name === 'reports-plan') &&
        hooks.reduce((sum, row) => sum + row.count, 0) === 3 &&
        hooks.reduce((sum, row) => sum + (row.denied ?? 0), 0) === 1,
      JSON.stringify(buildNode?.extensions ?? null).slice(0, 400),
    );
    const bad = await stand.api(`/chat/${TREE_SESSION}/agents/..%2F..%2Fetc/extensions`);
    const none = await stand.api(`/chat/${TREE_SESSION}/agents/a9e0c0ffee0000009/extensions`);
    const lost = await stand.api(`/chat/9e3c1a52-0d4b-4a8e-9b1f-5c2d7a6e9f99/extensions`);
    check(
      'сервер: чужой id — 400, нет агента — 404 agent-not-found, нет разговора — 404',
      bad.status === 400 &&
        none.status === 404 &&
        none.text.includes('agent-not-found') &&
        lost.status === 404,
      `${bad.status} ${bad.text.slice(0, 80)} | ${none.status} ${none.text.slice(0, 80)} | ${lost.status}`,
    );

    const browser = await chromium.launch();
    try {
      for (const theme of ['light', 'dark']) {
        console.log(`Тема: ${theme}`);
        const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await bypassOnboarding(page, { theme });
        await stubHub(page, cwd, START);
        // Первый запрос хронологии «Сборки» задержан: окно должно сказать, что читает.
        let delayed = false;
        await page.route(`**/api/chat/*/agents/${BUILD}/extensions*`, async (route) => {
          if (!delayed) {
            delayed = true;
            await new Promise((resolve) => setTimeout(resolve, 1500));
          }
          await route.continue().catch(() => {});
        });
        await openChat(stand, page, TREE_SESSION);

        // 2. Строка главного агента и значки узла.
        const sheet = page.locator('[data-chat-progress]');
        await sheet.waitFor({ timeout: 60_000 });
        await sheet.locator('button').first().click();
        await page.waitForTimeout(600);
        const mainLine = await textOf(sheet.locator('[data-progress-extensions]'));
        check(
          `${theme}: строка главного агента — reports-plan и «хуки 1»`,
          mainLine.includes('reports-plan') && mainLine.includes('хуки 1'),
          mainLine,
        );
        const chips = page.locator(`[data-agent-node="${BUILD}"] [data-agent-extensions]`);
        const chipsText = await textOf(chips);
        check(
          `${theme}: значки «Сборки» — скилл, сервер MCP, «хуки 3», «отказ 1»`,
          chipsText.includes('reports-build') &&
            chipsText.includes('tracker') &&
            chipsText.includes('хуки 3') &&
            chipsText.includes('отказ 1'),
          chipsText,
        );
        const exploreChips = await page
          .locator(`[data-agent-node="${AGENT_IDS.explore}"] [data-agent-extensions]`)
          .count();
        check(`${theme}: у «Разведки» без срабатываний значков нет`, exploreChips === 0);
        await shot(sheet, `agent-extensions-tree-${theme}`);

        // 3. Окно с узла.
        const modal = page.locator('[data-agent-extensions-modal]');
        if ((await chips.count()) === 1) {
          await chips.click();
          await modal.waitFor({ timeout: 5000 }).catch(() => {});
          const loading = await textOf(modal.locator(`[data-extensions-timeline="${BUILD}"]`));
          check(
            `${theme}: пока ответ задержан — «Читаю транскрипт…»`,
            /Читаю транскрипт/.test(loading),
            loading,
          );
          await modal
            .locator('[data-extension-group="hook"] li')
            .first()
            .waitFor({ timeout: 8000 })
            .catch(() => {});
          const pressed = await modal
            .locator(`[data-extensions-agent="${BUILD}"]`)
            .getAttribute('aria-pressed');
          const count = (kind) => modal.locator(`[data-extension-group="${kind}"] li`).count();
          const timeline = await textOf(modal.locator('[data-extensions-timeline]'));
          check(
            `${theme}: окно открыто на «Сборке» — скилл 1, MCP 1, хуки 3, один отказ`,
            pressed === 'true' &&
              (await count('skill')) === 1 &&
              (await count('mcp')) === 1 &&
              (await count('hook')) === 3 &&
              (await modal.locator('[data-extension-outcome="denied"]').count()) === 1,
            timeline.slice(0, 300),
          );
          check(
            `${theme}: длительности — «30с» у MCP, «85 мс» у хука, отказ с причиной`,
            timeline.includes('30с') &&
              timeline.includes('85 мс') &&
              timeline.includes('push needs'),
            timeline.slice(0, 400),
          );
          await shot(page.getByRole('dialog').first(), `agent-extensions-modal-${theme}`);
          const issues = await axeIssues(page, ['[data-agent-extensions-modal]']);
          check(
            `${theme}: axe — окно без серьёзных нарушений`,
            issues.length === 0,
            issues.join(' | '),
          );

          await modal.locator('[data-extensions-agent="main"]').click();
          await modal
            .locator('[data-extensions-timeline="main"]')
            .waitFor({ timeout: 5000 })
            .catch(() => {});
          await page.waitForTimeout(500);
          const mainTimeline = await textOf(modal.locator('[data-extensions-timeline="main"]'));
          check(
            `${theme}: главный агент в окне — reports-plan «6с», session-brief «240 мс»`,
            mainTimeline.includes('reports-plan') &&
              mainTimeline.includes('6с') &&
              mainTimeline.includes('240 мс'),
            mainTimeline.slice(0, 300),
          );
          await modal.locator(`[data-extensions-agent="${AGENT_IDS.nested}"]`).click();
          await page.waitForTimeout(800);
          const empty = await modal.locator('[data-extensions-state="empty"]').count();
          check(`${theme}: агент без срабатываний — «пока нет»`, empty === 1);

          await page.keyboard.press('Escape');
          await page.waitForTimeout(400);
          const focusBack = await page.evaluate(() =>
            Boolean(document.activeElement?.closest('[data-agent-extensions]')),
          );
          check(
            `${theme}: Escape закрыл окно и вернул фокус на значки`,
            (await modal.count()) === 0 && focusBack,
          );
        } else {
          check(`${theme}: окно открыто на «Сборке» — скилл 1, MCP 1, хуки 3, один отказ`, false);
        }
        const issues = await axeIssues(page, ['[data-chat-progress]']);
        check(
          `${theme}: axe — значки в дереве без серьёзных нарушений`,
          issues.length === 0,
          issues.join(' | '),
        );

        // 4. Карточка группы.
        await openChat(stand, page, PARENT);
        const card = page.locator('[data-child-hub] [data-hub-row]').first();
        await card.waitFor({ timeout: 30_000 }).catch(() => {});
        await page.waitForTimeout(1500);
        const groupChips = card.locator('[data-group-extensions] [data-agent-extensions]');
        const groupText = await textOf(groupChips);
        check(
          `${theme}: карточка группы — скиллы всей группы, «хуки 4», «отказ 1»`,
          groupText.includes('reports-plan') &&
            groupText.includes('reports-build') &&
            groupText.includes('хуки 4') &&
            groupText.includes('отказ 1'),
          groupText,
        );
        await shot(card, `agent-extensions-group-${theme}`);
        if ((await groupChips.count()) === 1) {
          await groupChips.click();
          await modal.waitFor({ timeout: 5000 }).catch(() => {});
          const listed = await modal.locator('[data-extensions-agent]').count();
          const mainPressed = await modal
            .locator('[data-extensions-agent="main"]')
            .getAttribute('aria-pressed');
          check(
            `${theme}: из карточки — окно на главном агенте, в списке он и пять субагентов`,
            listed === 6 && mainPressed === 'true' && page.url().includes(PARENT),
            `${listed} ${mainPressed} ${page.url()}`,
          );
          await page.keyboard.press('Escape');
        } else {
          check(
            `${theme}: из карточки — окно на главном агенте, в списке он и пять субагентов`,
            false,
          );
        }

        check(
          `${theme}: ошибок страницы нет`,
          errors.length === 0,
          errors.join(' | ').slice(0, 300),
        );
        await context.close();
      }
    } finally {
      await browser.close();
    }
  },
);
