/**
 * Живое доказательство связки 5.2 после переезда чата на ядро (этап 11): хук списка задач
 * (`tools/board-fields-hook.mjs`, PreToolUse на поиск, доску и спринт трекера) едет в сеанс
 * обычного чата Claude. Тумблер инициативы разделения снят (этап 10, G14) — хук едет всегда.
 *
 * `check-board-fields.mjs` доказывает, что делает с хуком настоящий CLI; там настройки собраны
 * самой проверкой. Здесь — обратное: CLI фальшивый, а всё до него настоящее — одноразовая панель
 * (`apps/server/src/index.ts`), маршрут `/api/chat/send`, профиль чата из
 * `bootstrap/runtime/runtime.ts`, реестр прогонов, перенос слоя `core-run/session-carry.ts`,
 * НАСТОЯЩЕЕ ядро со своим временным домом (журнал задачи, дорога сеанса, переходник Claude) и
 * его хост сеансов. Фальшивый `claude` на первом ходе списывает свой argv, текст хода и
 * содержимое файла `--settings`, который собрало ядро.
 *
 * Строки: ход дошёл до процесса сеанса ядра; журнал задачи несёт хук полем `session.hooks`;
 * в `--settings` сеанса хук на поиск, доску и спринт с командой панели по абсолютному пути; хук
 * ядра (судья прав) остаётся последним в PreToolUse и хуки не выключены; ответ дошёл до чата.
 *
 * Запуск: `node tools/qa/check-board-fields-wiring.mjs`. Стенд человека, его ядро и `~/.claude`
 * не трогаются; установленный `claude` не нужен.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { runOnStand, wait } from './throwaway-stand.mjs';

const MATCHER = 'mcp__.*__jira_(search|get_board_issues|get_sprint_issues)';
const PROMPT = 'разбери доску BF-MARK';

/**
 * Фальшивый `claude`: проба версии — строкой; сеанс ядра — на каждый ход строка в `calls.jsonl`
 * (argv, текст хода, файл `--settings`) и ответ «ок» потоком stream-json. Живёт, пока открыт stdin.
 */
const FAKE_CLI = String.raw`
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const argv = process.argv.slice(2);
if (!argv.includes('--input-format')) {
  process.stdout.write('2.1.999 (Claude Code)\n');
  process.exit(0);
}
const self = fileURLToPath(import.meta.url);
const LOG = self.replace(/[^\\/]+$/, 'calls.jsonl');
const ALIVE = self.replace(/[^\\/]+$/, '.stand-alive');
setInterval(() => {
  if (!existsSync(ALIVE)) process.exit(0);
}, 250).unref();
const unq = (value) => (value === undefined ? undefined : value.replace(/^"|"$/g, ''));
const at = argv.indexOf('--settings');
const file = at >= 0 ? unq(argv[at + 1]) : '';
const session = 'bf-' + process.pid;
const out = (event) => process.stdout.write(JSON.stringify(event) + '\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.type !== 'user') return;
  // Рамка хода, как у CLI с --replay-user-messages: по started ядро признаёт ход своим.
  const command = typeof message.uuid === 'string' ? message.uuid : undefined;
  const lifecycle = (state) =>
    command && out({ type: 'command_lifecycle', command_uuid: command, state, uuid: command + '-' + state, session_id: session });
  lifecycle('queued');
  lifecycle('started');
  const settings = file && existsSync(file) ? readFileSync(file, 'utf8') : '';
  appendFileSync(LOG, JSON.stringify({ argv, settings, said: JSON.stringify(message.message ?? '') }) + '\n');
  out({ type: 'system', subtype: 'init', session_id: session, model: 'fake', tools: [], cwd: process.cwd() });
  out({ type: 'stream_event', session_id: session,
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ок' } } });
  out({ type: 'assistant', session_id: session, message: { id: 'msg_bf', type: 'message', role: 'assistant',
    model: 'fake', content: [{ type: 'text', text: 'ок' }], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } });
  out({ type: 'result', subtype: 'success', is_error: false, result: 'ок', session_id: session,
    duration_ms: 1, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } });
  lifecycle('completed');
}).on('close', () => process.exit(0));
`;

await runOnStand(
  { label: 'board-fields', web: false, fakeCli: { claude: FAKE_CLI }, core: true },
  async (stand, check) => {
    const log = join(stand.bin, 'calls.jsonl');
    const calls = () =>
      existsSync(log)
        ? readFileSync(log, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line))
        : [];
    const journals = () => {
      const dir = join(stand.coreHome, 'tasks');
      if (!existsSync(dir)) return [];
      return readdirSync(dir).flatMap((taskId) =>
        readdirSync(join(dir, taskId))
          .filter((f) => f.endsWith('.jsonl'))
          .map((f) =>
            readFileSync(join(dir, taskId, f), 'utf8')
              .split('\n')
              .filter(Boolean)
              .map((l) => JSON.parse(l)),
          ),
      );
    };

    const sent = await stand.api('/chat/send', {
      method: 'POST',
      body: { chatId: randomUUID(), prompt: PROMPT, projectPath: stand.root },
    });
    const turn = () => calls().find((c) => c.said.includes('BF-MARK'));
    for (let t = 0; t < 60_000 && !turn(); t += 250) await wait(250);
    const call = turn();
    const events = String(sent.text)
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data: '))
      .map((line) => {
        try {
          return JSON.parse(line.slice(6));
        } catch {
          return {};
        }
      });
    const error = events.find((e) => e.kind === 'error');
    check(
      'обычный чат через ядро: ход дошёл до процесса сеанса ядра',
      Boolean(call),
      `статус ${sent.status}; ${JSON.stringify(error ?? null)}; ${String(sent.text).slice(0, 400)}`,
    );

    const created = journals()
      .flat()
      .find((l) => l.kind === 'task.created');
    const carried = created?.data?.session?.hooks?.PreToolUse ?? [];
    check(
      'журнал задачи ядра: хук списка задач полем session.hooks',
      carried.some((g) => g.matcher === MATCHER),
      JSON.stringify(created?.data?.session ?? null).slice(0, 600),
    );

    const settings = call?.settings ? JSON.parse(call.settings) : undefined;
    const pre = settings?.hooks?.PreToolUse ?? [];
    const hook = pre.find((entry) => entry.matcher === MATCHER);
    check(
      'в --settings сеанса хук PreToolUse на поиск, доску и спринт',
      Boolean(hook),
      call?.settings || '(файла --settings нет)',
    );
    check(
      'команда хука — board-fields-hook.mjs панели, по абсолютному пути',
      /^node ".*[\\/]tools[\\/]board-fields-hook\.mjs"$/.test(hook?.hooks?.[0]?.command ?? ''),
      hook?.hooks?.[0]?.command,
    );
    const last = pre.at(-1);
    check(
      'хук ядра остаётся последним в PreToolUse, хуки не выключены',
      pre.length >= 2 &&
        last?.matcher === '*' &&
        last !== hook &&
        settings?.disableAllHooks === false,
      JSON.stringify({ pre, disableAllHooks: settings?.disableAllHooks }).slice(0, 600),
    );
    check(
      'ответ сеанса дошёл до чата без ошибки',
      !error && events.some((e) => e.kind === 'text' && String(e.text).includes('ок')),
      JSON.stringify(error ?? events.slice(-3)).slice(0, 400),
    );
  },
);
