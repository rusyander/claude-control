/**
 * Эхо записи MR в звене группы — у OpenCode (P-15): настоящий `opencode`, модель-заглушка
 * OpenAI `/chat/completions`, MCP-заглушка форджа и прослойка набора `variants/opencode`
 * (`tool.execute.after` → `hooks/lib/run.mjs post-any --cli=opencode`).
 *
 * У OpenCode нет командных хуков: подмена вывода — это прослойка, правящая объект вывода
 * `tool.execute.after`. Для инструмента MCP этот объект — сам ответ сервера `{content:[…]}`
 * (выпуск 1.18.35: текст для модели собирается из `content` ПОСЛЕ хука), а имя инструмента —
 * `<сервер>_<инструмент>`, без `mcp__`. Доказательство — СЛЕДУЮЩИЙ запрос к модели: в нём
 * сообщение `tool` таким, каким его увидела модель.
 *
 * Три прогона: без прослойки (эхо целиком — контроль: заглушка правда шлёт большое эхо), звено
 * группы (`AGENTDECK_SPLIT_CHILD=1`: эхо обрезано, ссылка MR на месте), сессия человека (эхо
 * целиком). Дом OpenCode и состояние набора — временные; настоящие `~/.config/opencode`,
 * `~/.claude` не пишутся — их снимок до и после сравнивается.
 *
 * Запуск: node tools/qa/check-mr-echo-trim-opencode.mjs. Нет `opencode` в STEER_CLI_DIR/PATH —
 * «не проверено», код 2.
 */
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findCli } from './foreign-cli.mjs';
import {
  REAL_HOME,
  REPO,
  diffRealProviderDirs,
  reporter,
  snapshotRealProviderDirs,
} from './throwaway-stand.mjs';
import { startStubModel } from '../../packages/stub-model/src/index.mjs';

const IS_WIN = process.platform === 'win32';
/**
 * Настоящие каталоги OpenCode — их прогон обязан оставить как были. `~/.claude` вне снимка: его
 * во время прогона пишут рабочая панель и сессии человека (живая проба 25.10 — `agentdeck/`,
 * `project-configs/`), а дом процесса OpenCode и набора — временный.
 */
const OPENCODE_DIRS = [
  join(REAL_HOME, '.config', 'opencode'),
  join(REAL_HOME, '.local', 'share', 'opencode'),
  join(REAL_HOME, '.local', 'state', 'opencode'),
];
const KIT = join(REPO, 'apps', 'server', 'assets', 'kit', 'agentdeck-kit');
const VARIANTS = join(REPO, 'apps', 'server', 'assets', 'kit', 'variants');
const DESCRIPTION = 'Описание MR. '.repeat(1_500); // ~21k знаков
const TOKEN = Math.random().toString(36).slice(2, 8);
const MARK = `QA-MR-ECHO-${TOKEN}`;
const TOOL = 'forge_update_merge_request';
const { check: report, failed } = reporter();
const check = (condition, name) => report(name, condition);

// MCP-заглушка форджа: один инструмент, ответ — MR целиком, как у GitLab.
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

/**
 * Заглушка модели: запрос с меткой и инструментом форджа без результата — вызов правки MR;
 * с результатом — запоминает его текст и отвечает текстом. Служебные запросы — текст.
 */
async function startStub() {
  const state = { result: null, called: false };
  const stub = await startStubModel({
    // Только chat/completions; прочее — 404, как у прежней заглушки.
    route: ({ path }) =>
      path.includes('chat/completions') ? undefined : { status: 404, body: {} },
    script: ({ request }) => {
      const { body } = request;
      const tools = (body.tools ?? []).map((tool) => tool.function?.name).filter(Boolean);
      const results = (body.messages ?? [])
        .filter((m) => m.role === 'tool')
        .map((m) =>
          typeof m.content === 'string'
            ? m.content
            : (Array.isArray(m.content) ? m.content : [])
                .map((part) => (typeof part?.text === 'string' ? part.text : ''))
                .join('\n'),
        );
      const main = request.raw.includes(MARK) && tools.includes(TOOL);
      if (main && results.length) state.result = results[results.length - 1];
      if (!main || results.length) return `STUB_DONE_${TOKEN}`;
      state.called = true;
      const args = { iid: '7', description: DESCRIPTION };
      return { tool: { name: TOOL, args, id: 'call_mr' } };
    },
  });
  return { port: stub.port, state, close: () => stub.close() };
}

/** Запуск CLI с таймаутом; дерево процессов снимается целиком (иначе CLI переживёт проверку). */
function run(file, args, { cwd, env, timeout = 120_000 }) {
  return new Promise((done) => {
    // PWD: OpenCode берёт каталог сессии из него (живая проба 24.10). `.cmd` запускает cmd.exe.
    const viaCmd = IS_WIN && /\.cmd$/i.test(file);
    const argv = viaCmd ? args.map((a) => (/[\s&|<>^]/.test(a) ? `"${a}"` : a)) : args;
    const child = spawn(viaCmd ? `"${file}"` : file, argv, {
      cwd,
      env: { ...env, PWD: cwd },
      windowsHide: true,
      shell: viaCmd,
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.stdin.end();
    const timer = setTimeout(() => {
      if (IS_WIN) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      else child.kill('SIGKILL');
    }, timeout);
    child.on('close', (code) => {
      clearTimeout(timer);
      done({ code, out });
    });
  });
}

/** Временный дом: все переменные дома указывают внутрь, модель — заглушка. */
function homeEnv(home, extra) {
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (/^(AGENTDECK_|CLAUDE_|ANTHROPIC_|OPENAI_|OPENCODE_)/i.test(key)) delete env[key];
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    XDG_CACHE_HOME: join(home, '.cache'),
    AGENTDECK_KIT_STATE: join(home, 'kit-state'),
    ...extra,
  };
}

async function runOnce(exe, root, label, { plugin, child }) {
  const dir = join(root, label);
  const home = join(dir, 'home');
  const project = join(dir, 'project');
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
  const kit = join(dir, 'kit');
  cpSync(KIT, kit, { recursive: true });
  cpSync(join(VARIANTS, 'opencode'), kit, { recursive: true });
  if (plugin) {
    const plugins = join(project, '.opencode', 'plugins');
    mkdirSync(plugins, { recursive: true });
    cpSync(
      join(VARIANTS, 'opencode', 'plugins', 'agentdeck-kit.js'),
      join(plugins, 'agentdeck-kit.js'),
    );
  }
  const stubFile = join(dir, 'forge-stub.mjs');
  writeFileSync(stubFile, MCP_STUB);
  const stub = await startStub();
  try {
    const config = join(dir, 'opencode.json');
    writeFileSync(
      config,
      JSON.stringify({
        $schema: 'https://opencode.ai/config.json',
        provider: {
          stub: {
            npm: '@ai-sdk/openai-compatible',
            name: 'stub',
            options: { baseURL: `http://127.0.0.1:${stub.port}/v1`, apiKey: 'x' },
            models: { 'stub-model': { name: 'stub', tool_call: true } },
          },
        },
        model: 'stub/stub-model',
        small_model: 'stub/stub-model',
        mcp: { forge: { type: 'local', command: [process.execPath, stubFile], enabled: true } },
      }),
    );
    const res = await run(exe, ['run', '--auto', `Update MR 7 description. ${MARK}`], {
      cwd: project,
      env: homeEnv(home, {
        OPENCODE_CONFIG: config,
        AGENTDECK_KIT_DIR: kit,
        AGENTDECK_SPLIT_CHILD: child ? '1' : '',
        AGENTDECK_HEAVY_QUEUE_DIR: '',
      }),
    });
    if (process.env.MR_ECHO_DEBUG)
      console.log(`[${label}] exit ${res.code}\n${res.out.slice(-1500)}`);
    return { called: stub.state.called, result: stub.state.result ?? '' };
  } finally {
    await stub.close();
  }
}

async function main() {
  const dir = findCli('opencode');
  if (!dir) {
    console.log('Не проверено: opencode не найден (STEER_CLI_DIR / PATH)');
    process.exit(2);
  }
  const cmd = join(dir, IS_WIN ? 'opencode.cmd' : 'opencode');
  const exe = existsSync(cmd) ? cmd : join(dir, 'opencode');
  const root = mkdtempSync(join(tmpdir(), 'agentdeck-mr-echo-oc-'));
  const before = snapshotRealProviderDirs({ dirs: OPENCODE_DIRS });
  console.log(`CLI: ${exe}\n`);
  try {
    const bare = await runOnce(exe, root, 'bare', { plugin: false, child: true });
    check(bare.called, 'без прослойки: модель позвала правку MR');
    check(
      bare.result.length > 15_000 && bare.result.includes('Описание MR.'),
      `без прослойки модель видит эхо целиком (${bare.result.length} знаков) — заглушка правда шлёт большое эхо`,
    );
    const group = await runOnce(exe, root, 'group', { plugin: true, child: true });
    if (process.env.MR_ECHO_DEBUG) console.log(`[group result] ${group.result.slice(0, 600)}`);
    check(group.called, 'звено группы: модель позвала правку MR');
    check(
      group.result.length > 0 && group.result.length < 1_200,
      `звено группы: эхо обрезано (${group.result.length} знаков)`,
    );
    check(
      group.result.includes('merge_requests/7') && group.result.includes('"iid":7'),
      'звено группы: ссылка и номер MR на месте',
    );
    check(
      group.result.includes(`"description_chars":${DESCRIPTION.length}`) &&
        !group.result.includes('Описание MR.'),
      'звено группы: вместо описания — его длина',
    );
    const human = await runOnce(exe, root, 'human', { plugin: true, child: false });
    check(
      human.result.length > 15_000,
      `сессия человека: эхо целиком (${human.result.length} знаков)`,
    );
    const changed = diffRealProviderDirs(before, snapshotRealProviderDirs({ dirs: OPENCODE_DIRS }));
    check(
      changed.length === 0,
      `настоящие каталоги CLI не тронуты${changed.length ? `: ${changed.map((c) => c.path).join(', ')}` : ''}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  }
  const bad = failed();
  console.log(bad ? `\nНЕ ПРОШЛО: ${bad}` : '\nвсё прошло');
  process.exit(bad ? 1 : 0);
}

await main();
