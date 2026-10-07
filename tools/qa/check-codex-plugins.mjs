/**
 * Плагины Codex в разделе «Плагины» (MAP 25) — настоящим codex через настоящую
 * панель.
 *
 * Панель ничего не кладёт в кэш плагинов сама: она зовёт `codex plugin
 * marketplace add|remove`, `codex plugin add|remove` и правит одну строку
 * `enabled` в `[plugins."имя@рынок"]` config.toml. Вопрос — делает ли это то,
 * что обещает экран. Сценарии:
 *   1. раздел виден как плагины Codex (`codex-plugins`, действия разрешены),
 *      списки пусты, CLI ответил без ошибки;
 *   2. отказы до CLI: селектор `--help` — 400, чужой плагин — 404, файловый
 *      маршрут — 409; кэш плагинов не появился;
 *   3. подключение локального рынка (формат Claude `.claude-plugin/
 *      marketplace.json`) — рынок в сводке, плагин в «можно поставить»;
 *   4. установка — сводка: поставлен, включён, скиллы и описание из манифеста;
 *   5. свидетель CLI: app-server `skills/list` видит скилл плагина — плагин
 *      действует;
 *   6. выключение панелью — config.toml `enabled = false`, остальное байт-в-байт,
 *      `codex plugin list` говорит выключен, скилла у app-server нет; включение —
 *      скилл вернулся (без этой пары проверка «выключено» не умела бы краснеть);
 *   7. несуществующий плагин — 422 словами CLI;
 *   8. удаление плагина и рынка — списки пусты, кэша плагина нет.
 *
 * Подменено ничего: модели не нужно, всё — локальные команды CLI. CLI — из
 * `STEER_CLI_DIR`, иначе из PATH; нет — «не проверено», код 2. `CODEX_HOME` и дом
 * панели — временные каталоги, настоящий `~/.codex` не трогается.
 *
 * Запуск: node tools/qa/check-codex-plugins.mjs
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { NotChecked, reporter, startStand } from './throwaway-stand.mjs';

const IS_WIN = process.platform === 'win32';
const MKT = 'qa-mkt';
const PLUGIN = 'hello';
const ID = `${PLUGIN}@${MKT}`;
const SKILL = 'qa-greet-7713';

function findCli() {
  const names = IS_WIN ? ['codex.cmd', 'codex.exe', 'codex'] : ['codex'];
  const dirs = [
    ...(process.env.STEER_CLI_DIR ? process.env.STEER_CLI_DIR.split(delimiter) : []),
    ...(process.env.PATH ?? process.env.Path ?? '').split(delimiter),
  ];
  return dirs.find((dir) => dir && names.some((file) => existsSync(join(dir, file))));
}

const { check, finish } = reporter();
const cliDir = findCli();
if (!cliDir) {
  console.log('Не проверено: codex нет ни в STEER_CLI_DIR, ни в PATH.');
  process.exit(2);
}
const cli = join(cliDir, IS_WIN ? 'codex.cmd' : 'codex');

const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-codex-plugins-')));
const codexHome = join(root, 'codex-home');
const configPath = join(codexHome, 'config.toml');
mkdirSync(codexHome, { recursive: true });
// Строка человека, которую выключение обязано не тронуть.
writeFileSync(configPath, '# мой конфиг\nmodel = "gpt-5"\n');
process.env.CODEX_HOME = codexHome;

// Рынок: локальная папка в формате Claude — Codex читает и его.
const market = join(root, 'mkt');
const pluginRoot = join(market, 'plugins', PLUGIN);
mkdirSync(join(market, '.claude-plugin'), { recursive: true });
mkdirSync(join(pluginRoot, '.claude-plugin'), { recursive: true });
mkdirSync(join(pluginRoot, 'skills', SKILL), { recursive: true });
writeFileSync(
  join(market, '.claude-plugin', 'marketplace.json'),
  JSON.stringify({
    name: MKT,
    owner: { name: 'qa' },
    plugins: [
      { name: PLUGIN, source: './plugins/hello', description: 'QA plugin', version: '1.0.0' },
    ],
  }),
);
writeFileSync(
  join(pluginRoot, '.claude-plugin', 'plugin.json'),
  JSON.stringify({ name: PLUGIN, version: '1.0.0', description: 'QA plugin' }),
);
writeFileSync(
  join(pluginRoot, 'skills', SKILL, 'SKILL.md'),
  `---\nname: ${SKILL}\ndescription: QA greeting skill\n---\nSay hi.\n`,
);

/** Запуск CLI мимо панели — тот же CODEX_HOME. */
function runCli(args, cwd) {
  return new Promise((done) => {
    const child = IS_WIN
      ? spawn(`"${cli}" ${args.map((arg) => `"${arg}"`).join(' ')}`, { cwd, shell: true })
      : spawn(cli, args, { cwd });
    let out = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (out += chunk));
    child.stdin.end();
    const timer = setTimeout(() => child.kill(), 120_000);
    child.on('exit', () => {
      clearTimeout(timer);
      done(out);
    });
  });
}

/** Скиллы, которые Codex загрузил бы в разговор: app-server `skills/list`. */
function skillNames(cwd) {
  return new Promise((done, fail) => {
    const child = IS_WIN
      ? spawn(`"${cli}" app-server`, { cwd, shell: true })
      : spawn(cli, ['app-server'], { cwd });
    let buffer = '';
    const timer = setTimeout(() => {
      child.kill();
      fail(new NotChecked('app-server не ответил на skills/list'));
    }, 60_000);
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line.startsWith('{')) continue;
        const message = JSON.parse(line);
        if (message.id === 1) {
          send({ method: 'initialized' });
          send({ id: 2, method: 'skills/list', params: { cwds: [cwd], forceReload: true } });
        } else if (message.id === 2) {
          clearTimeout(timer);
          child.kill();
          done(
            (message.result?.data ?? [])
              .flatMap((entry) => entry.skills ?? [])
              .filter((skill) => skill.enabled !== false)
              .map((skill) => skill.name),
          );
        }
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'qa', version: '0' } } });
  });
}

let stand;
try {
  stand = await startStand({
    label: 'codex-plugins',
    settings: { provider: 'codex' },
    web: false,
    extraPath: [cliDir],
  });
  console.log(`Одноразовая панель ${stand.apiUrl}\n`);
  const work = join(stand.home, 'work');
  mkdirSync(work, { recursive: true });
  const info = async () => (await stand.api('/provider-plugins')).body;
  const cliList = async () => {
    const out = await runCli(['plugin', 'list', '--json'], work);
    return JSON.parse(out.slice(out.indexOf('{')));
  };

  console.log('1. Раздел плагинов Codex');
  const providers = (await stand.api('/providers')).body;
  const codex = providers?.providers?.find((item) => item.id === 'codex');
  check(
    'возможность plugins ready',
    codex?.capabilities?.plugins === 'ready',
    JSON.stringify(codex?.capabilities),
  );
  const empty = await info();
  check(
    'формат codex-plugins, действия есть, списки пусты, CLI без ошибки',
    empty?.format === 'codex-plugins' &&
      empty?.installedActions === true &&
      empty?.marketplaceActions === true &&
      empty?.pluginsDir === join(codexHome, 'plugins') &&
      empty?.installed?.length === 0 &&
      empty?.marketplaces?.length === 0 &&
      !empty?.installedStateError,
    JSON.stringify(empty),
  );

  console.log('\n2. Отказы до CLI');
  const flag = await stand.api('/provider-plugins/installed', {
    method: 'POST',
    body: { source: '--help' },
  });
  check('селектор «--help» — 400', flag.status === 400, flag.text);
  const ghost = await stand.api(`/provider-plugins/installed/${encodeURIComponent('x@y')}`, {
    method: 'DELETE',
  });
  check('чужой плагин — 404', ghost.status === 404, ghost.text);
  const file = await stand.api('/provider-plugins/file', {
    method: 'PUT',
    body: { path: 'evil.js', content: 'x' },
  });
  check('файловый маршрут — 409', file.status === 409, file.text);
  check('кэш плагинов не появился', !existsSync(join(codexHome, 'plugins', 'cache')));

  console.log('\n3. Подключение рынка');
  const added = await stand.api('/provider-plugins/marketplaces', {
    method: 'POST',
    body: { source: market },
  });
  check('POST marketplaces — 200', added.status === 200, added.text);
  const withMarket = await info();
  check(
    `рынок ${MKT} в сводке, ${ID} — в «можно поставить»`,
    withMarket?.marketplaces?.some((item) => item.name === MKT) &&
      withMarket?.available?.some((item) => item.id === ID && item.description === 'QA plugin'),
    JSON.stringify({ m: withMarket?.marketplaces, a: withMarket?.available }),
  );

  console.log('\n4. Установка панелью');
  const installed = await stand.api('/provider-plugins/installed', {
    method: 'POST',
    body: { source: ID },
  });
  check('POST installed — 200', installed.status === 200, installed.text);
  const after = (await info())?.installed?.find((item) => item.id === ID);
  check(
    'сводка: поставлен, включён, рынок, версия, скиллы, описание',
    after?.enabled === true &&
      after?.marketplace === MKT &&
      after?.version === '1.0.0' &&
      after?.hasSkills === true &&
      after?.description === 'QA plugin',
    JSON.stringify(after),
  );

  console.log('\n5. Свидетель CLI: плагин действует');
  check(
    'app-server видит скилл плагина',
    (await skillNames(work)).some((n) => n.includes(SKILL)),
  );

  console.log('\n6. Выключение и включение панелью');
  const before = readFileSync(configPath, 'utf8');
  const off = await stand.api(`/provider-plugins/installed/${encodeURIComponent(ID)}/disable`, {
    method: 'POST',
  });
  check('disable — 200', off.status === 200, off.text);
  const afterOff = readFileSync(configPath, 'utf8');
  check(
    'config.toml: ровно enabled = false, строка человека цела',
    afterOff === before.replace(/(\[plugins\."hello@qa-mkt"\]\r?\nenabled = )true/, '$1false') &&
      afterOff !== before &&
      afterOff.startsWith('# мой конфиг\nmodel = "gpt-5"\n'),
    afterOff,
  );
  const listOff = await cliList();
  check(
    'codex plugin list: выключен',
    listOff.installed?.find((item) => item.pluginId === ID)?.enabled === false,
    JSON.stringify(listOff),
  );
  check('сводка панели: выключено', (await info())?.installed?.[0]?.enabled === false);
  check(
    'скилла выключенного плагина у app-server нет',
    !(await skillNames(work)).some((n) => n.includes(SKILL)),
  );
  const on = await stand.api(`/provider-plugins/installed/${encodeURIComponent(ID)}/enable`, {
    method: 'POST',
  });
  check('enable — 200', on.status === 200, on.text);
  check(
    'скилл вернулся',
    (await skillNames(work)).some((n) => n.includes(SKILL)),
  );

  console.log('\n7. Несуществующий плагин — отказ словами CLI');
  const nope = await stand.api('/provider-plugins/installed', {
    method: 'POST',
    body: { source: `nope@${MKT}` },
  });
  check(
    '422 codex-plugin-cli-failed, причина — текст CLI',
    nope.status === 422 &&
      nope.body?.messageCode === 'codex-plugin-cli-failed' &&
      String(nope.body?.params?.reason ?? '').includes('nope'),
    nope.text,
  );

  console.log('\n8. Удаление плагина и рынка');
  const removed = await stand.api(`/provider-plugins/installed/${encodeURIComponent(ID)}`, {
    method: 'DELETE',
  });
  check('DELETE installed — 200', removed.status === 200, removed.text);
  check('кэша плагина нет', !existsSync(join(codexHome, 'plugins', 'cache', MKT, PLUGIN)));
  check('codex plugin list о нём молчит', (await cliList()).installed?.length === 0);
  const gone = await stand.api(`/provider-plugins/marketplaces/${MKT}`, { method: 'DELETE' });
  check('DELETE marketplaces — 200', gone.status === 200, gone.text);
  const end = await info();
  check(
    'сводка пуста',
    end?.installed?.length === 0 && end?.marketplaces?.length === 0 && end?.available?.length === 0,
    JSON.stringify(end),
  );
} catch (error) {
  if (error instanceof NotChecked) {
    console.log(`Не проверено: ${error.message}`);
    process.exitCode = 2;
  } else {
    check('сценарий дошёл до конца', false, error instanceof Error ? error.stack : String(error));
  }
} finally {
  await stand?.stop();
  // Корень прогона (проект, домашний каталог CLI) — иначе он копился в temp.
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  } catch {
    // Держит ещё не вышедший CLI — на вердикт проверки это не влияет.
  }
}
if (process.exitCode !== 2) finish();
