/**
 * Прогон окна «Код проекта».
 *
 * Проверяется вся связка целиком: кнопка есть только у вкладки проекта, окно
 * открывается со списком изменённых файлов, первый файл подставляется сам,
 * редактор получает ТЕКУЩИЙ текст с подсветкой синтаксиса, дифф рисует новое
 * зелёным и прежнее серой вставкой, тумблер эту подсветку снимает, в дереве
 * тронутое агентом помечено на всех уровнях, прокрутка раздельная (окно целиком
 * не едет), а правка уходит в сервер тем самым `mtimeMs`, что пришёл с
 * содержимым (иначе запись отобьётся как несвежая).
 *
 * Данные подменяются на лету, а не берутся с диска: прогон обязан быть
 * воспроизводимым на любой машине, а разговор с правками в чужой истории —
 * случайность. Тем же приёмом живут `check-attention.mjs` и
 * `check-provider-chat.mjs`.
 *
 * Запуск: `node tools/qa/check-project-code.mjs` при поднятом `pnpm dev`.
 */
import { chromium } from 'playwright';
import { bypassOnboarding } from './bypass-onboarding.mjs';

const BASE = process.env.APP_URL ?? 'http://localhost:8888';
const PROJECT = { name: 'QA проект', path: 'C:/qa-project' };

// Файл длиннее окна: без этого у редактора нечего прокручивать и проверка
// раздельной прокрутки ничего не значила бы.
const TAIL = Array.from({ length: 160 }, (_, index) => `const line${index} = ${index};`).join('\n');
const BEFORE = `const port = 5178;\nconst host = "0.0.0.0";\n${TAIL}\n`;
const AFTER = `const port = 5178;\nconst host = "127.0.0.1";\nconst secure = true;\n${TAIL}\n`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await bypassOnboarding(page);

const problems = [];
page.on('pageerror', (error) => problems.push(error.message));
page.on('console', (message) => message.type() === 'error' && problems.push(message.text()));

/** Что ушло на запись — по нему проверяется, тем ли `mtimeMs` сохраняем. */
let saved;

// Каталога проекта на диске нет — настоящий git-пульт ответил бы отказом и
// засорил консоль. Проверяем не его, поэтому отвечаем «не репозиторий».
await page.route('**/api/project-git*', async (route) =>
  route.fulfill({
    json: { isRepo: false, detached: false, unborn: false, branches: [], changes: [] },
  }),
);

/** Снимок окна кода: сервер здесь подменён, но ведёт себя как настоящий. */
let view = null;

await page.route('**/api/project-files/view*', async (route) => {
  const method = route.request().method();
  if (method === 'PUT') {
    view = route.request().postDataJSON().view;
    return route.fulfill({ json: { ok: true } });
  }
  if (method === 'DELETE') {
    view = null;
    return route.fulfill({ json: { ok: true } });
  }
  return route.fulfill({ json: view });
});

/** Ширина списка файлов — одна на панель, а не на проект. */
let layout = { treeWidth: 300 };

await page.route('**/api/project-files/layout*', async (route) => {
  if (route.request().method() === 'PUT') {
    const width = route.request().postDataJSON().treeWidth;
    layout = { treeWidth: Math.min(720, Math.max(200, Math.round(width))) };
  }
  return route.fulfill({ json: layout });
});

await page.route('**/api/chats/projects*', async (route) =>
  route.fulfill({
    json: [
      {
        path: PROJECT.path,
        name: PROJECT.name,
        exists: true,
        lastActivity: '2026-08-07T10:00:00.000Z',
        chats: [],
      },
    ],
  }),
);

await page.route('**/api/project-files/changes*', async (route) =>
  route.fulfill({
    json: {
      files: [
        { path: 'src/config.ts', added: 2, removed: 1, missing: false },
        { path: 'src/gone.ts', added: 0, removed: 0, missing: true },
      ],
      skipped: 0,
    },
  }),
);

// Дерево отвечает по каталогам: корень и src. Иначе не проверить, что папка с
// правками раскрылась сама и получила метку.
await page.route('**/api/project-files/tree*', async (route) => {
  const dir = new URL(route.request().url()).searchParams.get('dir') ?? '';
  if (dir === 'src') {
    return route.fulfill({
      json: {
        dir: 'src',
        entries: [
          { name: 'config.ts', path: 'src/config.ts', isDir: false, sizeBytes: 120 },
          { name: 'index.ts', path: 'src/index.ts', isDir: false, sizeBytes: 80 },
        ],
        truncated: false,
      },
    });
  }
  return route.fulfill({
    json: {
      dir: '',
      entries: [
        { name: 'src', path: 'src', isDir: true },
        { name: 'logo.png', path: 'logo.png', isDir: false, sizeBytes: 68 },
        { name: 'icon.svg', path: 'icon.svg', isDir: false, sizeBytes: 90 },
        { name: 'README.md', path: 'README.md', isDir: false, sizeBytes: 40 },
        { name: 'spec.pdf', path: 'spec.pdf', isDir: false, sizeBytes: 300 },
        ...Array.from({ length: 40 }, (_, index) => ({
          name: `file-${index}.txt`,
          path: `file-${index}.txt`,
          isDir: false,
          sizeBytes: 10,
        })),
      ],
      truncated: false,
    },
  });
});

// Настоящий PNG 1×1: `img` обязан ЗАГРУЗИТЬСЯ, а не просто оказаться в разметке
// — пустой тег с битым адресом выглядит в проверке точно так же.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><circle r="18" /></svg>';
const MD = '# Заголовок\n\nАбзац с `кодом`.\n';

/** Файлы, показываемые не текстом: у каждого свой признак показа. */
const FILES = {
  'src/config.ts': { content: AFTER, baseline: BEFORE, kind: 'exact', added: 2, removed: 1 },
  'logo.png': { content: '', preview: 'image', isBinary: true, sizeBytes: 68 },
  'icon.svg': { content: SVG, preview: 'svg', sizeBytes: 90 },
  'README.md': { content: MD, preview: 'markdown', sizeBytes: 40 },
  'spec.pdf': { content: '', preview: 'pdf', isBinary: true, sizeBytes: 300 },
};

await page.route('**/api/project-files/raw*', async (route) =>
  route.fulfill({ contentType: 'image/png', body: PNG }),
);

await page.route('**/api/project-files/content*', async (route) => {
  if (route.request().method() === 'PUT') {
    saved = route.request().postDataJSON();
    return route.fulfill({ json: { mtimeMs: 777, sizeBytes: 120 } });
  }

  const path = new URL(route.request().url()).searchParams.get('file') ?? 'src/config.ts';
  const file = FILES[path] ?? FILES['src/config.ts'];
  return route.fulfill({
    json: {
      path,
      kind: 'none',
      added: 0,
      removed: 0,
      unmatched: 0,
      isBinary: false,
      sizeBytes: 120,
      mtimeMs: 555,
      tooBig: false,
      isReadOnly: false,
      ...file,
    },
  });
});

let bad = 0;
const check = (ok, text) => {
  console.log(`${ok ? 'ок  ' : 'ПЛОХО'} ${text}`);
  if (!ok) bad += 1;
};

await page.goto(`${BASE}/chat`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('nav');
await page.waitForTimeout(1500);

// В песочнице кнопки быть не должно: окно живёт только у проекта.
check(
  (await page.getByRole('button', { name: 'Код проекта' }).count()) === 0,
  'на домашней вкладке кнопки «Код проекта» нет',
);

// Список проектов в боковой панели живёт за сегментом «Проекты» — по умолчанию
// там показаны чаты.
await page.getByRole('tab', { name: 'Проекты' }).click();
await page.waitForTimeout(800);
await page
  .getByRole('button', { name: new RegExp(PROJECT.name) })
  .first()
  .click();
await page.waitForTimeout(1500);

const openButton = page.getByRole('button', { name: 'Код проекта' }).first();
check((await openButton.count()) > 0, 'у вкладки проекта кнопка «Код проекта» есть');
await openButton.click();
await page.waitForTimeout(1500);

const dialog = page.getByRole('dialog');
check((await dialog.count()) > 0, 'окно открылось');

const editor = dialog.locator('[data-testid="project-code-editor"]');
await editor.locator('.cm-content').waitFor({ timeout: 15_000 });
check(true, 'редактор собрался');

check(
  (await dialog.getByRole('button', { name: /Изменённые \(1\)/ }).count()) > 0,
  'вкладка «Изменённые» считает только существующие файлы',
);

const text = await editor.innerText();
check(text.includes('127.0.0.1'), 'в редакторе текущий текст файла');
check(text.includes('0.0.0.0'), 'прежний код показан вставкой');

const deleted = editor.locator('.cm-deletedChunk');
const changed = editor.locator('.cm-changedLine');
check((await deleted.count()) > 0, 'блок удалённого кода отрисован');
check((await changed.count()) > 0, 'добавленные строки подсвечены');

// Подсветка синтаксиса: грамматика приезжает отдельным куском, и именно её
// загрузка ломалась переоптимизацией зависимостей.
await page.waitForTimeout(1500);
const colours = await editor.evaluate((host) => {
  const spans = [...host.querySelectorAll('.cm-line span')];
  return [...new Set(spans.map((span) => getComputedStyle(span).color))];
});
check(colours.length > 1, `подсветка синтаксиса работает: цветов ${colours.length}`);

// Дерево: тронутое агентом видно на всех уровнях.
await dialog.getByRole('button', { name: 'Все файлы' }).click();
await page.waitForTimeout(1200);
check(
  (await dialog.locator('[class*="nodeInside"]').count()) > 0,
  'папка с правками помечена в дереве',
);
check(
  (await dialog.locator('[class*="nodeChanged"]').count()) > 0,
  'изменённый файл выделен в дереве',
);

// Прокрутка: окно целиком не едет, едут дерево и редактор по отдельности.
const scrolling = await dialog.evaluate((node) => {
  const measure = (element) =>
    element ? { over: element.scrollHeight > element.clientHeight + 2 } : null;
  const body = node.querySelector('[class*="body"]');
  return {
    body: measure(body),
    tree: measure(node.querySelector('[class*="tree"]')),
    editor: measure(node.querySelector('.cm-scroller')),
    dialogHeight: Math.round(node.getBoundingClientRect().height),
  };
});
check(scrolling.body?.over === false, 'тело окна не прокручивается');
check(scrolling.tree?.over === true, 'дерево прокручивается своей полосой');
check(scrolling.editor?.over === true, 'код прокручивается своей полосой');
check(scrolling.dialogHeight > 850, `окно занимает высоту экрана: ${scrolling.dialogHeight}px`);

// Размер строки дерева: список читают весь сеанс, и мелкий шрифт здесь —
// не вкусовщина, а работа глазами.
const nodeSize = await dialog
  .locator('[class*="_node_"]')
  .first()
  .evaluate((node) => ({
    font: Math.round(parseFloat(getComputedStyle(node).fontSize)),
    height: Math.round(node.getBoundingClientRect().height),
  }));
check(nodeSize.font >= 14, `кегль имени файла: ${nodeSize.font}px`);
check(nodeSize.height >= 26, `высота строки дерева: ${nodeSize.height}px`);

// Разделитель: тянем список шире и проверяем, что ширина уехала и запомнилась.
const resizer = dialog.locator('[data-testid="project-code-resizer"] [role="separator"]');
check((await resizer.count()) === 1, 'разделитель списка на месте');

const sidebar = dialog.locator('[class*="_sidebar_"]').first();
const widthBefore = Math.round((await sidebar.boundingBox()).width);
const grip = await resizer.boundingBox();
await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
await page.mouse.down();
await page.mouse.move(grip.x + grip.width / 2 + 140, grip.y + grip.height / 2, { steps: 12 });
await page.mouse.up();
await page.waitForTimeout(900);

const widthAfter = Math.round((await sidebar.boundingBox()).width);
check(widthAfter > widthBefore + 100, `список стал шире: ${widthBefore} → ${widthAfter}px`);
check(layout.treeWidth === widthAfter, `ширина ушла на сервер: ${layout.treeWidth}px`);

// Клавиатурой тот же результат: перетаскивание только мышью для части людей
// означает «недоступно вовсе».
await resizer.focus();
await page.keyboard.press('ArrowLeft');
await page.waitForTimeout(900);
check(layout.treeWidth === widthAfter - 24, `стрелка сузила список: ${layout.treeWidth}px`);

// Границы: за максимум не пускают, сколько ни тяни.
await resizer.focus();
for (let i = 0; i < 40; i += 1) await page.keyboard.press('ArrowRight');
await page.waitForTimeout(900);
check(layout.treeWidth === 720, `ширина упёрлась в потолок: ${layout.treeWidth}px`);
await resizer.focus();
for (let i = 0; i < 40; i += 1) await page.keyboard.press('ArrowLeft');
await page.waitForTimeout(900);
check(layout.treeWidth === 200, `ширина упёрлась в пол: ${layout.treeWidth}px`);

// Тумблер снимает подсветку, но текст файла остаётся тем же.
await dialog.getByRole('switch', { name: 'Правки агента' }).click();
await page.waitForTimeout(700);
check((await deleted.count()) === 0, 'тумблер убрал вставки прежнего кода');
check((await editor.innerText()).includes('127.0.0.1'), 'текст файла на месте');

// Правка и сохранение: важно, что уходит именно тот mtimeMs, что пришёл.
const save = dialog.getByRole('button', { name: 'Сохранить' });
check(await save.isDisabled(), 'без правок кнопка сохранения выключена');

await editor.locator('.cm-content').click();
await page.keyboard.press('End');
await page.keyboard.type(' // qa');
await page.waitForTimeout(500);
check(!(await save.isDisabled()), 'после правки сохранение доступно');

await save.click();
await page.waitForTimeout(1200);
check(saved?.mtimeMs === 555, `запись ушла с mtimeMs открытия: ${saved?.mtimeMs}`);
check(String(saved?.content).includes('// qa'), 'в записи есть набранный текст');
check(saved?.file === 'src/config.ts', 'записывается открытый файл');

// Память таба: что открыто — уходит на сервер и возвращается при следующем
// открытии окна. Это и есть смысл хранения снимка вне браузера.
check(view?.file === 'src/config.ts', `снимок помнит открытый файл: ${view?.file}`);
check(view?.openDirs?.includes('src') === true, 'снимок помнит раскрытую папку');
check(view?.showDiff === false, 'снимок помнит снятый тумблер диффа');
check(view?.onlyChanged === false, 'снимок помнит выбранную вкладку списка');

await page.keyboard.press('Escape');
await page.waitForTimeout(800);
await openButton.click();
await page.waitForTimeout(2500);
check((await dialog.count()) > 0, 'окно открылось повторно');
check(
  (await dialog.locator('[class*="nodeActive"]').count()) > 0,
  'при повторном открытии восстановлен прежний файл',
);
check(
  (await dialog.getByRole('switch', { name: 'Правки агента' }).isChecked()) === false,
  'при повторном открытии восстановлен режим показа',
);

// Файлы, которые показываются не текстом. Проверяется именно ПОКАЗ: тег в
// разметке ничего не доказывает, пока картинка не загрузилась, а разметка не
// собралась в элементы.
await dialog.getByRole('button', { name: 'Все файлы' }).click();
await page.waitForTimeout(800);

const codeTab = dialog.getByRole('button', { name: 'Код', exact: true });
const previewTab = dialog.getByRole('button', { name: 'Превью', exact: true });

await dialog.getByRole('button', { name: 'logo.png' }).click();
await page.waitForTimeout(1200);

const picture = dialog.locator('[class*="_previewImage_"]');
check((await picture.count()) === 1, 'вместо «двоичный файл» показана картинка');
check(
  await picture.evaluate((img) => img.complete && img.naturalWidth > 0),
  'картинка действительно загрузилась',
);
check((await editor.count()) === 0, 'у картинки редактора нет');
check((await codeTab.count()) === 0, 'у картинки нет вкладки исходника — его не существует');

await dialog.getByRole('button', { name: 'icon.svg' }).click();
await page.waitForTimeout(1200);
check((await previewTab.count()) === 1, 'у SVG есть обе вкладки');
check(
  await picture.evaluate((img) => img.src.startsWith('data:image/svg+xml')),
  'SVG открылся рисунком',
);

await codeTab.click();
await editor.locator('.cm-content').waitFor({ timeout: 10_000 });
check((await editor.innerText()).includes('<circle'), 'вкладка «Код» открывает исходник SVG');

// Правка обязана попасть в показ ДО сохранения: иначе вкладка врёт о том, что
// нарисовано.
await editor.locator('.cm-content').click();
await page.keyboard.press('Control+End');
await page.keyboard.type('<!--qa-mark-->');
await page.waitForTimeout(400);
await previewTab.click();
await page.waitForTimeout(600);
check(
  await picture.evaluate((img) => decodeURIComponent(img.src).includes('qa-mark')),
  'показ SVG собран из набранного текста, а не из файла на диске',
);

// PDF отдаём встроенному просмотрщику браузера. Проверяем оправу: сам
// просмотрщик в headless не запускается, и требовать от него страницу здесь
// значило бы проверять Chromium, а не панель.
await dialog.getByRole('button', { name: 'spec.pdf' }).click();
await page.waitForTimeout(1000);
const frame = dialog.locator('[class*="_previewFrame_"]');
check((await frame.count()) === 1, 'PDF открывается врезкой просмотрщика');
check((await frame.getAttribute('sandbox')) === 'allow-scripts', 'чужой документ идёт в песочнице');
check(
  String(await frame.getAttribute('src')).includes('project-files/raw'),
  'врезка тянет байты у панели, а не у файловой системы напрямую',
);

await dialog.getByRole('button', { name: 'README.md' }).click();
await page.waitForTimeout(1200);
const document = dialog.locator('[data-testid="project-code-markdown"]');
check((await document.count()) === 1, 'Markdown открывается показом, как и всё, у чего он есть');
check((await document.locator('h1').innerText()) === 'Заголовок', 'разметка собралась в документ');
check((await document.locator('code').count()) > 0, 'вставки кода в разметке отрисованы');

await codeTab.click();
await editor.locator('.cm-content').waitFor({ timeout: 10_000 });
check((await editor.innerText()).includes('# Заголовок'), 'вкладка «Код» открывает исходник');

// Несохранённое. Переключение файлов работу не теряет, а закрытие окна —
// единственное место, где она пропадает насовсем, поэтому там спрашивают.
await codeTab.click();
await editor.locator('.cm-content').waitFor({ timeout: 10_000 });
await editor.locator('.cm-content').click();
await page.keyboard.type('ЧЕРНОВИК ');
await page.waitForTimeout(400);

await dialog.getByRole('button', { name: 'icon.svg' }).click();
await page.waitForTimeout(1000);
await dialog.getByRole('button', { name: 'README.md' }).click();
await page.waitForTimeout(1200);
check(
  (await editor.count()) === 1,
  'файл с недописанной правкой открывается на ней, а не на показе',
);
check((await editor.innerText()).includes('ЧЕРНОВИК'), 'уход на другой файл не потерял набранное');

await page.keyboard.press('Escape');
await page.waitForTimeout(900);
const discard = page.getByRole('dialog').filter({ hasText: 'несохранённые правки' });
check((await discard.count()) === 1, 'закрытие с несохранённым спрашивает, а не молчит');
check(
  (await discard.innerText()).includes('README.md'),
  'в вопросе названы файлы, которые пропадут',
);

await discard.getByRole('button', { name: 'Отмена' }).click();
await page.waitForTimeout(700);
check((await dialog.count()) > 0, 'отказ от закрытия оставляет окно и правку на месте');
check((await editor.innerText()).includes('ЧЕРНОВИК'), 'правка после отказа цела');

await page.keyboard.press('Escape');
await page.waitForTimeout(700);
await page
  .getByRole('dialog')
  .filter({ hasText: 'несохранённые правки' })
  .getByRole('button', { name: 'Закрыть без сохранения' })
  .click();
await page.waitForTimeout(900);
check((await page.getByRole('dialog').count()) === 0, 'явный отказ от правок закрывает окно');

console.log(
  problems.length ? `ПРОБЛЕМЫ: ${problems.slice(0, 3).join(' | ')}` : 'ошибок консоли нет',
);
await browser.close();
process.exit(bad === 0 && problems.length === 0 ? 0 : 1);
