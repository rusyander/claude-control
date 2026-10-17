/**
 * Живое доказательство связки 5.2: хук списка задач едет в прогон обычного чата
 * настоящей панели, пока включена инициатива разделения, и не едет без неё.
 *
 * `check-board-fields.mjs` доказывает, что делает с хуком настоящий CLI; там
 * настройки собраны самой проверкой. Здесь — обратное: CLI фальшивый, а всё
 * до него настоящее — одноразовая панель (`apps/server/src/index.ts`), маршрут
 * `/api/chat/send`, резолвер профиля из `bootstrap/runtime/runtime.ts`, реестр
 * и раннер. Фальшивый `claude` при старте списывает свой argv и содержимое
 * файла `--settings` (панель стирает его, как только процесс вышел).
 *
 * Случаи: инициатива включена (по умолчанию) — в `--settings` хук PreToolUse на
 * поиск, доску и спринт; выключена — хука нет.
 *
 * Запуск: `node tools/qa/check-board-fields-wiring.mjs`. Стенд человека и его
 * `~/.claude` не трогаются; установленный `claude` не нужен.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runOnStand, wait } from './throwaway-stand.mjs';

const MATCHER = 'mcp__.*__jira_(search|get_board_issues|get_sprint_issues)';

/** Фальшивый `claude`: argv и файл `--settings` — строкой в `calls.jsonl`, ответ — «ок». */
const FAKE_CLI = String.raw`
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const self = fileURLToPath(import.meta.url);
const LOG = self.replace(/[^\\/]+$/, 'calls.jsonl');
const ALIVE = self.replace(/[^\\/]+$/, '.stand-alive');
setInterval(() => {
  if (!existsSync(ALIVE)) process.exit(0);
}, 250).unref();
if (argv[0] === '--version' || argv[0] === '-v') {
  process.stdout.write('2.1.0 (Claude Code)\n');
  process.exit(0);
}
const at = argv.indexOf('--settings');
const file = at >= 0 ? argv[at + 1] : '';
const settings = file && existsSync(file) ? readFileSync(file, 'utf8') : '';
appendFileSync(LOG, JSON.stringify({ argv, settings }) + '\n');
const out = (event) => process.stdout.write(JSON.stringify(event) + '\n');
for await (const chunk of process.stdin) {
  if (!chunk.toString('utf8').includes('"user"')) continue;
  out({ type: 'system', subtype: 'init', session_id: 'bf-session' });
  out({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 'bf-session' });
  process.exit(0);
}
`;

await runOnStand(
  { label: 'board-fields', web: false, fakeCli: { claude: FAKE_CLI } },
  async (stand, check) => {
    const log = join(stand.bin, 'calls.jsonl');
    const calls = () =>
      existsSync(log)
        ? readFileSync(log, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line))
        : [];

    /** Новый чат одной репликой; ответ — что увидел фальшивый CLI. */
    const send = async (chatId) => {
      const before = calls().length;
      const sent = await stand.api('/chat/send', {
        method: 'POST',
        body: { chatId, prompt: 'разбери доску', projectPath: stand.root },
      });
      for (let t = 0; t < 30_000 && calls().length === before; t += 250) await wait(250);
      return { status: sent.status, call: calls()[before] };
    };
    const hookOf = (call) => {
      if (!call?.settings) return undefined;
      const pre = JSON.parse(call.settings).hooks?.PreToolUse ?? [];
      return pre.find((entry) => entry.matcher === MATCHER);
    };

    const on = await send('bf-on');
    check('чат с инициативой: CLI запущен', Boolean(on.call), `статус ${on.status}`);
    const hook = hookOf(on.call);
    check(
      'в --settings хук PreToolUse на поиск, доску и спринт',
      Boolean(hook),
      on.call?.settings || '(файла --settings нет)',
    );
    check(
      'команда хука — board-fields-hook.mjs панели, по абсолютному пути',
      /^node ".*[\\/]tools[\\/]board-fields-hook\.mjs"$/.test(hook?.hooks?.[0]?.command ?? ''),
      hook?.hooks?.[0]?.command,
    );
    check(
      'серверы чата не сняты: --strict-mcp-config в argv нет',
      !on.call?.argv.includes('--strict-mcp-config'),
      on.call?.argv.join(' '),
    );

    const patched = await stand.api('/settings', {
      method: 'PATCH',
      body: { taskSplitInitiative: false },
    });
    check('инициатива выключена', patched.status === 200, patched.text.slice(0, 300));
    const off = await send('bf-off');
    check('чат без инициативы: CLI запущен', Boolean(off.call), `статус ${off.status}`);
    check(
      'без инициативы хука нет',
      !hookOf(off.call),
      off.call?.settings || '(файла --settings нет)',
    );
  },
);
