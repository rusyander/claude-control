/**
 * Точка на значке панели и счёт в заголовке вкладки — только когда человека
 * ждёт что-то НОВОЕ, и гаснут, как только он это увидел.
 *
 * Владелец 28.09: у установленной панели точка на значке горела ВСЕГДА
 * («• 4 · AgentDeck»): вопросы четырёх брошенных детей разделения трёхдневной
 * давности считались поводом звать при каждом открытии, а увиденное не гасло.
 *
 * Правило (`shared/lib/attention`): повод = прогон ждёт/упал или разговор стоит на
 * вопросе; увиден = окно панели на виду и в фокусе, пока повод существует (или
 * его чат открыт). Увиденное помнится между перезагрузками; новый повод зовёт.
 *
 * Стенд одноразовый (`throwaway-stand.mjs`): своя панель над временным домом,
 * вопрос агента — настоящий транскрипт с `AskUserQuestion` без ответа, который
 * панель находит сама наблюдателем файлов. Подменён только фокус окна —
 * внешняя граница: безголовый браузер считает любую вкладку «в фокусе», а
 * человек бывает и в другой программе.
 *
 * Запуск: `node tools/qa/check-attention-badge.mjs` (стенд человека не нужен).
 * `SHOTS=<dir>` — снимки заголовка и значка по шагам.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { runOnStand, wait } from './throwaway-stand.mjs';

const SHOTS = process.env.SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

/** Фокус окна под управлением проверки; помнится в sessionStorage — переживает перезагрузку. */
function focusShim() {
  const stored = sessionStorage.getItem('qa-focus');
  window.__qaFocus = stored === null ? true : stored === '1';
  Document.prototype.hasFocus = function hasFocus() {
    return window.__qaFocus;
  };
  Object.defineProperty(Document.prototype, 'visibilityState', {
    configurable: true,
    get: () => (window.__qaFocus ? 'visible' : 'hidden'),
  });
  window.__qaSetFocus = (on) => {
    window.__qaFocus = on;
    sessionStorage.setItem('qa-focus', on ? '1' : '0');
    window.dispatchEvent(new Event(on ? 'focus' : 'blur'));
    document.dispatchEvent(new Event('visibilitychange'));
  };
}

const setFocus = (page, on) => page.evaluate((value) => window.__qaSetFocus(value), on);

/** Разговор, стоящий на вопросе агента: последняя запись — `AskUserQuestion` без ответа. */
function writeAsking(cfg, sessionId, cwd) {
  const dir = join(cfg, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
  mkdirSync(dir, { recursive: true });
  const at = new Date().toISOString();
  const lines = [
    {
      type: 'user',
      sessionId,
      cwd,
      timestamp: at,
      uuid: `${sessionId}-u`,
      message: { role: 'user', content: 'Сделай отчёт' },
    },
    {
      type: 'assistant',
      sessionId,
      cwd,
      timestamp: at,
      uuid: `${sessionId}-a`,
      message: {
        id: `${sessionId}-m`,
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: `${sessionId}-t`,
            name: 'AskUserQuestion',
            input: {
              questions: [
                {
                  question: 'Какой формат?',
                  header: 'Формат',
                  multiSelect: false,
                  options: [
                    { label: 'PDF', description: 'файл' },
                    { label: 'MD', description: 'текст' },
                  ],
                },
              ],
            },
          },
        ],
      },
    },
  ];
  writeFileSync(
    join(dir, `${sessionId}.jsonl`),
    `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`,
  );
}

/** Что видит человек снаружи панели: заголовок вкладки и есть ли точка на значке. */
async function badge(page) {
  return page.evaluate(() => {
    const href = document.querySelector('link[rel~="icon"]')?.getAttribute('href') ?? '';
    const svg = href.startsWith('data:') ? decodeURIComponent(href.split(',')[1] ?? '') : href;
    return { title: document.title, dot: svg.includes('cx="24"'), href };
  });
}

/** Дождаться состояния метки (до `seconds`); вернуть последнее увиденное. */
async function badgeUntil(page, test, seconds = 20) {
  let last = await badge(page);
  for (let i = 0; i < seconds * 4 && !test(last); i += 1) {
    await wait(250);
    last = await badge(page);
  }
  return last;
}

/** Снимок «как это выглядит снаружи»: заголовок вкладки и значок крупно. */
async function shot(browser, name, seen) {
  if (!SHOTS) return;
  const card = await browser.newPage({ viewport: { width: 520, height: 200 } });
  await card.setContent(
    `<body style="font:16px system-ui;margin:24px;display:flex;gap:20px;align-items:center">
      <img src="${seen.href.replace(/"/g, '&quot;')}" width="128" height="128" alt="">
      <div><div style="color:#666">заголовок вкладки</div><b>${seen.title.replace(/</g, '&lt;')}</b></div>
    </body>`,
  );
  await card.screenshot({ path: join(SHOTS, `${name}.png`) });
  await card.close();
}

await runOnStand({ label: 'attention' }, async (stand, check) => {
  const browser = await chromium.launch();
  try {
    const page = await stand.newPage(browser);
    await page.addInitScript(focusShim);
    await page.goto(`${stand.webUrl}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('nav', { timeout: 90_000 });
    await wait(2500);

    // 1. Панель без поводов — ни точки, ни счёта.
    const idle = await badge(page);
    await shot(browser, '1-idle', idle);
    check('без поводов: заголовок чист', !idle.title.startsWith('●'), idle.title);
    check('без поводов: на значке нет точки', !idle.dot);

    // 2. Человек ушёл в другую программу, агент задал вопрос.
    await setFocus(page, false);
    writeAsking(stand.cfg, 'qa-ask-one', join(stand.root, 'proj-one'));
    const asked = await badgeUntil(page, (seen) => seen.dot);
    await shot(browser, '2-asked-away', asked);
    check('вопрос агента, окно не в фокусе: точка на значке', asked.dot);
    check(
      'вопрос агента, окно не в фокусе: «● » в заголовке',
      asked.title.startsWith('● ') && !asked.title.startsWith('● 2'),
      asked.title,
    );

    // 3. Вернулся к панели — повод увиден, метка гаснет.
    await setFocus(page, true);
    const looked = await badgeUntil(page, (seen) => !seen.dot, 5);
    await shot(browser, '3-seen', looked);
    check('окно в фокусе: точка снята', !looked.dot);
    check('окно в фокусе: заголовок чист', !looked.title.startsWith('●'), looked.title);

    // 4. Панель открыли заново, не глядя на неё (фоновое восстановление вкладки,
    //    значок установленного приложения): старый увиденный вопрос не зовёт.
    await setFocus(page, false);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('nav', { timeout: 60_000 });
    await wait(4000);
    const reopened = await badge(page);
    await shot(browser, '4-reopened-away', reopened);
    check('перезагрузка без фокуса: увиденный вопрос не зовёт', !reopened.dot, reopened.title);
    check(
      'перезагрузка без фокуса: заголовок чист',
      !reopened.title.startsWith('●'),
      reopened.title,
    );

    // 5. Пришёл НОВЫЙ вопрос — зовёт только он, старый в счёт не идёт.
    writeAsking(stand.cfg, 'qa-ask-two', join(stand.root, 'proj-two'));
    // Читать метку, только когда страница заведомо узнала о втором вопросе:
    // сервер его видит, и событие наблюдателя успело дойти.
    for (let i = 0; i < 80; i += 1) {
      const { body } = await stand.api('/chats');
      if (Array.isArray(body) && body.some((chat) => chat.id === 'qa-ask-two')) break;
      await wait(250);
    }
    await wait(3000);
    const fresh = await badgeUntil(page, (seen) => seen.dot);
    await shot(browser, '5-new-ask', fresh);
    check('новый вопрос: точка есть', fresh.dot);
    check(
      'новый вопрос: счёт — только новый (●, не ● 2)',
      fresh.title.startsWith('● ') && !/^● 2 /.test(fresh.title),
      fresh.title,
    );

    // 6. И гаснет при взгляде.
    await setFocus(page, true);
    const done = await badgeUntil(page, (seen) => !seen.dot, 5);
    check('новый вопрос увиден: точка снята', !done.dot, done.title);

    check('страница без ошибок', page.errors.length === 0, page.errors.join('\n'));
  } finally {
    await browser.close();
  }
});
