import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { spawn as nodeSpawn } from 'node:child_process';
import { parse as parseToml } from 'smol-toml';
import type { PanelAgentRunEvent } from '@agentdeck/contracts/panel-agent';
import {
  KIMI_REQUEST_MAX_CHARS,
  createKimiTranslator,
  kimiAgentFile,
  kimiConversation,
  kimiPromptLiteral,
  prepareKimiAgentHome,
} from './kimi-agent.ts';
import { startPanelAgentRun } from './runner.ts';

/**
 * Агент панели у Kimi Code. Строки потока сняты с настоящего kimi 2.1.1 на
 * заглушке модели (`tools/qa/check-panel-agent-kimi.mjs`); там же живьём
 * проверено, что до модели доходят только переходник и наш промпт. Здесь — то,
 * что живьём не покраснить: сборка каталога хода из конфига человека, ссылка на
 * вход, шаблон тела, перевод потока и отказы до запуска.
 */

const BRIDGE_TOOL = 'mcp__agentdeck-panel__where_am_i';

/** Подстановка тела агента у Kimi 2.1.1 (`renderPrompt`): известные `${имя}` — значениями. */
function kimiRender(template: string, vars: Record<string, string>): string {
  return template.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name: string) =>
    typeof vars[name] === 'string' ? vars[name] : match,
  );
}

describe('createKimiTranslator', () => {
  it('текст и вызов одной строки — в форме Claude, итог — последний текст на конце хода', () => {
    const translate = createKimiTranslator();
    const out = [
      { role: 'meta', type: 'system.version', version: '2.1.1' },
      {
        role: 'assistant',
        content: 'Смотрю.',
        tool_calls: [{ type: 'function', id: 'call_1', function: { name: BRIDGE_TOOL } }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '/rules' },
      { role: 'assistant', content: 'Вы на странице правил.' },
      { role: 'meta', type: 'session.resume_hint', session_id: 's1' },
    ].flatMap(translate);
    expect(out).toEqual([
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Смотрю.' }] } },
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'call_1', name: BRIDGE_TOOL }] },
      },
      {
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'call_1', is_error: false, content: '/rules' },
          ],
        },
      },
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Вы на странице правил.' }] },
      },
      { type: 'result', result: 'Вы на странице правил.' },
    ]);
  });

  it('отказ вызова самим CLI (таймаут) — ошибка; ответ переходника — нет', () => {
    const translate = createKimiTranslator();
    const timedOut = `Tool "${BRIDGE_TOOL}" failed: MCP error -32001: Request timed out`;
    const [failed] = translate({ role: 'tool', tool_call_id: 'c', content: timedOut });
    const [plain] = translate({ role: 'tool', tool_call_id: 'c', content: 'Tool list: 3' });
    expect(failed?.message?.content?.[0]).toMatchObject({ is_error: true, content: timedOut });
    expect(plain?.message?.content?.[0]).toMatchObject({ is_error: false });
  });
});

describe('kimiPromptLiteral', () => {
  it('известная переменная Kimi в нашем тексте не подставляется, прочее — дословно', () => {
    const text = 'Путь ${cwd}, правила ${agents_md}; $x {y} ${ not} ${1a}';
    const rendered = kimiRender(kimiPromptLiteral(text), {
      cwd: 'C:/work',
      agents_md: 'PROJECT_AGENTS',
    });
    expect(rendered).not.toContain('PROJECT_AGENTS');
    expect(rendered).not.toContain('C:/work');
    expect(rendered.replace(/\u2060/g, '')).toBe(text);
  });
});

describe('kimiConversation', () => {
  it('первая реплика — только флагом; прежние и итоги действий — в контекст', () => {
    expect(kimiConversation([{ role: 'user', content: 'где я?' }])).toEqual({
      request: 'где я?',
      context: '',
    });
    const split = kimiConversation(
      [
        { role: 'user', content: 'покажи правила' },
        { role: 'assistant', content: 'Вот они.' },
        { role: 'user', content: 'открой первое' },
      ],
      ['list_rules: rules/a.md'],
    );
    expect(split.request).toBe('открой первое');
    expect(split.context).toContain('- list_rules: rules/a.md');
    expect(split.context).toContain('Human: покажи правила\n\nAssistant: Вот они.');
    expect(split.context).not.toContain('открой первое');
  });
});

describe('prepareKimiAgentHome', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-kimi-home-test-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const bridge = { command: 'node', args: ['panel.mjs'], env: { AGENTDECK_URL: 'http://x' } };

  it('из конфига человека — только модель; MCP — только переходник; вход — ссылкой', () => {
    const user = join(root, 'user');
    mkdirSync(join(user, 'credentials'), { recursive: true });
    writeFileSync(join(user, 'credentials', 'kimi-code.json'), '{"access_token":"t"}');
    writeFileSync(
      join(user, 'config.toml'),
      [
        'default_model = "k2"',
        'default_permission_mode = "ask"',
        'extra_skill_dirs = ["C:/skills"]',
        '[providers.moon]',
        'type = "kimi"',
        'api_key = "sk-user"',
        '[models.k2]',
        'provider = "moon"',
        'model = "kimi-k2"',
        '[thinking]',
        'enabled = true',
        '[mcp]',
        'tool_timeout_ms = 1000',
        '[[hooks]]',
        'event = "UserPromptSubmit"',
        'command = "echo hi"',
        '[[permission.rules]]',
        'decision = "allow"',
        'pattern = "Bash"',
        '',
      ].join('\n'),
    );
    const dir = join(root, 'run');
    const prepared = prepareKimiAgentHome({
      dir,
      bridge,
      systemPromptText: 'SYS ${agents_md}',
      context: 'Conversation so far: Human: ${cwd}',
      userHome: user,
      toolTimeoutMs: 660_000,
    });
    const home = prepared.env.KIMI_CODE_HOME!;
    expect(home.startsWith(dir)).toBe(true);
    expect(parseToml(readFileSync(join(home, 'config.toml'), 'utf8'))).toEqual({
      default_model: 'k2',
      providers: { moon: { type: 'kimi', api_key: 'sk-user' } },
      models: { k2: { provider: 'moon', model: 'kimi-k2' } },
      thinking: { enabled: true },
    });
    expect(JSON.parse(readFileSync(join(home, 'mcp.json'), 'utf8'))).toEqual({
      mcpServers: { 'agentdeck-panel': bridge },
    });
    expect(prepared.env.KIMI_MCP_TOOL_TIMEOUT_MS).toBe('660000');
    expect(readFileSync(join(home, 'credentials', 'kimi-code.json'), 'utf8')).toContain('"t"');

    // Обновлённый токен ложится в файл человека, а удаление папки хода его не трогает.
    writeFileSync(join(home, 'credentials', 'kimi-code.json'), '{"access_token":"t2"}');
    expect(readFileSync(join(user, 'credentials', 'kimi-code.json'), 'utf8')).toContain('t2');
    rmSync(dir, { recursive: true, force: true });
    expect(existsSync(join(user, 'credentials', 'kimi-code.json'))).toBe(true);
  });

  it('конфига и входа нет — каталог всё равно собран, модель — из окружения', () => {
    const dir = join(root, 'run');
    const prepared = prepareKimiAgentHome({
      dir,
      bridge,
      systemPromptText: 'SYS',
      context: '',
      userHome: join(root, 'absent'),
      toolTimeoutMs: 1,
    });
    expect(readFileSync(join(prepared.env.KIMI_CODE_HOME!, 'config.toml'), 'utf8').trim()).toBe('');
    expect(existsSync(join(prepared.env.KIMI_CODE_HOME!, 'credentials'))).toBe(false);
  });
});

describe('kimiAgentFile', () => {
  it('инструменты — только переходник, тело — наш промпт без промпта Kimi', () => {
    // Прежние реплики — тоже текст человека: `${cwd}` в них не подставляется.
    const file = kimiAgentFile('SYS ${agents_md}', 'CTX ${cwd}');
    const [, front, body] = file.split('---');
    expect(front).toContain('name: agentdeck-panel');
    expect(front).toContain('tools:\n  - "mcp__agentdeck-panel__*"');
    expect(body).not.toContain('${base_prompt}');
    const rendered = kimiRender(body!, { agents_md: 'LEAK_AGENTS', cwd: 'LEAK_CWD' });
    expect(rendered).not.toContain('LEAK');
    expect(rendered).toContain('CTX');
  });
});

function fakeCli(lines: object[], seen: { args?: string[]; stdin?: string; agentFile?: string }) {
  return ((_command: string, args: string[]) => {
    seen.args = args;
    // Через обёртку cmd.exe argv приходит одной строкой — путь берём из неё.
    const file = /--agent-file "?([^"\s]+)/.exec(args.join(' '))?.[1];
    if (file) seen.agentFile = readFileSync(file, 'utf8');
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      stdin: PassThrough;
      pid: number;
      kill: () => boolean;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    seen.stdin = '';
    child.stdin.on('data', (chunk: Buffer) => (seen.stdin += chunk.toString('utf8')));
    child.pid = 424246;
    child.kill = () => true;
    setImmediate(() => {
      for (const line of lines) child.stdout.write(`${JSON.stringify(line)}\n`);
      child.stdout.end();
      setImmediate(() => child.emit('close', 0));
    });
    return child;
  }) as unknown as typeof nodeSpawn;
}

describe('ход агента на Kimi Code', () => {
  let userRoot: string;
  beforeEach(() => {
    // Каталог «человека» — временный: ход читает из него только модель.
    userRoot = mkdtempSync(join(tmpdir(), 'cc-kimi-user-test-'));
    vi.stubEnv('KIMI_CODE_HOME', userRoot);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(userRoot, { recursive: true, force: true });
  });

  async function run(lines: object[], extra: { images?: boolean; content?: string } = {}) {
    const events: PanelAgentRunEvent[] = [];
    const seen: { args?: string[]; stdin?: string; agentFile?: string } = {};
    const handle = startPanelAgentRun({
      command: 'kimi',
      dialect: 'kimi',
      env: {},
      selfBaseUrl: 'http://127.0.0.1:1',
      conversationId: 'k1',
      context: { route: '/rules', title: 'Правила' },
      messages: [
        { role: 'user', content: 'покажи правила' },
        { role: 'assistant', content: 'Вот они.' },
        { role: 'user', content: extra.content ?? 'где я?' },
      ],
      ...(extra.images
        ? { images: [{ name: 'a.png', mediaType: 'image/png', base64: 'AA==' }] }
        : {}),
      onEvent: (event) => events.push(event),
      spawnImpl: fakeCli(lines, seen),
    });
    return { result: await handle.done, events, seen };
  }

  const call = (name: string) => ({
    role: 'assistant',
    tool_calls: [{ type: 'function', id: 'call_1', function: { name } }],
  });
  const done = { role: 'meta', type: 'session.resume_hint', session_id: 's' };

  it('вызов переходника — ход до ответа; реплика — флагом, прежние — в файле агента', async () => {
    const { result, events, seen } = await run([
      call(BRIDGE_TOOL),
      { role: 'tool', tool_call_id: 'call_1', content: '/rules' },
      { role: 'assistant', content: 'Вы на странице правил.' },
      done,
    ]);
    expect(result.ok).toBe(true);
    expect(result.reply).toBe('Вы на странице правил.');
    expect(events.some((event) => event.kind === 'tool' && event.name === 'where_am_i')).toBe(true);
    // На Windows ненайденный CLI идёт через обёртку cmd.exe — argv сверяем строкой.
    const args = seen.args!.join(' ');
    expect(args).toMatch(/-p "?где я\?"? --output-format stream-json --agent-file/);
    expect(args).not.toContain('--auto');
    expect(seen.stdin).toBe('');
    expect(seen.agentFile).toContain('Human: покажи правила');
    expect(seen.agentFile).not.toContain('где я?');
  });

  it('вызов не переходника обрывает ход с причиной', async () => {
    const { result, events } = await run([
      call('Bash'),
      { role: 'tool', tool_call_id: 'call_1', content: 'ok' },
      { role: 'assistant', content: 'Выполнил.' },
      done,
    ]);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('сверх переходника панели (Bash)');
    expect(events.some((event) => event.kind === 'tool')).toBe(false);
  });

  it('конца хода нет — ответа нет: выход без session.resume_hint — сбой', async () => {
    const { result } = await run([{ role: 'assistant', content: 'PART' }]);
    expect(result.ok).toBe(false);
  });

  it('картинка и длинная реплика — честный отказ до запуска CLI', async () => {
    const image = await run([done], { images: true });
    expect(image.result.error).toContain('не принимает картинки');
    expect(image.seen.args).toBeUndefined();
    const long = await run([done], { content: 'я'.repeat(KIMI_REQUEST_MAX_CHARS + 1) });
    expect(long.result.error).toContain(`длиннее ${KIMI_REQUEST_MAX_CHARS} знаков`);
    expect(long.seen.args).toBeUndefined();
    const edge = await run([{ role: 'assistant', content: 'ok' }, done], {
      content: 'я'.repeat(KIMI_REQUEST_MAX_CHARS),
    });
    expect(edge.result.ok).toBe(true);
  });
});
