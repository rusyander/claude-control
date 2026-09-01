import { useTranslation } from 'react-i18next';
import type { ScenarioStep } from '@claude-control/contracts';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { TextField } from '@shared/ui/text-field';
import type { ScenarioFieldsProps } from './ScenarioFields.types';
import { EMPTY_STEP } from './ScenarioFields.constants';
import styles from './GroupFormModal.module.scss';

/**
 * Сценарий группы: порядок работы над типовой задачей.
 *
 * Шаги здесь — не памятка человеку: панель компилирует их в скилл, который
 * читает агент. Поэтому у шага есть признак выполнения — без него список
 * остаётся пожеланием, и агент сам решает, что шаг сделан.
 *
 * Триггер проверяется прямо в форме: сломанное выражение упало бы внутри хука
 * на каждом запросе, и разбирать это пришлось бы уже по стеку в чужом чате.
 */
export function ScenarioFields({ value, onChange }: ScenarioFieldsProps) {
  const { t } = useTranslation();

  const triggerError = isValidPattern(value.trigger) ? undefined : t('groups.scenarioTriggerError');

  const patchStep = (index: number, patch: Partial<ScenarioStep>): void => {
    onChange({
      ...value,
      steps: value.steps.map((step, position) =>
        position === index ? { ...step, ...patch } : step,
      ),
    });
  };

  const move = (index: number, delta: number): void => {
    const target = index + delta;
    if (target < 0 || target >= value.steps.length) return;
    const current = value.steps[index];
    const neighbour = value.steps[target];
    if (!current || !neighbour) return;
    const steps = [...value.steps];
    steps[index] = neighbour;
    steps[target] = current;
    onChange({ ...value, steps });
  };

  return (
    <Stack gap="var(--spacing-sm)">
      <TextField
        label={t('groups.scenarioWhen')}
        value={value.when}
        onChange={(when) => onChange({ ...value, when })}
        placeholder={t('groups.scenarioWhenPlaceholder')}
        hint={t('groups.scenarioWhenHint')}
      />

      <TextField
        label={t('groups.scenarioTrigger')}
        value={value.trigger}
        onChange={(trigger) => onChange({ ...value, trigger })}
        placeholder="GOR-\d+"
        hint={t('groups.scenarioTriggerHint')}
        error={triggerError}
        isMono
      />

      <Stack gap="var(--spacing-2xs)">
        <Typography variant="body-sm" weight="medium">
          {t('groups.scenarioSteps')}
        </Typography>

        {value.steps.map((step, index) => (
          <Stack key={index} gap="var(--spacing-2xs)" className={styles.stepCard}>
            <Stack direction="row" align="center" justify="between" gap="var(--spacing-xs)">
              <Typography variant="caption" color="subtle" as="span">
                {index + 1}
              </Typography>
              <Stack direction="row" gap="var(--spacing-3xs)" flexShrink={0}>
                <Button
                  size="sm"
                  variant="ghost"
                  iconOnly
                  icon={<Icon name="chevronUp" size={20} />}
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                  aria-label={t('groups.moveUp')}
                />
                <Button
                  size="sm"
                  variant="ghost"
                  iconOnly
                  icon={<Icon name="chevronDown" size={20} />}
                  disabled={index === value.steps.length - 1}
                  onClick={() => move(index, 1)}
                  aria-label={t('groups.moveDown')}
                />
                <Button
                  size="sm"
                  variant="ghost"
                  iconOnly
                  icon={<Icon name="close" size={20} />}
                  onClick={() =>
                    onChange({
                      ...value,
                      steps: value.steps.filter((_, position) => position !== index),
                    })
                  }
                  aria-label={t('groups.scenarioStepRemove')}
                />
              </Stack>
            </Stack>

            <TextField
              label={t('groups.scenarioStepTitle')}
              value={step.title}
              onChange={(title) => patchStep(index, { title })}
            />
            <TextField
              label={t('groups.scenarioStepBody')}
              value={step.body}
              onChange={(body) => patchStep(index, { body })}
              multiline
              rows={2}
            />
            <TextField
              label={t('groups.scenarioStepGate')}
              value={step.gate}
              onChange={(gate) => patchStep(index, { gate })}
              hint={t('groups.scenarioStepGateHint')}
            />
          </Stack>
        ))}

        <Stack direction="row">
          <Button
            size="sm"
            leftIcon={<Icon name="plus" size={20} />}
            onClick={() => onChange({ ...value, steps: [...value.steps, EMPTY_STEP] })}
          >
            {t('groups.scenarioStepAdd')}
          </Button>
        </Stack>
      </Stack>

      <Typography variant="caption" color="subtle">
        {t('groups.scenarioHint')}
      </Typography>
    </Stack>
  );
}

/** Годится ли выражение триггера. Пустое — годится: тогда хук просто не ставится. */
function isValidPattern(pattern: string): boolean {
  if (!pattern.trim()) return true;
  try {
    new RegExp(pattern, 'i');
    return true;
  } catch {
    return false;
  }
}
