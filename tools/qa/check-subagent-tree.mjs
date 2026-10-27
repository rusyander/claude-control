/**
 * Дерево агентов и субагентов в чате и в карточке группы.
 *
 * Что проверяется на живом интерфейсе одноразового стенда:
 * 1. «План агента» показывает субагентов деревом (`role="tree"`): вложенный
 *    субагент — веткой второго уровня под тем, кто его запустил; узел,
 *    найденный только по файлам субагента (середина большого транскрипта не
 *    прочитана), — тоже в дереве.
 * 2. У узла видны модель, вызовы инструментов, токены, время и последнее
 *    действие — всё посчитано сервером по файлу субагента.
 * 3. Клавиатура дерева: стрелки ходят по узлам, ← сворачивает, → разворачивает,
 *    Enter открывает ход субагента панелью справа; Escape её закрывает и
 *    возвращает фокус на узел.
 * 4. Панель справа — шаги субагента из его транскрипта (вызовы и результаты),
 *    только чтение.
 * 5. «Остановить» у идущего субагента уходит запросом с его id (сам путь до
 *    CLI доказывает `check-subagent-stop.mjs` на настоящем CLI).
 * 6. Карточка группы в хабе называет, сколько агентов идёт и сколько
 *    закончено; переход из неё открывает чат группы с панелью нужного агента.
 * 7. axe (WCAG 2.1 AA) по дереву, панели хода и полосе агентов карточки —
 *    без серьёзных нарушений.
 * Обе темы, без ошибок страницы.
 *
 * Данные: разговоры засеяны синтетикой (`subagent-tree-fixture.mjs`) в дом
 * стенда, прогресс и ход субагента отдаёт настоящий сервер стенда. Подменено
 * только то, чего у стенда нет: живой процесс разговора (`processAlive`,
 * `canStopAgents`) и хаб родителя (`/api/chats`, `/api/chat/*\/tree`).
 *
 * Запуск: `node tools/qa/check-subagent-tree.mjs`; `SHOTS=<папка>` и
 * `PHASE=before|after` — снимки обеих тем.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';
import { runOnStand } from './throwaway-stand.mjs';
import { bypassOnboarding } from './bypass-onboarding.mjs';
import { AGENT_IDS, TREE_SESSION, seedSubagentTree } from './subagent-tree-fixture.mjs';
import { GROUP_SESSION, PARENT, PROJECT_DIR, openChat, stubHub } from './subagent-tree-hub.mjs';

const suffix = process.env.PHASE ? `_${process.env.PHASE.toUpperCase()}` : '';
const START = Date.now() - 12 * 60_000;

/** Решения «Остановить», ушедшие с экрана. */
const stops = [];

async function stubLive(page, stand) {
  // Живого процесса у стенда нет — его признак подменяется в настоящем ответе
  // сервера, всё остальное (дерево, счётчики, модели) — как посчитал сервер.
  await page.route('**/api/chat/*/progress*', async (route) => {
    try {
      const response = await route.fetch();
      const body = await response.json();
      await route.fulfill({
        response,
        json: { ...body, processAlive: true, canStopAgents: true },
      });
    } catch {
      /* страница закрыта */
    }
  });
  await page.route('**/api/chat/*/agents/*/stop', async (route) => {
    const parts = new URL(route.request().url()).pathname.split('/');
    stops.push({ chatId: parts[3], agentId: parts[5], method: route.request().method() });
    // Как ответил настоящий CLI 2.1.310 на `stop_task` (check-subagent-stop.mjs).
    await route.fulfill({ json: { outcome: 'requested' } });
  });
  void stand;
}

/** Серьёзные и критические нарушения axe в указанных областях — строками. */
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

async function shot(page, locator, name) {
  if (!process.env.SHOTS) return;
  mkdirSync(process.env.SHOTS, { recursive: true });
  await locator.first().scrollIntoViewIfNeeded();
  await locator.first().screenshot({ path: join(process.env.SHOTS, `${name}${suffix}.png`) });
}

await runOnStand(
  {
    label: 'subagent-tree',
    seed: ({ cfg, home }) => {
      const cwd = join(home, PROJECT_DIR);
      mkdirSync(cwd, { recursive: true });
      seedSubagentTree({ cfg, cwd, start: START });
      seedSubagentTree({ cfg, cwd, sessionId: GROUP_SESSION, start: START });
    },
  },
  async (stand, check) => {
    const cwd = join(stand.home, PROJECT_DIR);
    // Сервер сам: дерево и счётчики по засеянным файлам, без браузера.
    const progress = await stand.api(`/chat/${TREE_SESSION}/progress`);
    const agents = progress.body?.agents ?? [];
    const byAgent = (agentId) => agents.find((agent) => agent.agentId === agentId);
    check('сервер: пять узлов дерева', agents.length === 5, JSON.stringify(agents).slice(0, 400));
    check(
      'сервер: вложенный субагент знает родителя',
      byAgent(AGENT_IDS.nested)?.parentId !== undefined &&
        byAgent(AGENT_IDS.nested)?.parentId === byAgent(AGENT_IDS.review)?.id,
      JSON.stringify(byAgent(AGENT_IDS.nested) ?? null).slice(0, 300),
    );
    check(
      'сервер: узел без вызова в главном транскрипте построен по meta и закончен',
      byAgent(AGENT_IDS.orphan)?.status === 'done',
      JSON.stringify(byAgent(AGENT_IDS.orphan) ?? null).slice(0, 300),
    );
    const explore = byAgent(AGENT_IDS.explore);
    check(
      'сервер: у «Разведки» модель, 3 вызова, токены и последнее действие',
      explore?.model === 'claude-haiku-4-5' &&
        explore?.toolCalls === 3 &&
        Object.values(explore?.tokens ?? {}).reduce((sum, value) => sum + value, 0) > 0 &&
        Boolean(explore?.lastAction),
      JSON.stringify(explore ?? null).slice(0, 300),
    );
    const detail = await stand.api(`/chat/${TREE_SESSION}/agents/${AGENT_IDS.explore}`);
    check(
      'сервер: ход субагента — шаги с вызовами и результатами',
      detail.status === 200 &&
        (detail.body?.steps ?? []).some(
          (step) =>
            step.kind === 'tool' && step.name === 'Grep' && step.result?.includes('build.ts'),
        ),
      detail.text.slice(0, 300),
    );
    const bad = await stand.api(`/chat/${TREE_SESSION}/agents/..%2F..%2Fetc`);
    check('сервер: чужой id агента — 400, не путь', bad.status === 400, bad.text.slice(0, 200));

    const browser = await chromium.launch();
    try {
      for (const theme of ['light', 'dark']) {
        console.log(`Тема: ${theme}`);
        // Свой контекст, а не `stand.newPage`: axe разбирает только страницу
        // контекста, открытого через `browser.newContext()`.
        const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
        const page = await context.newPage();
        page.errors = [];
        page.on('pageerror', (error) => page.errors.push(error.message));
        await bypassOnboarding(page, { theme });
        await stubLive(page, stand);
        await stubHub(page, cwd, START);
        await openChat(stand, page, TREE_SESSION);

        const sheet = page.locator('[data-chat-progress]');
        await sheet.waitFor({ timeout: 60_000 });
        await sheet.locator('button').first().click();
        await page.waitForTimeout(600);

        const tree = page.locator('[data-chat-progress] [role="tree"]');
        const hasTree = (await tree.count()) === 1;
        check(`${theme}: субагенты — деревом (role=tree)`, hasTree);
        const node = (agentId) => page.locator(`[data-agent-node="${agentId}"]`);
        check(
          `${theme}: пять узлов, вложенный — второго уровня`,
          (await page.locator('[data-agent-node]').count()) === 5 &&
            (await node(AGENT_IDS.nested).getAttribute('aria-level')) === '2',
        );
        const exploreText = hasTree ? ((await node(AGENT_IDS.explore).textContent()) ?? '') : '';
        check(
          `${theme}: узел «Разведки» — модель, вызовы, токены, время, последнее действие`,
          /haiku/i.test(exploreText) &&
            /3 вызов/.test(exploreText) &&
            /ток/.test(exploreText) &&
            /точка входа/.test(exploreText),
          exploreText.slice(0, 300),
        );
        await shot(page, sheet, `tree-sheet-${theme}`);

        // Клавиатура: фокус на первом узле, вниз-вниз — «Ревью», ← сворачивает.
        let keyboard = false;
        if (hasTree) {
          await node(AGENT_IDS.explore).focus();
          await page.keyboard.press('ArrowDown');
          const onReview = await node(AGENT_IDS.review).evaluate(
            (item) => item === document.activeElement,
          );
          await page.keyboard.press('ArrowLeft');
          const collapsed =
            (await node(AGENT_IDS.review).getAttribute('aria-expanded')) === 'false' &&
            !(await node(AGENT_IDS.nested).isVisible());
          await page.keyboard.press('ArrowRight');
          const expanded = await node(AGENT_IDS.nested).isVisible();
          await page.keyboard.press('ArrowRight');
          const intoChild = await node(AGENT_IDS.nested).evaluate(
            (item) => item === document.activeElement,
          );
          keyboard = onReview && collapsed && expanded && intoChild;
          check(
            `${theme}: стрелки — ↓ к соседу, ← свернуть, → развернуть и войти`,
            keyboard,
            JSON.stringify({ onReview, collapsed, expanded, intoChild }),
          );
          await page.keyboard.press('Enter');
        } else {
          check(`${theme}: стрелки — ↓ к соседу, ← свернуть, → развернуть и войти`, false);
        }

        const pane = page.locator('[data-agent-pane]');
        await pane.waitFor({ timeout: 5000 }).catch(() => {});
        // Шапка рисуется сразу, ход приходит отдельным запросом — ждём его шаги.
        await pane
          .locator('ol li')
          .first()
          .waitFor({ timeout: 5000 })
          .catch(() => {});
        const paneText = (await pane.count()) ? ((await pane.textContent()) ?? '') : '';
        check(
          `${theme}: Enter открыл ход вложенного субагента справа`,
          paneText.includes('Проверка тестов отчётов') && paneText.includes('**/*.test.ts'),
          paneText.slice(0, 300),
        );
        await shot(page, page.locator('[data-chat-page], main').first(), `tree-pane-${theme}`);
        // Доступность дерева и панели хода — axe по тем же правилам, что общий обход.
        if (await pane.count()) {
          const issues = await axeIssues(page, ['[data-chat-progress]', '[data-agent-pane]']);
          check(
            `${theme}: axe — дерево и ход без серьёзных нарушений`,
            issues.length === 0,
            issues.join(' | '),
          );
        }
        if (await pane.count()) {
          await page.keyboard.press('Escape');
          await page.waitForTimeout(300);
          const back = await node(AGENT_IDS.nested).evaluate(
            (item) => item === document.activeElement,
          );
          check(
            `${theme}: Escape закрыл панель и вернул фокус на узел`,
            (await pane.count()) === 0 && back,
          );
        } else {
          check(`${theme}: Escape закрыл панель и вернул фокус на узел`, false);
        }

        // «Остановить» — только у идущего, и уходит с его id.
        const stop = node(AGENT_IDS.review).locator('[data-agent-stop]');
        const stopCount = await stop.count();
        const doneStops = await node(AGENT_IDS.explore).locator('[data-agent-stop]').count();
        check(
          `${theme}: «Остановить» есть только у идущего субагента`,
          stopCount === 1 && doneStops === 0,
        );
        if (stopCount === 1) {
          const before = stops.length;
          await stop.click();
          await page.waitForTimeout(400);
          const sent = stops.slice(before);
          check(
            `${theme}: «Остановить» — POST с id агента`,
            sent.length === 1 &&
              sent[0].agentId === AGENT_IDS.review &&
              sent[0].chatId === TREE_SESSION &&
              sent[0].method === 'POST',
            JSON.stringify(sent),
          );
          // «Запрошена», а не «остановлен»: подтверждение CLI ≠ остановка (замер 2.1.310).
          const said = (await node(AGENT_IDS.review).textContent()) ?? '';
          check(
            `${theme}: после «Остановить» — «остановка запрошена»`,
            /запрошен/.test(said),
            said,
          );
        }

        // Карточка группы: счётчики и переход к агенту.
        await openChat(stand, page, PARENT);
        const card = page.locator('[data-child-hub] [data-hub-row]').first();
        await card.waitFor({ timeout: 30_000 }).catch(() => {});
        await page.waitForTimeout(1500);
        const strip = card.locator('[data-group-agents]');
        const stripText = (await strip.count()) ? ((await strip.textContent()) ?? '') : '';
        check(
          `${theme}: карточка группы — сколько агентов идёт и закончено`,
          /1 ид/.test(stripText) && /4 законч|3 готов/.test(stripText),
          stripText.slice(0, 200),
        );
        await shot(page, card, `group-card-${theme}`);
        if (await strip.count()) {
          const issues = await axeIssues(page, ['[data-group-agents]']);
          check(
            `${theme}: axe — агенты в карточке без серьёзных нарушений`,
            issues.length === 0,
            issues.join(' | '),
          );
        }
        const jump = strip.locator(`[data-group-agent-jump="${AGENT_IDS.review}"]`);
        if ((await jump.count()) === 1) {
          await jump.click();
          await page.waitForURL(new RegExp(GROUP_SESSION), { timeout: 10_000 }).catch(() => {});
          await pane.waitFor({ timeout: 8000 }).catch(() => {});
          const opened = (await pane.count()) ? ((await pane.textContent()) ?? '') : '';
          check(
            `${theme}: переход из карточки — чат группы и панель «Ревью»`,
            page.url().includes(GROUP_SESSION) && opened.includes('Ревью правок отчётов'),
            `${page.url()} | ${opened.slice(0, 200)}`,
          );
        } else {
          check(`${theme}: переход из карточки — чат группы и панель «Ревью»`, false);
        }

        check(
          `${theme}: ошибок страницы нет`,
          page.errors.length === 0,
          page.errors.join(' | ').slice(0, 300),
        );
        await context.close();
      }
    } finally {
      await browser.close();
    }
  },
);
