/**
 * Живое доказательство автономности чата: доходит ли метка
 * `AGENTDECK_AUTONOMOUS=1` ДО ПРОЦЕССА прогона — и только туда, где галочка
 * включена.
 *
 * Почему юнит-тестов реестра мало. Они проверяют, что `withAutonomy` положил
 * метку в опции, и зеленеют, даже когда между опциями и `spawn` порвано всё:
 * маршрут настроек пишет одну запись, а реестр читает другую; раннер
 * наследует окружение сервера и тащит метку туда, где её сняли; ребёнок
 * разделения не видит родителя, потому что связь записывается позже старта.
 * Здесь не подменяется ничего, кроме самого CLI: одноразовая панель (свой
 * каталог конфигурации, свой дом, свой порт) и фальшивый `claude` на PATH,
 * который печатает своё окружение в рабочую папку и выходит. Токенов не
 * тратится, рабочий стенд и настоящий `~/.claude` не трогаются.
 *
 * Что доказывается:
 *   1. чат без настроек (по умолчанию автономно) получает метку;
 *   2. чат с выключенной автономией (PUT group-settings) идёт БЕЗ метки —
 *      хотя сам сервер запущен с `AGENTDECK_AUTONOMOUS=1` в окружении
 *      (панель, поднятая из автономного прогона, не должна раздавать метку);
 *   3. ребёнок разделения без своих настроек наследует выключенную автономию
 *      родителя, а ребёнок автономного родителя — включённую.
 *
 * Запуск: node tools/qa/check-chat-autonomy-env.mjs
 * Переменная: CHECK_PANEL_PORT (5196).
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';

const isWindows = process.platform === 'win32';
const PORT = Number(process.env.CHECK_PANEL_PORT ?? 5196);
const PANEL = `http://127.0.0.1:${PORT}`;
const MARK = 'AGENTDECK_AUTONOMOUS';
const DUMP = 'cc-env-dump.txt';

let bad = 0;
const check = (ok, text) => {
  console.log(`${ok ? 'ок   ' : 'ПЛОХО ×'} ${text}`);
  if (!ok) bad += 1;
};

/** Фальшивый CLI: окружение — в файл рабочей папки, выход без ответа. */
function fakeCli(bin) {
  if (isWindows) {
    writeFileSync(join(bin, 'claude.cmd'), `@echo off\r\nset > "%CD%\\${DUMP}"\r\nexit /b 0\r\n`);
    return;
  }
  writeFileSync(join(bin, 'claude'), `#!/bin/sh\nenv > "$PWD/${DUMP}"\nexit 0\n`, { mode: 0o755 });
}

function envOf(dir) {
  const path = join(dir, DUMP);
  if (!existsSync(path)) return undefined;
  const env = new Map();
  for (const line of readFileSync(path, 'latin1').split(/\r?\n/)) {
    const at = line.indexOf('=');
    if (at > 0) env.set(line.slice(0, at).toUpperCase(), line.slice(at + 1));
  }
  return env;
}

async function waitForDump(dir, seconds = 30) {
  for (let i = 0; i < seconds * 4; i += 1) {
    const env = envOf(dir);
    if (env) return env;
    await wait(250);
  }
  return undefined;
}

async function waitForPanel(seconds = 60) {
  for (let i = 0; i < seconds * 2; i += 1) {
    try {
      const res = await fetch(`${PANEL}/api/system`);
      if (res.ok) return true;
    } catch {
      /* ещё не поднялась */
    }
    await wait(500);
  }
  return false;
}

async function api(method, path, body) {
  const res = await fetch(`${PANEL}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, text };
}

const root = mkdtempSync(join(tmpdir(), 'cc-autonomy-env-'));
const home = join(root, 'home');
const config = join(root, 'config');
const bin = join(root, 'bin');
const dirs = Object.fromEntries(
  ['on', 'off', 'kidOff', 'kidOn'].map((name) => [name, join(root, `project-${name}`)]),
);
for (const dir of [home, config, bin, ...Object.values(dirs)]) mkdirSync(dir, { recursive: true });
writeFileSync(join(config, 'settings.json'), '{}\n', 'utf8');
fakeCli(bin);

const server = spawn(
  process.execPath,
  ['--experimental-strip-types', '--no-warnings', 'apps/server/src/index.ts'],
  {
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: config,
      HOME: home,
      USERPROFILE: home,
      PORT: String(PORT),
      PATH: `${bin}${isWindows ? ';' : ':'}${process.env.PATH ?? ''}`,
      // Сервер сам «из автономного прогона»: метка обязана не протечь дальше.
      [MARK]: '1',
    },
    stdio: 'ignore',
    shell: false,
  },
);

try {
  check(await waitForPanel(), `одноразовая панель поднялась на ${PANEL}`);

  const send = (chatId, cwd, extra = {}) =>
    api('POST', '/api/chat/send', { chatId, prompt: 'проверка', projectPath: cwd, ...extra });

  // 1. По умолчанию — автономно.
  const on = await send('new-autonomy-on', dirs.on);
  check(on.status < 300, `прогон чата по умолчанию принят: ${on.status}`);
  const envOn = await waitForDump(dirs.on);
  check(envOn?.get(MARK) === '1', `чат по умолчанию получил ${MARK}=1: ${envOn?.get(MARK)}`);

  // 2. Автономия выключена — метки нет, хотя у сервера она в окружении.
  const put = await api('PUT', '/api/chat/new-autonomy-off/group-settings', { autonomous: false });
  check(put.status === 200, `PUT group-settings {autonomous:false}: ${put.status}`);
  const off = await send('new-autonomy-off', dirs.off);
  check(off.status < 300, `прогон чата без автономии принят: ${off.status}`);
  const envOff = await waitForDump(dirs.off);
  check(Boolean(envOff), 'фальшивый CLI чата без автономии выгрузил окружение');
  check(!envOff?.has(MARK), `чат без автономии идёт без ${MARK}: ${envOff?.get(MARK) ?? 'нет'}`);

  // 3. Дети наследуют — каждый своего родителя.
  const kidOff = await send('new-autonomy-kid-off', dirs.kidOff, {
    parentChatId: 'new-autonomy-off',
    parentTitle: 'Без автономии',
  });
  check(kidOff.status < 300, `прогон ребёнка неавтономного родителя принят: ${kidOff.status}`);
  const envKidOff = await waitForDump(dirs.kidOff);
  check(
    Boolean(envKidOff) && !envKidOff.has(MARK),
    `ребёнок неавтономного родителя без ${MARK}: ${envKidOff?.get(MARK) ?? 'нет'}`,
  );
  const kidOn = await send('new-autonomy-kid-on', dirs.kidOn, {
    parentChatId: 'new-autonomy-on',
    parentTitle: 'Автономный',
  });
  check(kidOn.status < 300, `прогон ребёнка автономного родителя принят: ${kidOn.status}`);
  const envKidOn = await waitForDump(dirs.kidOn);
  check(
    envKidOn?.get(MARK) === '1',
    `ребёнок автономного родителя получил ${MARK}=1: ${envKidOn?.get(MARK)}`,
  );
} finally {
  server.kill();
  await wait(500);
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}

console.log(bad === 0 ? '\nитог: всё сошлось' : `\nитог: расхождений ${bad}`);
process.exit(bad === 0 ? 0 : 1);
