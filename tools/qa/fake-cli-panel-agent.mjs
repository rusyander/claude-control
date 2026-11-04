/**
 * Исходник фальшивого `claude` для агента панели (`check-agent-rules-walk.mjs`).
 * Стенд кладёт его под именем `claude` первым в PATH одноразовой панели.
 *
 * Подменена ТОЛЬКО модель. Всё остальное настоящее: скрипт читает `--mcp-config`,
 * который собрала панель, запускает из него настоящий переходник
 * (`tools/mcp/panel.mjs`), говорит с ним MCP по stdio и зовёт действия панели
 * так же, как их зовёт CLI, — значит, каждое изменение проходит карточку и ждёт
 * решения человека. Ход агента панели идёт через ядро (s10): CLI зовётся как SDK
 * (`--input-format stream-json`, stdin открыт), мост — сервер `panel-bridge` среди
 * прочих в `--mcp-config` сессии. Скрипт отвечает так, как читает ядро
 * (`sdk-stream/normalise.ts`): эхо строки user с её uuid (`isReplay`), `system/init`,
 * текст частями `stream_event`, сообщения с id и расходом, `result` на ход; выход —
 * по концу stdin.
 *
 * Ход выбирается по ТЕКУЩЕЙ просьбе (`Human (current request): …`):
 * - «создай правила для X» → два `save_rule` про X; ответ называет созданные;
 * - иначе («для чего эти правила?») → `list_rules`, потом каждое правило целиком
 *   (`list_rules {id}`), и ответ пересказывает ИХ ТЕКСТ из панели. Тел правил
 *   скрипт на этом ходу не знает — только то, что вернула панель;
 * - «найди наборы … в <папка>» → `list_discovered_groups`, пока идёт поиск, потом
 *   `import_discovered_group` находки «Walk set <папка>»;
 * - «перенеси переменную KEY …» → `move_env` из settings.json;
 * - «поменяй право «P» …» → `edit_permission_rule` allow → ask.
 *
 * Служебный вызов (без моста `panel-bridge` — поиск наборов; на прежней дороге —
 * `claude -p` без `--mcp-config`) получает ответ `serviceReply`: вся опись источника
 * одним набором. Пишется в `service-cli.jsonl`.
 *
 * Каждый вызов пишется в `agent-cli.jsonl` рядом с собой.
 * Экспорт — строка: её исходник пишется в файл стенда (`fakeCli`).
 */
export const FAKE_PANEL_AGENT_CLI_SOURCE = String.raw`
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const self = fileURLToPath(import.meta.url);
const near = (name) => self.replace(/[^\\/]+$/, name);

if (argv[0] === '--version' || argv[0] === '-v') {
  process.stdout.write('2.1.0 (Claude Code)\n');
  process.exit(0);
}

// Стенд снят — выйти самому: иначе процесс держал бы его каталог.
setInterval(() => {
  if (!existsSync(near('.stand-alive'))) process.exit(0);
}, 500).unref();

const log = (entry) => appendFileSync(near('agent-cli.jsonl'), JSON.stringify(entry) + '\n');
const flag = (name) => {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1]?.replace(/^"|"$/g, '') : undefined;
};
const configPath = flag('--mcp-config');
// Ядро (s10) зовёт CLI как SDK: «-p --input-format stream-json», stdin открыт, ходы — строки
// user, каждая ждёт эха со своим uuid (--replay-user-messages). Прежняя дорога панели —
// задание целиком на stdin и выход по его концу — осталась для служебных вызовов.
const core = argv.includes('--input-format');
const session = flag('--resume') ?? flag('--session-id') ?? randomUUID();
const model = flag('--model') ?? 'fake-panel-agent';
const msgId = () => 'msg_' + randomUUID().replace(/-/g, '').slice(0, 20);
const out = (event) => {
  if (core && (event.type === 'assistant' || event.type === 'user')) {
    event.session_id = session;
    event.parent_tool_use_id = null;
    if (event.type === 'assistant') {
      event.message = { id: msgId(), type: 'message', role: 'assistant', model, stop_reason: null,
        usage: { input_tokens: 1, output_tokens: 1 }, ...event.message };
      // Текст ядро берёт из потока частей (--include-partial-messages), как у настоящего CLI:
      // целое сообщение несёт только вызовы и расход.
      const texts = event.message.content.filter((block) => block.type === 'text');
      if (texts.length > 0) {
        const part = (inner) => process.stdout.write(
          JSON.stringify({ type: 'stream_event', event: inner, session_id: session, parent_tool_use_id: null }) + '\n');
        part({ type: 'message_start', message: { ...event.message, content: [] } });
        texts.forEach((block, index) =>
          part({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } }));
        part({ type: 'message_stop' });
      }
    } else event.message = { role: 'user', ...event.message };
  }
  process.stdout.write(JSON.stringify(event) + '\n');
};
// Итог хода: на прежней дороге — выход, у ядра — ждать следующую строку или конец stdin.
const finish = (reply, isError = false) =>
  new Promise((resolve) => {
    const line = { type: 'result', subtype: isError ? 'error_during_execution' : 'success', result: reply,
      is_error: isError, num_turns: 1, duration_ms: 1, total_cost_usd: 0, session_id: session,
      usage: { input_tokens: 1, output_tokens: 1 } };
    // Выход — после того, как строка итога ушла в трубу: на Linux запись в неё асинхронна.
    process.stdout.write(JSON.stringify(line) + '\n', () => (core ? resolve() : process.exit(isError ? 1 : 0)));
  });

let prompt = '';
process.stdin.setEncoding('utf8');
if (core) {
  const queue = [];
  let busy = false;
  let ended = false;
  const pump = async () => {
    if (busy) return;
    if (queue.length === 0) {
      if (ended) process.exit(0);
      return;
    }
    busy = true;
    const message = queue.shift();
    const content = message.message?.content;
    prompt = typeof content === 'string' ? content : (content ?? []).map((part) => part.text ?? '').join('');
    out({ type: 'user', message: message.message, uuid: message.uuid, isReplay: true });
    out({ type: 'system', subtype: 'init', session_id: session, model, cwd: process.cwd(), tools: [],
      mcp_servers: [] });
    try {
      await turn();
    } catch (error) {
      await finish(String(error), true);
    } finally {
      busy = false;
    }
    void pump();
  };
  createInterface({ input: process.stdin })
    .on('line', (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.type !== 'user') return;
      queue.push(message);
      void pump();
    })
    .on('close', () => {
      ended = true;
      void pump();
    });
} else {
  process.stdin.on('data', (chunk) => (prompt += chunk));
  process.stdin.on('end', () => {
    turn().catch((error) => finish(String(error), true));
  });
}

// Ход без моста панели — служебный вызов (поиск наборов: задание текстом, ответ — текст).
async function turn() {
  const config = configPath ? JSON.parse(readFileSync(configPath, 'utf8')) : undefined;
  const servers = Object.entries(config?.mcpServers ?? {});
  const bridged = servers.find(([id]) => id === 'panel-bridge') ?? (core ? undefined : servers[0]);
  if (!bridged) {
    const reply = serviceReply(prompt);
    appendFileSync(near('service-cli.jsonl'), JSON.stringify({ argv, reply }) + '\n');
    if (!core) {
      process.stdout.write(reply + '\n', () => process.exit(0));
      return;
    }
    // Не строка-якорь сценария (REPLY_LINE ищется подстрокой): текст ответа — отдельным блоком.
    const answer = { type: 'text', text: reply };
    out({ type: 'assistant', message: { content: [answer] } });
    await finish(reply);
    return;
  }
  await main(bridged);
}

const parse = (text) => {
  const at = text.indexOf('{');
  try {
    return at >= 0 ? JSON.parse(text.slice(at)) : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Ответ на опись источника: всё найденное — один набор «Walk set <папка>». Имя
 * несёт папку источника, чтобы ход агента выбрал находку своего проекта.
 */
function serviceReply(text) {
  const source = /Source: (.+?)(?: \(part \d+ of \d+\))?\r?\n/.exec(text)?.[1]?.trim();
  const inventory = text.slice(Math.max(0, text.indexOf('Inventory:')));
  const members = [...inventory.matchAll(/^- (\w+) (\S+):/gm)].map((m) => ({ kind: m[1], id: m[2] }));
  if (!source || members.length === 0) return JSON.stringify({ groups: [] });
  const folder = source.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
  return JSON.stringify({
    groups: [{ name: 'Walk set ' + folder, when: 'walk', why: 'found together', members }],
  });
}

async function main([serverId, server]) {
  const bridge = spawn(server.command, server.args ?? [], {
    env: { ...process.env, ...(server.env ?? {}) },
    stdio: ['pipe', 'pipe', 'ignore'],
    windowsHide: true,
  });
  let buffer = '';
  let nextId = 1;
  const waiting = new Map();
  bridge.stdout.setEncoding('utf8');
  bridge.stdout.on('data', (chunk) => {
    buffer += chunk;
    let at = buffer.indexOf('\n');
    while (at >= 0) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      at = buffer.indexOf('\n');
      if (!line) continue;
      const message = JSON.parse(line);
      if (message.id !== undefined && waiting.has(message.id)) {
        waiting.get(message.id)(message);
        waiting.delete(message.id);
      }
    }
  });
  const rpc = (method, params) =>
    new Promise((resolve) => {
      const id = nextId++;
      waiting.set(id, resolve);
      bridge.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'fake-claude', version: '0' },
  });
  bridge.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  let seq = 0;
  const tool = async (name, args) => {
    const useId = 'toolu_' + ++seq;
    out({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: useId, name: 'mcp__' + serverId + '__' + name, input: args }] },
    });
    const answer = await rpc('tools/call', { name, arguments: args });
    const text = (answer.result?.content ?? []).map((part) => part.text ?? '').join('\n');
    const isError = answer.result?.isError === true || answer.error !== undefined;
    out({
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: useId, content: [{ type: 'text', text }], is_error: isError }],
      },
    });
    log({ name, args, isError, text: text.slice(0, 2000) });
    return { text, isError };
  };

  const current = (/Human \(current request\): ([\s\S]*)$/.exec(prompt)?.[1] ?? prompt).trim();
  let reply;
  const done = (result) => !result.isError && result.text.startsWith('Done.');
  if (/наборы/i.test(current)) {
    // Поиск идёт в фоне: читать находки, пока идёт, как и велит описание действия.
    const where = (/\sв\s+(\S+?)[.?!]*$/i.exec(current)?.[1] ?? '').trim();
    let view;
    for (let i = 0; i < 120; i += 1) {
      view = parse((await tool('list_discovered_groups', {})).text);
      if (view && !view.running) break;
      await new Promise((resume) => setTimeout(resume, 500));
    }
    const found = (view?.groups ?? []).find(
      (item) => item.name === 'Walk set ' + where && item.status === 'new',
    );
    if (!found) reply = 'Нового набора в ' + where + ' не нашлось.';
    else {
      const result = await tool('import_discovered_group', { key: found.key });
      reply = done(result)
        ? 'Набор «' + found.name + '» стал группой проекта, выключенной.'
        : 'Набор «' + found.name + '» не импортирован: ' + result.text.slice(0, 200);
    }
  } else if (/перенеси/i.test(current)) {
    const key = /\b([A-Z][A-Z0-9_]+)\b/.exec(current)?.[1] ?? 'X';
    const result = await tool('move_env', { key, source: 'settings' });
    reply = done(result)
      ? 'Переменная ' + key + ' теперь в settings.local.json.'
      : 'Переменная ' + key + ' осталась на месте: ' + result.text.slice(0, 200);
  } else if (/право/i.test(current)) {
    const pattern = /«(.+?)»/.exec(current)?.[1] ?? 'X';
    const result = await tool('edit_permission_rule', {
      id: 'allow:' + pattern,
      decision: 'ask',
      pattern,
    });
    reply = done(result)
      ? 'Право ' + pattern + ' теперь спрашивает.'
      : 'Право ' + pattern + ' не изменено: ' + result.text.slice(0, 200);
  } else if (/созда|create/i.test(current)) {
    const topic = (/(?:для|for)\s+(.+?)[.?!]*$/i.exec(current)?.[1] ?? 'X').trim();
    const drafts = [
      { title: topic + ': язык', body: 'Сообщения про ' + topic + ' пишутся по-русски, в повелительном наклонении.' },
      { title: topic + ': длина', body: 'Первая строка про ' + topic + ' — не длиннее 72 символов.' },
    ];
    const made = [];
    const refused = [];
    for (const draft of drafts) {
      const result = await tool('save_rule', draft);
      (result.isError || !result.text.startsWith('Done.') ? refused : made).push(draft.title);
    }
    reply = made.length > 0
      ? 'Создал правила: ' + made.map((title) => '«' + title + '»').join(', ') + '.'
      : 'Правила не созданы: ' + refused.map((title) => '«' + title + '»').join(', ') + ' — вы отклонили.';
  } else {
    const listed = parse((await tool('list_rules', {})).text);
    const parts = [];
    for (const rule of listed?.rules ?? []) {
      const full = parse((await tool('list_rules', { id: rule.id })).text);
      const body = typeof full?.body === 'string' ? full.body : (full?.body?.text ?? '');
      parts.push('«' + rule.title + '» — ' + body.trim());
    }
    reply = parts.length > 0 ? 'Эти правила задают вот что:\n' + parts.join('\n') : 'Правил нет.';
  }
  out({ type: 'assistant', message: { content: [{ type: 'text', text: reply }] } });
  bridge.kill();
  await finish(reply);
}
`;
