/**
 * E2E мультиагентской среды чата с МОКОМ потока (SSE).
 *
 * Перехватываем /api/chat/send и отдаём синтетические события — так UI
 * детерминированно проходит через все состояния БЕЗ реального Claude (быстро,
 * стабильно, без токенов). Покрыто: зелёная/жёлтая/красная точки, фоновые
 * уведомления, клик по тосту → переход, пульт агентов + «остановить всех»,
 * параллельный запуск, пикер папки, карточка редактора.
 *
 * Запуск: node tools/qa/e2e-agents.mjs   (нужен поднятый фронт на 8888).
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.APP_URL ?? 'http://127.0.0.1:8888';
const OUT = join(process.cwd(), '.agent', 'screenshots', 'before-after', 'e2e-agents');
mkdirSync(OUT, { recursive: true });

const results = [];
const check = (name, ok) => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} · ${name}`);
};

// --- Управляемый мок потока ---
let scenario = 'done'; // 'green' | 'yellow' | 'red' | 'done'
let holdMs = 0;

function streamBody(sid) {
  const events = [{ kind: 'session', sessionId: sid, model: 'mock', tools: 1 }];
  if (scenario === 'yellow') {
    events.push({ kind: 'tool', name: 'AskUserQuestion', input: {}, id: 't1' });
  } else if (scenario === 'red') {
    events.push({ kind: 'error', message: 'лимит достигнут' });
  } else {
    events.push({ kind: 'text', text: 'привет' });
    if (scenario === 'done') {
      events.push({ kind: 'done', costUsd: 0.005, durationMs: 100, sessionId: sid });
    }
  }
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
// Каждый сценарий стартует с чистого рабочего пространства (Home, без табов).
await page.addInitScript(() => {
  try {
    localStorage.removeItem('claude-control:workspace');
  } catch {
    /* приватный режим */
  }
});
const problems = [];
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') problems.push(`console: ${m.text()}`);
});

let seq = 0;
await page.route('**/api/chat/send', async (route) => {
  if (holdMs) await new Promise((r) => setTimeout(r, holdMs));
  seq += 1;
  const sid = `mock-${Date.now()}-${seq}`;
  try {
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
      body: streamBody(sid),
    });
  } catch {
    // Запрос прервали (стоп) — это ожидаемо.
  }
});

await page.emulateMedia({ colorScheme: 'dark' });

/** Перейти на вкладку «Проекты» в сайдбаре, вернувшись сперва на домашний таб. */
async function goProjects() {
  await page.waitForSelector('nav');
  await page.waitForTimeout(400);
  const homeTab = page
    .getByRole('tablist', { name: 'Рабочие пространства' })
    .getByRole('tab', { name: 'Чаты' });
  if (await homeTab.isVisible().catch(() => false)) {
    await homeTab.click();
    await page.waitForTimeout(300);
  }
  await page.getByRole('tab', { name: 'Проекты' }).click();
  await page.waitForTimeout(300);
}

async function openFirstProject() {
  await goProjects();
  await page.locator('button:has-text("чатов:")').first().click();
  await page.waitForTimeout(400);
}

async function send(text) {
  const composer = page.locator('textarea[data-chat-input]');
  await composer.fill(text);
  await composer.press('Enter');
}

try {
  // ============ Сценарий A: зелёная точка + пульт + стоп-всех ============
  scenario = 'green';
  holdMs = 8000; // держим прогон «работающим»
  await page.goto(`${BASE}/chat`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('nav');
  await openFirstProject();
  await send('Задача A');
  await page.waitForTimeout(1200);

  const green = await page
    .getByRole('img', { name: 'агент работает' })
    .first()
    .isVisible()
    .catch(() => false);
  check('A1: зелёная точка «агент работает» на табе', green);
  await page.screenshot({ path: join(OUT, 'A_green.png') });

  // Пульт агентов
  await page.getByRole('button', { name: /Агенты/ }).click();
  await page.waitForTimeout(300);
  const panelRunning = await page
    .getByText('Активных агентов: 1')
    .isVisible()
    .catch(() => false);
  check('A2: пульт показывает 1 активного агента', panelRunning);
  await page.screenshot({ path: join(OUT, 'A_panel.png') });

  // Остановить всех
  await page.getByRole('button', { name: 'Остановить всех' }).click();
  await page.waitForTimeout(600);
  const greenGone = await page
    .getByRole('img', { name: 'агент работает' })
    .first()
    .isVisible()
    .catch(() => false);
  check('A3: после «Остановить всех» зелёная точка исчезла', !greenGone);

  // ============ Сценарий B: жёлтая точка + уведомление + клик→переход ============
  scenario = 'yellow';
  holdMs = 1500;
  await page.goto(`${BASE}/chat`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('nav');
  await openFirstProject();
  await send('Задача B с вопросом');
  await page.waitForTimeout(500);
  // Уходим на Home — прогон становится фоновым.
  await page.getByRole('tab', { name: 'Чаты' }).first().click();

  let waitToast = false;
  for (let i = 0; i < 20; i += 1) {
    const txt = await page
      .locator('[aria-label="Уведомления"]')
      .innerText()
      .catch(() => '');
    if (/ждёт ответа/.test(txt)) {
      waitToast = true;
      break;
    }
    await page.waitForTimeout(500);
  }
  check('B1: фоновый тост «агент ждёт ответа»', waitToast);
  await page.screenshot({ path: join(OUT, 'B_waiting_toast.png') });

  // Клик по тосту → переходим в тот проект (лента табов, активный — проект).
  await page
    .locator('[aria-label="Уведомления"] li button')
    .first()
    .click()
    .catch(() => {});
  await page.waitForTimeout(500);
  const tabbar = page.getByRole('tablist', { name: 'Рабочие пространства' });
  const yellowOnTab = await page
    .getByRole('img', { name: 'агент ждёт ответа' })
    .first()
    .isVisible()
    .catch(() => false);
  check('B2: жёлтая точка «ждёт ответа» на табе', yellowOnTab);
  check(
    'B3: клик по тосту открыл ленту табов проекта',
    await tabbar.isVisible().catch(() => false),
  );

  // ============ Сценарий C: красная точка + уведомление об ошибке ============
  scenario = 'red';
  holdMs = 1200;
  await page.goto(`${BASE}/chat`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('nav');
  await openFirstProject();
  await send('Задача C с ошибкой');
  await page.waitForTimeout(400);
  await page.getByRole('tab', { name: 'Чаты' }).first().click();

  let errToast = false;
  for (let i = 0; i < 20; i += 1) {
    const txt = await page
      .locator('[aria-label="Уведомления"]')
      .innerText()
      .catch(() => '');
    if (/ошибка или лимит/.test(txt)) {
      errToast = true;
      break;
    }
    await page.waitForTimeout(500);
  }
  check('C1: фоновый тост «ошибка или лимит»', errToast);
  const redOnTab = await page
    .getByRole('img', { name: 'ошибка или лимит' })
    .first()
    .isVisible()
    .catch(() => false);
  check('C2: красная точка на табе', redOnTab);
  await page.screenshot({ path: join(OUT, 'C_error.png') });

  // ============ Сценарий D: параллельный запуск в нескольких проектах ============
  scenario = 'green';
  holdMs = 8000;
  await page.goto(`${BASE}/chat`, { waitUntil: 'domcontentloaded' });
  await goProjects();
  await page.getByRole('button', { name: 'Запустить в нескольких' }).click();
  await page.waitForTimeout(500);
  // Отмечаем первые два проекта в списке модалки (кнопки с путём).
  const modalItems = page.locator('[role="dialog"] button').filter({ hasText: /[\\/]/ });
  const count = await modalItems.count();
  let picked = 0;
  for (let i = 0; i < count && picked < 2; i += 1) {
    const el = modalItems.nth(i);
    if (await el.isVisible().catch(() => false)) {
      await el.click().catch(() => {});
      picked += 1;
    }
  }
  await page.locator('[role="dialog"] textarea').fill('Параллельная задача');
  await page.waitForTimeout(200);
  await page.getByRole('button', { name: /Запустить в \d/ }).click();
  await page.waitForTimeout(1500);

  await page.getByRole('button', { name: /Агенты/ }).click();
  await page.waitForTimeout(300);
  const twoRunning = await page
    .getByText(/Активных агентов: [2-9]/)
    .isVisible()
    .catch(() => false);
  check('D1: параллельно запущены ≥2 агента (пульт)', twoRunning);
  await page.screenshot({ path: join(OUT, 'D_parallel.png') });
  // Прибираемся.
  await page
    .getByRole('button', { name: 'Остановить всех' })
    .click()
    .catch(() => {});

  // ============ Сценарий E: пикер папки + карточка редактора ============
  await page.goto(`${BASE}/settings`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('nav');
  await page
    .getByRole('button', { name: 'VS Code', exact: true })
    .first()
    .waitFor({ timeout: 8000 })
    .catch(() => {});
  const editorCard = await page
    .getByRole('button', { name: 'VS Code', exact: true })
    .first()
    .isVisible()
    .catch(() => false);
  check('E1: карточка редактора показывает VS Code', editorCard);

  await page.goto(`${BASE}/chat`, { waitUntil: 'domcontentloaded' });
  await goProjects();
  await page.getByRole('button', { name: 'Добавить папку' }).click();
  await page.waitForTimeout(400);
  const picker = await page
    .getByText('Выбор папки проекта')
    .isVisible()
    .catch(() => false);
  check('E2: пикер папки открывается', picker);
} catch (error) {
  problems.push(`exception: ${error.message}`);
}

await browser.close();

const passed = results.filter((r) => r.ok).length;
console.log(`\n=== ИТОГ: ${passed}/${results.length} проверок пройдено ===`);
if (problems.length) {
  console.log('--- ошибки страницы/консоли ---');
  console.log(problems.join('\n'));
}
console.log('Скрины:', OUT);
process.exit(passed === results.length && problems.length === 0 ? 0 : 1);
