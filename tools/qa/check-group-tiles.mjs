/**
 * Карточки и вкладки страницы групп говорят правду, пока данные не пришли или
 * не прочитались: первые шаги скилла — на языке интерфейса (английский
 * заголовок раздела в русской карточке был жалобой), участник без файла виден
 * на карточке, сбой пути — «шаги не прочитались», а не «своих шагов нет»;
 * блока «Автоматизации (хуки)» на странице нет; число вкладки, пока обнаружение
 * читается, — «…», а не 0; на 400px вкладка «Обнаружение» с меткой ошибок
 * видна; сбой источника назван словами интерфейса (и в английском), а не
 * кодом `unreadable` или русским текстом CLI.
 *
 * Сервер подменён (`group-stubs.mjs`); сбои — `patch` поверх подмены. Отбор
 * снятых источников и код сбоя сервера доказывает
 * `apps/server/src/domains/group-discovery/run.test.ts`.
 *
 * Запуск: `node tools/qa/check-group-tiles.mjs` при поднятом `pnpm dev`
 * (или `APP_URL=` на собранный снимок). Снимки: `.agent/screenshots/before-after/group-tiles/`.
 */
import { addDeliveryGroup, makeGroupState } from './group-stubs.mjs';
import { BASE, MANUAL, startRun, visible } from './group-harness.mjs';

const SHOTS = '.agent/screenshots/before-after/group-tiles';
const { check, openPage, finish } = await startRun(SHOTS);

const tileOf = (page, name) =>
  page.getByRole('article').filter({ has: page.getByRole('heading', { name, exact: true }) });
const tabs = (page) => page.getByRole('tablist', { name: /^(Разделы групп|Group sections)$/ });

// ---------- 1. Первые шаги словами интерфейса, участник без файла на карточке ----------
{
  const state = addDeliveryGroup(makeGroupState());
  state.missingMembers = new Set(['mcp:playwright']);
  // Скилл из .claude привязанного проекта: не «нет файла», а «только в проекте».
  const frontend = state.groups.find((group) => group.id === 'qa-frontend');
  frontend.members = [...frontend.members, { kind: 'skill', id: 'incident-capture' }];
  state.projectOnlyMembers = new Map([['skill:incident-capture', 'c:/work/shop']]);
  const { page, errors, close } = await openPage({ state });
  const delivery = tileOf(page, 'Доставка тикета');
  await delivery
    .getByText('Этап 1 доставки')
    .waitFor({ timeout: 15000 })
    .catch(() => undefined);
  check(
    await visible(delivery.getByText('Этап 1 доставки', { exact: true })),
    'первый шаг скилла — русский',
  );
  check(
    !(await visible(delivery.getByText('Stage 1 of the ticket flow', { exact: false }))),
    'английского заголовка раздела на русской карточке нет',
  );
  const manual = tileOf(page, MANUAL);
  const warn = manual.getByText('Нет файла у участника: playwright', { exact: false });
  await warn.waitFor({ timeout: 8000 }).catch(() => undefined);
  check(await visible(warn), 'карточка называет участника без файла');
  const only = manual.getByText('Только в проекте shop, группа им не управляет: incident-capture', {
    exact: true,
  });
  check(await visible(only), 'участник из .claude проекта назван «только в проекте shop»');
  // Каждое предупреждение — своей строкой (<p>): склейка через точку читалась одной фразой.
  const missingLine = await manual
    .locator('p')
    .filter({ hasText: /^Нет файла у/ })
    .innerText()
    .catch(() => '');
  check(
    missingLine !== '' && !missingLine.includes('incident-capture'),
    'участник из проекта не записан в «нет файла»; предупреждения — отдельными строками',
    missingLine,
  );
  await page.screenshot({ path: `${SHOTS}/tiles-steps-missing.png` });
  check(errors.length === 0, 'ошибок консоли нет', errors.join(' | '));
  await close();
}

// ---------- 2. Сбой пути — словами, не фактом; блока автоматизаций на странице нет ----------
{
  const { page, close } = await openPage({
    patch: async (target) => {
      await target.route('**/api/groups/qa-frontend/path', (route) =>
        route.fulfill({ status: 500, json: { error: 'сбой' } }),
      );
    },
  });
  const manual = tileOf(page, MANUAL);
  const failed = manual.getByText('шаги не прочитались — откройте группу', { exact: true });
  await failed.waitFor({ timeout: 15000 }).catch(() => undefined);
  check(await visible(failed), 'сбой пути на карточке назван словами');
  check(
    !(await visible(manual.getByText('Своих шагов нет', { exact: false }))),
    'сбой пути не выдаётся за «своих шагов нет»',
  );
  // Владелец 28.09: хуки живут в разделе «Хуки», на странице групп их блок был
  // третьим способом «создать что-то» и путал с шагом-хуком сценария.
  check(
    (await page.locator('h2', { hasText: 'Автоматизации (хуки)' }).count()) === 0 &&
      (await page.getByRole('button', { name: 'Новый хук' }).count()) === 0,
    'блока «Автоматизации (хуки)» и «Новый хук» на странице групп нет',
  );
  await page.screenshot({ path: `${SHOTS}/tiles-failures.png` });
  await close();
}

// ---------- 3. Вкладки: «…», пока обнаружение читается; 400px — «Обнаружение» видна ----------
{
  const { page, errors, close } = await openPage({
    width: 400,
    delay: [[/^\/groups\/discovery$/, 3000]],
  });
  // Сразу после открытия: находки ещё в пути (задержка 3 с) — ни «0», ни пустоты.
  await tabs(page).waitFor({ timeout: 8000 });
  const zero = await visible(tabs(page).getByRole('tab', { name: 'Найдено, 0' }));
  const reading = await visible(tabs(page).getByRole('tab', { name: 'Найдено, читаю' }));
  check(!zero, 'ноль на вкладке до ответа не показан');
  check(reading, 'пока находки читаются, у вкладки «читаю», а не 0');
  const discovery = tabs(page).getByRole('tab', { name: 'Обнаружение, 1 ошибка' });
  await discovery.waitFor({ timeout: 8000 });
  const box = await discovery.boundingBox();
  const width = await page.evaluate(() => document.documentElement.clientWidth);
  check(
    Boolean(box) && box.x >= 0 && box.x + box.width <= width,
    '400px: вкладка «Обнаружение» с меткой ошибок целиком на экране',
    box ? `${Math.round(box.x)}..${Math.round(box.x + box.width)} из ${width}` : 'нет',
  );
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  check(overflow <= 0, '400px: без горизонтальной прокрутки', `${overflow}px`);
  await page.screenshot({ path: `${SHOTS}/tabs-400.png` });
  check(errors.length === 0, '400px: ошибок консоли нет', errors.join(' | '));
  await close();
}

// ---------- 4. Сбой источника словами — и в английском интерфейсе ----------
for (const lang of ['ru', 'en']) {
  const { page, close } = await openPage({
    patch: (target) =>
      target.route('**/api/settings', async (route) => {
        if (route.request().method() !== 'GET') return route.fallback();
        // Стенд мог перезапускаться: пустой ответ шлюза — повтор, а не падение прогона.
        let response = await route.fetch();
        for (let i = 0; i < 60 && response.status() >= 500; i += 1) {
          await new Promise((done) => setTimeout(done, 1000));
          response = await route.fetch();
        }
        const body = await response.json();
        return route.fulfill({ response, json: { ...body, language: lang } });
      }),
  });
  await page.goto(`${BASE}/groups?tab=discovery`);
  const progress = page.getByRole('group', {
    name: lang === 'en' ? /discovery/i : 'Ход обнаружения по источникам',
  });
  await progress.waitFor({ timeout: 15000 });
  const words = lang === 'en' ? 'the CLI did not answer in time' : 'CLI не ответил вовремя';
  check(
    await visible(progress.getByText(words, { exact: false })),
    `${lang}: сбой источника словами`,
  );
  check(
    !(await visible(progress.getByText('за отведённое время', { exact: false }))),
    `${lang}: сырого текста CLI в строке нет`,
  );
  await page.screenshot({ path: `${SHOTS}/discovery-error-${lang}.png` });
  await close();
}

// ---------- 5. Окно находки называет, что импорт в группу не перенесёт ----------
// Живой разбор: у группы доставки найдено 23 участника, в группу вошли 22 — инструкции
// пропали молча.
{
  const state = makeGroupState();
  const release = state.discovery.groups.find((item) => item.key === 'shop:release');
  release.members = [
    ...release.members,
    {
      kind: 'instructions',
      id: 'CLAUDE.md',
      path: 'C:/work/shop/CLAUDE.md',
      summary: 'правила проекта',
    },
  ];
  const total = release.members.length;
  const { page, errors, close, open } = await openPage({ state });
  await tabs(page)
    .getByRole('tab', { name: /^Найдено, / })
    .click();
  const dialog = await open('Выпуск релиза');
  const note = dialog.getByText(`Импорт перенесёт в группу не всё: CLAUDE.md (1 из ${total})`, {
    exact: false,
  });
  check(await visible(note), 'окно находки до импорта называет, что не войдёт в группу');
  await dialog.getByRole('tab', { name: 'Состав' }).click();
  check(
    await visible(dialog.getByText('не войдёт в группу', { exact: true })),
    'в «Составе» такой участник помечен',
  );
  await page.screenshot({ path: `${SHOTS}/found-import-leaves.png` });
  check(errors.length === 0, 'находка: ошибок консоли нет', errors.join(' | '));
  await close();
}

// ---------- Копия для другой CLI: своя карточка, не пара, без тумблера Claude (F-40) ----------
// Копия в каталоги qwen прежде читалась глобальной группой Claude: карточка
// «глобальная», пара с оригиналом и тумблер, гасивший одноимённые скиллы Claude.
{
  const state = makeGroupState();
  state.groups = [
    ...state.groups,
    {
      id: 'qa-site-docs-qwen',
      name: 'Документация сайта (qwen)',
      description: '',
      color: 'accent',
      icon: 'folder',
      scope: { kind: 'global', provider: 'qwen' },
      origin: {
        scope: { kind: 'project', path: 'C:/work/site', provider: 'claude' },
        groupId: 'qa-site-docs',
        hash: 'h',
        copiedAt: '2026-09-26T09:00:00.000Z',
      },
      members: [{ kind: 'skill', id: 'docs-writer' }],
      env: {},
      isEnabled: true,
      order: 4,
      usedIn: [],
    },
  ];
  state.paths['qa-site-docs-qwen'] = [];
  const { page, errors, close } = await openPage({ state });
  const qwen = tileOf(page, 'Документация сайта (qwen)');
  await qwen.waitFor({ timeout: 15000 });
  check(
    await visible(qwen.getByText('глобальная · qwen', { exact: true })),
    'карточка копии называет провайдера',
  );
  check(
    !(await visible(qwen.getByText('пара с проектом', { exact: false }))),
    'копия для qwen — не пара проектной группы',
  );
  check(
    (await qwen.getByRole('switch').count()) === 0,
    'тумблера Claude у копии для qwen нет',
    String(await qwen.getByRole('switch').count()),
  );
  // Контроль: оригинал остаётся своей проектной карточкой, с тумблером.
  await tabs(page)
    .getByRole('tab', { name: /^В проектах/ })
    .click();
  const site = tileOf(page, 'Документация сайта');
  await site.waitFor({ timeout: 8000 }).catch(() => undefined);
  check(await visible(site), 'проектный оригинал — своя карточка на вкладке проектов');
  check((await site.getByRole('switch').count()) === 1, 'у оригинала тумблер на месте');
  await page.screenshot({ path: `${SHOTS}/foreign-copy-tile.png` });
  check(errors.length === 0, 'копия для qwen: ошибок консоли нет', errors.join(' | '));
  await close();
}

await finish('Карточки и вкладки групп честны о сбоях и языке');
