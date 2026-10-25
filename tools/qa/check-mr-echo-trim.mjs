/**
 * Эхо записи MR в звене группы — живой путь: настоящий `claude`, модель-стаб, MCP-стаб
 * форджа и хук PostToolUse набора (`hooks/lib/run.mjs post-any`).
 *
 * Форж возвращает на `update_merge_request` весь MR с описанием — текстом, который
 * модель только что сама отправила (группа 1, 25.10: шесть правок описания — 62k эха).
 * Хук `mr-echo-trim` подменяет вывод через `updatedMCPToolOutput`. Доказательство —
 * тело СЛЕДУЮЩЕГО запроса к модели: в нём `tool_result` такой, каким его увидела модель.
 *
 * Три прогона: без хука (эхо целиком — контроль: стаб правда шлёт большое эхо), звено
 * группы (эхо обрезано, ссылка MR на месте), сессия человека (эхо целиком).
 * `--global` — тот же прогон с глобальным диспетчером `~/.claude/hooks/post-any-dispatch.mjs`
 * (пишет его отметки в `~/.claude/cache`, поэтому к блоку тестов не привязан).
 *
 * Запуск: node tools/qa/check-mr-echo-trim.mjs [--global]; CLAUDE_CLI — свой `claude`.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, parse } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOLS = dirname(dirname(fileURLToPath(import.meta.url)));
const KIT_RUN = join(
  TOOLS,
  '..',
  'apps',
  'server',
  'assets',
  'kit',
  'agentdeck-kit',
  'hooks',
  'lib',
  'run.mjs',
);
const GLOBAL_RUN = join(homedir(), '.claude', 'hooks', 'post-any-dispatch.mjs');
const GLOBAL = process.argv.includes('--global');
const DESCRIPTION = 'Описание MR. '.repeat(1_500); // ~21k знаков

let bad = 0;
const check = (ok, text) => {
  console.log(`${ok ? 'ок ' : 'НЕТ'} ${text}`);
  if (!ok) bad += 1;
};

function resolveClaude() {
  if (process.env.CLAUDE_CLI) return process.env.CLAUDE_CLI;
  if (process.platform !== 'win32') return 'claude';
  const tail = join('node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
  for (const root of [dirname(process.execPath), join(process.env.APPDATA ?? '', 'npm')]) {
    if (existsSync(join(root, tail))) return join(root, tail);
  }
  return '';
}

/** Каталог без `.claude` у родителей: на Windows временная папка лежит в домашней. */
function workBase() {
  for (let dir = tmpdir(); ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.claude'))) break;
    if (dir === parse(dir).root) return tmpdir();
  }
  const pub = process.platform === 'win32' ? process.env.PUBLIC : '/tmp';
  if (pub && existsSync(pub)) return pub;
  throw new Error('нет каталога вне домашней папки: задайте PUBLIC');
}

// MCP-стаб форджа: один инструмент, ответ — MR целиком, как у GitLab.
const MCP_STUB = `
import readline from 'node:readline';
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
const mr = {
  id: 9001, iid: 7, project_id: 42, title: 'feat: x', state: 'opened', draft: false,
  web_url: 'https://forge.example.com/group/proj/-/merge_requests/7',
  source_branch: 'feature/x', target_branch: 'main', sha: 'abc123',
  merge_status: 'can_be_merged', created_at: '2026-10-25T00:00:00Z', updated_at: '2026-10-25T01:00:00Z',
  description: ${JSON.stringify(DESCRIPTION)},
  author: { id: 1, username: 'someone', name: 'Someone' },
};
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.method === 'initialize') return send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'forge-stub', version: '1.0.0' } } });
  if (m.method === 'tools/list') return send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'update_merge_request', description: 'stub', inputSchema: { type: 'object', properties: { iid: { type: 'string' }, description: { type: 'string' } } } }] } });
  if (m.method === 'tools/call') return send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: JSON.stringify(mr) }] } });
  if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, result: {} });
});
`;

function sse(blocks, stop) {
  const events = [
    [
      'message_start',
      {
        type: 'message_start',
        message: {
          id: 'msg_mr',
          type: 'message',
          role: 'assistant',
          model: 'stub',
          content: [],
          stop_reason: null,
          usage: { input_tokens: 10, output_tokens: 1 },
        },
      },
    ],
  ];
  blocks.forEach(([start, delta], index) => {
    events.push([
      'content_block_start',
      { type: 'content_block_start', index, content_block: start },
    ]);
    events.push(['content_block_delta', { type: 'content_block_delta', index, delta }]);
    events.push(['content_block_stop', { type: 'content_block_stop', index }]);
  });
  events.push([
    'message_delta',
    { type: 'message_delta', delta: { stop_reason: stop }, usage: { output_tokens: 1 } },
  ]);
  events.push(['message_stop', { type: 'message_stop' }]);
  return events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('');
}
const textReply = (text) =>
  sse(
    [
      [
        { type: 'text', text: '' },
        { type: 'text_delta', text },
      ],
    ],
    'end_turn',
  );

/** Модель-стаб: в главном разговоре зовёт правку MR, следующим запросом запоминает её итог. */
function startStub() {
  const state = { result: null };
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (!req.url?.includes('/messages') || req.url.includes('count_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(req.url?.includes('count_tokens') ? '{"input_tokens":10}' : '{}');
        return;
      }
      let body = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        /* пустое тело — тоже запрос */
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const main = (body.tools ?? []).some((t) => /__update_merge_request$/.test(t.name));
      if (!main) return res.end(textReply('no'));
      const results = (body.messages ?? []).flatMap((m) =>
        Array.isArray(m.content) ? m.content.filter((b) => b.type === 'tool_result') : [],
      );
      if (results.length) {
        const last = results[results.length - 1];
        // Тексты блоков итога — то, что прочтёт модель (без JSON-обёртки блоков).
        state.result =
          typeof last.content === 'string'
            ? last.content
            : (Array.isArray(last.content) ? last.content : [])
                .map((b) => (typeof b?.text === 'string' ? b.text : ''))
                .join('\n');
        return res.end(textReply('ok'));
      }
      const name = body.tools.find((t) => /__update_merge_request$/.test(t.name)).name;
      res.end(
        sse(
          [
            [
              { type: 'tool_use', id: 'toolu_mr0', name, input: {} },
              {
                type: 'input_json_delta',
                partial_json: JSON.stringify({ iid: '7', description: DESCRIPTION }),
              },
            ],
          ],
          'tool_use',
        ),
      );
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        state,
        close: () => server.close(),
      }),
    ),
  );
}

async function runOnce(exe, work, label, { hook, child }) {
  const stub = await startStub();
  const dir = join(work, label);
  const home = join(dir, 'home');
  const project = join(dir, 'proj');
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
  writeFileSync(join(home, 'settings.json'), '{}');
  const stubFile = join(dir, 'forge-stub.mjs');
  writeFileSync(stubFile, MCP_STUB);
  const mcpFile = join(dir, 'mcp.json');
  writeFileSync(
    mcpFile,
    JSON.stringify({ mcpServers: { forge: { command: process.execPath, args: [stubFile] } } }),
  );
  const settings = hook
    ? {
        hooks: {
          PostToolUse: [
            {
              matcher: '^(?!(Read|Grep|Glob)$).*',
              hooks: [
                {
                  type: 'command',
                  command: `node "${hook}"${hook === KIT_RUN ? ' post-any' : ''}`,
                  timeout: 10,
                },
              ],
            },
          ],
        },
      }
    : {};
  const settingsFile = join(dir, 'settings.json');
  writeFileSync(settingsFile, JSON.stringify(settings));
  const env = {
    ...process.env,
    CLAUDE_CONFIG_DIR: home,
    ANTHROPIC_BASE_URL: stub.url,
    ANTHROPIC_AUTH_TOKEN: 'mr-stub',
    ANTHROPIC_API_KEY: 'mr-stub',
    ANTHROPIC_MODEL: 'claude-sonnet-4-6',
    DISABLE_AUTOUPDATER: '1',
    ENABLE_TOOL_SEARCH: 'false',
    AGENTDECK_KIT_STATE: join(dir, 'kit-state'),
    AGENTDECK_KIT_VARIANT: '',
    AGENTDECK_HEAVY_QUEUE_DIR: '',
    AGENTDECK_SPLIT_CHILD: child ? '1' : '',
  };
  const args = [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--strict-mcp-config',
    '--mcp-config',
    mcpFile,
    '--settings',
    settingsFile,
    '--allowedTools',
    'mcp__forge__update_merge_request',
  ];
  const output = await new Promise((resolve) => {
    const proc = spawn(exe, args, { cwd: project, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    proc.stdout.on('data', (c) => (out += c));
    proc.stderr.on('data', (c) => (out += c));
    const timer = setTimeout(() => proc.kill(), 120_000);
    proc.stdin.end(
      `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'update MR 7 description' } })}\n`,
    );
    proc.on('close', () => {
      clearTimeout(timer);
      resolve(out);
    });
  });
  stub.close();
  if (process.env.MR_ECHO_DEBUG) console.log(`[${label}] ${output.slice(-1500)}`);
  return stub.state.result ?? '';
}

async function main() {
  const exe = resolveClaude();
  if (!exe) throw new Error('claude не найден: задайте CLAUDE_CLI');
  const work = mkdtempSync(join(workBase(), 'agentdeck-mr-echo-'));
  const hook = GLOBAL ? GLOBAL_RUN : KIT_RUN;
  console.log(`CLI: ${exe}\nХук: ${hook}\n`);
  try {
    const bare = await runOnce(exe, work, 'bare', { hook: null, child: true });
    check(
      bare.length > 15_000 && bare.includes('Описание MR.'),
      `без хука модель видит эхо целиком (${bare.length} знаков) — стаб правда шлёт большое эхо`,
    );
    const group = await runOnce(exe, work, 'group', { hook, child: true });
    if (process.env.MR_ECHO_DEBUG) console.log(`[group result] ${group}`);
    check(
      group.length > 0 && group.length < 1_200,
      `звено группы: эхо обрезано (${group.length} знаков)`,
    );
    check(
      group.includes('merge_requests/7') && group.includes('"iid":7'),
      'звено группы: ссылка и номер MR на месте',
    );
    check(
      group.includes(`"description_chars":${DESCRIPTION.length}`) &&
        !group.includes('Описание MR.'),
      'звено группы: вместо описания — его длина',
    );
    const human = await runOnce(exe, work, 'human', { hook, child: false });
    check(human.length > 15_000, `сессия человека: эхо целиком (${human.length} знаков)`);
  } finally {
    rmSync(work, { recursive: true, force: true, maxRetries: 5 });
  }
  console.log(bad ? `\nНЕ ПРОШЛО: ${bad}` : '\nвсё прошло');
  process.exit(bad ? 1 : 0);
}

await main();
