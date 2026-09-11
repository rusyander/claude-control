/**
 * Сценарий `groups/bundle`: набор под задачу, который включают руками.
 *
 * Вход сюда — «у меня десяток правил и скиллов, и половина нужна только на
 * ревью». Путь: пустой раздел → форма с составом → конфликт прав, который
 * панель ловит прямо в форме → переменные набора → карточка → тумблер → что
 * стало с участниками на их собственных страницах.
 *
 * Два последних кадра — главные в сценарии и единственные, которые нельзя
 * подделать готовым состоянием: они показывают, ПОЧЕМУ включение группы не
 * оживляет то, что выключили руками. Заглушка держит два повода быть
 * выключенным порознь, как их держит сервер, и кадры сняты после настоящих
 * щелчков по тумблеру.
 */
import { makeState, settings, panelShell, open } from './projects-stubs.mjs';

export async function shootBundle(browser, web, scenario) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });

  try {
    // Раздел начинается пустым, а сущности, из которых собирают набор, уже
    // есть: группа только ссылается на них и ничего не создаёт.
    const state = makeState();
    state.groups = [];
    state.automations = [];

    await settings(page);
    await panelShell(page, state);

    // ── 01. Раздел без единой группы ─────────────────────────────────────────
    await open(page, web, '/groups');
    await scenario.shot(page, '01-empty');

    // ── 02. Форма группы: имя, описание и состав ─────────────────────────────
    await page
      .getByRole('button', { name: /^(Создать группу|Create group)$/ })
      .first()
      .click();
    await page.waitForSelector('[role="dialog"]');
    const dialog = page.locator('[role="dialog"]').first();
    await page.getByLabel(/^(Название|Name)$/).fill('Ревью фронтенда');
    await page
      .getByLabel(/^(Описание|Description)$/)
      .fill('Всё, что нужно на разборе чужой ветки, и ничего сверх того.');

    for (const name of [
      'Отвечай диффом',
      'Новых зависимостей не заводить',
      'shots-before-after',
      'PreToolUse · Bash',
      'design-mocks',
      'deny · Bash(git push:*)',
    ]) {
      await dialog
        .locator('label', { hasText: name })
        .locator('input[type="checkbox"]')
        .first()
        .check();
      await page.waitForTimeout(150);
    }
    // Отметки уехали вниз вместе с прокруткой формы: возвращаем её к началу —
    // кадр должен начинаться там же, где начинает человек, с имени набора.
    await scrollBody(dialog, 0);
    await page.waitForTimeout(600);
    await scenario.shot(page, '02-form', { clip: '[role="dialog"]', padding: 40 });

    // ── 03. Конфликт прав внутри группы ──────────────────────────────────────
    // Два участника-права с одним шаблоном и разными решениями: Claude Code
    // возьмёт какое-то одно, и панель предупреждает об этом до сохранения.
    await dialog
      .locator('label', { hasText: 'allow · Bash(git push:*)' })
      .locator('input[type="checkbox"]')
      .first()
      .check();
    await page.waitForTimeout(600);
    await scenario.shot(page, '03-conflict', { clip: '[role="dialog"]', padding: 40 });
    await dialog
      .locator('label', { hasText: 'allow · Bash(git push:*)' })
      .locator('input[type="checkbox"]')
      .first()
      .uncheck();
    await page.waitForTimeout(400);

    // ── 04. Переменные набора ────────────────────────────────────────────────
    // Регистр без anchoring: английская подпись «Group environment variables»
    // несёт слово со строчной буквы, а не с прописной, как в заголовке раздела.
    await page.getByLabel(/Переменные окружения|Environment variables/i).fill('REVIEW_STRICT=1');
    await scrollBody(dialog, 'end');
    await page.waitForTimeout(600);
    await scenario.shot(page, '04-env', { clip: '[role="dialog"]', padding: 40 });

    await page.getByRole('button', { name: /^(Сохранить|Save)$/ }).click();
    await page.waitForSelector('[role="dialog"]', { state: 'detached', timeout: 8000 });
    await page.waitForTimeout(1200);

    // ── 05. Карточка набора в списке ─────────────────────────────────────────
    await scenario.shot(page, '05-card');

    // ── 06. Тот же набор, выключенный тумблером ──────────────────────────────
    await page
      .getByRole('switch', { name: /Ревью фронтенда/ })
      .first()
      .click();
    await page.waitForTimeout(1500);
    await scenario.shot(page, '06-off');

    // ── 07. Что стало с участниками: страница правил ─────────────────────────
    await open(page, web, '/rules');
    await scenario.shot(page, '07-rules-off');

    // ── 08. Группа включена обратно ──────────────────────────────────────────
    // Правило, погашенное группой, вернулось. Правило, выключенное отдельным
    // тумблером ДО сборки набора, осталось выключенным: это разные решения.
    await open(page, web, '/groups');
    await page
      .getByRole('switch', { name: /Ревью фронтенда/ })
      .first()
      .click();
    await page.waitForTimeout(1500);
    await open(page, web, '/rules');
    await scenario.shot(page, '08-rules-on');

    // ── 09. Удаление набора ──────────────────────────────────────────────────
    await open(page, web, '/groups');
    await page
      .getByRole('button', { name: /^(Удалить|Delete): Ревью фронтенда/ })
      .first()
      .click();
    await page.waitForSelector('[role="dialog"]');
    await page.waitForTimeout(800);
    await scenario.shot(page, '09-delete', { clip: '[role="dialog"]', padding: 120 });
  } finally {
    await page.close();
  }
}

/**
 * Прокрутить тело модалки. Форма прокручивается внутри себя, а не страницей: у
 * неё ограничена высота, и прокрутка окна тут ничего не двигает.
 */
async function scrollBody(dialog, to) {
  await dialog.evaluate((node, target) => {
    const body = node.querySelector('[class*="_body"]') ?? node;
    body.scrollTo(0, target === 'end' ? body.scrollHeight : target);
  }, to);
}
