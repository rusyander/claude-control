import type { ConfigView } from '@agentdeck/contracts/core/config';
import type { McpOffersReply } from '@agentdeck/contracts/core/panel-api';
import { describe, expect, it } from 'vitest';
import {
  draftChanged,
  draftOf,
  isPicked,
  pickKinds,
  pickRows,
  setAllByDefault,
  togglePick,
  withPicks,
} from './mcpPicks';

/**
 * Модель экрана выбора MCP (s10 p9): строки из предложений всех CLI плюс выбранные, которых никто
 * не предлагает; чат без записи — «все предложенные»; запись — весь раздел с отпечатком, прочие
 * разделы и виды только чтения не трогаются.
 */

const REPLY: McpOffersReply = {
  kinds: [
    { kind: 'work', takesHuman: true, allByDefault: false },
    { kind: 'review', takesHuman: false, allByDefault: false },
    { kind: 'chat', takesHuman: true, allByDefault: true },
  ],
  clis: [
    {
      cli: 'claude',
      servers: [
        { id: 'probe', scope: 'user', file: 'a', transport: 'stdio' },
        { id: 'broken', scope: 'user', file: 'a', transport: null, skipped: 'no command' },
      ],
      unread: [],
    },
    {
      cli: 'codex',
      servers: [{ id: 'docs', scope: 'user', file: 'b', transport: 'remote' }],
      unread: [],
    },
  ],
  noReader: ['gemini'],
};

const view = (mcpPicks?: Record<string, string[]>): ConfigView => ({
  doc: { cliPaths: { claude: 'C:/bin/claude.exe' }, ...(mcpPicks ? { mcpPicks } : {}) },
  digest: 'd'.repeat(64),
  drift: null,
  issues: [],
});

describe('core MCP picks model (s10 p9)', () => {
  it('rows join every CLI offer by name and add a picked server no CLI offers as unknown', () => {
    const kinds = pickKinds(REPLY);
    expect(kinds.map((k) => k.kind)).toEqual(['work', 'chat']);
    const draft = draftOf(view({ work: ['ghost', 'probe'] }), kinds);
    const rows = pickRows(REPLY, draft);
    expect(rows.map((r) => r.id)).toEqual(['broken', 'docs', 'ghost', 'probe']);
    expect(rows.find((r) => r.id === 'ghost')).toMatchObject({ unknown: true, offered: false });
    expect(rows.find((r) => r.id === 'broken')).toMatchObject({ unknown: false, offered: false });
    expect(
      isPicked(
        draft,
        'work',
        rows.find((r) => r.id === 'probe')!,
      ),
    ).toBe(true);
  });

  it('chat without a record takes every carried server; the first untick turns it explicit', () => {
    const kinds = pickKinds(REPLY);
    const draft = draftOf(view(), kinds);
    expect(draft.chat).toBeNull();
    const rows = pickRows(REPLY, draft);
    expect(
      isPicked(
        draft,
        'chat',
        rows.find((r) => r.id === 'docs')!,
      ),
    ).toBe(true);
    expect(
      isPicked(
        draft,
        'chat',
        rows.find((r) => r.id === 'broken')!,
      ),
    ).toBe(false);
    const next = togglePick(draft, 'chat', 'docs', rows);
    expect(next.chat).toEqual(['probe']);
    expect(setAllByDefault(next, 'chat', true, rows).chat).toBeNull();
  });

  it('the written doc keeps other sections and read-only picks, drops empty kinds, keeps an explicit empty chat', () => {
    const kinds = pickKinds(REPLY);
    const base = view({ review: ['probe'], work: ['probe'] });
    const out = withPicks(base, { work: [], chat: [] }, kinds);
    expect(out.baseDigest).toBe(base.digest);
    expect(out.doc.cliPaths).toEqual({ claude: 'C:/bin/claude.exe' });
    expect(out.doc.mcpPicks).toEqual({ review: ['probe'], chat: [] });
    const cleared = withPicks(view({ work: ['probe'] }), { work: [], chat: null }, kinds);
    expect(cleared.doc.mcpPicks).toBeUndefined();
    expect(draftChanged(base, draftOf(base, kinds), kinds)).toBe(false);
    expect(draftChanged(base, { ...draftOf(base, kinds), work: ['docs'] }, kinds)).toBe(true);
  });
});
