import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { isServerMessageCode } from '@agentdeck/contracts/server-messages';
import { isPanelActionMessageCode } from '@agentdeck/contracts/panel-agent';

/**
 * Код текста, отданный сервером, обязан быть в списке контрактов — иначе панель
 * и телефон его не переведут и молча покажут русскую строку в английском
 * интерфейсе, то есть ровно то, от чего коды заведены.
 *
 * Тело ответа у Fastify не типизировано: `reply.send({ messageCode: 'опечатка' })`
 * tsc пропускает. Поэтому литералы сверяются по тексту исходников. Исходы
 * агента панели несут свои коды (`PANEL_ACTION_MESSAGE_CODES`, словарь окна
 * агента) — они тоже объявлены в контрактах и считаются здесь. Что код
 * переведён на оба языка, проверяют тесты словарей панели и телефона.
 */
const SRC = resolve(import.meta.dirname, '..');

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

describe('коды текстов сервера', () => {
  it('каждый `messageCode` в ответах сервера объявлен в contracts/server-messages', () => {
    const unknown: string[] = [];
    let seen = 0;
    for (const file of sources(SRC)) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/messageCode:\s*'([^']+)'/g)) {
        seen += 1;
        if (!isServerMessageCode(match[1]) && !isPanelActionMessageCode(match[1]))
          unknown.push(`${relative(SRC, file)}: ${match[1]}`);
      }
    }
    expect(seen).toBeGreaterThan(5);
    expect(unknown).toEqual([]);
  });
});
