import { describe, expect, it } from 'vitest';
import type { DiffNote } from './diffNotes.types';
import { changeChat, dropSent, notesOf, saveNote, withDraft } from './notesTray';

const a3: DiffNote = { path: 'a.ts', line: 3, text: 'x', note: 'первая' };
const b2: DiffNote = { path: 'b.ts', line: 2, text: 'y', note: 'вторая' };

describe('notesTray: лоток заметок до отправки (P172)', () => {
  it('новая заметка к той же строке заменяет прежнюю, а не добавляется второй', () => {
    const list = saveNote([a3, b2], { path: 'a.ts', line: 3, text: 'x' }, ' исправленная ');
    expect(list).toEqual([b2, { ...a3, note: 'исправленная' }]);
  });

  it('пустой текст убирает заметку строки', () => {
    expect(saveNote([a3, b2], a3, '   ')).toEqual([b2]);
  });

  it('после отправки снимаются только отправленные — дописанная во время отправки остаётся', () => {
    const later: DiffNote = { path: 'c.ts', line: 1, text: 'z', note: 'дописана позже' };
    const sent = [a3, b2];
    // Пока шла отправка, человек исправил a3 (новый объект) и дописал c.ts.
    const now = [...saveNote(sent, a3, 'исправлена позже'), later];
    expect(dropSent(now, sent)).toEqual([{ ...a3, note: 'исправлена позже' }, later]);
  });

  it('лоток свой у каждого разговора: правка одного не задевает другой', () => {
    const all = changeChat({ one: [a3] }, 'two', (list) => [...list, b2]);
    expect(notesOf(all, 'one')).toEqual([a3]);
    expect(notesOf(all, 'two')).toEqual([b2]);
    expect(notesOf(all, 'three')).toEqual([]);
  });

  it('черновик свой у каждого разговора: выбранная в одном чате строка не уезжает в другой', () => {
    const drafts = withDraft<string>({}, 'one', 'a.ts:3');
    expect(drafts.two).toBeUndefined();
    const both = withDraft(drafts, 'two', 'b.ts:2');
    expect(both).toEqual({ one: 'a.ts:3', two: 'b.ts:2' });
    expect(withDraft(both, 'one', undefined)).toEqual({ two: 'b.ts:2' });
  });
});
