/**
 * Конструктор групп, третий круг: вкладки страницы, «Создать группу» → «Сценарий»,
 * составитель шага с тремя способами (словами, из каталога, хук), длинный путь
 * из восьмидесяти шагов и «Порядок применения» участников словами со вставкой
 * «+» на место.
 *
 * API групп подменён целиком (`group-stubs.mjs`), запись, которую подмена не
 * знает, до сервера не доходит (501). Прогон не трогает ~/.claude и проекты.
 *
 * Негативы и вариации: пустое имя сценария (запроса нет), отказ ассистента,
 * медленный каталог (не «ничего не нашлось»), повышение до хука отвергнуто
 * (путь возвращается как был), 80 шагов (фильтр, «Свернуть все», без
 * горизонтальной прокрутки на 420px), адрес главнее запомненной вкладки.
 *
 * Запуск: `node tools/qa/check-group-builder.mjs` при поднятом `pnpm dev`.
 * Снимки: `.agent/screenshots/before-after/group-cards/check-builder-*.png`.
 */
import { makeGroupState } from './group-stubs.mjs';
import {
  BASE,
  PAIR,
  SITE,
  lastSteps,
  pathList,
  rowTitles,
  startRun,
  visible,
} from './group-harness.mjs';

const SHOTS = '.agent/screenshots/before-after/group-cards';
const { check, openPage, finish } = await startRun(SHOTS);
const tabsOf = (page) => page.getByRole('tablist', { name: 'Разделы групп' });
const tab = (page, name) => tabsOf(page).getByRole('tab', { name: new RegExp(`^${name}, `) });
const saves = (state, id) => state.calls.filter((call) => call.path === `/groups/${id}`);

// ---------- 1. Вкладки: адрес главнее памяти, память без адреса ----------
{
  const { page, close } = await openPage();
  await tabsOf(page).waitFor({ timeout: 15000 });
  await tab(page, 'Найдено').click();
  check(page.url().includes('tab=found'), 'вкладка пишется в адрес', page.url());
  await page.goto(`${BASE}/groups`);
  await tabsOf(page).waitFor({ timeout: 15000 });
  check(
    (await tab(page, 'Найдено').getAttribute('aria-selected')) === 'true',
    'без ?tab= открыта запомненная вкладка',
  );
  await page.goto(`${BASE}/groups?tab=project`);
  await tabsOf(page).waitFor({ timeout: 15000 });
  check(
    (await tab(page, 'В проектах').getAttribute('aria-selected')) === 'true',
    'адрес главнее запомненной вкладки',
  );
  await page.goto(`${BASE}/groups?tab=nonsense`);
  await tabsOf(page).waitFor({ timeout: 15000 });
  check(
    (await tabsOf(page).locator('[aria-selected="true"]').count()) === 1,
    'незнакомая вкладка в адресе не даёт пустого экрана',
  );
  await tab(page, 'Глобальные').focus();
  await page.keyboard.press('ArrowRight');
  check(
    (await tab(page, 'В проектах').getAttribute('aria-selected')) === 'true',
    'стрелка вправо переключает вкладку',
  );
  await close();
}

// ---------- 1а. Одна кнопка создания и окно выбора вида: 1280/1920 обе темы, 400 ----------
// Владелец 28.09: «Создать группу» и «Создать сценарий» рядом не читались, а блок
// «Автоматизации (хуки)» с «Новым хуком» был третьим способом создать что-то.
{
  const CHOOSER_SHOTS = '.agent/screenshots/before-after/L4-create-chooser';
  const TAG = process.env.SHOT_TAG ?? 'after';
  for (const [theme, width] of [
    ['light', 1280],
    ['dark', 1280],
    ['light', 1920],
    ['dark', 1920],
    ['light', 400],
  ]) {
    const label = `${theme} ${width}`;
    const { page, errors, close } = await openPage({ theme, width });
    await tabsOf(page).waitFor({ timeout: 15000 });
    const create = page.locator('main').getByRole('button', { name: 'Создать группу' });
    check(
      (await create.count()) === 1 &&
        (await page.getByRole('button', { name: 'Создать сценарий' }).count()) === 0,
      `${label}: в шапке одна кнопка создания`,
    );
    check(
      (await page.getByRole('button', { name: 'Новый хук' }).count()) === 0 &&
        (await page.locator('h2', { hasText: 'Автоматизации (хуки)' }).count()) === 0,
      `${label}: блока автоматизаций нет`,
    );
    await page.screenshot({ path: `${CHOOSER_SHOTS}/${TAG}-${theme}-${width}-page.png` });
    await create.click();
    const chooser = page.getByRole('dialog', { name: 'Какую группу создать' });
    await chooser.waitFor({ timeout: 5000 });
    await chooser.evaluate((node) =>
      Promise.all(node.getAnimations({ subtree: true }).map((a) => a.finished)),
    );
    const geo = await chooser.evaluate((node) => {
      const box = node.getBoundingClientRect();
      const options = [...node.querySelectorAll('ul button')].map((button) => {
        const rect = button.getBoundingClientRect();
        return {
          inside: rect.left >= box.left - 0.5 && rect.right <= box.right + 0.5,
          overflow: button.scrollWidth > button.clientWidth + 1,
        };
      });
      return {
        fits: box.left >= 0 && box.right <= window.innerWidth,
        options,
        pageScroll: document.documentElement.scrollWidth > window.innerWidth,
      };
    });
    check(
      geo.fits && !geo.pageScroll && geo.options.length === 2,
      `${label}: окно выбора целиком в экране, вариантов два`,
      JSON.stringify(geo),
    );
    check(
      geo.options.every((item) => item.inside && !item.overflow),
      `${label}: варианты не вылезают и не обрезаны`,
      JSON.stringify(geo.options),
    );
    // Первый вариант получает фокус с клавиатуры, Escape закрывает окно и
    // возвращает фокус на кнопку создания.
    await page.keyboard.press('Escape');
    await chooser.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => undefined);
    check(
      await create.evaluate((node) => node === document.activeElement),
      `${label}: Escape возвращает фокус на «Создать группу»`,
    );
    await create.click();
    await chooser.waitFor({ timeout: 5000 });
    await chooser.evaluate((node) =>
      Promise.all(node.getAnimations({ subtree: true }).map((a) => a.finished)),
    );
    await page.screenshot({ path: `${CHOOSER_SHOTS}/${TAG}-${theme}-${width}.png` });
    check(errors.length === 0, `${label}: ошибок консоли нет`, errors.join(' | '));
    await close();
  }
}

// ---------- 2. «Создать группу» → «Сценарий»: пустое имя, создание, составитель ----------
{
  const { page, state, errors, close } = await openPage();
  check(
    (await page.getByRole('button', { name: 'Создать сценарий' }).count()) === 0,
    'на странице одна кнопка создания, «Создать сценарий» рядом не стоит',
  );
  await page.getByRole('button', { name: 'Создать группу' }).first().click();
  const chooser = page.getByRole('dialog', { name: 'Какую группу создать' });
  await chooser.waitFor({ timeout: 5000 });
  check(
    (await visible(chooser.getByRole('button', { name: /^Набор/ }))) &&
      (await visible(chooser.getByText('Шаги по порядку — это вся работа', { exact: false }))),
    'выбор вида: у «Набора» и «Сценария» своя строка о разнице',
  );
  await chooser.getByRole('button', { name: /^Сценарий/ }).click();
  const modal = page.getByRole('dialog', { name: 'Новый сценарий' });
  await modal.waitFor({ timeout: 5000 });
  await modal.getByRole('button', { name: 'Создать и открыть' }).click();
  check(
    await visible(modal.getByText('Без названия сценарий не создать.')),
    'пустое имя названо словами',
  );
  check(
    !state.calls.some((call) => call.path === '/groups' && call.method === 'POST'),
    'с пустым именем запроса нет',
  );
  await modal.getByLabel('Название').fill('Выпуск релиза магазина');
  await modal.getByRole('button', { name: 'Создать и открыть' }).click();
  const created = state.calls.find((call) => call.path === '/groups' && call.method === 'POST');
  await page.waitForTimeout(600);
  check(created?.body?.flow === 'scenario', 'создаётся группа flow: scenario', created?.body?.flow);
  const composer = page.getByRole('dialog', { name: 'Новый шаг' });
  await composer.waitFor({ timeout: 8000 }).catch(() => undefined);
  check(await visible(composer), 'после создания сразу открыт составитель первого шага');
  const group = page.getByRole('dialog', { name: 'Выпуск релиза магазина', exact: true });
  check(await visible(group), 'под ним — окно нового сценария');

  // Три способа — вкладки; «Выбрать готовый» — каталог, сначала «описание готовится».
  const modes = composer.getByRole('tablist', { name: 'Как добавить шаг' });
  for (const name of ['Описать словами', 'Выбрать готовый', 'Хук']) {
    check(await visible(modes.getByRole('tab', { name })), `способ «${name}» есть`);
  }
  await modes.getByRole('tab', { name: 'Выбрать готовый' }).click();
  const pickE2e = composer.getByRole('button', {
    name: /^Добавить шагом: (Прогон e2e|e2e-runner)$/,
  });
  await pickE2e.waitFor({ timeout: 6000 });
  await composer
    .getByText('гоняет e2e на стенде', { exact: false })
    .waitFor({ timeout: 8000 })
    .catch(() => undefined);
  check(
    await visible(composer.getByText('гоняет e2e на стенде', { exact: false })),
    'описание каталога докатилось опросом',
  );
  await composer.getByLabel('Найти в каталоге').fill('линт');
  check(
    (await composer.getByRole('button', { name: /^Добавить шагом:/ }).count()) === 1,
    'поиск каталога сужает список',
  );
  await composer.getByLabel('Найти в каталоге').fill('');
  await page.screenshot({ path: `${SHOTS}/check-builder-catalog-light.png` });
  await pickE2e.click();
  await composer.waitFor({ state: 'hidden', timeout: 6000 }).catch(() => undefined);
  await page.waitForTimeout(600);
  const id = created ? state.groups.at(-1)?.id : '';
  const steps = lastSteps(state, id) ?? [];
  check(
    steps.length === 1 && steps[0]?.resource?.id === 'e2e-runner',
    'щелчок по каталогу — шаг-ссылка на скилл',
    JSON.stringify(steps.map((item) => item.resource)),
  );
  const members = saves(state, id).at(-1)?.body?.members ?? [];
  check(
    members.some((member) => member.kind === 'skill' && member.id === 'e2e-runner'),
    'в сценарии скилл из каталога становится участником',
    JSON.stringify(members),
  );

  // Утилита — шаг, но не участник.
  await group
    .getByRole('button', { name: /^Добавить шаг после/ })
    .last()
    .click();
  await composer.waitFor({ timeout: 5000 });
  await composer.getByRole('tab', { name: 'Выбрать готовый' }).click();
  await composer.getByRole('button', { name: /^Добавить шагом: tools\/shots\.mjs$/ }).click();
  await page.waitForTimeout(800);
  check((lastSteps(state, id) ?? []).length === 2, 'утилита встала вторым шагом');
  const after = saves(state, id).at(-1)?.body?.members ?? [];
  check(!after.some((member) => member.id === 'tools/shots.mjs'), 'утилита участником не стала');
  check(errors.length === 0, 'ошибок консоли нет', errors.join(' | '));
  await close();
}

// ---------- 2б. Конвейер: скилл из каталога — тоже участник ----------
// Раньше участником он становился только в сценарии: у конвейера шаг «примени
// скилл X» упирался в выключенный скилл. Второго блока нет — сервер не рисует
// блоком скилл, стоящий в пути шагом.
{
  const { page, state, errors, close, open } = await openPage();
  const dialog = await open(PAIR);
  await pathList(dialog).waitFor({ timeout: 15000 });
  await pathList(dialog).getByRole('button', { name: 'Добавить шаг после «Ревью»' }).click();
  const composer = page.getByRole('dialog', { name: 'Новый шаг' });
  await composer.getByRole('tab', { name: 'Выбрать готовый' }).click();
  await composer.getByRole('button', { name: /^Добавить шагом: (Прогон e2e|e2e-runner)$/ }).click();
  await page.waitForTimeout(900);
  const id = 'qa-shop-order-global';
  const members = saves(state, id).at(-1)?.body?.members ?? [];
  check(
    members.some((member) => member.kind === 'skill' && member.id === 'e2e-runner'),
    'в конвейере скилл из каталога становится участником',
    JSON.stringify(members.map((member) => `${member.kind}:${member.id}`)),
  );
  check(errors.length === 0, 'ошибок консоли нет', errors.join(' | '));
  await close();
}

// ---------- 2в. Проектная группа: общий скилл из каталога — с областью ----------
// Ревью 28.09 (F-39): участник без `scope` живёт там же, где группа, и общий
// скилл, выбранный в проектной группе, сервер читал как проектный.
{
  const { page, state, errors, close, open } = await openPage();
  const dialog = await open(SITE);
  await pathList(dialog).waitFor({ timeout: 15000 });
  await pathList(dialog)
    .getByRole('button', { name: /^Добавить шаг/ })
    .first()
    .click();
  const composer = page.getByRole('dialog', { name: 'Новый шаг' });
  await composer.getByRole('tab', { name: 'Выбрать готовый' }).click();
  await composer.getByRole('button', { name: /^Добавить шагом: (Прогон e2e|e2e-runner)$/ }).click();
  await page.waitForTimeout(900);
  const members = saves(state, 'qa-site-docs').at(-1)?.body?.members ?? [];
  const picked = members.find((member) => member.kind === 'skill' && member.id === 'e2e-runner');
  check(
    picked?.scope?.kind === 'global',
    'общий скилл в проектной группе сохраняется с scope: global',
    JSON.stringify(members),
  );
  check(errors.length === 0, 'ошибок консоли нет', errors.join(' | '));
  await close();
}

// ---------- 3. Хук: создание и отказ повышения ----------
for (const promoteFail of [false, true]) {
  const state = makeGroupState();
  state.promoteFail = promoteFail;
  const { page, close, open } = await openPage({ state });
  const dialog = await open(PAIR);
  await pathList(dialog).waitFor({ timeout: 15000 });
  const before = (state.paths['qa-shop-order-global'] ?? []).map((item) => item.id);
  await pathList(dialog).getByRole('button', { name: 'Добавить шаг после «Ревью»' }).click();
  const composer = page.getByRole('dialog', { name: 'Новый шаг' });
  await composer.getByRole('tab', { name: 'Хук' }).click();
  await composer.getByRole('button', { name: 'Создать хук и добавить шагом' }).click();
  check(
    await visible(composer.getByText('Без названия шаг не сохранить.')),
    'хук без названия не создаётся — сказано словами',
  );
  await composer.getByLabel('Название шага').fill('Линт после правки');
  await composer.getByLabel('Команда', { exact: true }).fill('pnpm lint');
  await composer.getByRole('button', { name: 'Создать хук и добавить шагом' }).click();
  await page.waitForTimeout(1500);
  const promote = state.calls.find((call) => call.path.endsWith('/path/promote'));
  check(promote?.body?.type === 'hook', 'хук создаётся повышением шага', promote?.body?.type);
  const now = (state.paths['qa-shop-order-global'] ?? []).map((item) => item.id);
  if (promoteFail) {
    check(
      now.join(',') === before.join(','),
      'отказ повышения — путь вернулся как был',
      now.join(','),
    );
    check(
      await visible(composer.getByText('Хук не создался', { exact: false })),
      'и отказ назван в составителе',
    );
  } else {
    const titles = await rowTitles(pathList(dialog));
    check(
      titles.some((title) => /^Линт после правки\s*хук$/.test(title)),
      'шаг-хук в пути: то же название, вид «хук»',
      titles.join(' | '),
    );
    // Прогон читает EN: русское название там было бы русским текстом для модели.
    const saved = (lastSteps(state, 'qa-shop-order-global') ?? []).find(
      (item) => item.title?.ru === 'Линт после правки',
    );
    check(
      Boolean(saved) && !/[а-яё]/i.test(saved.title.en) && saved.title.en.startsWith('Hook '),
      'у шага-хука английская сторона названия — английская',
      JSON.stringify(saved?.title),
    );
  }
  await close();
}

// ---------- 4. Отказ и задержка ассистента в «Описать словами» ----------
{
  const { page, state, close, open } = await openPage({
    delay: [[/\/path\/draft$/, 2000]],
    patch: (target) =>
      target.route('**/api/groups/*/path/draft', (route) =>
        route.fulfill({ status: 502, json: { error: 'модель недоступна' } }),
      ),
  });
  const dialog = await open(PAIR);
  await pathList(dialog).getByRole('button', { name: 'Добавить шаг после «План»' }).click();
  const composer = page.getByRole('dialog', { name: 'Новый шаг' });
  await composer.getByLabel('Что сделать на этом шаге').fill('сверить с макетом');
  await composer.getByRole('button', { name: 'Подготовить' }).click();
  await composer
    .getByRole('alert')
    .waitFor({ timeout: 6000 })
    .catch(() => undefined);
  check(
    await visible(composer.getByText('Ассистент не ответил. Повторите.')),
    'отказ ассистента назван',
  );
  check(!state.calls.some((call) => call.path.endsWith('/path/steps')), 'и ничего не записано');
  await close();
}

// ---------- 5. Восемьдесят шагов: фильтр, свёртка, узкий экран ----------
for (const theme of ['light', 'dark']) {
  const state = makeGroupState();
  const own = state.paths['qa-shop-order-global'] ?? [];
  const many = Array.from({ length: 80 }, (_, index) => ({
    ...own[0],
    id: `s-many-${index}`,
    order: index,
    anchor: 'work',
    title: { ru: `Шаг номер ${index + 1}`, en: `Step ${index + 1}` },
  }));
  state.paths['qa-shop-order-global'] = [...many, ...own.slice(1)];
  const { page, close, open } = await openPage({ state, theme, width: 420 });
  const dialog = await open(PAIR);
  const list = pathList(dialog);
  await list.waitFor({ timeout: 15000 });
  const started = Date.now();
  await dialog.getByLabel('Найти шаг').fill('номер 77');
  const titles = await rowTitles(list);
  check(
    titles.length === 1 && titles[0].startsWith('Шаг номер 77'),
    `${theme}: фильтр из 80+ шагов оставил один`,
    `${titles.length} за ${Date.now() - started} мс`,
  );
  check(
    (await list.getByRole('button', { name: /^Добавить шаг после/ }).count()) === 0,
    `${theme}: под фильтром «+» нет — список плоский`,
  );
  await dialog.getByLabel('Найти шаг').fill('');
  await dialog.getByRole('button', { name: 'Свернуть все' }).click();
  check(
    (await list.getByRole('button', { name: /^Взять тикет/ }).count()) === 0 ||
      !(await visible(list.getByRole('button', { name: /^Взять тикет/ }))),
    `${theme}: «Свернуть все» прячет шаги скилла`,
  );
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  check(overflow <= 0, `${theme}, 420px: 80 шагов без горизонтальной прокрутки`, `${overflow}px`);
  await page.screenshot({ path: `${SHOTS}/check-builder-80-${theme}-420.png` });
  await close();
}

// ---------- 6. «Порядок применения»: словами, «+» ставит на место ----------
{
  const { page, state, close, open } = await openPage();
  const dialog = await open(PAIR);
  await dialog.getByRole('button', { name: 'Редактировать' }).click();
  const form = page.getByRole('dialog').last();
  const order = form
    .getByRole('list')
    .filter({ has: page.getByText('ticket-delivery') })
    .last();
  await order.waitFor({ timeout: 8000 });
  check(
    await visible(order.getByText('доводит тикет до MR', { exact: false })),
    'участник читается одной строкой «что делает»',
  );
  await form.getByRole('button', { name: 'Вставить участника на место 1' }).click();
  check(
    await visible(form.getByText('Новый участник встанет на место 1', { exact: false })),
    'выбранное место названо',
  );
  const pick = form.locator('label').filter({ hasText: 'Фронтенд-работа' }).locator('input');
  await pick.check();
  await form.getByRole('button', { name: 'Сохранить' }).click();
  await page.waitForTimeout(800);
  const saved = saves(state, 'qa-shop-order-global').at(-1)?.body?.members ?? [];
  check(
    saved[0]?.kind === 'group' && saved[0]?.id === 'qa-frontend',
    'отмеченный после «+» участник встал первым',
    JSON.stringify(saved.map((member) => member.id)),
  );
  await close();
}

// ---------- 6б. Стёртое «Когда» уходит пустой строкой, а не пропадает из тела (F-71) ----------
// С `undefined` ключ выпадал из JSON, сервер оставлял прежнее условие, а тост
// говорил «сохранено» — старое «Когда» продолжало управлять автовыбором.
{
  const { page, state, close, open } = await openPage();
  const dialog = await open(PAIR);
  await dialog.getByRole('button', { name: 'Редактировать' }).click();
  const form = page.getByRole('dialog').last();
  const when = form.getByLabel('Когда уместна');
  await when.waitFor({ timeout: 8000 });
  check(
    (await when.inputValue()) === 'задача с номером тикета в любом проекте',
    'форма открылась с прежним «Когда»',
    await when.inputValue(),
  );
  await when.fill('');
  await form.getByRole('button', { name: 'Сохранить' }).click();
  await page.waitForTimeout(800);
  const body = saves(state, 'qa-shop-order-global').at(-1)?.body;
  check(
    body !== undefined && Object.hasOwn(body, 'when') && body.when === '',
    'PUT несёт when: "" — стирание дошло до сервера',
    JSON.stringify(body?.when ?? '(ключа нет)'),
  );
  await close();
}
{
  // Контроль: «Когда» не трогали — уходит как было.
  const { page, state, close, open } = await openPage();
  const dialog = await open(PAIR);
  await dialog.getByRole('button', { name: 'Редактировать' }).click();
  const form = page.getByRole('dialog').last();
  await form.getByLabel('Когда уместна').waitFor({ timeout: 8000 });
  await form.getByRole('button', { name: 'Сохранить' }).click();
  await page.waitForTimeout(800);
  const body = saves(state, 'qa-shop-order-global').at(-1)?.body;
  check(
    body?.when === 'задача с номером тикета в любом проекте',
    'нетронутое «Когда» уходит прежним',
    JSON.stringify(body?.when),
  );
  await close();
}

// ---------- 7. Перенос мышью за ручку: плавно и рывком ----------
for (const moves of [10, 1]) {
  const { page, state, close, open } = await openPage();
  const dialog = await open(PAIR);
  const list = pathList(dialog);
  await list.waitFor({ timeout: 15000 });
  const handle = list.getByRole('button', { name: 'Переставить шаг «Заметки к релизу»' });
  const target = list.getByRole('button', { name: 'Добавить шаг после «Разбор задачи»' });
  await handle.scrollIntoViewIfNeeded();
  const from = await handle.boundingBox();
  const to = await target.boundingBox();
  const x = from.x + from.width / 2;
  await page.mouse.move(x, from.y + from.height / 2);
  await page.mouse.down();
  // Рывок (один шаг) — событие указателя раньше перерисовки: так ломался перенос.
  if (moves > 1) await page.mouse.move(x, from.y - 40, { steps: 5 });
  await page.mouse.move(x, to.y + to.height / 2, { steps: moves });
  await page.mouse.up();
  await page.waitForTimeout(800);
  const moved = (lastSteps(state, 'qa-shop-order-global') ?? []).find(
    (item) => item.id === 's-rel',
  );
  check(
    moved?.anchor === 'triage',
    `мышью за ручку (${moves === 1 ? 'рывком' : 'плавно'}) шаг встаёт к ближайшему «+»`,
    JSON.stringify(moved?.anchor),
  );
  await close();
}

await finish('Конструктор групп работает');
