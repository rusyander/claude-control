/**
 * Сообщение посреди ответа чужого CLI (В1) — настоящими CLI, через настоящую панель.
 *
 * На каждый CLI (Codex — `app-server`, Qwen — `serve`, Goose — `acp`, Kimi Code —
 * `web`, OpenCode — сессия `serve`) свой одноразовый стенд (`throwaway-stand.mjs`) и заглушка модели
 * (`stub-steer-model.mjs`), держащая ход занятым. Сценарий — путь человека через
 * API панели: вопрос → ход стал «принимающим» → второе сообщение с меткой,
 * пока модель держит ход → ответ. Доказательство — у модели: метка пришла ей
 * в ТОМ ЖЕ ходе (ответ «STEER_SEEN»), второго хода и очереди не было.
 *
 * Подменена только модель (сетевая граница). CLI — настоящие: из `STEER_CLI_DIR`
 * (каталоги через разделитель PATH), иначе из PATH. Нет CLI — «не проверено» по
 * нему, не провал. Дома CLI — временные каталоги: настоящие `~/.codex`, `~/.qwen`,
 * данные Goose, `~/.kimi-code`, конфиг OpenCode и `~/.claude` не трогаются.
 *
 * Код выхода: 1 — провал; 2 — провалов нет, но хоть один CLI не проверен; 0 — всё.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { NotChecked, startStand, wait } from './throwaway-stand.mjs';
import { startStubModel } from './stub-steer-model.mjs';

const IS_WIN = process.platform === 'win32';
const cliDir = process.env.STEER_CLI_DIR;
const only = process.argv.slice(2);

/** Где лежит CLI: сначала `STEER_CLI_DIR`, потом PATH. */
function findCli(name) {
  const names = IS_WIN ? [`${name}.cmd`, `${name}.exe`, name] : [name];
  const dirs = [
    ...(cliDir ? cliDir.split(delimiter) : []),
    ...(process.env.PATH ?? process.env.Path ?? '').split(delimiter),
  ];
  return dirs.find((dir) => dir && names.some((file) => existsSync(join(dir, file))));
}

/**
 * PID процессов, запущенных из каталога CLI. Стенд снимает панель жёстко, и её
 * `exit`, гасящий `opencode serve`, не успевает отработать: сервер CLI
 * пережил бы проверку. Снимаем ровно то, чего до прогона не было.
 */
function cliProcesses(dir) {
  // Сравниваем без регистра и с одним видом разделителя: Windows пишет путь как придётся.
  const norm = (text) => text.toLowerCase().replace(/[\\/]+/g, '/');
  const needle = norm(dir).replace(/\/+$/, '');
  try {
    const rows = IS_WIN
      ? execFileSync(
          'powershell',
          [
            '-NoProfile',
            '-Command',
            'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)`t$($_.CommandLine)" }',
          ],
          { encoding: 'utf8' },
        )
      : execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' });
    return new Set(
      rows
        .split(/\r?\n/)
        .map((row) => row.trim().match(/^(\d+)\s+(.*)$/))
        .filter((match) => match && norm(match[2]).includes(needle))
        .map((match) => Number(match[1])),
    );
  } catch {
    return new Set();
  }
}

function reap(before, dir) {
  for (const pid of cliProcesses(dir)) {
    if (before.has(pid) || pid === process.pid) continue;
    try {
      process.kill(pid);
    } catch {
      // уже вышел
    }
  }
}

/**
 * Окружение CLI на стенд: адрес заглушки и временный дом. Переменные ложатся в
 * окружение этого процесса до старта стенда — панель наследует их, CLI тоже.
 */
const CLIS = {
  codex: {
    transport: 'live',
    env: (root, base) => {
      const home = join(root, 'codex-home');
      mkdirSync(home, { recursive: true });
      writeFileSync(
        join(home, 'config.toml'),
        [
          'model_provider = "stub"',
          'model = "stub-model"',
          '[model_providers.stub]',
          'name = "stub"',
          `base_url = "${base}/v1"`,
          'wire_api = "responses"',
          'env_key = "STUB_KEY"',
          '',
        ].join('\n'),
      );
      return { CODEX_HOME: home, STUB_KEY: 'x' };
    },
  },
  qwen: {
    transport: 'live',
    env: (root, base) => {
      const home = join(root, 'qwen-home');
      mkdirSync(home, { recursive: true });
      return {
        QWEN_HOME: home,
        OPENAI_BASE_URL: `${base}/v1`,
        OPENAI_API_KEY: 'x',
        OPENAI_MODEL: 'stub-model',
      };
    },
  },
  goose: {
    transport: 'live',
    // Дом Goose (APPDATA/XDG) — уже временный дом стенда; ключ — переменной, не связкой ключей.
    env: (_root, base) => ({
      GOOSE_PROVIDER: 'openai',
      GOOSE_MODEL: 'stub-model',
      OPENAI_HOST: base,
      OPENAI_BASE_PATH: 'v1/chat/completions',
      OPENAI_API_KEY: 'x',
      GOOSE_DISABLE_KEYRING: '1',
    }),
  },
  kimi: {
    transport: 'live',
    // Модель — запись своей таблицы `[models]` в config.toml; `auto` — инструмент
    // заглушки выполняется без вопроса, как в `kimi -p`.
    env: (root, base) => {
      const home = join(root, 'kimi-home');
      mkdirSync(home, { recursive: true });
      writeFileSync(
        join(home, 'config.toml'),
        [
          'default_model = "stub"',
          'default_permission_mode = "auto"',
          '[providers.stub]',
          'type = "openai"',
          `base_url = "${base}/v1"`,
          'api_key = "x"',
          '[models.stub]',
          'provider = "stub"',
          'model = "stub-model"',
          'max_context_size = 128000',
          '',
        ].join('\n'),
      );
      return { KIMI_CODE_HOME: home };
    },
  },
  opencode: {
    transport: 'session',
    env: (root, base) => {
      const config = join(root, 'opencode.json');
      writeFileSync(
        config,
        JSON.stringify({
          $schema: 'https://opencode.ai/config.json',
          provider: {
            stub: {
              npm: '@ai-sdk/openai-compatible',
              name: 'stub',
              options: { baseURL: `${base}/v1`, apiKey: 'x' },
              models: { 'stub-model': { name: 'stub', tool_call: true } },
            },
          },
          model: 'stub/stub-model',
          permission: { bash: 'allow', edit: 'allow' },
        }),
      );
      const xdg = (name) => {
        const dir = join(root, name);
        mkdirSync(dir, { recursive: true });
        return dir;
      };
      return {
        OPENCODE_CONFIG: config,
        XDG_CONFIG_HOME: xdg('xdg-config'),
        XDG_DATA_HOME: xdg('xdg-data'),
        XDG_STATE_HOME: xdg('xdg-state'),
        XDG_CACHE_HOME: xdg('xdg-cache'),
      };
    },
  },
};

let failures = 0;
const skipped = [];
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ✓ ${name}`);
  else {
    failures += 1;
    console.log(`  ✗ ${name}${detail ? `\n    ${detail}` : ''}`);
  }
  return condition;
};

/** Ждать, пока условие станет правдой; `undefined` — не дождались. */
async function until(probe, seconds) {
  for (let i = 0; i < seconds * 4; i += 1) {
    const value = await probe();
    if (value) return value;
    await wait(250);
  }
  return undefined;
}

async function checkCli(name, spec) {
  console.log(`\n${name}`);
  const dir = findCli(name);
  if (!dir) {
    skipped.push(name);
    console.log(`  Не проверено: «${name}» нет ни в STEER_CLI_DIR, ни в PATH.`);
    return;
  }
  const marker = `STEER-MARK-${Math.random().toString(36).slice(2, 8)}`;
  const stub = await startStubModel({ marker, holdMs: 8000 });
  const root = mkdtempSync(join(tmpdir(), `cc-steer-${name}-`));
  const added = spec.env(root, `http://127.0.0.1:${stub.port}`);
  const saved = { PATH: process.env.PATH };
  for (const key of Object.keys(added)) saved[key] = process.env[key];
  Object.assign(process.env, added, { PATH: `${dir}${delimiter}${process.env.PATH ?? ''}` });

  const before = cliProcesses(dir);
  let stand;
  try {
    stand = await startStand({ web: false, label: `steer-${name}`, settings: { provider: name } });
    const chat = await stand.api('/provider-chat/chats', { method: 'POST', body: {} });
    if (!check('разговор создан', chat.status === 200 && chat.body?.id, chat.text)) return;
    const id = chat.body.id;
    // Разговор без «Разрешить правки» отдаёт каждую просьбу CLI о команде
    // человеку карточкой (`ProviderChatService` → `decidePermission`), а здесь
    // отвечать на неё некому: Codex ждал решения, модель — результата, и ход
    // вставал до метки. Проверка — про сообщение посреди хода, не про права.
    const rights = await stand.api(`/provider-chat/chats/${id}`, {
      method: 'PATCH',
      body: { allowEdits: true },
    });
    if (!check('правки разрешены (вопросов о командах нет)', rights.status === 200, rights.text))
      return;
    const status = async () => (await stand.api(`/provider-chat/chats/${id}/status`)).body;

    const first = await stand.api(`/provider-chat/chats/${id}/send`, {
      method: 'POST',
      body: { text: 'Первый вопрос: ответь, когда закончишь.' },
    });
    if (!check('вопрос принят', first.status === 200, first.text)) return;

    const steerable = await until(async () => (await status())?.steerable === true, 90);
    if (
      !check(
        'статус: ход принимает сообщения посреди ответа',
        steerable,
        JSON.stringify(await status()),
      )
    ) {
      // Ход кончился, не начавшись: причина — в последней реплике (ошибка CLI),
      // а журнал панели о ней молчит.
      const messages = (await stand.api(`/provider-chat/chats/${id}`)).body?.messages ?? [];
      console.log(
        `    последняя реплика: ${JSON.stringify(messages.at(-1) ?? null).slice(0, 800)}`,
      );
      console.log(`    модель получила запросов: ${stub.requests.length}`);
      console.log(stand.log().slice(-1500));
      return;
    }
    const holding = await until(() => stub.isHolding(), 90);
    if (!check('модель держит ход', holding, JSON.stringify(stub.requests))) return;

    const steer = await stand.api(`/provider-chat/chats/${id}/send`, {
      method: 'POST',
      body: { text: `Учти ещё ${marker}`, queueIfBusy: true },
    });
    check(
      'сообщение посреди ответа принято ходом (200, steered)',
      steer.status === 200 && steer.body?.steered === true,
      `${steer.status} ${steer.text}`,
    );

    const ended = await until(async () => (await status())?.isRunning === false, 120);
    check('ход кончился', ended, JSON.stringify(await status()));
    const after = await status();
    check(
      'очереди нет, «принимает» снято',
      !after?.queued && !after?.steerable,
      JSON.stringify(after),
    );

    const messages = (await stand.api(`/provider-chat/chats/${id}`)).body?.messages ?? [];
    const shape = messages.map((item) => `${item.role}${item.steered ? ':steered' : ''}`);
    check(
      'переписка: вопрос, подхваченное сообщение, ОДИН ответ',
      shape.join(',') === 'user,user:steered,assistant',
      shape.join(','),
    );
    const answer = messages.at(-1);
    check(
      'метка дошла до модели в том же ходе (STEER_SEEN в ответе)',
      answer?.role === 'assistant' && answer.content.includes('STEER_SEEN'),
      answer?.content,
    );
    check(
      `ответ транспортом ${spec.transport}`,
      answer?.transport === spec.transport,
      String(answer?.transport),
    );
    check(
      'модель получила метку запросом этого прогона',
      stub.requests.some((request) => request.marker),
      JSON.stringify(stub.requests.map((request) => [request.n, request.marker, request.reply])),
    );

    // Обратная сторона: хода нет — сообщение уходит обычной отправкой, а не «посреди».
    const idle = await stand.api(`/provider-chat/chats/${id}/send`, {
      method: 'POST',
      body: { text: 'Новый вопрос после ответа.', queueIfBusy: true },
    });
    check(
      'без идущего хода — обычная отправка, не steered',
      idle.status === 200 && idle.body?.steered === undefined && !idle.body?.queued,
      `${idle.status} ${idle.text}`,
    );
    await until(async () => (await status())?.isRunning === false, 120);
  } catch (error) {
    if (error instanceof NotChecked) {
      skipped.push(name);
      console.log(`  Не проверено: ${error.message}`);
    } else check('сценарий дошёл до конца', false, error?.stack ?? String(error));
  } finally {
    if (stand) await stand.stop();
    reap(before, dir);
    await wait(500);
    // Сервер CLI писал в дом стенда до самого снятия — стенд не смог его стереть.
    if (stand) rmSync(stand.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    await stub.close();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    } catch (error) {
      // Каталог держит пережившая проверку дочка CLI (Codex запускает `git`):
      // это не провал сценария, но и не молчание — остаток назван.
      console.log(`  ! временный каталог не удалён: ${root} (${error.code ?? error.message})`);
    }
  }
}

for (const [name, spec] of Object.entries(CLIS)) {
  if (only.length > 0 && !only.includes(name)) continue;
  await checkCli(name, spec);
}

if (failures > 0) {
  console.log(`\nПровалов: ${failures}`);
  process.exit(1);
}
if (skipped.length > 0) {
  console.log(`\nПровалов нет; не проверено: ${skipped.join(', ')}`);
  process.exit(2);
}
console.log('\nВсё сходится.');
process.exit(0);
