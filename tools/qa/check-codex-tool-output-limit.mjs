/**
 * Потолок ответа инструмента группы Codex (пакет C плана экономии чужих CLI, решение O2)
 * на НАСТОЯЩЕМ codex.
 *
 * Путь: рычаги группы → канал панели (`economy-run/codex.ts`) → `withCodexKit`
 * (`kit/codex.ts`) → запуск тем же `spawnCliProcess` и с тем же сложением
 * окружения, что у `ProviderChatRun` (`{ ...kit.env, ...runEnv }`) → настоящий
 * `codex exec`. Модель — заглушка OpenAI responses: первым ответом зовёт оболочку
 * (`node big.js`, 40 000 знаков вывода), вторым — «done». Свидетели:
 *   - длина `function_call_output` во втором запросе к модели — ровно то, что
 *     Codex положил бы в окно;
 *   - argv, с которым ОС запустила процесс (`child.spawnargs`), а не то, что
 *     собрала панель;
 *   - окружение, которое видит команда, запущенная САМИМ codex (`big.js` пишет
 *     его в файл): переменные панели в него не доходят, метка-контроль доходит.
 *     Контрольный прогон без снятия (`withCodexKit` обойдён) показывает, что
 *     свидетель видит именно это имя, — иначе «нет переменной» ничего бы не значило.
 *
 * Сценарии:
 *   рычаги по умолчанию (8000 знаков, 10 000 токенов) → ключа НЕТ: Codex и так
 *     строже (его предел 2500 токенов), ключ поднял бы предел;
 *   оболочка 4000, чтение 2000 → `-c tool_output_token_limit=2000`, вывод ужат
 *     ниже умолчания Codex;
 *   ключ 500 напрямую → единица — токены (~4 знака): до модели доходит ≤ 2500 знаков.
 *
 * Дом Codex — временный `CODEX_HOME`; `~/.codex`, `~/.claude` не трогаются.
 * Подменена только модель (сетевая граница). Нет codex — «не проверено», код 2.
 * Зависший codex снимается деревом (`lib/kill-tree.mjs`): на Windows `child.kill()`
 * снял бы лишь обёртку, и codex остался бы сиротой.
 *
 * Запуск: [STEER_CLI_DIR=<каталог с codex>] node tools/qa/check-codex-tool-output-limit.mjs
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { killChildProcessTree } from '../../apps/server/src/lib/kill-tree.mjs';

const IS_WIN = process.platform === 'win32';
const BIG = 40_000;
/** Метка-контроль: доходит до команды codex, если окружение вообще доходит. */
const MARK = 'AGENTDECK_PROBE_MARK';
const server = (path) => new URL(`../../apps/server/src/${path}`, import.meta.url).href;
const { economyRunEnv } = await import(server('domains/provider-chat/economy-run/economy-run.ts'));
const { CODEX_COMPACT_LIMIT_ENV, CODEX_TOOL_OUTPUT_LIMIT_ENV, withCodexKit } = await import(
  server('domains/kit/codex.ts')
);
const { spawnCliProcess } = await import(server('lib/cli-spawn/cli-spawn.ts'));
const PANEL_VARS = [CODEX_TOOL_OUTPUT_LIMIT_ENV, CODEX_COMPACT_LIMIT_ENV];
const { GROUP_ECONOMY_DEFAULTS } = await import(
  new URL('../../packages/contracts/src/group-economy.ts', import.meta.url).href
);

let bad = 0;
const check = (text, ok, detail) => {
  console.log(
    `  ${ok ? '✓' : '✗'} ${text}${!ok && detail ? ` — ${String(detail).slice(0, 600)}` : ''}`,
  );
  if (!ok) bad += 1;
  return ok;
};

function findCli(name) {
  const names = IS_WIN ? [`${name}.cmd`, `${name}.exe`, name] : [name];
  const dirs = [
    ...(process.env.STEER_CLI_DIR ? process.env.STEER_CLI_DIR.split(delimiter) : []),
    ...(process.env.PATH ?? process.env.Path ?? '').split(delimiter),
  ];
  return dirs.find((dir) => dir && names.some((file) => existsSync(join(dir, file))));
}

/** Заглушка модели: без вывода инструмента — вызов оболочки, с ним — «done». */
function startModel() {
  const outputs = [];
  const srv = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      if (!/\/responses/.test(req.url ?? '')) return void res.writeHead(404).end();
      let body = {};
      try {
        body = JSON.parse(raw || '{}');
      } catch {
        // не JSON — ответим текстом
      }
      const input = Array.isArray(body.input) ? body.input : [];
      const tools = (body.tools ?? []).flatMap((tool) =>
        Array.isArray(tool.tools)
          ? tool.tools.map((inner) => inner.name)
          : [tool.name ?? tool.type],
      );
      const done = input.filter((item) => item.type === 'function_call_output');
      for (const item of done) {
        outputs.push(typeof item.output === 'string' ? item.output : JSON.stringify(item.output));
      }
      // Имя инструмента оболочки зависит от версии Codex — берём то, что он предложил.
      const shell = ['exec_command', 'shell_command', 'shell'].find((name) => tools.includes(name));
      const args = {
        exec_command: { cmd: 'node big.js' },
        shell_command: { command: 'node big.js' },
        shell: { command: ['node', 'big.js'] },
      };
      const n = outputs.length + done.length + 1;
      const item =
        done.length === 0 && shell
          ? {
              type: 'function_call',
              id: `fc_${n}`,
              call_id: `call_${n}`,
              name: shell,
              arguments: JSON.stringify(args[shell]),
              status: 'completed',
            }
          : {
              type: 'message',
              id: `msg_${n}`,
              role: 'assistant',
              status: 'completed',
              content: [{ type: 'output_text', text: 'done', annotations: [] }],
            };
      const resp = {
        id: `resp_${n}`,
        object: 'response',
        model: 'stub-model',
        status: 'in_progress',
        output: [],
      };
      const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      send('response.created', { type: 'response.created', response: resp });
      send('response.output_item.done', {
        type: 'response.output_item.done',
        output_index: 0,
        item,
      });
      send('response.completed', {
        type: 'response.completed',
        response: {
          ...resp,
          status: 'completed',
          output: [item],
          usage: {
            input_tokens: 10,
            output_tokens: 1,
            total_tokens: 11,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens_details: { reasoning_tokens: 0 },
          },
        },
      });
      res.end();
    });
  });
  return new Promise((resolve) =>
    srv.listen(0, '127.0.0.1', () => resolve({ srv, outputs, port: srv.address().port })),
  );
}

/** Временный каталог: Codex отпускает свои клоны плагинов не сразу — повторяем. */
async function removeLater(dir) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  console.log(`  (временный каталог не удалён: ${dir})`);
}

/**
 * Один прогон `codex exec` с argv панели: длина вывода инструмента, дошедшего до модели,
 * argv процесса и окружение команды codex. `strip: false` — контроль без снятия.
 */
async function run(env, options = {}) {
  const model = await startModel();
  const root = mkdtempSync(join(tmpdir(), 'cc-codex-tool-limit-'));
  const home = join(root, 'home');
  const work = join(root, 'work');
  mkdirSync(home, { recursive: true });
  mkdirSync(work, { recursive: true });
  // Окружение прогона — как у службы чатов: канал рычагов + свои переменные запуска
  // (дом Codex, ключ заглушки) + метка-контроль, всё через `withCodexKit`.
  const platformEnv = { ...env, CODEX_HOME: home, STUB_KEY: 'x', [MARK]: 'seen' };
  const kit = withCodexKit(
    ['exec', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', '-'],
    platformEnv,
    'exec',
  );
  // Свидетель окружения — команда, которую запускает САМ codex.
  const witness = join(work, 'env.json');
  writeFileSync(
    join(work, 'big.js'),
    [
      `const names = ${JSON.stringify([...PANEL_VARS, MARK])};`,
      `require('node:fs').writeFileSync(${JSON.stringify(witness)}, JSON.stringify(Object.fromEntries(names.map((n) => [n, process.env[n] ?? null]))));`,
      `process.stdout.write('0123456789'.repeat(${BIG / 10}));`,
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(home, 'config.toml'),
    [
      'model_provider = "stub"',
      'model = "stub-model"',
      '[model_providers.stub]',
      'name = "stub"',
      `base_url = "http://127.0.0.1:${model.port}/v1"`,
      'wire_api = "responses"',
      'env_key = "STUB_KEY"',
      '',
    ].join('\n'),
  );
  // Сложение окружения — как в `ProviderChatRun` (`{ ...kit.env, ...runEnv, PWD }`).
  // Контроль (`strip: false`) обходит снятие: окружение уходит как собрано.
  const childEnv = { ...(options.strip === false ? platformEnv : (kit.env ?? {})), PWD: work };
  const spawned = spawnCliProcess('codex', kit.args, { cwd: work, env: childEnv });
  if (spawned.error) {
    model.srv.close();
    await removeLater(root);
    return {
      args: kit.args,
      spawnargs: [],
      code: 'spawn',
      seen: undefined,
      log: spawned.error.message,
    };
  }
  const { child } = spawned;
  child.stdin.end('run node big.js, then say done');
  let log = '';
  child.stdout.on('data', (chunk) => (log += chunk));
  child.stderr.on('data', (chunk) => (log += chunk));
  const code = await new Promise((resolve) => {
    // Зависший codex — деревом: `child.kill()` на Windows оставил бы его сиротой.
    const timer = setTimeout(() => (killChildProcessTree(child), resolve('timeout')), 120_000);
    child.on('exit', (exit) => (clearTimeout(timer), resolve(exit)));
  });
  let seen;
  try {
    seen = JSON.parse(readFileSync(witness, 'utf8'));
  } catch {
    seen = undefined;
  }
  model.srv.close();
  await removeLater(root);
  return {
    args: kit.args,
    // argv, с которым ОС запустила процесс (обёртка npm разворачивается в node + скрипт).
    spawnargs: child.spawnargs ?? [],
    code,
    seen,
    length: model.outputs[0]?.length,
    log: log.slice(-400),
  };
}

const cliDir = findCli('codex');
if (!cliDir) {
  console.log('НЕ ПРОВЕРЕНО: codex не найден (STEER_CLI_DIR или PATH)');
  process.exit(2);
}
// `spawnCliProcess` ищет codex по PATH процесса (окружение запуска — добавка к нему).
process.env.PATH = `${cliDir}${delimiter}${process.env.PATH ?? ''}`;

const keyOf = (args) => args.filter((arg) => arg.startsWith('tool_output_token_limit='));
const channel = (economy) => economyRunEnv('codex', { env: {}, appData: tmpdir(), economy }) ?? {};

console.log('— рычаги по умолчанию');
const base = await run(channel(GROUP_ECONOMY_DEFAULTS));
check('прогон завершился', base.code === 0, base.log);
check('ключа нет: Codex и так строже', keyOf(base.args).length === 0, base.args.join(' '));
check(
  `Codex сам ужал вывод ${BIG} знаков (до модели ${base.length})`,
  typeof base.length === 'number' && base.length < BIG / 2,
  base.length,
);

console.log('— оболочка 4000 знаков, чтение 2000 токенов');
const tight = await run(
  channel({ ...GROUP_ECONOMY_DEFAULTS, bashOutputChars: 4_000, readOutputTokens: 2_000 }),
);
check('прогон завершился', tight.code === 0, tight.log);
check(
  'argv: `-c tool_output_token_limit=2000` ровно один раз',
  JSON.stringify(keyOf(tight.args)) === JSON.stringify(['tool_output_token_limit=2000']) &&
    tight.args[tight.args.indexOf('tool_output_token_limit=2000') - 1] === '-c',
  tight.args.join(' '),
);
check(
  'argv процесса (spawnargs) несёт тот же ключ',
  tight.spawnargs.includes('tool_output_token_limit=2000'),
  tight.spawnargs.join(' '),
);
check(
  'служебные переменные панели до команды codex не доходят, метка доходит',
  tight.seen !== undefined &&
    PANEL_VARS.every((name) => tight.seen[name] === null) &&
    tight.seen[MARK] === 'seen',
  JSON.stringify(tight.seen),
);
check(
  `вывод ужат ниже умолчания Codex (${tight.length} < ${base.length}) и не ниже ~2000 токенов`,
  typeof tight.length === 'number' &&
    typeof base.length === 'number' &&
    tight.length < base.length &&
    tight.length >= 2_000 * 3,
  `${tight.length} / ${base.length}`,
);

console.log('— контроль: окружение без снятия (withCodexKit обойдён)');
const raw = await run(
  channel({ ...GROUP_ECONOMY_DEFAULTS, bashOutputChars: 4_000, readOutputTokens: 2_000 }),
  { strip: false },
);
check('прогон завершился', raw.code === 0, raw.log);
check(
  'свидетель видит переменную панели, когда её не сняли',
  raw.seen?.[CODEX_TOOL_OUTPUT_LIMIT_ENV] === '2000' && raw.seen?.[MARK] === 'seen',
  JSON.stringify(raw.seen),
);

console.log('— ключ 500 напрямую (единица — токены)');
const small = await run({ [CODEX_TOOL_OUTPUT_LIMIT_ENV]: '500' });
check('прогон завершился', small.code === 0, small.log);
check(
  `500 токенов → до модели не больше ~2500 знаков (${small.length})`,
  typeof small.length === 'number' && small.length <= 500 * 4 + 500,
  small.length,
);

console.log(bad === 0 ? '\nOK' : `\nПРОВАЛОВ: ${bad}`);
process.exit(bad === 0 ? 0 : 1);
