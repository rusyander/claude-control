/**
 * Сценарий: шаг, вставленный в самое начало, и выбор готового ресурса в
 * выключенной группе (F-126, F-100).
 *
 * F-126: у сценария один ряд — `work`. Вставка «в самое начало» клала шаг под
 * `triage`, у сценария появлялась вторая стадия, и агент панели, считающий
 * место по ряду `work`, ставил свои шаги не туда. Проверяется то, что уходит
 * PUT: все шаги под `work`, новый — первым по номеру, и на экране он первый.
 *
 * F-100: скилл, правило или хук из каталога становится участником группы, а
 * участник выключенной группы выключается везде. Выбор говорит это до щелчка —
 * у включённой группы строки нет.
 *
 * API групп подменён (`group-stubs.mjs`), настройки стенда не меняются.
 * Запуск: `node tools/qa/check-group-scenario-first.mjs` при поднятом `pnpm dev`.
 * Снимки: `.agent/screenshots/before-after/F-100-F-126/`.
 */
import { addScenarioGroup, makeGroupState } from './group-stubs.mjs';
import { lastSteps, pathList, rowTitles, startRun, visible } from './group-harness.mjs';

const SHOTS = '.agent/screenshots/before-after/F-100-F-126';
const ID = 'qa-scenario';
const NAME = 'Длинный сценарий';
const WARNING = /^Группа выключена\./;

const { check, openPage, finish } = await startRun(SHOTS);

/** Открыть сценарий, «+» в самом начале, способ «Выбрать готовый». */
async function openPicker(state) {
  const run = await openPage({ state });
  const dialog = await run.open(NAME);
  const list = pathList(dialog);
  await list.getByText('Действие номер 3').first().waitFor({ timeout: 20000 });
  await list.getByRole('button', { name: 'Добавить шаг в самое начало' }).click();
  const composer = run.page.getByRole('dialog', { name: 'Новый шаг' });
  await composer.waitFor({ timeout: 8000 });
  await composer.getByRole('tab', { name: 'Выбрать готовый' }).click();
  await composer
    .getByRole('button', { name: 'Добавить шагом: Прогон e2e' })
    .waitFor({ timeout: 8000 });
  return { ...run, list, composer };
}

// ---------- 1. Выключенный сценарий: предупреждение и шаг первым в ряду work ----------
{
  const state = addScenarioGroup(makeGroupState(), { count: 3 });
  const { page, list, composer, errors, close } = await openPicker(state);
  const warning = composer.getByText(WARNING);
  check(await visible(warning), 'выключенная группа: в выборе предупреждение «выключится везде»');
  await page.screenshot({ path: `${SHOTS}/picker-group-off.png` });

  await composer.getByRole('button', { name: 'Добавить шагом: Прогон e2e' }).click();
  await composer.waitFor({ state: 'hidden', timeout: 8000 }).catch(() => undefined);
  await page.waitForTimeout(800);
  const sent = lastSteps(state, ID) ?? [];
  const lanes = sent.map((item) => `${item.anchor}:${item.order}`).join(',');
  check(sent.length === 4, 'PUT унёс 4 шага', sent.length);
  check(
    sent.every((item) => item.anchor === 'work'),
    'все шаги сценария — в одном ряду work, без triage',
    lanes,
  );
  const first = sent.find((item) => item.order === 0);
  check(
    first?.kind === 'resource' && first.resource?.id === 'e2e-runner',
    'новый шаг — первый по номеру',
    `${first?.id} ${first?.resource?.id ?? ''}`,
  );
  const titles = await rowTitles(list);
  check(/Прогон e2e/.test(titles[0] ?? ''), 'на экране он первой строкой', titles[0]);
  check(errors.length === 0, 'ошибок консоли нет', errors.join(' | '));
  await page.screenshot({ path: `${SHOTS}/scenario-first-step.png` });
  await close();
}

// ---------- 2. Включённый сценарий: предупреждения нет ----------
{
  const state = addScenarioGroup(makeGroupState(), { count: 3 });
  state.groups = state.groups.map((item) => (item.id === ID ? { ...item, isEnabled: true } : item));
  const { composer, errors, close } = await openPicker(state);
  check(!(await visible(composer.getByText(WARNING))), 'включённая группа: предупреждения нет');
  check(errors.length === 0, 'ошибок консоли нет', errors.join(' | '));
  await close();
}

await finish('\nСценарий: шаг в начале и выбор в выключенной группе — всё на месте.');
