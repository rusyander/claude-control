#!/usr/bin/env node
/**
 * ТАБЛИЦА СВЕРКИ ПРАВ (П4.2): решение брокера против решения НАСТОЯЩЕГО
 * `claude` на одном и том же наборе правил.
 *
 * Зачем не таблица ожиданий. Написать рядом с каждым правилом, «как решил бы
 * Claude», — это проверить собственное представление о Claude, а оно и есть
 * предмет спора: перенос прав имеет смысл ровно настолько, насколько брокер
 * повторяет чужой движок. Поэтому вторая половина каждой строки не придумана, а
 * ИЗМЕРЕНА: с тем же набором правил запускается настоящий `claude.exe`, а
 * доказательством служит диск — файл, который вызов создаёт, когда его пустили.
 *
 * Что подменено, и это обе внешние границы: модель отвечает скриптованный стаб
 * (`stub-tool-any` повторяет вызов, названный заданием, — своей таблицы
 * «инструмент → поле» у стаба нет намеренно), а корпоративной платформы нет
 * вовсе. Разборщик вызовов, шлюз и движок прав у `claude` — настоящие.
 *
 * ГРАНИЦА, которую таблица показывает, а не прячет: строки, где набор правил о
 * вызове МОЛЧИТ, в равенство не входят. Там у Claude работает его режим
 * подтверждений (`default` спрашивает, а в `-p` спросить некого — значит
 * отказывает), а брокер не вмешивается вовсе: он принуждает то, что сказано в
 * каноне. Режим целого CLI переносом не переставляется — это решение 3
 * `permissions-map.ts`, и матрица верности объявляет `mode:` отдельно.
 *
 * Запуск: `node tools/qa/check-permission-broker.mjs`
 * Нужен установленный `claude` (путь можно задать `CLAUDE_CLI`); сети и стенда
 * не нужно — стаб и шлюз поднимаются здесь же.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { startStubPlatform } from './stub-platform.mjs';
import {
  NotChecked,
  gatewayDriverSource,
  reporter,
  startGatewayDriver,
} from './gateway-harness.mjs';

const CONTOUR = 'broker-company';
const MODEL = 'stub-tool-any';
/** Заглушка вместо ключа: собрана из кусков, чтобы в репозитории не лежало похожее на секрет. */
const KEY = ['broker', 'stub', 'key'].join('-');
const ROUTE_TOKEN = ['panel', 'contour', 'no', 'key', 'needed'].join('-');

const BROKER_TS = new URL(
  '../../apps/server/src/domains/portability/wire/permission-broker.ts',
  import.meta.url,
).href;

/**
 * Строки сверки.
 *
 * `rules` — набор прав в грамматике Claude, он же канон: форма правила у них
 * одна, и в этом весь смысл сверки. `call` собирается из целевого пути, чтобы
 * каждая строка писала СВОЙ файл и строки не путались между собой.
 * `decided` — говорит ли набор правил об этом вызове хоть что-нибудь.
 */
const ROWS = [
  {
    title: 'allow по префиксу команды',
    rules: { allow: ['Bash(touch:*)'] },
    call: (file) => ({ name: 'Bash', arguments: { command: `touch ${file}` } }),
    decided: true,
  },
  {
    title: 'deny по префиксу команды',
    rules: { deny: ['Bash(touch:*)'] },
    call: (file) => ({ name: 'Bash', arguments: { command: `touch ${file}` } }),
    decided: true,
  },
  {
    title: 'чужой deny не трогает разрешённый вызов',
    rules: { allow: ['Bash(touch:*)'], deny: ['Bash(git push:*)'] },
    call: (file) => ({ name: 'Bash', arguments: { command: `touch ${file}` } }),
    decided: true,
  },
  {
    title: 'allow при ПУСТОМ списке deny',
    rules: { allow: ['Bash(touch:*)'], deny: [] },
    call: (file) => ({ name: 'Bash', arguments: { command: `touch ${file}` } }),
    decided: true,
  },
  {
    title: 'deny ДРУГОГО инструмента не трогает вызов',
    rules: { allow: ['Bash(touch:*)'], deny: ['Read'] },
    call: (file) => ({ name: 'Bash', arguments: { command: `touch ${file}` } }),
    decided: true,
  },
  {
    title: 'deny на инструмент сильнее allow на его аргумент',
    rules: { allow: ['Bash(touch:*)'], deny: ['Bash'] },
    call: (file) => ({ name: 'Bash', arguments: { command: `touch ${file}` } }),
    decided: true,
  },
  {
    title: 'ask без человека: спросить некого',
    rules: { ask: ['Bash(touch:*)'] },
    call: (file) => ({ name: 'Bash', arguments: { command: `touch ${file}` } }),
    decided: true,
  },
  {
    title: 'allow на инструмент без уточнения',
    rules: { allow: ['Write'] },
    call: (file) => ({ name: 'Write', arguments: { file_path: file, content: 'ok' } }),
    decided: true,
  },
  {
    title: 'deny на инструмент без уточнения',
    rules: { deny: ['Write'] },
    call: (file) => ({ name: 'Write', arguments: { file_path: file, content: 'ok' } }),
    decided: true,
  },
  {
    title: 'правила молчат — решает режим CLI, не брокер',
    rules: {},
    call: (file) => ({ name: 'Bash', arguments: { command: `touch ${file}` } }),
    decided: false,
  },
];

/** Водитель шлюза: настоящий разбор кадров и настоящая прослойка, ворот нет. */
const DRIVER = gatewayDriverSource({ title: 'Стаб контура для сверки прав' });

/**
 * Водитель брокера: НАСТОЯЩИЙ модуль из дерева на тех же строках.
 *
 * Своей копии решения здесь нет ни одной — иначе сверялись бы две выдумки.
 */
const BROKER_DRIVER = `
import { permissionBrokerOf } from ${JSON.stringify(BROKER_TS)};

const rows = JSON.parse(process.argv[2]);
const item = (rule, decision, order) => ({
  id: 'permission:' + decision + '-' + rule,
  kind: 'permission',
  source: { provider: 'claude', scope: 'global', origin: 'file', file: 'settings.json', plugin: null },
  intent: decision + ': ' + rule,
  trigger: { on: 'always' },
  blocking: decision === 'allow' ? 'observes' : 'blocks',
  needs: { resolution: 'facts', facts: ['tool_name'], evidence: 'declared' },
  sideEffects: [],
  rule,
  decision,
  enabled: true,
  order,
  raw: rule,
});

const out = [];
for (const row of rows) {
  const rules = [];
  for (const decision of ['allow', 'ask', 'deny']) {
    for (const rule of row.rules[decision] ?? []) rules.push(item(rule, decision, rules.length));
  }
  // Спрашивающего НЕТ намеренно: у \`claude -p\` его тоже нет, и сверять надо
  // сравнимые положения, а не брокер с панелью против CLI без человека.
  const gate = permissionBrokerOf({ rules });
  const verdict = await gate.decide({ id: 'call', ...row.call });
  out.push({ allow: verdict.allow, reason: verdict.reason ?? '' });
}
process.stdout.write(JSON.stringify(out));
`;

const report = reporter();
const { ok, bad } = report;

/**
 * Путь до настоящего CLI. На Windows берётся `claude.exe` пакета, а не
 * `claude.cmd` из PATH: `.cmd` без оболочки не запускается, а с оболочкой
 * кавычки задания разбирает `cmd.exe`.
 */
function resolveClaude() {
  if (process.env.CLAUDE_CLI) return process.env.CLAUDE_CLI;
  if (process.platform !== 'win32') return 'claude';
  const tail = join('node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
  for (const root of [dirname(process.execPath), join(process.env.APPDATA ?? '', 'npm')]) {
    const candidate = join(root, tail);
    if (existsSync(candidate)) return candidate;
  }
  throw new NotChecked('не найден `claude.exe` — задайте путь в CLAUDE_CLI.');
}

/**
 * Один ход настоящего `claude` с заданным набором правил.
 *
 * Доказательство — файл на диске: движок прав решает ДО исполнения, и пустивший
 * вызов CLI его исполняет. Отсутствие файла при работающей строке `allow` того
 * же вида (соседняя строка таблицы) и означает отказ, а не поломку задания.
 */
async function askClaude(exe, port, index, row) {
  const work = realpathSync.native(mkdtempSync(join(tmpdir(), `cc-broker-${index}-`)));
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), `cc-broker-home-${index}-`)));
  const target = join(work, 'proof.txt').replace(/\\/g, '/');

  writeFileSync(
    join(home, '.claude.json'),
    JSON.stringify({
      hasCompletedOnboarding: true,
      projects: { [work]: { hasTrustDialogAccepted: true, allowedTools: [] } },
    }),
    'utf8',
  );
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ permissions: row.rules }), 'utf8');

  const call = row.call(target);
  // Кавычки одинарные — метку разбирает стаб, а двойные внутри JSON-тела уже
  // экранированы (см. `stub-platform.mjs anyToolReply`).
  const marker = JSON.stringify(call).split('"').join("'");
  const cli = spawn(
    exe,
    ['-p', `Сделай вызов. ВЫЗОВ: ${marker} ;;`, '--permission-mode', 'default', '--max-turns', '3'],
    {
      cwd: work,
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: home,
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}/${CONTOUR}`,
        ANTHROPIC_AUTH_TOKEN: ROUTE_TOKEN,
        ANTHROPIC_MODEL: MODEL,
        DISABLE_TELEMETRY: '1',
        DISABLE_AUTOUPDATER: '1',
        DISABLE_ERROR_REPORTING: '1',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    },
  );

  let out = '';
  cli.stdout.on('data', (chunk) => (out += chunk));
  cli.stderr.on('data', (chunk) => (out += chunk));
  await new Promise((done) => {
    const timer = setTimeout(() => {
      cli.kill();
      done('таймаут');
    }, 120_000);
    cli.on('close', (value) => {
      clearTimeout(timer);
      done(value);
    });
  });

  const allowed = existsSync(target);
  rmSync(home, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
  return { allowed, out, call };
}

/** Решения брокера на тех же строках — одним запуском настоящего модуля. */
async function askBroker(dir, rows) {
  const driverPath = join(dir, 'broker-driver.ts');
  writeFileSync(driverPath, BROKER_DRIVER, 'utf8');
  // Путь у каждой строки свой — как и у прогона `claude`: одинаковые вызовы в
  // разных строках однажды уже слились в один (счёт ходов у стаба идёт по вызову).
  const payload = rows.map((row, index) => ({
    rules: row.rules,
    call: row.call(`/tmp/proof-${index}.txt`),
  }));
  const child = spawn(
    process.execPath,
    ['--experimental-strip-types', '--no-warnings', driverPath, JSON.stringify(payload)],
    { stdio: ['ignore', 'pipe', 'inherit'], shell: false },
  );
  let out = '';
  child.stdout.on('data', (chunk) => (out += chunk));
  const code = await new Promise((done) => child.on('close', done));
  if (code !== 0) throw new NotChecked(`водитель брокера вышел с кодом ${code}.`);
  return JSON.parse(out);
}

const verdictWord = (allow) => (allow ? 'пустил' : 'отказал');

async function main() {
  const exe = resolveClaude();
  const stub = await startStubPlatform({ port: 0 });
  const dir = mkdtempSync(join(tmpdir(), 'cc-broker-'));
  const driver = await startGatewayDriver({
    dir,
    source: DRIVER,
    job: { appDataDir: dir, contour: CONTOUR, upstream: stub.url, key: KEY },
  });

  try {
    const port = driver.port;
    console.log(`Стаб-контур: ${stub.url}\nШлюз проверки: http://127.0.0.1:${port}\n`);

    // Вызовы строк обязаны РАЗЛИЧАТЬСЯ. Стаб считает ходы по самому вызову, и
    // две строки с одинаковым вызовом слились бы в одну: вторая получила бы
    // второй ход («вызов отработан»), то есть не сделала бы вызова вовсе — а
    // отсутствие файла проверка прочитала бы как отказ. Так и случилось при
    // написании этой проверки: шесть строк из восьми «совпадали», не проверив
    // ничего.
    const markers = ROWS.map((row, index) => JSON.stringify(row.call(`/тот же путь-${index}`)));
    const collapsed = markers.filter((marker, index) => markers.indexOf(marker) !== index);
    if (collapsed.length > 0) {
      throw new NotChecked(`строки таблицы зовут один и тот же вызов: ${collapsed.join(', ')}`);
    }

    const broker = await askBroker(dir, ROWS);
    const rows = [];
    for (const [index, row] of ROWS.entries()) {
      const claude = await askClaude(exe, port, index, row);
      rows.push({ row, claude, broker: broker[index] });
    }

    console.log('Таблица сверки: правила → решение\n');
    const width = Math.max(...ROWS.map((row) => row.title.length));
    for (const { row, claude, broker: verdict } of rows) {
      const mark = row.decided ? (claude.allowed === verdict.allow ? '=' : '≠') : '·';
      console.log(
        `  ${mark} ${row.title.padEnd(width)}  claude: ${verdictWord(claude.allowed).padEnd(7)}  брокер: ${verdictWord(verdict.allow)}`,
      );
    }
    console.log('');

    for (const { row, claude, broker: verdict } of rows) {
      if (!row.decided) continue;
      if (claude.allowed === verdict.allow) {
        ok(`совпало: ${row.title}`);
        continue;
      }
      bad(
        `разошлось: ${row.title}`,
        `claude ${verdictWord(claude.allowed)}, брокер ${verdictWord(verdict.allow)}; причина брокера: ${
          verdict.reason || '—'
        }\n    CLI сказал: ${JSON.stringify(claude.out.slice(-300))}`,
      );
    }

    // Строка, где правила молчат: в равенство не входит, но обязана быть
    // ПОКАЗАНА — иначе граница брокера остаётся необъявленной.
    const silent = rows.find(({ row }) => !row.decided);
    if (silent) {
      console.log(
        `\n  · граница: правила молчат — claude ${verdictWord(silent.claude.allowed)} (его режим), брокер ${verdictWord(
          silent.broker.allow,
        )} (не вмешивается)`,
      );
      if (!silent.broker.allow) {
        bad(
          'брокер вмешался туда, где канон молчит',
          'брокер обязан пропускать вызов, о котором правил нет',
        );
      }
    }

    // Проверка умеет краснеть: соседние строки `allow` и `deny` одного вида дают
    // РАЗНЫЙ исход у claude. Одинаковый означал бы, что доказательство на диске
    // не зависит от прав вовсе.
    const allowRow = rows[0];
    const denyRow = rows[1];
    if (allowRow.claude.allowed === denyRow.claude.allowed) {
      bad(
        'доказательство на диске не зависит от прав',
        `и allow, и deny дали «${verdictWord(allowRow.claude.allowed)}» — движок прав в прогоне не участвует`,
      );
    } else {
      ok('движок прав claude в прогоне действительно участвует (allow ≠ deny)');
    }
  } finally {
    driver.stop();
    await stub.close();
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(report.failures === 0 ? '\nВсё сходится.' : `\nПровалов: ${report.failures}`);
  process.exit(report.failures === 0 ? 0 : 1);
}

main().catch((error) => {
  if (error instanceof NotChecked) {
    console.error(`НЕ ПРОВЕРЕНО: ${error.message}`);
    process.exit(2);
  }
  console.error(error);
  process.exit(1);
});
