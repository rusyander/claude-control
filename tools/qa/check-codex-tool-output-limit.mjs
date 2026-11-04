/**
 * Потолок ответа инструмента Codex (пакет C плана экономии чужих CLI, решение O2) на НАСТОЯЩЕМ
 * codex — по решению ядра.
 *
 * Путь: рычаги шага (`SessionSpec.economy`, умолчания `CORE_ECONOMY_DEFAULTS`) → `codexEconomy`
 * ядра (`apps/core/src/adapters/economy-carry.ts`) → ключи верхнего уровня `config.toml` дома
 * сеанса, ДО таблиц — тем же порядком, что у `planCodex` (рычаги, затем привязка адреса) →
 * настоящий `codex exec` с этим домом (`CODEX_HOME`). Модель — заглушка OpenAI responses: первым
 * ответом зовёт оболочку (`node big.js`, 40 000 знаков вывода), вторым — «done». Свидетель —
 * длина `function_call_output` во втором запросе к модели: ровно то, что Codex положил в окно.
 *
 * Прежний канал панели (`economy-run/codex.ts` → `withCodexKit`, ключ в argv) ушёл в ядро вместе
 * с чатом чужих CLI; ядро несёт ключ файлом дома сеанса, переменных окружения у Codex нет.
 *
 * Сценарии:
 *   рычаги по умолчанию (8000 знаков, 10 000 токенов) → ключа НЕТ: Codex и так строже (его
 *     предел 2500 токенов), ключ поднял бы предел;
 *   оболочка 4000, чтение 2000 → `tool_output_token_limit = 2000` в `config.toml`, вывод ужат
 *     ниже умолчания Codex;
 *   ключ 500 в файле напрямую → единица — токены (~4 знака): до модели доходит ≤ 2500 знаков
 *     (контроль, что Codex вообще читает ключ из дома сеанса).
 *
 * Дом Codex — временный `CODEX_HOME`; `~/.codex`, `~/.claude` не трогаются.
 * Подменена только модель (сетевая граница). Нет codex — «не проверено», код 2.
 * Зависший codex снимается деревом (`lib/kill-tree.mjs`): на Windows `child.kill()` снял бы лишь
 * обёртку, и codex остался бы сиротой.
 *
 * Запуск: [STEER_CLI_DIR=<каталог с codex>] node tools/qa/check-codex-tool-output-limit.mjs
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { killChildProcessTree } from '../../apps/server/src/lib/kill-tree.mjs';
import { startStubModel } from '../../packages/stub-model/src/index.mjs';

const IS_WIN = process.platform === 'win32';
const BIG = 40_000;
const at = (path) => new URL(`../../${path}`, import.meta.url).href;
const { codexEconomy, CODEX_DEFAULT_TOOL_OUTPUT_TOKENS } = await import(
  at('apps/core/src/adapters/economy-carry.ts')
);
const { CORE_ECONOMY_DEFAULTS } = await import(at('packages/contracts/src/core/config.ts'));
const { spawnCliProcess } = await import(at('apps/server/src/lib/cli-spawn/cli-spawn.ts'));

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
async function startModel() {
  const outputs = [];
  // Инструменты MCP Codex кладёт пространством имён: `{name, tools: [...]}` — разворачиваем.
  const toolNames = (body) =>
    (body.tools ?? []).flatMap((tool) =>
      Array.isArray(tool.tools) ? tool.tools.map((inner) => inner.name) : [tool.name ?? tool.type],
    );
  const args = {
    exec_command: { cmd: 'node big.js' },
    shell_command: { command: 'node big.js' },
    shell: { command: ['node', 'big.js'] },
  };
  const stub = await startStubModel({
    route: ({ path }) => (/\/responses/.test(path) ? undefined : { status: 404, body: {} }),
    script: ({ request }) => {
      const input = Array.isArray(request.body.input) ? request.body.input : [];
      const done = input.filter((item) => item.type === 'function_call_output');
      for (const item of done) {
        outputs.push(typeof item.output === 'string' ? item.output : JSON.stringify(item.output));
      }
      // Имя инструмента оболочки зависит от версии Codex — берём то, что он предложил.
      const tools = toolNames(request.body);
      const shell = ['exec_command', 'shell_command', 'shell'].find((name) => tools.includes(name));
      if (done.length === 0 && shell) return { tool: { name: shell, args: args[shell] } };
      return 'done';
    },
  });
  return { outputs, port: stub.port, close: () => stub.close() };
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
 * Один прогон `codex exec` с домом сеанса: ключи экономии `toml` — верхним уровнем, затем
 * таблица адреса заглушки (как `planCodex`: рычаги до первой таблицы). Итог — что легло в
 * `config.toml` и длина вывода инструмента, дошедшего до модели.
 */
async function run(toml) {
  const model = await startModel();
  const root = mkdtempSync(join(tmpdir(), 'cc-codex-tool-limit-'));
  const home = join(root, 'home');
  const work = join(root, 'work');
  mkdirSync(home, { recursive: true });
  mkdirSync(work, { recursive: true });
  writeFileSync(join(work, 'big.js'), `process.stdout.write('0123456789'.repeat(${BIG / 10}));\n`);
  const config = [
    ...(toml ? [toml] : []),
    'model_provider = "stub"',
    'model = "stub-model"',
    '[model_providers.stub]',
    'name = "stub"',
    `base_url = "http://127.0.0.1:${model.port}/v1"`,
    'wire_api = "responses"',
    'env_key = "STUB_KEY"',
    '',
  ].join('\n');
  writeFileSync(join(home, 'config.toml'), config);
  const args = ['exec', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', '-'];
  const spawned = spawnCliProcess('codex', args, {
    cwd: work,
    env: { CODEX_HOME: home, STUB_KEY: 'x', PWD: work },
  });
  if (spawned.error) {
    await model.close();
    await removeLater(root);
    return { config, code: 'spawn', log: spawned.error.message };
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
  await model.close();
  await removeLater(root);
  return { config, code, length: model.outputs[0]?.length, log: log.slice(-400) };
}

const cliDir = findCli('codex');
if (!cliDir) {
  console.log('НЕ ПРОВЕРЕНО: codex не найден (STEER_CLI_DIR или PATH)');
  process.exit(2);
}
// `spawnCliProcess` ищет codex по PATH процесса (окружение запуска — добавка к нему).
process.env.PATH = `${cliDir}${delimiter}${process.env.PATH ?? ''}`;

const KEY = /^tool_output_token_limit = (\d+)$/m;
/** Решение ядра для рычагов шага: ключи `config.toml` и потери с именем. */
const decide = (economy) => codexEconomy({ economy });

console.log('— рычаги по умолчанию (умолчания ядра = умолчания групп панели)');
const baseDecision = decide(CORE_ECONOMY_DEFAULTS);
check(
  `ядро ключа не ставит: Codex и так строже (${CODEX_DEFAULT_TOOL_OUTPUT_TOKENS} токенов)`,
  !KEY.test(baseDecision.toml) && Object.keys(baseDecision.env).length === 0,
  JSON.stringify(baseDecision),
);
const base = await run(baseDecision.toml);
check('прогон завершился', base.code === 0, base.log);
check(
  `Codex сам ужал вывод ${BIG} знаков (до модели ${base.length})`,
  typeof base.length === 'number' && base.length < BIG / 2,
  base.length,
);

console.log('— оболочка 4000 знаков, чтение 2000 токенов');
const tightDecision = decide({ bashOutputChars: 4_000, readOutputTokens: 2_000 });
check(
  'ядро кладёт `tool_output_token_limit = 2000` ключом верхнего уровня, переменных нет',
  tightDecision.toml.match(KEY)?.[1] === '2000' && Object.keys(tightDecision.env).length === 0,
  JSON.stringify(tightDecision),
);
const tight = await run(tightDecision.toml);
check('прогон завершился', tight.code === 0, tight.log);
check(
  'ключ в config.toml стоит до первой таблицы',
  tight.config.search(KEY) >= 0 && tight.config.search(KEY) < tight.config.indexOf('['),
  tight.config,
);
check(
  `вывод ужат ниже умолчания Codex (${tight.length} < ${base.length}) и не ниже ~2000 токенов`,
  typeof tight.length === 'number' &&
    typeof base.length === 'number' &&
    tight.length < base.length &&
    tight.length >= 2_000 * 3,
  `${tight.length} / ${base.length}`,
);

console.log('— один рычаг из двух: предел общий на все инструменты — потеря с именем');
const halfDecision = decide({ bashOutputChars: 4_000 });
check(
  'ключа нет, потеря названа',
  !KEY.test(halfDecision.toml) && halfDecision.lost.some((line) => line.includes('tool output')),
  JSON.stringify(halfDecision),
);

console.log('— контроль: ключ 500 в файле напрямую (единица — токены)');
const small = await run('tool_output_token_limit = 500');
check('прогон завершился', small.code === 0, small.log);
check(
  `500 токенов → до модели не больше ~2500 знаков (${small.length})`,
  typeof small.length === 'number' && small.length <= 500 * 4 + 500,
  small.length,
);

console.log(bad === 0 ? '\nOK' : `\nПРОВАЛОВ: ${bad}`);
process.exit(bad === 0 ? 0 : 1);
