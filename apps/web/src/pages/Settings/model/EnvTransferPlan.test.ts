import { describe, it, expect } from 'vitest';
import type {
  EnvTransferPlanEntry,
  EnvTransferEntryStatus,
  EnvTransferPromptEntry,
} from '../EnvTransfer.types';
import {
  defaultPlatformSelection,
  defaultPromptSelection,
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

  it('контур, уже настроенный здесь, по умолчанию НЕ перезаписывается', () => {
    const entries = [
      { id: 'новый', status: 'new' as const },
      { id: 'такой-же', status: 'same' as const },
      { id: 'другой', status: 'differs' as const },
    ].map((item) => ({
      ...item,
      title: item.id,
      driver: 'enterprise-platform',
      baseUrl: 'https://api.example.ru',
      hasToken: false,
      notes: [],
    }));

    expect(defaultPlatformSelection(entries)).toEqual(['новый']);
  });

  describe('промпты (ревью Т4, MINOR-4)', () => {
    const prompt = (
      id: string,
      status: 'new' | 'same' | 'differs',
      unknown = false,
    ): EnvTransferPromptEntry => ({ id, status, bytes: 10, unknown });

    it('отмечена только новая правка: свою перезаписывает человек сам', () => {
      expect(
        defaultPromptSelection([
          prompt('image', 'new'),
          prompt('presentation', 'differs'),
          prompt('tool-protocol', 'same'),
        ]),
      ).toEqual(['image']);
    });

    it('промпт, которого эта панель не знает, не отмечается даже новым', () => {
      // Записать такую правку некуда: отмеченная, она молча пропала бы при развороте.
      expect(defaultPromptSelection([prompt('из-будущего', 'new', true)])).toEqual([]);
    });

    it('пустой план — пустой выбор', () => {
      expect(defaultPromptSelection([])).toEqual([]);
    });
  });

  it('размер архива показывается по-человечески', () => {
    expect(formatArchiveSize(512)).toBe('512 Б');
    expect(formatArchiveSize(2048)).toBe('2.0 КБ');
    expect(formatArchiveSize(5 * 1024 * 1024)).toBe('5.0 МБ');
  });
});
