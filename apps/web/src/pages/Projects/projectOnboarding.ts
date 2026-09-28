import type { ProjectE2eOnboarding } from '@agentdeck/contracts';

type Translate = (key: string, params?: Record<string, unknown>) => string;

/**
 * Что панель сделала с папкой e2e только что добавленного проекта — строкой
 * уведомления. Без неё папка появлялась в каталоге человека молча, и он узнавал
 * о ней из `git status` или никогда. `undefined` — сказать нечего.
 */
export function projectOnboardingText(
  e2e: ProjectE2eOnboarding | undefined,
  t: Translate,
): { tone: 'info' | 'warning'; text: string } | undefined {
  if (!e2e) return undefined;
  if (e2e.state === 'failed') return { tone: 'warning', text: t('testsE2e.onboard.failed') };
  const dir = `${e2e.dir}/`;
  if (e2e.state === 'created') {
    return {
      tone: 'info',
      text: t(e2e.excluded ? 'testsE2e.onboard.created' : 'testsE2e.onboard.createdVisible', {
        dir,
      }),
    };
  }
  if (!e2e.sync || e2e.sync.tests === 0) {
    return { tone: 'info', text: t('testsE2e.onboard.foundEmpty', { dir }) };
  }
  return {
    tone: 'info',
    text: t('testsE2e.onboard.synced', { dir, tests: e2e.sync.tests, added: e2e.sync.added }),
  };
}
