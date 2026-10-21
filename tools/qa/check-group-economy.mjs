/**
 * Живое доказательство рычагов экономии групп на настоящем `claude` (21.10.2026).
 *
 * Профиль строит настоящий `groupRunProfile`, запуск — как у панели: `run.env` в
 * окружение процесса, `run.settings` в файл `--settings`. Подменена одна модель:
 * стаб вместо API Anthropic ведёт ход по сценарию (Bash с длинным выводом → чтение
 * большого файла → Bash, печатающий окружение) и пишет тела запросов — по ним видно,
 * что CLI на самом деле отдал модели.
 *
 * Что доказывается (каждое — против контроля без профиля в том же каталоге):
 * - ответ Bash сверх `bashOutputChars` (ключ `bashOutputMaxChars`) — превью ~2k и путь
 *   к файлу; упавшая команда с длинным выводом — код выхода и начало до потолка, без
 *   хвоста и файла (проба L2: 3000 строк, ошибка на 2990);
 * - чтение файла больше `readOutputTokens` урезано до начала с подсказкой читать кусками;
 * - срок кэша `cacheTtl` доехал до `cache_control` запроса;
 * - `CLAUDE_CODE_AUTO_CONNECT_IDE=false` и окно сжатия дошли до процесса CLI (сам
 *   отказ от IDE без живого редактора не наблюдаем — видно, что флаг у процесса);
 * - с `workHabits` напоминание о долгом молчании не доходит до модели: отдельная пара
 *   ходов из девяти беззвучных Bash, у обоих способность модели включает его, как у
 *   настоящего аккаунта, — контроль его получает, группа нет.
 *
 * Каталог прогона — вне домашней папки: CLI собирает `.claude` всех родителей.
 * Запуск: `node tools/qa/check-group-economy.mjs`. Нужен установленный `claude`
 * (путь — `CLAUDE_CLI`); стенд и настройки человека не трогаются.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';
import { tmpdir } from 'node:os';

const PREFIX = 'cc-economy-';
const BIG_OUTPUT = 20_000;
const TAIL_LINES = 3_000;
const TAIL_ERROR_LINE = 2_990;
const TAIL_ERROR = 'TAIL-ERROR: build failed at step 2990';
// Напоминание о молчании (CLI 2.1.286): после пяти ходов без текста, если его
// включает способность модели — у стаба её задаёт переменная окружения.
const SILENT_STEPS = 9;
const SILENT_NEEDLE = "hasn't heard from you";
const SILENT_CAPS = 'silent_turn_reminder';

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
  const pub = process.platform === 'win32' ? process.env.PUBLIC : '/tmp';
  if (pub && existsSync(pub)) return pub;
  throw new Error('нет каталога вне домашней папки: задайте PUBLIC');
}

/** Шаги хода: n-й вызов модели после n итогов инструментов. */
function scriptFor(bigFile) {
  const node = process.execPath.replace(/\\/g, '/');
  return [
    {
      name: 'Bash',
      input: {
        command: `"${node}" -e "for(let i=0;i<${BIG_OUTPUT / 100};i++)console.log(String(i).padStart(5,'0')+'-'.repeat(94))"`,
        description: 'print long output',
      },
    },
    { name: 'Read', input: { file_path: bigFile } },
    {
      name: 'Bash',
      input: {
        command: `"${node}" -e "console.log('IDE='+process.env.CLAUDE_CODE_AUTO_CONNECT_IDE+' WIN='+process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW)"`,
        description: 'print env',
      },
    },
    // Проба хвоста (директива L2): ошибка в конце длинного вывода и код выхода —
    // что из них модель видит, когда вывод больше потолка.
    {
      name: 'Bash',
      input: {
        command: `"${node}" -e "for(let i=1;i<=${TAIL_LINES};i++)console.log(i===${TAIL_ERROR_LINE}?'${TAIL_ERROR}':'line '+i+' ok');process.exit(3)"`,
        description: 'print long output with an error near the end',
      },
    },
  ];
}

/** Беззвучные шаги: модель зовёт инструмент и не пишет человеку ни слова. */
const silentScript = () =>
  Array.from({ length: SILENT_STEPS }, (_, step) => ({
    name: 'Bash',
    input: { command: `echo step${step}`, description: 'silent step' },
  }));

const toolResults = (body) =>
  (body?.messages ?? []).flatMap((message) =>
    Array.isArray(message.content)
      ? message.content.filter((block) => block.type === 'tool_result')
      : [],
  );

const resultText = (block) =>
  typeof block?.content === 'string'
    ? block.content
    : (block?.content ?? []).map((part) => part.text ?? '').join('');

function sse(res, content, stopReason) {
  const message = {
    id: `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model: 'stub',
    content: [],
    stop_reason: null,
    usage: { input_tokens: 10, output_tokens: 1 },
  };
  const events = [['message_start', { type: 'message_start', message }]];
  content.forEach((block, index) => {
    if (block.type === 'text') {
      events.push(
        [
          'content_block_start',
          { type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
        ],
        [
          'content_block_delta',
          { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } },
        ],
      );
    } else {
      events.push(
        [
          'content_block_start',
          {
            type: 'content_block_start',
            index,
            content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
          },
        ],
        [
          'content_block_delta',
          {
            type: 'content_block_delta',
            index,
            delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
          },
        ],
      );
    }
    events.push(['content_block_stop', { type: 'content_block_stop', index }]);
  });
  events.push(
    [
      'message_delta',
      { type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: 1 } },
    ],
    ['message_stop', { type: 'message_stop' }],
  );
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  for (const [event, data] of events)
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  res.end();
}

/** Стаб API: главный цикл (есть инструмент Bash) идёт по сценарию, прочее — словом. */
function startStub() {
  const state = { script: [], seen: [] };
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (req.url?.includes('count_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ input_tokens: Math.ceil(raw.length / 4) }));
        return;
      }
      if (!req.url?.includes('/messages')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      let body = {};
      try {
        body = JSON.parse(raw);
      } catch {
        // Не JSON — запрос без инструментов, ответ «ok» ниже.
      }
      const main = (body.tools ?? []).some((tool) => tool.name === 'Bash');
      if (!main) return sse(res, [{ type: 'text', text: 'ok' }], 'end_turn');
      state.seen.push(body);
      const step = state.script[toolResults(body).length];
      if (!step) return sse(res, [{ type: 'text', text: 'done' }], 'end_turn');
      sse(
        res,
        [{ type: 'tool_use', id: `toolu_${toolResults(body).length}`, ...step }],
        'tool_use',
      );
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        state,
        close: () => server.close(),
      }),
    ),
  );
}

/** Все `cache_control` тела запроса, где бы они ни стояли. */
function cacheControls(node, out = []) {
  if (Array.isArray(node)) node.forEach((item) => cacheControls(item, out));
  else if (node && typeof node === 'object') {
    if (node.cache_control) out.push(node.cache_control);
    Object.values(node).forEach((value) => cacheControls(value, out));
  }
  return out;
}

async function main() {
  const exe = resolveClaude();
  if (!exe) throw new Error('claude не найден: задайте CLAUDE_CLI');
  const { groupRunProfile } =
    await import('../../apps/server/src/domains/chat/group-profile/group-profile.ts');
  const stub = await startStub();
  const work = mkdtempSync(join(workBase(), PREFIX));
  console.log(`CLI: ${exe}\nКаталог: ${work}\n`);

  // Около 15 тысяч токенов прозы: больше потолка группы (10k), меньше потолка CLI (25k).
  const bigFile = join(work, 'big.txt').replace(/\\/g, '/');
  const line = 'The quick brown fox jumps over the lazy dog near the riverbank today.';
  writeFileSync(bigFile, Array.from({ length: 900 }, (_, i) => `${i} ${line}`).join('\n'));

  /**
   * Один ход; `economy` — профиль группы с этими рычагами, без него — контроль.
   * `caps` — способности модели (стаб их не сообщает, CLI берёт из окружения).
   */
  async function turn(label, economy, { script = scriptFor(bigFile), caps = '' } = {}) {
    const home = join(work, label, 'home');
    const project = join(work, label, 'proj');
    mkdirSync(home, { recursive: true });
    mkdirSync(project, { recursive: true });
    // `=`: список инструментов — вариадический флаг, он съел бы и слово хода.
    const args = ['-p', '--output-format', 'json', '--allowedTools=Bash,Read'];
    let runEnv = {};
    if (economy) {
      const run = groupRunProfile({
        entries: [],
        tasksText: '',
        extra: [],
        compactWindow: 160_000,
        economy,
      });
      const settingsFile = join(work, label, 'flag-settings.json');
      writeFileSync(settingsFile, JSON.stringify(run.settings));
      args.push('--settings', settingsFile);
      runEnv = run.env;
    }
    const env = {
      ...process.env,
      ...runEnv,
      CLAUDE_CONFIG_DIR: home,
      ANTHROPIC_BASE_URL: stub.url,
      ANTHROPIC_AUTH_TOKEN: 'eco-stub',
      ANTHROPIC_API_KEY: 'eco-stub',
      ANTHROPIC_MODEL: 'claude-sonnet-4-5',
      DISABLE_AUTOUPDATER: '1',
    };
    // Порог и текст напоминания — как у CLI по умолчанию, у обоих ходов.
    delete env.CLAUDE_CODE_SILENT_TURN_REMINDER_TURNS;
    delete env.CLAUDE_CODE_SILENT_TURN_REMINDER_TEXT;
    delete env.CLAUDE_CODE_MODEL_CAPABILITIES;
    if (caps) env.CLAUDE_CODE_MODEL_CAPABILITIES = caps;
    if (!economy) {
      for (const key of [
        'CLAUDE_CODE_AUTO_CONNECT_IDE',
        'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
        'CLAUDE_CODE_PROMPT_CACHE_TTL',
        'CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS',
        'CLAUDE_CODE_SILENT_TURN_REMINDER',
      ]) {
        delete env[key];
      }
    }
    stub.state.script = script;
    const from = stub.state.seen.length;
    const output = await new Promise((resolve) => {
      const child = spawn(exe, [...args, 'go'], {
        cwd: project,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let text = '';
      child.stdout.on('data', (chunk) => (text += chunk));
      child.stderr.on('data', (chunk) => (text += chunk));
      const timer = setTimeout(() => child.kill(), 180_000);
      child.on('close', () => {
        clearTimeout(timer);
        resolve(text);
      });
    });
    // Ход не дошёл до модели — причину CLI пишет в свой вывод.
    if (stub.state.seen.length === from) console.log(`${label}: ${output.slice(0, 600)}`);
    const bodies = stub.state.seen.slice(from);
    const last = bodies.at(-1);
    const results = toolResults(last).map(resultText);
    return {
      calls: bodies.length,
      bash: results[0] ?? '',
      read: results[1] ?? '',
      env: results[2] ?? '',
      tail: results[3] ?? '',
      tailError: toolResults(last)[3]?.is_error === true,
      ttls: [...new Set(cacheControls(bodies).map((control) => control.ttl ?? '(нет)'))],
      reminders: bodies.filter((body) => JSON.stringify(body).includes(SILENT_NEEDLE)).length,
    };
  }

  const economy = {
    bashOutputChars: 8_000,
    readOutputTokens: 10_000,
    cacheTtl: '1h',
    detachIde: true,
    workHabits: true,
  };
  const on = await turn('economy', economy);
  const off = await turn('control', undefined);
  const silentOpts = { script: silentScript(), caps: SILENT_CAPS };
  const quietOn = await turn('silent-economy', economy, silentOpts);
  const quietOff = await turn('silent-control', undefined, silentOpts);

  check(
    on.calls >= 4 && off.calls >= 4,
    `ход прошёл все шаги (вызовов: ${on.calls} / ${off.calls})`,
  );
  check(off.bash.length >= BIG_OUTPUT, `контроль: ответ Bash целиком (${off.bash.length} знаков)`);
  // Узкий диапазон по факту CLI 2.1.286 (F-08): сверх потолка в окно идёт не
  // ~8000, а превью начала ~2k знаков и путь — так и написано в справке.
  check(
    on.bash.length > 1_800 && on.bash.length < 3_000,
    `группа: вместо вывода сверх потолка — превью ~2k знаков (${on.bash.length})`,
  );
  check(
    /persisted-output/.test(on.bash) && /tool-results|\.txt/i.test(on.bash),
    `группа: полный вывод назван файлом — «${on.bash.slice(0, 200).replace(/\s+/g, ' ')}»`,
  );
  check(off.read.length > 40_000, `контроль: файл прочитан целиком (${off.read.length} знаков)`);
  // CLI 2.1.286 файл целиком сверх потолка не отказывает, а отдаёт начало с
  // подсказкой читать кусками — в разговор попадает меньше, это и есть рычаг.
  check(
    on.read.length < off.read.length * 0.8 && /offset/i.test(on.read),
    `группа: чтение урезано (${on.read.length} знаков) — «${on.read
      .slice(-240)
      .replace(/\s+/g, ' ')}»`,
  );
  check(on.ttls.includes('1h'), `группа: срок кэша в запросе — ${on.ttls.join(', ')}`);
  check(!off.ttls.includes('1h'), `контроль: срок кэша в запросе — ${off.ttls.join(', ')}`);
  check(
    on.env.includes('IDE=false') && on.env.includes('WIN=160000'),
    `группа: окружение процесса — ${on.env.trim()}`,
  );
  check(
    off.env.includes('IDE=undefined') && off.env.includes('WIN=undefined'),
    `контроль: окружение процесса — ${off.env.trim()}`,
  );

  // Проба хвоста (L2, F-08): 3000 строк, ошибка на 2990, код выхода 3. Справка
  // обещает ровно это: код выхода и начало до потолка, без файла и без хвоста.
  // CLI начнёт показывать хвост или путь — проверка покраснеет, справку править.
  check(
    on.tailError && /^Exit code 3/.test(on.tail),
    `группа, упавшая команда: код выхода виден — «${on.tail.slice(0, 40).replace(/\s+/g, ' ')}»`,
  );
  check(
    on.tail.length > 7_000 && on.tail.length < 9_000,
    `группа, упавшая команда: начало вывода до потолка 8000 (${on.tail.length} знаков)`,
  );
  check(
    !on.tail.includes(TAIL_ERROR) && !/persisted-output|tool-results/.test(on.tail),
    'группа, упавшая команда: ошибки из хвоста и пути к файлу нет — как в справке',
  );
  check(
    !off.tail.includes(TAIL_ERROR) && off.tail.length > on.tail.length,
    `контроль: хвоста с ошибкой нет и без потолка (${off.tail.length} знаков) — потолок его не отнимает`,
  );

  // Напоминание о молчании: способность включает его обоим, `0` от профиля гасит.
  check(
    quietOn.calls > SILENT_STEPS && quietOff.calls > SILENT_STEPS,
    `молчание: все ${SILENT_STEPS} беззвучных шагов пройдены (вызовов: ${quietOn.calls} / ${quietOff.calls})`,
  );
  check(
    quietOff.reminders > 0,
    `молчание, контроль: напоминание в ${quietOff.reminders} запросах из ${quietOff.calls}`,
  );
  check(
    quietOn.reminders === 0,
    `молчание, группа: напоминания нет ни в одном запросе (${quietOn.reminders})`,
  );

  stub.close();
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  console.log(bad ? `\nПровалов: ${bad}` : '\nВсё ок');
  process.exit(bad ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
