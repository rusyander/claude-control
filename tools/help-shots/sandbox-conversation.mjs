/**
 * Сценарий `sandbox/conversation`: правило проверяется разговором в песочнице.
 *
 * Стенд — тот же, что у правил (`rules-panel.mjs`): сборку временного каталога делает настоящий
 * сервер, состав «Что подключено» в кадре — то, что он туда положил. Подменяется только прогон
 * `/api/sandbox/run`: за ним задача ядра, установленный CLI и живая модель. Поток подмены — те же
 * события, что шлёт маршрут (`session`, `text`, `done`; отказ ядра — `error` с кодом
 * `sandbox-core-refused` и причиной), так что перевод отказа на язык интерфейса в кадре настоящий.
 *
 * Кадры:
 *   01-composition — окно песочницы на вкладке «Разговор»: состав, доступ, границы;
 *   02-waiting     — вопрос ушёл, ответа ещё нет: кнопка «Стоп» снимает задачу ядра;
 *   03-answer      — ответ из песочницы;
 *   04-refused     — ядро не провело разговор: причина словами, на языке интерфейса.
 */
import { setClaudeMd, RULES_CLAUDE_MD } from './rules-fixture.mjs';
import { openSection, closeModal } from './rules-stubs.mjs';

const ANSWER =
  'Здравствуйте! Отвечаю по-русски, как требует правило «Язык общения». ' +
  'Имена файлов вроде `package.json` оставляю как есть.';

/** Причина отказа — та, что ядро называет, когда у песочницы нет доступа к аккаунту. */
const REFUSAL_REASON = 'the model turn ended with an error';

function stream(events) {
  return {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
    body: events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
  };
}

/** Источник доступа — «из файла настроек», а не путь временного каталога стенда. */
async function fileCredentials(page) {
  await page.route('**/api/sandbox/create', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    return route.fulfill({ response, json: { ...body, credentials: { source: 'file' } } });
  });
}

async function openRuleSandbox(page, web) {
  await openSection(page, web, '/rules?tab=all');
  await page
    .getByRole('button', { name: /^(Песочница|Sandbox): / })
    .first()
    .click();
  // У правила вкладок нет: прогона событий у него не бывает, окно открыто сразу на разговоре.
  await page.waitForTimeout(3000);
}

async function ask(page, prompt) {
  await page.getByLabel(/^(Запрос|Prompt)$/).fill(prompt);
  await page
    .getByRole('button', { name: /^(Отправить в песочницу|Send to the sandbox)$/ })
    .first()
    .click();
}

export async function shootSandbox(browser, web, scenario, home, lang = 'ru') {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const clip = { clip: '[role="dialog"]', padding: 24 };
  // Вопрос человек пишет на языке интерфейса; ответ остаётся русским — того требует правило.
  const question =
    lang === 'en'
      ? 'Hi! Tell me what you can help with.'
      : 'Привет! Расскажи, чем ты можешь помочь.';

  try {
    setClaudeMd(home, RULES_CLAUDE_MD);
    await fileCredentials(page);

    // ── 01. Состав и границы ─────────────────────────────────────────────────
    await openRuleSandbox(page, web);
    await scenario.shot(page, '01-composition', clip);

    // ── 02. Ответа ещё нет: «Стоп» ───────────────────────────────────────────
    // Поток не отвечает, пока кадр не снят: так выглядит ход, пока ядро поднимает сеанс.
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    await page.route('**/api/sandbox/run', async (route) => {
      await held;
      await route.fulfill(stream([{ kind: 'done' }])).catch(() => {});
    });
    await ask(page, question);
    await page.waitForTimeout(1200);
    await scenario.shot(page, '02-waiting', clip);
    release();
    await page.waitForTimeout(800);
    await page.unroute('**/api/sandbox/run');

    // ── 03. Ответ ────────────────────────────────────────────────────────────
    await page.route('**/api/sandbox/run', (route) =>
      route.fulfill(
        stream([
          { kind: 'session', sessionId: 'help-guide' },
          { kind: 'text', text: ANSWER },
          // Как шлёт маршрут: ядро цены хода не называет.
          { kind: 'done', costUsd: 0 },
        ]),
      ),
    );
    await ask(page, question);
    await page.waitForTimeout(2000);
    await scenario.shot(page, '03-answer', clip);
    await page.unroute('**/api/sandbox/run');

    // ── 04. Отказ ядра ───────────────────────────────────────────────────────
    await page.route('**/api/sandbox/run', (route) =>
      route.fulfill(
        stream([
          {
            kind: 'error',
            message: `Ядро не провело разговор в песочнице: ${REFUSAL_REASON}`,
            messageCode: 'sandbox-core-refused',
            params: { reason: REFUSAL_REASON },
          },
        ]),
      ),
    );
    await ask(page, question);
    await page.waitForTimeout(2000);
    await scenario.shot(page, '04-refused', clip);
    await closeModal(page);
  } finally {
    await page.close();
  }
}
