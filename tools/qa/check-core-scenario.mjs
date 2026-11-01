/**
 * Библиотека и редактор сценариев ядра `/core/scenarios` (этап 9, зона C) — настоящая дорога:
 * одноразовая панель + своё ядро (`startStand({ core: true })`), запросы браузера идут через
 * прокладку панели к живому ядру, ответы не перехватываются.
 *
 * Что проверяется:
 * 1. Запись однократна по HTTP ядра (засев напрямую с токеном ядра): 201 → тот же текст 200 →
 *    другой текст под той же версией 409 `version-taken` с `next: 2`; файл версии один и байт в
 *    байт первый.
 * 2. Библиотека через панель: пресеты ядра и засеянная версия; чтение по ссылке `id@v` — шаги
 *    по порядку, ссылка в адресе.
 * 3. «Создать на основе» пресета: свой id `<пресет>-own@1`; перенос шага с клавиатуры (Пробел,
 *    стрелка, Пробел) меняет порядок; черновик годен по схеме контрактов.
 * 4. Запись из браузера — строгое действие `save-scenario`. Пока звено панели не подтверждено
 *    ядру (P131), ядро отказывает `signature-required`: карточка говорит это словами, файла нет.
 *    Звено подтверждено — версия записана: файл с черновиком, строка «Сохранено». Ветка, по
 *    которой пошёл прогон, названа в строке проверки.
 * 5. С нуля: пустой id назван до запроса, кнопка записи выключена.
 *
 * Правка сценария идущей задачи — `check-core-scenario-edit.mjs`. Модели — заглушки
 * `packages/stub-model` (стенд), CLI — подставной. Запуск: `node tools/qa/check-core-scenario.mjs`;
 * `SHOTS=<папка>` — кадры в обеих темах. Код выхода: 0 — сходится, 1 — провал, 2 — стенд не поднялся.
 */
import { chromium } from 'playwright';
import {
  QA_FLOW,
  coreDirect,
  routeStrictToCore,
  shoot,
  standOptions,
} from './core-scenario-stand.mjs';
import { runOnStand } from './throwaway-stand.mjs';

await runOnStand(standOptions('core-scenario', {}), async (stand, check) => {
  const core = coreDirect(stand);

  // 1. Однократная запись по HTTP ядра.
  const first = await core.save(QA_FLOW);
  check(
    'ядро: новая версия — 201 со ссылкой',
    first.status === 201 && first.body?.ref?.id === 'qa-flow' && first.body.ref.version === 1,
    `${first.status} ${first.text}`,
  );
  const written = JSON.stringify(core.read('qa-flow@1.json'));
  const again = await core.save(QA_FLOW);
  check(
    'ядро: тот же текст той же версии — 200',
    again.status === 200,
    `${again.status} ${again.text}`,
  );
  const overwrite = await core.save({ ...QA_FLOW, title: 'Другой текст' });
  check(
    'ядро: другой текст под той же версией — 409 version-taken, следующая 2',
    overwrite.status === 409 &&
      overwrite.body?.code === 'version-taken' &&
      overwrite.body?.next === 2,
    `${overwrite.status} ${overwrite.text}`,
  );
  check(
    'файл версии один и прежний',
    core.files().join(',') === 'qa-flow@1.json' &&
      JSON.stringify(core.read('qa-flow@1.json')) === written,
    core.files().join(','),
  );

  // 2. Библиотека через панель.
  const listed = await stand.api('/core/scenarios');
  check(
    'панель: список — пресеты ядра и засеянная версия',
    listed.status === 200 &&
      listed.body.presets.some((s) => s.id === 'feature') &&
      listed.body.library.map((s) => `${s.id}@${s.version}`).join(',') === 'qa-flow@1',
    `${listed.status} ${listed.text.slice(0, 300)}`,
  );

  const browser = await chromium.launch();
  try {
    const page = await stand.newPage(browser, { width: 1440, height: 2400 });
    await routeStrictToCore(page, stand);
    await page.goto(`${stand.webUrl}/core/scenarios?tab=library`);
    await page.locator('[data-scenario-item="qa-flow@1"]').waitFor({ timeout: 30_000 });
    const items = await page.locator('[data-scenario-item]').count();
    check(
      'библиотека: пресеты и своя версия в списке',
      items === listed.body.presets.length + 1,
      `${items}`,
    );
    await page.locator('[data-scenario-item="qa-flow@1"]').click();
    const view = page.locator('[data-scenario-view="qa-flow@1"]');
    await view.waitFor({ timeout: 20_000 });
    const viewSteps = await view
      .locator('[data-step-id]')
      .evaluateAll((els) => els.map((el) => el.getAttribute('data-step-id')));
    check(
      'чтение: шаги сценария по порядку, ссылка в адресе',
      viewSteps.join(',') === 'plan,work' && page.url().includes('id=qa-flow%401'),
      `${viewSteps.join(',')} ${page.url()}`,
    );
    await page.locator('[data-scenario-item="feature@1"]').click();
    await page.locator('[data-scenario-view="feature@1"]').waitFor({ timeout: 20_000 });
    await shoot(page, 'core-scenarios-library');

    // 3. Новый сценарий на основе пресета.
    await page.getByRole('button', { name: 'Создать на основе' }).click();
    const version = page.locator('[data-scenario-version]');
    await version.waitFor({ timeout: 20_000 });
    check(
      'основа-пресет: свой id и версия 1',
      (await version.getAttribute('data-scenario-version')) === 'feature-own@1',
      await version.getAttribute('data-scenario-version'),
    );
    const rowIds = () =>
      page
        .locator('[data-scenario-editor] [data-step-row]')
        .evaluateAll((els) => els.map((el) => el.getAttribute('data-step-row')));
    const before = await rowIds();
    await page.locator('[data-scenario-editor] [data-drag-handle]').first().focus();
    await page.keyboard.press('Space');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Space');
    await page.waitForTimeout(300);
    const after = await rowIds();
    check(
      'перенос с клавиатуры: первый шаг встал вторым',
      before.length > 2 && after[0] === before[1] && after[1] === before[0],
      `${before.join(',')} → ${after.join(',')}`,
    );
    const problems = page.locator('[data-draft-problems]');
    check(
      'черновик годен — суд схемы молчит',
      (await problems.getAttribute('data-draft-problems')) === '0',
      await problems.innerText(),
    );
    await shoot(page, 'core-scenarios-new');

    // 4. Запись через прокладку — строгое действие.
    const saveButton = page.getByRole('button', { name: 'Сохранить в библиотеку' });
    await saveButton.click();
    await page
      .locator('[data-scenario-refusal], [data-scenario-saved]')
      .first()
      .waitFor({ timeout: 30_000 });
    const refusal = page.locator('[data-scenario-refusal]');
    if ((await refusal.count()) > 0) {
      const code = await refusal.getAttribute('data-scenario-refusal');
      const note = await refusal.innerText();
      check(
        'запись через прокладку (звено не подтверждено): отказ signature-required словами',
        code === 'signature-required' && note.includes('звено панели ещё не подтверждено'),
        `${code} ${note}`,
      );
      check(
        'отказ не оставил файла в библиотеке',
        !core.files().includes('feature-own@1.json'),
        core.files().join(','),
      );
      await shoot(page, 'core-scenarios-refused');
    } else {
      const saved = await page.locator('[data-scenario-saved]').getAttribute('data-scenario-saved');
      const file = core.files().includes('feature-own@1.json')
        ? core.read('feature-own@1.json')
        : undefined;
      check(
        'запись через прокладку (звено подтверждено): версия записана файлом черновика',
        saved === 'feature-own@1' &&
          file?.presetOf?.id === 'feature' &&
          file.steps[0]?.id === after[0],
        `${saved} ${core.files().join(',')}`,
      );
      await shoot(page, 'core-scenarios-saved');
    }

    // 5. Пустой id называется до запроса, кнопка записи выключена.
    await page.goto(`${stand.webUrl}/core/scenarios?tab=new`);
    await page.locator('[data-scenario-editor]').waitFor({ timeout: 20_000 });
    const count = Number(await problems.getAttribute('data-draft-problems'));
    check(
      'с нуля: пустой id назван, запись выключена',
      count > 0 && (await saveButton.isDisabled()),
      `${count} ${await problems.innerText()}`,
    );
    check('страница без ошибок', page.errors.length === 0, page.errors.join('\n'));
  } finally {
    await browser.close();
  }
});
