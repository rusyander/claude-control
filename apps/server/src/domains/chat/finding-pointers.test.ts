import { describe, it, expect } from 'vitest';
import {
  FINDING_POINTER_FILES,
  findingPointers,
  fixStagePrompt,
} from '@agentdeck/contracts/model-cascade';

/**
 * g5 25.10 (ревью P3, R34): холодная сессия правок перечитывала целиком файлы, диапазоны
 * которых ревью уже прочло, — 142 тыс. токенов переписанного окна. Задание правок теперь
 * называет места из карточек (`path:start-end`), сведённые по файлу.
 * Карточки — формы вердикта g5 (заголовок, «Где:», сокращённое имя рядом с полным путём).
 */

const G5_CARDS = [
  '🔴 1 **Константа поиска дублирована** — Где: inst-admin-ui/src/pages/Users/constants.tsx:98-106; ' +
    'и ещё inst-admin-ui/src/pages/Users/UsersList.tsx:41. В constants.tsx:104 — тот же литерал.',
  '🟡 2 **Нет теста на 255** — Где: inst-admin-ui/src/pages/Users/constants.tsx:12, ' +
    '`apps/api/handlers/users.go:210-230,260`; см. https://git.acme.local/a/b.ts:5',
  '❓ 3 **Зачем алиас?** — без места',
];

describe('указатели правок из карточек ревью (ревью P3)', () => {
  it('места сведены по файлу, диапазоны и перечни строк сохранены', () => {
    expect(findingPointers(G5_CARDS)).toEqual([
      '- inst-admin-ui/src/pages/Users/constants.tsx: 98-106, 12',
      '- inst-admin-ui/src/pages/Users/UsersList.tsx: 41',
      '- apps/api/handlers/users.go: 210-230, 260',
    ]);
  });

  it('голое имя файла и ссылка — не места; карточек без мест — пусто', () => {
    const pointers = findingPointers(G5_CARDS).join('\n');
    expect(pointers).not.toMatch(/^- constants\.tsx/m);
    expect(pointers).not.toContain('git.acme.local');
    expect(findingPointers(['❓ 3 без места', 'b.ts:3 — без каталога'])).toEqual([]);
  });

  it('указатель, а не опись: не больше FINDING_POINTER_FILES файлов', () => {
    const many = Array.from(
      { length: FINDING_POINTER_FILES + 5 },
      (_, i) => `src/f${i}.ts:${i + 1}`,
    );
    expect(findingPointers(many)).toHaveLength(FINDING_POINTER_FILES);
  });

  it('задание правок называет места после карточек и велит читать диапазоном', () => {
    const prompt = fixStagePrompt(G5_CARDS, { branch: 'split/g5' });
    const at = prompt.indexOf('Where the findings point');
    expect(at).toBeGreaterThan(prompt.indexOf('3. ❓ 3'));
    expect(prompt).toContain('open each with a ranged read around its lines (offset/limit)');
    expect(prompt).toContain('- inst-admin-ui/src/pages/Users/constants.tsx: 98-106, 12');
    expect(fixStagePrompt(['❓ без места'])).not.toContain('Where the findings point');
  });
});
