/**
 * Кадры справки раздела «Тесты» — два сценария одной съёмкой.
 *
 * `workspace` — путь от пустого проекта до прочитанной записи прогона: его
 * проходит один раз всякий, кто заводит набор. `health` — то, что делают с
 * набором, который УЖЕ живёт: карантин, покрытие, отбор по правкам, обмен с CI;
 * его проходят регулярно и обычно другим человеком. Один сценарий = один путь
 * человека от начала до конца, поэтому их два, а не один длинный и не восемь
 * коротких.
 *
 * Панель поднимается СВОЯ, одноразовая: каталог конфигурации во временной папке,
 * свои порты, свой фронт. Рабочий стенд человека не трогается. Проект тоже свой
 * и одноразовый — рядом с репозиторием, а не внутри него (наблюдатель `pnpm dev`
 * перезапускал бы сервер на каждой записи) и не во временной папке профиля (её
 * путь содержит имя пользователя, а оно уехало бы в кадр).
 *
 * CLI НЕ НУЖЕН и не запускается: всё, что здесь снято, панель делает сама —
 * ручной проход пишет настоящие результаты и настоящую запись прогона, импорт из
 * CI читает настоящий junit.xml, а «Только изменённое» отказывается ДО запуска
 * агента. Ни один кадр не изображает экран, которого нет.
 *
 * Запуск: node tools/help-shots/tests-panel.mjs
 * Переменные: GUIDE_PANEL_PORT, GUIDE_WEB_PORT, GUIDE_TESTS_PROJECT.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { openScenario } from './kit.mjs';

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
    links: [{ type: 'requirement', url: 'SHOP-14', title: 'Корзина: правка количества' }],
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
    links: [{ type: 'requirement', url: 'SHOP-14', title: 'Корзина: правка количества' }],
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
    links: [{ type: 'requirement', url: 'SHOP-21', title: 'Оформление заказа' }],
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
    links: [{ type: 'requirement', url: 'SHOP-21', title: 'Оформление заказа' }],
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

  started.push(
    spawn(
      process.execPath,
      ['--experimental-strip-types', '--no-warnings', 'apps/server/src/index.ts'],
      { cwd: ROOT, env, stdio: 'ignore', shell: false },
    ),
  );
  if (!(await waitFor(`${PANEL}/api/system`, 40)))
    throw new Error('одноразовая панель не поднялась');
  console.log(`панель на ${PANEL}`);

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
    const skip = page.getByRole('button', { name: 'Пропустить' });
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
  } finally {
    await browser.close();
  }
}

/** Открыть раздел на нужной вкладке и дождаться, пока он дочитает проект. */
async function openTests(page, tab = 'library') {
  await page.goto(`${WEB}/tests?tab=${tab}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('nav');
  await page.waitForTimeout(2600);
}

async function workspace(page) {
  const scenario = openScenario('tests', 'workspace');
  const main = page.getByRole('main').first();

  await openTests(page);
  await scenario.shot(page, '01-empty');

  // Шаг 1 онбординга заводит окружение `local` «Локальное» — настоящей записью
  // в environments.json, а не отметкой на экране.
  await main.getByRole('button', { name: 'Добавить окружение' }).first().click();
  await page.waitForTimeout(1800);
  await scenario.shot(page, '02-environment');

  // ── Группа ────────────────────────────────────────────────────────────────
  await main.getByRole('button', { name: 'Новая группа' }).first().click();
  await page.waitForTimeout(600);
  await page.getByLabel('Идентификатор').fill(GROUP);
  await page.waitForTimeout(300);
  await scenario.shot(page, '03-group', { clip: '[role="dialog"]' });
  await page.getByRole('button', { name: 'Сохранить' }).first().click();
  await page.waitForTimeout(1800);

  // ── Первый кейс руками ────────────────────────────────────────────────────
  // Окно кейса выше экрана: на 900px под срез уходят шаги, ради которых кейс и
  // заводят, и кадр обещал бы меньше, чем форма просит.
  await page.setViewportSize({ width: 1440, height: 1500 });
  await main.getByRole('button', { name: 'Добавить тест' }).first().click();
  await page.waitForTimeout(800);

  const editor = page.getByRole('dialog').first();
  await editor.getByLabel('Что проверяем').fill('Товар добавляется в корзину');
  await editor
    .getByLabel('Зачем')
    .fill('Корзина — вход в оплату: без неё не проверить ничего дальше');
  await editor.getByLabel('Зона', { exact: true }).fill('Корзина');
  await editor.getByLabel('Секция').fill('Корзина/Добавление');
  await editor.getByLabel('Минут').fill('4');
  await editor.getByLabel('Важность').selectOption({ label: 'высокая' });
  await editor.getByLabel('Предусловие').fill('Каталог открыт, пользователь не входил');

  // Поле шага ищется ролью: подпись «Шаг 1» носят ещё и кнопки «поднять»,
  // «опустить» и «удалить» этого же шага.
  await editor.getByRole('textbox', { name: 'Шаг 1' }).fill('Открыть карточку товара');
  await editor.getByLabel('Ожидание шага').nth(0).fill('Кнопка «В корзину» активна');
  await editor.getByRole('button', { name: 'Добавить шаг' }).click();
  await page.waitForTimeout(400);
  await editor.getByRole('textbox', { name: 'Шаг 2' }).fill('Нажать «В корзину»');
  await editor.getByLabel('Ожидание шага').nth(1).fill('Счётчик корзины стал 1');

  await editor.getByLabel('Ожидаемый результат').fill('В корзине один товар, сумма равна его цене');
  await editor.getByLabel('Чем доказывается').fill('Счётчик в шапке и строка товара в корзине');
  await editor.getByLabel('Теги').fill('корзина, дым');
  await page.waitForTimeout(500);
  await scenario.shot(page, '04-case', { clip: '[role="dialog"]' });

  await editor.getByRole('button', { name: 'Сохранить' }).first().click();
  await page.waitForTimeout(2000);
  await page.setViewportSize({ width: 1440, height: 900 });

  // Остальные пять кейсов — тем же маршрутом панели, что и первый: набор из
  // одного кейса не показал бы ни отбора, ни секций, ни покрытия.
  for (const testCase of SEEDED) await post('/case', { groupId: GROUP, testCase });
  await openTests(page);
  await scenario.shot(page, '05-library');

  // ── Ручной проход ─────────────────────────────────────────────────────────
  await main.getByLabel('Отметить все показанные').first().check();
  await page.waitForTimeout(600);
  await main
    .getByRole('button', { name: /Пройти руками/ })
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
    .filter({ has: page.getByLabel('Заметка к шагу 2') })
    .first();
  await step2.getByRole('button', { name: 'провален' }).first().click();
  await page.waitForTimeout(400);
  await page.getByLabel('Заметка к шагу 2').fill('Количество осталось 1, сумма не пересчиталась');
  await page
    .getByLabel(/Что получилось/)
    .fill('Кнопка «плюс» не увеличивает количество: сумма заказа остаётся прежней');
  await page.waitForTimeout(600);
  await scenario.shot(page, '07-runner-failed', { clip: '[role="dialog"]' });

  await verdict('2');
  await verdict('1');
  await verdict('1');
  await verdict('1');
  await verdict('1');

  await runner.getByRole('button', { name: 'Завершить' }).first().click();
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
  await main.getByRole('button', { name: 'Только изменённое' }).first().click();
  await page.waitForTimeout(2500);
  await scenario.shot(page, '01-changed-only');

  // ── Карантин ──────────────────────────────────────────────────────────────
  await openTests(page);
  // Галочка строки подписана названием кейса — по нему её и находят.
  await main.getByLabel('Количество товара в корзине меняется').first().check();
  await page.waitForTimeout(600);
  await main.getByLabel('Действие').first().selectOption({ label: 'в карантин' });
  await page.waitForTimeout(400);
  await main
    .getByLabel('Причина карантина')
    .fill('Ждём починки пересчёта суммы, дефект SHOP-31 открыт');
  await page.waitForTimeout(400);
  await scenario.shot(page, '02-quarantine');

  await main.getByRole('button', { name: 'Применить' }).first().click();
  await page.waitForTimeout(2200);
  await scenario.shot(page, '03-muted');

  // ── Отчёт: вердикт вехи и разбор набора ───────────────────────────────────
  // Два кадра, а не один: «отдаём или нет» и «чем это доказано» — разные
  // вопросы, и карточки под них стоят на странице далеко друг от друга.
  await openTests(page, 'report');
  await main.getByText('Готовность релиза').first().scrollIntoViewIfNeeded();
  await page.waitForTimeout(1200);
  await scenario.shot(page, '04-release');

  await main.getByText('Карантин и устаревание').first().scrollIntoViewIfNeeded();
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
  await main.getByRole('button', { name: 'Обмен' }).first().click();
  await page.waitForTimeout(900);
  const modal = page.getByRole('dialog').first();
  await modal.getByLabel('Файл в проекте').first().fill('test-results/junit.xml');
  await modal.getByRole('button', { name: 'Взять из проекта' }).first().click();
  await page.waitForTimeout(3000);
  await scenario.shot(page, '07-exchange', { clip: '[role="dialog"]' });

  await page.keyboard.press('Escape');
  await page.waitForTimeout(1000);
  await openTests(page, 'runs');
  await scenario.shot(page, '08-runs-import');

  scenario.finish();
}
