/**
 * Continue (`cn`) в чате панели — настоящий `cn` через настоящую панель.
 *
 * Свой одноразовый стенд (`throwaway-stand.mjs`, только API) с активным
 * continue; дом стенда несёт `~/.continue/config.yaml` с одной моделью
 * `provider: openai`, чей `apiBase` — заглушка ниже (сетевая граница).
 * Заглушка первым ответом зовёт инструмент правки (`Write`, если `cn` его
 * показал, иначе оболочку `Bash`), который пишет файл в каталог разговора; вторым
 * — отдаёт заготовленный текст.
 *
 * Что доказывается:
 *   1. «Разрешить правки» выключено → `cn` не показал модели ни `Write`/`Edit`/
 *      `MultiEdit`, ни `Bash`, файл в каталоге разговора НЕ тронут;
 *   2. включено → файл переписан;
 *   3. ответ — ровно текст заглушки, без служебного вывода CLI;
 *   4. `ANTHROPIC_API_KEY` в окружении панели не переписал `config.yaml` (без
 *      `--config` `cn -p` дописывает туда модели Claude с ключом);
 *   5. настоящие каталоги CLI человека не тронуты (снимок до/после).
 *
 * `cn` — из `CONTINUE_CLI_DIR` / `STEER_CLI_DIR` (каталоги через разделитель
 * PATH), иначе из PATH. Нет его — «не проверено» (код 2), не провал.
 * Код выхода: 0 — сходится, 1 — провал, 2 — не проверено.
 */
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import {
  NotChecked,
  diffRealProviderDirs,
  runOnStand,
  snapshotRealProviderDirs,
  wait,
} from './throwaway-stand.mjs';

const IS_WIN = process.platform === 'win32';
const CANNED = 'CN_STUB_CANNED_REPLY_7f3a';
const PROBE = 'cn-probe.txt';
const ORIGINAL = 'original-content';
const WRITTEN = 'written-by-cn';
const EDIT_TOOLS = ['Write', 'Edit', 'MultiEdit', 'Bash'];
// Ключ-приманка: настоящий ключ никуда не уходит; ищем его потом в config.yaml.
const ANTHROPIC_SENTINEL = 'sk-ant-SENTINEL-cli-continue-not-a-key';

function findCliDir() {
  const names = IS_WIN ? ['cn.cmd', 'cn.exe', 'cn'] : ['cn'];
  const dirs = [
    ...(process.env.CONTINUE_CLI_DIR ? process.env.CONTINUE_CLI_DIR.split(delimiter) : []),
    ...(process.env.STEER_CLI_DIR ? process.env.STEER_CLI_DIR.split(delimiter) : []),
    ...(process.env.PATH ?? process.env.Path ?? '').split(delimiter),
  ];
  return dirs.find((dir) => dir && names.some((file) => existsSync(join(dir, file))));
}

/** Заглушка OpenAI `/chat/completions` (поток SSE) с журналом запросов. */
function startStub() {
  const requests = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      if (!req.url.includes('chat/completions')) {
        requests.push({ url: req.url, other: true });
        res.writeHead(404);
        res.end('{}');
        return;
      }
      let parsed = {};
      try {
        parsed = JSON.parse(body);
      } catch {
        // не JSON — пусть будет пустой запрос
      }
      const tools = (parsed.tools ?? []).map((tool) => tool.function?.name);
      const answered = (parsed.messages ?? []).some((message) => message.role === 'tool');
      // Оболочка `cn` на Windows — PowerShell, иначе login-shell: строка одна для обеих.
      const writeLine = `node -e "require('fs').writeFileSync('${PROBE}','${WRITTEN}')"`;
      let call;
      if (!answered && tools.includes('Write'))
        call = { name: 'Write', args: { filepath: PROBE, content: WRITTEN } };
      else if (!answered && tools.includes('Bash'))
        call = { name: 'Bash', args: { command: writeLine } };
      requests.push({ url: req.url, tools, answered, call: call?.name, model: parsed.model });

      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const send = (delta, finish = null) =>
        res.write(
          `data: ${JSON.stringify({
            id: 'stub',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'stub-model',
            choices: [{ index: 0, delta, finish_reason: finish }],
          })}\n\n`,
        );
      if (call) {
        send({
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: `call_${requests.length}`,
              type: 'function',
              function: { name: call.name, arguments: JSON.stringify(call.args) },
            },
          ],
        });
        send({}, 'tool_calls');
      } else {
        send({ role: 'assistant', content: CANNED });
        send({}, 'stop');
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  return new Promise((done) =>
    server.listen(0, '127.0.0.1', () =>
      done({
        port: server.address().port,
        requests,
        close: () =>
          new Promise((closed) => {
            server.closeAllConnections();
            server.close(() => closed());
          }),
      }),
    ),
  );
}

const cliDir = findCliDir();
if (!cliDir) {
  console.log('Не проверено: `cn` (@continuedev/cli) не найден — задайте CONTINUE_CLI_DIR.');
  process.exit(2);
}
const stub = await startStub();
const configText = [
  'name: Stand',
  'version: 1.0.0',
  'schema: v1',
  'models:',
  '  - name: stub',
  '    provider: openai',
  '    model: stub-model',
  `    apiBase: http://127.0.0.1:${stub.port}/v1`,
  '    apiKey: sk-stub-not-a-key',
  '    roles:',
  '      - chat',
  '',
].join('\n');

const realBefore = snapshotRealProviderDirs();
let configPath;

await runOnStand(
  {
    label: 'cli-continue',
    web: false,
    noClaude: true,
    settings: { provider: 'continue' },
    extraPath: [cliDir],
    env: { ANTHROPIC_API_KEY: ANTHROPIC_SENTINEL },
    seed: ({ home }) => {
      mkdirSync(join(home, '.continue'), { recursive: true });
      configPath = join(home, '.continue', 'config.yaml');
      writeFileSync(configPath, configText, 'utf8');
    },
  },
  async (stand, check) => {
    const until = async (probe, seconds) => {
      for (let i = 0; i < seconds * 2; i += 1) {
        const value = await probe();
        if (value) return value;
        await wait(500);
      }
      return undefined;
    };
    const cli = await stand.api('/chat/cli?provider=continue&refresh=1');
    if (cli.status !== 200 || !cli.body?.path)
      throw new NotChecked(`панель не видит cn: ${cli.text.slice(0, 300)}`);

    const project = (name) => {
      const dir = join(stand.root, 'work', name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, PROBE), ORIGINAL, 'utf8');
      return dir;
    };
    const runTurn = async (dir, allowEdits) => {
      const created = await stand.api('/provider-chat/chats', {
        method: 'POST',
        body: { workdir: dir },
      });
      if (created.status !== 200) throw new Error(`разговор не создан: ${created.text}`);
      const id = created.body.id;
      const patched = await stand.api(`/provider-chat/chats/${id}`, {
        method: 'PATCH',
        body: { allowEdits },
      });
      check(`allowEdits=${allowEdits} записан`, patched.status === 200, patched.text);
      const from = stub.requests.length;
      const sent = await stand.api(`/provider-chat/chats/${id}/send`, {
        method: 'POST',
        body: { text: 'Перепиши файл cn-probe.txt.' },
      });
      check('вопрос принят', sent.status === 200, sent.text);
      const done = await until(
        async () =>
          (await stand.api(`/provider-chat/chats/${id}/status`)).body?.isRunning === false,
        180,
      );
      check('ход кончился', Boolean(done));
      const messages = (await stand.api(`/provider-chat/chats/${id}`)).body?.messages ?? [];
      return { messages, requests: stub.requests.slice(from) };
    };

    // 1. Правки выключены.
    console.log('1. «Разрешить правки» выключено');
    const offDir = project('off');
    const off = await runTurn(offDir, false);
    const offTools = off.requests.flatMap((request) => request.tools ?? []);
    check('cn сходил в заглушку', off.requests.length > 0, JSON.stringify(off.requests));
    check(
      'модели не показан ни один инструмент правки (Write/Edit/MultiEdit/Bash)',
      off.requests.length > 0 && !offTools.some((tool) => EDIT_TOOLS.includes(tool)),
      JSON.stringify([...new Set(offTools)]),
    );
    check(
      'файл в каталоге разговора не тронут',
      readFileSync(join(offDir, PROBE), 'utf8') === ORIGINAL,
      readFileSync(join(offDir, PROBE), 'utf8'),
    );
    const offAnswer = off.messages.at(-1);
    check(
      'ответ — ровно текст заглушки, без служебного вывода',
      offAnswer?.role === 'assistant' && offAnswer.content.trim() === CANNED,
      JSON.stringify(offAnswer),
    );

    // 2. Правки включены.
    console.log('\n2. «Разрешить правки» включено');
    const onDir = project('on');
    const on = await runTurn(onDir, true);
    const onCalls = on.requests.map((request) => request.call).filter(Boolean);
    check('модель позвала инструмент правки', onCalls.length > 0, JSON.stringify(on.requests));
    check(
      'файл переписан cn',
      readFileSync(join(onDir, PROBE), 'utf8').trim() === WRITTEN,
      readFileSync(join(onDir, PROBE), 'utf8'),
    );
    const onAnswer = on.messages.at(-1);
    check(
      'ответ — ровно текст заглушки',
      onAnswer?.role === 'assistant' && onAnswer.content.trim() === CANNED,
      JSON.stringify(onAnswer),
    );

    // 3. Конфиг человека и ключ из окружения.
    console.log('\n3. Конфиг и окружение');
    const after = readFileSync(configPath, 'utf8');
    check(
      'config.yaml байт-в-байт (ANTHROPIC_API_KEY из окружения его не переписал)',
      after === configText,
      after.includes(ANTHROPIC_SENTINEL) ? 'в файле ключ-приманка и модели Claude' : after,
    );
    check(
      'запросы шли только в заглушку (модель stub-model)',
      stub.requests.every((request) => request.other || request.model === 'stub-model'),
      JSON.stringify(stub.requests.map((request) => request.model)),
    );

    // 4. Настоящие каталоги CLI человека (`runOnStand` выходит сам — снимок здесь).
    const changed = diffRealProviderDirs(realBefore, snapshotRealProviderDirs());
    check(
      'настоящие каталоги CLI человека не тронуты',
      changed.length === 0,
      JSON.stringify(changed.slice(0, 10)),
    );
    await stub.close();
  },
);
