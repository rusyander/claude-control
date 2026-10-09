/**
 * Чужой CLI: первая запись и первый разговор — на НАСТОЯЩЕЙ модели CLI, а не
 * на заглушке. Кейс foreign-first-talk/ftalk-001 (TASKS «Не решается кодом»,
 * «Чужие CLI: первая запись и первый разговор»).
 *
 * Прочие живые проверки чужих CLI (`check-cli-opencode.mjs`,
 * `check-foreign-steer.mjs`) подменяют модель заглушкой: они доказывают провод
 * панели, но не то, что человек, поставивший CLI, получит ответ его собственной
 * модели. Здесь модель — та, что CLI выбирает сам, без флага модели (так панель
 * и запускает чужой CLI). Сеть до модели — настоящая.
 *
 * Свой одноразовый стенд (`throwaway-stand.mjs`): временный дом, так что запись
 * панели ложится в конфиг CLI внутри него, а настоящие каталоги человека
 * сверяются до и после (`snapshotRealProviderDirs`).
 *
 * Строки:
 *   W.  панель пишет глобальные инструкции CLI (`PUT /claude-md`) → файл на диске
 *       по пути, который назвала панель, внутри временного дома, с меткой;
 *   S1. первый вопрос — ответ идёт потоком: ≥2 `delta` до `done`;
 *   M.  второй вопрос помнит первый (число из первого вопроса в ответе);
 *   I.  (сведение) ответы несут метку из инструкций — CLI прочёл записанный файл;
 * OpenCode сверх того:
 *   OS. ответ пришёл через `opencode serve` (transport `session`);
 *   OF. модель, которой нет, — падение приходит в поток (`error`/реплика `failed`
 *       с текстом), отправка не падает 5xx и ход кончается сам.
 *
 * Запуск: `node tools/qa/check-foreign-first-talk.mjs --cli opencode`. CLI — из
 * PATH. Нет его — «не проверено», код 2. Код выхода: 0 / 1 провал / 2.
 *
 * `--local-model <имя в Ollama>` — у CLI нет своей модели без аккаунта (Aider,
 * Continue, Goose): проверка кладёт во временный дом СОБСТВЕННЫЙ конфиг модели
 * CLI (то, что человек пишет руками или `goose configure`) с Ollama на
 * 127.0.0.1:11434. Ollama поднимает человек; проверка её не трогает. CLI без
 * глобальных инструкций (Continue) — строка W «не применимо», разговор идёт.
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, isAbsolute } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  diffRealProviderDirs,
  runOnStand,
  snapshotRealProviderDirs,
  wait,
} from './throwaway-stand.mjs';

const IS_WIN = process.platform === 'win32';
const cliAt = process.argv.indexOf('--cli');
const CLI = cliAt > 0 ? process.argv[cliAt + 1] : 'opencode';
const TURN_LIMIT_MS = 240_000;
const modelAt = process.argv.indexOf('--local-model');
const LOCAL_MODEL = modelAt > 0 ? process.argv[modelAt + 1] : undefined;
const OLLAMA = 'http://127.0.0.1:11434';

/**
 * Собственный конфиг модели CLI во временном доме — по документированным
 * ключам каждого CLI (`.agent/provider-formats.agent.md`).
 */
const LOCAL_MODEL_SEEDS = {
  continue: (home, model) => [
    join(home, '.continue', 'config.yaml'),
    [
      'name: local',
      'version: 1.0.0',
      'schema: v1',
      'models:',
      '  - name: Local',
      '    provider: ollama',
      `    model: ${model}`,
      `    apiBase: ${OLLAMA}`,
      '    roles: [chat, edit, apply]',
      '',
    ].join('\n'),
  ],
  aider: (home, model) => [
    join(home, '.aider.conf.yml'),
    [`model: ollama_chat/${model}`, 'set-env:', `  - OLLAMA_API_BASE=${OLLAMA}`, ''].join('\n'),
  ],
  goose: (home, model) => [
    IS_WIN
      ? join(home, 'AppData', 'Roaming', 'Block', 'goose', 'config', 'config.yaml')
      : join(home, '.config', 'goose', 'config.yaml'),
    ['GOOSE_PROVIDER: ollama', `GOOSE_MODEL: ${model}`, `OLLAMA_HOST: ${OLLAMA}`, ''].join('\n'),
  ],
};

/**
 * CLI, чей неинтерактивный запуск отдаёт ответ одной записью при выходе, — по
 * замеру самого CLI в обход панели, не по документации.
 */
const WHOLE_ANSWER = {
  continue:
    '`cn -p` 1.5.47 пишет ответ в stdout одной записью перед выходом (замер 09.10: +5519 мс, выход 5548 мс)',
};

function seedLocalModel({ home }) {
  if (!LOCAL_MODEL) return;
  const make = LOCAL_MODEL_SEEDS[CLI];
  if (!make) throw new Error(`--local-model: для «${CLI}» конфиг модели не описан`);
  const [file, body] = make(home, LOCAL_MODEL);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body, 'utf8');
}

function findCliDir(name) {
  try {
    const out = execFileSync(IS_WIN ? 'where' : 'which', [name], { encoding: 'utf8' });
    const first = out.split(/\r?\n/).find(Boolean);
    return first ? dirname(first.trim()) : undefined;
  } catch {
    return undefined;
  }
}

/** Имя файла CLI, где оно не совпадает с id провайдера (`providers/catalog/*.ts`, `cli.command`). */
const BINARY = { continue: 'cn', cursor: 'cursor-agent', kimi: 'kimi' }[CLI] ?? CLI;
const cliDir = findCliDir(BINARY);
if (!cliDir) {
  console.log(`Не проверено: «${BINARY}» нет в PATH.`);
  process.exit(2);
}

/**
 * Поток одного хода. Подписка живёт, только пока ход идёт (подписавшийся к
 * кончившемуся ответу закрывается сразу), поэтому открывается ПОСЛЕ отправки —
 * так же, как это делает вкладка.
 */
function openStream(apiUrl, chatId) {
  const events = [];
  const controller = new AbortController();
  const ready = fetch(`${apiUrl}/api/provider-chat/chats/${chatId}/stream`, {
    signal: controller.signal,
  }).then(async (res) => {
    events.status = res.status;
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for await (const chunk of res.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let cut;
        while ((cut = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          const line = frame.split('\n').find((l) => l.startsWith('data: '));
          if (line) events.push({ at: Date.now(), ...JSON.parse(line.slice(6)) });
        }
      }
    } catch {
      // Снят нами — конец чтения.
    }
  });
  return { events, close: () => controller.abort(), ready };
}

/**
 * Улики CLI до того, как стенд унесёт свой временный дом: журнал OpenCode
 * (`~/.local/share/opencode/log`) — в `.agent/tmp/ftalk-logs/<метка>`.
 */
function keepCliLogs(stand, label) {
  const from = join(stand.home, '.local', 'share', CLI, 'log');
  if (!existsSync(from)) return;
  const to = join(process.cwd(), '.agent', 'tmp', 'ftalk-logs', `${label}-${Date.now()}`);
  cpSync(from, to, { recursive: true });
  console.log(`     журнал CLI сохранён: ${to}`);
}

const isEnd = (e) => e.type === 'done' || e.type === 'error' || e.type === 'stopped';

/**
 * Вопрос и конец его хода. Конец — событие в потоке; не пришло — переписка
 * (последняя реплика ассистента): так «поток молчал» отделено от «ответа не было».
 */
async function ask(stand, chatId, text) {
  const count = async () =>
    (await stand.api(`/provider-chat/chats/${chatId}`)).body?.messages?.length ?? 0;
  const sentCount = (await count()) + 1;
  const t0 = Date.now();
  const sent = await stand.api(`/provider-chat/chats/${chatId}/send`, {
    method: 'POST',
    body: { text },
  });
  const stream = openStream(stand.apiUrl, chatId);
  let stored;
  while (Date.now() - t0 < TURN_LIMIT_MS) {
    if (stream.events.some(isEnd)) break;
    const status = (await stand.api(`/provider-chat/chats/${chatId}/status`)).body;
    if (status?.isRunning === false) {
      const messages = (await stand.api(`/provider-chat/chats/${chatId}`)).body?.messages ?? [];
      if (messages.length > sentCount && messages.at(-1)?.role === 'assistant') {
        await wait(1000); // конец мог прийти в поток на полшага позже статуса
        break;
      }
    }
    await wait(250);
  }
  const ms = Date.now() - t0;
  stream.close();
  const messages = (await stand.api(`/provider-chat/chats/${chatId}`)).body?.messages ?? [];
  if (messages.length > sentCount - 1 && messages.at(-1)?.role === 'assistant')
    stored = messages.at(-1);
  const end = stream.events.find(isEnd);
  const deltas = stream.events.filter((e) => e.type === 'delta');
  return { sent, end, stored, deltas, ms, streamStatus: stream.events.status };
}

await runOnStand(
  {
    web: false,
    label: `ftalk-${CLI}`,
    settings: { provider: CLI },
    extraPath: [cliDir],
    seed: seedLocalModel,
  },
  async (stand, check) => {
    const before = snapshotRealProviderDirs();
    const mark = `ZX-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
    const number = String(4000 + Math.floor(Math.random() * 5000));

    // --- W: запись из панели ------------------------------------------------
    const put = await stand.api('/claude-md', {
      method: 'PUT',
      body: {
        content: `# Rules\n\nEnd every answer with the exact token ${mark} on its own line.\n`,
      },
    });
    if (put.status === 400)
      console.log(
        `  —  W  не применимо: у ${CLI} нет глобальных инструкций (${put.text.slice(0, 120)})`,
      );
    else {
      const info = await stand.api('/claude-md');
      const file = info.body?.path ?? info.body?.filePath;
      const inside = file && !relative(stand.home, file).startsWith('..') && isAbsolute(file);
      const onDisk = file && existsSync(file) ? readFileSync(file, 'utf8') : '';
      check(
        'W  запись панели легла файлом в конфиг CLI внутри временного дома, с меткой',
        put.status === 200 && inside && onDisk.includes(mark),
        `PUT ${put.status}; путь ${file}; на диске ${JSON.stringify(onDisk.slice(0, 120))}`,
      );
      console.log(`     файл: ${file}`);
    }

    // --- разговор -----------------------------------------------------------
    const project = mkdtempSync(join(tmpdir(), `ftalk-${CLI}-proj-`));
    writeFileSync(join(project, 'README.md'), '# probe\n', 'utf8');
    const created = await stand.api('/provider-chat/chats', {
      method: 'POST',
      body: { title: 'first talk', workdir: project },
    });
    if (!check('разговор создан', created.status === 200 && created.body?.id, created.text)) return;
    const id = created.body.id;

    const q1 = await ask(
      stand,
      id,
      `Remember the number ${number}. Confirm it, then count from 1 to 40 separated by spaces.`,
    );
    if (!q1.stored) keepCliLogs(stand, 'q1-no-answer');
    const a1 = q1.stored?.content ?? '';
    console.log(
      `     Q1 ${q1.ms} ms, поток HTTP ${q1.streamStatus}, delta ×${q1.deltas.length}, конец ${q1.end?.type}: ${JSON.stringify(a1.slice(0, 160))}`,
    );
    check(
      'A1 первый ответ получен и записан в переписку',
      q1.sent.status === 200 && q1.stored?.role === 'assistant' && !q1.stored.failed && a1,
      `send ${q1.sent.status}; реплика ${JSON.stringify(q1.stored)?.slice(0, 300)}`,
    );
    if (WHOLE_ANSWER[CLI]) {
      console.log(`  —  S1 не применимо: ${WHOLE_ANSWER[CLI]}`);
      check(
        'S1 ответ целиком пришёл в поток (done с текстом)',
        q1.end?.type === 'done' && Boolean(q1.end.message?.content),
        `конец ${JSON.stringify(q1.end)?.slice(0, 300)}`,
      );
    } else
      check(
        'S1 первый ответ шёл потоком (≥2 delta, затем done в потоке)',
        q1.end?.type === 'done' && q1.deltas.length >= 2,
        `send ${q1.sent.status}; конец ${JSON.stringify(q1.end)?.slice(0, 300)}; delta ×${q1.deltas.length}`,
      );

    const q2 = await ask(
      stand,
      id,
      'Which number did I ask you to remember? Answer with the number.',
    );
    const a2 = q2.stored?.content ?? '';
    console.log(
      `     Q2 ${q2.ms} ms, delta ×${q2.deltas.length}, конец ${q2.end?.type}: ${JSON.stringify(a2.slice(0, 160))}`,
    );
    check(
      'M  второй ответ помнит первый вопрос',
      q2.sent.status === 200 && q2.stored?.failed !== true && a2.includes(number),
      `ждали ${number}; ответ ${JSON.stringify(a2.slice(0, 200))}`,
    );
    const marked = [a1, a2].filter((a) => a.includes(mark)).length;
    console.log(`     I  метка инструкций в ответах: ${marked} из 2 (сведение: послушание модели)`);

    if (CLI === 'opencode') {
      check(
        'OS ответ пришёл через `opencode serve` (transport session)',
        q1.stored?.transport === 'session' && q2.stored?.transport === 'session',
        `transport ${q1.stored?.transport} / ${q2.stored?.transport}`,
      );

      // Модель, которой нет: её называет конфиг проекта нового разговора —
      // `opencode serve` один на панель, а конфиг читает на каталог.
      const broken = mkdtempSync(join(tmpdir(), `ftalk-${CLI}-bad-`));
      writeFileSync(
        join(broken, 'opencode.json'),
        JSON.stringify({ model: 'opencode/no-such-model-agentdeck' }, null, 2),
      );
      const second = await stand.api('/provider-chat/chats', {
        method: 'POST',
        body: { title: 'bad model', workdir: broken },
      });
      const badId = second.body?.id;
      const q3 = await ask(stand, badId, 'Say hello.');
      const last = q3.stored;
      const status = (await stand.api(`/provider-chat/chats/${badId}/status`)).body;
      const shown = q3.end?.error ?? q3.end?.message?.content ?? '';
      console.log(
        `     OF ${q3.ms} ms, конец ${q3.end?.type}: ${JSON.stringify(shown.slice(0, 200))}; последняя реплика failed=${last?.failed}`,
      );
      check(
        'OF неверная модель — падение пришло в поток текстом, ход кончился, отправка не 5xx',
        q3.sent.status === 200 &&
          q3.end &&
          shown.trim().length > 0 &&
          (q3.end.type === 'error' || q3.end.message?.failed === true) &&
          status?.isRunning === false,
        `send ${q3.sent.status}; конец ${JSON.stringify(q3.end)?.slice(0, 300)}; running ${status?.isRunning}`,
      );
      check(
        'OF падение записано в переписку (реплика failed с текстом)',
        last?.role === 'assistant' && last?.failed === true && last.content.trim().length > 0,
        JSON.stringify(last)?.slice(0, 300),
      );
    }

    const drift = diffRealProviderDirs(before, snapshotRealProviderDirs());
    check(
      'настоящие каталоги CLI человека не тронуты',
      drift.length === 0,
      drift.map((entry) => JSON.stringify(entry)).join('\n    '),
    );
  },
);
