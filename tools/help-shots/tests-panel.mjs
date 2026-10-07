/**
 * Кадры справки раздела «Тесты» — три сценария одной съёмкой.
 *
 * `workspace` — путь от пустого проекта до прочитанной записи прогона: его
 * проходит один раз всякий, кто заводит набор. `health` — то, что делают с
 * набором, который УЖЕ живёт: карантин, покрытие, отбор по правкам, обмен с CI;
 * его проходят регулярно и обычно другим человеком. `e2e` — папка настоящих
 * автотестов: завести, сверить с кейсами, убрать. Один сценарий = один путь
 * человека от начала до конца, поэтому их три, а не один длинный и не восемь
 * коротких.
 *
 * Панель поднимается СВОЯ, одноразовая: каталог конфигурации во временной папке,
 * свои порты, свой фронт. Рабочий стенд человека не трогается. Проект тоже свой
 * и одноразовый — рядом с репозиторием, а не внутри него (наблюдатель `pnpm dev`
 * перезапускал бы сервер на каждой записи) и не во временной папке профиля (её
 * путь содержит имя пользователя, а оно уехало бы в кадр).
 *
 * Установленный CLI НЕ НУЖЕН: всё, что здесь снято, панель делает сама — ручной
 * проход пишет настоящие результаты и настоящую запись прогона, импорт из CI
 * читает настоящий junit.xml, а «Только изменённое» отказывается ДО запуска
 * агента. Сценарий `e2e` кладёт в PATH панели два подменыша — `claude`
 * (tests-e2e-fake-cli.mjs, подменена только модель) и `npx` (fake-npx.mjs,
 * пишет junit вместо браузеров); строку о папке, сверку по концу хода, прогон
 * и запись истории делает настоящая панель. Ни один кадр не изображает экран,
 * которого нет.
 *
 * Запуск: node tools/help-shots/tests-panel.mjs
 * Переменные: GUIDE_PANEL_PORT, GUIDE_WEB_PORT, GUIDE_TESTS_PROJECT.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { openScenario, applyShotLanguage, shotLanguage } from './kit.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const PANEL_PORT = Number(process.env.GUIDE_PANEL_PORT ?? 5194);
const WEB_PORT = Number(process.env.GUIDE_WEB_PORT ?? 8902);
const PANEL = `http://127.0.0.1:${PANEL_PORT}`;
const WEB = `http://127.0.0.1:${WEB_PORT}`;

/**
 * Одноразовый проект рядом с репозиторием: `<родитель репозитория>/cc-help-tests`.
 * Считается от места этого файла, а не от `os.tmpdir()` — путь показан в кадре
 * над библиотекой, и во временной папке профиля он содержал бы имя пользователя.
 */
const PROJECT = process.env.GUIDE_TESTS_PROJECT ?? join(ROOT, '..', 'cc-help-tests', 'shop');
const PROJECT_NAME = 'Магазин';
const GROUP = 'smoke';
const API = `${PANEL}/api/project-tests`;

/** Что видит человек в кадре: одна группа «Дым» из шести кейсов. */
const SEEDED = [
  {
    title: 'Количество товара в корзине меняется',
    area: 'Корзина',
    section: 'Корзина/Правка',
    priority: 'high',
    duration: 3,
    tags: ['корзина', 'дым'],
    steps: [
      { action: 'Открыть корзину с одним товаром', expected: 'В строке товара стоит 1' },
      { action: 'Нажать «плюс» в строке товара', expected: 'Количество 2, сумма удвоилась' },
    ],
    expected: 'Сумма заказа пересчитана по новому количеству',
    links: [
      {
        type: 'requirement',
        url: 'https://tracker.example.com/browse/SHOP-14',
        title: 'Корзина: правка количества',
      },
    ],
    codePaths: ['src/cart'],
  },
  {
    title: 'Позиция удаляется из корзины',
    area: 'Корзина',
    section: 'Корзина/Правка',
    priority: 'medium',
    duration: 2,
    tags: ['корзина'],
    steps: [
      { action: 'Открыть корзину с двумя товарами', expected: 'Показаны обе строки' },
      { action: 'Удалить вторую строку', expected: 'Осталась одна строка' },
    ],
    expected: 'В корзине один товар, сумма равна его цене',
    links: [
      {
        type: 'requirement',
        url: 'https://tracker.example.com/browse/SHOP-14',
        title: 'Корзина: правка количества',
      },
    ],
    codePaths: ['src/cart'],
  },
  {
    title: 'Заказ оформляется с доставкой курьером',
    area: 'Оформление',
    section: 'Оформление/Доставка',
    priority: 'blocker',
    duration: 8,
    tags: ['оформление', 'дым'],
    steps: [
      { action: 'Перейти к оформлению из корзины', expected: 'Открыта форма заказа' },
      { action: 'Выбрать доставку курьером и подтвердить', expected: 'Показан номер заказа' },
    ],
    expected: 'Заказ создан, номер показан на экране',
    links: [
      {
        type: 'requirement',
        url: 'https://tracker.example.com/browse/SHOP-21',
        title: 'Оформление заказа',
      },
    ],
    codePaths: ['src/checkout'],
  },
  {
    title: 'Промокод уменьшает сумму заказа',
    area: 'Оформление',
    section: 'Оформление/Скидки',
    priority: 'medium',
    duration: 5,
    tags: ['оформление'],
    steps: [
      { action: 'Ввести промокод в форме заказа', expected: 'Поле приняло код' },
      { action: 'Применить код', expected: 'Итоговая сумма уменьшилась на размер скидки' },
    ],
    expected: 'Скидка показана отдельной строкой и вычтена из суммы',
    links: [
      {
        type: 'requirement',
        url: 'https://tracker.example.com/browse/SHOP-21',
        title: 'Оформление заказа',
      },
    ],
    codePaths: ['src/checkout'],
  },
  {
    title: 'Поиск находит товар по части названия',
    area: 'Каталог',
    section: 'Каталог/Поиск',
    priority: 'high',
    duration: 3,
    tags: ['каталог', 'дым'],
    steps: [
      { action: 'Ввести в поиск часть названия товара', expected: 'Подсказки показаны' },
      { action: 'Открыть первый результат', expected: 'Открыта карточка нужного товара' },
    ],
    expected: 'Найден товар, название которого содержит введённую строку',
    codePaths: ['src/catalog'],
  },
];

function git(...args) {
  const result = spawnSync('git', ['-C', PROJECT, ...args], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')}: ${(result.stderr || result.stdout || '').trim()}`);
  }
  return (result.stdout ?? '').trim();
}

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

async function post(path, body) {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: PROJECT, ...body }),
  });
  if (!res.ok) throw new Error(`POST ${path}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

/** Чистый проект под съёмку: репозиторий с одним коммитом и меткой вехи. */
/**
 * Подменены только модель и сам раннер тестов — ради кадров «Прогнать автотесты»
 * и «агент чата написал тест». `claude` — `tests-e2e-fake-cli.mjs` (читает
 * строку о папке из дописки панели и кладёт тест туда), `npx` — раннер из
 * фикстур сервера (пишет junit туда, куда панель велела, и выходит с кодом 1,
 * как Playwright с одним красным тестом). Команду, отчёт, историю и сверку по
 * концу хода панель делает по-настоящему.
 */
function fakeBin(home) {
  const bin = join(home, 'bin');
  mkdirSync(bin, { recursive: true });
  const scripts = {
    claude: join(ROOT, 'tools', 'help-shots', 'tests-e2e-fake-cli.mjs'),
    npx: join(
      ROOT,
      'apps',
      'server',
      'src',
      'domains',
      'project-tests',
      '__fixtures__',
      'fake-npx.mjs',
    ),
  };
  for (const [name, script] of Object.entries(scripts)) {
    if (process.platform === 'win32') {
      writeFileSync(
        join(bin, `${name}.cmd`),
        `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`,
      );
    } else {
      writeFileSync(join(bin, name), `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, {
        mode: 0o755,
      });
    }
  }
  return bin;
}

/**
 * Отчёт фальшивого раннера: два теста спеки корзины, второй красный, а первый
 * зелёный только со второй попытки (`<flakyFailure>` — так Playwright пишет
 * ретрай в junit, когда панель просит его об этом). Два таких прогона — и
 * карточка карантина предлагает кейс по повторам.
 */
const RUN_JUNIT =
  '<testsuites><testsuite name="cart.spec.ts">' +
  '<testcase name="Корзина › [cart-001] товар добавляется в корзину @smoke" classname="cart.spec.ts" time="1.4">' +
  '<flakyFailure message="Timeout 5000ms: счётчик корзины не обновился"/></testcase>' +
  '<testcase name="Корзина › [cart-002] пустая корзина не пускает к оплате @regression" classname="cart.spec.ts" time="0.6">' +
  '<failure message="кнопка «Оплатить» доступна при пустой корзине"/></testcase>' +
  '</testsuite></testsuites>';

/** Окружение сервера: один ключ PATH (на Windows их бывает два — `Path` и `PATH`). */
function standEnv(env, bin) {
  const inherited = Object.fromEntries(
    Object.entries(env).filter(([key]) => key.toUpperCase() !== 'PATH'),
  );
  const path = Object.entries(env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? '';
  return {
    ...inherited,
    PATH: `${bin}${delimiter}${path}`,
    FAKE_E2E_JUNIT: RUN_JUNIT,
    FAKE_E2E_EXIT: '1',
  };
}

function buildProject() {
  rmSync(PROJECT, { recursive: true, force: true });
  mkdirSync(PROJECT, { recursive: true });
  writeFileSync(
    join(PROJECT, 'README.md'),
    '# Магазин\n\nДемонстрационный проект для снимков справки.\n',
    'utf8',
  );
  mkdirSync(join(PROJECT, 'src', 'cart'), { recursive: true });
  mkdirSync(join(PROJECT, 'src', 'checkout'), { recursive: true });
  mkdirSync(join(PROJECT, 'src', 'catalog'), { recursive: true });
  for (const area of ['cart', 'checkout', 'catalog']) {
    writeFileSync(join(PROJECT, 'src', area, 'index.js'), `export const ${area} = {};\n`, 'utf8');
  }
  // Каркас назван самим проектом (vitest в package.json), интеграционные помечены
  // именем файла — ради кадра пирамиды: без этого она честно сказала бы «не известно».
  writeFileSync(
    join(PROJECT, 'package.json'),
    `${JSON.stringify({ name: 'shop', private: true, devDependencies: { vitest: '^3.2.0', '@playwright/test': '^1.55.0' } }, null, 2)}\n`,
    'utf8',
  );
  const unit = (names) =>
    [
      "import { describe, it, expect } from 'vitest';",
      '',
      "describe('модуль', () => {",
      ...names.map((name) => `  it('${name}', () => expect(true).toBe(true));`),
      '});',
      '',
    ].join('\n');
  const tests = {
    'cart/cart.test.js': [
      'складывает позиции',
      'пересчитывает сумму',
      'убирает пустую строку',
      'не уходит в минус',
    ],
    'checkout/promo.test.js': ['применяет промокод', 'отклоняет просроченный', 'округляет скидку'],
    'catalog/search.test.js': ['ищет по части названия', 'не различает регистр'],
    'checkout/order.integration.test.js': ['заказ пишется в базу', 'оплата уходит в шлюз'],
  };
  for (const [file, names] of Object.entries(tests)) {
    writeFileSync(join(PROJECT, 'src', ...file.split('/')), unit(names), 'utf8');
  }
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'QA');
  git('config', 'user.email', 'qa@local');
  git('add', '-A');
  git('commit', '-qm', 'демонстрационный проект');
  git('tag', 'v1.4');
}

const home = mkdtempSync(join(tmpdir(), 'cc-help-tests-'));
mkdirSync(join(home, 'agentdeck'), { recursive: true });
writeFileSync(join(home, 'settings.json'), '{}\n', 'utf8');
writeFileSync(join(home, 'CLAUDE.md'), '# путеводитель\n', 'utf8');
// Проект — в реестре «Проектов»: папку e2e и автотесты панель заводит только
// проектам оттуда и копиям их веток (`project-gate.ts`), и кадры папки e2e на
// незарегистрированном проекте показали бы отказ, а не работу.
writeFileSync(
  join(home, 'agentdeck', 'state.json'),
  `${JSON.stringify({ projects: [{ id: 'shop', name: PROJECT_NAME, path: PROJECT }] }, null, 2)}\n`,
  'utf8',
);

const started = [];
try {
  buildProject();
  console.log(`проект ${PROJECT}`);

  const env = {
    ...process.env,
    CLAUDE_CONFIG_DIR: home,
    PORT: String(PANEL_PORT),
    WEB_PORT: String(WEB_PORT),
  };
  // Сервер панели видит фальшивые `claude` и `npx` раньше настоящих; фронту они не нужны.
  const serverEnv = standEnv(env, fakeBin(home));

  started.push(
    spawn(
      process.execPath,
      ['--experimental-strip-types', '--no-warnings', 'apps/server/src/index.ts'],
      { cwd: ROOT, env: serverEnv, stdio: 'ignore', shell: false },
    ),
  );
  if (!(await waitFor(`${PANEL}/api/system`, 40)))
    throw new Error('одноразовая панель не поднялась');
  console.log(`панель на ${PANEL}`);

  // Язык — до первого кадра и через настройки панели, а не через i18n в
  // странице: кадр должен доказывать тот путь, по которому язык приходит
  // человеку. `GUIDE_LANG=en` → английские кадры рядом с русскими.
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

  await shoot();
} finally {
  for (const child of started) child.kill();
  rmSync(home, { recursive: true, force: true });
  if (!process.env.GUIDE_KEEP_PROJECT) rmSync(PROJECT, { recursive: true, force: true });
}

async function shoot() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await page.goto(`${WEB}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);

    // Свежая панель встречает мастером онбординга. Он закрывается по-настоящему:
    // подменять на съёмке нечего — кадры должны быть тем, что человек увидит сам.
    const skip = page.getByRole('button', { name: /^(Пропустить|Skip)$/ });
    if (await skip.count()) {
      await skip.first().click();
      await page.waitForTimeout(1200);
    }

    // Проект открыт вкладкой, а не записан в реестр: раздел тестов берёт и то,
    // и другое, а вкладка — ровно тот путь, которым сюда попадает человек из чата.
    await page.evaluate(
      ([path, name]) =>
        localStorage.setItem(
          'agentdeck:workspace',
          JSON.stringify({
            projectTabs: [{ id: path.toLowerCase(), path, name }],
            activeTabId: path.toLowerCase(),
            views: {},
          }),
        ),
      [PROJECT, PROJECT_NAME],
    );

    await workspace(page);
    await health(page);
    await e2e(page);
  } finally {
    await browser.close();
  }
}

/** Открыть раздел на нужной вкладке и дождаться, пока он дочитает проект. */
async function openTests(page, tab = 'library') {
  await page.goto(`${WEB}/tests?tab=${tab}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('nav');
  // Язык приходит из /api/settings; сервер, занятый концом прогона, отвечает
  // позже фиксированной паузы — и кадр снялся бы на языке по умолчанию.
  await page.waitForFunction(
    (lang) => document.documentElement.lang.startsWith(lang),
    shotLanguage(),
    { timeout: 15_000 },
  );
  await page.waitForTimeout(2600);
}

async function workspace(page) {
  const scenario = openScenario('tests', 'workspace');
  const main = page.getByRole('main').first();

  await openTests(page);
  await scenario.shot(page, '01-empty');

  // Шаг 1 онбординга заводит окружение `local` «Локальное» — настоящей записью
  // в environments.json, а не отметкой на экране.
  await main
    .getByRole('button', { name: /^(Добавить окружение|Add an environment)$/ })
    .first()
    .click();
  await page.waitForTimeout(1800);
  await scenario.shot(page, '02-environment');

  // ── Группа ────────────────────────────────────────────────────────────────
  await main
    .getByRole('button', { name: /^(Новая группа|New group)$/ })
    .first()
    .click();
  await page.waitForTimeout(600);
  await page.getByLabel(/^(Идентификатор|Identifier)$/).fill(GROUP);
  await page.waitForTimeout(300);
  await scenario.shot(page, '03-group', { clip: '[role="dialog"]' });
  await page
    .getByRole('button', { name: /^(Сохранить|Save)$/ })
    .first()
    .click();
  await page.waitForTimeout(1800);

  // ── Первый кейс руками ────────────────────────────────────────────────────
  // Окно кейса выше экрана: на 900px под срез уходят шаги, ради которых кейс и
  // заводят, и кадр обещал бы меньше, чем форма просит.
  await page.setViewportSize({ width: 1440, height: 2000 });
  await main
    .getByRole('button', { name: /^(Добавить тест|Add a test)$/ })
    .first()
    .click();
  await page.waitForTimeout(800);

  const editor = page.getByRole('dialog').first();
  await editor.getByLabel(/^(Что проверяем|What we check)$/).fill('Товар добавляется в корзину');
  await editor
    .getByLabel(/^(Зачем|Why)$/)
    .fill('Корзина — вход в оплату: без неё не проверить ничего дальше');
  await editor.getByLabel(/^(Зона|Area)$/).fill('Корзина');
  await editor.getByLabel(/^(Секция|Section)$/).fill('Корзина/Добавление');
  await editor.getByLabel(/^(Минут|Minutes)$/).fill('4');
  await editor
    .getByLabel(/^(Важность|Priority)$/)
    .selectOption({ label: shotLanguage() === 'en' ? 'high' : 'высокая' });
  await editor
    .getByLabel(/^(Предусловие|Precondition)$/)
    .fill('Каталог открыт, пользователь не входил');

  // Поле шага ищется ролью: подпись «Шаг 1» носят ещё и кнопки «поднять»,
  // «опустить» и «удалить» этого же шага.
  await editor.getByRole('textbox', { name: /^(Шаг 1|Step 1)$/ }).fill('Открыть карточку товара');
  await editor
    .getByLabel(/^(Ожидание шага|Step expectation)$/)
    .nth(0)
    .fill('Кнопка «В корзину» активна');
  await editor.getByRole('button', { name: /^(Добавить шаг|Add a step)$/ }).click();
  await page.waitForTimeout(400);
  await editor.getByRole('textbox', { name: /^(Шаг 2|Step 2)$/ }).fill('Нажать «В корзину»');
  await editor
    .getByLabel(/^(Ожидание шага|Step expectation)$/)
    .nth(1)
    .fill('Счётчик корзины стал 1');

  await editor
    .getByLabel(/^(Ожидаемый результат|Expected result)$/)
    .fill('В корзине один товар, сумма равна его цене');
  await editor
    .getByLabel(/^(Чем доказывается|How it is proven)$/)
    .fill('Счётчик в шапке и строка товара в корзине');
  await editor.getByLabel(/^(Теги|Tags)$/).fill('корзина, дым');
  await page.waitForTimeout(500);
  await scenario.shot(page, '04-case', { clip: '[role="dialog"]' });

  await editor
    .getByRole('button', { name: /^(Сохранить|Save)$/ })
    .first()
    .click();
  await page.waitForTimeout(2000);
  await page.setViewportSize({ width: 1440, height: 900 });

  // Остальные пять кейсов — тем же маршрутом панели, что и первый: набор из
  // одного кейса не показал бы ни отбора, ни секций, ни покрытия.
  for (const testCase of SEEDED) await post('/case', { groupId: GROUP, testCase });
  await openTests(page);
  await scenario.shot(page, '05-library');

  // ── Ручной проход ─────────────────────────────────────────────────────────
  await main
    .getByLabel(/^(Отметить все показанные|Select everything shown)$/)
    .first()
    .check();
  await page.waitForTimeout(600);
  await main
    .getByRole('button', { name: /^(Пройти руками|Run( it)? manually)/ })
    .first()
    .click();
  await page.waitForTimeout(3000);

  const runner = page.getByRole('dialog').first();
  await scenario.shot(page, '06-runner', { clip: '[role="dialog"]' });

  // Вердикт закрывается цифрой — тем же способом, каким его закрывает человек:
  // 1 — пройден, 2 — провален. Клавиши молчат, пока курсор в поле ввода, поэтому
  // перед цифрой фокус уводится с заметки на заголовок прохода.
  const verdict = async (key) => {
    await runner.getByRole('heading').first().click();
    await page.keyboard.press(key);
    await page.waitForTimeout(1800);
  };

  await verdict('1');

  // Второй проход красный, с разбором шага: провал без доказательства нечем ни
  // воспроизвести, ни завести дефектом. Красным сделан именно «Количество товара
  // в корзине меняется» — заметка о неработающем «плюсе» должна говорить о том
  // кейсе, который на экране, иначе кадр учит выдуманному примеру.
  const step2 = runner
    .locator('li')
    .filter({ has: page.getByLabel(/^(Заметка к шагу 2|Note on step 2)$/) })
    .first();
  await step2
    .getByRole('button', { name: /^(провален|failed)$/ })
    .first()
    .click();
  await page.waitForTimeout(400);
  await page
    .getByLabel(/^(Заметка к шагу 2|Note on step 2)$/)
    .fill('Количество осталось 1, сумма не пересчиталась');
  await page
    .getByLabel(/^(Что получилось|What actually happened)/)
    .fill('Кнопка «плюс» не увеличивает количество: сумма заказа остаётся прежней');
  await page.waitForTimeout(600);
  await scenario.shot(page, '07-runner-failed', { clip: '[role="dialog"]' });

  await verdict('2');
  await verdict('1');
  await verdict('1');
  await verdict('1');
  await verdict('1');

  await runner
    .getByRole('button', { name: /^(Завершить|Finish)$/ })
    .first()
    .click();
  await page.waitForTimeout(2500);

  await openTests(page);
  await scenario.shot(page, '08-library-after');

  await openTests(page, 'runs');
  // Запись раскрывается: список отвечает на «что происходило», раскрытая
  // запись — на «почему этот кейс красный».
  await main.locator('[aria-expanded]').first().click();
  await page.waitForTimeout(2000);
  await scenario.shot(page, '09-run-record');

  await openTests(page, 'report');
  await scenario.shot(page, '10-report');

  scenario.finish();
}

async function health(page) {
  const scenario = openScenario('tests', 'health');
  const main = page.getByRole('main').first();

  // ── Отбор по правкам на чистом дереве ─────────────────────────────────────
  await openTests(page);
  await main
    .getByRole('button', { name: /^(Только изменённое|Changed only)$/ })
    .first()
    .click();
  await page.waitForTimeout(2500);
  await scenario.shot(page, '01-changed-only');

  // ── Карантин ──────────────────────────────────────────────────────────────
  await openTests(page);
  // Галочка строки подписана названием кейса — по нему её и находят.
  await main.getByLabel('Количество товара в корзине меняется').first().check();
  await page.waitForTimeout(600);
  await main
    .getByLabel(/^(Действие|Action)$/)
    .first()
    .selectOption({ label: shotLanguage() === 'en' ? 'quarantine' : 'в карантин' });
  await page.waitForTimeout(400);
  await main
    .getByLabel(/^(Причина карантина|Quarantine reason)$/)
    .fill('Ждём починки пересчёта суммы, дефект SHOP-31 открыт');
  await page.waitForTimeout(400);
  await scenario.shot(page, '02-quarantine');

  await main
    .getByRole('button', { name: /^(Применить|Apply)$/ })
    .first()
    .click();
  await page.waitForTimeout(2200);
  await scenario.shot(page, '03-muted');

  // ── Отчёт: вердикт вехи и разбор набора ───────────────────────────────────
  // Два кадра, а не один: «отдаём или нет» и «чем это доказано» — разные
  // вопросы, и карточки под них стоят на странице далеко друг от друга.
  await openTests(page, 'report');
  await main
    .getByText(/^(Готовность релиза|Release readiness)$/)
    .first()
    .scrollIntoViewIfNeeded();
  await page.waitForTimeout(1200);
  await scenario.shot(page, '04-release');

  await main
    .getByText(/^(Карантин и устаревание|Quarantine and ageing)$/)
    .first()
    .scrollIntoViewIfNeeded();
  await page.waitForTimeout(1200);
  await scenario.shot(page, '05-health');

  // ── Покрытие ──────────────────────────────────────────────────────────────
  await openTests(page, 'coverage');
  await page.waitForTimeout(1500);
  await scenario.shot(page, '06-coverage');

  // ── Обмен: результаты из CI ───────────────────────────────────────────────
  mkdirSync(join(PROJECT, 'test-results'), { recursive: true });
  writeFileSync(
    join(PROJECT, 'test-results', 'junit.xml'),
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<testsuites>',
      '  <testsuite name="smoke">',
      '    <testcase name="Поиск находит товар по части названия" time="2.4"/>',
      '    <testcase name="Заказ оформляется с доставкой курьером" time="7.1"/>',
      '    <testcase name="Ничей автотест" time="0.3"><failure message="упал"/></testcase>',
      '  </testsuite>',
      '</testsuites>',
    ].join('\n'),
    'utf8',
  );

  await openTests(page);
  await main
    .getByRole('button', { name: /^(Обмен|Exchange)$/ })
    .first()
    .click();
  await page.waitForTimeout(900);
  const modal = page.getByRole('dialog').first();
  await modal
    .getByLabel(/^(Файл в проекте|File in the project)$/)
    .first()
    .fill('test-results/junit.xml');
  await modal
    .getByRole('button', { name: /^(Взять из проекта|Take from the project)$/ })
    .first()
    .click();
  await page.waitForTimeout(3000);
  await scenario.shot(page, '07-exchange', { clip: '[role="dialog"]' });

  await page.keyboard.press('Escape');
  await page.waitForTimeout(1000);
  await openTests(page, 'runs');
  await scenario.shot(page, '08-runs-import');

  scenario.finish();
}

/** Кейсы корзины, заведённые сверкой папки e2e, — из файла группы на диске. */
function syncedCartCases() {
  const dir = join(PROJECT, '.agent', 'tests');
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.tests.json')) continue;
    const group = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    const cases = (group.cases ?? []).filter((item) => /^cart-00[12]$/.test(item.id));
    if (cases.length > 0) return { groupId: name.replace(/\.tests\.json$/, ''), cases };
  }
  throw new Error('Кейсов корзины после сверки папки e2e нет');
}

async function mutation(page, scenario) {
  const { groupId, cases } = syncedCartCases();
  for (const testCase of cases) {
    await post('/case', { groupId, testCase: { ...testCase, codePaths: ['src/cart/index.js'] } });
  }
  await post('/environment', {
    environment: {
      id: 'local',
      title: shotLanguage() === 'en' ? 'Local' : 'Локальное',
      isDefault: true,
      baseUrl: 'http://localhost:3000',
    },
  });
  await openTests(page);
  const card = '[data-testid="tests-mutation"]';
  await page.locator(card).scrollIntoViewIfNeeded();
  await page
    .locator(card)
    .getByRole('button', { name: /^(Сломать и прогнать|Break and run)$/ })
    .click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /^(Запустить|Start)$/ })
    .click();
  await page.locator(`${card} [data-mutation-verdict]`).waitFor({ timeout: 60_000 });
  await page.locator(`${card} li`).first().waitFor({ timeout: 15_000 });
  // Итог дописывается под карточкой, а та стоит у нижнего края окна: кадр
  // обрезал бы его по окну — карточка встаёт в середину.
  await page.locator(card).evaluate((node) => node.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(800);
  await scenario.shot(page, '11-mutation-result', { clip: card, padding: 8 });
}

/**
 * Папка e2e: завести, сверить с кейсами, убрать. Всё настоящее — папку и строку
 * в `.git/info/exclude` пишет панель, спеку кладёт сценарий (как её положил бы
 * агент чата), сверка читает её с диска, уборка упирается в чужой файл.
 */
async function e2e(page) {
  const scenario = openScenario('tests', 'e2e');
  const card = '[data-testid="tests-e2e-card"]';
  const within = page.locator(card);

  await openTests(page);
  await scenario.shot(page, '01-missing', { clip: card, padding: 8 });

  await within.getByRole('button', { name: /^(Создать папку|Create folder)$/ }).click();
  await page.waitForTimeout(1500);
  await scenario.shot(page, '02-created', { clip: card, padding: 8 });
  // «npm install» в заготовке: без раннера в node_modules/.bin панель отказывает
  // до запуска (ничего не качает сама), а раннер здесь — подменный npx из PATH.
  const bin = join(PROJECT, 'e2e', 'node_modules', '.bin');
  mkdirSync(bin, { recursive: true });
  for (const name of ['playwright', 'playwright.cmd']) writeFileSync(join(bin, name), '');

  writeFileSync(
    join(PROJECT, 'e2e', 'cart.spec.ts'),
    [
      "import { test, expect } from '@playwright/test';",
      '',
      "test.describe('Корзина', () => {",
      "  test('[cart-001] товар добавляется в корзину @smoke', async ({ page }) => {",
      '    // Given открыт каталог',
      "    await page.goto('/catalog');",
      '    // When нажимает «В корзину» у первого товара',
      "    await page.getByRole('button', { name: 'В корзину' }).first().click();",
      '    // Then счётчик корзины показывает 1',
      "    await expect(page.getByTestId('cart-count')).toHaveText('1');",
      '  });',
      '',
      "  test('[cart-002] пустая корзина не пускает к оплате @regression', async ({ page }) => {",
      '    // Given корзина пуста',
      "    await page.goto('/cart');",
      '    // Then кнопка оплаты недоступна',
      "    await expect(page.getByRole('button', { name: 'Оплатить' })).toBeDisabled();",
      '  });',
      '});',
      '',
    ].join('\n'),
    'utf8',
  );
  await within.getByRole('button', { name: /^(Обновить из папки|Update from folder)$/ }).click();
  await page.waitForTimeout(2200);
  await scenario.shot(page, '03-synced');

  // «Прогнать автотесты»: команда каркаса без агента, итог — на кейсы и в историю.
  await within.getByRole('button', { name: /^(Прогнать автотесты|Run autotests)$/ }).click();
  await within
    .getByText(/(Упало \d+ из|of \d+ failed|Прошли все|All passed)/)
    .first()
    .waitFor({ timeout: 30_000 });
  await page.waitForTimeout(800);
  await scenario.shot(page, '05-run-done', { clip: card, padding: 8 });
  await openTests(page, 'runs');
  await scenario.shot(page, '06-run-history');

  // Второй прогон того же отчёта: [cart-001] снова зелёный только на повторе —
  // два прогона из двух, и карточка карантина предлагает его по повторам.
  await openTests(page);
  const runButton = within.getByRole('button', { name: /^(Прогнать автотесты|Run autotests)$/ });
  await runButton.click();
  await page.waitForTimeout(1500);
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('[data-testid="tests-e2e-card"] button')].some(
        (button) =>
          /^(Прогнать автотесты|Run autotests)$/.test(button.textContent?.trim() ?? '') &&
          !button.disabled,
      ),
    undefined,
    { timeout: 30_000 },
  );
  await page.waitForTimeout(800);

  await openTests(page, 'report');
  const quarantine = '[data-testid="tests-quarantine-card"]';
  await page.locator(quarantine).scrollIntoViewIfNeeded();
  await page
    .locator(quarantine)
    .getByText(/(на повторе|on retry) ×2/)
    .first()
    .waitFor({ timeout: 15_000 });
  await page.waitForTimeout(600);
  await scenario.shot(page, '09-retry-quarantine', { clip: quarantine, padding: 8 });

  // Пирамида: модульные и интеграционные посчитаны по файлам проекта рядом с e2e.
  const pyramid = '[data-testid="tests-pyramid-card"]';
  await page.locator(pyramid).scrollIntoViewIfNeeded();
  await page.locator(pyramid).getByText(/^E2E$/).first().waitFor({ timeout: 15_000 });
  await page.waitForTimeout(600);
  await scenario.shot(page, '10-pyramid', { clip: pyramid, padding: 8 });

  // Сторона чата: агент обычного разговора узнал папку из строки панели и
  // положил туда тест; кейс завела сама панель по концу хода.
  await page.goto(`${WEB}/chat`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('nav');
  await page.waitForTimeout(2000);
  await page
    .getByRole('button', { name: /^(Новый чат|New chat)/ })
    .first()
    .click();
  await page.waitForTimeout(1500);
  const input = page.locator('textarea[data-chat-input]');
  await input.fill(
    shotLanguage() === 'en'
      ? 'Write an e2e test: an order is paid by card.'
      : 'Напиши e2e-тест: заказ оплачивается картой.',
  );
  await input.press('Enter');
  await page
    .getByText(/checkout\.spec\.ts —/)
    .first()
    .waitFor({ timeout: 30_000 });
  await page.waitForTimeout(1500);
  await scenario.shot(page, '07-chat-test');
  await openTests(page);
  // Группу завела сверка по концу хода; её заголовок — describe спеки.
  await page.getByText('Оформление', { exact: true }).first().click();
  await page.waitForTimeout(1200);
  await page
    .getByText(/заказ оплачивается картой/i)
    .first()
    .waitFor({ timeout: 15_000 });
  await scenario.shot(page, '08-chat-case');
  await openTests(page);

  await within.getByRole('button', { name: /^(Убрать папку|Remove folder)$/ }).click();
  await page.waitForTimeout(1500);
  await scenario.shot(page, '04-remove-confirm', { clip: card, padding: 8 });

  // Проверка набора поломкой с итогом (Ф21) — после кадра подтверждения: итог
  // удлиняет карточку, и кадр 04 обрезал бы его на краю окна. Автокейсы корзины
  // привязываются к её модулю тем же путём, что правка кейса человеком,
  // окружение получает адрес стенда — без него проверка не стартует. Дальше всё
  // настоящее: копия, поломка, прогон подменного раннера, разбор отчёта и
  // уборка копии делает панель.
  await within.getByRole('button', { name: /^(Отмена|Cancel)$/ }).click();
  await mutation(page, scenario);
  await openTests(page);
  await within.getByRole('button', { name: /^(Убрать папку|Remove folder)$/ }).click();
  await page.waitForTimeout(1500);

  await within.getByRole('button', { name: /^(Убрать вместе с ними|Remove them too)$/ }).click();
  await page.waitForTimeout(1500);

  scenario.finish();
}
