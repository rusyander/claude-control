/**
 * Прогон параллельных веток: несколько агентов в одном репозитории.
 *
 * Проверяется то, ради чего раздел существует: копия репозитория заводится из
 * панели, открывается СВОЕЙ вкладкой (а значит, получает своего агента, свой
 * список чатов и свою точку состояния) и убирается обратно, не задев основную.
 *
 * Репозиторий тест делает свой, во временном каталоге: так прогон не зависит ни
 * от чужой истории, ни от установленного CLI, ни от того, что открыто у
 * человека, — и ничего в его проектах не трогает.
 *
 * У репозитория есть локальный слой всех четырёх источников зеркала:
 * `.mcp.json` под skip-worktree с местной правкой; игнорируемые
 * `.claude/settings.local.json`, `.env`, `node_modules/`, `.venv/`, `.vault/`;
 * НЕотслеживаемый и НЕ игнорируемый `CLAUDE.local.md`; отслеживаемый и локально
 * поправленный `.env.example`. Проверяется, что копия получает слой (и флаг) без
 * вопросов и без `node_modules`, что рабочая версия отслеживаемого файла
 * побеждает версию коммита, что незакоммиченная работа вне списка (`scratch.ts`)
 * в копию не едет, что `.claude/skills` достаётся копии ССЫЛКОЙ (правка скилла в
 * оригинале видна в копии сразу), что отчёт называет `.vault/` за бортом, а
 * дописанный шаблон доносит его повторным зеркалом — но `.venv/` не доносит
 * никакой шаблон, он в закрытом списке сборочных каталогов.
 * Бутстрап — фиктивной командой `node -e`:
 * удачная даёт значок «зависимости есть» и лог, провальная — «установка не
 * удалась» с кодом, и ни та ни другая копию не ломает.
 *
 * Запись копии в `.claude.json` (доверие и согласие на серверы `.mcp.json`)
 * здесь НЕ проверяется: файл принадлежит стенду, на котором идёт прогон. Её
 * доказывает `check-copy-autonomy.mjs` — у него свой одноразовый каталог
 * конфигурации.
 *
 * Нужен живой `pnpm dev` (адрес — `APP_URL`). Запуск: `node tools/qa/check-worktrees.mjs`.
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import { bypassOnboarding } from './bypass-onboarding.mjs';

const BASE = process.env.APP_URL ?? 'http://localhost:8888';
const BRANCH = 'feature/qa-parallel';

const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? '✓' : '✕'} ${what}`);
  if (!ok) failures.push(what);
};

/** Свой репозиторий с одним коммитом — на нём и проверяем. */
function makeRepo() {
  // Длинная форма пути обязательна: git отвечает ею, а панель сравнивает пути.
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-qa-wt-')));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git('init', '--initial-branch=main');
  git('config', 'user.email', 'qa@example.invalid');
  git('config', 'user.name', 'QA');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'file.txt'), 'первый\n');
  // Lock-файл в индексе: фиктивная установка его переписывает, панель откатывает.
  writeFileSync(join(dir, 'package-lock.json'), '{"lockfileVersion":3}\n');
  writeFileSync(join(dir, '.gitignore'), '.claude/\n.env\nnode_modules/\n.venv/\n.vault/\n');
  writeFileSync(join(dir, '.mcp.json'), '{"shared":true}\n');
  // Отслеживаемый файл из списка БЕЗ флага: в чекауте копии лежала бы эта,
  // закоммиченная версия — четвёртый источник зеркала как раз про неё.
  writeFileSync(join(dir, '.env.example'), 'ВЕРСИЯ=коммита\n');
  // `-f`: у человека `.mcp.json` может стоять в глобальном ignore — тест про
  // отслеживаемый файл под флагом, а не про его ignore-статус.
  git('add', '-A', '-f');
  git('commit', '-m', 'первый');
  // Локальный слой: правка под skip-worktree и игнорируемое разного рода.
  writeFileSync(join(dir, '.mcp.json'), '{"local":true}\n');
  git('update-index', '--skip-worktree', '.mcp.json');
  writeFileSync(join(dir, '.env.example'), 'ВЕРСИЯ=рабочая\n');
  // Неотслеживаемый и НЕ игнорируемый: git молчит о нём и списку флагов, и
  // списку игнорируемого — до третьего источника копия оставалась без него.
  writeFileSync(join(dir, 'CLAUDE.local.md'), 'мои правила\n');
  // Незакоммиченная работа ВНЕ списка: её зеркало трогать не вправе.
  writeFileSync(join(dir, 'scratch.ts'), 'export const x = 1;\n');
  mkdirSync(join(dir, '.claude', 'skills'), { recursive: true });
  writeFileSync(join(dir, '.claude', 'settings.local.json'), '{"permissions":{}}\n');
  writeFileSync(join(dir, '.claude', 'skills', 'review.md'), 'версия оригинала\n');
  writeFileSync(join(dir, '.env'), 'SECRET=1\n');
  mkdirSync(join(dir, 'node_modules'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', 'x.js'), '// deps\n');
  // `.venv/` — из закрытого списка сборочных каталогов: его не доносит и шаблон.
  mkdirSync(join(dir, '.venv', 'bin'), { recursive: true });
  writeFileSync(join(dir, '.venv', 'bin', 'python'), '');
  // `.vault/` — просто игнорируемое, которого нет во встроенном списке: его
  // панель называет «за бортом», и шаблон человека его доносит.
  mkdirSync(join(dir, '.vault'), { recursive: true });
  writeFileSync(join(dir, '.vault', 'token.txt'), 'секрет стенда\n');
  return dir;
}

const gitOut = (dir, ...args) =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true });

function drop(target) {
  try {
    rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    // Каталог остаётся в temp и уйдёт с ОС — на результат это не влияет.
  }
}

const repo = makeRepo();
const copies = join(dirname(repo), `${basename(repo)}-worktrees`);
const copy = join(copies, 'feature-qa-parallel');

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await bypassOnboarding(page);

// Вкладку проекта ставим прямо в хранилище: прогон про копии, а не про то, как
// открывается проект.
await page.addInitScript(
  ([path]) => {
    const id = path.replace(/\\/g, '/').toLowerCase();
    localStorage.setItem(
      'agentdeck:workspace',
      JSON.stringify({ projectTabs: [{ id, path, name: 'qa-repo' }], activeTabId: id, views: {} }),
    );
  },
  [repo],
);

try {
  // networkidle не наступает: панель держит открытый поток /api/events.
  await page.goto(`${BASE}/chat`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: /main/ }).first().click();

  const section = page.getByRole('dialog').getByLabel('Параллельные ветки');
  await section.waitFor({ timeout: 10_000 });
  check(
    (await section.getByTitle(repo).count()) > 0,
    'основная копия видна в списке до всякого создания',
  );

  // Команда подготовки — до создания копии: она идёт сразу после зеркала.
  const NODE = process.execPath.includes(' ') ? `"${process.execPath}"` : process.execPath;
  const dialog = page.getByRole('dialog');
  const saveSettings = async () => {
    await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
    // Сохранилось — черновик сброшен, кнопка снова неактивна.
    await dialog
      .getByRole('button', { name: 'Сохранить', exact: true, disabled: true })
      .waitFor({ timeout: 10_000 });
  };
  await dialog.getByRole('button', { name: 'Настройка копий' }).click();
  const commandField = dialog.getByLabel('Команда после создания копии');
  await commandField.waitFor({ timeout: 10_000 });
  await commandField.fill(
    `${NODE} -e "require('fs').writeFileSync('package-lock.json','churn');console.log('BOOT-OK')"`,
  );
  await saveSettings();

  await page.getByPlaceholder('feature/имя ветки').fill(BRANCH);
  await page.getByRole('button', { name: 'Завести копию' }).click();

  await page.waitForFunction(
    (path) =>
      (JSON.parse(localStorage.getItem('agentdeck:workspace') ?? '{}').projectTabs ?? []).some(
        (tab) => tab.path === path,
      ),
    copy,
    { timeout: 30_000 },
  );
  check(true, 'копия открылась своей вкладкой проекта');
  check(existsSync(copy), `каталог копии создан рядом с проектом (${copy})`);
  check(
    (await page.getByRole('tab', { name: 'feature-qa-parallel' }).count()) > 0 ||
      (await page.getByText('feature-qa-parallel', { exact: false }).count()) > 0,
    'вкладка подписана именем копии',
  );

  // Локальный слой переехал без единого вопроса.
  check(
    existsSync(join(copy, '.mcp.json')) &&
      readFileSync(join(copy, '.mcp.json'), 'utf8').includes('"local"'),
    'копия получила .mcp.json с МЕСТНОЙ правкой, а не версию из коммита',
  );
  check(
    gitOut(copy, 'ls-files', '-v', '--', '.mcp.json').startsWith('S'),
    'флаг skip-worktree поставлен и в копии',
  );
  // Неотслеживаемое и не игнорируемое: третий источник зеркала.
  check(
    existsSync(join(copy, 'CLAUDE.local.md')) &&
      readFileSync(join(copy, 'CLAUDE.local.md'), 'utf8') === 'мои правила\n',
    'копия получила CLAUDE.local.md — неотслеживаемый и НЕ игнорируемый файл',
  );
  // Отслеживаемое с местной правкой: четвёртый источник. Версия коммита в
  // копии — это чужие настройки под видом своих, поэтому сравниваем содержимое.
  check(
    readFileSync(join(copy, '.env.example'), 'utf8') === 'ВЕРСИЯ=рабочая\n',
    'отслеживаемый .env.example приехал РАБОЧЕЙ версией, а не версией коммита',
  );
  check(
    !existsSync(join(copy, 'scratch.ts')),
    'незакоммиченная работа вне списка (scratch.ts) в копию не поехала',
  );
  // Копия «грязна» ровно тем же, чем оригинал: локальным слоем, и ничем сверх.
  // Пустого `git status` тут быть не может — источники 3 и 4 на то и источники.
  const porcelain = gitOut(copy, 'status', '--porcelain')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .sort()
    .join('|');
  check(
    porcelain === '?? CLAUDE.local.md|M .env.example',
    'в копии значится ровно локальный слой и ничего сверх него',
    `git status: ${porcelain || '(пусто)'}`,
  );
  check(
    existsSync(join(copy, '.claude', 'settings.local.json')),
    'копия получила .claude/settings.local.json',
  );
  // Скиллы — ССЫЛКА: правка в оригинале обязана быть видна копии сразу, иначе
  // агент в копии работает по вчерашним правилам.
  check(
    lstatSync(join(copy, '.claude', 'skills')).isSymbolicLink(),
    '.claude/skills в копии — ссылка, а не отдельная копия каталога',
  );
  writeFileSync(join(repo, '.claude', 'skills', 'review.md'), 'поправили скилл\n');
  check(
    readFileSync(join(copy, '.claude', 'skills', 'review.md'), 'utf8') === 'поправили скилл\n',
    'правка скилла в оригинале видна в копии сразу, без повторного зеркала',
  );
  check(existsSync(join(copy, '.env')), 'копия получила .env');
  check(!existsSync(join(copy, 'node_modules')), 'node_modules в копию не переехал');
  check(!existsSync(join(copy, '.vault')), '.vault/ без шаблона в копию не переехал');

  // Возвращаемся в основную копию и убираем созданную.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.evaluate(
    ([id]) => {
      const state = JSON.parse(localStorage.getItem('agentdeck:workspace') ?? '{}');
      state.activeTabId = id;
      localStorage.setItem('agentdeck:workspace', JSON.stringify(state));
    },
    [repo.replace(/\\/g, '/').toLowerCase()],
  );
  await page.reload({ waitUntil: 'domcontentloaded' });

  await page.getByRole('button', { name: /main/ }).first().click();
  const list = page.getByRole('dialog').getByLabel('Параллельные ветки');
  await list.waitFor({ timeout: 10_000 });
  check((await list.getByTitle(copy).count()) > 0, 'копия видна в списке из основного репозитория');

  // Бутстрап отработал: значок и лог.
  await list.getByText('зависимости есть').first().waitFor({ timeout: 30_000 });
  check(true, 'бутстрап копии дошёл до «зависимости есть»');
  await list.getByRole('button', { name: 'Лог', exact: true }).first().click();
  await list.getByText('BOOT-OK').first().waitFor({ timeout: 10_000 });
  check(true, 'лог бутстрапа виден на карточке');
  check(
    readFileSync(join(copy, 'package-lock.json'), 'utf8').includes('lockfileVersion'),
    'переписанный установкой lock-файл откачен к версии из индекса',
  );
  check(
    (await list.getByText('откачены: package-lock.json').count()) > 0,
    'откат lock-файла назван на карточке',
  );

  // Провальная команда: значок «не удалась» с кодом, копия на месте.
  await dialog.getByRole('button', { name: 'Настройка копий' }).click();
  await commandField.waitFor({ timeout: 10_000 });
  await commandField.fill(`${NODE} -e "process.exit(3)"`);
  await saveSettings();
  await list.getByRole('button', { name: 'Повторить установку' }).first().click();
  await list.getByText('установка не удалась').first().waitFor({ timeout: 30_000 });
  check((await list.getByText('код 3').count()) > 0, 'провал бутстрапа показан с кодом выхода');
  check(existsSync(copy), 'провал бутстрапа копию не трогает');
  // Команда хранится по проекту в панели — снимаем, чтобы temp-путь не остался в state.json.
  await commandField.fill('');
  await saveSettings();

  // Повторное зеркало: отчёт называет .vault/ за бортом.
  await list.getByRole('button', { name: 'Обновить локальный слой' }).first().click();
  const report = list.getByLabel('Локальный слой');
  await report.waitFor({ timeout: 15_000 });
  check((await report.getByText('.vault/').count()) > 0, 'отчёт называет .vault/ за бортом');

  // Дописанный шаблон доносит .vault/ следующим зеркалом — но не .venv/: тот в
  // закрытом списке сборочных каталогов, и шаблон человека его не открывает.
  // Раскрывашка «Настройка копий» уже открыта с шага бутстрапа.
  const includeField = dialog.getByLabel('Переносить ещё');
  await includeField.waitFor({ timeout: 10_000 });
  await includeField.fill('.vault/**\n.venv/**');
  await saveSettings();
  await list.getByRole('button', { name: 'Обновить локальный слой' }).first().click();
  await page.waitForFunction(
    (path) => {
      const node = document.querySelector('[aria-label="Локальный слой"]');
      return node !== null && node.textContent.includes(path);
    },
    '.vault/token.txt',
    { timeout: 15_000 },
  );
  check(existsSync(join(copy, '.vault', 'token.txt')), 'после шаблона .vault/ переехал в копию');
  check(
    !existsSync(join(copy, '.venv')),
    '.venv/ не доносит и шаблон: закрытый список сборочных каталогов сильнее',
  );
  // Шаблон хранится по проекту в панели — снимаем, чтобы temp-путь не остался в state.json.
  await includeField.fill('');
  await saveSettings();

  // Копия с локальным слоем ГРЯЗНА по git с первой секунды жизни — источники 3
  // и 4 кладут в неё неотслеживаемое и изменённое. Поэтому обычное «Убрать»
  // отказывает, а панель показывает вторую, красную кнопку: это и есть штатный
  // путь уборки копии после доработки зеркала, его и проверяем.
  await page.getByRole('button', { name: 'Убрать', exact: true }).first().click();
  const removeForce = page.getByRole('button', { name: 'Убрать вместе с правками' }).first();
  await removeForce.waitFor({ timeout: 20_000 });
  check(true, 'обычное «Убрать» отказало и панель предложила убрать вместе с правками');
  await removeForce.click();
  await page.waitForFunction((path) => !document.body.innerText.includes(path), copy, {
    timeout: 30_000,
  });
  check(!existsSync(join(copy, 'file.txt')), 'рабочее дерево копии убрано');
  // Главное про ссылку при уборке: git не идёт сквозь junction. Пойди он —
  // «убрал копию» означало бы стёртые скиллы ОРИГИНАЛА, и заметили бы это не
  // здесь, а в следующем разговоре агента.
  check(
    readFileSync(join(repo, '.claude', 'skills', 'review.md'), 'utf8') === 'поправили скилл\n',
    'скиллы оригинала уборку копии пережили — сквозь ссылку ничего не удалено',
  );
  if (existsSync(copy)) {
    console.log(
      `⚠ каталог копии остался оболочкой (${readdirSync(copy).join(', ')}): ` +
        '`git worktree remove --force` не удаляет junction и молча выходит с нулём, ' +
        'а повторное «Завести копию» той же ветки упрётся в «already exists»',
    );
  }
  check(existsSync(repo), 'основной репозиторий не тронут');
} finally {
  await browser.close();
  drop(copies);
  drop(repo);
}

console.log(failures.length ? `\nПровалено: ${failures.length}` : '\nВсё сошлось');
process.exit(failures.length ? 1 : 0);
