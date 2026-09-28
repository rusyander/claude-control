/**
 * Модель группы разделения доезжает до процесса CLI — сквозь весь конвейер.
 *
 * Живой прогон 24.09.2026: карточка разделения предложила sonnet на механику,
 * а все ответы группы в журнале — Opus. Тесты маршрута подменяют сам прогон,
 * соседние живые проверки (`check-group-path-run.mjs`) кладут связь группы
 * руками — ни одна не проходит путь «предложение → разбор → план → работа».
 * Здесь не подменяется ничего, кроме самого CLI: одноразовая панель (свой
 * каталог конфигурации, дом, порт), настоящий git-репозиторий и фальшивый
 * `claude` на PATH, который пишет `--model` и промпт каждого хода.
 *
 * Что доказывается (автоподбор включён — так по умолчанию):
 *   1. разбор идёт на потолке разговора (модель шапки родителя);
 *   2. план группы — на потолке, в копии группы;
 *   3. РАБОТА механической группы — на модели, которую показала карточка
 *      (sonnet), а не на потолке; группа реализации — на своей;
 *   4. следующее сообщение человека в чате группы без модели в теле (так шлют
 *      телефон и API) идёт на той же модели группы, а ответ на `/api/chat/:id`
 *      называет её — вкладка выставляет её в выборе модели чата.
 *
 * Запуск: node tools/qa/check-split-group-model.mjs
 * Переменная: CHECK_PANEL_PORT (5214).
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
const PORT = Number(process.env.CHECK_PANEL_PORT ?? 5214);
const PANEL = `http://127.0.0.1:${PORT}`;
// Модель шапки родителя: алиас или полное имя (живой прогон 24.09 шёл на
// `claude-opus-5-5`) — `CEILING_MODEL` меняет её.
const CEILING = { model: process.env.CEILING_MODEL ?? 'opus', effort: 'high' };

let bad = 0;
const check = (ok, text, actual = '') => {
  console.log(`${ok ? 'ок   ' : 'ПЛОХО ×'} ${text}${actual !== '' ? ` — видно: ${actual}` : ''}`);
  if (!ok) bad += 1;
};

/** Фальшивый `claude`: каждый ход — строка в `turns.jsonl` с моделью, папкой и промптом. */
function fakeCli(bin, logDir) {
  const script = join(bin, 'fake-claude.mjs');
  writeFileSync(
    script,
    `import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
const log = (o) => appendFileSync(${JSON.stringify(join(logDir, 'turns.jsonl'))}, JSON.stringify(o) + '\\n');
if (args.includes('--version')) { console.log('2.1.0 (Claude Code)'); process.exit(0); }
const at = args.indexOf('--model');
const model = at >= 0 ? args[at + 1] : '';
const ef = args.indexOf('--effort');
const effort = ef >= 0 ? args[ef + 1] : '';
const streaming = args.includes('stream-json');
const live = args.includes('--input-format');
const after = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
const sid = after('--resume') || after('--session-id') || 'sess-' + process.pid;
// Транскрипт, как у настоящего CLI: без него панель не знает чат и не продолжает его.
const tdir = join(process.env.CLAUDE_CONFIG_DIR || '.', 'projects', process.cwd().replace(/[^A-Za-z0-9]/g, '-'));
const transcript = (role, text) => { mkdirSync(tdir, { recursive: true }); appendFileSync(join(tdir, sid + '.jsonl'), JSON.stringify({ type: role, sessionId: sid, cwd: process.cwd(), timestamp: new Date().toISOString(), uuid: sid + '-' + Date.now() + Math.random(), message: role === 'user' ? { role, content: text } : { id: 'm' + Date.now(), role, model, content: [{ type: 'text', text }] } }) + '\\n'); };
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const reply = (prompt) => {
  log({ cwd: process.cwd(), sid, model, effort, prompt: prompt.slice(0, 400) });
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
const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-split-model-')));
const turnsFile = join(root, 'turns.jsonl');
const turns = () =>
  existsSync(turnsFile)
    ? readFileSync(turnsFile, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];

async function waitTurns(pred, count = 1, seconds = 60) {
  for (let i = 0; i < seconds * 4; i += 1) {
    const found = turns().filter(pred);
    if (found.length >= count) return found;
    await wait(250);
  }
  return turns().filter(pred);
}

const home = join(root, 'home');
const config = join(root, 'config');
const bin = join(root, 'bin');
const project = join(root, 'shop');
for (const dir of [home, config, bin, project]) mkdirSync(dir, { recursive: true });
writeFileSync(join(config, 'settings.json'), '{}\n', 'utf8');
writeFileSync(join(project, 'README.md'), '# Shop\n', 'utf8');
const git = (...args) => execFileSync('git', args, { cwd: project, stdio: 'ignore' });
git('init', '-q', '-b', 'main');
git('-c', 'user.email=qa@example.com', '-c', 'user.name=qa', 'add', '-A');
git('-c', 'user.email=qa@example.com', '-c', 'user.name=qa', 'commit', '-q', '-m', 'init');
fakeCli(bin, root);

const env = {
  ...process.env,
  CLAUDE_CONFIG_DIR: config,
  HOME: home,
  USERPROFILE: home,
  PORT: String(PORT),
  PATH: `${bin}${isWindows ? ';' : ':'}${process.env.PATH ?? ''}`,
};
const server = spawn(
  process.execPath,
  ['--experimental-strip-types', '--no-warnings', 'apps/server/src/index.ts'],
  { env, stdio: 'ignore', shell: false },
);

const PARENT = 'split-model-parent';
const GROUPS = [
  {
    title: 'Подписи кнопок',
    branch: 'split/labels',
    kind: 'mechanical',
    tasks: ['переименовать подписи кнопок на странице заказа'],
  },
  {
    title: 'Скидка в корзине',
    branch: 'split/discount',
    kind: 'implementation',
    tasks: ['посчитать скидку по купону в корзине'],
  },
];

try {
  check(await waitForPanel(), 'одноразовая панель поднялась');
  const added = await api('POST', '/api/projects', { name: 'Shop', path: project });
  check(added.status === 200 || added.status === 201, 'проект заведён', added.status);

  // Разделение — ровно тем телом, что шлёт карточка вкладки (`useTaskSplit`):
  // модель и глубина шапки родителя, без ручных замен — автоподбор решает сам.
  const split = await api('POST', '/api/chat/split', {
    projectPath: project,
    proposal: { groups: GROUPS },
    startRuns: true,
    allowEdits: true,
    model: CEILING.model,
    effort: CEILING.effort,
    parentChatId: PARENT,
  });
  check(split.status === 200, 'разделение принято', `${split.status} ${split.text.slice(0, 200)}`);

  // 1. Разбор — в корне репозитория, на потолке.
  const triage = await waitTurns((turn) => norm(turn.cwd) === norm(project));
  check(triage.length >= 1, 'разбор запущен в корне репозитория', triage.length);
  check(triage[0]?.model === CEILING.model, 'разбор идёт на потолке разговора', triage[0]?.model);

  // 2–3. В каждой копии: первый ход — план (потолок), следующий — работа.
  const inCopy = (branch) => (turn) =>
    norm(turn.cwd) !== norm(project) && norm(turn.cwd).includes(branch.split('/').pop());
  const expected = { 'split/labels': /sonnet/i, 'split/discount': undefined };
  const workModels = {};
  for (const group of GROUPS) {
    const seen = await waitTurns(inCopy(group.branch), 2, 90);
    check(seen.length >= 2, `«${group.title}»: план и работа запущены`, seen.length);
    check(seen[0]?.model === CEILING.model, `«${group.title}»: план на потолке`, seen[0]?.model);
    workModels[group.branch] = seen[1]?.model;
    console.log(
      `     «${group.title}»: ходы в копии — ${seen.map((t) => t.model || '(без --model)').join(', ')}`,
    );
  }
  check(
    expected['split/labels'].test(workModels['split/labels'] ?? ''),
    'механическая группа РАБОТАЕТ на sonnet, как показала карточка',
    workModels['split/labels'],
  );
  check(
    Boolean(workModels['split/discount']),
    'группа реализации работает с явной моделью',
    workModels['split/discount'],
  );

  // 4. Сообщение человека в чате группы без модели в теле — модель группы.
  const tree = await api('GET', `/api/chat/${PARENT}/tree`);
  const children = tree.json?.children ?? tree.json?.nodes ?? [];
  const labels = JSON.stringify(tree.json ?? {});
  // Чат группы, в котором идёт РАБОТА: у группы их два — план (на потолке, так
  // задумано) и работа (на модели группы). Хаб ведёт группу по чату работы.
  const childId = children.find?.(
    (c) => /Подписи/.test(c.title ?? '') && c.stage === 'work',
  )?.chatId;
  check(
    Boolean(childId),
    'чат механической группы найден в дереве',
    childId ?? labels.slice(0, 200),
  );
  if (childId) {
    // Список чатов — источник шапки вкладки: `assignedModel` выставляет выбор модели.
    const list = await api('GET', '/api/chats');
    const rows = Array.isArray(list.json) ? list.json : (list.json?.chats ?? []);
    const row = rows.find((c) => c.id === childId || c.sessionId === childId);
    const shown = row?.assignedModel;
    check(
      /sonnet/i.test(String(shown ?? '')),
      'чат группы называет свою модель — sonnet',
      String(shown),
    );
    const copy = seenCopy(childId);
    const sent = await api('POST', '/api/chat/send', {
      chatId: childId,
      sessionId: childId,
      prompt: 'MARK_FOLLOW_UP поправь ещё подпись «Оплатить»',
      ...(copy ? { projectPath: copy } : {}),
    });
    check(
      sent.status === 200,
      'сообщение в чат группы принято',
      `${sent.status} ${sent.text.slice(0, 200)}`,
    );
    const next = await waitTurns((turn) => turn.prompt.includes('MARK_FOLLOW_UP'));
    check(
      /sonnet/i.test(next[0]?.model ?? ''),
      'следующее сообщение без модели в теле идёт на модели группы',
      next[0]?.model,
    );
  }
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

/** Папка копии, в которой шли ходы чата: берётся из записанных ходов. */
function seenCopy() {
  const copyTurn = turns().find(
    (turn) => norm(turn.cwd) !== norm(project) && norm(turn.cwd).includes('labels'),
  );
  return copyTurn?.cwd;
}

console.log(bad ? `\nПЛОХО: ${bad}` : '\nВсё сходится');
process.exit(bad ? 1 : 0);
