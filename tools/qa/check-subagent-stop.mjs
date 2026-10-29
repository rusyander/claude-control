/**
 * «Остановить» у субагента в дереве агентов — на настоящем CLI.
 *
 * Путь целиком: реестр прогонов панели (`ChatRunRegistry.stopSubagent`) →
 * живая сессия (`LiveSession.stopTask`) → `control_request` `stop_task` в stdin
 * настоящего `claude` → его `control_response` → субагент снят. Модель —
 * заглушка на своём порту (`ANTHROPIC_BASE_URL`), каталог конфигурации —
 * одноразовый: ни `~/.claude`, ни стенд человека не трогаются.
 *
 * Сценарий заглушки:
 * - главный агент первым ходом запускает фонового субагента (`Agent`,
 *   `run_in_background`) и кончает ход;
 * - субагенту заглушка не отвечает — держит его запрос открытым, пока его не
 *   оборвут: так субагент гарантированно «идёт» в момент остановки.
 *
 * Что проверяется:
 * 1. Между ходами у разговора есть кому послать `stop_task` (`canStopSubagents`).
 * 2. `stopSubagent` с id субагента — CLI подтвердил (`ok`).
 * 3. После этого CLI оборвал запрос субагента к модели — он правда остановлен.
 * 4. Чужой id — CLI тоже отвечает «готово» (замер 2.1.310), но настоящий
 *    субагент при этом работает дальше: подтверждение CLI ≠ остановка.
 * 5. Разговор без живого процесса — `absent`, без записи куда-либо.
 *
 * Запуск: `node tools/qa/check-subagent-stop.mjs`. Нужен установленный `claude`
 * (`CLAUDE_CLI` — свой путь).
 */
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { NotChecked, reporter } from './throwaway-stand.mjs';
import { startStubModel } from '../../packages/stub-model/src/index.mjs';

const MAIN_MARK = 'STOPPROBE-MAIN';
const SUB_MARK = 'STOPPROBE-SUB';
/** Сколько держится запрос субагента: дольше любого прогона — оборвать его должен CLI. */
const SUB_HOLD_MS = 10 * 60_000;

/** Первая реплика человека в запросе — по ней видно, чей это запрос. */
function firstUserText(body) {
  const first = (body.messages ?? []).find((message) => message.role === 'user');
  const content = first?.content;
  if (typeof content === 'string') return content;
  return (content ?? []).map((block) => block.text ?? '').join('\n');
}

const hasToolResult = (body) =>
  (body.messages ?? []).some(
    (message) =>
      Array.isArray(message.content) &&
      message.content.some((block) => block.type === 'tool_result'),
  );

async function startStub() {
  const state = { agentTool: '', mainTurns: 0 };
  const subs = [];
  const stub = await startStubModel({
    // Вне `/messages` (служебные пути CLI) — пустой JSON, как было у своего стаба.
    route: ({ path }) => (path.includes('/messages') ? undefined : { body: {} }),
    script: ({ request }) => {
      const { body } = request;
      const said = firstUserText(body);
      if (said.includes(SUB_MARK)) {
        // Субагент: поток начат и держится, пока CLI его не оборвёт (`aborted` в записи).
        subs.push(request);
        return { text: 'ok', stallMs: SUB_HOLD_MS };
      }
      const tool = request.tools.find((name) => name === 'Agent' || name === 'Task');
      if (!said.includes(MAIN_MARK) || hasToolResult(body) || !tool) return 'ok';
      state.agentTool = tool;
      state.mainTurns += 1;
      const args = {
        description: 'stop probe',
        prompt: `${SUB_MARK} wait for the model`,
        subagent_type: 'general-purpose',
        run_in_background: true,
      };
      return { tool: { name: tool, args, id: `toolu_stop_${Date.now()}` } };
    },
  });
  Object.defineProperties(state, {
    requests: { enumerable: true, get: () => stub.requests.length },
    subHeld: { enumerable: true, get: () => subs.length },
    subAborted: { enumerable: true, get: () => subs.filter((sub) => sub.aborted).length },
  });
  return { url: stub.baseUrl, state, close: () => stub.close() };
}

/** id субагента — из его meta в одноразовом каталоге конфигурации. */
function findAgentId(configDir) {
  const projects = join(configDir, 'projects');
  if (!existsSync(projects)) return undefined;
  const walk = (dir, depth) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const match = /^agent-(.+)\.meta\.json$/.exec(entry.name);
      if (match) return match[1];
      if (entry.isDirectory() && depth < 4) {
        const found = walk(path, depth + 1);
        if (found) return found;
      }
    }
    return undefined;
  };
  return walk(projects, 0);
}

const { check, finish } = reporter();
const work = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-stop-work-')));
const home = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-stop-home-')));
const stub = await startStub();
let runs;
const key = 'stop-probe';
try {
  const { ChatRunRegistry } =
    await import('../../apps/server/src/domains/chat/ChatRunRegistry/ChatRunRegistry.ts');
  runs = new ChatRunRegistry();
  runs.setPlatformRouting(() => ({
    env: {
      ANTHROPIC_BASE_URL: stub.url,
      ANTHROPIC_AUTH_TOKEN: 'stop-stub-token',
      ANTHROPIC_API_KEY: 'stop-stub-token',
      ANTHROPIC_MODEL: 'stub-stop',
      DISABLE_AUTOUPDATER: '1',
      DISABLE_TELEMETRY: '1',
      DISABLE_ERROR_REPORTING: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    },
  }));
  console.log(`Заглушка модели ${stub.url}\n`);
  runs.start(
    key,
    {
      prompt: `${MAIN_MARK} запусти субагента`,
      cwd: work,
      configDir: home,
      ...(process.env.CLAUDE_CLI ? { command: process.env.CLAUDE_CLI } : {}),
      permissionMode: 'default',
      permissionPrompt: { runId: key, baseUrl: 'http://127.0.0.1:1' },
    },
    { origin: 'chat' },
  );
  for (let i = 0; i < 240 && stub.state.subHeld === 0; i += 1) await wait(250);
  if (stub.state.requests === 0)
    throw new NotChecked('CLI не обратился к заглушке модели — нет `claude`?');
  check(
    'главный агент запустил субагента вызовом Agent/Task',
    stub.state.agentTool !== '',
    JSON.stringify(stub.state),
  );
  check('субагент идёт: его запрос к модели держится открытым', stub.state.subHeld > 0);
  for (let i = 0; i < 120 && runs.isRunning(key); i += 1) await wait(250);
  const agentId = findAgentId(home);
  check('у субагента есть id (meta в каталоге сессии)', Boolean(agentId), String(agentId));

  check('между ходами разговору есть кому послать stop_task', runs.canStopSubagents(key) === true);
  // Замер 25.10 (claude 2.1.310): на чужой id CLI тоже отвечает успехом. Значит,
  // подтверждение — только «запрос принят», а снят ли субагент, говорит его след
  // в транскрипте; панель так и пишет («остановка запрошена»).
  const refused = await runs.stopSubagent(key, 'no-such-agent-id');
  await wait(2000);
  check(
    'чужой id — субагент работает дальше (подтверждение CLI ≠ остановка)',
    refused !== 'absent' && stub.state.subAborted === 0,
    `${JSON.stringify(refused)} ${JSON.stringify(stub.state)}`,
  );
  const aborted = stub.state.subAborted;
  const reply = agentId ? await runs.stopSubagent(key, agentId) : 'no-agent';
  check(
    'stop_task с id субагента — CLI подтвердил',
    reply !== 'absent' && reply?.outcome === 'ok',
    JSON.stringify(reply),
  );
  for (let i = 0; i < 40 && stub.state.subAborted === aborted; i += 1) await wait(250);
  check(
    'после остановки CLI оборвал запрос субагента к модели',
    stub.state.subAborted > aborted,
    JSON.stringify(stub.state),
  );
  // Дерево панели по транскрипту: остановленный субагент больше не «идёт».
  const { readChatProgressWithTree } =
    await import('../../apps/server/src/domains/chat/subagent-tree/subagent-tree.ts');
  const sessionId = runs.active?.().find((run) => run.chatId === key)?.sessionId;
  let node;
  for (let i = 0; i < 40; i += 1) {
    const chats = readdirSync(join(home, 'projects'), { withFileTypes: true }).flatMap((dir) =>
      dir.isDirectory()
        ? readdirSync(join(home, 'projects', dir.name))
            .filter((name) => name.endsWith('.jsonl'))
            .map((name) => name.replace(/\.jsonl$/, ''))
        : [],
    );
    const id = sessionId ?? chats[0];
    node = id
      ? readChatProgressWithTree(join(home, 'projects'), id).agents.find(
          (agent) => agent.agentId === agentId,
        )
      : undefined;
    if (node && node.status !== 'running') break;
    await wait(250);
  }
  check(
    'дерево панели: остановленный субагент не числится идущим',
    Boolean(node) && node.status !== 'running',
    JSON.stringify(node ?? null).slice(0, 400),
  );
  if (process.env.STOP_DUMP) console.log(JSON.stringify(node, null, 2));
  // CLI пишет итог остановленного `<status>killed</status>` (замер 25.10) — это
  // решение человека, не падение: узел называет его «остановлен».
  check(
    'дерево панели: остановленный помечен «остановлен», а не «упал»',
    node?.stopped === true,
    JSON.stringify(node ?? null).slice(0, 300),
  );
  const absent = await runs.stopSubagent('no-such-chat', agentId ?? 'x');
  check('разговор без живого процесса — absent', absent === 'absent', JSON.stringify(absent));
} catch (error) {
  if (error instanceof NotChecked) {
    console.log(`Не проверено: ${error.message}`);
    process.exitCode = 2;
  } else {
    check('сценарий дошёл до конца', false, error?.stack ?? String(error));
  }
} finally {
  runs?.closeLive?.(key);
  runs?.stopAll?.();
  await wait(1500);
  stub.close();
  for (const dir of [work, home]) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* процесс ещё держит файл — временная папка уйдёт с чисткой ОС */
    }
  }
}
if (process.exitCode !== 2) finish();
