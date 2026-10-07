/**
 * Codex через шлюз панели (MAP D): настоящий `codex exec` → ручка `/v1/responses`
 * шлюза → стаб-контур, который говорит только на `chat/completions`.
 *
 * Подменён только контур (`stub-platform.mjs`, сетевая граница). Codex —
 * настоящий: из `STEER_CLI_DIR`, потом PATH; его дом — временный `CODEX_HOME`,
 * настоящий `~/.codex` не читается и не пишется. Шлюз — настоящий слушатель
 * панели в этом же процессе, с контуром во временном каталоге данных.
 *
 * Проверяется:
 *   1. текстовый ход: ответ контура доходит до вывода codex; наверх ушёл
 *      `chat/completions` с ключом контура, а не с ключом codex; в следе шлюза
 *      запрос записан маршрутом `/v1/responses` с расходом;
 *   2. ход с инструментом: контур отвечает вызовом текстом прослойки, codex
 *      получает его элементом `function_call`, ИСПОЛНЯЕТ, и файл появляется на
 *      диске; второй запрос несёт вывод инструмента, и ход кончается текстом;
 *   3. отказ контура (`stub-401`) доходит до codex ошибкой, а не пустым ответом.
 *
 * Запуск: `STEER_CLI_DIR=<каталог с codex> node tools/qa/check-codex-gateway.mjs`
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { fileURLToPath } from 'node:url';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';

const IS_WIN = process.platform === 'win32';
/** Собран из кусков: в репозитории не должно лежать присваивание, похожее на ключ. */
const SECRET = ['contour', 'codex', 'key', '4b7e'].join('-');
const CODEX_KEY = ['codex', 'local', 'x'].join('-');
const CONTOUR = 'codex-company';

let bad = 0;
const check = (ok, text, detail) => {
  console.log(`${ok ? '✓' : '✗'} ${text}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) bad += 1;
};

function findCodex() {
  const names = IS_WIN ? ['codex.cmd', 'codex.exe', 'codex'] : ['codex'];
  const dirs = [
    ...(process.env.STEER_CLI_DIR ? process.env.STEER_CLI_DIR.split(delimiter) : []),
    ...(process.env.PATH ?? process.env.Path ?? '').split(delimiter),
  ];
  for (const dir of dirs) {
    const name = dir && names.find((file) => existsSync(join(dir, file)));
    if (name) return join(dir, name);
  }
  return undefined;
}

/** `codex exec` с временным домом; вывод целиком, код выхода. */
function runCodex(cli, { home, cwd, prompt, model, hangMs = 60_000, onHang }) {
  const args = [
    'exec',
    '--skip-git-repo-check',
    '--dangerously-bypass-approvals-and-sandbox',
    '-m',
    model,
    prompt,
  ];
  const env = { ...process.env, CODEX_HOME: home, AGENTDECK_CODEX_KEY: CODEX_KEY };
  return new Promise((resolve) => {
    const child = IS_WIN
      ? spawn(`"${cli}" ${args.map((arg) => `"${arg}"`).join(' ')}`, { cwd, env, shell: true })
      : spawn(cli, args, { cwd, env });
    // Без закрытого stdin `codex exec` ждёт дописки промпта («Reading additional input from stdin»).
    child.stdin.end();
    let out = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (out += chunk));
    // На Windows codex сидит под cmd: `kill` снял бы оболочку, а сам codex
    // держал бы трубы открытыми, и `close` не пришёл бы никогда.
    const timer = setTimeout(() => {
      onHang?.();
      console.log(`  вывод codex к этому моменту:
${out.slice(-1500)}`);
      // Дерево могло не сняться — ответ всё равно возвращается, чтобы проверка дошла до конца.
      setTimeout(() => resolve({ code: 'hang', out }), 3000);
      if (IS_WIN) spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)]);
      else child.kill();
    }, hangMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

async function main() {
  const { AppStore } = await import('../../apps/server/src/lib/app-store.ts');
  const { PlatformGateway } =
    await import('../../apps/server/src/domains/platform/gateway/listener.ts');
  const { writePlatform, writeToken } =
    await import('../../apps/server/src/domains/platform/store.ts');
  const { defaultOurRules, defaultPlatformRules } =
    await import('../../packages/contracts/src/platform.ts');
  const { defaultPlatformTransport } =
    await import('../../packages/contracts/src/platform-transport.ts');
  const { startStubPlatform } = await import('./stub-platform.mjs');

  const cli = findCodex();
  if (!cli) {
    // Код 2 — «не проверено» для junit-run: нет CLI — не дефект продукта.
    console.log('Не проверено: codex нет ни в STEER_CLI_DIR, ни в PATH.');
    process.exit(2);
  }
  console.log(`codex: ${cli}`);

  const root = mkdtempSync(join(tmpdir(), 'cc-codex-gw-'));
  const appData = join(root, 'agentdeck');
  const home = join(root, 'codex-home');
  const work = join(root, 'work');
  for (const dir of [appData, home, work]) mkdirSync(dir, { recursive: true });

  const stub = await startStubPlatform({ port: 0 });
  const gateway = new PlatformGateway();
  const closers = [];
  try {
    const store = new AppStore(appData);
    writePlatform(store, {
      id: CONTOUR,
      title: 'Codex через шлюз',
      driver: 'enterprise-platform',
      baseUrl: stub.url,
      enabled: true,
      mode: 'required',
      budgetUsd: 0,
      budgetSince: '',
      capabilities: [],
      targets: [],
      consumers: [],
      projectPaths: [],
      agents: [],
      toolShim: true,
      contourPrompt: true,
      defaultModel: '',
      consumerModels: {},
      modelMap: {},
      rules: { platform: defaultPlatformRules(), ours: defaultOurRules() },
      caCertPath: '',
      transport: defaultPlatformTransport(),
    });
    writeToken(appData, CONTOUR, SECRET);
    await gateway.start({ store, appDataDir: appData, port: 0, spendFlushMs: 0 });
    const gatewayPort = gateway.status().port;
    // Пишущий посредник между codex и шлюзом: при зависании видно, ЧТО codex
    // получил на самом деле, а не что шлюз считал отправленным.
    const wire = [];
    const proxy = createServer((req, res) => {
      const entry = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        out: '',
        ended: false,
      };
      wire.push(entry);
      const up = httpRequest(
        {
          host: '127.0.0.1',
          port: gatewayPort,
          path: req.url,
          method: req.method,
          headers: req.headers,
        },
        (upRes) => {
          entry.status = upRes.statusCode;
          res.writeHead(upRes.statusCode ?? 502, upRes.headers);
          upRes.on('data', (chunk) => {
            entry.out += chunk;
            res.write(chunk);
          });
          upRes.on('end', () => {
            entry.ended = true;
            res.end();
          });
        },
      );
      req.pipe(up);
    });
    await new Promise((done) => proxy.listen(0, '127.0.0.1', done));
    closers.push(() => new Promise((done) => proxy.close(done)));
    const base = `http://127.0.0.1:${proxy.address().port}/${CONTOUR}/v1`;
    writeFileSync(
      join(home, 'config.toml'),
      [
        'model_provider = "agentdeck"',
        'check_for_update_on_startup = false',
        '[model_providers.agentdeck]',
        'name = "agentdeck"',
        `base_url = "${base}"`,
        'wire_api = "responses"',
        'env_key = "AGENTDECK_CODEX_KEY"',
        // Фоновые походы codex к сервисам OpenAI (проверка обновлений, аналитика,
        // синхронизация плагинов) к проверке шлюза не относятся, а выход codex
        // ждал их и зависал после уже законченного хода.
        '[analytics]',
        'enabled = false',
        '[features]',
        'plugins = false',
        '',
      ].join('\n'),
    );

    console.log('\n1. Текстовый ход');
    {
      const before = stub.calls.length;
      const run = await runCodex(cli, {
        home,
        cwd: work,
        prompt: 'скажи готов',
        model: 'stub-chat',
        onHang: () =>
          console.log(
            `  ЗАВИС: провод ${JSON.stringify(wire.map((w) => ({ m: w.method, u: w.url, s: w.status, ended: w.ended, enc: w.headers['content-encoding'], tail: w.out.slice(-300) })))}
  контур видел ${JSON.stringify(stub.calls.slice(before).map((c) => `${c.method} ${c.path}`))}, шлюз ${JSON.stringify(gateway.status().events.map((e) => [e.path, e.status]))}`,
          ),
      });
      const ups = stub.calls.slice(before).filter((call) => call.method === 'POST');
      check(run.code === 0, 'codex exec завершился нулём', `${run.code}: ${run.out.slice(-600)}`);
      check(run.out.includes('готов'), 'ответ контура «готов» в выводе codex', run.out.slice(-400));
      check(
        ups.length > 0 && ups.every((call) => call.path.endsWith('/chat/completions')),
        'наверх ушёл только chat/completions',
        ups.map((call) => call.path).join(', '),
      );
      check(
        ups.every((call) => String(call.authorization).includes(SECRET)),
        'наверх — ключ контура',
      );
      check(
        ups.every((call) => !String(call.authorization).includes(CODEX_KEY)),
        'ключ codex наверх не ушёл',
      );
      const events = gateway.status().events.filter((event) => event.path.endsWith('/responses'));
      check(
        events.length > 0 && events.every((event) => event.status === 200),
        'след шлюза: маршрут /v1/responses, статус 200',
        JSON.stringify(events.map((event) => [event.path, event.status])),
      );
      const shimmed = events.at(-1)?.shimmed ?? [];
      console.log(`  инструменты codex (текстом прослойки): ${shimmed.join(', ') || '—'}`);
      if (process.env.DUMP) writeFileSync(process.env.DUMP, ups.at(-1)?.body ?? '');
      console.log(`  потери перевода: ${(events.at(-1)?.lost ?? []).join(', ') || '—'}`);
    }

    console.log('\n2. Ход с инструментом: вызов текстом прослойки → codex исполняет');
    {
      // `mkdir` одинаково понимают cmd, PowerShell и sh: доказательство — каталог
      // на диске, созданный самим codex, а не строка в его выводе.
      const marker = 'codex-gateway-marker';
      const before = stub.calls.length;
      const eventsBefore = gateway.status().events.length;
      const run = await runCodex(cli, {
        home,
        cwd: work,
        prompt: `выполни. ВЫЗОВ: {'name': 'exec_command', 'arguments': {'cmd': 'mkdir ${marker}'}};;`,
        model: 'stub-tool-any',
      });
      const ups = stub.calls.slice(before).filter((call) => call.method === 'POST');
      check(run.code === 0, 'codex exec завершился нулём', `${run.code}: ${run.out.slice(-600)}`);
      check(
        existsSync(join(work, marker)),
        'каталог создан командой, которую codex исполнил по вызову из шлюза',
        run.out.slice(-600),
      );
      check(
        ups.length === 2,
        'наверх ушло два запроса: вызов и ответ на его вывод',
        String(ups.length),
      );
      const second = ups[1]?.body ?? '';
      // Прослойка везёт вывод инструмента наверх тем же текстом протокола, что и
      // вызов: контур принимает только текст.
      check(
        second.includes('</tool_result>') && second.includes(marker),
        'второй запрос несёт вывод исполненной команды блоком <tool_result>',
        second.slice(-300),
      );
      check(
        run.out.includes('вызов отработан'),
        'ход кончился текстом контура',
        run.out.slice(-300),
      );
      const events = gateway.status().events.slice(eventsBefore);
      check(
        events.length === 2 && events.every((event) => event.status === 200),
        'в следе шлюза оба запроса /v1/responses со статусом 200',
        JSON.stringify(events.map((event) => [event.path, event.status])),
      );
    }

    console.log('\n3. Отказ контура доходит до codex');
    {
      const run = await runCodex(cli, {
        home,
        cwd: work,
        prompt: 'скажи готов',
        model: 'stub-401',
      });
      check(run.code !== 0 && run.code !== 'hang', 'codex завершился ошибкой', String(run.code));
      check(
        /401|unauthor|invalid/i.test(run.out),
        'в выводе codex — отказ контура, а не пустой ответ',
        run.out.slice(-500),
      );
    }
  } finally {
    for (const close of closers) await close();
    await gateway.stop();
    await stub.close();
    // `KEEP_SESSIONS=<каталог>` — сохранить настоящие файлы сессий codex этого
    // прогона: по ним сверяется разбор аналитики (формат — не по документации).
    if (process.env.KEEP_SESSIONS && existsSync(join(home, 'sessions'))) {
      cpSync(join(home, 'sessions'), process.env.KEEP_SESSIONS, { recursive: true });
    }
    rmSync(root, { recursive: true, force: true });
  }
  console.log(bad === 0 ? '\nВсё сходится.' : `\nПровалов: ${bad}`);
  process.exit(bad === 0 ? 0 : 1);
}

if (!process.features.typescript && !process.env.CC_CODEX_GW_RETRY) {
  const result = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url)],
    { stdio: 'inherit', env: { ...process.env, CC_CODEX_GW_RETRY: '1' } },
  );
  process.exit(result.status ?? 1);
} else {
  await main();
}
