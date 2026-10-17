import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SplitPlanView } from '@agentdeck/contracts/chat-handoff';
import { StatusChats, briefWithStatus } from './status-chats.ts';

/**
 * Лёгкие чаты вопросов о ходе групп (5.1): чат узнаётся под временным и под
 * настоящим ключом, после перезапуска, и получает сводку своего разделения.
 */
let root: string;
let file: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-status-chats-'));
  file = join(root, 'status-chats.json');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const SPLIT: SplitPlanView = {
  parentChatId: 'parent',
  order: [0],
  groups: [{ index: 0, title: 'Вход', branch: 'feature/a', after: [], status: 'started' }],
};

describe('StatusChats', () => {
  it('ключ из CLI узнаётся наравне с временным, и после перезапуска', () => {
    const chats = new StatusChats(file);
    chats.add('new-1-status', 'parent');
    chats.alias('new-1-status', 'sess-1');
    expect(chats.parentOf(['sess-1'])).toBe('parent');
    expect(new StatusChats(file).parentOf(['new-1-status'])).toBe('parent');
    expect(new StatusChats(file).parentOf(['sess-1'])).toBe('parent');
  });

  it('чужой разговор не становится лёгким чатом: ни ключом, ни переименованием', () => {
    const chats = new StatusChats(file);
    chats.alias('other', 'sess-x');
    expect(chats.parentOf(['other', 'sess-x'])).toBeUndefined();
  });

  it('помнит 200 последних', () => {
    const chats = new StatusChats(file);
    for (let i = 0; i < 205; i += 1) chats.add(`c-${i}`, 'parent');
    const saved = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(saved)).toHaveLength(200);
  });

  /** Ревью B1-F9: предел вытеснял чат, которым пользуются, — тот продолжался полным чатом. */
  it('ход освежает запись: под пределом остаётся чат, которым пользуются', () => {
    writeFileSync(
      file,
      JSON.stringify({ old: { parent: 'parent', at: '2020-01-01T00:00:00.000Z' } }),
    );
    const chats = new StatusChats(file);
    for (let i = 0; i < 150; i += 1) chats.add(`c-${i}`, 'parent');
    expect(chats.parentOf(['old'])).toBe('parent');
    for (let i = 150; i < 260; i += 1) chats.add(`c-${i}`, 'parent');
    expect(new StatusChats(file).parentOf(['old'])).toBe('parent');
  });

  it('незаведённый чат убирается, ключи прототипа чатом не считаются', () => {
    const chats = new StatusChats(file);
    chats.add('new-1-status', 'parent');
    chats.remove('new-1-status');
    expect(new StatusChats(file).parentOf(['new-1-status'])).toBeUndefined();
    expect(chats.parentOf(['__proto__', 'constructor'])).toBeUndefined();
    expect(chats.assignedOf('constructor')).toBeUndefined();
  });

  it('нет файла — пустой список, а не отказ', () => {
    const chats = new StatusChats(join(root, 'missing', 'x.json'));
    expect(chats.parentOf(['a'])).toBeUndefined();
  });
});

describe('briefWithStatus', () => {
  const view = (keys: readonly string[]) => (keys.includes('parent') ? SPLIT : undefined);
  const at = () => new Date('2026-10-17T10:00:00.000Z');

  it('родителю — его сводка, лёгкому чату — сводка наблюдателя, прочим — ничего', () => {
    const chats = new StatusChats(file);
    chats.add('new-1-status', 'parent');
    const brief = briefWithStatus(view, chats, at);
    expect(brief(['parent'])).toContain('agentdeck:tell');
    expect(brief(['new-1-status'])).toContain('You only observe');
    expect(brief(['new-1-status'])).toContain('1. "Вход"');
    expect(brief(['plain-chat'])).toBeUndefined();
  });
});
