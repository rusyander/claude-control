import { describe, it, expect } from 'vitest';
import { projectOnboardingText } from './projectOnboarding';

const t = (key: string, params?: Record<string, unknown>): string =>
  params ? `${key} ${JSON.stringify(params)}` : key;

describe('projectOnboardingText', () => {
  it('нечего сказать — молчит', () => {
    expect(projectOnboardingText(undefined, t)).toBeUndefined();
  });

  it('заведена панелью: скрыта от git или проект не под git', () => {
    expect(projectOnboardingText({ state: 'created', dir: 'e2e', excluded: true }, t)).toEqual({
      tone: 'info',
      text: 'testsE2e.onboard.created {"dir":"e2e/"}',
    });
    expect(projectOnboardingText({ state: 'created', dir: 'e2e', excluded: false }, t)?.text).toBe(
      'testsE2e.onboard.createdVisible {"dir":"e2e/"}',
    );
  });

  it('своя: сверена или пока пуста', () => {
    expect(
      projectOnboardingText(
        {
          state: 'found',
          dir: 'tests/e2e',
          framework: 'playwright',
          sync: { tests: 4, added: 3, groups: ['cart'] },
        },
        t,
      )?.text,
    ).toBe('testsE2e.onboard.synced {"dir":"tests/e2e/","tests":4,"added":3}');
    expect(
      projectOnboardingText({ state: 'found', dir: 'e2e', framework: 'cypress' }, t)?.text,
    ).toBe('testsE2e.onboard.foundEmpty {"dir":"e2e/"}');
  });

  it('сбой — предупреждение, проект всё равно добавлен', () => {
    expect(projectOnboardingText({ state: 'failed' }, t)).toEqual({
      tone: 'warning',
      text: 'testsE2e.onboard.failed',
    });
  });
});
