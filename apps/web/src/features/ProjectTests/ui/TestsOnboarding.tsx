import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Typography } from '@shared/ui/typography';
import type { TestsOnboardingProps } from './TestsOnboarding.types';
import styles from './ProjectTests.module.scss';

/** Первое окружение проекта: одно, по умолчанию, с говорящим именем. */
const FIRST_ENVIRONMENT_ID = 'local';

/**
 * Пустой набор: три шага вместо пустого списка.
 *
 * Пустое состояние здесь встречает человека, у которого в проекте ещё НЕТ
 * ничего, — и оно обязано отвечать на «с чего начать», а не сообщать очевидное
 * «кейсов нет». Шаги идут в том порядке, в каком их и делают: сначала есть
 * куда гонять, потом появляется что гонять, и только потом — прогон.
 *
 * Шаги отмечаются сделанными по состоянию проекта, а не по нажатиям: окружение
 * могли завести из другой вкладки или руками в файле, и панель обязана это
 * увидеть.
 */
export function TestsOnboarding({ board, scope, environmentId }: TestsOnboardingProps) {
  const { t } = useTranslation();

  const environment = board.environments.find((item) => !item.archived);
  const draft = board.pendingDraft;
  const isRunning = board.run?.status === 'running';

  const steps = [
    {
      key: 'env',
      title: t('tests.onboarding.envTitle'),
      text: t('tests.onboarding.envText'),
      done: environment ? t('tests.onboarding.envDone', { title: environment.title }) : undefined,
      action: environment ? undefined : t('tests.onboarding.envAction'),
      onAction: () => {
        // Отказ показывает общая строка ошибок набора, поэтому здесь его
        // достаточно поглотить: без этого он уходит в необработанный промис.
        void board
          .saveEnvironment({
            id: FIRST_ENVIRONMENT_ID,
            title: t('tests.onboarding.envName'),
            isDefault: true,
          })
          .catch(() => undefined);
      },
    },
    {
      key: 'generate',
      title: t('tests.onboarding.generateTitle'),
      text: t('tests.onboarding.generateText'),
      done: draft ? t('tests.onboarding.generateDone', { count: draft.pending }) : undefined,
      action: t('tests.onboarding.generateAction'),
      onAction: () =>
        board.start({
          mode: 'generate',
          scope,
          environmentId: environmentId || undefined,
          autoAccept: board.autoAcceptDrafts,
        }),
    },
    {
      key: 'run',
      title: t('tests.onboarding.runTitle'),
      text: t('tests.onboarding.runText'),
      done: undefined,
      action: undefined,
      onAction: () => undefined,
    },
  ];

  return (
    <Stack gap="var(--spacing-sm)" className={styles.onboarding}>
      <Typography variant="heading-sm">{t('tests.onboarding.title')}</Typography>
      <Typography variant="body-sm" color="subtle">
        {t('tests.onboarding.subtitle', { dir: board.dir })}
      </Typography>

      <ol className={styles.onboardingSteps}>
        {steps.map((step, index) => (
          <li key={step.key} className={styles.onboardingStep}>
            <span className={styles.onboardingNumber} aria-hidden="true">
              {step.done ? <Icon name="check" size={16} /> : index + 1}
            </span>
            <Stack gap="var(--spacing-3xs)">
              <Typography variant="body" weight="medium">
                {step.title}
              </Typography>
              <Typography variant="body-sm" color="subtle">
                {step.done ?? step.text}
              </Typography>
              {step.action && (
                <div>
                  <Button
                    variant={index === 0 && !environment ? 'primary' : 'secondary'}
                    size="sm"
                    disabled={isRunning}
                    isLoading={board.isBusy && !isRunning}
                    onClick={step.onAction}
                  >
                    {step.action}
                  </Button>
                </div>
              )}
            </Stack>
          </li>
        ))}
      </ol>
    </Stack>
  );
}
