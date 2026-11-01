import { useTranslation } from 'react-i18next';
import { Badge } from '@shared/ui/badge';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { orderedSteps, refText } from '../../model/scenarioDraft';
import type { ScenarioViewProps } from './ScenarioView.types';
import styles from './ScenarioView.module.scss';

/**
 * Сценарий из библиотеки на чтение: шаги в порядке зависимостей, у каждого — вид, модель,
 * «после чего» и ворота. Указание шагу показано целиком: это то, что модель получит в брифе.
 */
export function ScenarioView({ scenario, source }: ScenarioViewProps) {
  const { t } = useTranslation();
  const ref = refText(scenario);
  return (
    <Stack gap="var(--spacing-sm)" data-scenario-view={ref}>
      <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
        <Typography variant="heading-sm" as="h2">
          {scenario.title}
        </Typography>
        <Badge tone={source === 'preset' ? 'info' : 'accent'}>
          {source === 'preset' ? t('coreScenario.library.preset') : t('coreScenario.library.saved')}
        </Badge>
        <Typography variant="mono" color="subtle" as="span">
          {ref}
        </Typography>
      </Stack>
      {scenario.presetOf && (
        <Typography variant="caption" color="subtle" as="span">
          {t('coreScenario.view.presetOf', { ref: refText(scenario.presetOf) })}
        </Typography>
      )}
      <ol className={styles.steps} aria-label={t('coreScenario.view.stepsLabel', { ref })}>
        {orderedSteps(scenario.steps).map((step, index) => (
          <li key={step.id} className={styles.step} data-step-id={step.id}>
            <span className={styles.number}>{index + 1}</span>
            <Stack gap="var(--spacing-3xs)" minWidth="0" flex={1}>
              <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
                <Typography variant="body-sm" weight="medium" as="span">
                  {step.title}
                </Typography>
                <Badge tone="neutral">{t(`coreScenario.kind.${step.kind}`)}</Badge>
                <Badge tone="neutral">{t(`coreScenario.tier.${step.model.tier}`)}</Badge>
              </Stack>
              <Typography variant="caption" color="subtle" as="span">
                {step.id}
                {step.after.length > 0 &&
                  ` · ${t('coreScenario.view.after', { after: step.after.join(', ') })}`}
                {step.gate.length > 0 &&
                  ` · ${t('coreScenario.view.gates', {
                    gates: step.gate.map((gate) => t(`coreScenario.gate.${gate.kind}`)).join(', '),
                  })}`}
              </Typography>
              {step.knowledge.text && (
                <Typography variant="caption" className={styles.text} as="p">
                  {step.knowledge.text}
                </Typography>
              )}
            </Stack>
          </li>
        ))}
      </ol>
    </Stack>
  );
}
