/**
 * Сценарии раздела «Права доступа»: `permissions/setup` и `permissions/audit`.
 *
 * Делятся по входу. В первый приходят с чистой машины и спрашивают «что он
 * вообще может и как это закрыть»; во второй — когда прав уже два десятка и
 * вопрос другой: «почему это правило не работает и где оно лежит».
 *
 * Ни одно состояние не подкладывается мимо панели там, где его можно сделать
 * руками: права сценария `setup` заводятся через настоящую форму и настоящий
 * пакетный ввод, и после каждого шага они действительно лежат в `settings.json`
 * одноразового стенда. Подложены только исходные права сценария `audit` — это
 * его условие задачи, а не его путь.
 */
import {
  AUDIT_PERMISSIONS,
  closeModal,
  openSection,
  writeSettings,
  writeSettingsLocal,
} from './access-fixture.mjs';

/**
 * Заготовки на вкладке «Системные» идут подряд, категориями, в порядке
 * `PERMISSION_PRESETS`. Кнопка «Настроить» — одна на карточку, поэтому шаг
 * адресуется номером; чтобы номер не разъехался с контрактом молча, после
 * открытия формы сверяем, какой шаблон в неё подставился.
 */
const PRESET_INDEX = { 'Bash(git push:*)': 8 };

async function configurePreset(page, pattern) {
  await page
    .getByRole('button', { name: /^(Настроить|Configure)$/ })
    .nth(PRESET_INDEX[pattern])
    .click();
  await page.waitForTimeout(1200);
  const filled = await page.getByLabel(/^(Правило|Rule)$/).inputValue();
  if (filled !== pattern) {
    throw new Error(`заготовка разъехалась: ждали ${pattern}, форма открылась с «${filled}»`);
  }
}

/** Пакетный ввод: одно решение на весь список. Возвращается уже закрытым. */
async function bulkCreate(page, decision, lines) {
  await page
    .getByRole('button', { name: /^(Добавить правило|Add rule)$/ })
    .first()
    .click();
  await page.waitForTimeout(900);
  await page
    .getByRole('button', { name: /^(Несколько сразу|Several at once)$/ })
    .first()
    .click();
  await page.waitForTimeout(600);
  await page.getByRole('button', { name: decision }).first().click();
  await page.locator('[role="dialog"] textarea').first().fill(lines.join('\n'));
  await page.waitForTimeout(800);
  return async () => {
    await page
      .getByRole('button', { name: /^(Создать все|Create all)/ })
      .first()
      .click();
    await page.waitForTimeout(2000);
    await closeModal(page);
  };
}

export async function shootSetup(browser, web, scenario) {
  // Высокое окно: вкладка «Системные» — это список карточек, и обрезать его на
  // третьей значило бы показать не список, а его начало.
  const page = await browser.newPage({ viewport: { width: 1400, height: 1500 } });

  try {
    // Чистая машина: ни одного правила. Ровно то состояние, в котором раздел
    // показывает «Не задано» у всех тринадцати заготовок.
    writeSettings({});
    writeSettingsLocal(undefined);

    // ── 01. Что он вообще делает с компьютером ───────────────────────────────
    await openSection(page, web, '/permissions');
    await scenario.shot(page, '01-system-empty');

    // ── 02. Форма, открытая заготовкой ───────────────────────────────────────
    await configurePreset(page, 'Bash(git push:*)');
    // Категория заготовок своя от формы: открывшись, она всегда показывает файлы,
    // а речь в кадре о git — рядом с полем должны стоять его же заготовки.
    await page.locator('[role="dialog"]').getByRole('button', { name: 'Git', exact: true }).click();
    await page
      .getByRole('button', { name: /^(Запрещено|Denied)$/ })
      .first()
      .click();
    await page.waitForTimeout(500);
    await scenario.shot(page, '02-form-preset', { clip: '[role="dialog"]', padding: 24 });

    // ── 03. Правило, записанное словами ──────────────────────────────────────
    // Панель не отказывает — она предупреждает: проверить, инструмент это или
    // опечатка, может только Claude Code, когда дойдёт до вызова.
    await page.getByLabel(/^(Правило|Rule)$/).fill('запретить git push');
    await page.waitForTimeout(600);
    await scenario.shot(page, '03-form-warning', { clip: '[role="dialog"]', padding: 24 });

    await page.getByLabel(/^(Правило|Rule)$/).fill('Bash(git push:*)');
    await page.waitForTimeout(400);
    await page
      .getByRole('button', { name: /^(Сохранить|Save)$/ })
      .first()
      .click();
    await page.waitForTimeout(2000);

    // ── 04. Список сразу ─────────────────────────────────────────────────────
    const createAllowed = await bulkCreate(page, /^(Разрешено|Allowed)$/, [
      'Read',
      'Edit',
      'Bash(npm run:*)',
      'Bash(git status:*)',
      'WebSearch',
      'Skill',
    ]);
    await scenario.shot(page, '04-bulk', { clip: '[role="dialog"]', padding: 24 });
    await createAllowed();

    // Остальные два решения — тем же пакетным вводом, но без кадра: он был бы
    // тем же окном с другими строками.
    await (
      await bulkCreate(page, /^(Спрашивать|Ask)$/, ['Write', 'Bash(git commit:*)', 'WebFetch'])
    )();
    await (
      await bulkCreate(page, /^(Запрещено|Denied)$/, ['Bash(rm:*)'])
    )();

    // ── 05. Настроенный компьютер ────────────────────────────────────────────
    await openSection(page, web, '/permissions');
    await scenario.shot(page, '05-system-configured');

    // ── 06. Правило, которое не подействует ──────────────────────────────────
    await page
      .getByRole('button', { name: /^(Добавить правило|Add rule)$/ })
      .first()
      .click();
    await page.waitForTimeout(900);
    await page.getByLabel(/^(Правило|Rule)$/).fill('Bash(git push:*)');
    await page
      .getByRole('button', { name: /^(Спрашивать|Ask)$/ })
      .first()
      .click();
    await page.waitForTimeout(700);
    await scenario.shot(page, '06-form-shadowed', { clip: '[role="dialog"]', padding: 24 });

    // ── 07. Как перекрытие выглядит в списке ─────────────────────────────────
    await page
      .getByRole('button', { name: /^(Сохранить|Save)$/ })
      .first()
      .click();
    await page.waitForTimeout(2000);
    await openSection(page, web, '/permissions');
    await scenario.shot(page, '07-system-shadowed');
  } finally {
    await page.close();
  }
}

export async function shootAudit(browser, web, scenario) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1100 } });

  try {
    // Условие задачи сценария: права уже есть, и часть из них — в личном файле,
    // который панель читает наравне с общим, но не правит.
    writeSettings({ permissions: AUDIT_PERMISSIONS });
    writeSettingsLocal({
      permissions: { deny: ['Bash(curl:*)'], ask: ['Bash(docker:*)'] },
    });

    // ── 01. Все правила разом ────────────────────────────────────────────────
    await openSection(page, web, '/permissions');
    await page
      .getByRole('button', { name: /^(Все правила|All rules)$/ })
      .first()
      .click();
    await page.waitForTimeout(1200);
    await scenario.shot(page, '01-all-rules');

    // ── 02. Поиск по шаблону ─────────────────────────────────────────────────
    await page
      .getByLabel(/^(Поиск|Search)$/)
      .first()
      .fill('git');
    await page.waitForTimeout(900);
    await scenario.shot(page, '02-search');

    // ── 03. Правила из личного файла ─────────────────────────────────────────
    await page
      .getByLabel(/^(Поиск|Search)$/)
      .first()
      .fill('Bash(');
    await page.waitForTimeout(900);
    await scenario.shot(page, '03-local');

    // ── 04. Выключенное правило ──────────────────────────────────────────────
    // Выключение — это удаление строки из settings.json: иначе Claude Code
    // продолжал бы её применять. Строка остаётся в списке, потому что панель
    // помнит её у себя и умеет вернуть.
    await page
      .getByLabel(/^(Поиск|Search)$/)
      .first()
      .fill('commit');
    await page.waitForTimeout(800);
    await page
      .getByLabel(/^(Спрашивать|Ask): Bash\(git commit:\*\)$/)
      .first()
      .click();
    await page.waitForTimeout(2000);
    await scenario.shot(page, '04-disabled');

    // ── 05. Только правила серверов ──────────────────────────────────────────
    await page
      .getByLabel(/^(Поиск|Search)$/)
      .first()
      .fill('');
    await page
      .getByRole('button', { name: /^(MCP-серверы|MCP servers)$/ })
      .first()
      .click();
    await page.waitForTimeout(1200);
    await scenario.shot(page, '05-mcp-tab');

    // ── 06. Что значит «удалить» ─────────────────────────────────────────────
    await page
      .getByLabel(/^(Удалить|Delete): mcp__orders__refund_order$/)
      .first()
      .click();
    await page.waitForTimeout(1000);
    await scenario.shot(page, '06-delete', { clip: '[role="dialog"]', padding: 24 });
    await closeModal(page);
  } finally {
    await page.close();
  }
}
