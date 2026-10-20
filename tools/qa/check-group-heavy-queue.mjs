/**
 * Живое доказательство 3.2 плана экономии: очередь тяжёлых шагов групп на
 * настоящем `claude`.
 *
 * Юнит-тесты гоняют хук процессами с выдуманным входом; вопрос же в том, что
 * сделает CLI: держит ли он команду, пока хук `PreToolUse` из `--settings` ждёт,
 * зовёт ли `PostToolUse` и `PostToolUseFailure` с тем же `tool_use_id`, и
 * проходит ли исходная команда правило разрешений человека. Подменена одна
 * модель: стаб вместо API Anthropic, который в каждой сессии зовёт Bash
 * `npm test`. Своё — всё остальное: хуки и переменную строит настоящий
 * `groupRunProfile`, очередь — настоящий `tools/heavy-queue-hook.mjs`, тест —
 * настоящий `npm test`, пишущий начало и конец в общий журнал.
 *
 * Случаи:
 * - две группы с очередью разом → прогоны не пересекаются, оба прошли
 *   правило `Bash(npm test)` (команда не переписана);
 * - те же две без очереди → прогоны пересекаются (проба видит то, что меряет);
 * - первая группа падает (код 1) → вторая стартует сразу после неё, а не по
 *   сроку аренды: CLI зовёт `PostToolUseFailure`;
 * - хук человека отказал гейту первой группы → CLI не зовёт ни одного `Post*`,
 *   место отдаёт её следующий вызов, а не срок аренды;
 * - гейт проекта своим скриптом (`node tools/gate-check.mjs`), имени которого
 *   очередь не знает: без опыта группы идут разом, после одного замеренного
 *   прогона — по очереди;
 * - CLI сам увёл гейт в фон по таймауту Bash → аренда держится дальше, а не
 *   отдаётся в `PostToolUse`: так 16.10 гейты групп шли мимо очереди.
 *
 * Запуск: `node tools/qa/check-group-heavy-queue.mjs`. Нужен установленный
 * `claude` (путь — `CLAUDE_CLI`); стенд и настройки человека не трогаются.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const PREFIX = 'cc-heavyqueue-';
const TOOLS = fileURLToPath(new URL('..', import.meta.url));
/** Команда хука — так её собирает `runtime.ts`. */
const HOOK = `node "${join(TOOLS, 'heavy-queue-hook.mjs')}"`;
/** Сколько длится «гейт»: больше, чем расходятся старты двух CLI. */
const GATE_MS = 4_000;

let bad = 0;
const check = (ok, text) => {
  console.log(`${ok ? 'ок ' : 'НЕТ'} ${text}`);
  if (!ok) bad += 1;
};

function resolveClaude() {
  if (process.env.CLAUDE_CLI) return process.env.CLAUDE_CLI;
  if (process.platform !== 'win32') return 'claude';
  const tail = join('node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
  for (const root of [dirname(process.execPath), join(process.env.APPDATA ?? '', 'npm')]) {
    if (existsSync(join(root, tail))) return join(root, tail);
  }
  return '';
}

/** Каталог без `.claude` у родителей: на Windows временная папка лежит в домашней. */
function workBase() {
  for (let dir = tmpdir(); ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.claude'))) break;
    if (dir === parse(dir).root) return tmpdir();
  }
  // PUBLIC есть только на Windows; на Linux с TMPDIR под домом — `/tmp`.
  const pub = process.platform === 'win32' ? process.env.PUBLIC : '/tmp';
  if (pub && existsSync(pub)) return pub;
  throw new Error('нет каталога вне домашней папки: задайте PUBLIC');
}

function sse(blocks, stop) {
  const events = [
    [
      'message_start',
      {
        type: 'message_start',
        message: {
          id: 'msg_hq',
          type: 'message',
          role: 'assistant',
          model: 'stub',
          content: [],
          stop_reason: null,
          usage: { input_tokens: 10, output_tokens: 1 },
        },
      },
    ],
  ];
  blocks.forEach(([start, delta], index) => {
    events.push([
      'content_block_start',
      { type: 'content_block_start', index, content_block: start },
    ]);
    events.push(['content_block_delta', { type: 'content_block_delta', index, delta }]);
    events.push(['content_block_stop', { type: 'content_block_stop', index }]);
  });
  events.push([
    'message_delta',
    { type: 'message_delta', delta: { stop_reason: stop }, usage: { output_tokens: 1 } },
  ]);
  events.push(['message_stop', { type: 'message_stop' }]);
  return events
    .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    .join('');
}

/**
 * Стаб API: в разговоре с Bash зовёт `toolInput` один раз, потом — слово.
 * Список — по вызову на каждый ответ инструмента по порядку.
 */
function startStub(toolInput) {
  const calls = Array.isArray(toolInput) ? toolInput : [toolInput];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!req.url?.includes('/messages') || req.url.includes('count_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(req.url?.includes('count_tokens') ? '{"input_tokens":10}' : '{}');
        return;
      }
      let body = {};
      try {
        body = JSON.parse(raw);
      } catch {
        // пустое тело — тоже запрос
      }
      const bash = (body.tools ?? []).some((tool) => tool.name === 'Bash');
      const answered = (JSON.stringify(body.messages ?? []).match(/"tool_result"/g) ?? []).length;
      const call = bash ? calls[answered] : undefined;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.end(
        call
          ? sse(
              [
                [
                  { type: 'tool_use', id: `toolu_hq${Date.now()}`, name: 'Bash', input: {} },
                  {
                    type: 'input_json_delta',
                    partial_json: JSON.stringify({ description: 'gate', ...call }),
                  },
                ],
              ],
              'tool_use',
            )
          : sse(
              [
                [
                  { type: 'text', text: '' },
                  { type: 'text_delta', text: 'ok' },
                ],
              ],
              'end_turn',
            ),
      );
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({ url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() }),
    ),
  );
}

/**
 * Хук очереди за трассировщиком: событие, сессия и `duration_ms` каждого вызова —
 * строкой в `events.log` очереди, дальше вход как есть уходит настоящему хуку.
 * Так видно, ЧТО прислал CLI, а не только то, что место отдалось.
 */
function traced(work) {
  const file = join(work, 'trace-hook.mjs');
  writeFileSync(
    file,
    [
      "import { spawnSync } from 'node:child_process';",
      "import { appendFileSync, readFileSync } from 'node:fs';",
      "import { join } from 'node:path';",
      "const raw = readFileSync(0, 'utf8');",
      'try {',
      '  const input = JSON.parse(raw);',
      '  const line = [input.hook_event_name, input.session_id, input.duration_ms ?? "-"];',
      "  appendFileSync(join(process.env.AGENTDECK_HEAVY_QUEUE_DIR, 'events.log'), line.join(' ') + '\\n');",
      '} catch {}',
      `const run = spawnSync(process.execPath, [${JSON.stringify(join(TOOLS, 'heavy-queue-hook.mjs'))}], {`,
      "  input: raw, stdio: ['pipe', 'inherit', 'inherit'],",
      '});',
      'process.exit(run.status ?? 0);',
    ].join('\n'),
  );
  return `node "${file}"`;
}

function readLines(file) {
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
}

/** Журнал прогонов: `[метка, начало, конец]` по каждой группе. */
function spans(log) {
  const marks = readLines(log).map((line) => line.split(' '));
  const out = new Map();
  for (const [kind, label, at] of marks) {
    const span = out.get(label) ?? { label };
    span[kind] = Number(at);
    out.set(label, span);
  }
  return [...out.values()].sort((a, b) => a.start - b.start);
}

async function main() {
  const exe = resolveClaude();
  if (!exe) throw new Error('claude не найден: задайте CLAUDE_CLI');
  const { groupRunProfile } =
    await import('../../apps/server/src/domains/chat/group-profile/group-profile.ts');
  const work = mkdtempSync(join(workBase(), PREFIX));
  console.log(`CLI: ${exe}\nКаталог: ${work}\n`);

  /**
   * Одна группа: свой проект с гейтом (`npm test` и он же своим скриптом
   * `tools/gate-check.mjs`), общий журнал и общая очередь случая.
   */
  function group(
    caseDir,
    label,
    { queue, fail, stub, gateMs = GATE_MS, env: extra = {}, trace, userSettings = {} },
  ) {
    const home = join(caseDir, label, 'home');
    const project = join(caseDir, label, 'proj');
    mkdirSync(home, { recursive: true });
    mkdirSync(join(project, 'tools'), { recursive: true });
    writeFileSync(join(home, 'settings.json'), JSON.stringify(userSettings));
    const log = join(caseDir, 'gates.log');
    const gate =
      "import { appendFileSync } from 'node:fs';\n" +
      `const log = ${JSON.stringify(log)};\n` +
      `appendFileSync(log, 'start ${label} ' + Date.now() + '\\n');\n` +
      'setTimeout(() => {\n' +
      `  appendFileSync(log, 'end ${label} ' + Date.now() + '\\n');\n` +
      `  process.exit(${fail ? 1 : 0});\n` +
      `}, ${gateMs});\n`;
    writeFileSync(join(project, 'gate.mjs'), gate);
    writeFileSync(join(project, 'tools', 'gate-check.mjs'), gate);
    writeFileSync(
      join(project, 'package.json'),
      JSON.stringify({ name: `g-${label}`, private: true, scripts: { test: 'node gate.mjs' } }),
    );
    const profile = groupRunProfile({
      entries: [],
      tasksText: '',
      extra: [],
      ...(queue
        ? { heavyQueue: { hook: trace ? traced(work) : HOOK, dir: join(caseDir, 'queue') } }
        : {}),
    });
    const settingsFile = join(caseDir, label, 'settings.json');
    writeFileSync(settingsFile, JSON.stringify(profile.settings));
    const env = {
      ...process.env,
      ...profile.env,
      CLAUDE_CONFIG_DIR: home,
      ANTHROPIC_BASE_URL: stub.url,
      ANTHROPIC_AUTH_TOKEN: 'hq-stub',
      ANTHROPIC_API_KEY: 'hq-stub',
      ANTHROPIC_MODEL: 'claude-sonnet-4-5',
      DISABLE_AUTOUPDATER: '1',
      AGENTDECK_HEAVY_POLL_MS: '200',
      ...extra,
    };
    if (!queue) delete env.AGENTDECK_HEAVY_QUEUE_DIR;
    const args = [
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      ...profile.args,
      '--permission-mode',
      'acceptEdits',
      '--settings',
      settingsFile,
      '--allowedTools',
      'Bash(npm test)',
      'Bash(node tools/gate-check.mjs)',
    ];
    return new Promise((resolve) => {
      const child = spawn(exe, args, { cwd: project, env, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (chunk) => (out += chunk));
      child.stderr.on('data', (chunk) => (out += chunk));
      const timer = setTimeout(() => child.kill(), 180_000);
      const message = { role: 'user', content: 'run the gate' };
      child.stdin.end(`${JSON.stringify({ type: 'user', message })}\n`);
      child.on('close', () => {
        clearTimeout(timer);
        resolve(out);
      });
    });
  }

  /**
   * Две группы разом; вторая стартует позже (`lag`), чтобы первой была первая.
   * `teach` — сначала один прогон того же гейта в ту же очередь: опыт.
   */
  async function pair(name, options) {
    const caseDir = join(work, name);
    mkdirSync(caseDir, { recursive: true });
    const stub = await startStub(options.toolInput ?? { command: 'npm test' });
    const common = {
      queue: options.queue,
      stub,
      gateMs: options.gateMs,
      env: options.env,
      trace: options.trace,
    };
    if (options.teach) await group(caseDir, 't', common);
    const first = group(caseDir, 'a', {
      ...common,
      fail: options.failFirst,
      userSettings: options.firstSettings,
    });
    await new Promise((done) => setTimeout(done, options.lag ?? 500));
    const second = group(caseDir, 'b', { ...common, fail: false });
    const outputs = await Promise.all([first, second]);
    stub.close();
    const result = spans(join(caseDir, 'gates.log')).filter((span) => span.label !== 't');
    if (result.length < (options.expected ?? 2))
      console.log(`[${name}] CLI:\n${outputs.join('\n').slice(-1500)}`);
    return result;
  }

  const queued = await pair('queue', { queue: true });
  check(
    queued.length === 2 && queued.every((span) => span.start && span.end),
    `с очередью оба гейта прошли правило Bash(npm test) и отработали (${queued.length})`,
  );
  check(
    queued.length === 2 && queued[1].start >= queued[0].end,
    `с очередью гейты не пересекаются (второй начался через ${
      queued.length === 2 ? queued[1].start - queued[0].end : '?'
    } мс после конца первого)`,
  );

  const free = await pair('free', { queue: false });
  check(free.length === 2 && free[1].start < free[0].end, 'без очереди те же гейты идут разом');

  const failed = await pair('fail', { queue: true, failFirst: true, trace: true });
  const gap = failed.length === 2 ? failed[1].start - failed[0].end : Infinity;
  check(
    failed.length === 2 && gap >= 0 && gap < 20_000,
    `упавший гейт отдаёт место сразу, а не по сроку аренды (${gap} мс)`,
  );
  // Что прислал CLI: провал — своим событием, удача — с временем самой команды.
  const events = readLines(join(work, 'fail', 'queue', 'events.log'));
  check(
    events.some((line) => line.startsWith('PostToolUseFailure ')),
    `упавший гейт CLI закрыл событием PostToolUseFailure (${events.length} событий)`,
  );
  check(
    events.some((line) => /^PostToolUse \S+ \d+$/.test(line)),
    'прошедший гейт CLI закрыл PostToolUse с duration_ms — время команды без ожидания в очереди',
  );

  /**
   * Хук человека отказал тяжёлой команде: CLI дождался и очереди, но ни
   * `PostToolUse`, ни `PostToolUseFailure` не позвал (живьём 17.10). Место отдаёт
   * следующий вызов той же группы, а не срок аренды — 90 с при таймауте 60 с.
   */
  const denyHook = join(work, 'deny-npm-test.mjs');
  writeFileSync(
    denyHook,
    [
      "import { readFileSync } from 'node:fs';",
      "const input = JSON.parse(readFileSync(0, 'utf8'));",
      "if (String(input.tool_input?.command).startsWith('npm test')) {",
      '  const decision = { hookEventName: "PreToolUse", permissionDecision: "deny" };',
      '  process.stdout.write(JSON.stringify({ hookSpecificOutput: decision }));',
      '}',
    ].join('\n'),
  );
  const started = Date.now();
  const denied = await pair('deny', {
    queue: true,
    trace: true,
    lag: 2_000,
    expected: 1,
    toolInput: [{ command: 'npm test', timeout: 60_000 }, { command: 'node -e 1' }],
    firstSettings: {
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: `node "${denyHook}"` }] },
        ],
      },
    },
  });
  const deniedWait =
    denied.length === 1 && denied[0].label === 'b' ? denied[0].start - started : -1;
  check(
    deniedWait >= 0 && deniedWait < 30_000,
    `гейт, которому отказал хук человека, место не держит: вторая группа начала через ${deniedWait} мс (срок его аренды — 90 000)`,
  );

  // Гейт своим скриптом: имени очередь не знает, порог опыта — половина гейта.
  const ownGate = {
    queue: true,
    toolInput: { command: 'node tools/gate-check.mjs' },
    env: { AGENTDECK_HEAVY_LEARN_MS: String(GATE_MS / 2) },
  };
  const cold = await pair('learn-cold', ownGate);
  check(
    cold.length === 2 && cold[1].start < cold[0].end,
    'гейт своим скриптом без опыта очередь не видит — группы идут разом',
  );
  const taught = await pair('learn', { ...ownGate, teach: true });
  check(
    taught.length === 2 && taught[1].start >= taught[0].end,
    `после одного замеренного прогона тот же гейт идёт по очереди (зазор ${
      taught.length === 2 ? taught[1].start - taught[0].end : '?'
    } мс)`,
  );

  // Таймаут Bash 3 с при гейте в 12 с: CLI уводит команду в фон и зовёт PostToolUse.
  const moved = await pair('moved', {
    queue: true,
    toolInput: { command: 'npm test', timeout: 3_000 },
    gateMs: 12_000,
    env: { AGENTDECK_HEAVY_BACKGROUND_MS: '8000' },
  });
  const held = moved.length === 2 ? moved[1].start - moved[0].start : 0;
  check(
    held >= 9_000,
    `гейт, уведённый CLI в фон, держит аренду дальше: вторая группа ждала ${held} мс (таймаут Bash 3 000)`,
  );

  // Гейт, уведённый в фон, переживает свой CLI и держит каталог, пока не кончится.
  const movedLog = join(work, 'moved', 'gates.log');
  for (let i = 0; i < 60 && spans(movedLog).some((span) => !span.end); i += 1) {
    await new Promise((done) => setTimeout(done, 500));
  }
  rmSync(work, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 });
  console.log(bad ? `\nПровалов: ${bad}` : '\nВсё ок');
  process.exit(bad ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
