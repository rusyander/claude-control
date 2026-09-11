/**
 * Кадры раздела «Скиллы»: два входа, два сценария.
 *
 * `first` — скиллов нет вообще: пустой раздел, форма, заготовка тела, первое
 * сохранение и структура файлов. Этот путь проходят один раз.
 * `living` — скиллы уже написаны: список с размерами и файлами, промах поиска,
 * выключение (папка переезжает в `skills-disabled/`) и правка готового.
 *
 * Ни одного подложенного состояния: панель пишет настоящие папки в одноразовом
 * каталоге конфигурации и перечитывает их же.
 */
import { clearSkills, setSkills } from './config-fixture.mjs';
import { openSection, closeModal } from './config-stubs.mjs';

export async function shootSkillsFirst(browser, web, scenario, home) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });

  try {
    clearSkills(home);

    // ── 01. Пустой раздел ────────────────────────────────────────────────────
    await openSection(page, web, '/skills');
    await scenario.shot(page, '01-empty');

    // ── 02. Форма: имя и описание ────────────────────────────────────────────
    // Описание — главное поле: по нему Claude решает, подключать ли скилл.
    await page
      .getByRole('button', { name: /^(Создать скилл|Create skill)$/ })
      .first()
      .click();
    await page.waitForTimeout(1200);
    await page.getByLabel(/^(Имя скилла|Skill name)$/).fill('release-checklist');
    await page
      .getByLabel(/^(Описание — когда применять|Description — when to apply)$/)
      .fill('Use КОГДА собираются выкатывать ветку и просят проверить, всё ли готово к отправке.');
    await page.waitForTimeout(600);
    await scenario.shot(page, '02-form', { clip: '[role="dialog"]', padding: 24 });

    // ── 03. Заготовка тела ───────────────────────────────────────────────────
    await page
      .getByRole('button', { name: /^(Проверка \/ чеклист|Check \/ checklist)$/ })
      .first()
      .click();
    await page.waitForTimeout(800);
    await scenario.shot(page, '03-template', { clip: '[role="dialog"]', padding: 24 });

    // ── 04. Папка создана, окно осталось ─────────────────────────────────────
    // После создания форма не закрывается: появляется дерево файлов скилла, и
    // структуру собирают, не выходя из окна.
    await page
      .getByRole('button', { name: /^(Сохранить|Save)$/ })
      .first()
      .click();
    await page.waitForTimeout(2500);
    // Окно длиннее экрана, и дерево — в самом низу: без прокрутки в кадр попала
    // бы шапка формы, которая на предыдущем шаге уже снята.
    await page
      .getByText(/^(Структура файлов|File structure)$/)
      .first()
      .scrollIntoViewIfNeeded();
    await page.waitForTimeout(800);
    await scenario.shot(page, '04-structure', { clip: '[role="dialog"]', padding: 24 });
    await closeModal(page);

    // ── 05. Скилл в списке ───────────────────────────────────────────────────
    await openSection(page, web, '/skills', 2000);
    await scenario.shot(page, '05-card');

    // ── 06. Конструктор со структурой ────────────────────────────────────────
    // Тот же скилл можно завести папкой с модулями: заготовка структуры
    // выбирается ДО создания и разворачивается сразу после него.
    await page
      .getByRole('button', { name: /^(Создать скилл|Create skill)$/ })
      .first()
      .click();
    await page.waitForTimeout(1200);
    // Подпись вкладки режима — заголовок плюс пояснение под ним, поэтому не exact.
    await page
      .getByRole('button', { name: /^(Конструктор|Builder)/ })
      .first()
      .click();
    await page.waitForTimeout(1500);
    await page
      .getByText(/^(Заготовка структуры|Structure template)$/)
      .first()
      .scrollIntoViewIfNeeded();
    await page.waitForTimeout(800);
    await scenario.shot(page, '06-builder', { clip: '[role="dialog"]', padding: 24 });
    await closeModal(page);
  } finally {
    await page.close();
  }
}

export async function shootSkillsLiving(browser, web, scenario, home) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });

  try {
    setSkills(home);

    // ── 01. Список скиллов ───────────────────────────────────────────────────
    await openSection(page, web, '/skills', 2000);
    await scenario.shot(page, '01-list');

    // ── 02. Поиск не нашёл ───────────────────────────────────────────────────
    // Промах поиска показывает запрос, а не уверяет, что скиллов нет.
    await page
      .getByRole('searchbox', { name: /^(Поиск|Search)$/ })
      .first()
      .fill('миграции');
    await page.waitForTimeout(1200);
    await scenario.shot(page, '02-search');
    await page
      .getByRole('searchbox', { name: /^(Поиск|Search)$/ })
      .first()
      .fill('');
    await page.waitForTimeout(1000);

    // ── 03. Файлы скилла ─────────────────────────────────────────────────────
    // Скилл бывает папкой с модулями — счётчик файлов раскрывается деревом.
    await page
      .getByRole('button', { name: /файл|file/i })
      .first()
      .click();
    await page.waitForTimeout(1500);
    await scenario.shot(page, '03-files');

    // ── 04. Скилл выключен ───────────────────────────────────────────────────
    // Тумблер переносит папку в `skills-disabled/`: из палитры скилл пропадает,
    // из списка — нет.
    await page.getByRole('switch', { name: 'perf-audit' }).first().click();
    await page.waitForTimeout(2500);
    await scenario.shot(page, '04-off');

    // ── 05. Правка готового скилла ───────────────────────────────────────────
    // Имя папки в форме заблокировано: переименование — отдельная кнопка,
    // которая переносит и отметки панели.
    await page
      .getByRole('button', { name: /^(Редактировать|Edit): release-notes$/ })
      .first()
      .click();
    await page.waitForTimeout(2000);
    await page
      .getByText(/^(Структура файлов|File structure)$/)
      .first()
      .scrollIntoViewIfNeeded();
    await page.waitForTimeout(800);
    await scenario.shot(page, '05-edit', { clip: '[role="dialog"]', padding: 24 });
    await closeModal(page);
  } finally {
    await page.close();
  }
}
