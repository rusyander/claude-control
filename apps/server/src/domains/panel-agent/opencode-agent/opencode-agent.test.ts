import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { spawn as nodeSpawn } from 'node:child_process';
import type { PanelAgentRunEvent } from '@agentdeck/contracts/panel-agent';
import {
  createOpencodeTranslator,
  opencodePanelAgentArgs,
  prepareOpencodeAgentLayers,
} from './opencode-agent.ts';
import { startPanelAgentRun } from '../runner/runner.ts';

/**
 * Агент панели у OpenCode. Строки потока сняты с настоящего opencode 1.18 на
 * заглушке модели (`tools/qa/check-panel-agent-opencode.mjs`); там же живьём
 * проверено, что до модели доходит только переходник. Здесь — то, что живьём
 * не покраснить: сборка слоёв из конфигов человека, перевод потока и страховка
 * от чужого инструмента (агенту их и так не объявляют).
 */

const BRIDGE = 'agentdeck-panel_';

describe('createOpencodeTranslator', () => {
  it('вызов переходника: и вызов, и его итог — в форме Claude', () => {
    const translate = createOpencodeTranslator();
    expect(
      translate({
        type: 'tool_use',
        part: {
          tool: `${BRIDGE}where_am_i`,
          callID: 'c1',
          state: { status: 'completed', output: { route: '/rules' } },
        },
      }),
    ).toEqual([
      {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'c1', name: 'mcp__agentdeck-panel__where_am_i' }],
        },
      },
      {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'c1',
              is_error: false,
              content: '{"route":"/rules"}',
            },
          ],
        },
      },
    ]);
    const failed = translate({
      type: 'tool_use',
      part: {
        tool: `${BRIDGE}navigate`,
        callID: 'c2',
        state: { status: 'error', error: 'Человек отклонил действие' },
      },
    });
    expect(failed[1]).toEqual({
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'c2',
            is_error: true,
            content: 'Человек отклонил действие',
          },
        ],
      },
    });
  });

  it('конец хода только на stop: итог — последний текст; сбой — причина CLI', () => {
    const translate = createOpencodeTranslator();
    translate({ type: 'text', part: { text: 'Смотрю.' } });
    expect(translate({ type: 'step_finish', part: { reason: 'tool-calls' } })).toEqual([]);
    translate({ type: 'text', part: { text: 'Готово.' } });
    expect(translate({ type: 'step_finish', part: { reason: 'stop' } })).toEqual([
      { type: 'result', result: 'Готово.' },
    ]);
    expect(
      createOpencodeTranslator()({
        type: 'error',
        error: { name: 'APIError', data: { message: 'quota exceeded' } },
      }),
    ).toEqual([{ type: 'result', result: 'quota exceeded', is_error: true }]);
  });
});

describe('opencodePanelAgentArgs', () => {
  it('без внешних плагинов, агент панели, картинки — вложениями', () => {
    expect(opencodePanelAgentArgs(['a.png', 'b.png'])).toEqual([
      'run',
      '--pure',
      '--format',
      'json',
      '--agent',
      'agentdeck-panel',
      '-f',
      'a.png',
      '-f',
      'b.png',
    ]);
  });
});

describe('prepareOpencodeAgentLayers', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-opencode-layers-test-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const bridge = { command: 'node', args: ['panel.mjs'], env: { AGENTDECK_URL: 'http://x' } };

  it('из конфигов человека — только провайдеры и модель; вход — копией auth.json', () => {
    const userConfigDir = join(root, 'user-config');
    const userDataDir = join(root, 'user-data');
    mkdirSync(userConfigDir, { recursive: true });
    mkdirSync(userDataDir, { recursive: true });
    writeFileSync(
      join(userConfigDir, 'config.json'),
      JSON.stringify({ model: 'old/model', small_model: 'p/small' }),
    );
    writeFileSync(
      join(userConfigDir, 'opencode.json'),
      JSON.stringify({
        model: 'p/model',
        provider: { p: { options: { apiKey: '{env:P_KEY}', baseURL: '{env:P_URL}' } } },
        mcp: { usersrv: { type: 'local', command: ['x'] } },
        plugin: ['user-plugin'],
        instructions: ['USER.md'],
      }),
    );
    writeFileSync(join(userDataDir, 'auth.json'), '{"p":{"type":"api","key":"k"}}');
    const dir = join(root, 'run');
    mkdirSync(dir);
    const env = prepareOpencodeAgentLayers({
      dir,
      bridge,
      systemPromptText: 'AGENT PROMPT',
      userConfigDir,
      userDataDir,
      env: { P_KEY: 'secret', P_URL: 'http://p', UNRELATED: 'x' },
    });

    expect(env).toEqual({
      P_KEY: 'secret',
      P_URL: 'http://p',
      XDG_CONFIG_HOME: join(dir, 'xdg-config'),
      XDG_DATA_HOME: join(dir, 'xdg-data'),
      XDG_STATE_HOME: join(dir, 'xdg-state'),
      OPENCODE_DISABLE_PROJECT_CONFIG: '1',
      OPENCODE_DISABLE_CLAUDE_CODE: '1',
      OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
      OPENCODE_DISABLE_AUTOUPDATE: '1',
      OPENCODE_DISABLE_SHARE: '1',
    });
    const config = JSON.parse(
      readFileSync(join(dir, 'xdg-config', 'opencode', 'opencode.json'), 'utf8'),
    );
    expect(config.model).toBe('p/model');
    expect(config.small_model).toBe('p/small');
    expect(config.provider.p.options.apiKey).toBe('{env:P_KEY}');
    expect(Object.keys(config.mcp)).toEqual(['agentdeck-panel']);
    expect(config.mcp['agentdeck-panel'].command).toEqual(['node', 'panel.mjs']);
    expect(config.mcp['agentdeck-panel'].environment).toEqual({ AGENTDECK_URL: 'http://x' });
    expect(config.plugin).toBeUndefined();
    expect(config.instructions).toBeUndefined();
    expect(config.agent['agentdeck-panel']).toEqual({
      mode: 'primary',
      prompt: 'AGENT PROMPT',
      tools: { '*': false, 'agentdeck-panel_*': true },
      permission: { '*': 'deny', 'agentdeck-panel_*': 'allow' },
    });
    expect(config.agent.title).toEqual({ disable: true });
    expect(readFileSync(join(dir, 'xdg-data', 'opencode', 'auth.json'), 'utf8')).toBe(
      '{"p":{"type":"api","key":"k"}}',
    );
  });

  it('OPENCODE_CONFIG человека перекрывает его каталог; битый файл и нет auth.json — не падает', () => {
    const userConfigDir = join(root, 'user-config');
    mkdirSync(userConfigDir, { recursive: true });
    writeFileSync(join(userConfigDir, 'opencode.json'), JSON.stringify({ model: 'dir/model' }));
    writeFileSync(join(userConfigDir, 'opencode.jsonc'), '{ not json');
    const custom = join(root, 'custom.json');
    writeFileSync(custom, JSON.stringify({ model: 'custom/model' }));
    const dir = join(root, 'run');
    mkdirSync(dir);
    prepareOpencodeAgentLayers({
      dir,
      bridge,
      systemPromptText: 'p',
      userConfigDir,
      userDataDir: join(root, 'absent'),
      env: { OPENCODE_CONFIG: custom },
    });
    const config = JSON.parse(
      readFileSync(join(dir, 'xdg-config', 'opencode', 'opencode.json'), 'utf8'),
    );
    expect(config.model).toBe('custom/model');
    expect(existsSync(join(dir, 'xdg-data', 'opencode', 'auth.json'))).toBe(false);
  });
});

function fakeCli(lines: object[], seen: { args?: string[]; env?: NodeJS.ProcessEnv }) {
  return ((_command: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
    seen.args = args;
    seen.env = options.env;
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
    child.pid = 424244;
    child.kill = () => true;
    setImmediate(() => {
      for (const line of lines) child.stdout.write(`${JSON.stringify(line)}\n`);
      child.stdout.end();
      setImmediate(() => child.emit('close', 0));
    });
    return child;
  }) as unknown as typeof nodeSpawn;
}

describe('ход агента на OpenCode', () => {
  let userRoot: string;
  beforeEach(() => {
    // Каталоги «человека» — временные: ход читает из них конфиг и копирует вход.
    userRoot = mkdtempSync(join(tmpdir(), 'cc-opencode-user-test-'));
    vi.stubEnv('XDG_CONFIG_HOME', join(userRoot, 'config'));
    vi.stubEnv('XDG_DATA_HOME', join(userRoot, 'data'));
    vi.stubEnv('OPENCODE_CONFIG', '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(userRoot, { recursive: true, force: true });
  });

  async function run(lines: object[], images = false) {
    const events: PanelAgentRunEvent[] = [];
    const seen: { args?: string[]; env?: NodeJS.ProcessEnv } = {};
    const handle = startPanelAgentRun({
      command: 'opencode',
      dialect: 'opencode',
      env: {},
      selfBaseUrl: 'http://127.0.0.1:1',
      conversationId: 'o1',
      context: { route: '/rules', title: 'Правила' },
      messages: [{ role: 'user', content: 'где я?' }],
      ...(images ? { images: [{ name: 'a.png', mediaType: 'image/png', base64: 'AA==' }] } : {}),
      onEvent: (event) => events.push(event),
      spawnImpl: fakeCli(lines, seen),
    });
    return { result: await handle.done, events, seen };
  }

  it('вызов переходника — обычный ход до ответа, слои хода — не каталоги человека', async () => {
    const { result, events, seen } = await run([
      {
        type: 'tool_use',
        part: {
          tool: `${BRIDGE}where_am_i`,
          callID: 'c1',
          state: { status: 'completed', output: '/rules' },
        },
      },
      { type: 'step_finish', part: { reason: 'tool-calls' } },
      { type: 'text', part: { text: 'Вы на странице правил.' } },
      { type: 'step_finish', part: { reason: 'stop' } },
    ]);
    expect(result.ok).toBe(true);
    expect(result.reply).toBe('Вы на странице правил.');
    expect(events.some((event) => event.kind === 'tool' && event.name === 'where_am_i')).toBe(true);
    // На Windows ненайденный CLI идёт через обёртку cmd.exe — argv сверяем строкой.
    expect(seen.args?.join(' ')).toContain('run --pure --format json --agent agentdeck-panel');
    expect(seen.env?.XDG_CONFIG_HOME).not.toBe(join(userRoot, 'config'));
    expect(seen.env?.OPENCODE_DISABLE_PROJECT_CONFIG).toBe('1');
  });

  it('вызов не переходника обрывает ход с причиной', async () => {
    const { result, events } = await run([
      {
        type: 'tool_use',
        part: { tool: 'read', callID: 'c1', state: { status: 'completed', output: 'secret' } },
      },
      { type: 'text', part: { text: 'Прочитал файл.' } },
      { type: 'step_finish', part: { reason: 'stop' } },
    ]);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('сверх переходника панели (read)');
    expect(events.some((event) => event.kind === 'tool')).toBe(false);
  });

  it('картинка — вложением -f, файлом в папке хода', async () => {
    const { result, seen } = await run(
      [
        { type: 'text', part: { text: 'Вижу.' } },
        { type: 'step_finish', part: { reason: 'stop' } },
      ],
      true,
    );
    expect(result.ok).toBe(true);
    expect(seen.args?.join(' ')).toMatch(/-f "?[^ ]*[\\/]images[\\/]image-1\.png/);
  });
});
