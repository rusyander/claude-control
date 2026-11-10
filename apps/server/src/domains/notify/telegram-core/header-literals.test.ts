import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Заголовки канала Telegram к ядру (этап 12, D29, P187): ядро примет команду как пир `telegram`
 * по `x-agentdeck-human-channel` + `x-agentdeck-telegram-owner`, поэтому ставить их может только
 * порт команд Telegram. Проверка по исходникам: строка заголовка живёт лишь в константе контрактов
 * и в порту, а константы в сервере читает только порт. Пересылка браузера (`core-proxy`) или любой
 * другой модуль с этой строкой — красное: так заголовок незаметно стал бы подделываемым.
 */

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..', '..');
const ROOTS = ['apps', 'packages', 'tools'];
const SKIP = new Set(['node_modules', 'dist', 'build', 'android', 'ios', '.expo', 'coverage']);
const CODE = /\.(?:ts|tsx|mts|cts|mjs|cjs|js)$/;
const LITERAL = /x-agentdeck-(?:human-channel|telegram-owner)/i;
const CONSTANT = /\b(?:HUMAN_CHANNEL_HEADER|TELEGRAM_OWNER_HEADER)\b/;

const CONTRACT = 'packages/contracts/src/core/telegram-channel.ts';
const PORT = 'apps/server/src/domains/notify/telegram-core/command-port.ts';
/** Тесты сверяют заголовки по значению и ничего не шлют — обе проверки их не судят. */
const TEST = /\.test\.(?:ts|tsx|mts|mjs)$/;

function walk(dir: string, out: string[]): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (CODE.test(entry.name)) out.push(relative(REPO, path).split(sep).join('/'));
  }
  return out;
}

const all = ROOTS.flatMap((root) => walk(join(REPO, root), []));
const files = all.filter((file) => !TEST.test(file));
const text = (file: string) => readFileSync(join(REPO, file), 'utf8');

describe('telegram channel headers: one sender', () => {
  it('scans the real tree (the port and the contracts constant are found)', () => {
    expect(files).toContain(CONTRACT);
    expect(files).toContain(PORT);
    expect(files.length).toBeGreaterThan(500);
    expect(all.length).toBeGreaterThan(files.length);
  });

  it('header literals live only in the contracts constant and the command port', () => {
    const allowed = new Set([CONTRACT, PORT]);
    expect(files.filter((file) => !allowed.has(file) && LITERAL.test(text(file)))).toEqual([]);
  });

  it('inside the panel server only the command port reads the header constants', () => {
    const server = files.filter((file) => file.startsWith('apps/server/'));
    const allowed = new Set([PORT]);
    expect(server.filter((file) => !allowed.has(file) && CONSTANT.test(text(file)))).toEqual([]);
  });
});
