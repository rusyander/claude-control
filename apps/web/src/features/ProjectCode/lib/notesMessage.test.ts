import { describe, expect, it } from 'vitest';
import { notesMessage, noteKey, sortNotes } from './notesMessage';

const labels = { header: 'Заметки к правкам (3):', emptyLine: '(пустая строка)' };
// Добавлены вразнобой — так, как человек ходит по файлам.
const notes = [
  { path: 'src/b.ts', line: 2, text: 'const b = 2;', note: 'переименуй' },
  { path: 'src/a.ts', line: 9, text: '  return x;  ', note: ' верни копию ' },
  { path: 'src/a.ts', line: 3, text: '', note: 'здесь нужна проверка' },
];

describe('notesMessage: заметки к правкам одним сообщением (P172)', () => {
  it('блоки идут по файлу, потом по строке — не в порядке добавления', () => {
    expect(sortNotes(notes).map(noteKey)).toEqual(['src/a.ts:3', 'src/a.ts:9', 'src/b.ts:2']);
  });

  it('заголовок, затем на заметку блок «путь:строка», строка цитатой и сама заметка', () => {
    expect(notesMessage(notes, labels)).toBe(
      [
        'Заметки к правкам (3):',
        'src/a.ts:3\n> (пустая строка)\nздесь нужна проверка',
        'src/a.ts:9\n>   return x;\nверни копию',
        'src/b.ts:2\n> const b = 2;\nпереименуй',
      ].join('\n\n'),
    );
  });

  it('строки одного номера в разных файлах не сливаются', () => {
    const twin = [
      { path: 'x.ts', line: 1, text: 'x', note: 'n1' },
      { path: 'w.ts', line: 1, text: 'w', note: 'n2' },
    ];
    expect(sortNotes(twin).map(noteKey)).toEqual(['w.ts:1', 'x.ts:1']);
  });
});
