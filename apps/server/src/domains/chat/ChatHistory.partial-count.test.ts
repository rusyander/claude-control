import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readChats } from './ChatHistory.ts';

/**
 * Список чатов читает большой транскрипт началом и хвостом — полный проход по
 * стомегабайтному файлу ради одной строки списка стоил бы секунд. Значит число
 * сообщений у такого чата НЕПОЛНОЕ, и выдавать его итогом нельзя: в панели
 * стояло «38 сообщений» у разговора на сотни ходов. Теперь неполнота — признак,
 * а интерфейс рисует «38+».
 */
describe('readChats — счётчик сообщений не врёт на больших транскриптах', () => {
  let projectsDir: string;

  beforeEach(() => {
    projectsDir = mkdtempSync(join(tmpdir(), 'cc-chat-count-'));
  });

  afterEach(() => {
    rmSync(projectsDir, { recursive: true, force: true });
  });

  /** Транскрипт из N реплик; `padBytes` раздувает каждую до нужного размера файла. */
  function writeDialog(session: string, count: number, padBytes = 0): void {
    const dir = join(projectsDir, 'proj');
    mkdirSync(dir, { recursive: true });
    const lines: string[] = [];
    for (let i = 0; i < count; i += 1) {
      lines.push(
        JSON.stringify({
          type: i % 2 === 0 ? 'user' : 'assistant',
          uuid: `u${i}`,
          cwd: 'C:/work/app',
          timestamp: `2026-07-18T10:00:${String(i % 60).padStart(2, '0')}.000Z`,
          message: {
            role: i % 2 === 0 ? 'user' : 'assistant',
            content: `m${i}${'я'.repeat(padBytes)}`,
          },
        }),
      );
    }
    writeFileSync(join(dir, `${session}.jsonl`), `${lines.join('\n')}\n`);
  }

  it('маленький транскрипт сосчитан целиком — признака неполноты нет', () => {
    writeDialog('small', 6);

    const chat = readChats(projectsDir).find((item) => item.id === 'small');

    expect(chat?.messageCount).toBe(6);
    expect(chat?.messageCountPartial).toBeUndefined();
  });

  it('транскрипт больше 4 МБ помечен как сосчитанный не полностью', () => {
    // 900 реплик по ~10 КБ — заведомо больше предела полного чтения.
    writeDialog('big', 900, 5000);

    const chat = readChats(projectsDir).find((item) => item.id === 'big');

    expect(chat?.messageCountPartial).toBe(true);
    // Число осталось нижней оценкой: часть реплик середины в него не попала.
    expect(chat?.messageCount).toBeGreaterThan(0);
    expect(chat?.messageCount).toBeLessThan(900);
  });
});
