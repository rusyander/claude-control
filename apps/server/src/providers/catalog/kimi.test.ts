import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { KIMI_READ_ONLY_AGENT, kimiProvider } from './kimi.ts';

const args = kimiProvider.assistant!.oneShotArgs!;

/** Список `tools:` из frontmatter профиля — тем же видом, что читает Kimi (YAML-список). */
function frontmatterTools(text: string): string[] {
  const head = /^---\n([\s\S]*?)\n---/.exec(text.replace(/\r\n/g, '\n'))?.[1] ?? '';
  const block = /^tools:\n((?: {2}- .+\n?)+)/m.exec(head)?.[1] ?? '';
  return block
    .split('\n')
    .map((row) => row.replace(/^ {2}- /, '').trim())
    .filter(Boolean);
}

describe('kimi: «Разрешить правки» в одиночном запуске (D2)', () => {
  it('правки выключены — профиль только для чтения перед `-p`', () => {
    expect(args('P', { allowEdits: false })).toEqual([
      '--agent-file',
      KIMI_READ_ONLY_AGENT,
      '-p',
      'P',
    ]);
  });

  it('правки включены или переключателя нет — argv прежний', () => {
    expect(args('P', { allowEdits: true })).toEqual(['-p', 'P']);
    expect(args('P', {})).toEqual(['-p', 'P']);
    expect(args('P')).toEqual(['-p', 'P']);
  });

  it('профиль лежит рядом и даёт модели одни читающие инструменты', () => {
    expect(existsSync(KIMI_READ_ONLY_AGENT)).toBe(true);
    const text = readFileSync(KIMI_READ_ONLY_AGENT, 'utf8');
    expect(frontmatterTools(text)).toEqual(['Read', 'Glob', 'Grep', 'FetchURL']);
    // Системный промпт Kimi (AGENTS.md, скиллы, плагины) остаётся — профиль его оборачивает.
    expect(text).toContain('${base_prompt}');
    // `description` у профиля обязателен: без него `--agent-file` роняет запуск.
    expect(text).toMatch(/^description: \S/m);
  });

  it('stdout разбирается: оформление стенограммы снято', () => {
    const parser = kimiProvider.assistant!.parseStdout!();
    expect(parser.push('• ответ\n  дальше\n\n') + parser.end()).toBe('ответ\nдальше');
  });
});
