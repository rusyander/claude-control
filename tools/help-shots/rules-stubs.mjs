/**
 * Общее для съёмки пачки «Правила поведения».
 *
 * Подмен здесь ровно два, и оба названы по причине, а не по удобству: за ними
 * стоял бы установленный CLI и живая модель, то есть кадр зависел бы от машины,
 * на которой идёт съёмка. Всё остальное — настоящие ответы сервера панели,
 * читающего настоящий файл во временном каталоге конфигурации.
 */

/** Открыть раздел панели по адресу и дождаться, пока он дорисуется. */
export async function openSection(page, web, path, pause = 1500) {
  await page.goto(`${web}${path}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('nav');
  await page.waitForTimeout(pause);
}

/**
 * Помощник формы. Панель отправляет `POST /api/assist` и применяет пришедшие
 * поля к форме, помечая изменённые зелёным бейджем; сервер ради этого запускает
 * тот же `claude`, что и в терминале. Подменяется ОТВЕТ — разметка, бейджи и
 * порядок применения в кадре настоящие.
 */
export async function assistant(page, { reply, fields }) {
  await page.route('**/api/assist', (route) =>
    route.fulfill({ json: { reply, fields, sessionId: 'help-guide' } }),
  );
}

/**
 * Песочница. Сборку временного каталога делает настоящий сервер — в кадре
 * «Что внутри» перечислено то, что он туда действительно положил. Подменяются
 * две вещи: источник доступа к аккаунту (иначе в кадре оказался бы путь
 * временного каталога вместо привычного «из файла настроек») и сам прогон —
 * он требует установленного CLI и живой модели.
 */
export async function sandbox(page, answer) {
  await page.route('**/api/sandbox/create', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    return route.fulfill({ response, json: { ...body, credentials: { source: 'file' } } });
  });
  await page.route('**/api/sandbox/run', (route) =>
    route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body:
        `data: ${JSON.stringify({ kind: 'session', sessionId: 'help-guide' })}\n\n` +
        `data: ${JSON.stringify({ kind: 'text', text: answer })}\n\n` +
        `data: ${JSON.stringify({ kind: 'done', costUsd: 0.004 })}\n\n`,
    }),
  );
}

/**
 * Закрыть модальное окно. Escape закрывает его штатно, но подложка успевает
 * перехватить следующий клик — ждём, пока она уйдёт из разметки.
 */
export async function closeModal(page) {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(1000);
}
