import { beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AgentNode, AgentNodeDetail, BgItem } from '@agentdeck/contracts/core/agents';
import { i18n } from '@shared/config/i18n';
import { buildCoreTree } from '../../model/coreAgents';
import { AgentHistoryCard } from './AgentHistoryButton';
import { AgentNodeList } from './AgentNodeList';
import { AgentNodeDetailView } from './AgentNodeDetailView';
import { BgItemDetail } from './BgItemDetail';

/**
 * Окно «Агенты» по журналу ядра: карточка над полем ввода («фоном: N» / «фоновых нет»), дерево
 * строк с моделью и словом состояния, подробность фоновой работы (команда, итог, «висит»,
 * «осиротел», «осиротел — потерян») и расход ребёнка — его собственный, а не родителя.
 */
const TASK = '019a0000-0000-7000-8000-000000000001';
const STEP = '019a0000-0000-7000-8000-000000000002';
const SESSION = '019a0000-0000-7000-8000-000000000003';
const NOW = 100_000;

const node = (nodeId: string, over: Partial<AgentNode> = {}): AgentNode => ({
  nodeId,
  parentId: SESSION,
  taskId: TASK,
  kind: 'subagent',
  status: 'completed',
  stepId: STEP,
  unitId: null,
  sessionId: SESSION,
  model: null,
  background: false,
  startedAt: 1_000,
  endedAt: 61_000,
  spend: { tokens: null, windowShare: null },
  counts: { toolCalls: 0, files: 0, refusals: 0, escalations: 0, children: 0 },
  signals: [],
  briefExcerpt: null,
  returnExcerpt: null,
  ...over,
});
const session = (over: Partial<AgentNode> = {}) =>
  node(SESSION, { kind: 'unit-session', parentId: null, ...over });
const bg = (nodeId: string, over: Partial<AgentNode> = {}) =>
  node(nodeId, {
    kind: 'background-shell',
    background: true,
    briefExcerpt: 'npm run watch',
    ...over,
  });

const item = (itemId: string, over: Partial<BgItem> = {}): BgItem => ({
  itemId,
  kind: 'background-shell',
  excerpt: 'npm run watch',
  ownerChain: {
    taskId: TASK,
    stepId: STEP,
    unitId: null,
    sessionId: SESSION,
    toolUseId: 'toolu_bash',
    parentToolUseId: null,
  },
  startedAt: 1_000,
  ...over,
});

const detailOf = (n: AgentNode, bgItems: BgItem[] = []): AgentNodeDetail => ({
  node: n,
  toolCalls: { items: [], next: null },
  files: [],
  refusals: [],
  escalations: [],
  bg: bgItems,
  outputTail: null,
});

const text = (html: string): string =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const list = (nodes: AgentNode[]): string =>
  renderToStaticMarkup(
    <AgentNodeList
      roots={buildCoreTree(nodes)}
      picked={undefined}
      onPick={() => undefined}
      now={NOW}
    />,
  );

const statusOf = (html: string, nodeId: string): string | undefined => {
  const at = html.indexOf(`data-agent-row="${nodeId}"`);
  if (at < 0) return undefined;
  return /data-node-status="([^"]+)"/.exec(html.slice(at))?.[1];
};

beforeAll(async () => {
  await i18n.changeLanguage('ru');
});

describe('AgentHistoryCard — карточка над полем ввода', () => {
  it('идёт фоновая работа — «фоном: 1»', () => {
    const html = renderToStaticMarkup(
      <AgentHistoryCard
        nodes={[session({ status: 'running' }), bg('b1', { status: 'running', endedAt: null })]}
        onOpen={() => undefined}
      />,
    );
    expect(html).toContain('data-agent-history-bg="1"');
    expect(text(html)).toContain('фоном: 1');
  });

  it('фон кончился — «фоновых нет»', () => {
    const html = renderToStaticMarkup(
      <AgentHistoryCard
        nodes={[session(), bg('b1', { status: 'completed', exitCode: 0 })]}
        onOpen={() => undefined}
      />,
    );
    expect(html).toContain('data-agent-history-bg="0"');
    expect(text(html)).toContain('фоновых нет');
  });
});

describe('AgentNodeList — дерево строк', () => {
  it('строка субагента с моделью, фоновая — «идёт», законченная — «завершён (код 0)»', () => {
    const html = list([
      session({ status: 'running', endedAt: null }),
      node('toolu_sub', { model: 'sonnet', briefExcerpt: 'probe subagent' }),
      bg('b1', { status: 'running', endedAt: null }),
      bg('b2', { status: 'completed', exitCode: 0, startedAt: 2_000 }),
    ]);
    expect(html).toContain('data-agent-kind="subagent"');
    expect(html).toContain('data-agent-model="sonnet"');
    expect(statusOf(html, 'b1')).toBe('running');
    expect(statusOf(html, 'b2')).toBe('completed');
    expect(text(html)).toContain('завершён (код 0)');
  });

  it('сеанс потерян — его потерянная фоновая работа «осиротел — потерян»', () => {
    const html = list([session({ status: 'lost' }), bg('b1', { status: 'lost' })]);
    expect(statusOf(html, 'b1')).toBe('orphanLost');
    expect(text(html)).toContain('осиротел — потерян');
  });

  it('сеанс кончился штатно — потерянная фоновая работа просто «потерян»', () => {
    const html = list([session({ status: 'completed' }), bg('b1', { status: 'lost' })]);
    expect(statusOf(html, 'b1')).toBe('lost');
  });

  it('владельца нет в ответе — строка всё равно есть, корнем', () => {
    const html = list([bg('b1', { parentId: 'gone', status: 'running', endedAt: null })]);
    expect(statusOf(html, 'b1')).toBe('running');
  });
});

describe('BgItemDetail — фоновая работа подробно', () => {
  it('команда, «завершён (код 0)», расход «неизвестно», цепочка владельца', () => {
    const n = bg('b1', { status: 'completed', exitCode: 0 });
    const html = renderToStaticMarkup(
      <BgItemDetail detail={detailOf(n, [item('b1', { exitCode: 0, how: 'exit' })])} now={NOW} />,
    );
    const seen = text(html);
    expect(seen).toContain('npm run watch');
    expect(seen).toContain('завершён (код 0)');
    expect(seen).toContain('неизвестно');
    expect(html).toContain('data-agent-fact="owner"');
  });

  it('молчащая — «висит», живая сирота — «осиротел»', () => {
    const hang = bg('b1', { status: 'running', endedAt: null, signals: ['bg-hang'] });
    expect(
      text(renderToStaticMarkup(<BgItemDetail detail={detailOf(hang, [item('b1')])} now={NOW} />)),
    ).toContain('висит');
    const orphan = bg('b1', { status: 'running', endedAt: null, signals: ['bg-orphan'] });
    const orphanText = text(
      renderToStaticMarkup(<BgItemDetail detail={detailOf(orphan, [item('b1')])} now={NOW} />),
    );
    expect(orphanText).toContain('осиротел');
    expect(orphanText).not.toContain('осиротел —');
  });

  it('потеряна при аварийном конце владельца — «осиротел — потерян» и в подробности', () => {
    const n = bg('b1', { status: 'lost' });
    const html = renderToStaticMarkup(
      <AgentNodeDetailView
        detail={detailOf(n, [item('b1', { how: 'lost' })])}
        nodes={[session({ status: 'lost' }), n]}
        now={NOW}
        hasMore={false}
        isFetchingMore={false}
        onMore={() => undefined}
      />,
    );
    expect(html).toContain('data-bg-detail="b1"');
    expect(text(html)).toContain('осиротел — потерян');
  });
});

describe('AgentNodeDetailView — расход ребёнка свой', () => {
  it('у родителя расход известен, у субагента нет — у субагента «неизвестно»', () => {
    const parent = session({ spend: { tokens: 12_000, windowShare: null } });
    const child = node('toolu_sub', { model: 'sonnet' });
    const html = renderToStaticMarkup(
      <AgentNodeDetailView
        detail={detailOf(child)}
        nodes={[parent, child]}
        now={NOW}
        hasMore={false}
        isFetchingMore={false}
        onMore={() => undefined}
      />,
    );
    const spend = /data-agent-fact="spend"(.*?)<\/dd>/s.exec(html)?.[1] ?? '';
    expect(text(spend)).toContain('неизвестно');
    expect(text(spend)).not.toMatch(/12/);
  });
});
