/**
 * Кромки страницы групп, найденные ревью 28.09 (волна мелочей N3): каждое
 * место — живым жестом на странице с подменённым API групп (`group-stubs.mjs`),
 * ничего не пишется в настоящий ~/.claude.
 *
 *  1. Журнал обнаружения, пока источник ещё читается: «Ошибок нет» не
 *     говорится раньше времени (F-210).
 *  2. Копия в общие для чужого CLI: пустые советы объяснены словами, а
 *     предупреждения копии называют причину словами, не кодом (F-211, F-212).
 *  3. Слияние упало: причина и «Повторить» в самом окне (F-217).
 *  4. Выбор стороны пары не прочитался: карточка говорит об этом (F-238).
 *  5. Копия в общие из окна проектной группы: окно не пропадает, вкладка
 *     под ним — «Глобальные», где группа теперь живёт (F-216).
 *  6. «Копировать» из окна группы открывает копию с нуля — на «Порядке
 *     работы», а не на вкладке, оставшейся от исходной группы (F-213).
 *  7. Свежий сценарий: закрытый составитель не всплывает снова при смене
 *     вкладки окна (F-276).
 *  8. Окно шага показывает обе стороны условия готовности (F-281).
 *  9. Составитель: сбой хука не красит режим «Выбрать готовый» (F-274);
 *     сбой ассистента не стирает набранное (F-282); Home/End на вкладках
 *     языка — края списка (F-275).
 * 10. Подсказка строки, показанная наведением, не глотает Escape, которым
 *     человек отменяет перенос другой строки с клавиатуры (F-277).
 * 11–13. Отказ создания, место вставки, быстрый выбор (F-225, F-227, F-228).
 * 14. Вкладки страницы — общим механизмом разделов: щелчок держится, `/groups`
 *     без вкладки открывает последнюю выбранную, незнакомая `?tab=` уходит (F-214).
 *
 * `PHASE=BEFORE|AFTER` — суффикс снимков в
 * `.agent/screenshots/before-after/nits-N3/groups/` (по умолчанию AFTER).
 * Запуск: `node tools/qa/check-group-edges.mjs` при поднятом API стенда.
 */
import { makeGroupState } from './group-stubs.mjs';
import { MANUAL, PAIR, SITE, pathList, startRun, visible } from './group-harness.mjs';

const SHOTS = '.agent/screenshots/before-after/nits-N3/groups';
const PHASE = process.env.PHASE ?? 'AFTER';
const shot = (page, name) =>
  page.screenshot({ path: `${SHOTS}/${name}_${PHASE}.png` }).catch(() => undefined);
const { check, openPage, finish } = await startRun(SHOTS);

// includeHidden: под открытым окном страница скрыта от дерева доступности, а
// вкладку под окном проверяем именно тогда.
const tabOf = (page, name) =>
  page
    .getByRole('tablist', { name: 'Разделы групп', includeHidden: true })
    .getByRole('tab', { name: new RegExp(`^${name}, `), includeHidden: true });
const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

// ---------- 1. Журнал обнаружения посреди прогона (F-210) ----------
for (const theme of ['light', 'dark']) {
  const state = makeGroupState();
  state.discovery = {
    ...state.discovery,
    running: true,
    sources: [
      { source: 'C:/work/shop', state: 'running', found: 0 },
      { source: 'provider:claude', state: 'done', found: 1 },
    ],
  };
  const { page, close } = await openPage({ state, theme });
  await tabOf(page, 'Обнаружение').click();
  const progress = page.getByRole('group', { name: 'Ход обнаружения по источникам' });
  await progress.waitFor({ timeout: 8000 });
  check(
    !(await visible(progress.getByText('Ошибок нет', { exact: false }))),
    `${theme}: пока источник читается, «Ошибок нет» не говорится`,
    (await progress.innerText()).replace(/\s+/g, ' '),
  );
  await shot(page, `discovery-running-${theme}`);
  await close();
}

// ---------- 2. Копия в общие для чужого CLI: советы и предупреждения (F-211, F-212) ----------
{
  const warnings = [
    { kind: 'skipped', member: 'permission:Bash(git:*)', detail: 'permission' },
    { kind: 'skipped', member: 'skill:docs-writer', detail: 'project-relative' },
    { kind: 'failed', member: 'rule:gone', detail: 'missing' },
    { kind: 'skipped', member: 'hook:PostToolUse:lint', detail: 'not_transferable' },
  ];
  const { page, state, close, open } = await openPage({
    patch: (target) =>
      target.route('**/api/groups/*/copy-to-global', (route) => {
        const body = JSON.parse(route.request().postData() ?? '{}');
        state.copyBodies = [...(state.copyBodies ?? []), body];
        return json(route, {
          group: { ...state.groups.find((group) => group.id === 'qa-site-docs'), id: 'x-codex' },
          advice: [],
          warnings,
        });
      }),
  });
  const site = await open(SITE);
  await site.getByRole('button', { name: 'Скопировать в общие' }).click();
  const copy = page.getByRole('dialog', { name: /^Копия «Документация сайта» в общие/ });
  await copy.waitFor({ timeout: 5000 });
  const target = copy.getByRole('combobox', { name: 'Куда копировать' });
  const values = await target
    .locator('option')
    .evaluateAll((options) => options.map((option) => option.value));
  const foreign = values.find((value) => value !== 'claude');
  check(Boolean(foreign), 'в списке целей есть чужой CLI', values.join(','));
  if (foreign) await target.selectOption(foreign);
  await copy.getByRole('button', { name: 'Скопировать', exact: true }).click();
  await copy.getByText('Что советует агент').waitFor({ timeout: 5000 });
  const text = (await copy.innerText()).replace(/\s+/g, ' ');
  check(
    state.copyBodies?.at(-1)?.provider === foreign,
    'копия ушла выбранному CLI',
    JSON.stringify(state.copyBodies),
  );
  check(
    !text.includes('Советов нет — копия готова как есть') && /только для копии в Claude/.test(text),
    'пустые советы у чужого CLI объяснены, а не «Советов нет»',
    text,
  );
  check(
    !/: (permission|project-relative|missing|not_transferable)(\s|$)/.test(text),
    'предупреждения копии без сырых кодов',
    text,
  );
  check(
    /разрешение/.test(text) && /путь внутри проекта/.test(text) && /файла нет/.test(text),
    'причины пропуска названы словами: вид участника, путь проекта, нет файла',
    text,
  );
  check(/не переносится/.test(text), 'исход переноса — словами паспорта среды', text);
  await shot(page, 'copy-foreign-advice-light');
  await close();
}

// ---------- 2б. Копия в Claude, модель не ответила: сбой назван (F-211) ----------
{
  const { page, state, close, open } = await openPage({
    patch: (target) =>
      target.route('**/api/groups/*/copy-to-global', (route) =>
        json(route, {
          group: { ...state.groups.find((group) => group.id === 'qa-site-docs'), id: 'x-claude' },
          advice: [],
          adviceFailed: true,
          warnings: [],
        }),
      ),
  });
  const site = await open(SITE);
  await site.getByRole('button', { name: 'Скопировать в общие' }).click();
  const copy = page.getByRole('dialog', { name: /^Копия «Документация сайта» в общие/ });
  await copy.waitFor({ timeout: 5000 });
  await copy.getByRole('button', { name: 'Скопировать', exact: true }).click();
  await copy.getByText('Что советует агент').waitFor({ timeout: 5000 });
  const text = (await copy.innerText()).replace(/\s+/g, ' ');
  check(
    !text.includes('Советов нет — копия готова как есть') && /Агент не ответил/.test(text),
    'сбой модели после копии назван, а не выдан за «Советов нет»',
    text,
  );
  await shot(page, 'copy-advice-failed-light');
  await close();
}

// ---------- 3. Слияние упало: причина и «Повторить» в окне (F-217) ----------
for (const theme of ['light', 'dark']) {
  let calls = 0;
  const { page, close, open } = await openPage({
    theme,
    patch: (target) =>
      target.route('**/api/groups/*/merge-origin', (route) => {
        calls += 1;
        return json(route, { error: 'модель не ответила за 60 секунд' }, 502);
      }),
  });
  const pair = await open(PAIR);
  await pair.getByRole('button', { name: 'Слить в нашу копию' }).click();
  const dialog = page.getByRole('dialog', { name: /^Слияние изменений проекта/ });
  await dialog.waitFor({ timeout: 5000 });
  const alert = dialog.getByRole('alert');
  await alert.waitFor({ timeout: 8000 }).catch(() => undefined);
  const alertText = (await visible(alert)) ? await alert.innerText() : '';
  check(
    alertText.includes('модель не ответила за 60 секунд'),
    `${theme}: причина сбоя слияния — в окне`,
    alertText || (await dialog.innerText()).replace(/\s+/g, ' '),
  );
  const echoes = await page.getByText('модель не ответила за 60 секунд').count();
  check(echoes === 1, `${theme}: причина одна — общего тоста рядом нет`, `${echoes} копий`);
  await shot(page, `merge-failed-${theme}`);
  const retry = dialog.getByRole('button', { name: 'Повторить' });
  check(await visible(retry), `${theme}: «Повторить» в окне`);
  if (await visible(retry)) {
    await retry.click();
    await page.waitForTimeout(800);
    check(calls === 2, `${theme}: «Повторить» просит слияние ещё раз`, `запросов: ${calls}`);
  }
  await close();
}

// ---------- 4. Сторона пары не прочиталась (F-238) ----------
for (const theme of ['light', 'dark']) {
  const { page, close } = await openPage({
    theme,
    patch: (target) =>
      target.route('**/api/projects/group-choice**', (route) =>
        route.request().method() === 'GET'
          ? json(route, { error: 'нет доступа к проекту' }, 500)
          : route.fallback(),
      ),
  });
  const tile = page
    .getByRole('article')
    .filter({ has: page.getByRole('heading', { name: PAIR, exact: true }) });
  await tile.waitFor({ timeout: 10000 });
  await tile
    .getByText('Не удалось узнать, какая сторона действует.')
    .waitFor({ timeout: 8000 })
    .catch(() => undefined);
  check(
    await visible(tile.getByText('Не удалось узнать, какая сторона действует.')),
    `${theme}: карточка пары говорит, что сторону узнать не вышло`,
    (await tile.innerText()).replace(/\s+/g, ' '),
  );
  await tile.screenshot({ path: `${SHOTS}/pair-choice-error-${theme}_${PHASE}.png` });
  await close();
}

// ---------- 5. Копия в общие из окна: окно остаётся, вкладка — «Глобальные» (F-216) ----------
{
  const { page, close, open } = await openPage();
  const site = await open(SITE);
  await site.getByRole('button', { name: 'Скопировать в общие' }).click();
  const copy = page.getByRole('dialog', { name: /^Копия «Документация сайта» в общие/ });
  await copy.getByRole('button', { name: 'Скопировать', exact: true }).click();
  await copy.getByText('Что советует агент').waitFor({ timeout: 5000 });
  await copy.getByRole('button', { name: 'Готово' }).click();
  await copy.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => undefined);
  await page.waitForTimeout(600);
  const groupDialog = page.getByRole('dialog', { name: /^Документация сайта/ });
  check(
    await visible(groupDialog),
    'после копии окно группы на месте',
    `окон: ${await page.getByRole('dialog').count()}`,
  );
  check(
    (await tabOf(page, 'Глобальные').getAttribute('aria-selected')) === 'true',
    'под окном — «Глобальные», где группа теперь живёт парой',
  );
  await shot(page, 'copy-keeps-dialog-light');
  await close();
}

// ---------- 6. Копия группы открывается с нуля (F-213) ----------
{
  const { page, close, open } = await openPage();
  const manual = await open(MANUAL);
  const views = manual.getByRole('tablist', { name: 'Вид группы' });
  await views.getByRole('tab', { name: 'Состав' }).click();
  await manual.getByRole('button', { name: 'Копировать', exact: true }).click();
  const ask = page.getByRole('dialog', { name: `Копировать группу «${MANUAL}»` });
  await ask.waitFor({ timeout: 5000 });
  await ask.getByRole('textbox', { name: 'Имя копии' }).fill('Фронтенд-работа N3');
  await ask.getByRole('button', { name: 'Копировать', exact: true }).click();
  const copied = page.getByRole('dialog', { name: 'Фронтенд-работа N3', exact: true });
  await copied.waitFor({ timeout: 8000 });
  const selected = await copied
    .getByRole('tablist', { name: 'Вид группы' })
    .getByRole('tab', { selected: true })
    .innerText();
  check(selected === 'Порядок работы', 'копия открывается на «Порядке работы»', selected);
  await close();
}
{
  // Смена стороны пары в открытом окне: путь другой группы начинается с нуля —
  // поиск, набранный по одной стороне, к другой не переезжает.
  const { page, close, open } = await openPage();
  const pair = await open(PAIR);
  await pathList(pair).waitFor({ timeout: 15000 });
  const filter = pair.getByRole('searchbox', { name: 'Найти шаг' });
  await filter.fill('e2e');
  await pair.getByRole('button', { name: 'Проектная', exact: true }).click();
  await page.waitForTimeout(1200);
  const left = (await filter.count()) > 0 ? await filter.inputValue() : '';
  check(left === '', 'после смены стороны пары поиск пути пуст', `в поиске: «${left}»`);
  await close();
}

// ---------- 7. Свежий сценарий: составитель не всплывает снова (F-276) ----------
{
  const { page, close } = await openPage();
  await page.getByRole('button', { name: 'Создать группу' }).first().click();
  const chooser = page.getByRole('dialog', { name: 'Какую группу создать' });
  await chooser.getByRole('button', { name: /^Сценарий/ }).click();
  const modal = page.getByRole('dialog', { name: 'Новый сценарий' });
  await modal.getByLabel('Название').fill('Сценарий N3');
  await modal.getByRole('button', { name: 'Создать и открыть' }).click();
  const composer = page.getByRole('dialog', { name: 'Новый шаг' });
  await composer.waitFor({ timeout: 8000 });
  await composer.getByRole('button', { name: 'Отмена' }).click();
  await composer.waitFor({ state: 'hidden', timeout: 3000 }).catch(() => undefined);
  const group = page.getByRole('dialog', { name: 'Сценарий N3', exact: true });
  const views = group.getByRole('tablist', { name: 'Вид группы' });
  await views.getByRole('tab', { name: 'Состав' }).click();
  await views.getByRole('tab', { name: 'Порядок работы' }).click();
  await page.waitForTimeout(600);
  check(
    !(await visible(composer)),
    'закрытый составитель не всплывает при возврате на «Порядок работы»',
  );
  await close();
}

// ---------- 8. Окно шага: обе стороны условия готовности (F-281) ----------
for (const theme of ['light', 'dark']) {
  const { page, close, open } = await openPage({ theme });
  const pair = await open(PAIR);
  await pathList(pair).waitFor({ timeout: 15000 });
  await pathList(pair)
    .getByRole('button', { name: /^Прогнать e2e/ })
    .click();
  const step = page.getByRole('dialog', { name: 'Прогнать e2e', exact: true });
  await step.waitFor({ timeout: 5000 });
  const text = (await step.innerText()).replace(/\s+/g, ' ');
  check(
    text.includes('отчёт e2e зелёный') && text.includes('e2e report is green'),
    `${theme}: окно шага показывает условие на обоих языках`,
    text,
  );
  await shot(page, `step-gate-both-${theme}`);
  await close();
}

// ---------- 9. Составитель: сбои по режимам, набранное, Home/End ----------
{
  const state = makeGroupState();
  state.promoteFail = true;
  let draftFails = true;
  const { page, close, open } = await openPage({
    state,
    patch: (target) =>
      target.route('**/api/groups/*/path/draft', (route) =>
        draftFails ? json(route, { error: 'ассистент недоступен' }, 502) : route.fallback(),
      ),
  });
  const pair = await open(PAIR);
  await pathList(pair).waitFor({ timeout: 15000 });
  await pathList(pair).getByRole('button', { name: 'Добавить шаг после «Ревью»' }).click();
  const composer = page.getByRole('dialog', { name: 'Новый шаг' });
  await composer.waitFor({ timeout: 5000 });

  // Сбой ассистента: набранное остаётся в поле.
  const input = composer.getByLabel('Что сделать на этом шаге');
  await input.fill('после ревью прогнать e2e');
  await composer.getByRole('button', { name: 'Подготовить' }).click();
  await composer.getByText('Ассистент не ответил').waitFor({ timeout: 6000 });
  check(
    (await input.inputValue()) === 'после ревью прогнать e2e',
    'сбой ассистента не стёр набранное',
    await input.inputValue(),
  );
  await shot(page, 'composer-draft-failed-light');

  // Home/End — края вкладок языка.
  draftFails = false;
  // Поле стёрто (прежнее поведение) — набираем заново, чтобы дойти до остального.
  if (!(await input.inputValue())) await input.fill('после ревью прогнать e2e');
  await composer.getByRole('button', { name: 'Подготовить' }).click();
  const langTabs = composer.getByRole('tablist', { name: 'Язык шага' });
  await langTabs.waitFor({ timeout: 6000 }).catch(() => undefined);
  if (await visible(langTabs)) {
    await langTabs.getByRole('tab', { name: 'RU' }).click();
    await langTabs.getByRole('tab', { name: 'RU' }).focus();
    await page.keyboard.press('Home');
    check(
      (await langTabs.getByRole('tab', { name: 'RU' }).getAttribute('aria-selected')) === 'true',
      'Home на первой вкладке оставляет RU',
    );
    await page.keyboard.press('End');
    await page.keyboard.press('End');
    check(
      (await langTabs.getByRole('tab', { name: 'EN' }).getAttribute('aria-selected')) === 'true',
      'End на последней вкладке оставляет EN',
    );
  } else {
    check(false, 'черновик с вкладками языка пришёл', (await composer.innerText()).slice(0, 200));
  }

  // Сбой хука не переходит в «Выбрать готовый».
  const modes = composer.getByRole('tablist', { name: 'Как добавить шаг' });
  await modes.getByRole('tab', { name: 'Хук' }).click();
  await composer.getByLabel('Название шага').fill('Линт перед коммитом');
  await composer.getByLabel('Команда').fill('pnpm lint');
  await composer.getByRole('button', { name: 'Создать хук и добавить шагом' }).click();
  await composer
    .getByText('Хук не создался', { exact: false })
    .waitFor({ timeout: 6000 })
    .catch(() => undefined);
  check(
    await visible(composer.getByText('Хук не создался', { exact: false })),
    'сбой хука назван в форме хука',
  );
  await modes.getByRole('tab', { name: 'Выбрать готовый' }).click();
  await page.waitForTimeout(500);
  check(
    !(await visible(composer.getByText('Шаг не сохранился. Повторите.'))),
    'в «Выбрать готовый» чужого сбоя нет',
  );
  await shot(page, 'composer-pick-after-hook-failed-light');
  await close();
}

// ---------- 10. Подсказка наведением не глотает Escape переноса (F-277) ----------
{
  const { page, close, open } = await openPage();
  const pair = await open(PAIR);
  const list = pathList(pair);
  await list.waitFor({ timeout: 15000 });
  await list.getByRole('button', { name: /^Прогнать e2e/ }).hover();
  await list
    .getByRole('tooltip')
    .first()
    .waitFor({ timeout: 3000 })
    .catch(() => undefined);
  const handle = list.getByRole('button', { name: /^Переставить шаг «Заметки к релизу»/ });
  await handle.focus();
  await page.keyboard.press('Space');
  const live = pair.getByRole('status').filter({ hasText: 'взят' });
  await live.waitFor({ timeout: 3000 }).catch(() => undefined);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  const said = await pair
    .getByRole('toolbar')
    .getByRole('status')
    .innerText()
    .catch(() => '');
  check(/отменён/.test(said), 'первый Escape отменяет перенос, пока видна подсказка', said);
  check(await visible(pair), 'окно группы не закрылось');
  await close();
}
{
  // Без подсказки: Escape переноса не закрывает окно группы (Radix слушает
  // Escape на документе раньше ручки).
  const { page, close, open } = await openPage();
  const pair = await open(PAIR);
  const list = pathList(pair);
  await list.waitFor({ timeout: 15000 });
  await page.mouse.move(0, 0);
  const handle = list.getByRole('button', { name: /^Переставить шаг «Заметки к релизу»/ });
  await handle.focus();
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  const said = await pair
    .getByRole('toolbar')
    .getByRole('status')
    .innerText()
    .catch(() => '');
  check(
    (await visible(pair)) && /отменён/.test(said),
    'Escape переноса без подсказки отменяет перенос, окно остаётся',
    said,
  );
  await close();
}

// ---------- 11. Отказ создания: причина сервера одной строкой в окне (F-225) ----------
for (const [kind, title, submit] of [
  ['Сценарий', 'Новый сценарий', 'Создать и открыть'],
  ['Набор', 'Новый набор', 'Сохранить'],
]) {
  const reason = 'Группа с таким именем уже есть';
  const { page, close } = await openPage({
    patch: (target) =>
      target.route('**/api/groups', (route) =>
        route.request().method() === 'POST'
          ? json(route, { error: reason }, 409)
          : route.fallback(),
      ),
  });
  await page.getByRole('button', { name: 'Создать группу' }).first().click();
  await page
    .getByRole('dialog', { name: 'Какую группу создать' })
    .getByRole('button', { name: new RegExp(`^${kind}`) })
    .click();
  const modal = page.getByRole('dialog', { name: title });
  await modal.getByLabel('Название').fill('Дубль N3');
  await modal.getByRole('button', { name: submit, exact: true }).click();
  await page.waitForTimeout(1500);
  const inModal = await modal.getByText(reason).count();
  const onPage = await page.getByText(reason).count();
  check(
    inModal === 1 && onPage === 1,
    `${kind}: причина отказа — одна строка в окне, без второго тоста`,
    `в окне ${inModal}, на странице ${onPage}`,
  );
  await shot(page, `create-refused-${kind === 'Набор' ? 'bundle' : 'scenario'}-light`);
  await close();
}

// ---------- 12. Место вставки не переезжает после удаления участника (F-227) ----------
{
  const { page, close } = await openPage();
  await page.getByRole('button', { name: 'Создать группу' }).first().click();
  await page
    .getByRole('dialog', { name: 'Какую группу создать' })
    .getByRole('button', { name: /^Набор/ })
    .click();
  const modal = page.getByRole('dialog', { name: 'Новый набор' });
  const boxes = modal.locator('input[type="checkbox"]');
  await boxes.nth(2).waitFor({ timeout: 8000 });
  for (const index of [0, 1, 2]) await boxes.nth(index).check();
  await modal.getByRole('button', { name: 'Вставить участника на место 2' }).click();
  const notice = modal.getByText('Новый участник встанет на место', { exact: false });
  const armed = await visible(notice);
  await modal
    .getByRole('button', { name: /^Убрать из группы: / })
    .first()
    .click();
  await page.waitForTimeout(300);
  check(
    armed && !(await visible(notice)),
    'удаление участника снимает отмеченное место вставки',
    armed ? await notice.innerText().catch(() => '') : 'место вставки не отметилось',
  );
  await close();
}

// ---------- 13. Два быстрых выбора готового шага: второй не теряет первого (F-228) ----------
{
  // Список групп перечитывается медленно: второй выбор делается раньше, чем
  // страница узнала о первом участнике, — ровно окно, в котором терялся состав.
  const state = makeGroupState();
  const { page, close, open } = await openPage({ state, delay: [[/^\/groups$/, 4000]] });
  const manual = await open(MANUAL);
  await pathList(manual).waitFor({ timeout: 15000 });
  for (const title of ['Прогон e2e', 'Заметки к релизу']) {
    await manual
      .getByRole('toolbar')
      .getByRole('button', { name: /^Добавить (первый )?шаг$/ })
      .click();
    const composer = page.getByRole('dialog', { name: 'Новый шаг' });
    await composer.waitFor({ timeout: 5000 });
    await composer
      .getByRole('tablist', { name: 'Как добавить шаг' })
      .getByRole('tab', { name: 'Выбрать готовый' })
      .click();
    await composer.getByRole('button', { name: `Добавить шагом: ${title}` }).click();
    await composer.waitFor({ state: 'hidden', timeout: 8000 });
  }
  await page.waitForTimeout(1000);
  const puts = state.calls.filter(
    (call) => call.method === 'PUT' && call.path === '/groups/qa-frontend',
  );
  const last = puts.at(-1)?.body?.members ?? [];
  const ids = last.map((member) => `${member.kind}:${member.id}`);
  check(
    ids.includes('skill:e2e-runner') && ids.includes('skill:release-notes'),
    'второй быстрый выбор сохраняет и первого участника',
    `PUT: ${puts.length}, состав: ${ids.join(', ')}`,
  );
  await close();
}

// ---------- 14. Вкладки страницы — общим механизмом разделов (F-214) ----------
// Щелчок по вкладке держится (адрес и выбранная — одна вкладка), переход на
// `/groups` без вкладки открывает последнюю выбранную, а не ту, что была при
// входе на страницу, незнакомая `?tab=` уходит из адреса.
for (const theme of ['light', 'dark']) {
  const { page, close } = await openPage({ theme });
  const tabInUrl = () => new URL(page.url()).searchParams.get('tab');
  for (const [name, id] of [
    ['Найдено', 'found'],
    ['Обнаружение', 'discovery'],
    ['В проектах', 'project'],
  ]) {
    await tabOf(page, name).click();
    await page.waitForTimeout(600);
    const selected = await tabOf(page, name).getAttribute('aria-selected');
    check(
      selected === 'true' && tabInUrl() === id,
      `${theme}: щелчок по «${name}» держится`,
      `адрес ${tabInUrl()}, выбрана ${selected}`,
    );
  }
  await page.locator('nav a[href="/groups"]').first().click();
  await page.waitForTimeout(800);
  check(
    (await tabOf(page, 'В проектах').getAttribute('aria-selected')) === 'true',
    `${theme}: /groups без вкладки на самой странице — последняя выбранная`,
    page.url(),
  );
  await page.goto(`${page.url().split('?')[0]}?tab=xyz`);
  await tabOf(page, 'В проектах').waitFor({ timeout: 15_000 });
  await page.waitForTimeout(800);
  check(
    tabInUrl() === 'project' &&
      (await tabOf(page, 'В проектах').getAttribute('aria-selected')) === 'true',
    `${theme}: незнакомая ?tab= заменена открытой вкладкой`,
    page.url(),
  );
  await shot(page, `tabs-${theme}`);
  await close();
}

await finish('Кромки страницы групп — всё проверено');
