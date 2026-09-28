/**
 * Сита перед MR ловят блокер до MR — сквозь весь конвейер (решение владельца 28.09.2026).
 *
 * Таблица владельца: «потребители вне диффа» — 3 блокера, ушедших в MR; группа
 * удалила экспорт, а e2e ещё его зовёт. Тесты модулей проверяют судью и
 * механику git по отдельности, на кадрах внутри теста; здесь не подменяется
 * ничего, кроме самого CLI: одноразовая панель (свой каталог конфигурации, дом,
 * порт), настоящий репозиторий с голым «удалённым» и фальшивый `claude` на PATH,
 * который в копии группы удаляет `computeTotal` и коммитит — а `e2e/total.spec.ts`
 * остаётся его звать.
 *
 * Что доказывается:
 *   1. группа, которую панель довела до проверки доставки, получает напоминание
 *      ТЕМ ЖЕ разговором, и в нём — пробел сита «потребители» с удалённым именем
 *      и файлом-потребителем, по-английски (задание модели);
 *   2. «готово» группа не получает, пока пробел стоит (запись разделения);
 *   3. счёт блокеров (`GET /api/sieves`) записал пойманное до MR — класс
 *      `consumers`, ровно один раз на группу, сколько бы напоминаний ни было.
 *
 * Запуск: node tools/qa/check-split-sieves.mjs
 * `QA_MUSTFAIL=1` — без потребителя в e2e: проверка обязана покраснеть.
 * Переменная: CHECK_PANEL_PORT (5215).
 */
import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';

const isWindows = process.platform === 'win32';
const PORT = Number(process.env.CHECK_PANEL_PORT ?? 5215);
const PANEL = `http://127.0.0.1:${PORT}`;
const CEILING = { model: 'opus', effort: 'high' };
const GIT_ID = ['-c', 'user.email=qa@example.com', '-c', 'user.name=qa'];

let bad = 0;
const check = (ok, text, actual = '') => {
  console.log(`${ok ? 'ок   ' : 'ПЛОХО ×'} ${text}${actual !== '' ? ` — видно: ${actual}` : ''}`);
  if (!ok) bad += 1;
};

/**
 * Фальшивый `claude`: каждый ход — строка в `turns.jsonl` (папка, промпт целиком).
 * В копии группы (не в корне репозитория) первый же ход удаляет экспорт и
 * коммитит — так делает группа, «доделавшая» задачу и забывшая про e2e.
 */
function fakeCli(bin, logDir, projectRoot) {
  const script = join(bin, 'fake-claude.mjs');
  writeFileSync(
    script,
    `import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
const args = process.argv.slice(2);
const ROOT = ${JSON.stringify(projectRoot)};
const norm = (p) => p.replace(/\\\\/g, '/').toLowerCase();
const log = (o) => appendFileSync(${JSON.stringify(join(logDir, 'turns.jsonl'))}, JSON.stringify(o) + '\\n');
if (args.includes('--version')) { console.log('2.1.0 (Claude Code)'); process.exit(0); }
const at = args.indexOf('--model');
const model = at >= 0 ? args[at + 1] : '';
const streaming = args.includes('stream-json');
const live = args.includes('--input-format');
const after = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
const sid = after('--resume') || after('--session-id') || 'sess-' + process.pid;
const tdir = join(process.env.CLAUDE_CONFIG_DIR || '.', 'projects', process.cwd().replace(/[^A-Za-z0-9]/g, '-'));
const transcript = (role, text) => { mkdirSync(tdir, { recursive: true }); appendFileSync(join(tdir, sid + '.jsonl'), JSON.stringify({ type: role, sessionId: sid, cwd: process.cwd(), timestamp: new Date().toISOString(), uuid: sid + '-' + Date.now() + Math.random(), message: role === 'user' ? { role, content: text } : { id: 'm' + Date.now(), role, model, content: [{ type: 'text', text }] } }) + '\\n'); };
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const work = () => {
  if (norm(process.cwd()) === norm(ROOT) || !norm(process.cwd()).includes('total')) return;
  const lib = join(process.cwd(), 'src', 'lib.ts');
  if (!existsSync(lib) || !readFileSync(lib, 'utf8').includes('computeTotal')) return;
  writeFileSync(lib, 'export const other = 1;\\n');
  execFileSync('git', ${JSON.stringify(GIT_ID)}.concat(['commit', '-q', '-am', 'drop computeTotal']), { stdio: 'ignore' });
};
const reply = (prompt) => {
  work();
  log({ cwd: process.cwd(), sid, model, prompt });
  const text = 'Done.';
  transcript('user', prompt);
  transcript('assistant', text);
  out({ type: 'system', subtype: 'init', session_id: sid, model: model || 'default', tools: [] });
  out({ type: 'assistant', session_id: sid, message: { id: 'm' + Date.now() + Math.random(), role: 'assistant', model: model || 'default', content: [{ type: 'text', text }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: sid, total_cost_usd: 0, duration_ms: 1, num_turns: 1 });
};
process.stdin.setEncoding('utf8');
if (!streaming) {
  process.stdin.on('data', () => {});
  process.stdin.on('end', () => { process.stdout.write('ok\\n'); });
} else if (live) {
  let buf = '';
  process.stdin.on('data', (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf('\\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      if (msg.type !== 'user') continue;
      const c2 = msg.message?.content;
      reply(typeof c2 === 'string' ? c2 : (c2 ?? []).map((p) => p.text ?? '').join(''));
    }
  });
  process.stdin.on('end', () => process.exit(0));
  setInterval(() => {
    fetch('http://127.0.0.1:' + process.env.PORT + '/api/system', { signal: AbortSignal.timeout(2000) })
      .catch(() => process.exit(0));
  }, 1000);
} else {
  let input = '';
  process.stdin.on('data', (c) => { input += c; });
  process.stdin.on('end', () => { reply(input); process.exit(0); });
}
`,
  );
  if (isWindows) {
    writeFileSync(join(bin, 'claude.cmd'), `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
  } else {
    writeFileSync(join(bin, 'claude'), `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, {
      mode: 0o755,
    });
  }
}

async function api(method, path, body) {
  const res = await fetch(`${PANEL}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, text, json };
}

async function waitForPanel(seconds = 60) {
  for (let i = 0; i < seconds * 2; i += 1) {
    try {
      if ((await fetch(`${PANEL}/api/system`)).ok) return true;
    } catch {
      // ещё поднимается
    }
    await wait(500);
  }
  return false;
}

const norm = (path) => path.replace(/\\/g, '/').toLowerCase();

// Длинное имя: на Windows TEMP бывает в 8.3 (`RUSYAN~1`), а CLI видит папку полным.
const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-split-sieves-')));
const turnsFile = join(root, 'turns.jsonl');
const turns = () =>
  existsSync(turnsFile)
    ? readFileSync(turnsFile, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];

async function waitFor(pred, seconds = 90) {
  for (let i = 0; i < seconds * 4; i += 1) {
    const found = await pred();
    if (found) return found;
    await wait(250);
  }
  return undefined;
}

const home = join(root, 'home');
const config = join(root, 'config');
const bin = join(root, 'bin');
const project = join(root, 'shop');
const origin = join(root, 'origin.git');
for (const dir of [home, config, bin, join(project, 'src'), join(project, 'e2e')]) {
  mkdirSync(dir, { recursive: true });
}
writeFileSync(join(config, 'settings.json'), '{}\n', 'utf8');
writeFileSync(join(project, 'README.md'), '# Shop\n', 'utf8');
writeFileSync(
  join(project, 'src', 'lib.ts'),
  'export function computeTotal() {\n  return 1;\n}\n',
  'utf8',
);
writeFileSync(
  join(project, 'e2e', 'total.spec.ts'),
  // QA_MUSTFAIL=1: потребителя нет — проверка обязана покраснеть (не декорация).
  process.env.QA_MUSTFAIL
    ? 'export {};\n'
    : "import { computeTotal } from '../src/lib';\ncomputeTotal();\n",
  'utf8',
);
const git = (...args) => execFileSync('git', args, { cwd: project, stdio: 'ignore' });
execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { stdio: 'ignore' });
git('init', '-q', '-b', 'main');
git(...GIT_ID, 'add', '-A');
git(...GIT_ID, 'commit', '-q', '-m', 'init');
git('remote', 'add', 'origin', origin);
git('push', '-q', '-u', 'origin', 'main');
fakeCli(bin, root, project);

const env = {
  ...process.env,
  CLAUDE_CONFIG_DIR: config,
  HOME: home,
  USERPROFILE: home,
  PORT: String(PORT),
  GIT_TERMINAL_PROMPT: '0',
  PATH: `${bin}${isWindows ? ';' : ':'}${process.env.PATH ?? ''}`,
};
const server = spawn(
  process.execPath,
  ['--experimental-strip-types', '--no-warnings', 'apps/server/src/index.ts'],
  { env, stdio: 'ignore', shell: false },
);

const PARENT = 'split-sieves-parent';
const GROUP = {
  title: 'Итог корзины',
  branch: 'split/total',
  kind: 'implementation',
  tasks: ['убрать устаревший computeTotal из src/lib.ts'],
};
// Разделение — минимум две группы; соседняя ничего не меняет и в проверку не входит.
const NEIGHBOUR = {
  title: 'Описание',
  branch: 'split/readme',
  kind: 'mechanical',
  tasks: ['поправить заголовок README'],
};
const inCopy = (turn) => norm(turn.cwd) !== norm(project) && norm(turn.cwd).includes('total');
const CYRILLIC = /[А-Яа-яЁё]/;

try {
  check(await waitForPanel(), 'одноразовая панель поднялась');
  const added = await api('POST', '/api/projects', { name: 'Shop', path: project });
  check(added.status === 200 || added.status === 201, 'проект заведён', added.status);

  const split = await api('POST', '/api/chat/split', {
    projectPath: project,
    proposal: { groups: [GROUP, NEIGHBOUR] },
    startRuns: true,
    allowEdits: true,
    model: CEILING.model,
    effort: CEILING.effort,
    parentChatId: PARENT,
  });
  check(split.status === 200, 'разделение принято', `${split.status} ${split.text.slice(0, 200)}`);

  // 1. Напоминание группе с пробелом сита: удалённое имя и файл-потребитель.
  const nudge = await waitFor(() =>
    turns().find(
      (turn) =>
        inCopy(turn) &&
        turn.prompt.includes('consumers sieve') &&
        turn.prompt.includes('computeTotal'),
    ),
  );
  const copyTurns = turns().filter(inCopy);
  console.log(`     ходы в копии: ${copyTurns.length}`);
  check(Boolean(nudge), 'группа получила напоминание с пробелом сита «потребители»');
  check(
    Boolean(nudge?.prompt.includes('e2e/total.spec.ts')),
    'пробел называет файл-потребитель e2e/total.spec.ts',
    nudge ? '' : '(напоминания нет)',
  );
  const gapLine = nudge?.prompt.split('\n').find((line) => line.includes('consumers sieve')) ?? '';
  check(
    Boolean(gapLine) && !CYRILLIC.test(gapLine),
    'строка пробела — по-английски: это задание модели',
    gapLine.slice(0, 160),
  );
  // Напоминание пришло тем же разговором, что работа группы: сессия копии не новая.
  const sessions = new Set(copyTurns.map((turn) => turn.sid));
  check(
    Boolean(nudge) && copyTurns.some((turn) => turn !== nudge && turn.sid === nudge.sid),
    'напоминание — тем же разговором группы',
    `сессий в копии: ${sessions.size}`,
  );

  // 2–3. «Готово» не наступило; счёт записал пойманное ровно раз.
  const caught = await waitFor(async () => {
    const view = (await api('GET', '/api/sieves')).json;
    const month = view ? Object.values(view.tally ?? {})[0] : undefined;
    return month?.consumers?.caught ? month : undefined;
  }, 20);
  check(
    caught?.consumers?.caught === 1,
    'счёт блокеров: поймано до MR — consumers, один раз',
    JSON.stringify(caught ?? {}),
  );
  // Запись разделения (её отдаёт дерево родителя): группа ждёт доставку, пробел сита — в её списке.
  const tree = await api('GET', `/api/chat/${PARENT}/tree`);
  const group = (tree.json?.split?.groups ?? []).find((item) => item.branch === GROUP.branch);
  check(
    group !== undefined && group.status !== 'done',
    'группа не «готово», пока пробел сита стоит',
    group ? `${group.status}/${group.waitingFor ?? ''}` : `${tree.status}`,
  );
  check(
    (group?.deliveryMissing ?? []).some((line) => line.includes('computeTotal')),
    'пробел сита стоит в списке «не хватает» группы',
    (group?.deliveryMissing ?? []).length,
  );
} catch (error) {
  check(false, 'прогон упал', String(error?.stack ?? error));
} finally {
  server.kill();
  await wait(1500);
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  } catch {
    console.log(`     временный каталог не убран: ${root}`);
  }
}

console.log(bad ? `\nПЛОХО: ${bad}` : '\nВсё сходится');
process.exit(bad ? 1 : 0);
