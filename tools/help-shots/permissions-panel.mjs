/**
 * Кадры путеводителей «Права», «MCP-серверы» и «Переменные» — одной съёмкой.
 *
 * Разделов три, и все три про один вопрос: что агенту разрешено и чем он для
 * этого располагает. Право `mcp__orders__refund_order` бессмысленно без сервера
 * `orders`, а сервер не поднимется без токена из `.mcp-secrets.env`. Снимать их
 * порознь значило бы трижды поднимать один и тот же стенд с одной и той же
 * обстановкой — и трижды по-разному.
 *
 * Сценарии делятся по входу, а не по объёму:
 *
 *   permissions/setup   — компьютер чистый: что Claude Code с ним делает, как
 *                         закрыть опасное и почему «Разрешено» иногда не значит
 *                         разрешено.
 *   permissions/audit   — прав уже много: поиск, вкладка MCP, локальный файл,
 *                         выключение без потери и удаление.
 *   mcp/connect         — сервера нет: форма, заготовки, вставка чужого JSON,
 *                         первая проверка связи и отбор инструментов в права.
 *   mcp/trouble         — сервер не отвечает: четыре разные причины и что панель
 *                         про каждую говорит.
 *   env/secret          — нужен токен: куда он ляжет, почему скрыт и как его
 *                         показать и переписать.
 *   env/bulk            — переменных много: вставка целого .env, локальный файл
 *                         и переменная, которой владеет группа.
 *
 * СТЕНД ОДНОРАЗОВЫЙ, и для этой пачки это не формальность: её предмет — файлы
 * доступа. `CLAUDE_CONFIG_DIR` уводится в соседний каталог, домашний каталог
 * подменяется (он виден в карточке системы), и панель делает с этими файлами всё
 * по-настоящему: пишет права, гасит их, переносит между файлами, маскирует
 * секреты, ведёт рукопожатие MCP.
 *
 * НЕ ПОДМЕНЯЕТСЯ НИ ОДИН ОТВЕТ СЕРВЕРА. Единственное, что добавлено к съёмке, —
 * два процесса, которые изображают чужие MCP-серверы: `demo-mcp-server.mjs` по
 * stdio и он же в режиме `--unauthorized`, отвечающий 401. Всё остальное в кадре
 * панель посчитала сама.
 *
 * Запуск: node tools/help-shots/permissions-panel.mjs
 * Переменные: GUIDE_PANEL_PORT (5194), GUIDE_WEB_PORT (8904),
 *             GUIDE_ONLY (имя одного сценария: setup, audit, connect…).
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { openScenario, applyShotLanguage } from './kit.mjs';
import { CONFIG_DIR, HOME_DIR, makeStand, dropStand } from './access-fixture.mjs';
import { shootSetup, shootAudit } from './access-permissions.mjs';
import { shootConnect, shootTrouble } from './access-mcp.mjs';
import { shootSecret, shootBulk } from './access-env.mjs';

const PANEL_PORT = Number(process.env.GUIDE_PANEL_PORT ?? 5194);
const WEB_PORT = Number(process.env.GUIDE_WEB_PORT ?? 8904);
/** Порт, на котором сидит сервер, отвечающий 401: кадр «нужна авторизация». */
const OAUTH_PORT = Number(process.env.GUIDE_OAUTH_PORT ?? 5196);
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
makeStand();

try {
  const env = {
    ...process.env,
    CLAUDE_CONFIG_DIR: CONFIG_DIR,
    PORT: String(PANEL_PORT),
    WEB_PORT: String(WEB_PORT),
    // Домашний каталог виден в карточке системы раздела «Права»: настоящий
    // начинается с имени владельца машины, а кадры уезжают в git.
    HOME: HOME_DIR,
    USERPROFILE: HOME_DIR,
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
  await applyShotLanguage(PANEL);

  // Сервер, который на всё отвечает 401 с заголовком WWW-Authenticate. Панель
  // выводит «нужна авторизация» из НАСТОЯЩЕГО отказа, а не из настройки записи.
  started.push(
    spawn(
      process.execPath,
      [join(import.meta.dirname, 'demo-mcp-server.mjs'), '--unauthorized', String(OAUTH_PORT)],
      { stdio: 'ignore', shell: false },
    ),
  );

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
        // BROWSER=none — иначе Vite откроет окно поверх съёмки. Домашний каталог
        // фронту подменять нельзя: там кэш сборщика.
        env: { ...process.env, API_PORT: String(PANEL_PORT), BROWSER: 'none' },
        stdio: 'ignore',
        shell: false,
      },
    ),
  );
  if (!(await waitFor(WEB, 90))) throw new Error('фронт одноразовой панели не поднялся');
  console.log(`фронт на ${WEB}`);

  const browser = await chromium.launch();
  // GUIDE_ONLY сужает съёмку до одного сценария: правка селектора в конце пути
  // иначе проверяется полным прогоном всех шести.
  const only = process.env.GUIDE_ONLY ?? '';
  const run = async (topic, name, shoot) => {
    if (only && only !== name) return;
    const scenario = openScenario(topic, name);
    console.log(`\nсценарий ${topic}/${name}`);
    await shoot(browser, WEB, scenario, { oauthPort: OAUTH_PORT, panel: `${PANEL}` });
    scenario.finish();
  };

  try {
    // Порядок важен: сценарии переписывают одни и те же файлы доступа, и каждый
    // начинается с того, что кладёт нужное ему состояние.
    await run('permissions', 'setup', shootSetup);
    await run('permissions', 'audit', shootAudit);
    await run('mcp', 'connect', shootConnect);
    await run('mcp', 'trouble', shootTrouble);
    await run('env', 'secret', shootSecret);
    await run('env', 'bulk', shootBulk);
  } finally {
    await browser.close();
  }
} finally {
  for (const child of started) child.kill();
  dropStand();
}
