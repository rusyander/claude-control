import { useTranslation } from 'react-i18next';
import type { Gate, GateKind } from '@agentdeck/contracts/core/scenario';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { SelectField } from '@shared/ui/select-field';
import { Stack } from '@shared/ui/stack';
import { TextField } from '@shared/ui/text-field';
import { Typography } from '@shared/ui/typography';
import { gateOf } from '../../model/fields';
import type { GateFieldsProps } from './GateFields.types';
import styles from './GateFields.module.scss';

const GATE_KINDS: readonly GateKind[] = [
  'requirements-covered',
  'check-green',
  'regression-red-before',
  'review-no-blocking',
  'text',
];

/**
 * Ворота шага: каждое — вид и, где вид требует, проверка или условие. Смена вида пересобирает
 * ворота с нуля: поле одного вида схема у другого не примет.
 */
export function GateFields({ gates, onChange }: GateFieldsProps) {
  const { t } = useTranslation();
  const options = GATE_KINDS.map((kind) => ({
    value: kind,
    label: t(`coreScenario.gate.${kind}`),
  }));
  const replace = (index: number, gate: Gate): void =>
    onChange(gates.map((g, i) => (i === index ? gate : g)));

  return (
    <fieldset className={styles.gates}>
      <legend className={styles.legend}>{t('coreScenario.step.gates')}</legend>
      {gates.length === 0 && (
        <Typography variant="caption" color="subtle" as="span">
          {t('coreScenario.step.gatesEmpty')}
        </Typography>
      )}
      {gates.map((gate, index) => {
        const label = t(`coreScenario.gate.${gate.kind}`);
        return (
          // Ворота без своего id: место в списке и есть их имя в схеме (`gate.2`).
          <Stack key={index} direction="row" align="end" gap="var(--spacing-xs)" wrap>
            <div className={styles.kind}>
              <SelectField
                label={t('coreScenario.step.gates')}
                value={gate.kind}
                options={options}
                onChange={(kind) => replace(index, gateOf(kind as GateKind))}
              />
            </div>
            {gate.kind === 'check-green' && (
              <div className={styles.detail}>
                <TextField
                  label={t('coreScenario.step.checkId')}
                  value={gate.checkId}
                  isMono
                  onChange={(checkId) => replace(index, { ...gate, checkId })}
                />
              </div>
            )}
            {gate.kind === 'text' && (
              <div className={styles.detail}>
                <TextField
                  label={t('coreScenario.step.criterion')}
                  value={gate.criterion}
                  onChange={(criterion) => replace(index, { ...gate, criterion })}
                />
              </div>
            )}
            <Button
              size="sm"
              variant="ghost"
              iconOnly
              icon={<Icon name="trash" size={14} />}
              aria-label={t('coreScenario.step.removeGate', { gate: label })}
              onClick={() => onChange(gates.filter((_, i) => i !== index))}
            />
          </Stack>
        );
      })}
      <div>
        <Button
          size="sm"
          variant="secondary"
          leftIcon={<Icon name="plus" size={14} />}
          onClick={() => onChange([...gates, gateOf('requirements-covered')])}
        >
          {t('coreScenario.step.addGate')}
        </Button>
      </div>
    </fieldset>
  );
}
