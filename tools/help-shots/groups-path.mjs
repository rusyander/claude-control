/**
 * Сценарий `groups/path`: «Порядок работы» группы — как конвейер ведёт задачу.
 *
 * Вход — «хочу, чтобы после ревью агент ещё и e2e прогонял». Путь: окно группы
 * на вкладке «Порядок работы» (стадии конвейера, шаги скилла с числами в
 * строке, свои шаги, «+») → редактор шага: ассистент спрашивает и называет
 * похожий ресурс → готовое предложение на двух языках → правка одной стороны
 * просит перевести другую → «ресурс или промпт панели?» → подсказка у строки
 * шага-ресурса → окно шага скилла с числами «Авто» и закреплённым.
 *
 * Данные — общая подмена страницы групп (та же, что у
 * `tools/qa/check-group-path.mjs`): ассистент шага — разговор с моделью.
 */
import { installGroupStubs, openGroup } from '../qa/group-stubs.mjs';
import { makeState, settings, panelShell, open } from './projects-stubs.mjs';

// Окна вложенные (редактор шага и окно шага поверх окна группы) — снимаем верхнее.
const TOP_DIALOG = '[role="dialog"] >> nth=-1';

export async function shootPath(browser, web, scenario) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });

  try {
    await settings(page);
    await panelShell(page, makeState());
    await installGroupStubs(page);

    await open(page, web, '/groups');
    const group = await openGroup(page, 'Порядок задачи (общий)');
    const list = group.getByRole('list', { name: /^(Шаги порядка работы|Working order steps)$/ });
    await list.waitFor({ timeout: 15000 });

    // ── 01. «Порядок работы»: стадии, шаги скилла с числами, свои шаги ───────
    // Верх окна (выбор стороны пары) — кадр sources/03; здесь — сами строки.
    await page.waitForTimeout(800);
    // С вкладок окна: в кадре и подпись порядка работы, и панель инструментов, и строки.
    await group
      .getByRole('tablist', { name: /^(Вид группы|Group view)$/ })
      .evaluate((node) => node.scrollIntoView({ block: 'start' }));
    // Указатель после щелчка по карточке остался над окном: прокрутка подвела бы
    // под него строку, и кадр снял бы её подсказку. Подсказка — кадр 06.
    await page.mouse.move(0, 0);
    await page.waitForTimeout(400);
    await scenario.shot(page, '01-path', { clip: TOP_DIALOG, padding: 24 });

    // ── 02. «+» после «Ревью»: ассистент спрашивает ──────────────────────────
    await list
      .getByRole('button', { name: /^(Добавить шаг после «Ревью»|Add a step after “Review”)$/ })
      .click();
    const composer = page.getByRole('dialog', { name: /^(Новый шаг|New step)$/ });
    const langTabs = composer.getByRole('tablist', { name: /^(Язык шага|Step language)$/ });
    await composer
      .getByLabel(/Что сделать на этом шаге|What to do at this step/)
      .fill('после ревью прогнать e2e и приложить отчёт');
    await composer.getByRole('button', { name: /^(Подготовить|Prepare)$/ }).click();
    await composer.getByRole('button', { name: /^(Ответить|Answer)$/ }).waitFor({ timeout: 8000 });
    await page.waitForTimeout(500);
    await scenario.shot(page, '02-ask', { clip: TOP_DIALOG, padding: 40 });

    // ── 03. Готовое предложение на двух языках ───────────────────────────────
    await composer
      .getByLabel(/Ваш ответ|Your answer/)
      .fill('на локальном стенде, отчёт — в описание MR');
    await composer.getByRole('button', { name: /^(Ответить|Answer)$/ }).click();
    await langTabs.waitFor({ timeout: 8000 });
    await page.waitForTimeout(500);
    await langTabs.evaluate((node) => node.scrollIntoView({ block: 'start' }));
    await page.waitForTimeout(400);
    await scenario.shot(page, '03-proposal', { clip: TOP_DIALOG, padding: 40 });

    // ── 04. Правка одной стороны просит перевести другую ─────────────────────
    await composer.getByRole('tab', { name: 'EN' }).click();
    await composer
      .getByLabel(/Текст для модели|Text for the model/)
      .fill('Run e2e on the local stand and attach the HTML report to the MR description.');
    await page.waitForTimeout(400);
    await langTabs.evaluate((node) => node.scrollIntoView({ block: 'start' }));
    await page.waitForTimeout(400);
    await scenario.shot(page, '04-translate', { clip: TOP_DIALOG, padding: 40 });

    // ── 05. Шаг сохранён промптом панели: сделать ресурсом? ──────────────────
    // Рядом стоит «Перевести на RU и подтвердить» — нужен именно простой перевод,
    // иначе кадра с кнопкой «Подтвердить» не будет.
    await composer.getByRole('button', { name: /^(Перевести на|Translate to) [A-Z]{2}$/ }).click();
    await page.waitForTimeout(1200);
    await composer.getByRole('button', { name: /^(Подтвердить|Confirm)$/ }).click();
    await page.getByRole('button', { name: /^(Сделать|Make): / }).waitFor({ timeout: 8000 });
    await page.waitForTimeout(500);
    await scenario.shot(page, '05-promote', { clip: TOP_DIALOG, padding: 40 });
    await page
      .getByRole('button', { name: /^(Оставить промптом панели|Keep as a panel prompt)$/ })
      .click();
    await composer.waitFor({ state: 'detached', timeout: 8000 });
    await page.waitForTimeout(600);

    // ── 06. Подсказка у строки: что делает шаг-ресурс ────────────────────────
    const resource = list.getByRole('button', { name: /^(Заметки к релизу|Release notes)/ });
    await resource.scrollIntoViewIfNeeded();
    await resource.hover();
    await list.locator('[role="tooltip"]:not([hidden])').waitFor({ timeout: 8000 });
    await page.waitForTimeout(1200);
    await scenario.shot(page, '06-summary', { clip: TOP_DIALOG, padding: 24 });

    // ── 07. Окно шага скилла: откуда, где стоит, числа ───────────────────────
    await page.mouse.move(0, 0);
    await list.getByRole('button', { name: /^Взять тикет и завести ветку/ }).click();
    const step = page.getByRole('dialog', { name: 'Взять тикет и завести ветку', exact: true });
    const rounds = step.getByRole('combobox').first();
    await rounds.waitFor({ timeout: 8000 });
    // Одно число закрепляем щелчком, как человек: кадр показывает «Авто» и своё рядом.
    await rounds.selectOption({ index: 2 });
    await page.waitForTimeout(800);
    await scenario.shot(page, '07-knobs', { clip: TOP_DIALOG, padding: 24 });
    await page.keyboard.press('Escape');
    await step.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => undefined);

    // ── 08. «Выбрать готовый»: каталог с поиском, щелчок — шаг-ссылка ───────
    await list
      .getByRole('button', { name: /^(Добавить шаг после «Ревью»|Add a step after “Review”)$/ })
      .click();
    await composer.waitFor({ timeout: 8000 });
    await composer.getByRole('tab', { name: /^(Выбрать готовый|Pick a ready one)$/ }).click();
    await composer
      .getByRole('button', { name: /^(Добавить шагом|Add as a step): / })
      .first()
      .waitFor({ timeout: 8000 });
    // Описания каталога докатываются вторым опросом — ждём слов, а не имён.
    await page.waitForTimeout(3600);
    await scenario.shot(page, '08-pick', { clip: TOP_DIALOG, padding: 24 });

    // ── 09. «Хук»: событие, фильтр, команда — хук станет участником ─────────
    await composer.getByRole('tab', { name: /^(Хук|Hook)$/ }).click();
    await composer.getByLabel(/^(Название шага|Step title)/).fill('Линт после правки');
    await composer.getByLabel(/^(Фильтр|Filter)/).fill('Edit|Write');
    await composer.getByLabel(/^(Команда|Command)/).fill('pnpm lint');
    await page.waitForTimeout(400);
    await scenario.shot(page, '09-hook', { clip: TOP_DIALOG, padding: 24 });
  } finally {
    await page.close();
  }
}
