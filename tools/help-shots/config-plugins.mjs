/**
 * Кадры раздела «Плагины»: два входа, два сценария.
 *
 * `install` — плагин ставят готовым: что уже стоит, каталог маркетплейсов,
 * установка по идентификатору с выводом команды и отключение источника.
 * `own` — плагин пишут свой: каркас по формату Claude Code в выбранной папке.
 *
 * Единственная подмена во всей пачке — здесь: раздел спрашивает установленный
 * `claude` (`plugin list --json`, `--available`), то есть кадр зависел бы от
 * плагинов на машине съёмки и от похода в сеть за репозиториями. Подменён
 * ОТВЕТ CLI; разметка, счётчики и диалоги настоящие. Обзор диска для выбора
 * папки подменён по той же причине — он показал бы чужие каталоги.
 */
import { PLUGINS_DIR } from './config-fixture.mjs';
import { openSection, closeModal, plugins, install, folderPicker } from './config-stubs.mjs';

export async function shootPluginsInstall(browser, web, scenario) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

  try {
    await plugins(page);

    // ── 01. Что установлено ──────────────────────────────────────────────────
    // Выключенный плагин показан выключенным, а пропавший каталог назван
    // пометкой: CLI перечисляет такой плагин как установленный, и без пометки
    // он выглядел бы рабочим.
    await openSection(page, web, '/plugins', 2500);
    await scenario.shot(page, '01-installed');

    // ── 02. Каталог маркетплейсов ────────────────────────────────────────────
    // Загружается по запросу: за ним CLI обновляет репозитории и ходит в сеть.
    await page
      .getByRole('button', { name: /^(Показать каталог|Show catalogue)$/ })
      .first()
      .click();
    await page.waitForTimeout(2000);
    // Поиск идёт и по имени маркетплейса: «чей это плагин» — такой же вопрос,
    // как «что он делает».
    await page
      .getByRole('searchbox', { name: /^(Поиск по каталогу|Search the catalogue)$/ })
      .first()
      .fill('lab');
    await page.waitForTimeout(1200);
    await scenario.shot(page, '02-catalog');

    // ── 03. Установка по идентификатору ──────────────────────────────────────
    // Вывод команды показан как есть: это единственный источник правды о том,
    // что пошло не так.
    await install(page, {
      ok: false,
      needsRestart: false,
      output:
        'Error: plugin "code-review@lab-kit" not found in marketplace "lab-kit".\n' +
        'Known plugins: docs-kit, commit-commands, playwright-runner, notes-sync.',
    });
    await page
      .getByText(/^(Установить плагин|Install a plugin)$/)
      .first()
      .click();
    await page.waitForTimeout(800);
    await page
      .getByLabel(/^(Идентификатор плагина|Plugin identifier)$/)
      .fill('code-review@lab-kit');
    await page
      .getByRole('button', { name: /^(Установить|Install)$/ })
      .first()
      .click();
    await page.waitForTimeout(2000);
    await scenario.shot(page, '03-install');

    // ── 04. Отключение источника ─────────────────────────────────────────────
    // Вместе с маркетплейсом Claude Code убирает и его плагины — диалог
    // перечисляет поимённо, что пропадёт.
    await page
      .getByRole('button', { name: /^(Удалить|Delete): team-tools$/ })
      .first()
      .click();
    await page.waitForTimeout(1500);
    await scenario.shot(page, '04-marketplace', { clip: '[role="dialog"]', padding: 24 });
    await closeModal(page);
  } finally {
    await page.close();
  }
}

export async function shootPluginsOwn(browser, web, scenario) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

  try {
    await plugins(page, {
      notes: ['Список плагинов не получен: claude not found (PATH процесса панели).'],
      installed: [],
    });

    // ── 01. CLI не ответил ───────────────────────────────────────────────────
    // Причина названа строкой. Молчаливый ноль читался бы как «плагинов нет» и
    // отправил бы человека искать пропавшие команды.
    await openSection(page, web, '/plugins', 2500);
    await scenario.shot(page, '01-no-cli');

    await plugins(page);
    await folderPicker(page, PLUGINS_DIR);
    await openSection(page, web, '/plugins', 2500);

    // ── 02. Каркас плагина ───────────────────────────────────────────────────
    // Манифест и README пишутся всегда, остальные части — по выбору: пустые
    // папки только мешают.
    await page
      .getByText(/^(Создать плагин|Create a plugin)$/, { exact: true })
      .first()
      .click();
    await page.waitForTimeout(800);
    await page.getByLabel(/^(Имя плагина|Plugin name)$/).fill('release-kit');
    await page.getByLabel(/^(Описание|Description)$/).fill('Команды и скиллы вокруг выкатки ветки');
    await page.getByLabel(/^(Автор|Author)$/).fill('команда панели');
    await page
      .getByRole('button', { name: /^(Выбрать папку|Choose folder)$/ })
      .first()
      .click();
    await page.waitForTimeout(1200);
    await page.getByRole('button', { name: 'work', exact: true }).first().click();
    await page.waitForTimeout(1200);
    await page.getByRole('button', { name: 'claude-help-plugins' }).first().click();
    await page.waitForTimeout(1200);
    await page
      .getByRole('button', { name: /^(Открыть эту папку|Open this folder)$/ })
      .first()
      .click();
    await page.waitForTimeout(1200);
    await page
      .getByRole('switch', { name: /^(Скиллы \(skills\/\)|Skills \(skills\/\))$/ })
      .first()
      .click();
    await page.waitForTimeout(600);
    await scenario.shot(page, '02-scaffold');

    // ── 03. Что создано на диске ─────────────────────────────────────────────
    // Сервер отвечает путём и списком файлов — их и показывает карточка.
    // По-русски подпись у раскрывающего заголовка и у кнопки одна — берём
    // последнюю; по-английски они расходятся («Create a plugin» / «Create
    // plugin»), и регулярка находит только кнопку.
    await page
      .getByRole('button', { name: /^(Создать плагин|Create plugin)$/, exact: true })
      .last()
      .click();
    await page.waitForTimeout(2500);
    await scenario.shot(page, '03-created');
  } finally {
    await page.close();
  }
}
