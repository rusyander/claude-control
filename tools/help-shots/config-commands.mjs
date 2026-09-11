/**
 * Кадры раздела «Команды»: два входа, два сценария.
 *
 * `find` — человек ищет команду и не помнит, как она называется: общий список,
 * поиск, фильтры по источнику, встроенные с их синонимами.
 * `sources` — команда пропала из палитры, и надо понять почему: выключенный
 * скилл, файл команды с его путём и реестр плагинов, который CLI не читает.
 *
 * Подмен нет ни одного: список собирается сервером из настоящих папок
 * одноразового каталога — `skills/`, `commands/`, `plugins/`. Встроенные ведёт
 * сам клиент панели.
 */
import { setPluginRegistryVersion, setSkills } from './config-fixture.mjs';
import { openSection } from './config-stubs.mjs';

/** Кнопка фильтра подписана вместе со счётчиком — ищем по началу подписи. */
const FILTER_EN = {
  Встроенные: 'Built-in',
  Плагины: 'Plugins',
  Скиллы: 'Skills',
  'Файлы команд': 'Command files',
};
const filter = (page, name) =>
  page.getByRole('button', { name: new RegExp(`^(${name}|${FILTER_EN[name]}) · `) });

export async function shootCommandsFind(browser, web, scenario, home) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

  try {
    // Предыдущий сценарий выключал скилл — возвращаем набор к исходному виду.
    setSkills(home);

    // ── 01. Весь список ──────────────────────────────────────────────────────
    await openSection(page, web, '/commands', 2500);
    await scenario.shot(page, '01-list');

    // ── 02. Поиск ────────────────────────────────────────────────────────────
    // Ищет и по имени, и по описанию, и по владельцу: по одному имени команды
    // часто не понять, что она делает.
    await page
      .getByRole('searchbox', { name: /^(Поиск|Search)$/ })
      .first()
      .fill('релиз');
    await page.waitForTimeout(1200);
    await scenario.shot(page, '02-search');
    await page
      .getByRole('searchbox', { name: /^(Поиск|Search)$/ })
      .first()
      .fill('');
    await page.waitForTimeout(1000);

    // ── 03. Только встроенные ────────────────────────────────────────────────
    // Их каталог ведёт панель: CLI списка своих команд наружу не отдаёт.
    await filter(page, 'Встроенные').first().click();
    await page.waitForTimeout(1200);
    await scenario.shot(page, '03-builtin');

    // ── 04. Только плагины ───────────────────────────────────────────────────
    await filter(page, 'Плагины').first().click();
    await page.waitForTimeout(1200);
    await scenario.shot(page, '04-plugin');
  } finally {
    await page.close();
  }
}

export async function shootCommandsSources(browser, web, scenario, home) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

  try {
    // ── 01. Скиллы ───────────────────────────────────────────────────────────
    // Выключенный скилл из палитры пропал, а из списка — нет: именно это и
    // нужно увидеть человеку, который ищет пропавшую команду.
    await openSection(page, web, '/commands', 2500);
    await filter(page, 'Скиллы').first().click();
    await page.waitForTimeout(1200);
    await scenario.shot(page, '01-skill');

    // ── 02. Файлы команд ─────────────────────────────────────────────────────
    // Вложенная папка становится префиксом вызова, а путь файла виден строкой.
    await filter(page, 'Файлы команд').first().click();
    await page.waitForTimeout(1200);
    await scenario.shot(page, '02-files');

    // ── 03. Реестр плагинов чужой версии ─────────────────────────────────────
    // CLI читает только версию 2. Панель обязана видеть ровно то же, поэтому
    // команды таких плагинов из списка уходят — с объяснением строкой.
    setPluginRegistryVersion(home, 3);
    await openSection(page, web, '/commands', 2500);
    await scenario.shot(page, '03-registry');
  } finally {
    setPluginRegistryVersion(home, 2);
    await page.close();
  }
}
