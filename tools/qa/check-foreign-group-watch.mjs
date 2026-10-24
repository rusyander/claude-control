/**
 * Сторож, счёт и «остывшая сессия» у группы Qwen Code (план экономии чужих CLI,
 * пакет W) — настоящим `qwen` через настоящую панель.
 *
 * Сценарий — путь человека через API одноразовой панели: разговор Qwen Code в
 * репозитории git, разделение на две группы (вторая — фон), первый ход группы
 * (вызов инструмента и ответ), пауза дольше срока остывания, реплика человека в
 * разговор группы. Что видно:
 *
 *   1. переписка первого хода — одна сессия в каталоге копии группы;
 *   2. карточка группы (конвейер закрыл её после хода) — числа из переписки:
 *      одна сессия, холодный старт 12000, вызовов ≥ 2;
 *   3. сторож увидел первый ход по переписке: ровно один сигнал — R19 «тяжёлый
 *      первый запрос» (порог 10k на стенде, первый вызов заглушки — 12k);
 *   4. следующий ход после паузы (срок остывания сжат переменной панели
 *      `AGENTDECK_FOREIGN_COLD_AFTER_MS`, окно 60k выше базы 12k + 25k) идёт НОВОЙ
 *      сессией CLI: первый запрос к модели несёт вводную панели («Facts the panel
 *      collected»), прежнего вызова инструмента в нём нет, в ленте — заметка, у
 *      копии вторая сессия, прежняя — в `chats/archive/` (в `chats/` её нет), R2
 *      у новой сессии нет, пересчитанная карточка — две сессии (обязательно).
 *
 * Подменена только модель (`OPENAI_BASE_URL` на заглушку в этом файле): она
 * отвечает вызовом `glob` на первый запрос хода и текстом после результата,
 * а размер окна (`usage.prompt_tokens`) задаёт сама. Дом Qwen Code — временный
 * (`foreign-cli.mjs`). Нет `qwen` ни в `STEER_CLI_DIR`, ни в PATH — «не проверено»
 * (код 2), не провал.
 *
 * Запуск: `node tools/qa/check-foreign-group-watch.mjs`.
 */
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { NotChecked, reporter, startStand, wait } from './throwaway-stand.mjs';
import { FOREIGN_CLIS, applyCliEnv, cliProcesses, findCli, reap } from './foreign-cli.mjs';

const TASK = 'MARKER-W-TASK: list the markdown files and stop';
const BRIEF = 'Facts the panel collected';
/** Имя копии группы (`<проект>-worktrees/feature-list`) — по ветке. */
const GROUP_DIR = 'feature-list';
const FIRST = 12_000;
const BIG = 60_000;

/**
 * Заглушка OpenAI chat/completions (потоком и без). Запрос хода группы без
 * результата инструмента — вызов `glob` и окно 12k; с результатом — ответ
 * текстом и окно 60k (кэш почти весь: холодной перезаписи R2 здесь нет).
 * Вводная новой сессии — ответ текстом, окно 12k. Остальное (разбор, служебные
 * запросы CLI) — короткий ответ.
 */
function startModel() {
  const requests = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      let body = {};
      try {
        body = JSON.parse(raw || '{}');
      } catch {
        // не JSON — пустой запрос
      }
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const text = (content) =>
        Array.isArray(content)
          ? content.map((part) => part?.text ?? '').join('\n')
          : String(content ?? '');
      const users = messages.filter((m) => m.role === 'user').map((m) => text(m.content));
      const all = messages.map((m) => text(m.content)).join('\n');
      const system = messages
        .filter((m) => m.role === 'system')
        .map((m) => text(m.content))
        .join('\n');
      const hasTool = messages.some((m) => m.role === 'tool');
      // Группа — по её копии в системной части (рабочий каталог CLI): задание
      // группы видят и разбор, и соседняя группа.
      const group = system.includes(GROUP_DIR) && all.includes(TASK);
      const brief = users.some((u) => u.includes(BRIEF));
      const nextSpeaker = all.includes('next_speaker');
      requests.push({ n: requests.length + 1, group, brief, hasTool, nextSpeaker, users });
      let prompt = 500;
      let cached = 0;
      let reply = { content: 'ok' };
      if (group) {
        prompt = hasTool ? BIG : FIRST;
        cached = hasTool ? BIG - 1000 : 0;
        if (nextSpeaker) reply = { content: '{"reasoning":"done","next_speaker":"user"}' };
        else if (!hasTool && !brief)
          reply = {
            tool_calls: [
              {
                index: 0,
                id: `call_${requests.length}`,
                type: 'function',
                function: { name: 'glob', arguments: JSON.stringify({ pattern: '*.md' }) },
              },
            ],
          };
        else reply = { content: 'Group work done.' };
      }
      const usage = {
        prompt_tokens: prompt,
        completion_tokens: 5,
        total_tokens: prompt + 5,
        prompt_tokens_details: { cached_tokens: cached },
      };
      const finish = reply.tool_calls ? 'tool_calls' : 'stop';
      const head = { id: `c${requests.length}`, created: 1, model: 'stub-model' };
      if (!body.stream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            ...head,
            object: 'chat.completion',
            choices: [
              { index: 0, message: { role: 'assistant', ...reply }, finish_reason: finish },
            ],
            usage,
          }),
        );
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
      const chunk = { ...head, object: 'chat.completion.chunk' };
      send({ ...chunk, choices: [{ index: 0, delta: { role: 'assistant', ...reply } }] });
      send({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: finish }] });
      send({ ...chunk, choices: [], usage });
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  return new Promise((done) =>
    server.listen(0, '127.0.0.1', () =>
      done({
        port: server.address().port,
        requests,
        close: () => new Promise((closed) => server.close(() => closed())),
      }),
    ),
  );
}

async function until(probe, seconds, step = 300) {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) return undefined;
    await wait(step);
  }
}

/**
 * Файлы сессий Qwen Code в домах (`projects/<копия>/chats/<сессия>.jsonl`), без
 * спутника `<сессия>.ledger.jsonl` — он не сессия.
 */
function qwenChats(homes) {
  return homes.flatMap((home) => {
    const projects = join(home, 'projects');
    if (!existsSync(projects)) return [];
    // Прежнюю сессию Qwen Code уносит в `chats/archive/`, когда начата новая.
    return readdirSync(projects).flatMap((slug) =>
      [join(projects, slug, 'chats'), join(projects, slug, 'chats', 'archive')].flatMap((chats) =>
        existsSync(chats)
          ? readdirSync(chats)
              .filter((name) => name.endsWith('.jsonl') && !name.endsWith('.ledger.jsonl'))
              .map((name) => join(chats, name))
          : [],
      ),
    );
  });
}

const dir = findCli('qwen');
if (!dir) {
  console.log('Не проверено: «qwen» нет ни в STEER_CLI_DIR, ни в PATH.');
  process.exit(2);
}
const { check, finish } = reporter();
const model = await startModel();
const root = mkdtempSync(join(tmpdir(), 'cc-group-watch-qwen-'));
const restoreEnv = applyCliEnv(FOREIGN_CLIS.qwen.env(root, `http://127.0.0.1:${model.port}`), dir);
const qwenHome = process.env.QWEN_HOME;
const before = cliProcesses(dir, 'qwen');
let stand;
try {
  stand = await startStand({
    web: false,
    label: 'group-watch-qwen',
    settings: { provider: 'qwen' },
    env: { AGENTDECK_FOREIGN_COLD_AFTER_MS: '2000' },
  });
  console.log(`Одноразовая панель ${stand.apiUrl}, qwen из ${dir}\n`);
  // Рычаги — через страницу настроек (PATCH сливает с умолчаниями): слой
  // `state.json` стенда сливается на один уровень, и половинный блок потерял бы поля.
  const patched = await stand.api('/settings', {
    method: 'PATCH',
    body: {
      groupEconomy: { freshOnColdResume: true },
      groupWatch: { firstContextTokens: 10_000 },
    },
  });
  check(
    'рычаги стенда: новая сессия после паузы, порог R19 10k',
    patched.status === 200,
    patched.text.slice(0, 300),
  );

  // Проект — репозиторий git: у группы своя копия, и её сессии CLI — только её.
  const project = join(stand.root, 'project');
  mkdirSync(project);
  const git = (...args) => execFileSync('git', args, { cwd: project, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'qa@example.com');
  git('config', 'user.name', 'qa');
  writeFileSync(join(project, 'README.md'), '# qa\n');
  git('add', '.');
  git('commit', '-q', '-m', 'base');

  const parent = await stand.api('/provider-chat/chats', {
    method: 'POST',
    body: { title: 'родитель', workdir: project },
  });
  if (!check('разговор Qwen Code заведён', parent.status === 200, parent.text.slice(0, 300)))
    throw new Error('нет разговора');
  const parentKey = `qwen:${parent.body.id}`;
  const split = await stand.api('/chat/split', {
    method: 'POST',
    body: {
      projectPath: project,
      startRuns: true,
      parentChatId: parentKey,
      // Разделение — минимум две группы; вторая — фон: модель отвечает ей «ok».
      proposal: {
        groups: [
          { title: 'Список', branch: 'feature/list', tasks: [TASK] },
          { title: 'Фон', branch: 'feature/idle', tasks: ['reply ok'] },
        ],
      },
    },
  });
  if (!check('разделение принято', split.status === 200, split.text.slice(0, 400)))
    throw new Error('нет разделения');

  const tree = async () =>
    (await stand.api(`/chat/${encodeURIComponent(parentKey)}/tree`)).body ?? {};
  const groupOf = async () => (await tree())?.split?.groups?.[0] ?? (await tree())?.groups?.[0];
  // Разговор группы — разговор Qwen Code в её копии (ключ в записи плана бывает
  // временным, `new-…`, пока звено не названо).
  const norm = (path) =>
    String(path ?? '')
      .replace(/[\\/]+/g, '/')
      .toLowerCase();
  const childId = await until(async () => {
    const path = (await groupOf())?.path;
    if (!path) return undefined;
    const list = (await stand.api('/provider-chat/chats')).body ?? [];
    return list.find((chat) => norm(chat.workdir) === norm(path))?.id;
  }, 90);
  if (
    !check('группа получила разговор', Boolean(childId), JSON.stringify(await tree()).slice(0, 800))
  )
    throw new Error('нет звена');
  const id = String(childId);
  const status = async () => (await stand.api(`/provider-chat/chats/${id}/status`)).body;
  const messages = async () => (await stand.api(`/provider-chat/chats/${id}`)).body?.messages ?? [];

  // 1. Первый ход группы: вызов инструмента, его результат, ответ.
  const firstDone = await until(
    () => model.requests.some((r) => r.group && r.hasTool && !r.nextSpeaker),
    180,
  );
  await until(async () => (await status())?.isRunning === false, 120);
  check(
    'первый ход группы дошёл до модели: вызов glob и ответ после результата',
    Boolean(firstDone),
    JSON.stringify(model.requests.map(({ users: _users, ...rest }) => rest)),
  );
  // Дома, где панель ищет переписку: Qwen Code человека (здесь — временный) и набора панели.
  const homes = [qwenHome, join(stand.cfg, 'agentdeck', 'kit', 'qwen-home')];
  const groupFiles = () =>
    qwenChats(homes).filter((file) => file.toLowerCase().includes(GROUP_DIR));
  const files = groupFiles();
  check(
    'переписка первого хода группы — одна сессия в каталоге её копии',
    files.length === 1,
    JSON.stringify(qwenChats(homes)),
  );

  // 3. Карточка группы — числа из переписки CLI: конвейер закрыл группу после хода.
  const closed = await until(async () => (await groupOf())?.tokenLedger, 60);
  check(
    'карточка группы: одна сессия, холодный старт 12000, вызовов ≥ 2',
    closed?.usage?.sessions === 1 &&
      closed.usage.coldStart === FIRST &&
      closed.usage.turns >= 2 &&
      closed.usage.instructionPct === 0,
    JSON.stringify(closed ?? (await groupOf())),
  );

  // 2. Сторож: ровно один сигнал, R19 с числом первого запроса.
  const signals = await until(async () => {
    const list = (await groupOf())?.watchSignals ?? [];
    return list.length > 0 ? list : undefined;
  }, 30);
  const active = (signals ?? []).filter((signal) => !signal.clearedAt);
  check(
    'сторож: один сигнал — R19, первый запрос 12k',
    active.length === 1 && active[0].rule === 'R19' && active[0].numbers?.firstK === 12,
    `${JSON.stringify(signals ?? null)} группа ${JSON.stringify(await groupOf()).slice(0, 1500)}`,
  );

  // 4. Пауза дольше срока остывания, затем следующий ход группы.
  await wait(3000);
  const from = model.requests.length;
  const sent = await stand.api(`/provider-chat/chats/${id}/send`, {
    method: 'POST',
    body: { text: 'Continue the group work.' },
  });
  check('следующий ход группы принят', sent.status === 200, sent.text.slice(0, 300));
  const fresh = await until(() => model.requests.slice(from).find((r) => r.group && r.brief), 120);
  await until(async () => (await status())?.isRunning === false, 120);
  check(
    'после паузы — новая сессия: первый запрос несёт вводную панели, прежнего инструмента нет',
    Boolean(fresh) && !fresh.hasTool,
    JSON.stringify(model.requests.slice(from).map(({ users: _users, ...rest }) => rest)),
  );
  const notices = (await messages()).filter((m) => m.role === 'notice');
  check(
    'в ленте группы — заметка о новом разговоре',
    notices.length > 0,
    JSON.stringify(
      (await messages()).map((m) => ({ role: m.role, c: String(m.content).slice(0, 80) })),
    ),
  );
  check(
    'новая сессия — своим файлом переписки в каталоге копии',
    groupFiles().length === 2,
    JSON.stringify(qwenChats(homes)),
  );
  // Прежнюю сессию панель не стирает, а убирает в архив Qwen: файл переехал в
  // `chats/archive/` (его расход остаётся в аналитике), в `chats/` его больше нет.
  const firstName = files[0] ? basename(files[0]) : '';
  const firstNow = groupFiles().filter((file) => basename(file) === firstName);
  check(
    'прежняя сессия — в chats/archive/, в chats/ её нет',
    firstName !== '' &&
      firstNow.length === 1 &&
      basename(dirname(firstNow[0])) === 'archive' &&
      basename(dirname(dirname(firstNow[0]))) === 'chats',
    JSON.stringify({ firstName, files: qwenChats(homes) }),
  );
  // Новая сессия после паузы — не продолжение остывшего кэша: R2 у неё нет.
  const after = ((await groupOf())?.watchSignals ?? []).filter((signal) => !signal.clearedAt);
  check(
    'после нового разговора R2 нет: новая сессия кэш не продолжает',
    !after.some((signal) => signal.rule === 'R2'),
    JSON.stringify(after),
  );
  // Счёт пересчитан после хода: прежняя сессия и новая — обе расход группы.
  const recount = await until(async () => {
    const ledger = (await groupOf())?.tokenLedger;
    return ledger && ledger.at !== closed?.at ? ledger : undefined;
  }, 30);
  check(
    'карточка после нового разговора пересчитана: две сессии, холодный старт 12000',
    recount?.usage?.sessions === 2 && recount.usage.coldStart === FIRST,
    JSON.stringify(recount ?? (await groupOf())?.tokenLedger ?? null),
  );
} catch (error) {
  if (error instanceof NotChecked) {
    console.log(`Не проверено: ${error.message}`);
    process.exitCode = 2;
  } else {
    check('сценарий дошёл до конца', false, error?.stack ?? String(error));
    if (stand) console.log(`\nЖурнал панели (хвост):\n${stand.log().slice(-3000)}`);
  }
} finally {
  if (stand) await stand.stop();
  reap(before, dir, 'qwen', stand ? [root, stand.root] : [root]);
  await wait(500);
  if (stand) rmSync(stand.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  await model.close();
  restoreEnv();
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}
if (process.exitCode !== 2) finish();
