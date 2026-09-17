import { describe, it, expect, afterEach } from 'vitest';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { PanelActionJournalEntry } from '@agentdeck/contracts/panel-agent';
import { agentJournalPath, appendAgentJournal, readAgentJournal } from './journal.ts';

const entry = (name: string): PanelActionJournalEntry => ({
  at: '2026-09-17T10:00:00.000Z',
  name,
  risk: 'read',
  outcome: 'done',
  decidedBy: 'auto',
  summary: name,
});

describe('agent journal', () => {
  const dirs: string[] = [];
  const fresh = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-agent-journal-'));
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('нет файла — пустой след', () => {
    expect(readAgentJournal(fresh())).toEqual([]);
  });

  it('дописывает строки, отдаёт свежие первыми, режет по limit, битые пропускает', () => {
    const dir = fresh();
    expect(appendAgentJournal(dir, entry('a'))).toBe(true);
    appendFileSync(agentJournalPath(dir), '{оборванная строка\n{"x":1}\n');
    appendAgentJournal(dir, entry('b'));
    appendAgentJournal(dir, entry('c'));

    expect(readAgentJournal(dir).map((row) => row.name)).toEqual(['c', 'b', 'a']);
    expect(readAgentJournal(dir, 2).map((row) => row.name)).toEqual(['c', 'b']);
    expect(readAgentJournal(dir, 0).map((row) => row.name)).toEqual(['c']);
  });

  it('сбой записи не бросает — действие уже случилось', () => {
    const dir = fresh();
    // Каталог данных — файл: писать внутрь нельзя.
    appendFileSync(join(dir, 'blocked'), 'x');
    expect(appendAgentJournal(join(dir, 'blocked'), entry('a'))).toBe(false);
  });
});
