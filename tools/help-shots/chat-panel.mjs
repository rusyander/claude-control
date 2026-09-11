/**
 * Кадры путеводителя «Чат»: два сценария одной съёмкой.
 *
 * `basics` — путь ОДНОГО разговора: пустой чат проекта, вопрос с вложением,
 * живой ответ с шагами и расходом, запрос прав, вопрос агента, пульт git,
 * меню чата, пульт агентов, продолжение в чистой сессии и окно кода.
 *
 * `split` — путь, на котором один разговор становится несколькими: карточка
 * разделения, дерево чатов, сводка групп у родителя, вопросы и права детей,
 * сверка веток, пауза дерева и параллельные копии репозитория.
 *
 * Разделены они не по объёму, а по входу: человек, который никогда не делит
 * задачи, второй сценарий не откроет вовсе, а первый читает подряд с первого
 * дня.
 *
 * ПАНЕЛЬ ОДНОРАЗОВАЯ: каталог конфигурации во временной папке, свои порты, свой
 * фронт. Рабочий стенд не трогается. Данные подменяются целиком на уровне
 * браузера (`page.route`), как в `tools/qa/check-*.mjs`: настоящий прогон
 * потребовал бы установленного CLI, живой модели и оставлял бы за собой ветки
 * на диске. Ни одного экрана, которого нет в панели, здесь не выдумано —
 * подменены только ответы сервера.
 *
 * Запуск: node tools/help-shots/chat-panel.mjs
 * Переменные: GUIDE_PANEL_PORT (5193), GUIDE_WEB_PORT (8901).
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { openScenario } from './kit.mjs';
import { shootBasics } from './chat-basics.mjs';
import { shootSplit } from './chat-split.mjs';

const PANEL_PORT = Number(process.env.GUIDE_PANEL_PORT ?? 5193);
const WEB_PORT = Number(process.env.GUIDE_WEB_PORT ?? 8901);
const PANEL = `http://127.0.0.1:${PANEL_PORT}`;
const WEB = `http://127.0.0.1:${WEB_PORT}`;

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

const started = [];
const home = mkdtempSync(join(tmpdir(), 'cc-chat-guide-'));
mkdirSync(join(home, 'agentdeck'), { recursive: true });
writeFileSync(join(home, 'settings.json'), '{}\n', 'utf8');
writeFileSync(join(home, 'CLAUDE.md'), '# путеводитель\n', 'utf8');

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
  // GUIDE_ONLY сужает съёмку до одного сценария: правка селектора в конце пути
  // иначе проверяется полным прогоном обоих.
  const only = process.env.GUIDE_ONLY ?? '';
  try {
    if (!only || only === 'basics') {
      const basics = openScenario('chat', 'basics');
      console.log('\nсценарий basics');
      await shootBasics(browser, WEB, basics, home);
      basics.finish();
    }

    if (!only || only === 'split') {
      const split = openScenario('chat', 'split');
      console.log('\nсценарий split');
      await shootSplit(browser, WEB, split);
      split.finish();
    }
  } finally {
    await browser.close();
  }
} finally {
  for (const child of started) child.kill();
  rmSync(home, { recursive: true, force: true });
}
