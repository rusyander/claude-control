/**
 * Сценарий `agents`: план агента над полем ввода и окно «Агенты» — узлы ядра этого разговора.
 *
 * Данные подменены ответами сервера (`tools/qa/agent-history-stub.mjs`, его же обходят проверки
 * доступности и клавиатуры): список узлов ядра, узел подробно, план агента и сам чат. Подмена
 * проверена схемами контрактов ядра — окно рисует ровно то, что ядро отдало бы.
 *
 * Кадры обрезаны по полосе плана и окну: в шапке разговора стоит путь проекта, в справку ему не
 * место.
 */
import { settings, closeOverlay } from './chat-stubs.mjs';
import {
  AGENT_HISTORY_CHAT,
  AGENT_HISTORY_IDS,
  installAgentHistoryStub,
} from '../qa/agent-history-stub.mjs';

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

export async function shootAgents(browser, web, scenario) {
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
    await installAgentHistoryStub(page);
    await page.goto(`${web}/chat?id=${AGENT_HISTORY_CHAT}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('nav', { timeout: 90_000 });
    await closeAccessGate(page);

    // ── 01. Полоса плана и карточка «Агенты · фоном: 1» ─────────────────────
    const sheet = page.locator('[data-chat-progress]');
    await sheet.waitFor({ timeout: 60_000 });
    await sheet.locator('button').first().click();
    await page.locator('[data-agent-tree]').waitFor({ timeout: 30_000 });
    await page.locator('[data-agent-history-bg="1"]').waitFor({ timeout: 30_000 });
    await page.waitForTimeout(600);
    await page.evaluate(() => {
      document
        .querySelector('[data-chat-progress]')
        ?.parentElement?.setAttribute('data-shot-agents', '');
    });
    await scenario.shot(page, '01-tree', { clip: '[data-shot-agents]', padding: 8 });

    // ── 02. Окно «Агенты»: субагент с отказом и подъёмом модели ─────────────
    await page.locator('[data-agent-history-open]').click();
    const modal = page.locator('[data-agent-history-modal]');
    await modal.waitFor({ timeout: 10_000 });
    await modal.locator(`[data-agent-row="${AGENT_HISTORY_IDS.review}"]`).click();
    await modal.locator('[data-agent-detail]').waitFor({ timeout: 15_000 });
    await page.waitForTimeout(500);
    await scenario.shot(page, '02-history', { clip: '[role="dialog"]', padding: 24 });

    // ── 03. Фоновая работа, осиротевшая после уборки: хвост вывода и владелец ─
    await modal.locator(`[data-agent-row="${AGENT_HISTORY_IDS.bgOrphan}"]`).click();
    await modal.locator('[data-bg-detail]').waitFor({ timeout: 15_000 });
    await page.waitForTimeout(500);
    await scenario.shot(page, '03-background', { clip: '[role="dialog"]', padding: 24 });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    if (await modal.count()) await closeOverlay(page);
  } finally {
    await page.close();
  }
}
