/**
 * Сценарий `agents`: план агента, дерево субагентов и что у каждого сработало.
 *
 * В отличие от прочих сценариев «Чата» данные здесь НЕ подменяются ответами
 * сервера: в каталог конфигурации одноразовой панели кладётся настоящий
 * транскрипт главного агента и его субагентов (`tools/qa/subagent-tree-fixture.mjs`,
 * его же читает `check-agent-extensions.mjs`), и дерево, значки и окно «Скиллы,
 * хуки и MCP» сервер строит сам. Подменены только список чатов, дерево
 * разделения и лента родителя — у одноразовой панели их нет.
 *
 * Кадры обрезаны по полосе плана, окну и карточке группы: в шапке разговора
 * стоит путь проекта во временной папке машины, в справку ему не место.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { settings, closeOverlay } from './chat-stubs.mjs';
import { AGENT_IDS, TREE_SESSION, seedSubagentTree } from '../qa/subagent-tree-fixture.mjs';
import { GROUP_SESSION, PARENT, PROJECT_DIR, stubHub } from '../qa/subagent-tree-hub.mjs';

/** Транскрипт начат 12 минут назад: узлы показывают «за 3м 30с», а не сутки. */
const START = Date.now() - 12 * 60_000;

/** Окно «нужен доступ» ассистента панели: у одноразового каталога нет входа в CLI. */
async function closeAccessGate(page) {
  const gate = page.getByRole('dialog').filter({ hasText: /нужен доступ|needs access/ });
  await gate.waitFor({ timeout: 5000 }).catch(() => {});
  if (await gate.count())
    await gate
      .getByRole('button', { name: /^(Закрыть|Close)$/ })
      .last()
      .click();
}

async function openChatById(page, web, id) {
  await page.goto(`${web}/chat?id=${id}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('nav', { timeout: 90_000 });
  await closeAccessGate(page);
}

export async function shootAgents(browser, web, scenario, home) {
  const cwd = join(home, PROJECT_DIR);
  mkdirSync(cwd, { recursive: true });
  seedSubagentTree({ cfg: home, cwd, start: START });
  seedSubagentTree({ cfg: home, cwd, sessionId: GROUP_SESSION, start: START });

  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  // Знакомство с маскотом уже было: его приветствие ложилось на низ полосы плана.
  await page.addInitScript(() =>
    window.localStorage.setItem(
      'agentdeck.mascot',
      JSON.stringify({ enabled: false, chatty: false, greeted: true }),
    ),
  );
  try {
    await settings(page);
    await stubHub(page, cwd, START);

    // ── 01. Полоса плана: строка главного агента и значки узлов ─────────────
    await openChatById(page, web, TREE_SESSION);
    const sheet = page.locator('[data-chat-progress]');
    await sheet.waitFor({ timeout: 60_000 });
    await sheet.locator('button').first().click();
    await page
      .locator(`[data-agent-node="${AGENT_IDS.build}"] [data-agent-extensions]`)
      .waitFor({ timeout: 30_000 });
    await page.waitForTimeout(600);
    await scenario.shot(page, '01-tree', { clip: '[data-chat-progress]', padding: 8 });

    // ── 02. Окно «Скиллы, хуки и MCP» на узле «Сборки» ──────────────────────
    await page.locator(`[data-agent-node="${AGENT_IDS.build}"] [data-agent-extensions]`).click();
    const modal = page.locator('[data-agent-extensions-modal]');
    await modal.waitFor({ timeout: 10_000 });
    await modal.locator('[data-extension-group="hook"] li').first().waitFor({ timeout: 30_000 });
    await page.waitForTimeout(500);
    await scenario.shot(page, '02-extensions', { clip: '[role="dialog"]', padding: 24 });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    if (await modal.count()) await closeOverlay(page);

    // ── 03. Карточка группы у родителя: значки всей группы ──────────────────
    await openChatById(page, web, PARENT);
    const card = page.locator('[data-child-hub] [data-hub-row]').first();
    await card.waitFor({ timeout: 30_000 });
    await card.locator('[data-group-extensions] [data-agent-extensions]').waitFor({
      timeout: 30_000,
    });
    await page.waitForTimeout(1200);
    await scenario.shot(page, '03-group', { clip: '[data-child-hub] [data-hub-row]', padding: 8 });
  } finally {
    await page.close();
  }
}
