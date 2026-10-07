/**
 * Кадры путеводителя «Набор панели»: один сценарий `kit/page`.
 *
 * ПАНЕЛЬ ОДНОРАЗОВАЯ: каталог конфигурации во временной папке, свои порты, свой
 * фронт. Ничего не подменяется — `/api/kit` настоящий, над настоящим встроенным
 * набором приложения. Глобальный слой — временная папка, засеянная тремя
 * случаями, ради которых страница существует: одноимённый навык с другим
 * текстом, свои команда и субагент, которых в наборе нет.
 *
 * Запуск: node tools/help-shots/kit-panel.mjs
 * Переменные: GUIDE_PANEL_PORT (5229), GUIDE_WEB_PORT (8939), GUIDE_LANG, GUIDE_THEME.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { openScenario, applyShotLanguage } from './kit.mjs';
import { settings } from './chat-stubs.mjs';

const PANEL_PORT = Number(process.env.GUIDE_PANEL_PORT ?? 5229);
const WEB_PORT = Number(process.env.GUIDE_WEB_PORT ?? 8939);
const PANEL = `http://127.0.0.1:${PANEL_PORT}`;
const WEB = `http://127.0.0.1:${WEB_PORT}`;

/**
 * Три соседние по алфавиту строки навыков — три состояния сверки на одном
 * кадре: своя версия в глобальном (TWIN), та же версия (SAME) и правка
 * человека поверх встроенного (EDITED, через настоящий PUT /api/kit/item).
 */
const TWIN = 'read-before-edit';
const EDITED = 'refactor-code-health';
const SAME = 'report-honestly';
const BUILTIN = join(process.cwd(), 'apps', 'server', 'assets', 'kit', 'agentdeck-kit');

async function waitFor(url, seconds) {
  for (let i = 0; i < seconds * 2; i += 1) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status === 401) return true;
    } catch {
      /* ещё не поднялось */
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

function put(root, rel, text) {
  const path = join(root, rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text, 'utf8');
}

function seedGlobal(home) {
  put(
    home,
    `skills/${SAME}/SKILL.md`,
    readFileSync(join(BUILTIN, 'skills', SAME, 'SKILL.md'), 'utf8'),
  );
  put(
    home,
    `skills/${TWIN}/SKILL.md`,
    '---\nname: read-before-edit\ndescription: Read the file before editing it\n---\n\n' +
      'Read the whole file before any edit.\nNever edit from memory.\n',
  );
  put(
    home,
    'commands/release-notes.md',
    '---\ndescription: Draft release notes from merged changes\n---\n\nCollect merged changes and group them.\n',
  );
  put(
    home,
    'agents/api-reviewer.md',
    '---\nname: api-reviewer\ndescription: Reviews API changes for breaking shapes\n---\n\nCompare request and response shapes.\n',
  );
}

const region = (ru, en) =>
  `[role="region"][aria-label="${ru}"], [role="region"][aria-label="${en}"]`;
const MODES = region('Кто получает набор', 'Who gets the kit');

async function shootPage(browser, web, scenario) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  // Ошибка рендера иначе видна только как таймаут ожидания карточки.
  page.on('pageerror', (error) => console.log(`  ошибка страницы: ${error.message}`));
  try {
    await settings(page);
    await page.goto(`${web}/kit`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector(MODES);
    await page.waitForTimeout(1200);

    // ── 01. Режим на каждый CLI ─────────────────────────────────────────────
    await scenario.shot(page, '01-modes', { clip: MODES, padding: 12 });

    // ── 02. Навыки: происхождение, сверка, перенос ─────────────────────────
    // Окно, а не область: три нужные строки идут подряд, и окно с них
    // начинается — без вырезания строк из настоящего списка.
    await page.setViewportSize({ width: 1440, height: 720 });
    await page
      .locator('li', { hasText: TWIN })
      .first()
      .evaluate((el) => {
        el.scrollIntoView({ block: 'start' });
        // Прокручивается контейнер страницы, а не окно; полоса вкладок над ним
        // липкая — строку опускаем под неё, иначе шапка строки скрыта.
        let box = el.parentElement;
        while (box && box.scrollHeight <= box.clientHeight) box = box.parentElement;
        (box ?? document.scrollingElement)?.scrollBy(0, -90);
      });
    await page.waitForTimeout(400);
    await scenario.shot(page, '02-items');
    await page.setViewportSize({ width: 1440, height: 1100 });

    // ── 03. Разница с глобальным ────────────────────────────────────────────
    const row = page.locator('li', { hasText: TWIN }).first();
    await row.getByRole('button', { name: /^(Открыть|Open)$/ }).click();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    await dialog.getByRole('button', { name: /^(Разница|Difference)$/ }).click();
    await page.waitForTimeout(600);
    await scenario.shot(page, '03-diff', { clip: '[role="dialog"]', padding: 0 });
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });

    // ── 04. Только в глобальном слое ────────────────────────────────────────
    // Вкладка — по адресу: у ярлыка вкладки есть счётчик, и имя кнопки плавает.
    await page.goto(`${web}/kit?tab=agent`, { waitUntil: 'domcontentloaded' });
    const only = region('Есть только в глобальном слое', 'Only in the global layer');
    await page.waitForSelector(only);
    await page.locator(only).first().scrollIntoViewIfNeeded();
    await scenario.shot(page, '04-global-only', { clip: only, padding: 12 });
  } finally {
    await page.close();
  }
}

const started = [];
const home = mkdtempSync(join(tmpdir(), 'cc-kit-guide-'));
mkdirSync(join(home, 'agentdeck'), { recursive: true });
writeFileSync(join(home, 'settings.json'), '{}\n', 'utf8');
writeFileSync(join(home, 'CLAUDE.md'), '# путеводитель\n', 'utf8');
seedGlobal(home);

try {
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
      { env, stdio: 'ignore', shell: false },
    ),
  );
  if (!(await waitFor(`${PANEL}/api/system`, 40)))
    throw new Error('одноразовая панель не поднялась');
  console.log(`панель на ${PANEL}`);
  await applyShotLanguage(PANEL);
  const edited = `skills/${EDITED}/SKILL.md`;
  const text = readFileSync(join(BUILTIN, edited), 'utf8');
  const saved = await fetch(`${PANEL}/api/kit/item`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: edited,
      content: `${text}\n- Keep each refactor step reviewable on its own.\n`,
    }),
  });
  if (!saved.ok) throw new Error(`правка ${edited}: ${saved.status}`);

  started.push(
    spawn(
      'node',
      [
        join('node_modules', 'vite', 'bin', 'vite.js'),
        '--port',
        String(WEB_PORT),
        '--strictPort',
        '--host',
        '127.0.0.1',
      ],
      {
        cwd: join(process.cwd(), 'apps', 'web'),
        // BROWSER=none — иначе Vite откроет окно поверх съёмки.
        env: { ...env, API_PORT: String(PANEL_PORT), BROWSER: 'none' },
        stdio: 'ignore',
        shell: false,
      },
    ),
  );
  if (!(await waitFor(WEB, 90))) throw new Error('фронт одноразовой панели не поднялся');
  console.log(`фронт на ${WEB}`);

  const browser = await chromium.launch();
  try {
    const scenario = openScenario('kit', 'page');
    console.log('\nсценарий kit/page');
    await shootPage(browser, WEB, scenario);
    scenario.finish();
  } finally {
    await browser.close();
  }
} finally {
  for (const child of started) child.kill();
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
