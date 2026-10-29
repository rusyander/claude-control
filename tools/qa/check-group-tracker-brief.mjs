/**
 * Живое доказательство 2.3 плана экономии: ответы записи в трекер свёрнуты хуком
 * на настоящем `claude`.
 *
 * Юнит-тесты видят хук в профиле и строку свёртки из функции; вопрос же в том,
 * что сделает с ними CLI: доедет ли `updatedToolOutput` хука из `--settings` до
 * модели вместо ответа MCP-сервера и не заменит ли этот `--settings` хуки
 * человека. Подменены модель (стаб вместо API Anthropic, который зовёт
 * инструменты трекера по очереди), сервер трекера (`mcp-tracker-stub.mjs`) и
 * панель за брокером прав (разрешает всё: её решение проверяет
 * `check-group-forge-ask.mjs`). Своё — всё остальное: набор серверов, флаги и
 * настройки строит настоящий `groupRunProfile`, хук — настоящий
 * `tools/tracker-brief-hook.mjs`, запросы прав идут настоящим брокером
 * (`permission-prompt-server.mjs`): трекер у группы под `ask` (19.10), без
 * брокера CLI в `-p` отказывает каждому вызову.
 *
 * Случаи:
 * - с хуком группы: ответ смены статуса и ответ комментария доходят до модели
 *   короткой строкой, чтение задачи — целиком; личный хук человека из его
 *   `settings.json` срабатывает рядом (хуки складываются, не заменяются);
 * - тот же разговор без хука: оба ответа доходят целиком (проба видит то, что
 *   меряет).
 *
 * Запуск: `node tools/qa/check-group-tracker-brief.mjs`. Нужен установленный
 * `claude` (путь — `CLAUDE_CLI`); стенд и настройки человека не трогаются.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { startStubModel } from '../../packages/stub-model/src/index.mjs';

const PREFIX = 'cc-trackerbrief-';
const TOOLS = fileURLToPath(new URL('..', import.meta.url));
const BROKER = join(
  TOOLS,
  '..',
  'apps',
  'server',
  'src',
  'domains',
  'chat',
  'permission-prompt-server.mjs',
);
/** Команда хука — так её собирает `runtime.ts`. */
const HOOK = `node "${join(TOOLS, 'tracker-brief-hook.mjs')}"`;
const COMMENT = 'Готово, проверено на стенде';
/** Порядок вызовов модели-стаба: по одному инструменту на ход, потом слово. */
const CALLS = [
  ['jira_transition_issue', { issue_key: 'PROJ-1', transition_id: '21' }],
  ['jira_add_comment', { issue_key: 'PROJ-1', body: COMMENT }],
  ['jira_get_issue', { issue_key: 'PROJ-1' }],
];

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
  // PUBLIC есть только на Windows; на Linux с TMPDIR под домом — `/tmp`.
  const pub = process.platform === 'win32' ? process.env.PUBLIC : '/tmp';
  if (pub && existsSync(pub)) return pub;
  throw new Error('нет каталога вне домашней папки: задайте PUBLIC');
}

/** Все `tool_result` разговора по имени инструмента, текстом. */
function toolResults(body) {
  const names = new Map();
  const results = new Map();
  for (const message of body.messages ?? []) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type === 'tool_use') names.set(block.id, block.name);
      if (block.type === 'tool_result') {
        const content = block.content;
        const text = Array.isArray(content)
          ? content.map((part) => part.text ?? '').join('')
          : String(content ?? '');
        results.set(names.get(block.tool_use_id)?.replace(/^.*__/, ''), text);
      }
    }
  }
  return results;
}

/** Стаб API: в разговоре с инструментами трекера зовёт их по очереди, иначе — слово. */
async function startStub() {
  const seen = [];
  const stub = await startStubModel({
    // Вне `/messages` (служебные пути CLI) — пустой JSON, как было у своего стаба.
    route: ({ path }) => (path.includes('/messages') ? undefined : { body: {} }),
    script: ({ request, info }) => {
      const tools = info.tools.map((tool) => tool.name);
      const main = tools.some((name) => /__jira_transition_issue$/.test(name));
      if (main) seen.push(request.body);
      const done = toolResults(request.body).size;
      const next = main ? CALLS[done] : undefined;
      const name = next && tools.find((tool) => tool.endsWith(`__${next[0]}`));
      return name ? { tool: { name, args: next[1], id: `toolu_tb${done}` } } : 'ok';
    },
  });
  return { url: stub.baseUrl, seen, close: () => stub.close() };
}

/** Панель за брокером прав: разрешает всё и помнит, о чём спросили. */
async function startPanel() {
  const asked = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      if (body.toolName) asked.push(body.toolName);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ behavior: 'allow', updatedInput: body.input }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}`, asked, close: () => server.close() };
}

async function main() {
  const exe = resolveClaude();
  if (!exe) throw new Error('claude не найден: задайте CLAUDE_CLI');
  const { groupRunProfile } =
    await import('../../apps/server/src/domains/chat/group-profile/group-profile.ts');
  const stub = await startStub();
  const panel = await startPanel();
  const work = mkdtempSync(join(workBase(), PREFIX));
  console.log(`CLI: ${exe}\nКаталог: ${work}\n`);
  const userHook = join(work, 'user-hook.mjs');
  writeFileSync(
    userHook,
    "import { appendFileSync, readFileSync } from 'node:fs';\n" +
      "const input = JSON.parse(readFileSync(0, 'utf8'));\n" +
      "appendFileSync(process.argv[2], input.tool_name + '\\n');\n",
  );

  /** Один ход группы с инструментами трекера; окружение и флаги — от профиля группы. */
  async function run(label, trackerHook) {
    const home = join(work, label, 'home');
    const project = join(work, label, 'proj');
    mkdirSync(home, { recursive: true });
    mkdirSync(project, { recursive: true });
    const userLog = join(work, label, 'user-hook.log');
    const userCommand = `node "${userHook}" "${userLog}"`;
    writeFileSync(
      join(home, 'settings.json'),
      JSON.stringify({
        hooks: {
          PostToolUse: [{ matcher: 'mcp__.*', hooks: [{ type: 'command', command: userCommand }] }],
        },
      }),
    );
    const profile = groupRunProfile({
      entries: [
        {
          id: 'jira',
          config: { command: process.execPath, args: [join(TOOLS, 'qa', 'mcp-tracker-stub.mjs')] },
        },
      ],
      tasksText: '',
      extra: [],
      ...(trackerHook ? { trackerHook } : {}),
    });
    const mcpFile = join(work, label, 'mcp.json');
    writeFileSync(mcpFile, JSON.stringify(profile.mcp.config));
    const settingsFile = join(work, label, 'settings.json');
    writeFileSync(settingsFile, JSON.stringify(profile.settings));
    // Брокер прав — своим `--mcp-config`, как у `ChatRunner`.
    const brokerFile = join(work, label, 'perm.json');
    writeFileSync(
      brokerFile,
      JSON.stringify({
        mcpServers: {
          'perm-guard': {
            command: process.execPath,
            args: [BROKER],
            env: { PERM_RUN_ID: `tb-${label}`, PERM_BASE_URL: panel.url, PERM_PROGRESS_MS: '0' },
          },
        },
      }),
    );
    const env = {
      ...process.env,
      ...profile.env,
      CLAUDE_CONFIG_DIR: home,
      ANTHROPIC_BASE_URL: stub.url,
      ANTHROPIC_AUTH_TOKEN: 'tb-stub',
      ANTHROPIC_API_KEY: 'tb-stub',
      ANTHROPIC_MODEL: 'claude-sonnet-4-5',
      DISABLE_AUTOUPDATER: '1',
      // Свежий CLI откладывает инструменты MCP за ToolSearch: инструментов трекера
      // в запросе нет, стаб не узнаёт главный разговор и отвечает словом — 0 из 7
      // (28.10). Под проверкой хук после вызова, не загрузка инструмента; как в
      // check-group-forge-ask.mjs.
      ENABLE_TOOL_SEARCH: 'false',
    };
    const args = [
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      ...profile.args,
      '--mcp-config',
      mcpFile,
      '--settings',
      settingsFile,
      '--mcp-config',
      brokerFile,
      '--permission-prompt-tool',
      'mcp__perm-guard__approve',
    ];
    const from = stub.seen.length;
    const askedFrom = panel.asked.length;
    const output = await new Promise((resolve) => {
      const child = spawn(exe, args, { cwd: project, env, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (chunk) => (out += chunk));
      child.stderr.on('data', (chunk) => (out += chunk));
      const timer = setTimeout(() => child.kill(), 120_000);
      const message = { role: 'user', content: 'move PROJ-1 on and comment' };
      child.stdin.end(`${JSON.stringify({ type: 'user', message })}\n`);
      child.on('close', () => {
        clearTimeout(timer);
        resolve(out);
      });
    });
    const requests = stub.seen.slice(from);
    // Ни одного запроса с инструментами — CLI не дошёл до модели: его слова и есть причина.
    if (requests.length === 0) console.log(`[${label}] CLI:\n${output.slice(-1500)}`);
    return {
      results: toolResults(requests.at(-1) ?? {}),
      userLog: existsSync(userLog) ? readFileSync(userLog, 'utf8') : '',
      asked: panel.asked.slice(askedFrom),
    };
  }

  const brief = await run('hook', HOOK);
  check(
    CALLS.every(([name]) => brief.asked.some((tool) => tool.endsWith(`__${name}`))),
    `вызовы трекера дошли до панели брокером прав (${brief.asked.join(', ')})`,
  );
  check(brief.results.size === 3, `с хуком: модель получила три ответа (${brief.results.size})`);
  const transition = brief.results.get('jira_transition_issue') ?? '';
  check(
    transition.includes('transitioned successfully') &&
      transition.includes('status: In Progress') &&
      transition.includes('Full issue: jira_get_issue PROJ-1') &&
      !transition.includes('TRANSDESC') &&
      transition.length < 300,
    `смена статуса — короткой строкой (${transition.length} зн.): ${transition.slice(0, 120)}`,
  );
  const comment = brief.results.get('jira_add_comment') ?? '';
  check(
    comment.includes('Comment 10001 saved on PROJ-1') && !comment.includes(COMMENT),
    `комментарий — строкой без эха текста (${comment.length} зн.)`,
  );
  check(
    (brief.results.get('jira_get_issue') ?? '').includes('GETDESC'),
    'чтение задачи доходит целиком',
  );
  check(
    brief.userLog.split('\n').filter(Boolean).length === 3,
    `личный хук человека сработал рядом на каждый вызов (${JSON.stringify(brief.userLog.trim())})`,
  );

  const plain = await run('no-hook', '');
  check(
    (plain.results.get('jira_transition_issue') ?? '').includes('TRANSDESC'),
    'без хука смена статуса доходит задачей целиком',
  );
  check(
    (plain.results.get('jira_add_comment') ?? '').includes(COMMENT),
    'без хука комментарий доходит эхом',
  );

  stub.close();
  panel.close();
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  console.log(bad ? `\nПровалов: ${bad}` : '\nВсё ок');
  process.exit(bad ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
