import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ProjectTestMutationCheck, ProjectTestMutationView } from '@agentdeck/contracts';
import { i18n } from '@shared/config/i18n';

/**
 * Вид отчёта проверки поломкой (Ф10, Ф9): кейсы без результата не читаются
 * как «не защищён», неубранная копия названа, а «не проверено: нет доступа»
 * подставляет имена переменных. Хуки данных подменены — проверяется вид.
 */

let view: ProjectTestMutationView = { candidates: [] };
const idle = { mutate: () => {}, reset: () => {}, isPending: false, error: null };
vi.mock('@entities/ProjectTest', () => ({
  useMutationCheck: () => ({ data: view }),
  useStartMutationCheck: () => idle,
  useStopMutationCheck: () => idle,
}));

const { TestMutationCheck } = await import('./TestMutationCheck');

const check = (extra: Partial<ProjectTestMutationCheck>): ProjectTestMutationCheck => ({
  status: 'done',
  stage: 'report',
  file: 'src/app.ts',
  mode: 'break',
  startedAt: '2026-10-05T10:00:00.000Z',
  log: '',
  cases: [],
  caught: 0,
  missed: 0,
  noResult: 0,
  ...extra,
});

const noResultCase = (caseId: string) => ({
  groupId: 'g',
  caseId,
  title: caseId,
  automationFile: 'e2e/a.spec.ts',
  status: 'no-result' as const,
});

const render = (next: ProjectTestMutationCheck): string => {
  view = { check: next, candidates: [{ file: 'src/app.ts', cases: 2 }] };
  return renderToStaticMarkup(<TestMutationCheck path="/proj" isBusy={false} />);
};

describe('вид проверки поломкой', () => {
  it('все кейсы без результата — «нет результата», не «не защищён»', () => {
    const html = render(check({ cases: [noResultCase('a-1'), noResultCase('a-2')], noResult: 2 }));
    expect(html).toContain('data-mutation-verdict="noResult"');
    expect(html).toContain(i18n.t('testsE2e.mutation.noResult', { count: 2 }));
    expect(html).not.toContain(i18n.t('testsE2e.mutation.unprotected', { count: 2 }));
  });

  it('неубранная копия названа причиной', () => {
    const html = render(check({ cleanupError: 'EBUSY' }));
    expect(html).toContain(i18n.t('testsE2e.mutation.cleanupFailed', { reason: 'EBUSY' }));
  });

  it('нехватка доступа стенда — с именами переменных', () => {
    const html = render(
      check({
        status: 'error',
        errorCode: 'mutation-no-secrets',
        params: { names: 'E2E_TOKEN' },
      }),
    );
    expect(html).toContain('E2E_TOKEN');
  });

  // Кадр справки (Ф21) показал «Сломано: module throws on load» в русском окне:
  // что сломано, сервер шлёт кодом, а пишет интерфейс.
  it('что сломано — на языке окна, не строкой сервера', () => {
    const html = render(
      check({ mutation: 'module throws on load', mutationCode: 'module-throws' }),
    );
    expect(html).toContain(i18n.t('testsE2e.mutation.kind.module-throws'));
    expect(html).not.toContain('module throws on load');

    const flip = render(
      check({
        mode: 'subtle',
        mutation: 'line 3: a === b → a !== b',
        mutationCode: 'line-flip',
        mutationParams: { line: 3, from: 'a === b', to: 'a !== b' },
      }),
    );
    expect(flip).toContain('a === b → a !== b');
    expect(flip).not.toContain('line 3');
  });
});
