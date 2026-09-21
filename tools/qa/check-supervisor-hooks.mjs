#!/usr/bin/env node
/**
 * НАДЗИРАТЕЛЬ РАНТАЙМА: нагрузка доезжает до НАСТОЯЩЕГО скрипта хука, и события
 * вокруг чужого прогона отыгрываются как у Claude (П3.1 + П3.2).
 *
 * Что здесь проверяется по-настоящему: нагрузка уходит скрипту через stdin, и
 * скрипт получает её целой. Доказательство — файл, который написал сам скрипт,
 * разобрав то, что ему пришло. Таблицы собранных руками нагрузок тут нет
 * намеренно: она доказывала бы таблицу, а не то, что текст с кавычками и
 * обратными косыми переживает путь до скрипта.
 *
 * Ровно этот путь однажды уже стоил денег: на Windows цепочка `cmd.exe` → `.cmd`
 * → `.exe` уничтожает аргумент с кавычками, а JSON нагрузки состоит из кавычек
 * целиком. Поэтому argv проверяется отдельно и обязан приехать пустым.
 *
 * Вторая половина зовёт НАСТОЯЩИЙ `runSupervisorEvent` из дерева (водителем под
 * `--experimental-strip-types`) и проверяет исход по следу, который скрипт сам
 * оставил на диске: код 2 и снятый по таймауту скрипт отказывают прогону на
 * блокирующем событии, наблюдательное событие ими не блокируется, а событие,
 * которое цель умеет сама, надзиратель не дублирует — скрипт не запускается вовсе.
 *
 * `--selftest` портит по одной вещи за раз и ждёт красного на каждой: проверка,
 * которая не умеет краснеть, — украшение.
 *
 * События инструментов (`PreToolUse`/`PostToolUse`) здесь не проверяются — П4.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SELFTEST = process.argv.includes('--selftest');

/** Скрипт хука — такой же, какой человек написал бы для Claude. */
const HOOK_SCRIPT = `
const chunks = [];
process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', () => {
  const raw = Buffer.concat(chunks).toString('utf8');
  const out = { raw, argv: process.argv.slice(2) };
  try {
    out.payload = JSON.parse(raw);
  } catch (error) {
    out.parseError = String(error && error.message);
  }
  require('node:fs').writeFileSync(process.env.HOOK_REPORT, JSON.stringify(out), 'utf8');
});
`;

/**
 * Нагрузка события. Собирается здесь, а не импортом из `payload.ts`: проверка
 * обязана уметь работать по собранному серверу и не зависеть от того, чем
 * исполняется TypeScript. Форму фиксирует юнит `payload.test.ts` — здесь
 * проверяется ДОРОГА до скрипта.
 */
function payloadOf() {
  return {
    hook_event_name: 'UserPromptSubmit',
    session_id: 'chat-1',
    cwd: 'C:/work/demo',
    transcript_path: 'C:/appdata/provider-chats/codex/chat-1.jsonl',
    // Текст нарочно злой: кавычки, обратные косые, перевод строки и не-ASCII —
    // всё, что цепочка оболочек Windows съедает, если нагрузка уедет через argv.
    prompt: 'путь "C:\\work\\hook.mjs" и перевод\nстроки, кавычка \' и знак $PATH',
  };
}

function runHook(scriptPath, reportPath, stdinText, argv = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...argv], {
      // Оболочки здесь нет намеренно: скрипт зовётся напрямую, как его позовёт
      // надзиратель. Появится `shell: true` — аргументы начнут разбирать дважды.
      shell: false,
      windowsHide: true,
      env: { ...process.env, HOOK_REPORT: reportPath },
    });

    child.stdin.on('error', () => undefined);
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 0));

    child.stdin.write(stdinText);
    child.stdin.end();
  });
}

/**
 * Один прогон скрипта хука. `damage` — порча, которой пользуется только
 * самопроверка: `truncate` режет JSON на полпути, `argv` отправляет нагрузку
 * аргументом вместо stdin, то есть ровно тем способом, который здесь запрещён.
 */
async function probe(dir, label, damage) {
  const problems = [];
  const scriptPath = join(dir, `hook-${label}.cjs`);
  const reportPath = join(dir, `report-${label}.json`);
  writeFileSync(scriptPath, HOOK_SCRIPT, 'utf8');

  const sent = payloadOf();
  const encoded = JSON.stringify(sent);
  const stdinText = damage === 'truncate' ? encoded.slice(0, 40) : damage === 'argv' ? '' : encoded;
  const argv = damage === 'argv' ? [encoded] : [];

  const exitCode = await runHook(scriptPath, reportPath, stdinText, argv);
  if (exitCode !== 0) problems.push(`скрипт хука вышел с кодом ${exitCode}`);

  let report;
  try {
    report = JSON.parse(readFileSync(reportPath, 'utf8'));
  } catch (error) {
    problems.push(`скрипт не оставил отчёта: ${error.message}`);
  }

  if (report) {
    if (report.parseError) {
      problems.push(`скрипт не разобрал нагрузку: ${report.parseError}`);
    } else {
      for (const [key, value] of Object.entries(sent)) {
        const got = report.payload?.[key];
        if (got !== value) {
          problems.push(`поле ${key} доехало искажённым: ожидалось ${value}, пришло ${got}`);
        }
      }
      const extra = Object.keys(report.payload ?? {}).filter((key) => !(key in sent));
      if (extra.length > 0) problems.push(`в нагрузке появились лишние поля: ${extra.join(', ')}`);
    }

    // Главный запрет: нагрузка НЕ едет через argv.
    if ((report.argv ?? []).length > 0) {
      problems.push(`скрипту достались аргументы, а их быть не должно: ${report.argv.length}`);
    }
  }

  return problems;
}

// --- П3.2: события вокруг чужого прогона ------------------------------------

const RUN_TS = new URL(
  '../../apps/server/src/domains/portability/supervisor/run.ts',
  import.meta.url,
).href;
const CATALOG_TS = new URL('../../apps/server/src/providers/catalog.ts', import.meta.url).href;

/**
 * Водитель: зовёт НАСТОЯЩИЙ `runSupervisorEvent` из дерева, а не его пересказ.
 * Исполняется `node --experimental-strip-types` — тем же способом, которым панель
 * запускает хуки на TypeScript (`sandbox/HookRunner.ts`, `scriptCommand`).
 */
const DRIVER = `
import { readFileSync, writeFileSync } from 'node:fs';
import { runSupervisorEvent } from ${JSON.stringify(RUN_TS)};
import { CATALOG_PROVIDERS } from ${JSON.stringify(CATALOG_TS)};

const job = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const provider = CATALOG_PROVIDERS.find((candidate) => candidate.id === job.providerId);
if (!provider) throw new Error('в каталоге нет цели ' + job.providerId);

const outcome = await runSupervisorEvent({
  provider,
  run: job.run,
  input: job.input,
  hooks: job.hooks,
  timeoutMs: job.timeoutMs,
});

writeFileSync(process.argv[3], JSON.stringify(outcome), 'utf8');
`;

function runDriver(dir, driverPath, job, label) {
  const jobPath = join(dir, `job-${label}.json`);
  const outPath = join(dir, `outcome-${label}.json`);
  writeFileSync(jobPath, JSON.stringify(job), 'utf8');

  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--experimental-strip-types', '--no-warnings', driverPath, jobPath, outPath],
      { shell: false, windowsHide: true },
    );
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`водитель вышел с кодом ${code}: ${stderr.slice(-800)}`));
        return;
      }
      resolve(JSON.parse(readFileSync(outPath, 'utf8')));
    });
  });
}

/** Скрипт хука: оставляет след на диске и выходит заданным кодом. */
function hookScript(tracePath, exitCode, sleepMs = 0) {
  return `
const fs = require('node:fs');
const chunks = [];
process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', () => {
  fs.writeFileSync(${JSON.stringify(tracePath)}, Buffer.concat(chunks).toString('utf8'), 'utf8');
  ${sleepMs > 0 ? `setTimeout(() => process.exit(${exitCode}), ${sleepMs});` : `process.exit(${exitCode});`}
});
`;
}

const EVENT_RUN = {
  providerId: 'codex',
  sessionId: 'chat-1',
  cwd: process.cwd(),
  transcriptPath: join(process.cwd(), 'no-such-transcript.jsonl'),
};

/**
 * Случаи П3.2. Каждый проверяется по настоящему пути: настоящий скрипт, запущенный
 * настоящей оболочкой, и след, который он сам оставил на диске.
 */
async function eventCases(dir, damage) {
  const problems = [];
  const driverPath = join(dir, 'driver.mts');
  writeFileSync(driverPath, DRIVER, 'utf8');

  const cases = [
    {
      label: 'block-exit-2',
      title: 'код 2 на блокирующем событии не даёт прогону начаться',
      providerId: 'codex',
      event: 'UserPromptSubmit',
      exitCode: 2,
      expect: { blocked: true, ran: true, reason: true },
    },
    {
      label: 'observe-exit-2',
      title: 'код 2 на наблюдательном событии не блокирует',
      providerId: 'codex',
      event: 'Notification',
      exitCode: 2,
      expect: { blocked: false, ran: true, ignored: true },
    },
    {
      label: 'unknown-code-blocking',
      title: 'неизвестный код на блокирующем событии — fail-closed',
      providerId: 'codex',
      event: 'UserPromptSubmit',
      exitCode: 1,
      expect: { blocked: true, ran: true, reason: true },
    },
    {
      label: 'unknown-code-observing',
      title: 'неизвестный код на наблюдательном событии — fail-open',
      providerId: 'codex',
      event: 'Notification',
      exitCode: 1,
      expect: { blocked: false, ran: true },
    },
    {
      label: 'timeout',
      title: 'зависший скрипт снимается по таймауту и не вешает прогон',
      providerId: 'codex',
      event: 'UserPromptSubmit',
      exitCode: 0,
      sleepMs: 10_000,
      timeoutMs: 400,
      expect: { blocked: true, ran: true, timedOut: true },
    },
    {
      label: 'native-owner',
      title: 'событие, которое цель умеет сама, надзиратель не дублирует',
      providerId: 'kimi',
      event: 'UserPromptSubmit',
      exitCode: 2,
      expect: { blocked: false, ran: false, owner: 'native' },
    },
  ];

  for (const item of cases) {
    const tracePath = join(dir, `trace-${item.label}.txt`);
    const scriptPath = join(dir, `hook-${item.label}.cjs`);
    writeFileSync(scriptPath, hookScript(tracePath, item.exitCode, item.sleepMs ?? 0), 'utf8');

    // Порча самопроверки: у события отбирается блокирующая сила — блокирующие
    // случаи обязаны из-за этого покраснеть.
    const event = damage === 'unblock' && item.expect.blocked ? 'Notification' : item.event;

    let outcome;
    try {
      outcome = await runDriver(
        dir,
        driverPath,
        {
          providerId: item.providerId,
          run: { ...EVENT_RUN, providerId: item.providerId },
          input: { event },
          hooks: [{ event, command: `node "${scriptPath}"` }],
          ...(item.timeoutMs ? { timeoutMs: item.timeoutMs } : {}),
        },
        item.label,
      );
    } catch (error) {
      problems.push(`${item.title}: ${error.message}`);
      continue;
    }

    const ran = existsSync(tracePath);
    if (item.expect.ran !== ran) {
      problems.push(
        `${item.title}: скрипт ${ran ? 'сработал' : 'не сработал'}, а должен был ${item.expect.ran ? 'сработать' : 'промолчать'}`,
      );
    }
    if (ran && item.expect.ran) {
      // След — это то, что скрипт прочитал со stdin. Пустой след означает, что
      // нагрузка до него не дошла, сколько бы ни говорил код выхода.
      const trace = readFileSync(tracePath, 'utf8');
      let seen;
      try {
        seen = JSON.parse(trace);
      } catch {
        problems.push(`${item.title}: скрипт получил не JSON (${trace.slice(0, 80)})`);
      }
      if (seen && seen.hook_event_name !== event) {
        problems.push(
          `${item.title}: скрипту пришло событие ${seen.hook_event_name}, ждали ${event}`,
        );
      }
    }
    if (outcome.blocked !== item.expect.blocked) {
      problems.push(`${item.title}: blocked=${outcome.blocked}, ожидалось ${item.expect.blocked}`);
    }
    if (item.expect.reason && !outcome.reason) {
      problems.push(`${item.title}: отказ без причины — человеку нечего показать`);
    }
    if (item.expect.owner && outcome.owner !== item.expect.owner) {
      problems.push(`${item.title}: владелец ${outcome.owner}, ожидался ${item.expect.owner}`);
    }
    if (item.expect.timedOut && !outcome.results.some((result) => result.timedOut)) {
      problems.push(`${item.title}: таймаут не зафиксирован в результате`);
    }
    if (item.expect.ignored && !outcome.results.some((result) => result.ignoredOnObservingEvent)) {
      problems.push(`${item.title}: вмешательство на наблюдательном событии не помечено`);
    }
  }

  return problems;
}

const dir = mkdtempSync(join(tmpdir(), 'supervisor-hooks-'));

try {
  if (SELFTEST) {
    // Обе порчи обязаны покраснеть по отдельности. Проверка, которая ловит
    // только одну из них, молчит о второй — а вторая и есть главный запрет.
    const cases = [
      ['truncate', 'обрезанная нагрузка', (damage) => probe(dir, damage, damage)],
      ['argv', 'нагрузка уехала аргументом', (damage) => probe(dir, damage, damage)],
      [
        'unblock',
        'у блокирующего события отобрана блокирующая сила',
        (damage) => eventCases(dir, damage),
      ],
    ];
    let missed = 0;
    for (const [damage, title, run] of cases) {
      const problems = await run(damage);
      if (problems.length === 0) {
        console.error(`Самопроверка: «${title}» прошла как целая — проверка не краснеет.`);
        missed += 1;
      } else {
        console.log(`Самопроверка: «${title}» замечена (${problems.length}).`);
      }
    }
    process.exit(missed > 0 ? 1 : 0);
  }

  const problems = [...(await probe(dir, 'clean', null)), ...(await eventCases(dir, null))];
  if (problems.length > 0) {
    console.error('Надзиратель рантайма отыгрывает события неверно:');
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }

  console.log(
    'Нагрузка доезжает через stdin (argv пуст); код 2 и таймаут отказывают прогону на блокирующем событии, наблюдательное не блокируют, событие цели не дублируется.',
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
