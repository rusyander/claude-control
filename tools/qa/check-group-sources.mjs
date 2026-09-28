/**
 * Откуда берутся группы — страница групп целиком: вкладки (глобальные, в
 * проектах, найденные, ход обнаружения), каждая со своей сеткой карточек, связанная пара одной карточкой, в её
 * окне — выбор стороны и
 * переопределением, копия проектной группы в общие с советами агента, слияние
 * изменившегося оригинала, импорт находки и кнопка обнаружения с ходом по
 * источникам.
 *
 * API групп подменён целиком (`group-stubs.mjs`): настоящие находки требуют
 * проектов на диске и модели, копия пишет в ~/.claude. Прогон не зависит ни от
 * истории машины, ни от установленного CLI и ничего не оставляет.
 *
 * Кроме прямого пути — вариации, где живут дефекты: находки отвечают с
 * задержкой (остальные разделы не должны ждать), выбор стороны не читается
 * (кнопки выключены и сказано почему), пустой список групп, двойное нажатие
 * «Применить», импорт убирает находку.
 *
 * Запуск: `node tools/qa/check-group-sources.mjs` при поднятом `pnpm dev`.
 * Снимки: `.agent/screenshots/before-after/group-cards/check-sources-*.png`.
 */
import { makeGroupState } from './group-stubs.mjs';
import { PAIR, SITE, startRun, visible } from './group-harness.mjs';

const SHOTS = '.agent/screenshots/before-after/group-cards';
const { check, openPage, finish } = await startRun(SHOTS);

// ---------- 1. Прямой путь: разделы, пара, выбор стороны, переопределение ----------
{
  const { page, state, errors, close, open } = await openPage();
  await page.getByRole('heading', { name: 'Порядок задачи (общий)' }).waitFor({ timeout: 15000 });

  // Разделы — вкладки: открыта одна, остальные ждут щелчка; адрес помнит вкладку.
  const tabs = page.getByRole('tablist', { name: 'Разделы групп' });
  const tab = (name) => tabs.getByRole('tab', { name: new RegExp(`^${name}, `) });
  for (const name of ['Глобальные', 'В проектах', 'Найдено', 'Обнаружение']) {
    check(await visible(tab(name)), `вкладка «${name}» на странице`);
  }
  check(
    (await tab('Глобальные').getAttribute('aria-selected')) === 'true',
    'без ?tab= открыты «Глобальные»',
  );
  const panel = page.getByRole('tabpanel');
  const global = panel;
  const projects = panel;
  const found = panel;

  check(
    await visible(global.getByRole('heading', { name: 'Порядок задачи (общий)' })),
    'пара — в «Глобальных»',
  );
  check(
    !(await visible(page.getByRole('heading', { name: 'Документация сайта', exact: true }))),
    'проектная группа на вкладке «Глобальные» не видна',
  );
  await tab('В проектах').click();
  check(page.url().includes('tab=project'), 'щелчок по вкладке пишет её в адрес', page.url());
  const pairOriginal = await page
    .getByRole('heading', { name: 'Порядок задачи магазина', exact: true })
    .count();
  check(
    pairOriginal === 0,
    'проектная сторона пары не рисуется второй карточкой',
    `карточек: ${pairOriginal}`,
  );
  check(
    await visible(projects.getByRole('heading', { name: 'Документация сайта' })),
    'проектная группа без пары — в «В проектах»',
  );
  await tab('Глобальные').click();

  check(
    await visible(
      page.locator('[data-agent-anchor="qa-shop-order-global"]').getByText('пара с проектом'),
    ),
    'у пары на карточке метка «пара с проектом»',
  );
  const pair = await open(PAIR);
  const sides = pair.getByRole('group', { name: 'Что действует в C:/work/shop' });
  const globalSide = sides.getByRole('button', { name: 'Глобальная' });
  const projectSide = sides.getByRole('button', { name: 'Проектная' });
  check(
    (await globalSide.getAttribute('aria-pressed')) === 'true',
    'выбор проекта читается: действует глобальная',
  );
  check(
    await visible(pair.getByText('Не тронута, осталась в проекте, неактивна')),
    'неактивная проектная сторона подписана словами',
  );
  const override = pair.getByRole('switch', { name: 'Переопределение в C:/work/shop' });
  check(await visible(override), 'при глобальной стороне виден тумблер переопределения');
  check(
    (await override.getAttribute('aria-checked')) === 'true',
    'переопределение по умолчанию включено',
  );
  check(
    await visible(pair.getByText('.claude/rules/agentdeck-group.local.md', { exact: false })),
    'подсказка называет файл переопределения',
  );
  await page.screenshot({ path: `${SHOTS}/check-sources-light.png`, fullPage: true });

  await override.click();
  await page.waitForTimeout(500);
  const overrideCall = state.calls.find((call) => call.path.endsWith('/override'));
  check(
    overrideCall?.body?.enabled === false && overrideCall?.body?.path === 'C:/work/shop',
    'тумблер шлёт PUT override {path, enabled:false}',
    JSON.stringify(overrideCall?.body),
  );
  check(
    (await override.getAttribute('aria-checked')) === 'false',
    'тумблер показывает ответ сервера',
  );

  await projectSide.click();
  await page.waitForTimeout(800);
  const choiceCall = state.calls.find((call) => call.path === '/projects/group-choice');
  check(
    choiceCall?.body?.groupKey === 'project:qa-shop-order',
    '«Проектная» пишет выбор project:<id>',
    JSON.stringify(choiceCall?.body),
  );
  check(
    (await projectSide.getAttribute('aria-pressed')) === 'true',
    'после выбора нажата «Проектная»',
  );
  check(!(await visible(override)), 'при проектной стороне переопределения нет');
  check(
    await visible(pair.getByText('задача с номером тикета PROJ-', { exact: false })),
    'окно показывает «Когда» активной — проектной — стороны',
  );

  // Слияние изменившегося оригинала.
  check(
    await visible(pair.getByText('В проекте изменилось: скилл ticket-delivery')),
    'изменившийся оригинал назван',
  );
  await pair.getByRole('button', { name: 'Слить в нашу копию' }).click();
  const dialog = page.getByRole('dialog', { name: /^Слияние изменений проекта/ });
  await dialog.getByText('Что советует агент').waitFor({ timeout: 5000 });
  const apply = dialog.getByRole('button', { name: /Применить отмеченное/ });
  check(
    (await apply.textContent())?.includes('2'),
    'по умолчанию отмечены советы кроме «оставить» и замен хуков/MCP',
    await apply.textContent(),
  );
  // Замена хука — команда, которая будет выполняться: видна до применения, флажок снят.
  const hookRow = dialog.getByRole('listitem').filter({ hasText: 'PreToolUse:format' });
  check(
    await visible(hookRow.getByText('npx prettier --write', { exact: false })),
    'команда замены хука показана в окне',
  );
  check(!(await hookRow.getByRole('checkbox').isChecked()), 'замена хука заранее не отмечена');
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${SHOTS}/check-sources-merge-light.png` });
  // Двойное нажатие — один запрос: дважды применённый совет правит копию дважды.
  await apply.dblclick();
  await page.waitForTimeout(800);
  const applies = state.calls.filter((call) => call.path.endsWith('/advice/apply')).length;
  check(applies === 1, 'двойное «Применить» шлёт один запрос', `запросов: ${applies}`);
  check(
    !(await visible(pair.getByText('В проекте изменилось'))),
    'после слияния строка изменения пропала',
  );

  // Копия проектной группы в общие: кнопка — в шапке окна группы.
  await page.mouse.move(0, 0);
  await page.waitForTimeout(200);
  await page.keyboard.press('Escape');
  await pair.waitFor({ state: 'hidden', timeout: 3000 }).catch(() => undefined);
  const site = await open(SITE);
  await site.getByRole('button', { name: 'Скопировать в общие' }).click();
  const copyDialog = page.getByRole('dialog', { name: /^Копия «Документация сайта» в общие/ });
  await copyDialog.getByRole('button', { name: 'Скопировать', exact: true }).click();
  await copyDialog.getByText('Что советует агент').waitFor({ timeout: 5000 });
  check(
    await visible(copyDialog.getByText('имя занято в общих', { exact: false })),
    'предупреждение копии показано',
  );
  const adviceRows = await copyDialog.getByRole('listitem').count();
  check(adviceRows >= 3, 'советы по каждому участнику', `строк: ${adviceRows}`);
  await page.screenshot({ path: `${SHOTS}/check-sources-copy-light.png` });
  await copyDialog.getByRole('button', { name: 'Готово' }).click();
  await page.waitForTimeout(300);
  // Окно группы после копии остаётся открытым (F-216), а заголовок у пары
  // уже другой — закрываем любое открытое окно, а не найденное по имени.
  for (let round = 0; round < 3 && (await page.getByRole('dialog').count()) > 0; round += 1) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  }
  await site.waitFor({ state: 'hidden', timeout: 3000 }).catch(() => undefined);

  // Находки: ход по источникам (своя вкладка, в числе — ошибки) и импорт.
  check(
    await visible(tabs.getByRole('tab', { name: 'Обнаружение, 1 ошибка' })),
    'вкладка обнаружения считает ошибки, а не источники',
  );
  await tab('Обнаружение').click();
  // Сначала — споткнувшиеся источники, остальные — вторым списком под ними.
  const progress = page.getByRole('group', { name: 'Ход обнаружения по источникам' });
  const shownRows = () => progress.locator('li:visible').count();
  const early = await shownRows();
  check(early === 1, 'при ошибке видны только споткнувшиеся источники', `строк: ${early}`);
  const rest = progress.getByRole('button', { name: 'Остальные источники: 3' });
  check(await visible(rest), 'остальные свёрнуты под кнопкой с их числом');
  await rest.click();
  // После щелчка у кнопки другое имя («Свернуть остальные») — ищем её по связи со списком.
  const toggle = progress.locator('button[aria-controls]');
  await page.waitForTimeout(300);
  check(
    (await toggle.getAttribute('aria-expanded')) === 'true',
    'кнопка сообщает, что список раскрыт',
    await toggle.innerText(),
  );
  const late = await shownRows();
  check(late === 4, 'ход обнаружения — строка на источник', `строк: ${late}`);
  check(
    await visible(progress.getByText(/^ошибка — CLI не ответил вовремя$/)),
    'упавший источник помечен «ошибка» и назван словами интерфейса, а не текстом CLI',
  );
  check(
    await visible(progress.getByText('общие каталоги claude')),
    'источник провайдера назван словами',
  );
  await tab('Найдено').click();
  check(
    !(await visible(found.getByRole('heading', { name: 'Порядок задачи магазина' }))),
    'импортированная находка в «Найдено» не повторяется',
  );
  // Находка — карточка сетки; «Импортировать» в шапке её окна, где видно, что внутри.
  const foundDialog = await open('Выпуск релиза');
  check(
    await visible(foundDialog.getByText('Поднять версию')),
    'окно находки показывает её порядок работы',
  );
  // Сервер отдаёт имя строкой по-английски и пару `localized`: русский интерфейс
  // показывает русскую сторону — английское имя и «почему» были жалобой (S-G3).
  check(
    (await visible(foundDialog.getByText('подготовка релиза магазина', { exact: false }))) &&
      !(await visible(foundDialog.getByText('preparing a store release', { exact: false }))) &&
      !(await visible(foundDialog.getByText('the release skill', { exact: false }))),
    'окно находки — «Когда» и «почему» на языке интерфейса',
  );
  await foundDialog.getByRole('button', { name: 'Импортировать «Выпуск релиза»' }).click();
  await foundDialog.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => undefined);
  check(!(await visible(foundDialog)), 'импорт закрывает окно находки');
  check(
    state.importBodies?.at(-1)?.lang === 'ru',
    'импорт просит имя и «Когда» на языке интерфейса',
    JSON.stringify(state.importBodies),
  );
  check(
    await visible(
      page.getByText('Находка стала проектной группой — выключенной', { exact: false }),
    ),
    'уведомление говорит, что импортированная группа выключена',
  );
  await page.waitForTimeout(800);
  check(
    !(await visible(found.getByRole('heading', { name: 'Выпуск релиза' }))),
    'после импорта находка ушла из «Найдено»',
  );
  await tab('В проектах').click();
  check(
    await visible(projects.getByRole('heading', { name: 'Выпуск релиза' })),
    'и появилась в «В проектах»',
  );
  const importedTile = projects.getByRole('article').filter({
    has: page.getByRole('heading', { name: 'Выпуск релиза', exact: true }),
  });
  check(
    (await importedTile.getByRole('switch').getAttribute('aria-checked')) === 'false',
    'импортированная группа выключена',
  );

  // Кнопка обнаружения: занята, пока идёт, и сама отпускается.
  const discover = page.getByRole('button', { name: /Обнаружить группы|Идёт обнаружение/ });
  await discover.click();
  await page.waitForTimeout(300);
  check(
    await discover.isDisabled(),
    'во время обнаружения кнопка занята',
    await discover.textContent(),
  );
  await page
    .getByRole('button', { name: 'Обнаружить группы' })
    .waitFor({ timeout: 10000 })
    .catch(() => undefined);
  check(
    await visible(page.getByRole('button', { name: 'Обнаружить группы' })),
    'по окончании опрос сам вернул кнопку',
  );

  check(errors.length === 0, 'ошибок консоли нет', errors.join(' | '));
  await close();
}

// ---------- 2. Тёмная тема: снимок ----------
{
  const { page, close } = await openPage({ theme: 'dark' });
  await page.getByRole('heading', { name: 'Порядок задачи (общий)' }).waitFor({ timeout: 15000 });
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${SHOTS}/check-sources-dark.png`, fullPage: true });
  await close();
}

// ---------- 3. Вариация времени: находки отвечают через 3 с ----------
{
  const { page, close } = await openPage({ delay: [[/^\/groups\/discovery$/, 3000]] });
  await page
    .getByRole('heading', { name: 'Порядок задачи (общий)' })
    .waitFor({ timeout: 2500 })
    .catch(() => undefined);
  check(
    await visible(page.getByRole('heading', { name: 'Порядок задачи (общий)' })),
    'группы видны, не дожидаясь находок',
  );
  await page
    .getByRole('tablist', { name: 'Разделы групп' })
    .getByRole('tab', { name: /^Найдено, / })
    .click();
  const found = page.getByRole('tabpanel');
  check(
    !(await visible(found.getByText('Новых находок нет.'))),
    'пока находки грузятся, «нет находок» не врёт',
  );
  await found
    .getByRole('heading', { name: 'Выпуск релиза' })
    .waitFor({ timeout: 6000 })
    .catch(() => undefined);
  check(
    await visible(found.getByRole('heading', { name: 'Выпуск релиза' })),
    'находки дорисовались после ответа',
  );
  await close();
}

// ---------- 4. Негатив: выбор стороны не читается ----------
{
  const { page, errors, close, open } = await openPage({
    patch: (target) =>
      target.route('**/api/projects/group-choice?*', (route) =>
        route.fulfill({ status: 500, json: { error: 'сбой чтения' } }),
      ),
  });
  await page.getByRole('heading', { name: 'Порядок задачи (общий)' }).waitFor({ timeout: 15000 });
  const pair = await open(PAIR);
  await pair
    .getByText('Не удалось узнать, какая сторона действует.')
    .waitFor({ timeout: 8000 })
    .catch(() => undefined);
  check(
    await visible(pair.getByText('Не удалось узнать, какая сторона действует.')),
    'сбой выбора назван словами',
  );
  check(
    await pair.getByRole('button', { name: 'Глобальная' }).isDisabled(),
    'без выбора стороны кнопки выключены',
  );
  check(
    !(await visible(pair.getByRole('switch', { name: /Переопределение/ }))),
    'переопределение не показано наугад',
  );
  const unexpected = errors.filter((text) => !text.includes('500'));
  check(unexpected.length === 0, 'кроме ожидаемого 500 ошибок нет', unexpected.join(' | '));
  await close();
}

// ---------- 5. Пусто: ни групп, ни находок ----------
{
  const state = makeGroupState();
  state.groups = [];
  state.discovery = { ...state.discovery, groups: [] };
  const { page, close } = await openPage({ state });
  await page.waitForTimeout(1500);
  check(
    await visible(page.getByRole('button', { name: 'Создать группу' }).last()),
    'пустая страница зовёт создать группу',
  );
  check(
    (await page.locator('[data-agent-anchor]').count()) === 0,
    'пустая вкладка не рисует ни одной карточки',
  );
  await close();
}

await finish('Источники групп работают');
