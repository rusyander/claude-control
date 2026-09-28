/**
 * Кейс access-integrations-001: «Права → Системные → Удаление файлов из
 * оболочки → Настроить → Запрещено» пишет `Bash(rm:*)` в `permissions.deny`
 * settings.json, карточка меняет «Не задано» на «Запрещено», во вкладке «Все
 * правила» запрет виден; удаление правила возвращает «Не задано» и убирает
 * запись из файла.
 *
 * Путь настоящий: одноразовый стенд, временный каталог конфигурации. Оракул —
 * settings.json на диске, экран сверяется с ним: карточка, список и файл
 * обязаны сказать одно и то же.
 *
 * Запуск: `node tools/qa/check-permissions-configure.mjs` (стенд поднимается сам).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { runOnStand, wait } from './throwaway-stand.mjs';

const TITLE = 'Удаление файлов из оболочки';
const PATTERN = 'Bash(rm:*)';

await runOnStand({ label: 'permissions-configure' }, async (stand, check) => {
  const file = join(stand.cfg, 'settings.json');
  const deny = () =>
    existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')).permissions?.deny ?? []) : [];
  const browser = await chromium.launch();
  try {
    const page = await stand.newPage(browser, { height: 1400 });
    await page.goto(`${stand.webUrl}/permissions`, { waitUntil: 'domcontentloaded' });
    // Карточка пресета — ближайший контейнер, где есть и заголовок, и кнопка.
    const card = page
      .locator('div')
      .filter({ has: page.getByText(TITLE, { exact: true }) })
      .filter({ has: page.getByRole('button') })
      .last();
    await card.waitFor({ timeout: 30_000 });
    check('исходно карточка «Не задано»', (await card.innerText()).includes('Не задано'));
    check('исходно в settings.json запрета нет', !deny().includes(PATTERN), JSON.stringify(deny()));

    await card.getByRole('button', { name: 'Настроить' }).click();
    const form = page.getByRole('dialog').filter({ has: page.getByLabel('Правило') });
    await form.waitFor();
    check(
      'форма открыта с шаблоном пресета',
      (await form.getByLabel('Правило').inputValue()) === PATTERN,
      await form.getByLabel('Правило').inputValue(),
    );
    await form.getByRole('button', { name: 'Запрещено', exact: true }).click();
    await form.getByRole('button', { name: 'Сохранить' }).click();
    await form.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => undefined);
    await wait(700);

    check(
      'settings.json: permissions.deny содержит Bash(rm:*)',
      deny().includes(PATTERN),
      JSON.stringify(deny()),
    );
    const cardText = await card.innerText();
    check(
      'карточка: «Не задано» сменилось на «Запрещено»',
      !cardText.includes('Не задано') && cardText.includes('Запрещено'),
      cardText.replace(/\s+/g, ' '),
    );

    await page.getByRole('button', { name: 'Все правила', exact: true }).click();
    await wait(500);
    const main = await page.locator('main').innerText();
    check(
      '«Все правила»: Bash(rm:*) в списке и помечен запретом',
      main.includes(PATTERN) && main.includes('Запрещено'),
      main.slice(0, 600),
    );

    // Вернуть «Не задано» — удалить правило из списка.
    await page
      .getByRole('button', { name: new RegExp(`^Удалить: .*${PATTERN.replace(/[()*]/g, '\\$&')}`) })
      .first()
      .click();
    const confirm = page.getByRole('dialog').last();
    await confirm.waitFor();
    const typed = confirm.getByRole('textbox');
    if ((await typed.count()) > 0) await typed.first().fill(PATTERN);
    await confirm.getByRole('button', { name: 'Удалить' }).click();
    await confirm.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => undefined);
    await wait(700);
    check(
      'удаление: записи в settings.json нет',
      !deny().includes(PATTERN),
      JSON.stringify(deny()),
    );

    await page.getByRole('button', { name: 'Системные', exact: true }).click();
    await card.waitFor({ timeout: 10_000 });
    check('удаление: карточка снова «Не задано»', (await card.innerText()).includes('Не задано'));
    check('страница без необработанных ошибок', page.errors.length === 0, page.errors.join(' | '));
  } finally {
    await browser.close();
  }
});
