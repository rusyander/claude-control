import { afterAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ProjectWorktree, WorktreeBootstrapState } from '@agentdeck/contracts';
import { i18n } from '@shared/config/i18n';
import { WorktreeBootstrapCard } from './WorktreeBootstrapCard';

/**
 * @covers apps/web/src/features/ProjectGit/ui/WorktreeBootstrapCard/WorktreeBootstrapCard.tsx
 * @scenario Карточка подготовки копии называет первую настоящую ошибку (а не хвост лога)
 * и версии рантайма, на которых шла подготовка, — по-русски и по-английски.
 */

function render(bootstrap: Partial<WorktreeBootstrapState>): string {
  const worktree: ProjectWorktree = {
    path: 'C:/copies/a',
    isMain: false,
    detached: false,
    locked: false,
    prunable: false,
    bootstrap: {
      command: 'npm ci',
      status: 'failed',
      startedAt: '2026-10-13T10:00:00.000Z',
      logTail: 'tail',
      ...bootstrap,
    },
  };
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <WorktreeBootstrapCard
        path="C:/repo"
        worktree={worktree}
        disabled={false}
        onRerun={() => {}}
      />
    </QueryClientProvider>,
  );
}

afterAll(async () => {
  await i18n.changeLanguage('ru');
});

describe('карточка подготовки копии', () => {
  it('ru: сбой — первая ошибка видна, версии рантайма по строке на каждую', async () => {
    await i18n.changeLanguage('ru');
    const html = render({
      firstError: 'npm error code E404',
      runtimes: [
        {
          tool: 'node',
          where: '',
          wanted: '22',
          source: '.nvmrc',
          status: 'switched',
          used: '22.21.1',
          found: '24.13.0',
        },
        {
          tool: 'python',
          where: 'svc',
          wanted: '3.9',
          source: '.python-version',
          status: 'missing',
        },
      ],
    });
    expect(html).toContain('data-bootstrap-first-error');
    expect(html).toContain('Первая ошибка: npm error code E404');
    expect(html).toContain(
      'Node: проект просит 22 (.nvmrc) — подготовка шла на 22.21.1, а не на 24.13.0',
    );
    expect(html).toContain(
      'Python (svc): проект просит 3.9 (.python-version), подходящей версии на машине нет',
    );
    expect(html).toContain('data-bootstrap-runtime="missing"');
  });

  it('en: те же факты английскими словами', async () => {
    await i18n.changeLanguage('en');
    const html = render({
      firstError: 'npm error code E404',
      runtimes: [
        { tool: 'go', where: '', wanted: '1.25', source: 'go.mod', status: 'ok', used: '1.25.1' },
      ],
    });
    expect(html).toContain('First error: npm error code E404');
    expect(html).toContain('Go: the project asks for 1.25 (go.mod) — 1.25.1 fits');
  });

  it('удачная подготовка без версий — ни строки ошибки, ни строк версий', async () => {
    await i18n.changeLanguage('ru');
    const html = render({ status: 'ok', firstError: 'stale' });
    expect(html).not.toContain('data-bootstrap-first-error');
    expect(html).not.toContain('data-bootstrap-runtime');
  });
});
