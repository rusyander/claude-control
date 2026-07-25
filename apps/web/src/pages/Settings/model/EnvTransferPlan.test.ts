import { describe, it, expect } from 'vitest';
import type { EnvTransferPlanEntry, EnvTransferEntryStatus } from '../EnvTransfer.types';
import {
  defaultSelection,
  isAllSelected,
  selectableEntries,
  formatArchiveSize,
} from './EnvTransferPlan';

const entry = (name: string, status: EnvTransferEntryStatus): EnvTransferPlanEntry => ({
  archivePath: `files/loc-0/${name}`,
  relative: name,
  status,
  applyMode: 'file',
  bytes: 10,
  redactedKeys: [],
});

const PLAN = [
  entry('AGENTS.md', 'new'),
  entry('config.toml', 'differs'),
  entry('mcp.json', 'same'),
  entry('чужое.md', 'unresolved'),
];

describe('План разворота окружения', () => {
  it('по умолчанию отмечено только новое — перезапись выбирает человек', () => {
    expect(defaultSelection(PLAN)).toEqual(['files/loc-0/AGENTS.md']);
  });

  it('нерешённую запись отметить нельзя', () => {
    expect(selectableEntries(PLAN).map((item) => item.relative)).toEqual([
      'AGENTS.md',
      'config.toml',
      'mcp.json',
    ]);
  });

  it('«отмечено всё» считается по применимым записям, а не по всем', () => {
    const all = new Set(selectableEntries(PLAN).map((item) => item.archivePath));
    expect(isAllSelected(PLAN, all)).toBe(true);
    expect(isAllSelected(PLAN, new Set(defaultSelection(PLAN)))).toBe(false);
    // Пустой план не считается «отмеченным целиком»: отмечать нечего.
    expect(isAllSelected([], new Set())).toBe(false);
  });

  it('размер архива показывается по-человечески', () => {
    expect(formatArchiveSize(512)).toBe('512 Б');
    expect(formatArchiveSize(2048)).toBe('2.0 КБ');
    expect(formatArchiveSize(5 * 1024 * 1024)).toBe('5.0 МБ');
  });
});
