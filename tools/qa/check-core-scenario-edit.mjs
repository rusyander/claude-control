/**
 * Правка сценария идущей задачи `/core/scenarios?tab=task&id=<задача>` (этап 9, зона C) —
 * настоящая дорога: одноразовая панель + своё ядро, браузер через прокладку панели, ответы не
 * перехватываются.
 *
 * Что проверяется:
 * 1. Задача засеяна оценкой прямо в ядро (пресет `feature`, грант не подтверждён — задача живая
 *    и ждёт человека); вкладка правки показывает действующую версию `feature@1`, черновик —
 *    своим id `feature-own@1`.
 * 2. Правка шага и «Отправить правку» — команда `edit-scenario` через прокладку: ядро приняло
 *    `feature@1 → feature-own@1`, записало версию с правкой и основой-пресетом, свёртка задачи
 *    ждёт её применения; ответ ядра остаётся на экране, когда действующая версия сменилась.
 *
 * Звено панели не подтверждено ядру (P131) — ядро отказывает правке словами `signature-required`
 * (пир «untrusted-forward»/«unknown»): тогда принятую правку не проверить, выход 2 «не проверено»
 * с причиной ядра; любой другой отказ — провал. Запуск: `node tools/qa/check-core-scenario-edit.mjs`;
 * `SHOTS=<папка>` — кадры в обеих темах.
 */
import { chromium } from 'playwright';
import {
  DIRECT,
  coreDirect,
  routeStrictToCore,
  shoot,
  standOptions,
  uuidv7,
} from './core-scenario-stand.mjs';
import { NotChecked, runOnStand } from './throwaway-stand.mjs';

const holder = {};

await runOnStand(standOptions('core-scenario-edit', holder), async (stand, check) => {
  const core = coreDirect(stand);
  const estimate = await core.direct('POST', '/v1/estimate', {
    cmdId: uuidv7(),
    fields: {
      title: 'Проверка правки сценария',
      request: 'Сделать правку в a.txt',
      repos: [{ path: holder.repo, baseRef: null }],
      scenario: { preset: 'feature' },
      launchPolicy: 'confirm',
      ciWait: false,
    },
    proof: await core.proof(),
  });
  const taskId = estimate.body?.taskId;
  check(
    'засев: оценка создала задачу со сценарием feature@1',
    (estimate.status === 202 || estimate.status === 200) &&
      typeof taskId === 'string' &&
      estimate.body?.scenario?.id === 'feature',
    `${estimate.status} ${estimate.text.slice(0, 400)}`,
  );
  let live = false;
  for (let i = 0; i < 40 && !live; i += 1) {
    const task = await stand.api(`/core/tasks/${taskId}`);
    live = task.body?.live === true && Boolean(task.body?.task?.scenario);
    if (!live) await new Promise((done) => setTimeout(done, 500));
  }
  check('задача живая и со сценарием', live, taskId);

  const browser = await chromium.launch();
  try {
    const page = await stand.newPage(browser, { width: 1440, height: 2400 });
    await routeStrictToCore(page, stand);
    await page.goto(`${stand.webUrl}/core/scenarios?tab=task&id=${taskId}`);
    await page.locator('[data-task-scenario="feature@1"]').waitFor({ timeout: 30_000 });
    const version = page.locator('[data-scenario-version]');
    await version.waitFor({ timeout: 20_000 });
    check(
      'основа — действующая версия задачи, черновик своим id следующей версией',
      (await version.getAttribute('data-scenario-version')) === 'feature-own@1',
      await version.getAttribute('data-scenario-version'),
    );
    await page.getByLabel('Название шага').fill('План, поправленный человеком');
    await shoot(page, 'core-scenarios-task');

    await page.getByRole('button', { name: 'Отправить правку' }).click();
    await page
      .locator('[data-task-edit-applied], [data-scenario-refusal]')
      .first()
      .waitFor({ timeout: 30_000 });
    const refusal = page.locator('[data-scenario-refusal]');
    if ((await refusal.count()) > 0) {
      const code = await refusal.getAttribute('data-scenario-refusal');
      const note = await refusal.innerText();
      const hopUntrusted =
        code === 'signature-required' && /peer (untrusted-forward|unknown)/.test(note);
      check(
        'отказ ядра — только неподтверждённое звено (и не в обходе шва), файла правки нет',
        hopUntrusted && !DIRECT && !core.files().includes('feature-own@1.json'),
        `${code} ${note}`,
      );
      await shoot(page, 'core-scenarios-task-refused');
      // В обходе шва отказа звена быть не может: строка выше уже провалена, вердикт — провал.
      if (hopUntrusted && !DIRECT) {
        // Правка не принята — проверить нечего дальше; причина ядра уходит в «не проверено».
        throw new NotChecked(
          `принятая правка не проверена: звено панели не подтверждено ядру (P131) — ${note.split('\n').at(-1)}`,
        );
      }
      return;
    }
    const to = await page
      .locator('[data-task-edit-applied]')
      .getAttribute('data-task-edit-applied');
    check('правка принята: feature@1 → feature-own@1', to === 'feature-own@1', to);
    const saved = core.files().includes('feature-own@1.json')
      ? core.read('feature-own@1.json')
      : undefined;
    check(
      'ядро записало версию с правкой и основой-пресетом',
      saved?.steps?.[0]?.title === 'План, поправленный человеком' &&
        saved?.presetOf?.id === 'feature',
      core.files().join(','),
    );
    const folded = await stand.api(`/core/tasks/${taskId}`);
    const pending = folded.body?.task?.scenario?.pending?.to;
    check(
      'свёртка задачи ждёт применения новой версии',
      pending?.id === 'feature-own' && pending?.version === 1,
      JSON.stringify(folded.body?.task?.scenario),
    );
    await page.locator('[data-task-scenario="feature-own@1"]').waitFor({ timeout: 20_000 });
    check(
      'действующая — ожидающая версия, ответ ядра остался на экране',
      (await page.locator('[data-task-edit-applied]').count()) === 1,
      await page.locator('[data-task-edit]').innerText(),
    );
    await shoot(page, 'core-scenarios-task-applied');
    check('страница без ошибок', page.errors.length === 0, page.errors.join('\n'));
  } finally {
    await browser.close();
  }
});
