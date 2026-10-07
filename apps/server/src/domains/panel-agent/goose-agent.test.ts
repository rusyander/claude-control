import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { spawn as nodeSpawn } from 'node:child_process';
import { parse as parseYaml } from 'yaml';
import type { PanelAgentRunEvent } from '@agentdeck/contracts/panel-agent';
import {
  createGooseTranslator,
  gooseExtensionSpec,
  gooseSystemPromptFile,
  prepareGooseAgentRoot,
} from './goose-agent.ts';
import { startPanelAgentRun } from './runner.ts';

/**
 * Агент панели у Goose. Строки потока сняты с настоящего goose 1.53 на заглушке
 * модели (`tools/qa/check-panel-agent-goose.mjs`); там же живьём проверено, что
 * до модели доходит только переходник. Здесь — то, что живьём не покраснить:
 * сборка корня хода из конфига человека, шаблон промпта, перевод потока и
 * страховка от чужого инструмента (агенту их и так не объявляют).
 */

const BRIDGE = 'agentdeck-panel__';

const assistant = (content: object[]) => ({
  type: 'message',
  message: { id: 'c1', role: 'assistant', content },
});

describe('createGooseTranslator', () => {
  it('куски ответа — один текст перед вызовом, имя переходника — в форме Claude', () => {
    const translate = createGooseTranslator();
    const out = [
      assistant([{ type: 'text', text: 'Смотрю ' }]),
      assistant([{ type: 'text', text: 'страницу.' }]),
      assistant([
        {
          type: 'toolRequest',
          id: 'call_1',
          toolCall: { status: 'success', value: { name: `${BRIDGE}where_am_i`, arguments: {} } },
        },
      ]),
    ].flatMap(translate);
    expect(out).toEqual([
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Смотрю страницу.' }] } },
      {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'call_1', name: 'mcp__agentdeck-panel__where_am_i' }],
        },
      },
    ]);
  });

  it('итог вызова: успех — содержимое, таймаут CLI — его причина', () => {
    const translate = createGooseTranslator();
    const response = (toolResult: object) => ({
      type: 'message',
      message: { role: 'user', content: [{ type: 'toolResponse', id: 'call_1', toolResult }] },
    });
    expect(
      translate(
        response({ status: 'success', value: { content: [{ type: 'text', text: '/rules' }] } }),
      ),
    ).toEqual([
      {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call_1',
              is_error: false,
              content: '[{"type":"text","text":"/rules"}]',
            },
          ],
        },
      },
    ]);
    expect(
      translate(response({ status: 'error', error: '-32603: request timeout after PT300S' })),
    ).toEqual([
      {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call_1',
              is_error: true,
              content: '-32603: request timeout after PT300S',
            },
          ],
        },
      },
    ]);
  });

  it('конец хода: итог — последний текст; сбой — причина CLI', () => {
    const ok = createGooseTranslator();
    ok(assistant([{ type: 'text', text: 'Готово.' }]));
    expect(ok({ type: 'complete' })).toEqual([
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Готово.' }] } },
      { type: 'result', result: 'Готово.' },
    ]);
    expect(createGooseTranslator()({ type: 'error', error: 'Authentication failed' })).toEqual([
      { type: 'result', result: 'Authentication failed', is_error: true },
    ]);
  });
});

describe('gooseSystemPromptFile', () => {
  it('промпт — дословно: фигурные скобки и конец raw не ломают шаблон Goose', () => {
    expect(gooseSystemPromptFile('a {{ b }} {% c %}')).toBe(
      '{% raw %}a {{ b }} {% c %}{% endraw %}',
    );
    expect(gooseSystemPromptFile('x {% endraw %} y {%- endraw -%} z')).toBe(
      '{% raw %}x { % endraw % } y { % endraw % } z{% endraw %}',
    );
  });
});

describe('gooseExtensionSpec', () => {
  it('имя, переменные и команда — каждое слово в кавычках', () => {
    expect(
      gooseExtensionSpec({
        command: 'C:\\Program Files\\nodejs\\node.exe',
        args: ['C:/repo dir/tools/mcp/panel.mjs', '--conversation', 'c-1'],
        env: { AGENTDECK_URL: 'http://127.0.0.1:5178' },
      }),
    ).toBe(
      'agentdeck-panel:AGENTDECK_URL="http://127.0.0.1:5178" "C:\\\\Program Files\\\\nodejs\\\\node.exe" "C:/repo dir/tools/mcp/panel.mjs" "--conversation" "c-1"',
    );
  });
});

describe('prepareGooseAgentRoot', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-goose-root-test-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('из конфига человека — только скаляры; режим — auto; секреты и свои провайдеры — копиями', () => {
    const userConfigDir = join(root, 'user');
    mkdirSync(join(userConfigDir, 'custom_providers'), { recursive: true });
    writeFileSync(
      join(userConfigDir, 'config.yaml'),
      [
        'GOOSE_PROVIDER: openai',
        'GOOSE_MODEL: gpt-x',
        'OPENAI_HOST: http://h',
        'GOOSE_MODE: smart_approve',
        'GOOSE_TEMPERATURE: 0.2',
        'extensions:',
        '  usersrv: { type: stdio, cmd: x, enabled: true }',
        'plugins: [a]',
        '',
      ].join('\n'),
    );
    writeFileSync(join(userConfigDir, 'secrets.yaml'), 'OPENAI_API_KEY: k\n');
    writeFileSync(join(userConfigDir, 'custom_providers', 'mine.json'), '{}');
    const dir = join(root, 'run');
    mkdirSync(dir);
    const env = prepareGooseAgentRoot({
      dir,
      systemPromptText: 'AGENT PROMPT',
      userConfigDir,
      env: { OPENAI_API_KEY: 'from-env', OPENAI_BASE_PATH: 'v1/x', ANTHROPIC_API_KEY: 'no' },
    });

    expect(env).toEqual({
      OPENAI_API_KEY: 'from-env',
      OPENAI_BASE_PATH: 'v1/x',
      GOOSE_PATH_ROOT: join(dir, 'goose-root'),
      GOOSE_SYSTEM_PROMPT_FILE_PATH: join(dir, 'agent-system.md'),
      GOOSE_MODE: 'auto',
      CONTEXT_FILE_NAMES: '[".agentdeck-panel-no-hints"]',
      GOOSE_TELEMETRY_OFF: '1',
    });
    const config = parseYaml(
      readFileSync(join(dir, 'goose-root', 'config', 'config.yaml'), 'utf8'),
    );
    expect(config).toEqual({
      GOOSE_PROVIDER: 'openai',
      GOOSE_MODEL: 'gpt-x',
      OPENAI_HOST: 'http://h',
      GOOSE_TEMPERATURE: 0.2,
      GOOSE_MODE: 'auto',
      extensions: {},
    });
    expect(readFileSync(join(dir, 'goose-root', 'config', 'secrets.yaml'), 'utf8')).toBe(
      'OPENAI_API_KEY: k\n',
    );
    expect(existsSync(join(dir, 'goose-root', 'config', 'custom_providers', 'mine.json'))).toBe(
      true,
    );
    expect(readFileSync(join(dir, 'agent-system.md'), 'utf8')).toBe(
      '{% raw %}AGENT PROMPT{% endraw %}',
    );
  });

  it('провайдер из окружения сильнее конфига; конфига нет — корень всё равно собран', () => {
    const dir = join(root, 'run');
    mkdirSync(dir);
    const env = prepareGooseAgentRoot({
      dir,
      systemPromptText: 'p',
      userConfigDir: join(root, 'absent'),
      env: { GOOSE_PROVIDER: 'ollama', OLLAMA_HOST: 'http://o', OPENAI_API_KEY: 'no' },
    });
    expect(env.OLLAMA_HOST).toBe('http://o');
    expect(env.OPENAI_API_KEY).toBeUndefined();
    const config = parseYaml(
      readFileSync(join(dir, 'goose-root', 'config', 'config.yaml'), 'utf8'),
    );
    expect(config).toEqual({ GOOSE_MODE: 'auto', extensions: {} });
    expect(existsSync(join(dir, 'goose-root', 'config', 'secrets.yaml'))).toBe(false);
  });
});

function fakeCli(lines: object[], seen: { args?: string[] }) {
  return ((_command: string, args: string[]) => {
    seen.args = args;
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
    child.pid = 424245;
    child.kill = () => true;
    setImmediate(() => {
      for (const line of lines) child.stdout.write(`${JSON.stringify(line)}\n`);
      child.stdout.end();
      setImmediate(() => child.emit('close', 0));
    });
    return child;
  }) as unknown as typeof nodeSpawn;
}

describe('ход агента на Goose', () => {
  let userRoot: string;
  beforeEach(() => {
    // Каталог «человека» — временный: ход читает из него конфиг и копирует секреты.
    userRoot = mkdtempSync(join(tmpdir(), 'cc-goose-user-test-'));
    vi.stubEnv('APPDATA', userRoot);
    vi.stubEnv('HOME', userRoot);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(userRoot, { recursive: true, force: true });
  });

  async function run(lines: object[], images = false) {
    const events: PanelAgentRunEvent[] = [];
    const seen: { args?: string[] } = {};
    const handle = startPanelAgentRun({
      command: 'goose',
      dialect: 'goose',
      env: {},
      selfBaseUrl: 'http://127.0.0.1:1',
      conversationId: 'g1',
      context: { route: '/rules', title: 'Правила' },
      messages: [{ role: 'user', content: 'где я?' }],
      ...(images ? { images: [{ name: 'a.png', mediaType: 'image/png', base64: 'AA==' }] } : {}),
      onEvent: (event) => events.push(event),
      spawnImpl: fakeCli(lines, seen),
    });
    return { result: await handle.done, events, seen };
  }

  const toolRequest = (name: string) =>
    assistant([
      {
        type: 'toolRequest',
        id: 'call_1',
        toolCall: { status: 'success', value: { name, arguments: {} } },
      },
    ]);
  const toolResponse = {
    type: 'message',
    message: {
      role: 'user',
      content: [
        {
          type: 'toolResponse',
          id: 'call_1',
          toolResult: { status: 'success', value: { content: [{ type: 'text', text: 'x' }] } },
        },
      ],
    },
  };

  it('вызов переходника — обычный ход до ответа, без расширений человека', async () => {
    const { result, events, seen } = await run([
      toolRequest(`${BRIDGE}where_am_i`),
      toolResponse,
      assistant([{ type: 'text', text: 'Вы на странице правил.' }]),
      { type: 'complete' },
    ]);
    expect(result.ok).toBe(true);
    expect(result.reply).toBe('Вы на странице правил.');
    expect(events.some((event) => event.kind === 'tool' && event.name === 'where_am_i')).toBe(true);
    // На Windows ненайденный CLI идёт через обёртку cmd.exe — argv сверяем строкой.
    expect(seen.args?.join(' ')).toContain(
      'run --no-session --no-profile --output-format stream-json -i - --with-extension',
    );
  });

  it('вызов не переходника обрывает ход с причиной', async () => {
    const { result, events } = await run([
      toolRequest('developer__shell'),
      toolResponse,
      assistant([{ type: 'text', text: 'Выполнил команду.' }]),
      { type: 'complete' },
    ]);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('сверх переходника панели (developer__shell)');
    expect(events.some((event) => event.kind === 'tool')).toBe(false);
  });

  it('картинка — честный отказ до запуска CLI', async () => {
    const { result, seen } = await run([{ type: 'complete' }], true);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('не принимает картинки');
    expect(seen.args).toBeUndefined();
  });
});
