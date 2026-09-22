/**
 * Кадры раздела «Паспорт среды»: разовый перенос и подписка на канон.
 *
 * Сценарии делятся ПО ВОПРОСУ, на который отвечают, а не по экранам:
 *
 *   portability/transfer  — «перенеси то, что есть сейчас»: паспорт, отчёт
 *                           верности, план, применено;
 *   portability/subscribe — «держи это согласованным»: слои, план пересборки,
 *                           файл тронут руками, исход;
 *   portability/carry     — «а работа?»: незакрытые разговоры прежнего CLI и
 *                           названная причина, почему строка не выбирается.
 *
 * Снимается один проход по одной панели, и порядок тот же, что у человека:
 * подписка идёт ПОСЛЕ применённого переноса, потому что решение «держать ли
 * цель согласованной» принимают, увидев, что из переноса вышло, а перенос
 * работы — последним: вопрос «где моя незакрытая работа» возникает уже после
 * переезда среды.
 *
 * ПАНЕЛЬ ОДНОРАЗОВАЯ, и это здесь не формальность: прогон по-настоящему ПИШЕТ
 * файлы чужих CLI. Поэтому во временный каталог уведены все дома сразу —
 * `HOME`, `USERPROFILE`, `CODEX_HOME`, `QWEN_HOME`, `KIMI_CODE_HOME`,
 * `XDG_CONFIG_HOME`, `APPDATA`, тем же набором, что у
 * `tools/qa/check-portability-apply.mjs`. Забыть один из них значит записать в
 * настоящий `~/.codex` человека.
 *
 * Прогон ещё и ПРОВЕРЯЕТ: каждый кадр подписан утверждением, и утверждение
 * сверяется тут же. Кадр, на котором нет того, что обещает подпись, — это
 * тихая ложь в справке, поймать которую больше нечем. Красная строка роняет
 * прогон.
 *
 * Запуск: node tools/help-shots/portability-panel.mjs
 * Переменные: GUIDE_PANEL_PORT (5197), GUIDE_WEB_PORT (8907),
 *             GUIDE_LANG=en — английские кадры рядом с русскими.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { openScenario, applyShotLanguage } from './kit.mjs';
import { makeHome, drop, HOME_DIR } from './config-fixture.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const PANEL_PORT = Number(process.env.GUIDE_PANEL_PORT ?? 5197);
const WEB_PORT = Number(process.env.GUIDE_WEB_PORT ?? 8907);
const PANEL = `http://127.0.0.1:${PANEL_PORT}`;
const WEB = `http://127.0.0.1:${WEB_PORT}`;
const TARGET = 'codex';

/**
 * Подписи кнопок нужны на обоих языках: английский прогон идёт тем же кодом по
 * тому же пути. Регулярное выражение — единственный способ не заводить второй
 * сценарий-близнец, который разойдётся с первым в первую же правку.
 */
const BUTTON = {
  transferPlan: /^(Показать план переноса|Show transfer plan)$/,
  transfer: /^(Перенести|Transfer)$/,
  revert: /^(Отменить перенос|Undo transfer)$/,
  rebuildPlan: /^(Показать план пересборки|Show the rebuild plan)$/,
  rebuild: /^(Пересобрать|Rebuild)$/,
  projection: /^(Вернуть проекцию|Restore the projection)$/,
  canon: /^(Взять правку в канон|Take the edit into the canon)$/,
  unsubscribe: /^(Перестать писать в файл|Stop writing into this file)$/,
  resolve: /^(Сделать выбранное|Do it)$/,
};
const TEXT = {
  noLayers: /(Ни один слой не подписан|No layer is subscribed)/,
  drift: /(Файлов, тронутых руками|Files edited by hand)/,
  edited: /(файл правили руками|edited by hand)/,
  carry: /(Незакрытая работа у других CLI|Unfinished work at other CLIs)/,
  carryTarget: /(Продолжить у: |Continue at: )/,
  noCheckpoint: /(файла-опоры в каталоге нет|there is no checkpoint file in the directory)/,
  carryEmpty: /(Незакрытых разговоров у других CLI нет|No unfinished conversations at other CLIs)/,
  carryFailed: /(Список незакрытой работы не загрузился|The list of unfinished work did not load)/,
  subscriptionsFailed: /(Подписки не загрузились|Subscriptions did not load)/,
};
const LAYER = { skill: /^(Скиллы|Skills)$/, hook: /^(Хуки|Hooks)$/ };

const rows = [];
const check = (what, expected, seen, ok) => {
  rows.push({ what, ok });
  console.log(`${ok ? 'OK  ' : 'FAIL'} | ${what} | ждали: ${expected} | видно: ${seen}`);
};

async function waitFor(url, seconds) {
  for (let i = 0; i < seconds * 2; i += 1) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status === 401) return true;
    } catch {
      /* ещё не поднялось */
    }
    await new Promise((done) => setTimeout(done, 500));
  }
  return false;
}

const pause = (ms) => new Promise((done) => setTimeout(done, ms));

const started = [];
const canon = makeHome();
// Дом целей лежит РЯДОМ с репозиторием, а не во временной папке системы:
// системный путь на Windows содержит имя пользователя, а карточка расхождения
// пишет путь файла прямо на экран — и имя уехало бы в кадр справки.
const fakeHome = resolve(ROOT, '..', '.cc-help-portability');
rmSync(fakeHome, { recursive: true, force: true });
mkdirSync(fakeHome, { recursive: true });

// Разговоры чужих CLI панель ведёт сама, в своём каталоге данных рядом с
// каноном (`<CLAUDE_CONFIG_DIR>/agentdeck/provider-chats/<провайдер>`).
const APP_DATA = join(canon, 'agentdeck');

/**
 * Незакрытый разговор чужого CLI — файлом, как его пишет сама панель.
 *
 * Завести его «по-настоящему» съёмка не может: для этого нужен установленный
 * `codex`, который ответил бы на реплику. Предмет кадра не в том, как разговор
 * появился, а в том, что он остался незакрытым у прежнего CLI, — и всё, что
 * читает список кандидатов (шапка с рабочим каталогом, первая реплика, время
 * касания), здесь настоящее.
 */
function foreignChat(id, title, workdir, task) {
  const at = new Date().toISOString();
  const dir = join(APP_DATA, 'provider-chats', TARGET);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${id}.jsonl`),
    `${JSON.stringify({ kind: 'meta', id, providerId: TARGET, title, createdAt: at, workdir })}\n` +
      `${JSON.stringify({ kind: 'message', id: 'm1', role: 'user', content: task, at })}\n`,
    'utf8',
  );
}

/** Рабочий каталог разговора; с файлом-опорой или намеренно без него. */
function workdir(name, checkpoint) {
  const dir = join(fakeHome, 'projects', name);
  mkdirSync(join(dir, '.agent'), { recursive: true });
  if (checkpoint) writeFileSync(join(dir, '.agent', 'PROGRESS.md'), checkpoint, 'utf8');
  return dir;
}

try {
  const env = {
    ...process.env,
    // Канон подписки — дом Claude: его панель читает и пишет сама.
    CLAUDE_CONFIG_DIR: canon,
    // Дома ЦЕЛЕЙ: всё, куда перенос и пересборка умеют писать.
    HOME: fakeHome,
    USERPROFILE: fakeHome,
    CODEX_HOME: join(fakeHome, '.codex'),
    QWEN_HOME: join(fakeHome, '.qwen'),
    KIMI_CODE_HOME: join(fakeHome, '.kimi-code'),
    XDG_CONFIG_HOME: join(fakeHome, '.config'),
    APPDATA: join(fakeHome, 'AppData', 'Roaming'),
    PORT: String(PANEL_PORT),
    WEB_PORT: String(WEB_PORT),
  };

  started.push(
    spawn(
      process.execPath,
      ['--experimental-strip-types', '--no-warnings', 'apps/server/src/index.ts'],
      { cwd: ROOT, env, stdio: 'ignore', shell: false },
    ),
  );
  if (!(await waitFor(`${PANEL}/api/system`, 60)))
    throw new Error('одноразовая панель не поднялась');
  console.log(`панель на ${PANEL}, дом целей ${fakeHome}`);

  // Язык — до первого кадра и через настройки панели: кадр должен доказывать
  // тот путь, по которому язык приходит человеку.
  await applyShotLanguage(PANEL);

  started.push(
    spawn(
      process.execPath,
      [
        join('node_modules', 'vite', 'bin', 'vite.js'),
        '--port',
        String(WEB_PORT),
        '--strictPort',
        '--host',
        '127.0.0.1',
      ],
      {
        cwd: join(ROOT, 'apps', 'web'),
        // BROWSER=none — иначе Vite откроет окно поверх съёмки.
        env: { ...env, API_PORT: String(PANEL_PORT), BROWSER: 'none' },
        stdio: 'ignore',
        shell: false,
      },
    ),
  );
  if (!(await waitFor(WEB, 120))) throw new Error('фронт одноразовой панели не поднялся');
  console.log(`фронт на ${WEB}`);

  const browser = await chromium.launch();
  const transfer = openScenario('portability', 'transfer');
  const subscribe = openScenario('portability', 'subscribe');
  const carry = openScenario('portability', 'carry');

  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const button = (name) => page.getByRole('button', { name }).first();
    /** Карточку под кадр поднимаем к верху окна: кадр — это ответ, а не страница. */
    const focus = async (locator) => {
      await locator.scrollIntoViewIfNeeded();
      await page.mouse.wheel(0, -120);
      await pause(400);
    };

    await page.goto(`${WEB}/portability`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('nav');
    await pause(4000);
    // Цель — второй выпадающий список шапки: провайдер, цель, уровень.
    await page.locator('select').nth(1).selectOption(TARGET);
    await pause(4000);

    // ── transfer/01. Паспорт: что у источника есть ───────────────────────────
    await transfer.shot(page, '01-passport', { side: 'panel' });

    // ── transfer/02. Отчёт верности: что доедет ──────────────────────────────
    const fidelity = page.getByText(/(Верность переноса|Transfer fidelity)/).first();
    check(
      'отчёт верности на экране до переноса',
      'заголовок отчёта',
      String(await fidelity.isVisible()),
      await fidelity.isVisible(),
    );
    await focus(fidelity);
    await transfer.shot(page, '02-fidelity', { side: 'panel' });

    // ── transfer/03. План: что именно изменится в файлах ─────────────────────
    await focus(button(BUTTON.transferPlan));
    await button(BUTTON.transferPlan).click();
    await pause(5000);
    const applyCount = await button(BUTTON.transfer).count();
    check(
      'кнопка переноса появилась ПОСЛЕ плана',
      '1 кнопка',
      String(applyCount),
      applyCount === 1,
    );
    await focus(page.getByText(/(Перенос в|Transfer to)/).first());
    await transfer.shot(page, '03-plan', { side: 'panel' });

    // ── transfer/04. Применено — и отменяется целиком ────────────────────────
    await button(BUTTON.transfer).click();
    await page.waitForSelector('[role="dialog"]');
    await pause(600);
    await page.locator('[role="dialog"]').getByRole('button', { name: BUTTON.transfer }).click();
    await pause(6000);
    const revertCount = await button(BUTTON.revert).count();
    check(
      'после применения на месте плана — след и отмена',
      '1 кнопка отмены',
      String(revertCount),
      revertCount === 1,
    );
    await focus(page.getByText(/(Перенос в|Transfer to)/).first());
    await transfer.shot(page, '04-applied', { side: 'panel' });

    // ── subscribe/01. Слои: пока не подписан ни один ─────────────────────────
    const noLayers = page.getByText(TEXT.noLayers).first();
    check(
      'без слоёв сказано словами, а не пустым местом',
      'строка «ни один слой не подписан»',
      String(await noLayers.isVisible()),
      await noLayers.isVisible(),
    );
    const planBefore = await button(BUTTON.rebuildPlan).count();
    check(
      'кнопки плана пересборки нет, пока нет ни одного слоя',
      '0 кнопок',
      String(planBefore),
      planBefore === 0,
    );
    await focus(page.getByText(/(Подписка|Subscription of)/).first());
    await subscribe.shot(page, '01-layers', { side: 'panel' });

    // ── subscribe/02. План пересборки ────────────────────────────────────────
    await page.getByRole('switch', { name: LAYER.skill }).click();
    await pause(1500);
    await page.getByRole('switch', { name: LAYER.hook }).click();
    await pause(2000);

    const stored = await (await fetch(`${PANEL}/api/portability/subscriptions`)).json();
    const sub = stored.items.find((item) => item.target === TARGET);
    check(
      'подписка сохранена на сервере',
      'слои skill+hook',
      JSON.stringify(sub?.layers ?? []),
      Boolean(sub) && sub.layers.includes('skill') && sub.layers.includes('hook'),
    );

    await focus(button(BUTTON.rebuildPlan));
    await button(BUTTON.rebuildPlan).click();
    await pause(5000);
    await focus(page.getByText(/(Подписка|Subscription of)/).first());
    await subscribe.shot(page, '02-plan', { side: 'panel' });

    // ── subscribe/03. Файл тронут руками ─────────────────────────────────────
    await button(BUTTON.rebuild).click();
    await pause(6000);
    const afterSync = await (await fetch(`${PANEL}/api/portability/subscriptions`)).json();
    const synced = afterSync.items.find((item) => item.target === TARGET);
    const written = Object.keys(synced?.files ?? {});
    check(
      'пересборка записала файлы и запомнила их отпечатки',
      '> 0 файлов',
      String(written.length),
      written.length > 0,
    );

    const edited = written[0];
    const before = readFileSync(edited, 'utf8');
    writeFileSync(edited, `${before}\n# правка руками, которую панель не писала\n`);

    await focus(button(BUTTON.rebuildPlan));
    await button(BUTTON.rebuildPlan).click();
    await pause(5000);

    const driftSeen = await page.getByText(TEXT.drift).first().isVisible();
    check(
      'правка руками видна на экране',
      'строка о тронутых файлах',
      String(driftSeen),
      driftSeen,
    );
    const outcomes = [
      await button(BUTTON.canon).count(),
      await button(BUTTON.projection).count(),
      await button(BUTTON.unsubscribe).count(),
    ];
    check(
      'у тронутого файла предложены все три исхода',
      'канон+проекция+отписка',
      outcomes.join('/'),
      outcomes.every((count) => count >= 1),
    );
    const held = readFileSync(edited, 'utf8');
    check(
      'пересборка не тронула удержанный файл',
      'правка на месте',
      held.includes('правка руками') ? 'на месте' : 'стёрта',
      held.includes('правка руками'),
    );
    await focus(page.getByText(TEXT.drift).first());
    await subscribe.shot(page, '03-drift', { side: 'panel' });

    // ── subscribe/04. Исход сделан ───────────────────────────────────────────
    await button(BUTTON.projection).click();
    await pause(4000);
    const resolveCount = await button(BUTTON.resolve).count();
    check(
      'исход не делается без показанного плана',
      '1 кнопка после плана',
      String(resolveCount),
      resolveCount === 1,
    );
    await button(BUTTON.resolve).click();
    await pause(6000);

    // Устаревший план обязан уйти: он перечислял расхождение, которого больше
    // нет, а подставлять свежий вместо прочитанного человеком нельзя.
    const planGone = await button(BUTTON.rebuildPlan).count();
    check(
      'после исхода устаревший план снят с экрана',
      '1 кнопка «показать план»',
      String(planGone),
      planGone === 1,
    );
    await focus(page.getByText(/(Подписка|Subscription of)/).first());
    await subscribe.shot(page, '04-resolved', { side: 'panel' });

    // Продуктовая правда исхода: расхождения по файлу больше нет. Раздел панели
    // пересобран из канона, а текст человека ЗА пределами раздела остался —
    // панель ведёт в чужом файле только свой блок.
    await button(BUTTON.rebuildPlan).click();
    await pause(5000);
    const driftLeft = await page.getByText(TEXT.drift).count();
    check(
      'после исхода расхождение по файлу закрыто',
      '0 строк о тронутых файлах',
      String(driftLeft),
      driftLeft === 0,
    );
    const restored = readFileSync(edited, 'utf8');
    check(
      'раздел панели пересобран из канона',
      'блок panel на месте',
      restored.includes('agentdeck:portability:begin') ? 'на месте' : 'пропал',
      restored.includes('agentdeck:portability:begin'),
    );

    // ── carry/01. Что предлагается перенести ─────────────────────────────────
    // Разговор кладётся до перезагрузки страницы: список приходит с сервера,
    // и кадр обязан показывать ответ настоящего маршрута, а не подставленный
    // фронтом список.
    foreignChat(
      'oplata-kartoi',
      'Оплата картой падает',
      workdir(
        'payments-service',
        '# Состояние\n\nСлучай с 3-D Secure разобран, остался повтор платежа.\n',
      ),
      'разберись, почему падает оплата картой',
    );
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('nav');
    await pause(5000);

    const carryCard = page.getByText(TEXT.carry).first();
    check(
      'раздел переноса работы на странице',
      'заголовок раздела',
      String(await carryCard.isVisible()),
      await carryCard.isVisible(),
    );
    // Цель переноса РАБОТЫ — активный CLI, а не выбранная выше цель переноса
    // среды. Кадр с перепутанными целями обещал бы человеку не тот переезд.
    const targetLine = await page.getByText(TEXT.carryTarget).first().textContent();
    check(
      'цель названа активным CLI, а не целью переноса среды',
      'Claude, не Codex',
      String(targetLine),
      /Claude/.test(String(targetLine)) && !/Codex/.test(String(targetLine)),
    );
    const readyRow = page.getByRole('switch', { name: 'Оплата картой падает' });
    const readyOn = await readyRow.isEnabled();
    check('пригодный разговор выбирается', 'тумблер доступен', String(readyOn), readyOn);
    await focus(carryCard);
    await carry.shot(page, '01-list', { side: 'panel' });

    // ── carry/02. Почему строка не выбирается ────────────────────────────────
    // Второй разговор — в каталоге, где файла-опоры нет. Он остаётся в списке
    // рядом с пригодным: исчезни он, список читался бы как «этой работы нет».
    foreignChat(
      'otchet-po-vozvratam',
      'Отчёт по возвратам',
      workdir('reports-service', undefined),
      'собери отчёт по возвратам за квартал',
    );
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('nav');
    await pause(5000);

    const refusal = page.getByText(TEXT.noCheckpoint).first();
    check(
      'причина отказа названа в самой строке',
      'строка про отсутствие опоры',
      String(await refusal.isVisible()),
      await refusal.isVisible(),
    );
    const refusedOff = await page.getByRole('switch', { name: 'Отчёт по возвратам' }).isDisabled();
    const readyStill = await page.getByRole('switch', { name: 'Оплата картой падает' }).isEnabled();
    check(
      'непригодная строка не выбирается, пригодная рядом выбирается',
      'отказ выключен, пригодный доступен',
      `${refusedOff ? 'выключен' : 'доступен'}/${readyStill ? 'доступен' : 'выключен'}`,
      refusedOff && readyStill,
    );
    await focus(carryCard);
    await carry.shot(page, '02-refusal', { side: 'panel' });

    // ── Задержка ответа: экран ЖДЁТ, а не утверждает «ничего нет» ───────────
    // Четвёртая вариация. Опасность ровно та же, что у отказа ниже, только
    // окно короче: пока ответ в пути, пустой список читается как ответ
    // сервера — человек щёлкнет тумблер по экрану «ни один слой не подписан»
    // и запишет набор слоёв поверх настоящего. Кадра нет: это проверка, а не
    // картинка справки.
    const slow = async (route) => {
      const url = route.request().url();
      if (url.includes('portability/carry') || url.includes('portability/subscriptions')) {
        await new Promise((done) => setTimeout(done, 9000));
      }
      await route.continue();
    };
    await page.route('**/api/**', slow);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('nav');
    await pause(2000);
    await page.locator('select').nth(1).selectOption(TARGET);
    await pause(1500);
    const inFlight = await page.evaluate(() => document.body.innerText);
    // Ожидание на экране — это скелет: `role="status"` с подписью «загрузка».
    // Голый `role="status"` брать нельзя — в оболочке панели постоянно висит
    // пустой sr-only диктор с той же ролью, и он один давал бы «ожидание» на
    // любом экране, включая дочитанный.
    const WAITING = '[role="status"][aria-label]:not([aria-label=""])';
    const waiting = await page.locator(WAITING).count();
    check(
      'ответ в пути: экран ждёт, а не утверждает «работы нет» и «слои не подписаны»',
      'ни одного утверждения о пустоте, на экране — ожидание',
      `${TEXT.carryEmpty.test(inFlight) ? 'ЛОЖЬ: «незакрытых разговоров нет»; ' : ''}` +
        `${TEXT.noLayers.test(inFlight) ? 'ЛОЖЬ: «ни один слой не подписан»; ' : ''}` +
        `ожиданий на экране ${waiting}`,
      !TEXT.carryEmpty.test(inFlight) && !TEXT.noLayers.test(inFlight) && waiting > 0,
    );
    // Ожидание обязано КОНЧИТЬСЯ ответом: экран, застрявший в скелете, врёт
    // человеку не меньше пустого списка — просто молча.
    await pause(12000);
    const settled = await page.evaluate(() => document.body.innerText);
    // Застрявшее ожидание надо НАЗВАТЬ: «осталось одно» не говорит, какой
    // раздел не дождался ответа, и следующий прогон начинал бы разбор заново.
    const stillWaiting = await page.evaluate(
      (selector) =>
        [...document.querySelectorAll(selector)].map((node) => {
          const near = node.parentElement?.parentElement?.textContent?.trim().slice(0, 60) ?? '';
          return `«${node.getAttribute('aria-label')}» рядом: ${near}`;
        }),
      WAITING,
    );
    check(
      'задержанный ответ доезжает: ожидание сменилось данными',
      'ответ на экране, ожиданий нет',
      `${TEXT.carryTarget.test(settled) ? 'ответ на экране' : 'ответа нет'}, ожиданий ${stillWaiting.length}${stillWaiting.length ? `: ${stillWaiting.join(' · ')}` : ''}`,
      TEXT.carryTarget.test(settled) && stillWaiting.length === 0,
    );
    await page.unroute('**/api/**', slow);

    // ── Плохой ответ: два GET экрана отвечают 500 ────────────────────────────
    // Кадра здесь нет — это проверка, а не картинка справки, и стоит она
    // последней: перехват остаётся на странице до конца прогона.
    //
    // Раздел, написанный под «данные есть или их нет», на отказе показывает не
    // ошибку, а УТВЕРЖДЕНИЕ: «незакрытых разговоров нет», «ни один слой не
    // подписан». Второе опаснее первого — по такому экрану человек щёлкнет
    // тумблер и запишет набор слоёв поверх настоящего.
    await page.route('**/api/**', async (route) => {
      const url = route.request().url();
      if (url.includes('portability/carry') || url.includes('portability/subscriptions')) {
        await route.fulfill({ status: 500, body: '{"message":"проверка: сервер не ответил"}' });
        return;
      }
      await route.continue();
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('nav');
    await pause(3000);
    // Цель после перезагрузки выбирается заново: без неё раздела подписки на
    // экране нет вовсе, и проверка «слои не показаны погашенными» проверяла бы
    // пустое место.
    await page.locator('select').nth(1).selectOption(TARGET);
    await pause(4000);
    const broken = await page.evaluate(() => document.body.innerText);

    check(
      'незакрытая работа: отказ чтения назван, а не «работы нет»',
      'строка об отказе',
      TEXT.carryFailed.test(broken)
        ? 'названа'
        : TEXT.carryEmpty.test(broken)
          ? 'ЛОЖЬ: «незакрытых разговоров нет»'
          : 'ни того, ни другого',
      TEXT.carryFailed.test(broken),
    );
    check(
      'подписки: отказ чтения назван, а не «ни один слой не подписан»',
      'строка об отказе',
      TEXT.subscriptionsFailed.test(broken)
        ? 'названа'
        : TEXT.noLayers.test(broken)
          ? 'ЛОЖЬ: слои показаны погашенными'
          : 'ни того, ни другого',
      TEXT.subscriptionsFailed.test(broken),
    );
  } finally {
    transfer.finish();
    subscribe.finish();
    carry.finish();
    await browser.close();
  }
} finally {
  for (const child of started) child.kill();
  drop(HOME_DIR);
  rmSync(fakeHome, { recursive: true, force: true });
}

const failed = rows.filter((row) => !row.ok).length;
console.log(`\nстрок ${rows.length}, красных ${failed}`);
process.exit(failed === 0 ? 0 : 1);
