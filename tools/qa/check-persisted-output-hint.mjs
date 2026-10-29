#!/usr/bin/env node
// Подсказка о сохранённом выводе Bash (`persisted-output-hint`) на настоящем пути: настоящий `claude -p`, набор
// панели, собранный настоящим `KitService` в режиме «только набор» (он ставит BASH_MAX_OUTPUT_LENGTH=8000), заглушка
// модели вместо API. Модель зовёт оболочку с выводом ~14 КБ; CLI сохраняет его в файл и показывает превью. Проверка:
//   1. вход хука PostToolUse от CLI несёт `tool_response.persistedOutputPath` и размер (снимок входа — свой хук);
//   2. следующий запрос к модели несёт подсказку набора — с этим путём.
// Живой случай g1 #176 (27.10): по превью 2 КБ из 9,6 КБ диффа группа сочла правки «просто дописывающими».
//
// Нужен установленный `claude` (путь можно задать `CLAUDE_CLI`). Всё во временных каталогах, конфиг человека не
// трогается. Код выхода: 0 — подтверждено, 1 — провал, 2 — не проверено (нет CLI).
import { spawn, spawnSync } from 'node:child_process';
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
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStubModel } from './stub-steer-model.mjs';

class NotChecked extends Error {}
const MARKER = 'persisted-output: you saw only';
// Заглушка ключа: API здесь — своя заглушка модели.
const STUB_AUTH = 'stub';
let bad = 0;
const check = (ok, text) => {
  console.log(`${ok ? '✓' : '✗'} ${text}`);
  if (!ok) bad += 1;
};

function resolveClaude() {
  if (process.env.CLAUDE_CLI) return process.env.CLAUDE_CLI;
  if (process.platform !== 'win32') return 'claude';
  const tail = join('node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
  for (const root of [dirname(process.execPath), join(process.env.APPDATA ?? '', 'npm')]) {
    const exe = join(root, tail);
    if (existsSync(exe)) return exe;
  }
  return '';
}

/** Свой хук PostToolUse: пишет вход от CLI строкой в `dump` — снимок того, что CLI отдал хукам. */
function writeDumpHook(root, dump) {
  const dumper = join(root, 'dump.mjs');
  writeFileSync(
    dumper,
    [
      "import { appendFileSync } from 'node:fs';",
      "let s = '';",
      "process.stdin.on('data', (c) => (s += c));",
      `process.stdin.on('end', () => appendFileSync(${JSON.stringify(dump)}, s.replace(/\\n/g, ' ') + '\\n'));`,
    ].join('\n'),
  );
  const settings = join(root, 'settings.json');
  const command = `node "${dumper.replace(/\\/g, '/')}"`;
  writeFileSync(
    settings,
    JSON.stringify({
      hooks: { PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command }] }] },
    }),
  );
  return settings;
}

function runCli(exe, args, cwd, env) {
  const cli = spawn(exe, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
  let out = '';
  cli.stdout.on('data', (c) => (out += c));
  cli.stderr.on('data', (c) => (out += c));
  return new Promise((done) => {
    const timer = setTimeout(() => (cli.kill(), done(out)), 150_000);
    cli.on('close', () => (clearTimeout(timer), done(out)));
    cli.on('error', (e) => (clearTimeout(timer), done(`${out}\n${e.message}`)));
  });
}

async function main() {
  const exe = resolveClaude();
  if (!exe) throw new NotChecked('не нашёлся настоящий `claude` — задайте путь через CLAUDE_CLI.');
  const { KitService } = await import('../../apps/server/src/domains/kit/service.ts');

  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-persisted-hint-')));
  const home = join(root, 'config');
  const work = join(root, 'work');
  mkdirSync(home, { recursive: true });
  mkdirSync(work, { recursive: true });
  const dump = join(root, 'post-input.jsonl');
  const settings = writeDumpHook(root, dump);

  // Набор — тем же `runExtras`, что зовёт сборка прогона панели: флаги, окружение и потолок вывода не переписаны здесь.
  const kit = new KitService({
    appDataDir: join(root, 'panel'),
    claudeDir: () => home,
    providers: () => [{ id: 'claude', name: 'Claude Code' }],
  });
  kit.setMode('claude', 'ours');
  const extras = kit.runExtras({ provider: 'claude', local: false, hasSources: false });
  check(
    extras.env.BASH_MAX_OUTPUT_LENGTH === '8000',
    `режим «только набор» ставит потолок вывода: ${extras.env.BASH_MAX_OUTPUT_LENGTH}`,
  );

  const stub = await startStubModel({ marker: MARKER, holdMs: 200, toolLine: 'seq 1 3000' });
  try {
    const out = await runCli(
      exe,
      [
        '-p',
        'выведи числа',
        '--permission-mode',
        'default',
        '--allowedTools',
        'Bash(seq:*)',
        '--settings',
        settings,
        ...extras.args,
      ],
      work,
      {
        ...process.env,
        ...extras.env,
        CLAUDE_CONFIG_DIR: home,
        AGENTDECK_KIT_STATE: join(root, 'kit-state'),
        AGENTDECK_SPLIT_CHILD: '',
        AGENTDECK_HEAVY_QUEUE_DIR: '',
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${stub.port}`,
        ANTHROPIC_AUTH_TOKEN: STUB_AUTH,
        ANTHROPIC_API_KEY: STUB_AUTH,
        ANTHROPIC_MODEL: 'stub-persisted',
        DISABLE_TELEMETRY: '1',
        DISABLE_AUTOUPDATER: '1',
        DISABLE_ERROR_REPORTING: '1',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      },
    );

    const inputs = existsSync(dump)
      ? readFileSync(dump, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      : [];
    const resp = inputs.find((i) => i.tool_name === 'Bash')?.tool_response ?? {};
    check(inputs.length > 0, `хук PostToolUse получил вход от CLI: ${inputs.length}`);
    check(
      typeof resp.persistedOutputPath === 'string' && resp.persistedOutputPath.length > 0,
      `вход несёт persistedOutputPath: ${resp.persistedOutputPath ?? '—'}`,
    );
    check(
      Number(resp.persistedOutputSize) > 8000,
      `и размер больше потолка: ${resp.persistedOutputSize ?? '—'}`,
    );
    const after = stub.requests.find((r) => r.toolResult);
    check(
      Boolean(after),
      `запрос с результатом оболочки дошёл до модели (запросов ${stub.requests.length})`,
    );
    check(Boolean(after?.marker), 'в нём подсказка набора «видено только превью»');
    if (bad) console.log(`\nвывод CLI (начало):\n${out.slice(0, 1500)}`);
  } finally {
    await stub.close();
    rmSync(root, { recursive: true, force: true });
  }
  console.log(
    bad === 0
      ? '\nПодсказка о сохранённом выводе доходит до модели на настоящем пути.'
      : `\nПроблем: ${bad}`,
  );
  process.exit(bad === 0 ? 0 : 1);
}

if (!process.features.typescript && !process.env.CC_PERSISTED_RETRY) {
  const result = spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      '--no-warnings',
      fileURLToPath(import.meta.url),
      ...process.argv.slice(2),
    ],
    { stdio: 'inherit', env: { ...process.env, CC_PERSISTED_RETRY: '1' } },
  );
  process.exit(result.status ?? 1);
} else {
  await main().catch((error) => {
    if (error instanceof NotChecked) {
      console.log(`НЕ ПРОВЕРЕНО: ${error.message}`);
      process.exit(2);
    }
    console.error(error);
    process.exit(1);
  });
}
