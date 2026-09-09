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
 * У репозитория есть локальный слой — `.mcp.json` под skip-worktree с местной
 * правкой, игнорируемые `.claude/settings.local.json`, `.env`, `node_modules/`,
 * `.venv/`. Проверяется, что копия получает слой (и флаг) без вопросов и без
 * `node_modules`, что отчёт называет `.venv/` за бортом, а дописанный шаблон
 * доносит его повторным зеркалом. Бутстрап — фиктивной командой `node -e`:
 * удачная даёт значок «зависимости есть» и лог, провальная — «установка не
 * удалась» с кодом, и ни та ни другая копию не ломает.
 *
 * Нужен живой `pnpm dev`. Запуск: `node tools/qa/check-worktrees.mjs`.
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
  writeFileSync(join(dir, '.gitignore'), '.claude/\n.env\nnode_modules/\n.venv/\n');
  writeFileSync(join(dir, '.mcp.json'), '{"shared":true}\n');
  // `-f`: у человека `.mcp.json` может стоять в глобальном ignore — тест про
  // отслеживаемый файл под флагом, а не про его ignore-статус.
  git('add', '-A', '-f');
  git('commit', '-m', 'первый');
  // Локальный слой: правка под skip-worktree и игнорируемое разного рода.
  writeFileSync(join(dir, '.mcp.json'), '{"local":true}\n');
  git('update-index', '--skip-worktree', '.mcp.json');
  mkdirSync(join(dir, '.claude'), { recursive: true });
  writeFileSync(join(dir, '.claude', 'settings.local.json'), '{"permissions":{}}\n');
  writeFileSync(join(dir, '.env'), 'SECRET=1\n');
  mkdirSync(join(dir, 'node_modules'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', 'x.js'), '// deps\n');
  mkdirSync(join(dir, '.venv', 'bin'), { recursive: true });
  writeFileSync(join(dir, '.venv', 'bin', 'python'), '');
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
  check(gitOut(copy, 'status', '--porcelain').trim() === '', 'копия чистая по git status');
  check(
    existsSync(join(copy, '.claude', 'settings.local.json')),
    'копия получила .claude/settings.local.json',
  );
  check(existsSync(join(copy, '.env')), 'копия получила .env');
  check(!existsSync(join(copy, 'node_modules')), 'node_modules в копию не переехал');
  check(!existsSync(join(copy, '.venv')), '.venv/ без шаблона в копию не переехал');

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

  // Повторное зеркало: отчёт называет .venv/ за бортом.
  await list.getByRole('button', { name: 'Обновить локальный слой' }).first().click();
  const report = list.getByLabel('Локальный слой');
  await report.waitFor({ timeout: 15_000 });
  check((await report.getByText('.venv/').count()) > 0, 'отчёт называет .venv/ за бортом');

  // Дописанный шаблон доносит .venv/ следующим зеркалом.
  // Раскрывашка «Настройка копий» уже открыта с шага бутстрапа.
  const includeField = dialog.getByLabel('Переносить ещё');
  await includeField.waitFor({ timeout: 10_000 });
  await includeField.fill('.venv/**');
  await saveSettings();
  await list.getByRole('button', { name: 'Обновить локальный слой' }).first().click();
  await page.waitForFunction(
    (path) => {
      const node = document.querySelector('[aria-label="Локальный слой"]');
      return node !== null && node.textContent.includes(path);
    },
    '.venv/bin/python',
    { timeout: 15_000 },
  );
  check(existsSync(join(copy, '.venv', 'bin', 'python')), 'после шаблона .venv/ переехал в копию');
  // Шаблон хранится по проекту в панели — снимаем, чтобы temp-путь не остался в state.json.
  await includeField.fill('');
  await saveSettings();

  await page.getByRole('button', { name: 'Убрать', exact: true }).first().click();
  await page.waitForFunction((path) => !document.body.innerText.includes(path), copy, {
    timeout: 30_000,
  });
  check(!existsSync(copy), 'копия убрана вместе с каталогом');
  check(existsSync(repo), 'основной репозиторий не тронут');
} finally {
  await browser.close();
  drop(copies);
  drop(repo);
}

console.log(failures.length ? `\nПровалено: ${failures.length}` : '\nВсё сошлось');
process.exit(failures.length ? 1 : 0);
