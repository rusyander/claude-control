import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resetAgentDigestCache } from '../subagent-tree/agent-digest.ts';
import { readAgentTranscript } from '../subagent-tree/subagent-tree.ts';
import { historyKeys, readAgentHistory, resetAgentHistoryCache } from './agent-history.ts';
import { appendSubagentCall, at, seedGroup, type GroupFixture } from './agent-history.fixture.ts';

/**
 * История агентов по всем сессиям группы — на настоящих файлах в раскладке CLI
 * (временный каталог): прошлая сессия со своими субагентами, текущая, сессия
 * чужой группы и ключ без транскрипта.
 */
/** Часы в начале эпохи и ни одного живого процесса: «сейчас работают» — ноль. */
const IDLE = { now: 0, alive: () => false };

describe('история агентов по сессиям', () => {
  let root: string;
  let fx: GroupFixture;

  beforeEach(() => {
    resetAgentHistoryCache();
    resetAgentDigestCache();
    root = mkdtempSync(join(tmpdir(), 'cc-agent-history-'));
    fx = seedGroup(root);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('сессии группы новыми первыми: прошлая со своими субагентами, чужая группа и ключ без файла — мимо', () => {
    const history = readAgentHistory(fx.projectsDir, historyKeys(fx.links, 's-fix'), 's-fix', IDLE);
    expect(
      history.sessions.map((session) => [session.chatId, session.stage, session.current]),
    ).toEqual([
      ['s-fix', 'fix', true],
      ['s-work', 'work', undefined],
    ]);
    expect(history.agentCount).toBe(3);
    const work = history.sessions[1];
    expect(work?.startedAt).toBe(at(0));
    expect(work?.endedAt).toBe(at(45));
    expect(work?.agents.map((agent) => [agent.agentId, agent.description, agent.status])).toEqual([
      ['aw1', 'Найти модуль отчётов', 'done'],
      ['aw2', 'Собрать выгрузку CSV', 'done'],
    ]);
    expect(work?.agents[1]).toMatchObject({
      model: 'claude-sonnet-4-6',
      toolCalls: 3,
      tokens: { input: 15, output: 3 },
      result: 'Выгрузка готова, тесты зелёные',
    });
  });

  it('главный агент: вызовы по блокам, расход — каждый ответ один раз, модель', () => {
    const history = readAgentHistory(fx.projectsDir, historyKeys(fx.links, 's-fix'), 's-fix', IDLE);
    expect(history.sessions[1]?.main).toEqual({
      toolCalls: 3,
      tokens: { input: 60, output: 3, cacheRead: 300, cacheCreation: 0 },
      model: 'claude-opus-4-1',
      // s-work кончается репликой «Готово» (минута 45), открытых вызовов нет.
      lastAction: 'Готово',
    });
  });

  it('с любой сессии группы — та же история; текущей помечена запрошенная', () => {
    const history = readAgentHistory(
      fx.projectsDir,
      historyKeys(fx.links, 's-work'),
      's-work',
      IDLE,
    );
    expect(history.sessions.map((session) => [session.chatId, session.current])).toEqual([
      ['s-fix', undefined],
      ['s-work', true],
    ]);
  });

  it('чат без связи с группой — только своя сессия', () => {
    const history = readAgentHistory(fx.projectsDir, historyKeys({}, 's-other'), 's-other', IDLE);
    expect(history.sessions.map((session) => session.chatId)).toEqual(['s-other']);
    expect(history.agentCount).toBe(1);
    expect(readAgentHistory(fx.projectsDir, historyKeys({}, 'nope'), 'nope', IDLE)).toEqual({
      sessions: [],
      agentCount: 0,
      live: { agents: 0, subagents: 0 },
    });
  });

  it('дописанный файл субагента прошлой сессии перечитывается, неизменный — из памяти', () => {
    const keys = historyKeys(fx.links, 's-fix');
    const first = readAgentHistory(fx.projectsDir, keys, 's-fix', IDLE);
    const again = readAgentHistory(fx.projectsDir, keys, 's-fix', IDLE);
    expect(again.sessions[1]?.agents).toBe(first.sessions[1]?.agents);
    appendSubagentCall(fx.workLog, 3);
    const grown = readAgentHistory(fx.projectsDir, keys, 's-fix', IDLE);
    expect(grown.sessions[1]?.agents[1]?.toolCalls).toBe(4);
  });

  it('ход субагента прошлой сессии открывается по ключу этой сессии', () => {
    const history = readAgentHistory(fx.projectsDir, historyKeys(fx.links, 's-fix'), 's-fix', IDLE);
    const old = history.sessions[1];
    const transcript = readAgentTranscript(fx.projectsDir, old?.chatId ?? '', 'aw2', {
      limit: 50,
      offset: 0,
    });
    expect(transcript?.description).toBe('Собрать выгрузку CSV');
    expect(transcript?.steps.filter((step) => step.kind === 'tool')).toHaveLength(3);
  });
});
