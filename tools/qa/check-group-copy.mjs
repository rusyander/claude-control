/**
 * «Копировать группу»: кнопка на карточке и в шапке окна группы, окно с
 * предложенным именем «(копия)» / «(копия 2)», словами — что копия выключена и
 * ничего не гасит, занятое и пустое имя не проходят; подтверждение шлёт ровно
 * показанное имя, открывает окно копии, карточка копии — «Выключено», шаги пути
 * на месте. Escape закрывает только окно копии.
 *
 * Сервер подменён (`group-stubs.mjs`, маршрут `/duplicate` как у настоящего);
 * независимость копии, новые id шагов и «ничего не гасит» доказывает
 * `apps/server/src/routes/group-duplicate-routes/group-duplicate-routes.integration.test.ts` на
 * настоящих маршрутах и временном каталоге.
 *
 * Запуск: `node tools/qa/check-group-copy.mjs` при поднятом `pnpm dev`
 * (или `APP_URL=` на собранный снимок). Снимки: `.agent/screenshots/before-after/group-copy/`.
 */
import { MANUAL, pathList, rowNumbers, startRun, visible } from './group-harness.mjs';

const SHOTS = '.agent/screenshots/before-after/group-copy';
const { check, openPage, finish } = await startRun(SHOTS);
const COPY = `${MANUAL} (копия)`;

for (const theme of ['light', 'dark']) {
  const { page, state, errors, close, open } = await openPage({ theme });
  const source = await open(MANUAL);
  const sourceRows = await rowNumbers(pathList(source));
  await page.keyboard.press('Escape');
  await source.waitFor({ state: 'hidden', timeout: 5000 });

  // Кнопка на карточке — своя остановка, окно группы не открывает.
  const tileButton = page.getByRole('button', { name: `Копировать группу «${MANUAL}»` });
  await tileButton.click();
  const ask = page.getByRole('dialog', { name: `Копировать группу «${MANUAL}»` });
  await ask.waitFor({ timeout: 5000 });
  check(!(await visible(source)), `${theme}: кнопка карточки не открывает окно группы`);
  const nameField = ask.getByRole('textbox', { name: 'Имя копии' });
  check(
    (await nameField.inputValue()) === COPY,
    `${theme}: предложено «(копия)»`,
    await nameField.inputValue(),
  );
  check(
    await visible(ask.getByText('Копия создаётся выключенной и ничего не гасит', { exact: false })),
    `${theme}: окно говорит, что копия выключена и ничего не гасит`,
  );
  check(
    await visible(ask.getByText('Привязка к проектам не копируется', { exact: false })),
    `${theme}: окно говорит, что привязка не копируется`,
  );
  await page.waitForTimeout(600); // снимок после анимации открытия
  // Видимость Playwright не знает о прокрутке: текст, уехавший за край тела окна, для неё «виден».
  const hidden = await ask.evaluate((node) =>
    [node, ...node.querySelectorAll('*')].some(
      (el) => el.scrollTop > 0 || el.scrollHeight > el.clientHeight + 1,
    ),
  );
  check(!hidden, `${theme}: всё окно копирования видно без прокрутки`);
  await page.screenshot({ path: `${SHOTS}/copy-dialog-${theme}.png` });

  const confirm = ask.getByRole('button', { name: 'Копировать', exact: true });
  await nameField.fill(` ${MANUAL.toUpperCase()} `);
  check(
    await visible(ask.getByText('Группа с таким именем уже есть.')),
    `${theme}: занятое имя названо`,
  );
  check(await confirm.isDisabled(), `${theme}: с занятым именем копировать нельзя`);
  await nameField.fill('   ');
  check(
    await visible(ask.getByText('Без имени копию не создать.')),
    `${theme}: пустое имя названо`,
  );
  await nameField.fill(COPY);
  check(!(await confirm.isDisabled()), `${theme}: со свободным именем — можно`);

  await confirm.click();
  const copied = page.getByRole('dialog', { name: COPY, exact: true });
  await copied.waitFor({ timeout: 8000 });
  const sent = state.calls.filter((call) => call.path.endsWith('/duplicate'));
  check(
    sent.length === 1 && sent[0].body?.name === COPY && sent[0].body?.lang === 'ru',
    `${theme}: ушло ровно показанное имя и язык`,
    JSON.stringify(sent.map((call) => call.body)),
  );
  check(!(await visible(ask)), `${theme}: окно копирования закрылось`);
  check(
    await visible(page.getByText(`Создана «${COPY}» — выключенной`)),
    `${theme}: уведомление называет копию и что она выключена`,
  );
  const copyRows = await rowNumbers(pathList(copied));
  check(
    copyRows.join(',') === sourceRows.join(','),
    `${theme}: у копии те же шаги пути`,
    `${copyRows.join(',')} vs ${sourceRows.join(',')}`,
  );
  await page.waitForTimeout(600); // снимок после анимации открытия
  await page.screenshot({ path: `${SHOTS}/copy-opened-${theme}.png` });

  // Шапка окна копии: «Копировать» ещё раз — уже «(копия 2)»; Escape закрывает только его.
  await copied.getByRole('button', { name: 'Копировать', exact: true }).click();
  const again = page.getByRole('dialog', { name: `Копировать группу «${COPY}»` });
  await again.waitFor({ timeout: 5000 });
  const secondName = await again.getByRole('textbox', { name: 'Имя копии' }).inputValue();
  check(secondName === `${MANUAL} (копия 2)`, `${theme}: копия копии — «(копия 2)»`, secondName);
  // Окно ещё выезжает: Escape посреди анимации открытия человек не нажмёт.
  await page.waitForTimeout(400);
  await page.keyboard.press('Escape');
  await again.waitFor({ state: 'hidden', timeout: 5000 });
  check(await visible(copied), `${theme}: Escape закрыл только окно копирования`);
  check(
    state.calls.filter((call) => call.path.endsWith('/duplicate')).length === 1,
    `${theme}: отмена ничего не шлёт`,
  );
  await page.keyboard.press('Escape');
  await copied.waitFor({ state: 'hidden', timeout: 5000 });

  const copyTile = page.getByRole('article').filter({
    has: page.getByRole('heading', { name: COPY, exact: true }),
  });
  check(
    await visible(copyTile.getByText('Выключено', { exact: true })),
    `${theme}: карточка копии — «Выключено»`,
  );
  check(
    (await copyTile.getByRole('switch').getAttribute('aria-checked')) === 'false',
    `${theme}: тумблер копии выключен`,
  );
  check(errors.length === 0, `${theme}: ошибок консоли нет`, errors.join(' | '));
  await close();
}

// Узкий экран: окно копирования без горизонтальной прокрутки.
{
  const { page, errors, close } = await openPage({ width: 400 });
  await page.getByRole('button', { name: `Копировать группу «${MANUAL}»` }).click();
  const ask = page.getByRole('dialog', { name: `Копировать группу «${MANUAL}»` });
  await ask.waitFor({ timeout: 5000 });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  check(overflow <= 0, '400px: без горизонтальной прокрутки', `${overflow}px`);
  await page.waitForTimeout(600); // снимок после анимации открытия
  await page.screenshot({ path: `${SHOTS}/copy-dialog-400.png` });
  check(errors.length === 0, '400px: ошибок консоли нет', errors.join(' | '));
  await close();
}

await finish('Копирование группы работает');
