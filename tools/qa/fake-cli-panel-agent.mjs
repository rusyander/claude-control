/**
 * Исходник фальшивого `claude` для агента панели (`check-agent-rules-walk.mjs`).
 * Стенд кладёт его под именем `claude` первым в PATH одноразовой панели.
 *
 * Подменена ТОЛЬКО модель. Всё остальное настоящее: скрипт читает `--mcp-config`,
 * который собрала панель, запускает из него настоящий переходник
 * (`tools/mcp/panel.mjs`), говорит с ним MCP по stdio и зовёт действия панели
 * так же, как их зовёт CLI, — значит, каждое изменение проходит карточку и ждёт
 * решения человека. Ответ — строки `--output-format stream-json`, какие читает
 * `runner.ts`: `tool_use`, `tool_result`, текст и `result`.
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
 * Служебный вызов панели (`claude -p` без `--mcp-config` — поиск наборов) получает
 * ответ `serviceReply`: вся опись источника одним набором. Пишется в
 * `service-cli.jsonl`.
 *
 * Каждый вызов пишется в `agent-cli.jsonl` рядом с собой.
 * Экспорт — строка: её исходник пишется в файл стенда (`fakeCli`).
 */
export const FAKE_PANEL_AGENT_CLI_SOURCE = String.raw`
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
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
const out = (event) => process.stdout.write(JSON.stringify(event) + '\n');
const configPath = argv[argv.indexOf('--mcp-config') + 1];

let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (prompt += chunk));
process.stdin.on('end', () => {
  if (!argv.includes('--mcp-config')) {
    // Служебный вызов панели (поиск наборов: «claude -p», задание на stdin, ответ — текст).
    const reply = serviceReply(prompt);
    appendFileSync(near('service-cli.jsonl'), JSON.stringify({ argv, reply }) + '\n');
    process.stdout.write(reply + '\n', () => process.exit(0));
    return;
  }
  main().catch((error) => {
    out({ type: 'result', subtype: 'error', result: String(error), is_error: true });
    process.exit(1);
  });
});

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

async function main() {
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
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
  // Выход — после того, как строка итога ушла в трубу: на Linux запись в неё асинхронна.
  process.stdout.write(
    JSON.stringify({ type: 'result', subtype: 'success', result: reply, is_error: false }) + '\n',
    () => process.exit(0),
  );
}
`;
