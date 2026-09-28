/**
 * Кейс config-resources-005: хук добавляется на событие и проверяется в
 * песочнице без реального запуска Claude — песочница показывает то, что увидит
 * Claude Code: вывод, код выхода и время; код 2 объяснён как блокировка вызова.
 *
 * Путь настоящий: форма «Добавить хук» одноразового стенда → settings.json
 * временного каталога конфигурации → кнопка «Песочница» → прогон заготовки
 * «Безобидная команда» (POST /sandbox/probe-hook запускает саму команду хука).
 * Модели здесь нет вовсе: PATH стенда без `claude`, доступа к аккаунту нет.
 *
 * Оракул — settings.json и строка результата в окне песочницы: ответ сервера
 * читается рядом только для того, чтобы назвать расхождение, если экран
 * показал не то, что сервер получил от процесса.
 *
 * Запуск: `node tools/qa/check-hook-sandbox.mjs` (стенд поднимается сам).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { runOnStand, wait } from './throwaway-stand.mjs';

const OK_COMMAND = 'node -e "console.log(1)"';
const BLOCK_COMMAND = 'node -e "process.exit(2)"';
const LABEL = 'PreToolUse · Bash';
const FIXTURE = 'Безобидная команда';

await runOnStand({ label: 'hook-sandbox' }, async (stand, check) => {
  const settings = () => JSON.parse(readFileSync(join(stand.cfg, 'settings.json'), 'utf8'));
  const commands = () =>
    (settings().hooks?.PreToolUse ?? [])
      .filter((entry) => entry.matcher === 'Bash')
      .flatMap((entry) => entry.hooks.map((hook) => hook.command));

  const browser = await chromium.launch();
  try {
    const page = await stand.newPage(browser, { height: 1200 });
    await page.goto(`${stand.webUrl}/hooks`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Добавить хук' }).first().click();
    const form = page.getByRole('dialog', { name: 'Добавить хук' });
    await form.waitFor({ timeout: 30_000 });
    await form.getByLabel('Событие').selectOption('PreToolUse');
    await form.getByRole('button', { name: 'Bash', exact: true }).click();
    await form.getByRole('button', { name: 'Выполнить команду' }).click();
    await form.getByLabel('Команда', { exact: true }).fill(OK_COMMAND);
    await form.getByRole('button', { name: 'Сохранить' }).click();
    await form.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => undefined);
    check(
      'хук в settings.json под PreToolUse с матчером Bash',
      JSON.stringify(commands()) === JSON.stringify([OK_COMMAND]),
      JSON.stringify(settings().hooks),
    );
    check(
      'хук в списке под PreToolUse',
      (await page.getByRole('switch', { name: LABEL }).count()) === 1,
    );

    /** Прогнать одну заготовку в песочнице хука; вернуть текст строки результата и ответ сервера. */
    const probe = async () => {
      await page.getByRole('button', { name: `Песочница: ${LABEL}` }).click();
      const box = page.getByRole('dialog', { name: `Песочница: ${LABEL}` });
      await box.waitFor();
      // Окно сперва собирает песочницу и перерисовывает заготовки — ждём, пока соберёт.
      await box
        .getByRole('button', { name: /^Прогнать/ })
        .first()
        .waitFor();
      await box
        .getByText('Готовим песочницу…')
        .waitFor({ state: 'hidden', timeout: 30_000 })
        .catch(() => undefined);
      await wait(1000);
      await box.getByRole('button', { name: FIXTURE, exact: true }).click();
      const answer = page.waitForResponse((res) => res.url().includes('/api/sandbox/probe-hook'));
      await box
        .getByRole('button', { name: /^Прогнать/ })
        .first()
        .click();
      const body = await (await answer).json().catch(() => ({}));
      await wait(800);
      const text = await box.innerText();
      const tail = text.slice(text.lastIndexOf(FIXTURE));
      const result = tail.slice(
        0,
        tail.includes('Что подключено') ? tail.indexOf('Что подключено') : undefined,
      );
      await box.getByRole('button', { name: 'Закрыть' }).last().click();
      await box.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => undefined);
      return { result, server: (body.results ?? [])[0] ?? {} };
    };

    // Песочница с кодом 0: вывод 1, код выхода 0, время.
    const ok = await probe();
    console.log(`  сервер: код ${ok.server.exitCode}, вывод ${JSON.stringify(ok.server.stdout)}`);
    console.log(`  экран: ${ok.result.replace(/\s+/g, ' ').slice(0, 200)}`);
    check('код 0: показано время прогона', /\d+\s*мс/.test(ok.result), ok.result);
    check(
      'код 0: показан вывод команды «1»',
      /(^|\n)\s*1\s*(\n|$)/.test(ok.result.replace(FIXTURE, '')),
      `на экране нет вывода; сервер получил stdout ${JSON.stringify(ok.server.stdout)}`,
    );
    check(
      'код 0: показан код выхода 0',
      /код[^\n]{0,20}\b0\b/i.test(ok.result) || /exit[^\n]{0,10}\b0\b/i.test(ok.result),
      `на экране нет кода выхода; сервер получил ${ok.server.exitCode}`,
    );

    // Правка команды на выход с кодом 2 → код 2 и объяснение «2 = блокировка вызова».
    await page.getByRole('button', { name: `Редактировать: ${LABEL}` }).click();
    const edit = page
      .getByRole('dialog')
      .filter({ has: page.getByLabel('Команда', { exact: true }) });
    await edit.waitFor();
    await edit.getByLabel('Команда', { exact: true }).first().fill(BLOCK_COMMAND);
    await edit.getByRole('button', { name: 'Сохранить' }).click();
    await edit.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => undefined);
    check(
      'правка: в settings.json новая команда',
      JSON.stringify(commands()) === JSON.stringify([BLOCK_COMMAND]),
      JSON.stringify(commands()),
    );
    const blocked = await probe();
    console.log(`  сервер: код ${blocked.server.exitCode}, решение ${blocked.server.decision}`);
    console.log(`  экран: ${blocked.result.replace(/\s+/g, ' ').slice(0, 200)}`);
    check(
      'код 2: песочница говорит, что вызов остановлен',
      /остановил/.test(blocked.result),
      blocked.result,
    );
    check(
      'код 2: показан код 2 и объяснено, что вызов им заблокирован',
      /\b2\b/.test(blocked.result.replace(/\d+\s*мс/g, '')) &&
        /(блок|останов)/i.test(blocked.result),
      blocked.result.replace(/\s+/g, ' '),
    );

    // Медленная сборка: пока песочницы нет, «Прогнать» недоступна. Раньше кнопку
    // можно было нажать в первую секунду и получить «ещё не собрана» вместо
    // результата — так эта же проверка краснела под нагрузкой (27.09).
    const SLOW_MS = 3000;
    await page.route('**/api/sandbox/create', async (route) => {
      await wait(SLOW_MS);
      await route.continue();
    });
    await page.getByRole('button', { name: `Песочница: ${LABEL}` }).click();
    const slowBox = page.getByRole('dialog', { name: `Песочница: ${LABEL}` });
    await slowBox.waitFor();
    const slowRun = slowBox.getByRole('button', { name: /^Прогнать/ }).first();
    await slowRun.waitFor();
    await wait(500);
    check(
      'медленная сборка: «Прогнать» недоступна, пока песочница собирается',
      await slowRun.isDisabled(),
    );
    await slowBox.getByText('Готовим песочницу…').waitFor({ state: 'hidden', timeout: 30_000 });
    check('медленная сборка: после сборки «Прогнать» доступна', await slowRun.isEnabled());
    await page.unroute('**/api/sandbox/create');
    await slowBox.getByRole('button', { name: 'Закрыть' }).last().click();
    await slowBox.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => undefined);

    // Удалить хук — settings.json без него.
    await page.getByRole('button', { name: `Удалить: ${LABEL}` }).click();
    const confirm = page.getByRole('dialog').last();
    await confirm.waitFor();
    const typed = confirm.getByRole('textbox');
    // Подтверждение просит имя события хука, а не подпись карточки.
    if ((await typed.count()) > 0) await typed.first().fill('PreToolUse');
    await confirm.getByRole('button', { name: 'Удалить' }).click();
    await confirm.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => undefined);
    await wait(500);
    check(
      'удаление: в settings.json хука нет',
      commands().length === 0,
      JSON.stringify(settings()),
    );
    check('страница без необработанных ошибок', page.errors.length === 0, page.errors.join(' | '));
  } finally {
    await browser.close();
  }
});
