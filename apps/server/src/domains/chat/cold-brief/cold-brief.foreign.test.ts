import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { coldBriefFacts } from './cold-brief.ts';

/**
 * Вводная для группы чужого CLI (план экономии, пакет W): итог прежней стадии
 * читает решатель по переписке CLI и отдаёт четвёртым аргументом; путь Claude
 * (без него) читает транскрипт Claude, как прежде.
 */
describe('coldBriefFacts (foreign read)', () => {
  let dir: string;
  let transcript: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cold-brief-foreign-'));
    mkdirSync(join(dir, '.agent'));
    writeFileSync(join(dir, '.agent', 'PROGRESS.md'), 'done: 1; left: 2\n');
    transcript = join(dir, 's.jsonl');
    const answer = (text: string) =>
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
    writeFileSync(transcript, [answer('Ответ Claude.'), '{"type":"user"}'].join('\n'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('claude lastAnswer unchanged', () => {
    const facts = coldBriefFacts(dir, transcript);
    expect(facts).toContain('## Your last answer in the previous conversation\nОтвет Claude.');
    expect(facts).toContain('done: 1; left: 2');
  });

  it('a foreign read replaces the Claude transcript reading', () => {
    const facts = coldBriefFacts(dir, transcript, undefined, { lastAnswer: 'Qwen: tests pass.' });
    expect(facts).toContain('## Your last answer in the previous conversation\nQwen: tests pass.');
    expect(facts).not.toContain('Ответ Claude.');
    // Чужая переписка — не транскрипт Claude: пустое чтение не подставляет его.
    const empty = coldBriefFacts(dir, transcript, undefined, {});
    expect(empty).not.toContain('## Your last answer');
    expect(empty).not.toContain('## Your question still open');
    expect(empty).toContain('done: 1; left: 2');
  });
});
