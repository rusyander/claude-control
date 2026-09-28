import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { storeAgentImageFiles } from './agent-files.ts';

const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const image = { name: '../снимок.png', mediaType: 'image/png' as const, base64: PNG };

describe('storeAgentImageFiles', () => {
  const roots: string[] = [];
  afterEach(() =>
    roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })),
  );
  const appData = (): string => {
    const root = mkdtempSync(join(tmpdir(), 'cc-agent-files-'));
    roots.push(root);
    return root;
  };

  it('файл под каталогом данных, имя из запроса в путь не попадает, байты те же', () => {
    const root = appData();
    const [file] = storeAgentImageFiles(root, [image], () => 'one');
    expect(file).toEqual({
      name: '../снимок.png',
      path: join(root, 'agent-images', 'one', 'image-1.png'),
    });
    expect(readFileSync(file!.path).equals(Buffer.from(PNG, 'base64'))).toBe(true);
  });

  // Ревью 28.09 (F-267): держались только последние 50 отправок — разговор
  // чужого CLI, продолженный после 50 других, терял свои картинки, хотя вся
  // история уходит агенту заново на каждом ходе. Теперь срок (7 дней), большой
  // потолок (500) и никогда — каталог, на который ссылается живой разговор.
  const DAY = 24 * 60 * 60 * 1000;
  const aged = (path: string, days: number): void => {
    const at = new Date(Date.now() - days * DAY);
    utimesSync(dirname(path), at, at);
  };

  it('свежие отправки не выбрасываются после 50-й', () => {
    const root = appData();
    let n = 0;
    const first = storeAgentImageFiles(root, [image], () => `d${n++}`)[0]!;
    aged(first.path, 1);
    for (let i = 0; i < 60; i += 1) storeAgentImageFiles(root, [image], () => `d${n++}`);
    expect(readdirSync(join(root, 'agent-images'))).toHaveLength(61);
    expect(existsSync(first.path)).toBe(true);
  });

  it('старше 7 дней — прочь, если на каталог не ссылается разговор', () => {
    const root = appData();
    const old = storeAgentImageFiles(root, [image], () => 'old')[0]!;
    const kept = storeAgentImageFiles(root, [image], () => 'kept')[0]!;
    aged(old.path, 8);
    aged(kept.path, 8);
    const asked: string[][] = [];
    storeAgentImageFiles(root, [image], () => 'new', {
      referenced: (names) => {
        asked.push([...names]);
        return new Set(names.filter((name) => name === 'kept'));
      },
    });
    expect(existsSync(old.path)).toBe(false);
    expect(existsSync(kept.path)).toBe(true);
    // Спрашивают только о кандидатах, а не о каждом каталоге.
    expect(asked).toEqual([['kept', 'old']]);
  });

  it('потолок 500 — лишние старейшие прочь, но не моложе суток и не упомянутые', () => {
    const root = appData();
    let n = 0;
    const made: string[] = [];
    for (let i = 0; i < 505; i += 1) {
      const file = storeAgentImageFiles(root, [image], () => `c${String(n++).padStart(3, '0')}`, {
        referenced: () => new Set(),
      })[0]!;
      made.push(file.path);
    }
    // Все — старше суток; самый старый упомянут разговором.
    made.forEach((path, index) => aged(path, 2 + (505 - index) / 1000));
    storeAgentImageFiles(root, [image], () => 'last', {
      referenced: (names) => new Set(names.filter((name) => name === 'c000')),
    });
    const left = readdirSync(join(root, 'agent-images'));
    expect(left).toHaveLength(501);
    expect(left).toContain('c000');
    expect(left).toContain('last');
    expect(left).not.toContain('c001');
  });
});
