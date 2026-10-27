/**
 * Вики трекера группы Codex (P-16) на НАСТОЯЩЕМ codex: имена `confluence_*` сервера
 * трекера сняты поимённо (`-c mcp_servers.<сервер>.disabled_tools=[…]`), имена задач
 * (`jira_*`) — на месте.
 *
 * Путь: серверы из `config.toml` Codex тем же чтением, что у панели
 * (`readProviderMcpServers`) → правило группы (`foreignGroupMcp`, поимённо) → значение
 * выключателя `{off, disabledTools}` (как его пишет `setMcpOff` в `runtime.ts`) →
 * `withCodexKit` → `spawnCliProcess` → `codex exec`. Сервер трекера — заглушка
 * `mcp-wiki-stub.mjs` (stdio, задачи и вики). Свидетель — список инструментов в теле
 * первого запроса к модели: ровно то, что Codex предложил модели.
 *
 * Сценарии:
 *   задачи о вики молчат → в теле нет ни одного `confluence_*`, `jira_*` есть; argv несёт
 *     `disabled_tools`; строка группе говорит о снятой вики;
 *   задача называет вики → правило ничего не снимает, `confluence_*` в теле есть
 *     (контроль: свидетель видит эти имена, когда их не сняли);
 *   шаблон `confluence_*` напрямую → Codex его НЕ понимает, имена на месте (поэтому
 *     список поимённый).
 *
 * Дом Codex — временный `CODEX_HOME`; `~/.codex`, `~/.claude` не трогаются. Подменена
 * только модель (сетевая граница). Нет codex — «не проверено», код 2.
 *
 * Запуск: [STEER_CLI_DIR=<каталог с codex>] node tools/qa/check-codex-wiki-off.mjs
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { killChildProcessTree } from '../../apps/server/src/lib/kill-tree.mjs';

const IS_WIN = process.platform === 'win32';
const server = (path) => new URL(`../../apps/server/src/${path}`, import.meta.url).href;
const { CODEX_MCP_OFF_ENV, withCodexKit } = await import(server('domains/kit/codex.ts'));
const { foreignGroupMcp } = await import(server('domains/chat/group-profile/group-profile.ts'));
const { readProviderMcpServers } = await import(server('domains/provider-mcp/section.ts'));
const { spawnCliProcess } = await import(server('lib/cli-spawn/cli-spawn.ts'));
const STUB = fileURLToPath(new URL('./mcp-wiki-stub.mjs', import.meta.url)).replace(/\\/g, '/');
const SERVER_ID = 'atlassian-x';

let bad = 0;
const check = (text, ok, detail) => {
  console.log(
    `  ${ok ? '✓' : '✗'} ${text}${!ok && detail ? ` — ${String(detail).slice(0, 600)}` : ''}`,
  );
  if (!ok) bad += 1;
  return ok;
};

function findCli(name) {
  const names = IS_WIN ? [`${name}.cmd`, `${name}.exe`, name] : [name];
  const dirs = [
    ...(process.env.STEER_CLI_DIR ? process.env.STEER_CLI_DIR.split(delimiter) : []),
    ...(process.env.PATH ?? process.env.Path ?? '').split(delimiter),
  ];
  return dirs.find((dir) => dir && names.some((file) => existsSync(join(dir, file))));
}

/** Заглушка OpenAI responses: имена инструментов первого запроса, ответ — «done». */
function startModel() {
  const seen = { tools: undefined };
  const srv = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      if (!/\/responses/.test(req.url ?? '')) return void res.writeHead(404).end();
      let body = {};
      try {
        body = JSON.parse(raw || '{}');
      } catch {
        // не JSON — инструментов не видно
      }
      // Инструменты MCP Codex кладёт пространством имён: `{name, tools: [...]}`.
      seen.tools ??= (body.tools ?? []).flatMap((tool) =>
        Array.isArray(tool.tools)
          ? tool.tools.map((inner) => `${tool.name}/${inner.name}`)
          : [tool.name ?? tool.type],
      );
      const item = {
        type: 'message',
        id: 'msg_1',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'done', annotations: [] }],
      };
      const resp = { id: 'resp_1', object: 'response', model: 'stub-model', output: [item] };
      const usage = {
        input_tokens: 10,
        output_tokens: 1,
        total_tokens: 11,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
      };
      const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      send('response.created', {
        type: 'response.created',
        response: { ...resp, status: 'in_progress', output: [] },
      });
      send('response.output_item.done', {
        type: 'response.output_item.done',
        output_index: 0,
        item,
      });
      send('response.completed', {
        type: 'response.completed',
        response: { ...resp, status: 'completed', usage },
      });
      res.end();
    });
  });
  return new Promise((resolve) =>
    srv.listen(0, '127.0.0.1', () => resolve({ srv, seen, port: srv.address().port })),
  );
}

async function removeLater(dir) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  console.log(`  (временный каталог не удалён: ${dir})`);
}

/**
 * Один прогон группы: задачи → правило над серверами конфига → `codex exec`.
 * `raw` — значение выключателя напрямую, мимо правила (сценарий шаблона).
 */
async function run(tasksText, raw) {
  const model = await startModel();
  const root = mkdtempSync(join(tmpdir(), 'cc-codex-wiki-'));
  const home = join(root, 'home');
  const work = join(root, 'work');
  mkdirSync(home, { recursive: true });
  mkdirSync(work, { recursive: true });
  const configFile = join(home, 'config.toml');
  writeFileSync(
    configFile,
    [
      'model_provider = "stub"',
      'model = "stub-model"',
      '[model_providers.stub]',
      'name = "stub"',
      `base_url = "http://127.0.0.1:${model.port}/v1"`,
      'wire_api = "responses"',
      'env_key = "STUB_KEY"',
      `[mcp_servers.${SERVER_ID}]`,
      'command = "node"',
      // Слово `atlassian` в аргументах — так панель узнаёт сервер трекера с вики.
      `args = [${JSON.stringify(STUB)}, "mcp-atlassian"]`,
      '',
    ].join('\n'),
  );
  // Серверы — тем же чтением, что `providerMcpEntries` в `runtime.ts`.
  const entries = readProviderMcpServers({ format: 'toml', filePath: configFile }).map((item) => ({
    id: item.name,
    config: { url: item.url, command: item.command, args: item.args },
  }));
  const mcp = foreignGroupMcp({ entries, tasksText, extra: [] }, true);
  const off = raw ?? JSON.stringify({ off: mcp.off, disabledTools: mcp.disabledTools ?? {} });
  const kit = withCodexKit(
    ['exec', '--skip-git-repo-check', '-'],
    { CODEX_HOME: home, STUB_KEY: 'x', [CODEX_MCP_OFF_ENV]: off },
    'exec',
  );
  const spawned = spawnCliProcess('codex', kit.args, {
    cwd: work,
    env: { ...(kit.env ?? {}), PWD: work },
  });
  if (spawned.error) {
    model.srv.close();
    await removeLater(root);
    return { mcp, args: kit.args, code: 'spawn', tools: [], log: spawned.error.message };
  }
  const { child } = spawned;
  child.stdin.end('say done');
  let log = '';
  child.stdout.on('data', (chunk) => (log += chunk));
  child.stderr.on('data', (chunk) => (log += chunk));
  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => (killChildProcessTree(child), resolve('timeout')), 120_000);
    child.on('exit', (exit) => (clearTimeout(timer), resolve(exit)));
  });
  model.srv.close();
  await removeLater(root);
  return { mcp, args: kit.args, code, tools: model.seen.tools ?? [], log: log.slice(-400) };
}

const cliDir = findCli('codex');
if (!cliDir) {
  console.log('НЕ ПРОВЕРЕНО: codex не найден (STEER_CLI_DIR или PATH)');
  process.exit(2);
}
process.env.PATH = `${cliDir}${delimiter}${process.env.PATH ?? ''}`;

const wikiOf = (tools) => tools.filter((name) => /\/confluence_/.test(name));
const jiraOf = (tools) => tools.filter((name) => /\/jira_/.test(name));

console.log('— задачи о вики молчат');
const silent = await run('PROJ-1 fix the export button');
check('прогон завершился', silent.code === 0, silent.log);
check(
  'правило сняло вики сервера трекера поимённо',
  silent.mcp.disabledTools?.[SERVER_ID]?.includes('confluence_search') === true,
  JSON.stringify(silent.mcp),
);
check(
  'argv: `-c mcp_servers.atlassian-x.disabled_tools=[…]`',
  silent.args.some((arg) => arg.startsWith(`mcp_servers.${SERVER_ID}.disabled_tools=[`)),
  silent.args.join(' '),
);
check('строка группе говорит о снятой вики', /Tracker wiki tools/.test(silent.mcp.note ?? ''));
check(
  'в теле запроса ни одного confluence_*',
  wikiOf(silent.tools).length === 0,
  silent.tools.join(','),
);
check('имена задач на месте', jiraOf(silent.tools).length === 2, silent.tools.join(','));

console.log('— задача называет вики (контроль)');
const wiki = await run('обновить страницу в Confluence');
check('прогон завершился', wiki.code === 0, wiki.log);
check('правило ничего не снимает', wiki.mcp.disabledTools === undefined, JSON.stringify(wiki.mcp));
check(
  'свидетель видит confluence_*, когда их не сняли (3 имени)',
  wikiOf(wiki.tools).length === 3 && jiraOf(wiki.tools).length === 2,
  wiki.tools.join(','),
);

console.log('— шаблон confluence_* напрямую');
const glob = await run(
  'PROJ-1',
  JSON.stringify({ off: [], disabledTools: { [SERVER_ID]: ['confluence_*'] } }),
);
check('прогон завершился', glob.code === 0, glob.log);
check(
  'Codex шаблонов не понимает — имена на месте (список поимённый не зря)',
  wikiOf(glob.tools).length === 3,
  glob.tools.join(','),
);

console.log(bad === 0 ? '\nOK' : `\nПРОВАЛОВ: ${bad}`);
process.exit(bad === 0 ? 0 : 1);
