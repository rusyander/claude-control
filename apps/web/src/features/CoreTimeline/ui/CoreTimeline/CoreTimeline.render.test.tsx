import { beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TaskView } from '@agentdeck/contracts/core/task-view';
import type { SseEvent } from '@entities/CoreTask';
import { i18n } from '@shared/config/i18n';
import { foldEvents } from '../../model/fold';
import { CoreTimeline } from './CoreTimeline';
import { BudgetsPanel } from '../BudgetsPanel/BudgetsPanel';
import { SignalsPanel } from '../SignalsPanel/SignalsPanel';

/**
 * Лента на экране: заголовок решения — из шаблона языка интерфейса, причины — дословно под
 * «детали», проверка — с режимом и «почему», служебные строки — счётом. Расход панели — число
 * вида ядра без пересчёта.
 */

const TASK = '01900000-0000-7000-8000-000000000001';
const D_RUN = '01900000-0000-7000-8000-000000000601';

function ev(seq: number, kind: string, data: unknown) {
  const line = { v: 1, seq, at: 0, kind, data };
  return { id: String(seq), event: kind, data: JSON.stringify(line) } satisfies SseEvent;
}

const fold = foldEvents([
  ev(1, 'task.created', { title: 'Починить вход' }),
  ev(2, 'decision', {
    decisionId: 'd-2',
    class: 'permit',
    reasons: ['target outside unit paths'],
    output: { allow: false },
  }),
  ev(3, 'decision', { decisionId: D_RUN, class: 'check', reasons: [], output: { kind: 'run' } }),
  ev(4, 'decision', { decisionId: 'd-4', class: 'mystery', reasons: [], output: {} }),
  ev(5, 'usage', { input: 1 }),
  ev(6, 'signal', {
    signal: 'stall',
    severity: 'stop',
    subject: 'Bash',
    detail: 'no output',
    action: 'stop-step',
  }),
]);

const zero = { input: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 0, turns: 0 };
const view = {
  taskId: TASK,
  checks: [
    {
      decisionId: D_RUN,
      seq: 3,
      stepId: null,
      mode: 'run',
      why: 'no record for tree',
      recordId: null,
    },
  ],
  steps: [],
  sessions: [],
  budgets: [{ scope: 'task', spent: 1200, limit: 5000, seq: 1 }],
  windows: [{ routeId: 'stub:stand', limitKind: 'window', verdict: 'warn', resetAt: null, seq: 1 }],
  spend: {
    tokens: { ...zero, input: 1000, output: 234, turns: 3 },
    cost: { usd: 0.0123, windowUnits: 0, unpricedTokens: 0, versions: {}, turns: 3 },
    bySession: {},
    byStep: {},
  },
} as unknown as TaskView;

const wrap = (node: React.ReactNode) =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>,
  );

describe('лента задачи на экране', () => {
  beforeAll(async () => {
    await i18n.changeLanguage('ru');
  });

  it('решение — русский заголовок шаблона и английские причины дословно под «детали»', () => {
    const html = wrap(<CoreTimeline taskId={TASK} fold={fold} view={view} />);
    expect(html).toContain(i18n.t('coreTimeline.decisions.permit.outcomes.deny'));
    expect(html).toContain('<summary>');
    expect(html).toContain('target outside unit paths');
    expect(html).toContain('Решение «mystery» без шаблона');
    expect(html).toContain('data-core-hidden="1"');
  });

  it('проверка — режим из вида, «почему» дословно, без записи сказано прямо', () => {
    const html = wrap(<CoreTimeline taskId={TASK} fold={fold} view={view} />);
    expect(html).toContain('data-check-mode="run"');
    expect(html).toContain('no record for tree');
    expect(html).toContain('Записи ещё нет');
  });

  it('то же на английском — заголовок английского шаблона', async () => {
    await i18n.changeLanguage('en');
    const html = wrap(<CoreTimeline taskId={TASK} fold={fold} view={view} />);
    expect(html).toContain(i18n.t('coreTimeline.decisions.permit.outcomes.deny'));
    expect(i18n.t('coreTimeline.decisions.permit.outcomes.deny')).not.toBe(
      i18n.getFixedT('ru')('coreTimeline.decisions.permit.outcomes.deny'),
    );
    await i18n.changeLanguage('ru');
  });

  it('расход — числа вида ядра, бюджет и окно с вердиктом', () => {
    const html = renderToStaticMarkup(<BudgetsPanel view={view} />);
    expect(html).toContain('data-core-tokens="1234"');
    expect(html).toContain('$0.0123');
    expect(html).toContain('data-core-budget="task"');
    expect(html).toContain('data-window-verdict="warn"');
  });

  it('сигнал — важность, заголовок шаблона, действие, предмет с подписью и деталь', () => {
    const html = renderToStaticMarkup(<SignalsPanel fold={fold} />);
    expect(html).toContain('data-core-signal="stall"');
    expect(html).toContain('Сессия затихла');
    expect(html).toContain('шаг остановлен');
    expect(html).toContain('Сессия: <span lang="en">Bash</span>');
    expect(html).toContain('>no output<');
  });

  it('строка сигнала в ленте — тот же шаблон, без сырого id', () => {
    const html = wrap(<CoreTimeline taskId={TASK} fold={fold} view={view} />);
    expect(html).toContain('Сессия затихла');
    expect(html).toContain('data-signal-id="stall"');
    expect(html).toContain('Сессия: <span lang="en">Bash</span>');
    expect(html).not.toContain('Сигнал stall');
  });
});
