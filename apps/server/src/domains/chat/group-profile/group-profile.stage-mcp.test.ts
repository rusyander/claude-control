import { describe, it, expect } from 'vitest';
import { SPLIT_MCP_TAG } from '@agentdeck/contracts/split-tickets';
import {
  foreignGroupMcp,
  groupMcpProfile,
  groupRunProfile,
  STAGE_MCP_ROLES,
  stageMcpKind,
  type GroupProfileInput,
  type ProfileMcpEntry,
  type StageMcpKind,
} from './group-profile.ts';

/**
 * Набор MCP звена по его виду (N8, живая группа g8 26.10): правки и проверка правок
 * шли со всеми серверами проекта — 196 имён отложенных инструментов и 8,3 тыс.
 * знаков указаний в каждом ходе при нуле вызовов. Что CLI делает с набором
 * (`--strict-mcp-config` + свой `--mcp-config`), доказывает настоящий CLI
 * (`tools/qa/check-run-layers.mjs --stage-mcp`); здесь — какой набор звено получает.
 */

const ENTRIES: ProfileMcpEntry[] = [
  { id: 'gitlab-work', config: { command: 'npx', args: ['@zereight/mcp-gitlab'] } },
  { id: 'atlassian-work', config: { url: 'https://mcp.example.com/jira' } },
  { id: 'figma', config: { url: 'https://mcp.figma.com/mcp' } },
  { id: 'platform-local', config: { command: 'platform-mcp' } },
  { id: 'telegram', config: { command: 'telegram-mcp' } },
];

/** Задачи с макетом: тогда макеты едут везде, где таблица их пускает. */
const base = (patch: Partial<GroupProfileInput> = {}): GroupProfileInput => ({
  entries: ENTRIES,
  tasksText: 'PROJ-1 карточка по макету',
  extra: [],
  ...patch,
});

const FULL = ['gitlab-work', 'atlassian-work', 'figma', 'platform-local'];
const EXPECTED: Record<StageMcpKind, string[]> = {
  triage: FULL,
  plan: FULL,
  work: FULL,
  review: FULL,
  verify: [],
  fix: [],
  deliver: ['gitlab-work', 'atlassian-work'],
  push: ['gitlab-work', 'atlassian-work'],
};

const kept = (input: GroupProfileInput): string[] =>
  groupMcpProfile(input).kept.map((entry) => entry.id);

describe('набор MCP звена — одной таблицей по виду звена (N8)', () => {
  it('каждый вид звена получает ровно свой набор', () => {
    for (const kind of Object.keys(STAGE_MCP_ROLES) as StageMcpKind[]) {
      const input =
        kind === 'verify' ? base({ stage: 'review', verify: true }) : base({ stage: kind });
      expect(kept(input), kind).toEqual(EXPECTED[kind]);
    }
  });

  it('проход проверки — это звено ревью со списком правок; без отметки ревью идёт полным набором', () => {
    expect(stageMcpKind({ stage: 'review', verify: true })).toBe('verify');
    expect(stageMcpKind({ stage: 'review' })).toBe('review');
    // Отметка проверки у другого звена ничего не меняет: правки несут тот же список.
    expect(stageMcpKind({ stage: 'fix', verify: true })).toBe('fix');
    expect(stageMcpKind({})).toBe('work');
    expect(kept(base())).toEqual(FULL);
  });

  it('снятое звеном — с причиной `stage-idle`; мессенджер — своей причиной', () => {
    const dropped = groupMcpProfile(base({ stage: 'fix' })).dropped;
    expect(dropped).toEqual([
      { id: 'gitlab-work', reason: 'stage-idle' },
      { id: 'atlassian-work', reason: 'stage-idle' },
      { id: 'figma', reason: 'stage-idle' },
      { id: 'platform-local', reason: 'stage-idle' },
      { id: 'telegram', reason: 'messenger' },
    ]);
  });

  it('правки: запуск без единого сервера, строка называет снятые и блок просьбы', () => {
    const run = groupRunProfile(base({ stage: 'fix' }));
    expect(run.args).toContain('--strict-mcp-config');
    expect(run.mcp).toEqual({ ids: [], config: { mcpServers: {} } });
    expect(run.env.ENABLE_CLAUDEAI_MCP_SERVERS).toBe('false');
    expect(run.note).toContain('MCP servers in this run: none.');
    expect(run.note).toContain('gitlab-work, atlassian-work, figma, platform-local');
    expect(run.note).toContain(`<${SPLIT_MCP_TAG}>`);
    // Запретов на запись нечему накрывать: серверов нет.
    const deny = (run.settings.permissions as { deny?: string[] }).deny ?? [];
    expect(deny.some((rule) => rule.startsWith('mcp__'))).toBe(false);
  });

  it('доставка: трекер и хранилище кода своим `--mcp-config`, правила `ask` на них', () => {
    const run = groupRunProfile(base({ stage: 'deliver' }));
    expect(run.mcp?.ids).toEqual(['gitlab-work', 'atlassian-work']);
    expect(Object.keys((run.mcp?.config as { mcpServers: object }).mcpServers)).toEqual([
      'gitlab-work',
      'atlassian-work',
    ]);
    const ask = (run.settings.permissions as { ask: string[] }).ask;
    expect(ask).toContain('mcp__gitlab-work');
    expect(ask).toContain('mcp__atlassian-work');
  });

  it('просьба группы блоком `mcp` сильнее таблицы — сервер едет и в правки', () => {
    expect(kept(base({ stage: 'fix', extra: ['Platform-Local'] }))).toEqual(['platform-local']);
    expect(kept(base({ stage: 'review', verify: true, extra: ['atlassian-work'] }))).toEqual([
      'atlassian-work',
    ]);
  });

  it('чужой CLI без звена во входе — набор работы, как до таблицы (порт — отдельной строкой)', () => {
    expect(foreignGroupMcp(base()).off).toEqual(['telegram']);
  });
});
