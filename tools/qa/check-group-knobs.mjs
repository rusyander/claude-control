/**
 * Сетка карточек групп, окно группы и числа скиллов на строках порядка работы.
 *
 * Сетка: карточка — только главное (область, «Когда», число шагов и
 * участников, тумблер), имя — кнопка с кольцом фокуса, Enter открывает окно,
 * Escape закрывает и возвращает фокус на карточку, тумблер — своя остановка
 * Tab и окна не открывает; числа скиллов до открытия окна не просятся.
 * «Состав»: описания участников с сервера — пока читаются, «читаю…».
 * Числа: «читаю скилл…» и опрос, пока сервер дочитывает; список «Авто (в
 * скилле: N)» + min..max; число, равное умолчанию, закрепляется (PUT числом, а
 * не null), «Авто» шлёт null; отказ сервера — тост словами и прежнее значение;
 * сбой чтения с «Повторить»; у группы без чисел списков нет.
 *
 * API групп подменён (`group-stubs.mjs`), остальное — стенд как есть.
 * Запуск: `node tools/qa/check-group-knobs.mjs` при поднятом `pnpm dev`.
 * Снимки: `.agent/screenshots/before-after/group-cards/check-knobs-*.png`.
 */
import { makeGroupState } from './group-stubs.mjs';
import { PAIR, SITE, pathList, startRun, visible } from './group-harness.mjs';

const SHOTS = '.agent/screenshots/before-after/group-cards';
const { check, openPage, finish } = await startRun(SHOTS);

const asked = (requests, part) =>
  requests.filter((url) => new URL(url).pathname.endsWith(part)).length;
const knobPuts = (state) =>
  state.calls.filter((call) => call.path.endsWith('/knobs') && call.method !== 'GET');
const tileButton = (page, name) =>
  page.getByRole('heading', { name, exact: true }).getByRole('button', { name, exact: true });

// ---------- 1. Сетка: карточка, клавиатура, тумблер ----------
{
  const { page, state, errors, requests, close } = await openPage();
  const button = tileButton(page, PAIR);
  await button.waitFor({ timeout: 15000 });
  await page.waitForTimeout(800);
  const tile = page.locator('[data-agent-anchor="qa-shop-order-global"]');
  for (const [text, what] of [
    ['глобальная', 'область'],
    ['пара с проектом', 'пара'],
    ['задача с номером тикета в любом проекте', '«Когда»'],
  ]) {
    check(await visible(tile.getByText(text, { exact: false })), `на карточке видна ${what}`);
  }
  check(
    await visible(tile.getByText('4 шага · 2 участника')),
    'на карточке — число шагов и участников',
  );
  check(await visible(tile.getByText('В проекте изменилось: 1')), 'и предупреждение об оригинале');
  check(
    (await page.getByRole('tablist').count()) === 1,
    'на странице — только вкладки разделов; вкладки группы — в её окне',
  );
  check(
    asked(requests, '/knobs') === 0,
    'числа скиллов не просятся до окна',
    `запросов: ${asked(requests, '/knobs')}`,
  );
  await page.screenshot({ path: `${SHOTS}/check-knobs-grid-light.png`, fullPage: true });

  // Tab до имени: кольцо фокуса, Enter — окно с фокусом внутри, Escape — назад.
  await button.focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  const ring = await button.evaluate((node) => {
    const style = getComputedStyle(node);
    return node === document.activeElement && style.outlineStyle !== 'none'
      ? style.outlineWidth
      : '';
  });
  check(ring !== '' && ring !== '0px', 'у имени карточки видно кольцо фокуса', ring);
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: PAIR, exact: true });
  await dialog.waitFor({ timeout: 5000 });
  check(
    await dialog.evaluate((node) => node.contains(document.activeElement)),
    'Enter открывает окно, фокус внутри',
  );
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden', timeout: 3000 }).catch(() => undefined);
  await page.waitForTimeout(300);
  check(
    await button.evaluate((node) => node === document.activeElement),
    'Escape закрывает окно и возвращает фокус на карточку',
  );

  // «Копировать группу» (27.09) и тумблер — свои остановки Tab; тумблер
  // включает, а окна не открывает.
  const copy = tile.getByRole('button', { name: `Копировать группу «${PAIR}»` });
  const toggle = tile.getByRole('switch', { name: `Включено: ${PAIR}` });
  await page.keyboard.press('Tab');
  check(
    await copy.evaluate((node) => node === document.activeElement),
    'следующая остановка Tab — «Копировать группу»',
  );
  await page.keyboard.press('Tab');
  check(await toggle.evaluate((node) => node === document.activeElement), 'за ней — тумблер');
  await toggle.click();
  await page.waitForTimeout(500);
  check(!(await visible(dialog)), 'щелчок по тумблеру окна не открывает');
  check(
    state.calls.some((call) => call.path.includes('qa-shop-order-global')),
    'тумблер записал включение',
  );
  check(errors.length === 0, 'ошибок консоли нет', errors.join(' | '));
  await close();
}

// ---------- 2. «Состав»: описания с сервера, пока читаются — «читаю…» ----------
{
  const { close, open } = await openPage({ delay: [[/\/members$/, 1500]] });
  // Скилл проекта: своего описания у панели нет (тёзка из общего каталога —
  // другой файл), поэтому до ответа сервера строка честно «читаю…».
  const site = await open(SITE);
  await site.getByRole('tab', { name: 'Состав' }).click();
  const row = site.getByRole('tabpanel').locator('ol > li').first();
  await row.waitFor({ timeout: 5000 });
  check(
    await visible(row.getByText('читаю…')),
    'пока описания читаются — «читаю…», а не голое имя',
  );
  const described = row.getByText('«docs-writer» из файла', { exact: false });
  await described.waitFor({ timeout: 6000 }).catch(() => undefined);
  check(await visible(described), 'описание из файла проекта дорисовалось после ответа');
  await close();
}
{
  const { close, open } = await openPage({ delay: [[/\/members$/, 1500]] });
  const dialog = await open(PAIR);
  await dialog.getByRole('tab', { name: 'Состав' }).click();
  const members = dialog.getByRole('tabpanel').locator('ol > li');
  await members.first().waitFor({ timeout: 5000 });
  // Строка участника: первая строка — вид и имя (id — вторичным, если имя
  // другое), под ней — строка «что делает» или запасная.
  const parts = () =>
    members.evaluateAll((nodes) =>
      nodes.map((node) => (node.children[0]?.children.length ?? 0) + node.children.length - 1),
    );
  const early = await parts();
  check(
    early.length === 2 && early.every((count) => count >= 3),
    'и до ответа у каждого участника вид, имя и строка',
    early.join(','),
  );
  await members
    .first()
    .getByText('доводит тикет до MR', { exact: false })
    .waitFor({ timeout: 6000 })
    .catch(() => undefined);
  const late = await parts();
  check(
    late.every((count) => count >= 3),
    'и после ответа — тоже',
    late.join(','),
  );
  await close();
}

// ---------- 3. Числа: читаю скилл…, «Авто» ↔ число, закрепление, отказ ----------
{
  const state = makeGroupState();
  state.knobsPendingPolls = 1;
  const { page, errors, close, open } = await openPage({ state });
  const dialog = await open(PAIR);
  const list = pathList(dialog);
  const pending = dialog.getByText('читаю скилл ticket-delivery…');
  await pending.waitFor({ timeout: 8000 }).catch(() => undefined);
  check(await visible(pending), 'пока сервер дочитывает скилл — «читаю скилл…»');
  const rounds = list.getByRole('combobox', { name: /^Кругов ревью — шаг/ });
  const agents = list.getByRole('combobox', { name: /^Агентов на круг — шаг/ });
  await rounds.waitFor({ timeout: 10000 });
  check(!(await visible(pending)), 'после опроса «читаю» уходит, списки на месте');
  check(
    (await rounds.inputValue()) === '3',
    'своё число группы показано числом',
    await rounds.inputValue(),
  );
  check(
    (await agents.inputValue()) === 'auto',
    'число без записи — «Авто»',
    await agents.inputValue(),
  );
  const options = await rounds.locator('option').allTextContents();
  check(
    options.join('|') === 'Авто (в скилле: 2)|1|2|3|4|5',
    '«Авто» с числом скилла и числа от min до max',
    options.join('|'),
  );
  const weight = (locator) => locator.evaluate((node) => getComputedStyle(node).fontWeight);
  check(Number(await weight(rounds)) > Number(await weight(agents)), 'закреплённое число выделено');
  await page.screenshot({ path: `${SHOTS}/check-knobs-path-light.png` });

  // Число, равное умолчанию, — закрепление, а не «Авто»: PUT несёт само число.
  await agents.selectOption('2');
  await page.waitForTimeout(700);
  const pin = knobPuts(state).at(-1)?.body?.values;
  check(
    pin?.['ticket-delivery:agents-per-round'] === 2,
    'выбор числа, равного умолчанию, шлёт число',
    JSON.stringify(pin),
  );
  check(
    (await agents.inputValue()) === '2',
    'и оно осталось закреплённым, а не стало «Авто»',
    await agents.inputValue(),
  );

  // «Авто» возвращает число скиллу: PUT с null.
  await rounds.selectOption('auto');
  await page.waitForTimeout(700);
  const reset = knobPuts(state).at(-1)?.body?.values;
  check(
    reset && reset['ticket-delivery:review-rounds'] === null,
    '«Авто» шлёт null',
    JSON.stringify(reset),
  );
  check((await rounds.inputValue()) === 'auto', 'и список показывает «Авто»');

  // Отказ сервера: тост словами, значение прежнее.
  await page.route('**/api/groups/*/knobs', (route) =>
    route.request().method() === 'PUT'
      ? route.fulfill({ status: 400, json: { error: 'Кругов ревью: нужно от 1 до 5' } })
      : route.fallback(),
  );
  await rounds.selectOption('4');
  const refused = page.getByText('Кругов ревью: нужно от 1 до 5');
  await refused.waitFor({ timeout: 5000 }).catch(() => undefined);
  check(await visible(refused), 'отказ сервера назван словами');
  check(
    (await rounds.inputValue()) === 'auto',
    'и в списке прежнее значение',
    await rounds.inputValue(),
  );
  check(
    errors.every((line) => line.includes('/knobs')),
    'других ошибок нет',
    errors.join(' | '),
  );
  await close();
}

// ---------- 4. Сбой чтения чисел и группа без чисел ----------
{
  const state = makeGroupState();
  state.knobsFail.add('qa-shop-order-global');
  const { page, close, open } = await openPage({ state });
  const dialog = await open(PAIR);
  const failed = dialog.getByText('Числа скиллов не загрузились.');
  await failed.waitFor({ timeout: 10000 }).catch(() => undefined);
  check(await visible(failed), 'сбой чисел назван словами');
  check(await visible(pathList(dialog)), 'а порядок работы виден и без чисел');
  state.knobsFail.clear();
  await dialog.getByRole('button', { name: 'Повторить' }).click();
  const rounds = pathList(dialog).getByRole('combobox', { name: /^Кругов ревью/ });
  await rounds.waitFor({ timeout: 8000 }).catch(() => undefined);
  check(await visible(rounds), '«Повторить» дочитывает числа');
  // Под указателем могла оказаться строка с подсказкой: первый Escape прятал
  // бы её, а не окно. Уводим указатель — Escape закрывает окно.
  await page.mouse.move(0, 0);
  await page.waitForTimeout(200);
  await page.keyboard.press('Escape');
  const site = await open(SITE);
  await pathList(site).waitFor({ timeout: 10000 });
  check((await site.getByRole('combobox').count()) === 0, 'у группы без чисел списков нет');
  await close();
}

// ---------- 4б. Закреплённое число вне min..max: видно числом, не «Авто» (F-75) ----------
// Новая выписка скилла сузила размах, а значение группы сервер не трогает —
// прогон берёт 8. Прежде список без такого пункта молча показывал «Авто».
{
  const state = makeGroupState();
  state.knobs['qa-shop-order-global'].values['ticket-delivery:review-rounds'] = 8;
  const { page, errors, close, open } = await openPage({ state });
  const dialog = await open(PAIR);
  const rounds = pathList(dialog).getByRole('combobox', { name: /^Кругов ревью — шаг/ });
  await rounds.waitFor({ timeout: 10000 });
  check(
    (await rounds.inputValue()) === '8',
    'закреплённое 8 при 1..5 показано числом',
    await rounds.inputValue(),
  );
  const options = await rounds.locator('option').allTextContents();
  check(
    options.at(-1) === '8 (вне диапазона 1–5)',
    'пункт назван «вне диапазона», стоит за max',
    options.join('|'),
  );
  // Контроль: число в диапазоне — обычный пункт, пометки нет.
  const agents = pathList(dialog).getByRole('combobox', { name: /^Агентов на круг — шаг/ });
  check(
    !(await agents.locator('option').allTextContents()).some((text) =>
      text.includes('вне диапазона'),
    ),
    'у «Авто»-числа пометки нет',
  );
  await page.screenshot({ path: `${SHOTS}/check-knobs-out-of-range.png` });
  check(errors.length === 0, 'ошибок консоли нет', errors.join(' | '));
  await close();
}

// ---------- 5. Тёмная тема ----------
{
  const { page, close, open } = await openPage({ theme: 'dark' });
  const dialog = await open(PAIR);
  await pathList(dialog).getByRole('combobox').first().waitFor({ timeout: 10000 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${SHOTS}/check-knobs-path-dark.png` });
  await close();
}

await finish('Сетка групп и числа скиллов работают');
