/**
 * Исходник фальшивого `claude` для сквозного хода «агент панели ведёт чат»
 * (`check-panel-agent-chat-flow.mjs`). Один скрипт — две роли, как у настоящего
 * CLI, который панель запускает и для своего агента, и для чатов проектов:
 *
 * - ЧАТ (`--input-format stream-json`): процесс на разговор, читает строки
 *   stdin и отвечает на каждую, пишет транскрипт туда же, где его пишет
 *   настоящий CLI. На просьбу разделить задачи (текст кнопки сервера) отвечает
 *   блоком разделения из трёх групп, на остальное — «Готово.». Каждый ход —
 *   строка в `turns.jsonl` рядом со скриптом.
 * - АГЕНТ ПАНЕЛИ (`--mcp-config`, stdin до конца): говорит MCP с настоящим
 *   переходником панели и зовёт её действия: list_chats → read_chat →
 *   send_chat_message → request_split, потом читает чат, пока в нём не появится
 *   предложение, и называет кнопку, которую нажимает человек. Список
 *   инструментов переходника пишется в `agent-tools.json`, каждый вызов — в
 *   `agent-cli.jsonl`.
 *
 * Подменена только модель. Экспорт — строка: её исходник пишется в файл стенда.
 */
export const FAKE_CHAT_FLOW_CLI_SOURCE = String.raw`
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
}, 300).unref();

const after = (flag) => {
  const at = argv.indexOf(flag);
  return at >= 0 ? argv[at + 1] : undefined;
};
const out = (event) => process.stdout.write(JSON.stringify(event) + '\n');
// Три обратных апострофа: внутри шаблонной строки исходника их не написать.
const FENCE = String.fromCharCode(96).repeat(3);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const parse = (text) => {
  const at = text.indexOf('{');
  try {
    return at >= 0 ? JSON.parse(text.slice(at)) : undefined;
  } catch {
    return undefined;
  }
};

if (after('--input-format') === 'stream-json') await chat();
else await panelAgent();

// ── ЧАТ ───────────────────────────────────────────────────────────────────
async function chat() {
  const sid = after('--resume') || after('--session-id') || 'sess-' + process.pid;
  const dir = join(process.env.CLAUDE_CONFIG_DIR || '.', 'projects', process.cwd().replace(/[^A-Za-z0-9]/g, '-'));
  const transcript = (role, text) => {
    mkdirSync(dir, { recursive: true });
    appendFileSync(
      join(dir, sid + '.jsonl'),
      JSON.stringify({
        type: role,
        sessionId: sid,
        cwd: process.cwd(),
        timestamp: new Date().toISOString(),
        message: { role, content: role === 'user' ? text : [{ type: 'text', text }] },
      }) + '\n',
    );
  };
  const reply = (prompt) => {
    appendFileSync(near('turns.jsonl'), JSON.stringify({ sid, cwd: process.cwd(), prompt, at: Date.now() }) + '\n');
    const groups = [
      { title: 'Страница входа', branch: 'feat/login-page', tasks: ['Сверстать форму входа'] },
      { title: 'Тесты входа', branch: 'test/login', tasks: ['Покрыть вход тестами'] },
      { title: 'README', branch: 'docs/readme', tasks: ['Описать запуск в README'] },
    ];
    const text = prompt.startsWith('Split the tasks of this conversation')
      ? 'Предлагаю разделить на три группы.\n' + FENCE + 'agentdeck:split\n' + JSON.stringify({ groups }) + '\n' + FENCE
      : 'Готово.';
    transcript('user', prompt);
    transcript('assistant', text);
    out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-x', tools: [] });
    out({ type: 'assistant', session_id: sid, message: { id: 'm' + Date.now(), role: 'assistant', content: [{ type: 'text', text }] } });
    out({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: sid, total_cost_usd: 0, duration_ms: 1, num_turns: 1 });
  };
  const textOf = (line) => {
    try {
      const msg = JSON.parse(line);
      if (msg.type !== 'user') return undefined;
      const content = msg.message?.content;
      return typeof content === 'string' ? content : (content ?? []).map((part) => part.text ?? '').join('');
    } catch {
      return undefined;
    }
  };
  let buffered = '';
  for await (const chunk of process.stdin) {
    buffered += chunk.toString('utf8');
    let at;
    while ((at = buffered.indexOf('\n')) >= 0) {
      const text = textOf(buffered.slice(0, at));
      buffered = buffered.slice(at + 1);
      if (text !== undefined) reply(text);
    }
  }
}

// ── АГЕНТ ПАНЕЛИ ──────────────────────────────────────────────────────────
async function panelAgent() {
  let prompt = '';
  for await (const chunk of process.stdin) prompt += chunk.toString('utf8');
  const config = JSON.parse(readFileSync(after('--mcp-config'), 'utf8'));
  const [serverId, server] = Object.entries(config.mcpServers)[0];
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
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'fake-claude', version: '0' } });
  bridge.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const listed = await rpc('tools/list', {});
  writeFileSync(near('agent-tools.json'), JSON.stringify(listed.result?.tools ?? []));

  let seq = 0;
  const tool = async (name, args) => {
    const useId = 'toolu_' + ++seq;
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: useId, name: 'mcp__' + serverId + '__' + name, input: args }] } });
    const answer = await rpc('tools/call', { name, arguments: args });
    const text = (answer.result?.content ?? []).map((part) => part.text ?? '').join('\n');
    const isError = answer.result?.isError === true || answer.error !== undefined;
    out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: useId, content: [{ type: 'text', text }], is_error: isError }] } });
    appendFileSync(near('agent-cli.jsonl'), JSON.stringify({ name, args, isError, text: text.slice(0, 4000) }) + '\n');
    return { text, isError, done: !isError && text.startsWith('Done.') };
  };

  const current = (/Human \(current request\): ([\s\S]*)$/.exec(prompt)?.[1] ?? prompt).trim();
  const about = (/про (.+?)[.?!]*$/i.exec(current)?.[1] ?? '').trim();
  let reply;
  const chats = parse((await tool('list_chats', {})).text)?.chats ?? [];
  const target = chats.find((item) => about && String(item.title).includes(about));
  if (!target) {
    reply = 'Не нашёл чат про ' + about + '.';
  } else {
    await tool('read_chat', { chat: target.id });
    const sent = await tool('send_chat_message', { chat: target.id, message: 'Сначала допиши README.' });
    const asked = await tool('request_split', { chat: target.id });
    if (!asked.done) {
      reply = 'Разделение не запрошено' + (sent.done ? '' : ', сообщение не отправлено') + ' — вы отклонили.';
    } else {
      let proposal;
      for (let t = 0; t < 60 && !proposal; t += 1) {
        proposal = parse((await tool('read_chat', { chat: target.id })).text)?.splitProposal;
        if (!proposal) await sleep(500);
      }
      reply = proposal
        ? 'Агент чата предложил разделение. Нажмите «Разделить на ' + proposal.groups.length + ' чата» в чате — сам я его не применяю.'
        : 'Попросил агента чата о разделении, предложения пока нет.';
    }
  }
  out({ type: 'assistant', message: { content: [{ type: 'text', text: reply }] } });
  bridge.kill();
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: reply, is_error: false }) + '\n', () => process.exit(0));
}
`;
