import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { copyFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ChatMessage } from '@agentdeck/contracts';
import { readChatMessages } from '../ChatHistory/ChatHistory.ts';
import { hookNameOf } from './hook-trace.ts';

/**
 * След хода: хуки из служебных строк транскрипта садятся на шаг модели своего
 * хода. Фикстура повторяет формы строк CLI (замер 25.10.2026) с текстом-заглушкой.
 */
const FIXTURE = join(import.meta.dirname, '..', '__fixtures__', 'hook-trail.jsonl');

describe('hookNameOf — имя хука по команде', () => {
  it.each([
    ['"$HOME"/.claude/hooks/inject-project-rules.sh', 'inject-project-rules'],
    ['node "/home/user/tools/tests-hook.mjs" stop', 'tests-hook'],
    [
      'node --no-warnings "$HOME"/.claude/hooks/review-report-guard.mjs --stop',
      'review-report-guard',
    ],
    ['${CLAUDE_PLUGIN_ROOT}/scripts/on-stop.sh', 'on-stop'],
    ['FOO=1 python3 hooks/check.py', 'check'],
    ['bash ./hooks/verify-at-stop.sh', 'verify-at-stop'],
    ['', undefined],
  ])('%s → %s', (command, name) => {
    expect(hookNameOf(command)).toBe(name);
  });
});

describe('readChatMessages — хуки на шагах хода', () => {
  let projectsDir: string;
  let messages: ChatMessage[];

  beforeEach(async () => {
    projectsDir = mkdtempSync(join(tmpdir(), 'cc-hook-trail-'));
    mkdirSync(join(projectsDir, 'proj'));
    copyFileSync(FIXTURE, join(projectsDir, 'proj', 's1.jsonl'));
    messages = (await readChatMessages(projectsDir, 's1')).messages;
  });

  afterEach(() => {
    rmSync(projectsDir, { recursive: true, force: true });
  });

  const byId = (id: string): ChatMessage => {
    const found = messages.find((message) => message.id === id);
    if (!found) throw new Error(`нет сообщения ${id}`);
    return found;
  };

  it('строки хуков в ленту репликами не попадают', () => {
    expect(messages.map((message) => message.id)).toEqual([
      'u1',
      'a1',
      'a2',
      'x12',
      'a3',
      'a4',
      'u2',
      'u3',
      'a5',
    ]);
  });

  it('начало сессии и UserPromptSubmit ждут первый шаг хода', () => {
    expect(byId('u1').hooks).toBeUndefined();
    expect(byId('a1').hooks).toEqual([
      {
        event: 'SessionStart',
        hookName: 'SessionStart:startup',
        name: 'tests-hook',
        durationMs: 43,
        context: 'Заглушка: текст хука начала сессии',
      },
      { event: 'SessionStart', hookName: 'SessionStart', context: 'Заглушка: контекст ветки' },
      {
        event: 'UserPromptSubmit',
        hookName: 'UserPromptSubmit',
        context: 'Заглушка: самопроверка API_TOKEN=••••••',
      },
    ]);
  });

  it('PreToolUse и PostToolUse — на шаг вызова, остановка — с отметкой', () => {
    expect(byId('a2').hooks).toEqual([
      {
        event: 'PreToolUse',
        hookName: 'PreToolUse:Bash',
        name: 'block-git-mutations',
        durationMs: 31,
      },
      {
        event: 'PostToolUse',
        hookName: 'PostToolUse:Bash',
        name: 'inject-project-rules',
        durationMs: 500,
      },
      {
        event: 'PostToolUse',
        hookName: 'PostToolUse:Bash',
        name: 'inject-project-rules',
        durationMs: 600,
      },
      { event: 'PostToolUse', hookName: 'PostToolUse:Bash', name: 'lint-guard', blocked: true },
    ]);
  });

  it('слова человека посреди хода помечены и хук к ним уходит на следующий шаг', () => {
    expect(byId('x12')).toMatchObject({ role: 'user', midTurn: true });
    expect(byId('a3').hooks).toEqual([
      {
        event: 'UserPromptSubmit',
        hookName: 'UserPromptSubmit',
        context: 'Заглушка: контекст к словам посреди хода',
      },
    ]);
  });

  it('Stop — по итогу, без повтора строки hook_success; ветка субагента мимо', () => {
    expect(byId('a4').hooks).toEqual([
      { event: 'Stop', hookName: 'Stop', name: 'on-stop', durationMs: 300 },
      { event: 'Stop', hookName: 'Stop', name: 'tests-hook', durationMs: 100, blocked: true },
    ]);
    expect(messages.flatMap((message) => message.hooks ?? [])).not.toContainEqual(
      expect.objectContaining({ name: 'side' }),
    );
  });

  it('хук запроса, не дошедшего до модели, не уезжает в следующий ход', () => {
    expect(byId('u2').midTurn).toBeUndefined();
    expect(byId('a5').hooks).toEqual([
      { event: 'Stop', hookName: 'Stop', name: 'verify-at-stop', durationMs: 250, exitCode: 1 },
    ]);
  });
});
