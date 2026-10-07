/**
 * Разделы, которых у активного CLI нет, отказывают ДО запуска процесса. Кейс cli-x4-001.
 *
 * Было: `/api/plugins*` запускали АКТИВНЫЙ CLI с аргументами плагинов Claude
 * (`kimi plugin list --json`) и читали каталог плагинов Claude; песочница поднимала
 * настоящий `claude` при любом активном CLI; у Cursor (нет неинтерактивного запуска)
 * разговор заводился и падал на первом вопросе невнятным «нет ни ключа, ни CLI».
 * Стало: 409 с кодом (`plugins-provider-unsupported`, `sandbox-provider-unsupported`,
 * `provider-chat-unsupported`) и ни одного запуска.
 *
 * Проверка идёт в настоящий экземпляр панели (`apps/server/src/index.ts`) на
 * одноразовом доме (`throwaway-stand.mjs`), без фронта. Вместо CLI — фальшивые под
 * теми же именами первыми в PATH: каждый пишет свой argv в журнал рядом с собой.
 * Настоящий CLI не запускается ни разу. Свидетельство — журнал вызовов: контроль
 * под Claude (`claude plugin list` в журнале) доказывает, что подмена видна, так
 * что пустой журнал при отказе — решение маршрута, а не «CLI не найден».
 *
 * Запуск: `node tools/qa/check-cli-x4-guards.mjs [--server-dir <копия apps/server>]`.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { diffRealProviderDirs, runOnStand, snapshotRealProviderDirs } from './throwaway-stand.mjs';

const serverAt = process.argv.indexOf('--server-dir');
const SERVER_DIR = serverAt > 0 ? process.argv[serverAt + 1] : undefined;

/** Фальшивый CLI: строка журнала на каждый запуск, на stdout — пустой JSON-список. */
const fakeSource = (name) => `
import { appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
appendFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'calls.jsonl'),
  JSON.stringify({ cli: ${JSON.stringify(name)}, argv: process.argv.slice(2) }) + '\\n',
);
process.stdout.write('[]');
`;

const fakeCli = Object.fromEntries(
  ['claude', 'kimi', 'cursor-agent', 'gemini'].map((name) => [name, fakeSource(name)]),
);

/** Маршруты плагинов Claude: каждый ходит в CLI. */
const PLUGIN_ROUTES = [
  ['GET', '/plugins'],
  ['GET', '/plugins/available'],
  ['POST', '/plugins/install', { id: 'demo@market' }],
  ['POST', '/plugins/demo%40market/uninstall'],
  ['POST', '/plugins/demo%40market/enabled', { isEnabled: true }],
  ['POST', '/plugins/demo%40market/update'],
  ['POST', '/plugins/marketplaces', { source: 'owner/repo' }],
  ['DELETE', '/plugins/marketplaces/market'],
];

const SANDBOX_ID = `x4-guard-${process.pid}`;

/** Маршруты песочницы, которые читают конфиг Claude или запускают claude. */
const SANDBOX_ROUTES = [
  ['POST', '/sandbox/create', { id: SANDBOX_ID }],
  ['POST', '/sandbox/run', { id: SANDBOX_ID, prompt: 'проверь правило' }],
  ['POST', '/sandbox/probe-hook', { id: SANDBOX_ID, scriptName: 'guard.mjs' }],
  ['POST', '/sandbox/mcp-tools', { mcpId: 'demo' }],
  ['POST', '/sandbox/mcp-call', { mcpId: 'demo', tool: 'echo' }],
];

const realBefore = snapshotRealProviderDirs();

await runOnStand(
  {
    label: 'cli-x4-guards',
    web: false,
    fakeCli,
    settings: { provider: 'kimi' },
    ...(SERVER_DIR ? { serverDir: SERVER_DIR } : {}),
  },
  async (stand, check) => {
    const origin = `http://127.0.0.1:${Number(new URL(stand.apiUrl).port) + 1}`;
    const journal = join(stand.bin, 'calls.jsonl');
    const calls = () =>
      (stand.read(journal) ?? '')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    const send = (method, path, body) =>
      stand.api(path, { method, headers: { origin }, ...(body ? { body } : {}) });
    const switchTo = async (provider) => {
      const answer = await send('PATCH', '/settings', { provider });
      check(
        `активный CLI → ${provider}`,
        answer.status === 200,
        `${answer.status} ${answer.text.slice(0, 200)}`,
      );
    };

    /** Запрос, на который ждём 409 с кодом и ни одного запуска CLI за время запроса. */
    const expectRefusal = async (label, method, path, body, code) => {
      const before = calls().length;
      const answer = await send(method, path, body);
      const during = calls().slice(before);
      check(
        `${label}: ${method} /api${path} — 409 ${code}`,
        answer.status === 409 && answer.body?.messageCode === code,
        `${answer.status} ${answer.text.slice(0, 300)}`,
      );
      check(
        `${label}: ${method} /api${path} — ни одного запуска CLI`,
        during.length === 0,
        JSON.stringify(during),
      );
      return answer;
    };

    console.log('Kimi Code активен: плагины Claude');
    for (const [method, path, body] of PLUGIN_ROUTES) {
      await expectRefusal('kimi', method, path, body, 'plugins-provider-unsupported');
    }
    const named = await send('GET', '/plugins');
    check(
      'отказ называет активный CLI (params.provider = «Kimi Code»)',
      named.body?.params?.provider === 'Kimi Code',
      JSON.stringify(named.body?.params),
    );

    console.log('Kimi Code активен: песочница');
    for (const [method, path, body] of SANDBOX_ROUTES) {
      await expectRefusal('kimi', method, path, body, 'sandbox-provider-unsupported');
    }
    const sandboxDir = join(stand.home, '.agentdeck', 'sandboxes', SANDBOX_ID);
    check('песочница не собрана на диске', !existsSync(sandboxDir), sandboxDir);

    console.log('Cursor активен: чат');
    await switchTo('cursor');
    await expectRefusal('cursor', 'POST', '/provider-chat/chats', {}, 'provider-chat-unsupported');
    const list = await send('GET', '/provider-chat/chats');
    check(
      'cursor: разговор не заведён (список пуст)',
      list.status === 200 && Array.isArray(list.body) && list.body.length === 0,
      `${list.status} ${list.text.slice(0, 200)}`,
    );

    console.log('Контроль: там, где раздел есть, отказа нет');
    await switchTo('gemini');
    const gemini = await send('POST', '/provider-chat/chats', {});
    check(
      'gemini (чат ready): разговор заводится — 200',
      gemini.status === 200 && typeof gemini.body?.id === 'string',
      `${gemini.status} ${gemini.text.slice(0, 200)}`,
    );
    await switchTo('claude');
    const before = calls().length;
    const claude = await send('GET', '/plugins');
    const claudeCalls = calls().slice(before);
    check(
      'claude: GET /api/plugins — 200',
      claude.status === 200,
      `${claude.status} ${claude.text.slice(0, 200)}`,
    );
    check(
      'claude: до фальшивого claude дошло «plugin list» — подмена CLI видна журналу',
      claudeCalls.some(
        (call) => call.cli === 'claude' && call.argv[0] === 'plugin' && call.argv[1] === 'list',
      ),
      JSON.stringify(claudeCalls),
    );

    const foreign = calls().filter((call) => call.cli !== 'claude');
    check(
      'за весь прогон ни kimi, ни cursor-agent, ни gemini не запускались',
      foreign.length === 0,
      JSON.stringify(foreign),
    );

    const realDiff = diffRealProviderDirs(realBefore, snapshotRealProviderDirs());
    check(
      'настоящие каталоги CLI человека не тронуты',
      realDiff.length === 0,
      JSON.stringify(realDiff.slice(0, 10)),
    );
  },
);
