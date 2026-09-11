/**
 * Сценарий `rules/first`: человек пишет первое правило.
 *
 * Путь от пустого раздела до правила, проверенного разговором. Каждый шаг
 * человек делает сам, и каждый оставляет след в настоящем файле: форма
 * сохраняет — панель переписывает `CLAUDE.md` во временном каталоге, список
 * перечитывает его же. Ни одного подложенного состояния здесь нет.
 */
import { setClaudeMd } from './rules-fixture.mjs';
import { openSection, assistant, sandbox, closeModal } from './rules-stubs.mjs';

/** Что «ответит» помощник: готовое правило про язык общения. */
const ASSIST = {
  reply:
    'Собрал правило про язык. Формулировка проверяемая: язык ответа видно сразу, ' +
    'спорить не о чем.',
  fields: {
    title: 'Язык общения',
    body:
      'Отвечать по-русски: и текстом, и в вариантах выбора.\n\n' +
      'Имена файлов, команды и названия функций оставлять как есть — переводить их вредно.',
  },
};

/** Что «ответит» песочница на проверочный запрос. */
const SANDBOX_ANSWER =
  'Здравствуйте! Отвечаю по-русски, как требует правило «Язык общения». ' +
  'Чем помочь с проектом?';

export async function shootFirst(browser, web, scenario, home) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  try {
    // Пустой файл — то состояние, с которого начинают все: раздел показывает
    // обычную заглушку «Правил пока нет» и объясняет формат заголовка.
    setClaudeMd(home, '');
    await assistant(page, ASSIST);
    await sandbox(page, SANDBOX_ANSWER);

    // ── 01. Пустой раздел ────────────────────────────────────────────────────
    await openSection(page, web, '/rules');
    await scenario.shot(page, '01-empty');

    // ── 02. Форма: простой текст ─────────────────────────────────────────────
    await page
      .getByRole('button', { name: /^(Добавить правило|Add rule)$/ })
      .first()
      .click();
    await page.waitForTimeout(1200);
    await page.getByLabel(/^(Заголовок|Title)$/).fill('Бэкенд только на чтение');
    await page
      .getByLabel(/^(Текст правила|Rule text)$/)
      .fill(
        'Читать код сервера можно всегда. Править — только после явного разрешения\n' +
          'на эту задачу; разрешение не переносится на следующую.\n\n' +
          'Нашли ошибку в сервере — сообщите и спросите, чинить ли её сейчас.',
      );
    await page.waitForTimeout(600);
    await scenario.shot(page, '02-form', { clip: '[role="dialog"]', padding: 24 });

    // ── 03. Конструктор ──────────────────────────────────────────────────────
    // Тот же результат другим вводом: панель собирает markdown из блоков.
    await page
      .getByRole('button', { name: /^(Конструктор|Builder)$/ })
      .first()
      .click();
    await page.waitForTimeout(800);
    const items = page.getByPlaceholder(/^(Один пункт правила|One rule item)$/);
    await items.nth(0).fill('Читать любой код и любые логи');
    await items.nth(1).fill('Править сервер, миграции и схему базы без разрешения');
    await page.waitForTimeout(600);
    await scenario.shot(page, '03-builder', { clip: '[role="dialog"]', padding: 24 });

    // ── 04. Помощник заполнил поля ───────────────────────────────────────────
    await page
      .getByRole('button', { name: /^(Простой|Simple)$/ })
      .first()
      .click();
    await page.waitForTimeout(600);
    await page
      .getByPlaceholder(/^(Что нужно сделать\?|What should be done\?)$/)
      .first()
      .fill('всегда отвечай по-русски, включая варианты выбора');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(2500);
    await scenario.shot(page, '04-assistant', { clip: '[role="dialog"]', padding: 24 });

    // ── 05. Правило в списке ─────────────────────────────────────────────────
    await page
      .getByRole('button', { name: /^(Сохранить|Save)$/ })
      .first()
      .click();
    await page.waitForTimeout(2500);
    await scenario.shot(page, '05-card');

    // ── 06. Несколько сразу ──────────────────────────────────────────────────
    await page
      .getByRole('button', { name: /^(Добавить правило|Add rule)$/ })
      .first()
      .click();
    await page.waitForTimeout(1000);
    await page
      .getByRole('button', { name: /^(Несколько сразу|Several at once)$/ })
      .first()
      .click();
    await page.waitForTimeout(800);
    await page
      .locator('[role="dialog"] textarea')
      .first()
      .fill(
        'Проверять запуском :: «Готово» значит «запущено»: тесты, сборка, живой прогон.\n' +
          'Коммиты только по просьбе :: Никаких commit, push и веток по своей инициативе.',
      );
    await page.waitForTimeout(1000);
    await scenario.shot(page, '06-bulk', { clip: '[role="dialog"]', padding: 24 });
    await closeModal(page);

    // ── 07. Проверка в песочнице ─────────────────────────────────────────────
    await openSection(page, web, '/rules');
    await page
      .getByRole('button', { name: /^(Песочница|Sandbox): / })
      .first()
      .click();
    await page.waitForTimeout(3000);
    await page.getByLabel(/^(Запрос|Prompt)$/).fill('Привет! Расскажи, чем ты можешь помочь.');
    await page
      .getByRole('button', { name: /^(Отправить в песочницу|Send to the sandbox)$/ })
      .first()
      .click();
    await page.waitForTimeout(2500);
    await scenario.shot(page, '07-sandbox', { clip: '[role="dialog"]', padding: 24 });
    await closeModal(page);
  } finally {
    await page.close();
  }
}
