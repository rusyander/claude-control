import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  CLAUDE_SWITCH_VARS,
  claudeSwitchEnv,
  claudeSwitchPicker,
  describeClaudeSwitch,
  switchClaudeOff,
  switchClaudeOn,
} from './claude-switch.ts';

/**
 * Переключатель пишет НАСТОЯЩИЙ формат settings.json Claude во временный файл и
 * читает его обратно: проверяется файл, а не вызовы записи.
 */

const dirs: string[] = [];
function settingsFile(content?: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'cc-claude-switch-'));
  dirs.push(dir);
  const path = join(dir, 'settings.json');
  if (content !== undefined) writeFileSync(path, JSON.stringify(content, null, 2));
  return path;
}
const read = (path: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const VARS = claudeSwitchEnv({
  baseUrl: 'http://127.0.0.1:11435/',
  model: 'qwen3.6:27b-coding',
  context: 131_072,
});

describe('Claude Code на локальной модели', () => {
  it('переменные: адрес без пути, все алиасы на модель, окно — окно сервера, ключ пуст', () => {
    expect(VARS).toEqual({
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:11435',
      ANTHROPIC_AUTH_TOKEN: 'ollama',
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_MODEL: 'qwen3.6:27b-coding',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'qwen3.6:27b-coding',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'qwen3.6:27b-coding',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'qwen3.6:27b-coding',
      ANTHROPIC_DEFAULT_FABLE_MODEL: 'qwen3.6:27b-coding',
      CLAUDE_CODE_SUBAGENT_MODEL: 'qwen3.6:27b-coding',
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: '131072',
    });
    expect(Object.keys(VARS)).toEqual([...CLAUDE_SWITCH_VARS]);
  });

  it('включение дописывает env, не трогая остального; выключение возвращает файл как был', () => {
    const before = {
      model: 'opus',
      autoCompactWindow: 300_000,
      env: { DISABLE_TELEMETRY: '1', ANTHROPIC_MODEL: 'claude-opus-5-5' },
      permissions: { allow: ['Bash(git status:*)'] },
    };
    const path = settingsFile(before);
    const record = switchClaudeOn({
      settingsPath: path,
      model: 'q',
      vars: VARS,
      current: undefined,
    });

    const on = read(path);
    expect(on.model).toBe('opus');
    expect(on.permissions).toEqual(before.permissions);
    expect(on.env).toEqual({ DISABLE_TELEMETRY: '1', ...VARS });
    expect(record.previous.ANTHROPIC_MODEL).toBe('claude-opus-5-5');
    expect(record.previous.ANTHROPIC_BASE_URL).toBeNull();

    const result = switchClaudeOff(record);
    expect(read(path)).toEqual(before);
    expect(result.kept).toEqual([]);
  });

  it('повторное включение (другая модель) помнит исходное «до», а не свою запись', () => {
    const path = settingsFile({ env: { ANTHROPIC_MODEL: 'claude-opus-5-5' } });
    const first = switchClaudeOn({
      settingsPath: path,
      model: 'a',
      vars: VARS,
      current: undefined,
    });
    const other = claudeSwitchEnv({
      baseUrl: 'http://127.0.0.1:11435',
      model: 'b',
      context: 65_536,
    });
    const second = switchClaudeOn({ settingsPath: path, model: 'b', vars: other, current: first });
    expect(second.previous.ANTHROPIC_MODEL).toBe('claude-opus-5-5');
    switchClaudeOff(second);
    expect(read(path)).toEqual({ env: { ANTHROPIC_MODEL: 'claude-opus-5-5' } });
  });

  it('переменную, сменённую руками после включения, выключение не трогает и называет', () => {
    const path = settingsFile({});
    const record = switchClaudeOn({
      settingsPath: path,
      model: 'q',
      vars: VARS,
      current: undefined,
    });
    const edited = read(path);
    (edited.env as Record<string, string>).ANTHROPIC_MODEL = 'my-own';
    writeFileSync(path, JSON.stringify(edited));

    expect(describeClaudeSwitch(record, path).drift).toEqual(['ANTHROPIC_MODEL']);
    const result = switchClaudeOff(record);
    expect(result.kept).toEqual(['ANTHROPIC_MODEL']);
    expect(read(path)).toEqual({ env: { ANTHROPIC_MODEL: 'my-own' } });
  });

  it('выбор модели показывает Qwen, а не Opus; выключение возвращает прежний выбор', () => {
    const own = { options: [{ model: 'sonnet', label: 'Мой Sonnet' }] };
    const path = settingsFile({ model: 'sonnet', modelPicker: own });
    const picker = claudeSwitchPicker({
      model: 'qwen3.6:27b-coding',
      title: 'Qwen3.6 27B Coding',
      baseUrl: 'http://127.0.0.1:11435/',
    });
    const first = switchClaudeOn({
      settingsPath: path,
      model: 'q',
      vars: VARS,
      picker,
      current: undefined,
    });
    expect(read(path).modelPicker).toEqual({
      options: [
        {
          model: 'qwen3.6:27b-coding',
          label: 'Qwen3.6 27B Coding',
          description: 'qwen3.6:27b-coding · 127.0.0.1:11435',
        },
      ],
      replaceBuiltInOptions: true,
    });
    // Повторное включение помнит исходный выбор человека, а не свою строку.
    const second = switchClaudeOn({
      settingsPath: path,
      model: 'q',
      vars: VARS,
      picker,
      current: first,
    });
    expect(second.picker?.previous).toEqual(own);
    switchClaudeOff(second);
    expect(read(path)).toEqual({ model: 'sonnet', modelPicker: own });
  });

  it('выбор модели, сменённый руками после включения, выключение оставляет и называет', () => {
    const path = settingsFile({});
    const picker = claudeSwitchPicker({
      model: 'q',
      title: 'Q',
      baseUrl: 'http://127.0.0.1:11435',
    });
    const record = switchClaudeOn({
      settingsPath: path,
      model: 'q',
      vars: VARS,
      picker,
      current: undefined,
    });
    const edited = read(path);
    edited.modelPicker = { options: [{ model: 'q', label: 'свой' }] };
    writeFileSync(path, JSON.stringify(edited));
    expect(describeClaudeSwitch(record, path).drift).toEqual(['modelPicker']);
    const result = switchClaudeOff(record);
    expect(result.kept).toEqual(['modelPicker']);
    expect(read(path)).toEqual({ modelPicker: { options: [{ model: 'q', label: 'свой' }] } });
  });

  it('файла не было — включение его заводит, выключение оставляет без env', () => {
    const path = settingsFile();
    const record = switchClaudeOn({
      settingsPath: path,
      model: 'q',
      vars: VARS,
      current: undefined,
    });
    expect(read(path).env).toEqual(VARS);
    switchClaudeOff(record);
    expect(read(path)).toEqual({});
  });

  it('испорченный settings.json — отказ с путём, файл не переписан', () => {
    const path = settingsFile();
    writeFileSync(path, '{ "model": "opus", ');
    expect(() =>
      switchClaudeOn({ settingsPath: path, model: 'q', vars: VARS, current: undefined }),
    ).toThrow(path);
    expect(readFileSync(path, 'utf8')).toBe('{ "model": "opus", ');
  });

  it('выключенный — пустое состояние с перечнем переменных и путём файла', () => {
    expect(describeClaudeSwitch(undefined, 'C:/x/settings.json')).toEqual({
      on: false,
      model: '',
      settingsPath: 'C:/x/settings.json',
      vars: [...CLAUDE_SWITCH_VARS],
      drift: [],
    });
  });
});
