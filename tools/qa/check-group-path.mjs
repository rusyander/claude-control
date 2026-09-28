/**
 * Вкладка «Порядок работы» в окне группы: нумерованные строки — стадии
 * конвейера (не правятся), шаги скиллов (показ) и свои шаги человека; у
 * каждой строки метка «откуда»; наведение и фокус показывают описание, а
 * сводку ресурса строка спрашивает только показанной; «+» после строк, куда
 * шаг встанет; перенос и удаление своего шага; вкладка «Состав» с описаниями
 * участников с сервера.
 *
 * Окно шага, вставка «+» и ассистент шага — `check-group-steps.mjs`; числа
 * скиллов — `check-group-knobs.mjs`. API групп подменён (`group-stubs.mjs`),
 * подмена изменяемая: после PUT путь перечитывается и показывает ответ «сервера».
 *
 * Вариации: путь грузится медленно (не сбой, пустой список не рисуется) и
 * падает (сбой словами, «Повторить», соседняя группа жива), участник без
 * файла, старый шаг без перевода, узкий экран без горизонтальной прокрутки.
 *
 * Запуск: `node tools/qa/check-group-path.mjs` при поднятом `pnpm dev`.
 * Снимки: `.agent/screenshots/before-after/group-cards/check-path-*.png`.
 */
import { mkdirSync } from 'node:fs';
import { addDeliveryGroup, addScenarioGroup, makeGroupState } from './group-stubs.mjs';
import {
  MANUAL,
  PAIR,
  SITE,
  lastSteps,
  pathList,
  rowNumbers,
  startRun,
  visible,
} from './group-harness.mjs';

const SHOTS = '.agent/screenshots/before-after/group-cards';
const { check, openPage, finish } = await startRun(SHOTS);

// ---------- 1. Строки, метки, подсказки, «Состав», перенос и удаление ----------
{
  const { page, state, errors, requests, close, open } = await openPage();
  const dialog = await open(PAIR);
  const list = pathList(dialog);
  await list.waitFor({ timeout: 15000 });

  const tabs = dialog.getByRole('tablist', { name: 'Вид группы' });
  check(
    (await tabs.getByRole('tab', { name: 'Порядок работы' }).getAttribute('aria-selected')) ===
      'true',
    'окно открывается на «Порядке работы»',
  );
  const numbers = await rowNumbers(list);
  check(
    numbers.join(',') === '1,2,3,4',
    'нумеруются только шаги: 2 шага скилла + 2 своих, стадии — без номера',
    numbers.join(','),
  );
  const plus = await list.getByRole('button', { name: /^Добавить шаг после/ }).count();
  // Шаг ставится и внутрь раскрытого блока скилла — там он идёт в ходе скилла.
  check(plus === 10, '«+» после каждой строки, в раскрытом блоке скилла — тоже', `кнопок: ${plus}`);
  const stageTips = await list
    .locator('li > button[title]:not([aria-label])')
    .evaluateAll((items) => items.map((item) => item.getAttribute('title') ?? ''));
  check(
    stageTips.length === 6 && stageTips.every(Boolean),
    'шесть стадий — разделители с описанием',
    `стадий: ${stageTips.length}`,
  );
  check(
    (await list.getByRole('button', { name: 'Править шаг «Разбор задачи»' }).count()) === 0,
    'стадию конвейера править нельзя',
  );
  const block = list.getByRole('button', { name: 'Шаги скилла «ticket-delivery», 2 шага' });
  check(
    (await block.getAttribute('aria-expanded')) === 'true',
    'шаги скилла — один блок с его id, раскрыт',
  );
  check(
    (await list
      .getByRole('button', { name: /^Взять тикет и завести ветку наш скилл$/ })
      .count()) === 1,
    'шаг скилла помечен видом «наш скилл»',
  );
  check(
    (await list.getByRole('button', { name: /Править шаг «Взять тикет/ }).count()) === 0,
    'шаг скилла только показывается',
  );
  check(
    await visible(list.getByRole('button', { name: 'Прогнать e2e промпт', exact: true })),
    'свой шаг помечен «промпт»',
  );
  check(
    await visible(list.getByRole('button', { name: /^Заметки к релизу (наш|чужой) скилл$/ })),
    'шаг, превращённый в скилл, помечен видом скилла',
  );
  check(
    await visible(list.getByText('Готово, когда: отчёт e2e зелёный')),
    'у своего шага видна проверка «готово, когда»',
  );

  // Подсказка: наведение показывает первый абзац своего шага.
  const e2eButton = list.getByRole('button', { name: /^Прогнать e2e/ });
  const e2eHint = list.getByRole('tooltip').filter({ hasText: 'Прогони e2e и приложи отчёт.' });
  check(!(await visible(e2eHint)), 'до наведения подсказки не видно');
  await e2eButton.hover();
  check(await visible(e2eHint), 'наведение показывает описание шага');
  check(
    (await e2eButton.getAttribute('aria-describedby')) === (await e2eHint.getAttribute('id')),
    'кнопка строки описана подсказкой для диктора',
  );

  // Сводку шага-ресурса просит только показанная подсказка.
  const summaryAsked = () =>
    requests.filter(
      (url) => url.includes('/api/resources/summary') && url.includes('id=release-notes'),
    ).length;
  check(
    summaryAsked() === 0,
    'сводка ресурса не просится до показа',
    `запросов: ${summaryAsked()}`,
  );
  await list.getByRole('button', { name: /^Заметки к релизу/ }).hover();
  const relHint = list.getByRole('tooltip').filter({ hasText: 'что делает: собирает заметки' });
  await relHint.waitFor({ timeout: 5000 }).catch(() => undefined);
  check(await visible(relHint), 'подсказка шага-ресурса — сводка «что делает»');
  check(summaryAsked() === 1, 'сводка спрошена один раз', `запросов: ${summaryAsked()}`);
  await page.screenshot({ path: `${SHOTS}/check-path-hint-light.png` });

  // Фокус с клавиатуры показывает то же; Escape прячет подсказку, окно живо.
  await page.mouse.move(0, 0);
  await page.waitForTimeout(200);
  await e2eButton.focus();
  check(await visible(e2eHint), 'фокус показывает описание шага');
  await page.keyboard.press('Escape');
  check(!(await visible(e2eHint)), 'Escape прячет подсказку');
  check(await visible(dialog), 'и не закрывает окно группы');
  check(
    await e2eButton.evaluate((node) => node === document.activeElement),
    'фокус остался на строке',
  );
  check(
    stageTips.some((tip) => tip.includes('Составить план изменений')),
    'у стадии «План» описание — что на ней делается',
  );

  // «Состав»: стрелка вправо, описания участников — с сервера, «Используется в».
  await tabs.getByRole('tab', { name: 'Порядок работы' }).focus();
  await page.keyboard.press('ArrowRight');
  const membersTab = tabs.getByRole('tab', { name: 'Состав' });
  check((await membersTab.getAttribute('aria-selected')) === 'true', 'стрелка вправо — «Состав»');
  const panel = dialog.getByRole('tabpanel');
  await panel
    .getByText('доводит тикет до MR')
    .waitFor({ timeout: 5000 })
    .catch(() => undefined);
  check(
    await visible(panel.getByText('доводит тикет до MR', { exact: false })),
    'у участника описание из его файла',
  );
  check(
    requests.some((url) => url.endsWith('/api/groups/qa-shop-order-global/members')),
    'описания пришли одним запросом состава',
  );
  check(
    await visible(panel.getByText('C:/work/blog', { exact: false })),
    '«Используется в» перечисляет проекты',
  );
  await page.keyboard.press('ArrowLeft');

  // Перенос с клавиатуры: Пробел взял, стрелка вверх — место выше, Пробел положил.
  const handle = list.getByRole('button', { name: 'Переставить шаг «Прогнать e2e»' });
  await handle.focus();
  await page.keyboard.press('Space');
  const live = dialog.locator('[aria-live]').filter({ hasText: 'Прогнать e2e' });
  check(await visible(live.first()), 'взятый шаг объявлен в живой области');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Space');
  await page.waitForTimeout(700);
  const moved = lastSteps(state, 'qa-shop-order-global')?.find((item) => item.id === 's-e2e');
  check(
    moved?.anchor === 'work',
    'место выше края стадии переносит шаг в предыдущую',
    JSON.stringify(moved?.anchor),
  );

  // Удаление через подтверждение.
  await list.getByRole('button', { name: 'Убрать шаг «Прогнать e2e»' }).click();
  await page
    .getByRole('alertdialog')
    .or(page.getByRole('dialog').last())
    .getByRole('button', { name: 'Убрать', exact: true })
    .click();
  await page.waitForTimeout(700);
  const afterRemove = lastSteps(state, 'qa-shop-order-global') ?? [];
  check(!afterRemove.some((item) => item.id === 's-e2e'), 'удаление шлёт список без шага');
  check(
    !(await visible(list.getByRole('button', { name: /^Прогнать e2e/ }))),
    'и путь перерисован без него',
  );
  check(await visible(dialog), 'окно группы осталось открытым');

  check(errors.length === 0, 'ошибок консоли нет', errors.join(' | '));
  await close();
}

// ---------- 2. Время и сбой загрузки пути ----------
{
  const { page, close, open } = await openPage({
    delay: [[/^\/groups\/qa-shop-order-global\/path$/, 2500]],
  });
  const tile = page.locator('[data-agent-anchor="qa-shop-order-global"]');
  await tile.waitFor({ timeout: 15000 });
  check(
    await visible(tile.getByText('шаги: читаю…', { exact: false })),
    'карточка: пока путь читается — «шаги: читаю…»',
  );
  const dialog = await open(PAIR);
  await page.waitForTimeout(500);
  check(
    !(await visible(dialog.getByText('Порядок работы группы не загрузился.'))),
    'медленный путь не выдаётся за сбой',
  );
  check(!(await visible(pathList(dialog))), 'пока путь грузится, пустой список не рисуется');
  await pathList(dialog)
    .waitFor({ timeout: 6000 })
    .catch(() => undefined);
  check(await visible(pathList(dialog)), 'путь дорисовался после ответа');
  check(
    await visible(tile.getByText('4 шага', { exact: false })),
    'карточка считает шаги без стадий конвейера',
  );
  await close();
}
{
  const { page, close, open } = await openPage({
    patch: (target) =>
      target.route('**/api/groups/qa-frontend/path', (route) =>
        route.fulfill({ status: 500, json: { error: 'сбой' } }),
      ),
  });
  const tile = page.locator('[data-agent-anchor="qa-frontend"]');
  await tile.getByText('участник', { exact: false }).waitFor({ timeout: 15000 });
  await page.waitForTimeout(3000);
  check(
    !(await visible(tile.getByText('шаги: читаю…', { exact: false }))),
    'карточка со сбоем пути не читает вечно',
  );
  const dialog = await open(MANUAL);
  const failed = dialog.getByText('Порядок работы группы не загрузился.');
  await failed.waitFor({ timeout: 15000 }).catch(() => undefined);
  check(await visible(failed), 'сбой пути назван словами');
  check(await visible(dialog.getByRole('button', { name: /Повторить/ })), 'и есть «Повторить»');
  await page.keyboard.press('Escape');
  const pair = await open(PAIR);
  await pathList(pair)
    .waitFor({ timeout: 8000 })
    .catch(() => undefined);
  check(await visible(pathList(pair)), 'сбой одной группы не гасит путь соседней');
  await close();
}

// ---------- 3. Участник без файла, старый шаг без перевода ----------
{
  const state = makeGroupState();
  state.missingMembers = new Set(['skill:docs-writer']);
  const { close, open } = await openPage({ state });
  const dialog = await open(SITE);
  const list = pathList(dialog);
  await list.waitFor({ timeout: 15000 });
  check(await visible(list.getByText('нужен перевод')), 'перенесённый шаг помечен «нужен перевод»');
  check(
    await visible(list.getByText('Идёт в чате разбора задачи', { exact: false })),
    'шаг после «Разбора задачи» подписан: идёт в чате разбора',
  );
  const numbers = await rowNumbers(list);
  // Стадии и шаги подряд: у кнопок стадий и строк нет своего aria-label.
  const titles = await list
    .locator('button:not([aria-label])')
    .evaluateAll((items) => items.map((item) => item.textContent ?? ''));
  const at = titles.findIndex((title) => title.startsWith('Уточнить объём'));
  check(
    numbers[0] === '1' && at > 0 && titles[at - 1]?.startsWith('Разбор задачи'),
    'шаг разбора стоит сразу после стадии «Разбор задачи»',
    titles.slice(0, 4).join(' | '),
  );
  await dialog.getByRole('tab', { name: 'Состав' }).click();
  const missing = dialog.getByRole('tabpanel').getByText('файла нет', { exact: true });
  await missing.waitFor({ timeout: 5000 }).catch(() => undefined);
  check(await visible(missing), 'участник без файла помечен «файла нет»');
  await close();
}

// ---------- 4. Узкий экран и тёмная тема ----------
for (const theme of ['light', 'dark']) {
  const { page, close, open } = await openPage({ theme, width: 420 });
  const dialog = await open(PAIR);
  await pathList(dialog).waitFor({ timeout: 15000 });
  await page.waitForTimeout(600);
  const overflow = await page.evaluate(() => {
    const box = document.querySelector('[role="dialog"]');
    const inner = [...(box?.querySelectorAll('*') ?? [])].filter(
      (node) =>
        node.scrollWidth > node.clientWidth + 1 &&
        // Прокручивается только auto/scroll; hidden с многоточием — обрезанная строка.
        ['auto', 'scroll'].includes(getComputedStyle(node).overflowX) &&
        node.tagName !== 'SELECT',
    );
    return {
      page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      dialog: box ? box.getBoundingClientRect().right - window.innerWidth : 0,
      inner: inner.map((node) => node.className).slice(0, 3),
    };
  });
  check(
    overflow.page <= 0 && overflow.dialog <= 0,
    `420px, ${theme}: окно и страница без горизонтальной прокрутки`,
    JSON.stringify(overflow),
  );
  check(
    overflow.inner.length === 0,
    `420px, ${theme}: внутри окна ничего не прокручивается вбок`,
    overflow.inner.join(', '),
  );
  await page.screenshot({ path: `${SHOTS}/check-path-${theme}-420.png` });
  await close();
}

// ---------- 5. Сценарий из 80 шагов: перенос с клавиатуры держит фокус, край тянет список ----------
// Ручка раньше снималась на время сохранения: фокус уходил на окно, второй
// перенос с клавиатуры не делал ничего. Мышью/пальцем место за краем окна было
// недостижимо — список у края не ехал.
{
  const state = addScenarioGroup(makeGroupState());
  state.saveDelay = 400;
  const { page, errors, close, open } = await openPage({ state });
  const dialog = await open('Длинный сценарий');
  const list = pathList(dialog);
  await list.getByText('Действие номер 80').first().waitFor({ timeout: 20000 });
  const order = () =>
    (state.paths['qa-scenario'] ?? []).toSorted((a, b) => a.order - b.order).map((item) => item.id);
  check(
    (await rowNumbers(list)).length === 80,
    'сценарий: все 80 шагов на экране',
    (await rowNumbers(list)).length,
  );
  check(
    !(await visible(
      dialog.getByRole('button', { name: /^(Разбор|План|Работа|Ревью|Правки|Доставка)$/ }),
    )),
    'сценарий: разделителей стадий нет',
  );

  const handle = list.getByRole('button', { name: 'Переставить шаг «Действие номер 1»' });
  await handle.focus();
  await page.keyboard.press('Space');
  for (let move = 0; move < 5; move += 1) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Space');
  await page.waitForTimeout(900);
  const focused = await page.evaluate(
    () => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.tagName,
  );
  check(
    order().indexOf('sc-1') === 5,
    'клавиатура: шаг ушёл на 5 мест вниз',
    order().slice(0, 7).join(','),
  );
  check(
    focused === 'Переставить шаг «Действие номер 1»',
    'после переноса фокус на ручке перенесённого шага',
    focused,
  );
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Space');
  await page.waitForTimeout(900);
  const puts = state.calls.filter((call) => call.path === '/groups/qa-scenario/path/steps').length;
  check(
    order().indexOf('sc-1') === 4 && puts === 2,
    'второй перенос подряд тоже работает',
    `index ${order().indexOf('sc-1')}, PUT ${puts}`,
  );

  // Мышь: шаг 2 держим у нижнего края окна, не двигая, — список едет сам.
  const grip = list.getByRole('button', { name: 'Переставить шаг «Действие номер 2»' });
  await grip.scrollIntoViewIfNeeded();
  const box = await grip.boundingBox();
  const edge = await list.evaluate((node) => {
    for (let el = node.parentElement; el; el = el.parentElement) {
      const style = getComputedStyle(el);
      if (['auto', 'scroll'].includes(style.overflowY) && el.scrollHeight > el.clientHeight) {
        return el.getBoundingClientRect().bottom;
      }
    }
    return window.innerHeight;
  });
  const x = box.x + box.width / 2;
  await page.mouse.move(x, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(x, edge - 8, { steps: 12 });
  await page.waitForTimeout(1500);
  const scrolled = await dialog.evaluate((node) =>
    Math.max(...[node, ...node.querySelectorAll('*')].map((el) => el.scrollTop)),
  );
  await page.mouse.up();
  await page.waitForTimeout(900);
  check(scrolled > 400, 'мышь у края: список прокрутился сам', `scrollTop ${scrolled}`);
  check(
    order().indexOf('sc-2') > 15,
    'и шаг лёг в место, которого без прокрутки не было видно',
    `index ${order().indexOf('sc-2')}`,
  );
  check(errors.length === 0, 'сценарий: ошибок консоли нет', errors.join(' | '));
  await page.screenshot({ path: `${SHOTS}/check-path-scenario-80.png` });
  await close();
}

// ---------- 6. Скилл из 14 шагов, описаны 12: все шаги на экране, хвост «готовится» ----------
// Как у живой группы доставки: текст скилла дал 14 шагов, кэш описаний — 12.
// Все 14 строк обязаны быть видны (блок раскрыт, «14 шагов»), недостающие два
// — номером шага и «описание готовится», а не английским заголовком раздела.
{
  const state = addDeliveryGroup(makeGroupState(), { unreadable: true });
  const { errors, close, open } = await openPage({ state });
  const dialog = await open('Доставка тикета');
  const list = pathList(dialog);
  await list.getByText('Этап 12 доставки').first().waitFor({ timeout: 20000 });
  const numbers = await rowNumbers(list);
  check(numbers.length === 14, 'скилл из 14 шагов: все 14 строк на экране', numbers.length);
  const toggle = dialog.getByRole('button', { name: /14 шагов/ });
  check(
    (await toggle.getAttribute('aria-expanded')) === 'true',
    'блок скилла раскрыт, в нём «14 шагов»',
  );
  check(await visible(list.getByText('Шаг 13 скилла')), 'шаг 13 без описания — номером шага');
  check(await visible(list.getByText('Шаг 14 скилла')), 'шаг 14 без описания — номером шага');
  check(
    !(await visible(list.getByText('Stage 13 of the ticket flow'))),
    'английский заголовок раздела в русском интерфейсе не показан',
  );
  // Скрытая подсказка строки повторяет тот же текст — считаются только видимые.
  const preparing = list.getByText('описание готовится…').filter({ visible: true });
  check(
    (await preparing.count()) === 2,
    'у двух недостающих шагов — «описание готовится…»',
    String(await preparing.count()),
  );
  const alert = dialog.getByRole('alert').filter({ hasText: 'locked-skill' });
  check(await visible(alert), 'скилл, чей файл не прочёлся, назван словами, а не пропал молча');
  check(errors.length === 0, 'доставка: ошибок консоли нет', errors.join(' | '));
  await dialog.screenshot({ path: `${SHOTS}/check-path-delivery-14.png` });
  await close();
}

// ---------- 7. «Состав»: имя и строка на языке интерфейса, id вторым, «готовится» из pending ----------
// Живой разбор: у хука группы доставки на экране был `PreToolUse:873e2037`, хотя сервер уже
// вернул русское имя, а описание — английской строкой из файла.
for (const width of [1400, 400]) {
  const state = makeGroupState();
  const group = state.groups.find((item) => item.id === 'qa-shop-order-global');
  const HOOK = 'local:UserPromptSubmit:a8f575fe';
  group.members = [...group.members, { kind: 'hook', id: HOOK }];
  state.memberViews = {
    'qa-shop-order-global': {
      groupId: 'qa-shop-order-global',
      steps: [],
      pending: ['rule:review-checklist'],
      members: [
        {
          kind: 'skill',
          id: 'ticket-delivery',
          title: { ru: 'Доводка тикета', en: 'Ticket delivery' },
          summary: { ru: 'Ведёт задачу от разбора до MR', en: 'Takes a ticket to an MR' },
          description: 'Delivers a ticket end to end',
        },
        { kind: 'rule', id: 'review-checklist' },
        {
          kind: 'hook',
          id: HOOK,
          title: { ru: 'При отправке: узнаёт задачу', en: 'On submit: detects the ticket' },
          description: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/detect.mjs"',
        },
      ],
    },
  };
  const { page, errors, close, open } = await openPage({ state, width });
  const dialog = await open(PAIR);
  await dialog.getByRole('tab', { name: 'Состав' }).click();
  const panel = dialog.getByRole('tabpanel');
  await panel
    .getByText('Доводка тикета')
    .waitFor({ timeout: 5000 })
    .catch(() => undefined);
  check(
    await visible(panel.getByText('Доводка тикета', { exact: true })),
    `${width}: имя скилла — русское`,
  );
  check(
    await visible(panel.getByText('Ведёт задачу от разбора до MR', { exact: true })),
    `${width}: строка «что делает» — русская`,
  );
  check(
    !(await visible(panel.getByText('Delivers a ticket end to end'))),
    `${width}: английская строка файла не показана, когда есть русская`,
  );
  check(
    await visible(panel.getByText('При отправке: узнаёт задачу', { exact: true })),
    `${width}: хук назван словами, а не id`,
  );
  const hookId = panel.getByText(HOOK, { exact: true });
  const idLook = await hookId.evaluate((node) => ({
    mono: getComputedStyle(node).fontFamily.includes('Mono'),
    weight: Number(getComputedStyle(node).fontWeight),
  }));
  check(
    idLook.mono && idLook.weight < 500,
    `${width}: id хука второстепенен`,
    JSON.stringify(idLook),
  );
  check(
    await visible(panel.getByText('описание готовится…', { exact: true })),
    `${width}: участник из pending — «описание готовится…»`,
  );
  const overflow = await panel.evaluate((node) => node.scrollWidth - node.clientWidth);
  check(overflow <= 0, `${width}: «Состав» без горизонтальной прокрутки`, `${overflow}px`);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/check-path-members-${width}.png` });
  check(errors.length === 0, `${width}: ошибок консоли нет`, errors.join(' | '));
  await close();
}

// ---------- 8. Панель поиска прилипает под шапку окна и закрывает строки ----------
// Живой разбор 28.09: панель липла на отступ тела окна ниже шапки, и в щели над
// ней прокручивались шаги — строка «7 Снять скриншоты» стояла поверх поиска.
// Прилипшая панель обязана стоять вплотную к верху прокручиваемого тела, фон —
// непрозрачный, в точке над ней — ничего из списка.
{
  const TAG = process.env.SHOT_TAG ?? 'after';
  const STICKY_SHOTS = '.agent/screenshots/before-after/L4-sticky-toolbar';
  for (const [theme, width] of [
    ['light', 1280],
    ['dark', 1280],
    ['light', 1920],
    ['dark', 1920],
    ['light', 400],
  ]) {
    const state = addDeliveryGroup(makeGroupState());
    const { page, errors, close, open } = await openPage({ state, theme, width });
    const dialog = await open('Доставка тикета');
    await pathList(dialog).getByText('Этап 12 доставки').first().waitFor({ timeout: 20000 });
    const toolbar = dialog.getByRole('toolbar');
    const geo = await toolbar.evaluate(async (node) => {
      let body = node.parentElement;
      while (body && !/(auto|scroll)/.test(getComputedStyle(body).overflowY)) {
        body = body.parentElement;
      }
      body.scrollTop = body.scrollHeight;
      await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
      const bar = node.getBoundingClientRect();
      const port = body.getBoundingClientRect();
      const x = bar.left + bar.width / 2;
      const above = document.elementFromPoint(x, port.top + 2);
      const bg = getComputedStyle(node).backgroundColor;
      return {
        gap: Math.round(bar.top - port.top),
        aboveIsBar: Boolean(above && node.contains(above)) || above === node,
        opaque: !/rgba\(.*,\s*0(\.\d+)?\)$/.test(bg) && bg !== 'transparent',
        scrolled: body.scrollTop,
      };
    });
    const tag = `${theme}-${width}`;
    check(geo.scrolled > 0, `${tag}: тело окна прокручено`, String(geo.scrolled));
    check(Math.abs(geo.gap) <= 1, `${tag}: панель прилипла вплотную к верху тела`, `${geo.gap}px`);
    check(geo.aboveIsBar, `${tag}: над панелью не просвечивают шаги`);
    check(geo.opaque, `${tag}: фон панели непрозрачный`);
    check(errors.length === 0, `${tag}: ошибок консоли нет`, errors.join(' | '));
    mkdirSync(STICKY_SHOTS, { recursive: true });
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${STICKY_SHOTS}/${TAG}-${tag}.png` });
    await close();
  }
}

// ---------- 9. Ресурс шага проектной группы: файл и описание — из проекта (F-76, F-77) ----------
// Шаг, повышенный до правила или хука в проектной группе, лежит в `.claude`
// проекта (`promote.ts`). Прежде окно шага называло глобальные CLAUDE.md и
// settings.json, а описание спрашивалось без проекта — у одноимённого общего.
{
  const resourceStep = (id, title, resource) => ({
    id,
    anchor: 'review',
    order: 0,
    kind: 'resource',
    title: { ru: title, en: title },
    prompt: { ru: '', en: '' },
    source: 'ru',
    resource,
    createdAt: '2026-09-26T09:00:00.000Z',
  });
  const state = makeGroupState();
  state.paths['qa-site-docs'] = [
    ...state.paths['qa-site-docs'],
    resourceStep('s-style', 'Стиль документации', { type: 'rule', id: 'docs-style' }),
    { ...resourceStep('s-hook', 'Линт документации', { type: 'hook', id: 'Stop:docs' }), order: 1 },
  ];
  const { page, errors, requests, close, open } = await openPage({ state });
  const summaries = () =>
    requests
      .filter((url) => new URL(url).pathname.endsWith('/resources/summary'))
      .map((url) => new URL(url).searchParams);
  const dialog = await open(SITE);
  const list = pathList(dialog);
  await list.waitFor({ timeout: 15000 });
  const opened = async (title) => {
    await list.getByRole('button', { name: new RegExp(`^${title}`) }).click();
    const window = page.getByRole('dialog', { name: title, exact: true });
    await window.waitFor({ timeout: 5000 });
    return window;
  };
  const fileOf = (window) =>
    window
      .locator('dt', { hasText: /^Файл$/ })
      .locator('xpath=following-sibling::dd[1]')
      .innerText()
      .catch(() => '');

  const rule = await opened('Стиль документации');
  const ruleFile = (await fileOf(rule)).replaceAll('\\', '/');
  check(
    ruleFile === 'C:/work/site/.claude/rules/docs-style.md',
    'правило шага проектной группы — файл в .claude проекта',
    ruleFile,
  );
  await rule.getByText('«docs-style» — что делает', { exact: false }).waitFor({ timeout: 6000 });
  const ruleAsk = summaries().find((params) => params.get('id') === 'docs-style');
  check(
    ruleAsk?.get('path') === 'C:/work/site',
    'описание правила спрошено в проекте группы',
    ruleAsk?.toString() ?? 'запроса нет',
  );
  await page.keyboard.press('Escape');

  const hook = await opened('Линт документации');
  const hookFile = (await fileOf(hook)).replaceAll('\\', '/');
  check(
    hookFile === 'C:/work/site/.claude/settings.json',
    'хук шага проектной группы — settings.json проекта',
    hookFile,
  );
  await page.keyboard.press('Escape');
  await dialog.waitFor({ timeout: 3000 });
  await page.keyboard.press('Escape');

  // Контроль: ресурс шага глобальной группы — общий, без проекта в запросе.
  const pair = await open(PAIR);
  const pairList = pathList(pair);
  await pairList.getByRole('button', { name: /^Заметки к релизу/ }).click();
  const release = page.getByRole('dialog', { name: 'Заметки к релизу', exact: true });
  await release.waitFor({ timeout: 5000 });
  await release.getByText('«release-notes» — что делает', { exact: false }).waitFor({
    timeout: 6000,
  });
  const releaseAsk = summaries().find((params) => params.get('id') === 'release-notes');
  check(
    releaseAsk !== undefined && !releaseAsk.has('path'),
    'ресурс глобальной группы спрошен без проекта',
    releaseAsk?.toString() ?? 'запроса нет',
  );
  check(errors.length === 0, 'ресурсы проектной группы: ошибок консоли нет', errors.join(' | '));
  await close();
}

await finish('Порядок работы группы работает');
