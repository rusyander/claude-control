import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { spawn as nodeSpawn } from 'node:child_process';
import type { PanelAgentRunEvent } from '@agentdeck/contracts/panel-agent';
import { createGeminiTranslator, prepareGeminiAgentHome } from './gemini-agent.ts';
import { startPanelAgentRun } from './runner.ts';

/**
 * Агент панели у Gemini CLI. Строки потока сняты с настоящего gemini 0.62 на
 * заглушке модели (`tools/qa/check-panel-agent-gemini.mjs`); там же живьём
 * проверено, что до модели доходит только переходник. Здесь — то, что живьём
 * не покраснить: перевод потока по кускам и страховка от чужого инструмента
 * (Policy Engine его и так не объявляет).
 */

const BRIDGE = 'mcp_agentdeck-panel_';

describe('createGeminiTranslator', () => {
  it('куски ответа — один текст перед вызовом, имя переходника — в форме Claude', () => {
    const translate = createGeminiTranslator();
    const out = [
      { type: 'init', session_id: 's' },
      { type: 'message', role: 'user', content: 'Где я?' },
      { type: 'message', role: 'assistant', content: 'Смотрю ', delta: true },
      { type: 'message', role: 'assistant', content: 'страницу.', delta: true },
      { type: 'tool_use', tool_name: `${BRIDGE}where_am_i`, tool_id: 't1', parameters: {} },
    ].flatMap(translate);
    expect(out).toEqual([
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Смотрю страницу.' }] } },
      {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 't1', name: 'mcp__agentdeck-panel__where_am_i' }],
        },
      },
    ]);
  });

  it('итог вызова: успех — вывод, отказ — причина из error.message', () => {
    const translate = createGeminiTranslator();
    expect(
      translate({ type: 'tool_result', tool_id: 't1', status: 'success', output: 'route /x' }),
    ).toEqual([
      {
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 't1', is_error: false, content: 'route /x' },
          ],
        },
      },
    ]);
    expect(
      translate({
        type: 'tool_result',
        tool_id: 't2',
        status: 'error',
        error: { message: 'Человек отклонил действие' },
      }),
    ).toEqual([
      {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 't2',
              is_error: true,
              content: 'Человек отклонил действие',
            },
          ],
        },
      },
    ]);
  });

  it('конец хода: итог — последний текст; сбой — причина CLI', () => {
    const ok = createGeminiTranslator();
    ok({ type: 'message', role: 'assistant', content: 'Готово.', delta: true });
    expect(ok({ type: 'result', status: 'success' })).toEqual([
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Готово.' }] } },
      { type: 'result', result: 'Готово.' },
    ]);

    const failed = createGeminiTranslator();
    failed({ type: 'error', severity: 'error', message: 'quota exceeded' });
    expect(failed({ type: 'result', status: 'error' })).toEqual([
      { type: 'result', result: 'quota exceeded', is_error: true },
    ]);
    expect(
      createGeminiTranslator()({ type: 'result', status: 'error', error: { message: 'no auth' } }),
    ).toEqual([{ type: 'result', result: 'no auth', is_error: true }]);
  });
});

describe('prepareGeminiAgentHome', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-gemini-home-test-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('дом хода: из настроек человека только вход и модель, его файлы входа — копиями', () => {
    const userDir = join(root, 'user', '.gemini');
    mkdirSync(userDir, { recursive: true });
    writeFileSync(
      join(userDir, 'settings.json'),
      JSON.stringify({
        security: { auth: { selectedType: 'oauth-personal' } },
        model: { name: 'gemini-2.5-pro' },
        mcpServers: { usersrv: { command: 'x' } },
        hooks: { SessionStart: [] },
      }),
    );
    writeFileSync(join(userDir, '.env'), 'GEMINI_API_KEY=k\n');
    writeFileSync(join(userDir, 'oauth_creds.json'), '{}');
    const dir = join(root, 'run');
    mkdirSync(dir);
    const env = prepareGeminiAgentHome({
      dir,
      userDir,
      systemPromptText: 'AGENT PROMPT',
      bridge: { command: 'node', args: ['panel.mjs'], env: { AGENTDECK_URL: 'http://x' } },
    });

    expect(env).toEqual({
      GEMINI_CLI_HOME: dir,
      GEMINI_CLI_TRUST_WORKSPACE: 'true',
      GEMINI_SYSTEM_MD: join(dir, 'agent-system.md'),
    });
    const settings = JSON.parse(readFileSync(join(dir, '.gemini', 'settings.json'), 'utf8'));
    expect(settings.security).toEqual({ auth: { selectedType: 'oauth-personal' } });
    expect(settings.model).toEqual({ name: 'gemini-2.5-pro' });
    expect(Object.keys(settings.mcpServers)).toEqual(['agentdeck-panel']);
    expect(settings.mcpServers['agentdeck-panel'].trust).toBe(true);
    expect(settings.hooks).toBeUndefined();
    expect(settings.hooksConfig).toEqual({ enabled: false });
    expect(settings.skills).toEqual({ enabled: false });
    const policy = readFileSync(join(dir, '.gemini', 'policies', 'agent.toml'), 'utf8');
    expect(policy).toMatch(/toolName = "\*"\ndecision = "deny"/);
    expect(policy).toMatch(/mcpName = "agentdeck-panel"\ndecision = "allow"/);
    expect(readFileSync(join(dir, '.gemini', '.env'), 'utf8')).toBe('GEMINI_API_KEY=k\n');
    expect(existsSync(join(dir, '.gemini', 'oauth_creds.json'))).toBe(true);
    expect(existsSync(join(dir, '.gemini', 'gemini-credentials.json'))).toBe(false);
    expect(readFileSync(join(dir, 'agent-system.md'), 'utf8')).toBe('AGENT PROMPT');
  });

  it('настроек человека нет или они не JSON — дом всё равно собран, вход из окружения', () => {
    const userDir = join(root, 'user', '.gemini');
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, 'settings.json'), '{ not json');
    const dir = join(root, 'run');
    mkdirSync(dir);
    prepareGeminiAgentHome({
      dir,
      userDir,
      systemPromptText: 'p',
      bridge: { command: 'node', args: [], env: {} },
    });
    const settings = JSON.parse(readFileSync(join(dir, '.gemini', 'settings.json'), 'utf8'));
    expect(settings.security).toBeUndefined();
    expect(Object.keys(settings.mcpServers)).toEqual(['agentdeck-panel']);
  });
});

function fakeCli(lines: object[]): typeof nodeSpawn {
  return (() => {
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
    child.pid = 424243;
    child.kill = () => true;
    setImmediate(() => {
      for (const line of lines) child.stdout.write(`${JSON.stringify(line)}\n`);
      child.stdout.end();
      setImmediate(() => child.emit('close', 0));
    });
    return child;
  }) as unknown as typeof nodeSpawn;
}

describe('ход агента на Gemini CLI', () => {
  let userHome: string;
  beforeEach(() => {
    // Дом «человека» — временный: ход копирует из него файлы входа.
    userHome = mkdtempSync(join(tmpdir(), 'cc-gemini-user-test-'));
    vi.stubEnv('GEMINI_CLI_HOME', userHome);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(userHome, { recursive: true, force: true });
  });

  async function run(lines: object[], images = false) {
    const events: PanelAgentRunEvent[] = [];
    const handle = startPanelAgentRun({
      command: 'gemini',
      dialect: 'gemini',
      env: {},
      selfBaseUrl: 'http://127.0.0.1:1',
      conversationId: 'g1',
      context: { route: '/rules', title: 'Правила' },
      messages: [{ role: 'user', content: 'где я?' }],
      ...(images ? { images: [{ name: 'a.png', mediaType: 'image/png', base64: 'AA==' }] } : {}),
      onEvent: (event) => events.push(event),
      spawnImpl: fakeCli(lines),
    });
    return { result: await handle.done, events };
  }

  it('вызов переходника — обычный ход до ответа', async () => {
    const { result, events } = await run([
      { type: 'tool_use', tool_name: `${BRIDGE}where_am_i`, tool_id: 't1', parameters: {} },
      { type: 'tool_result', tool_id: 't1', status: 'success', output: '/rules' },
      { type: 'message', role: 'assistant', content: 'Вы на странице правил.', delta: true },
      { type: 'result', status: 'success' },
    ]);
    expect(result.ok).toBe(true);
    expect(result.reply).toBe('Вы на странице правил.');
    expect(events.some((event) => event.kind === 'tool' && event.name === 'where_am_i')).toBe(true);
  });

  it('вызов не переходника обрывает ход с причиной', async () => {
    const { result, events } = await run([
      { type: 'tool_use', tool_name: 'read_file', tool_id: 't1', parameters: { path: 'x' } },
      { type: 'tool_result', tool_id: 't1', status: 'success', output: 'secret' },
      { type: 'message', role: 'assistant', content: 'Прочитал файл.', delta: true },
      { type: 'result', status: 'success' },
    ]);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('сверх переходника панели (read_file)');
    expect(events.some((event) => event.kind === 'tool')).toBe(false);
  });

  it('картинка — честный отказ до запуска CLI', async () => {
    const { result } = await run([{ type: 'result', status: 'success' }], true);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('не принимает картинки');
  });
});
