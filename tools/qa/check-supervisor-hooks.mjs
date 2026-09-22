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
function hookScript(tracePath, exitCode, sleepMs = 0, print = '', printErr = '') {
  return `
const fs = require('node:fs');
const chunks = [];
process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', () => {
  fs.writeFileSync(${JSON.stringify(tracePath)}, Buffer.concat(chunks).toString('utf8'), 'utf8');
  ${print ? `process.stdout.write(${JSON.stringify(print)});` : ''}
  ${printErr ? `process.stderr.write(${JSON.stringify(printErr)});` : ''}
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
      title: 'неизвестный код на блокирующем событии — fail-closed, с кодом и хвостом вывода',
      providerId: 'codex',
      event: 'UserPromptSubmit',
      exitCode: 127,
      printErr: 'node: command not found',
      expect: {
        blocked: true,
        ran: true,
        reason: true,
        reasonHas: ['127', 'node: command not found'],
      },
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
    {
      // П6.2: калитка запросов и триггер сценария в файлы чужого CLI не пишутся
      // никогда, продублировать их цели нечем — поэтому запрет собственной
      // записи панели обязан действовать и там, где событие у цели своё.
      label: 'panel-owner',
      title: 'собственная запись панели отыгрывается и на родном для цели событии',
      providerId: 'kimi',
      event: 'UserPromptSubmit',
      exitCode: 2,
      hookOwner: 'panel',
      expect: { blocked: true, ran: true, reason: true },
    },
    {
      // У Claude простой stdout на `UserPromptSubmit` — это контекст, и скрипт,
      // снятый с него, печатает туда текст, а не JSON. Потерять напечатанное
      // значило бы тихо отменить весь смысл такого хука.
      label: 'stdout-context',
      title: 'простой вывод скрипта доезжает контекстом, а не теряется',
      providerId: 'codex',
      event: 'UserPromptSubmit',
      exitCode: 0,
      print: 'Работай по шагам сценария.',
      expect: { blocked: false, ran: true, context: 'Работай по шагам сценария.' },
    },
  ];

  for (const item of cases) {
    // Порча самопроверки: у события отбирается блокирующая сила — блокирующие
    // случаи обязаны из-за этого покраснеть.
    const event = damage === 'unblock' && item.expect.blocked ? 'Notification' : item.event;
    // Вторая порча: скрипт ничего не печатает. Краснеть обязан случай про
    // контекст — без своей порчи он зеленел бы и тогда, когда надзиратель
    // перестал бы поднимать напечатанное вовсе.
    const print = damage === 'silence' ? '' : (item.print ?? '');

    const tracePath = join(dir, `trace-${item.label}.txt`);
    const scriptPath = join(dir, `hook-${item.label}.cjs`);
    writeFileSync(
      scriptPath,
      hookScript(tracePath, item.exitCode, item.sleepMs ?? 0, print, item.printErr ?? ''),
      'utf8',
    );

    let outcome;
    try {
      outcome = await runDriver(
        dir,
        driverPath,
        {
          providerId: item.providerId,
          run: { ...EVENT_RUN, providerId: item.providerId },
          input: { event },
          hooks: [
            {
              event,
              command: `node "${scriptPath}"`,
              ...(item.hookOwner ? { owner: item.hookOwner } : {}),
            },
          ],
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
    // План (§7) обещает для сломавшегося скрипта «код выхода и хвост вывода».
    // Без обеих половин строка в ленте либо не называет код, либо отправляет
    // человека смотреть тот же вывод руками.
    for (const piece of item.expect.reasonHas ?? []) {
      if (!(outcome.reason ?? '').includes(piece)) {
        problems.push(
          `${item.title}: в причине нет «${piece}» (${JSON.stringify(outcome.reason ?? null)})`,
        );
      }
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
    if (item.expect.context && !outcome.addedContext.includes(item.expect.context)) {
      problems.push(
        `${item.title}: напечатанное скриптом не доехало контекстом (${JSON.stringify(outcome.addedContext)})`,
      );
    }
  }

  return problems;
}

const dir = mkdtempSync(join(tmpdir(), 'supervisor-hooks-'));

try {
  if (SELFTEST) {
    // Каждая порча обязана покраснеть ПО СВОЕМУ следу. «Хоть что-нибудь
    // покраснело» не годится: порча ловилась бы соседней проверкой, а та,
    // ради которой её вносят, молчала бы — и молчание засчитывалось бы за
    // работу.
    const cases = [
      [
        'truncate',
        'обрезанная нагрузка',
        (damage) => probe(dir, damage, damage),
        'не разобрал нагрузку',
      ],
      [
        'argv',
        'нагрузка уехала аргументом',
        (damage) => probe(dir, damage, damage),
        'скрипту достались аргументы',
      ],
      [
        'unblock',
        'у блокирующего события отобрана блокирующая сила',
        (damage) => eventCases(dir, damage),
        'blocked=false, ожидалось true',
      ],
      [
        'silence',
        'скрипт ничего не напечатал',
        (damage) => eventCases(dir, damage),
        'не доехало контекстом',
      ],
    ];
    let missed = 0;
    for (const [damage, title, run, trace] of cases) {
      const problems = await run(damage);
      const hit = problems.filter((problem) => problem.includes(trace));
      if (hit.length === 0) {
        console.error(
          `Самопроверка: «${title}» не поймана по следу «${trace}» (покраснело ${problems.length}).`,
        );
        missed += 1;
      } else {
        console.log(`Самопроверка: «${title}» замечена по следу «${trace}» (${hit.length}).`);
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
