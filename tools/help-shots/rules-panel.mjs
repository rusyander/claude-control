/**
 * Кадры путеводителей «Правила» и «CLAUDE.md»: четыре сценария одной съёмкой.
 *
 * Разделов в пачке два, и оба про один файл — личный `CLAUDE.md`. Раздел
 * «Правила» разбирает его на карточки, раздел «CLAUDE.md» открывает целиком;
 * снимать их порознь значило бы дважды поднимать один и тот же стенд с одной и
 * той же обстановкой.
 *
 * Сценарии делятся по входу, а не по объёму:
 *
 *   rules/first     — человек пишет первое правило: пустой раздел, три способа
 *                     ввода, помощник, сохранённая карточка, проверка в песочнице.
 *   rules/living    — правила уже есть: список и поиск, выключение без потери
 *                     текста, «0 правил» на файле, размеченном обычными «## ».
 *   claudeMd/file   — файл целиком: редактор, несохранённые правки, расхождение
 *                     с диском после чужой записи.
 *   claudeMd/layers — почему правило не сработало: те же инструкции уровнем
 *                     проекта и собственный `.claude` репозитория.
 *
 * ПАНЕЛЬ ОДНОРАЗОВАЯ, и для этой пачки это не формальность: её предмет —
 * файлы конфигурации. `CLAUDE_CONFIG_DIR` уводится во временную папку, туда же
 * кладётся выдуманный `CLAUDE.md`, и панель делает с ним всё по-настоящему:
 * разбирает, переключает, пересобирает, кладёт резервную копию. Личный
 * `~/.claude` владельца машины не читается и не правится ни на шаг.
 *
 * Подменяются ровно два ответа, за которыми иначе стоял бы установленный CLI и
 * живая модель: помощник формы (`/api/assistant/*`) и прогон песочницы
 * (`/api/sandbox/*`). Всё остальное в кадре — настоящий ответ сервера панели.
 *
 * Запуск: node tools/help-shots/rules-panel.mjs
 * Переменные: GUIDE_PANEL_PORT (5191), GUIDE_WEB_PORT (8901),
 *             GUIDE_ONLY (имя одного сценария).
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { openScenario, applyShotLanguage } from './kit.mjs';
import { makeHome, makeProject, dropProject, PROJECT_DIR } from './rules-fixture.mjs';
import { shootFirst } from './rules-first.mjs';
import { shootLiving } from './rules-living.mjs';
import { shootFile } from './claudemd-file.mjs';
import { shootLayers } from './claudemd-layers.mjs';

const PANEL_PORT = Number(process.env.GUIDE_PANEL_PORT ?? 5191);
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
const home = mkdtempSync(join(tmpdir(), 'cc-rules-guide-'));
makeProject();
makeHome(home, { projects: [{ id: 'orders', name: 'Панель заказов', path: PROJECT_DIR }] });

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

  // Язык — до первого кадра и через настройки панели, а не через i18n в
  // странице: кадр должен доказывать тот путь, по которому язык приходит
  // человеку. `GUIDE_LANG=en` → английские кадры рядом с русскими.
  const lang = await applyShotLanguage(PANEL);

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
  // иначе проверяется полным прогоном всех четырёх.
  const only = process.env.GUIDE_ONLY ?? '';
  const run = async (topic, name, shoot) => {
    if (only && only !== name) return;
    const scenario = openScenario(topic, name);
    console.log(`\nсценарий ${topic}/${name}`);
    await shoot(browser, WEB, scenario, home, lang);
    scenario.finish();
  };

  try {
    // Порядок важен: сценарии переписывают один и тот же CLAUDE.md, и каждый
    // начинается с того, что кладёт нужное ему состояние файла.
    await run('rules', 'first', shootFirst);
    await run('rules', 'living', shootLiving);
    await run('claudeMd', 'file', shootFile);
    await run('claudeMd', 'layers', shootLayers);
  } finally {
    await browser.close();
  }
} finally {
  for (const child of started) child.kill();
  rmSync(home, { recursive: true, force: true });
  dropProject();
}
