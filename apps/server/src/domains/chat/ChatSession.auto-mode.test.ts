import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ChatRunRegistry, type RunLike } from './ChatRunRegistry.ts';
import { ChatSession } from './ChatSession.ts';

/**
 * Выбор авторежима в чате (владелец, 24.09.2026) — настройка чата, а не след
 * прогона: переживает «Стоп» и перезапуск, едет в продолжение того же
 * разговора, но не в группу разделения — её ведут строки вкладки «Группы».
 */
const idle = (): RunLike => ({
  start: () => new Promise<void>(() => undefined),
  stop: () => undefined,
});

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cc-auto-mode-session-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('ChatSession: выбор авторежима в чате', () => {
  it('не выбирал — undefined: чат идёт за глобальной настройкой', () => {
    const session = new ChatSession(new ChatRunRegistry(idle), dir);
    expect(session.autoModeOverride('chat-1')).toBeUndefined();
  });

  it('щелчок тумблера переживает «Стоп» и перезапуск панели', () => {
    const session = new ChatSession(new ChatRunRegistry(idle), dir);
    session.toggleAutoApprove('chat-1', false);
    session.abort('chat-1');
    expect(session.autoModeOverride('chat-1')).toBe(false);

    const reborn = new ChatSession(new ChatRunRegistry(idle), dir);
    expect(reborn.autoModeOverride('chat-1')).toBe(false);
  });

  it('продолжение разговора наследует выбор, группа разделения — нет', () => {
    const session = new ChatSession(new ChatRunRegistry(idle), dir);
    session.toggleAutoApprove('chat-1', false);

    session.inherit(['chat-1'], 'next-1');
    session.inherit(['chat-1'], 'group-1', true);

    expect(session.autoModeOverride('next-1')).toBe(false);
    expect(session.autoModeOverride('group-1')).toBeUndefined();
  });
});
