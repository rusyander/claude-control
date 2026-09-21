#!/usr/bin/env node
/**
 * ХУКИ ВЫЗОВОВ НА ПРОВОДЕ: `PreToolUse` человека останавливает вызов чужого CLI
 * ДО того, как вызов до него доехал (П4.1).
 *
 * Чем это отличается от соседей. `check-supervisor-hooks.mjs` доказывает, что
 * нагрузка доезжает до скрипта, но ни одного вызова инструмента там нет —
 * события прогона происходят вокруг запуска. `check-tool-shim.mjs` доводит вызов
 * до файла настоящим `claude`, но хуков в нём нет вовсе. Модульные тесты
 * прослойки кормят разборщик строкой и зеленеют даже тогда, когда по проводу не
 * прошёл ни один байт.
 *
 * Здесь настоящий ПРОВОД: `handleGatewayRequest` из дерева на настоящем сокете,
 * настоящий разборщик прослойки, настоящий `runSupervisorEvent`, настоящий
 * скрипт хука отдельным процессом со своим кодом выхода. Подменены две вещи, и
 * обе — внешняя граница: корпоративная платформа (`stub-platform.mjs`, она же
 * скриптованная модель) и сам CLI, вместо которого ходит поддельный клиент.
 *
 * Поддельный он ровно в одном смысле: вместо того чтобы исполнить полученный
 * вызов, он ПИШЕТ ФАЙЛ. Это и есть доказательство — файла, которого клиент не
 * получил, на диске нет; и обратное: разрешённый вызов файл создаёт. Заменить
 * его настоящим CLI нельзя по устройству панели: ворота открываются по метке
 * прогона, и открыть их может только тот процесс, в котором живёт шлюз.
 *
 * Что прогоняется:
 *   1. разрешённый вызов доезжает до клиента, и файл появляется;
 *   2. запрещённый вызов до клиента НЕ доезжает: `tool_use` в потоке нет, файла
 *      на диске нет, а на месте вызова стоит РЕЗУЛЬТАТ инструмента с причиной —
 *      пара вызов↔результат не рвётся, и модель читает отказ там, где ждала
 *      ответ;
 *   3. хук получил нагрузку Claude с `tool_name` и `tool_input` — целиком и
 *      через stdin;
 *   4. вызов, показанный моделью В ЗАБОРЕ КОДА, хуков не зовёт и не блокируется:
 *      цитата протокола — это текст, а не действие (ловушка оплачена живым
 *      прогоном 12.09);
 *   5. вызов, приехавший ХВОСТОМ разбора (ответ целиком — один вызов), спрошен у
 *      хука так же: закрытие ответа ждёт решения, а не уезжает вперёд него;
 *   6. клиент, просивший НЕ поток, получает то же самое: запрет не зависит от
 *      формы ответа;
 *   7. след запроса называет остановленный вызов (`toolsBlocked`);
 *   8. ворот нет — прослойка работает как раньше: вызов уезжает клиенту без
 *      ожидания, и файл появляется.
 *
 * `--selftest` портит по одной вещи за раз и ждёт красного на каждой.
 *
 * Запуск: `node tools/qa/check-tool-shim-hooks.mjs`
 * Своего окружения не требует: стаб, шлюз и клиент поднимаются здесь же.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startStubPlatform } from './stub-platform.mjs';
import {
  NotChecked,
  gatewayDriverSource,
  reporter,
  startGatewayDriver,
} from './gateway-harness.mjs';

const SELFTEST = process.argv.includes('--selftest');

const CONTOUR = 'wire-hooks';
/** Заглушка вместо ключа: собрана из кусков, чтобы в репозитории не лежало похожее на секрет присваивание. */
const KEY = ['wire', 'stub', 'key'].join('-');
const RUN_TAG = 'run-with-hooks';
/** Метка прогона без ворот — тот же шлюз, те же кадры, хуков нет. */
const BARE_TAG = 'run-without-hooks';

/**
 * Скрипт хука — такой же, какой человек написал бы для Claude: читает нагрузку
 * со stdin, пишет след и решает кодом выхода. Запрет опознаётся по ПУТИ ФАЙЛА в
 * аргументах вызова: так скрипт смотрит именно в `tool_input`, а не в имя
 * инструмента, которое у обоих случаев одно.
 */
const HOOK_SCRIPT = `
const fs = require('node:fs');
const chunks = [];
process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', () => {
  const raw = Buffer.concat(chunks).toString('utf8');
  let payload = {};
  try {
    payload = JSON.parse(raw);
  } catch (error) {
    payload = { parseError: String(error && error.message) };
  }
  const report = JSON.parse(fs.existsSync(process.env.HOOK_REPORT)
    ? fs.readFileSync(process.env.HOOK_REPORT, 'utf8')
    : '[]');
  report.push({ raw, argv: process.argv.slice(2), payload });
  fs.writeFileSync(process.env.HOOK_REPORT, JSON.stringify(report), 'utf8');
  const target = String(payload?.tool_input?.file_path ?? '');
  if (target.includes('forbidden')) {
    process.stderr.write('в этот файл писать нельзя');
    process.exit(2);
  }
  process.exit(0);
});
`;

const GATE_TS = new URL(
  '../../apps/server/src/domains/portability/wire/tool-gate.ts',
  import.meta.url,
).href;
const CATALOG_TS = new URL('../../apps/server/src/providers/catalog.ts', import.meta.url).href;

/**
 * Водитель: НАСТОЯЩИЙ шлюз на настоящем сокете и НАСТОЯЩИЕ ворота вызовов.
 *
 * Поднимается `handleGatewayRequest` — та же функция, которую зовёт слушатель
 * панели, со всем, что внутри: разбор кадров, прослойка, придержанное закрытие
 * ответа, разбор очереди. Своего HTTP-сервера у проверки нет по той же причине,
 * по которой нет и своего разборщика: проверялась бы она сама.
 *
 * Ворота открываются `setToolGate`-путём реестра — тем же, которым их открывает
 * `bootstrap/runtime.ts`. Метка `BARE_TAG` не открыта намеренно: она и есть
 * красное-до, встроенное в прогон.
 */
const DRIVER = gatewayDriverSource({
  title: 'Стаб контура для хуков провода',
  imports: `
import { ToolGateRegistry, toolGateOf } from ${JSON.stringify(GATE_TS)};
import { CATALOG_PROVIDERS } from ${JSON.stringify(CATALOG_TS)};
`,
  setup: `
const provider = CATALOG_PROVIDERS.find((candidate) => candidate.id === job.providerId);
if (!provider) throw new Error('в каталоге нет цели ' + job.providerId);

const gates = new ToolGateRegistry();
gates.open(
  job.runTag,
  toolGateOf({
    provider,
    run: {
      providerId: job.providerId,
      sessionId: 'chat-wire-1',
      cwd: job.appDataDir,
      transcriptPath: job.appDataDir + '/transcript.jsonl',
    },
    hooks: [{ event: 'PreToolUse', command: process.execPath + ' ' + JSON.stringify(job.hookPath) }],
  }),
);
`,
  deps: 'toolGate: (runTag) => gates.gateOf(runTag)',
  routes: `
  // След запроса отдаётся своим путём: журнал живёт в процессе шлюза, и другого
  // способа показать его проверке нет.
  if ((request.url ?? '').startsWith('/_events')) {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(journal.events()));
    return;
  }
`,
});

/** Счёт провалов прогона. Имя не `report`: так в этой проверке зовут след хука. */
const tally = reporter();
const { check } = tally;

/**
 * Поддельный клиент: настоящий HTTP, настоящий разбор потока — и вместо
 * исполнения вызова запись файла. Файл на диске и есть доказательство, которое
 * нельзя подделать разбором.
 */
async function askGateway(port, { model, file, tag = RUN_TAG, stream = true }) {
  const url = `http://127.0.0.1:${port}/${CONTOUR}/_run/${tag}/v1/chat/completions`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model,
      stream,
      // Путь — косыми вперёд: скриптованная модель берёт его из тела запроса
      // регуляркой, а обратная косая Windows в ней и есть граница слова.
      messages: [{ role: 'user', content: `Запиши строку. ФАЙЛ: ${file.split('\\').join('/')}` }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'Write',
            description: 'Записать файл',
            parameters: {
              type: 'object',
              properties: { file_path: { type: 'string' }, content: { type: 'string' } },
              required: ['file_path', 'content'],
            },
          },
        },
      ],
    }),
  });

  const body = await response.text();
  const calls = [];
  let text = '';
  if (stream) {
    for (const chunk of body.split('\n\n')) {
      const line = chunk.split('\n').find((part) => part.startsWith('data: '));
      if (!line) continue;
      const payload = line.slice('data: '.length).trim();
      if (!payload || payload === '[DONE]') continue;
      let frame;
      try {
        frame = JSON.parse(payload);
      } catch {
        continue;
      }
      const delta = frame?.choices?.[0]?.delta ?? {};
      if (typeof delta.content === 'string') text += delta.content;
      for (const call of delta.tool_calls ?? []) calls.push(call);
    }
  } else {
    const whole = JSON.parse(body || '{}');
    const message = whole?.choices?.[0]?.message ?? {};
    if (typeof message.content === 'string') text += message.content;
    for (const call of message.tool_calls ?? []) calls.push(call);
  }

  // Вот оно, единственное действие клиента: полученный вызов ИСПОЛНЯЕТСЯ —
  // записью файла. Не получил — писать нечего, и диск это запомнит.
  for (const call of calls) {
    let args;
    try {
      args = JSON.parse(call?.function?.arguments ?? '{}');
    } catch {
      args = {};
    }
    if (typeof args.file_path === 'string' && args.file_path) {
      writeFileSync(args.file_path, String(args.content ?? ''), 'utf8');
    }
  }

  return { status: response.status, text, calls, body };
}

async function eventsOf(port) {
  const response = await fetch(`http://127.0.0.1:${port}/_events`);
  return response.json();
}

async function run(dir, port, hookReport) {
  // ── 1. Разрешённый вызов ─────────────────────────────────────────────────
  const allowed = join(dir, 'allowed.txt');
  const first = await askGateway(port, { model: 'stub-tool-shim', file: allowed });
  check(
    'разрешённый вызов доехал до клиента и файл создан',
    first.calls.length === 1 && existsSync(allowed),
    `вызовов ${first.calls.length}, файл ${existsSync(allowed) ? 'есть' : 'НЕТ'}: ${first.text.slice(-200)}`,
  );

  // ── 2. Запрещённый вызов ─────────────────────────────────────────────────
  const forbidden = join(dir, 'forbidden.txt');
  const second = await askGateway(port, { model: 'stub-tool-shim', file: forbidden });
  check(
    'запрещённый вызов до клиента НЕ доехал и файла нет',
    second.calls.length === 0 && !existsSync(forbidden),
    `вызовов ${second.calls.length}, файл ${existsSync(forbidden) ? 'ЕСТЬ' : 'нет'}`,
  );
  check(
    'на месте вызова — результат инструмента с причиной, а не обрыв',
    second.status === 200 &&
      second.text.includes('<tool_result name="Write">') &&
      second.text.includes('в этот файл писать нельзя'),
    `статус ${second.status}, текст: ${JSON.stringify(second.text.slice(-300))}`,
  );

  // ── 3. Нагрузка хука ─────────────────────────────────────────────────────
  const report = existsSync(hookReport) ? JSON.parse(readFileSync(hookReport, 'utf8')) : [];
  const blocked = report.find((entry) =>
    String(entry?.payload?.tool_input?.file_path ?? '').includes('forbidden'),
  );
  check(
    'хук получил нагрузку Claude через stdin: событие, имя и аргументы вызова',
    Boolean(blocked) &&
      blocked.payload.hook_event_name === 'PreToolUse' &&
      blocked.payload.tool_name === 'Write' &&
      blocked.payload.session_id === 'chat-wire-1' &&
      blocked.argv.length === 0,
    `следов ${report.length}: ${JSON.stringify(report.map((entry) => entry?.payload?.tool_name))}`,
  );

  // ── 4. Вызов в заборе кода ───────────────────────────────────────────────
  const quoted = join(dir, 'quoted.txt');
  const beforeQuote = report.length;
  const third = await askGateway(port, { model: 'stub-tool-quote', file: quoted });
  const afterQuote = existsSync(hookReport)
    ? JSON.parse(readFileSync(hookReport, 'utf8')).length
    : 0;
  check(
    'вызов в заборе кода не исполняется и хуков не зовёт',
    third.calls.length === 0 && !existsSync(quoted) && afterQuote === beforeQuote,
    `вызовов ${third.calls.length}, файл ${existsSync(quoted) ? 'ЕСТЬ' : 'нет'}, хуков ${afterQuote - beforeQuote}`,
  );

  // ── 5. Вызов из хвоста разбора ───────────────────────────────────────────
  const tailBlocked = join(dir, 'tail-forbidden.txt');
  const fourth = await askGateway(port, { model: 'stub-tool-tail', file: tailBlocked });
  check(
    'вызов из хвоста разбора тоже спрошен у хука и остановлен',
    fourth.calls.length === 0 &&
      !existsSync(tailBlocked) &&
      fourth.text.includes('<tool_result name="Write">') &&
      fourth.body.includes('[DONE]'),
    `вызовов ${fourth.calls.length}, файл ${existsSync(tailBlocked) ? 'ЕСТЬ' : 'нет'}, конец потока ${fourth.body.includes('[DONE]') ? 'есть' : 'НЕТ'}`,
  );

  const tailAllowed = join(dir, 'tail-allowed.txt');
  const fifth = await askGateway(port, { model: 'stub-tool-tail', file: tailAllowed });
  check(
    'разрешённый вызов из хвоста доезжает, и ответ закрыт после него',
    fifth.calls.length === 1 && existsSync(tailAllowed) && fifth.body.includes('[DONE]'),
    `вызовов ${fifth.calls.length}, файл ${existsSync(tailAllowed) ? 'есть' : 'НЕТ'}`,
  );

  // ── 6. Клиент, просивший не поток ────────────────────────────────────────
  const wholeForbidden = join(dir, 'whole-forbidden.txt');
  const sixth = await askGateway(port, {
    model: 'stub-tool-shim',
    file: wholeForbidden,
    stream: false,
  });
  check(
    'запрет действует и для клиента без потока',
    sixth.calls.length === 0 &&
      !existsSync(wholeForbidden) &&
      sixth.text.includes('<tool_result name="Write">'),
    `статус ${sixth.status}, вызовов ${sixth.calls.length}, текст: ${JSON.stringify(sixth.text.slice(-200))}`,
  );

  // ── 7. След запроса ──────────────────────────────────────────────────────
  const events = await eventsOf(port);
  const stopped = events.filter((event) => (event.toolsBlocked ?? []).includes('Write'));
  check(
    'след запроса называет остановленные вызовы',
    stopped.length >= 3,
    `следов с отказом ${stopped.length} из ${events.length}: ${JSON.stringify(events.map((event) => event.toolsBlocked ?? []))}`,
  );

  // ── 8. Ворот нет — прежнее поведение ─────────────────────────────────────
  const bare = join(dir, 'bare.txt');
  const seventh = await askGateway(port, {
    model: 'stub-tool-shim',
    file: bare,
    tag: BARE_TAG,
  });
  check(
    'прогон без ворот работает как раньше: вызов уезжает клиенту',
    seventh.calls.length === 1 && existsSync(bare),
    `вызовов ${seventh.calls.length}, файл ${existsSync(bare) ? 'есть' : 'НЕТ'}`,
  );
}

/**
 * Порчи самопроверки — по РАБОЧЕМУ коду, а не по стенду.
 *
 * Каждая снимает ровно одну половину провода, и каждая обязана покраснеть сама
 * по себе. Две из трёх — это дефекты, которые проверка нашла на самом деле: имя
 * поля аргументов на шве доменов и потерянная причина из stderr. Порча, которую
 * проверка не замечает, означает, что соответствующая строка обещания не
 * проверяется ничем.
 */
const DAMAGES = {
  'no-hold': {
    title: 'вызов не придерживается — уезжает клиенту, не спросив хука',
    file: 'apps/server/src/domains/platform/gateway/frames.ts',
    from: '        this.#pending.push({ call: prepared.call, payload });',
    to: '        this.#calls.push(prepared.call);',
  },
  'empty-args': {
    title: 'аргументы вызова не доезжают до нагрузки хука',
    file: 'apps/server/src/domains/portability/wire/tool-gate.ts',
    from: '        call: { id: call.id, name: call.name, input: call.arguments },',
    to: '        call: { id: call.id, name: call.name, input: undefined },',
  },
  'mute-reason': {
    title: 'причина отказа из stderr скрипта теряется',
    file: 'apps/server/src/domains/portability/supervisor/run.ts',
    from: '      : ((parsed === undefined && script.exitCode === 2 && said ? said : undefined) ??\n        verdict.reason);',
    to: '      : verdict.reason;',
  },
};

function damageFiles(damage) {
  const spec = DAMAGES[damage];
  const path = new URL(`../../${spec.file}`, import.meta.url);
  const before = readFileSync(path, 'utf8');
  if (!before.includes(spec.from)) {
    throw new NotChecked(
      `порча «${damage}» не нашла своё место в ${spec.file}: код поменялся, и самопроверка ` +
        'проверяла бы не то, что называет.',
    );
  }
  writeFileSync(path, before.replace(spec.from, spec.to), 'utf8');
  return () => writeFileSync(path, before, 'utf8');
}

async function main() {
  if (SELFTEST) {
    let missed = 0;
    for (const [damage, spec] of Object.entries(DAMAGES)) {
      const restore = damageFiles(damage);
      let seen;
      try {
        seen = await probe();
      } finally {
        restore();
      }
      if (seen === 0) {
        console.error(`Самопроверка: «${spec.title}» прошла незамеченной — проверка не краснеет.`);
        missed += 1;
      } else {
        console.log(`Самопроверка: «${spec.title}» замечена (провалов ${seen}).`);
      }
    }
    process.exit(missed > 0 ? 1 : 0);
  }

  const seen = await probe();
  console.log(seen === 0 ? '\nВсё сходится.' : `\nПровалов: ${seen}`);
  process.exit(seen === 0 ? 0 : 1);
}

async function probe() {
  tally.reset();
  const stub = await startStubPlatform({ port: 0 });
  const dir = mkdtempSync(join(tmpdir(), 'cc-wire-hooks-'));
  const hookPath = join(dir, 'pre-tool-use.cjs');
  const hookReport = join(dir, 'hook-report.json');
  writeFileSync(hookPath, HOOK_SCRIPT, 'utf8');

  const driver = await startGatewayDriver({
    dir,
    source: DRIVER,
    job: {
      appDataDir: dir,
      contour: CONTOUR,
      upstream: stub.url,
      key: KEY,
      runTag: RUN_TAG,
      providerId: 'codex',
      hookPath,
    },
    env: { HOOK_REPORT: hookReport },
  });

  try {
    console.log(`Стаб-контур: ${stub.url}\nШлюз проверки: http://127.0.0.1:${driver.port}\n`);
    await run(dir, driver.port, hookReport);
  } finally {
    driver.stop();
    await stub.close();
    rmSync(dir, { recursive: true, force: true });
  }

  return tally.failures;
}

main().catch((error) => {
  if (error instanceof NotChecked) {
    console.error(`НЕ ПРОВЕРЕНО: ${error.message}`);
    process.exit(2);
  }
  console.error(error);
  process.exit(1);
});
