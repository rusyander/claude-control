import { useTranslation } from 'react-i18next';
import { AGENT_MIN_CONTEXT } from '@agentdeck/contracts/local-models';
import { Button } from '@shared/ui/button';
import { SelectField } from '@shared/ui/select-field';
import { Toggle } from '@shared/ui/toggle';
import { Typography } from '@shared/ui/typography';
import styles from './ModelSelects.module.scss';
import type { ModelSelectsProps } from './ModelSelects.types';
import {
  blockText,
  contextLabel,
  contextOptionText,
  formatGb,
  quantOptionText,
  quantTitle,
} from './optionText';

/**
 * Остров настроек карточки: квантование (файлы репозитория с размером) и
 * контекст (от 8K до предела модели). Каждый закрывает у соседа то, что вместе с
 * ним не влезет, и пишет почему — «не влезет: нужно 26,1 ГБ из 24». Выбранное
 * запоминается сервером и действует на каждый запуск модели.
 */
export function ModelSelects({ row, onChoose }: ModelSelectsProps) {
  const { t, i18n } = useTranslation();
  const { model, choice, installedQuants } = row;
  const hasPartial =
    row.quantOptions.some((option) => option.level === 'partial') ||
    row.contextOptions.some((option) => option.level === 'partial');

  // Выбранная пара не влезает или мала для агента — об этом одна строка под списками.
  const blocking = [
    row.quantOptions.find((option) => option.value === choice.quant),
    row.contextOptions.find((option) => option.value === choice.context),
  ].find((option) => option?.block !== undefined);
  const rec = row.recommendation;
  const recQuant = rec.status === 'ok' ? rec.quant : undefined;
  const recContext = rec.status === 'ok' ? rec.context : undefined;
  const differs =
    rec.status === 'ok' && (rec.quant !== choice.quant || rec.context !== choice.context);
  const memory = formatGb(row.choiceFit.availableGb, i18n.language);
  const where = row.onGpu ? 'Gpu' : 'Cpu';
  const problem = blocking ? blockText(blocking, t, i18n.language) : undefined;

  return (
    <div
      className={styles.island}
      role="group"
      aria-label={t('localModels.catalog.selects.group', { title: model.title })}
    >
      <Typography variant="caption" color="muted" weight="semibold">
        {t('localModels.catalog.selects.title')}
      </Typography>
      <SelectField
        label={t('localModels.catalog.selects.quant')}
        value={choice.quant}
        onChange={(quant) => onChoose({ quant })}
        options={row.quantOptions.map((option) => ({
          value: option.value,
          label: quantOptionText(
            option,
            installedQuants.includes(option.value),
            t,
            i18n.language,
            option.value === choice.quant,
            option.value === recQuant,
          ),
          disabled: option.disabled && option.value !== choice.quant,
        }))}
      />
      <div className={styles.row}>
        <div className={styles.context}>
          <SelectField
            label={t('localModels.catalog.selects.context')}
            value={String(choice.context)}
            onChange={(context) => onChoose({ context: Number(context) })}
            options={row.contextOptions.map((option) => ({
              value: String(option.value),
              label: contextOptionText(
                option,
                t,
                i18n.language,
                option.value === choice.context,
                option.value === recContext,
              ),
              disabled: option.disabled && option.value !== choice.context,
            }))}
          />
        </div>
        {hasPartial || choice.allowPartial ? (
          <div className={styles.partial}>
            <Toggle
              size="sm"
              checked={choice.allowPartial}
              onCheckedChange={(allowPartial) => onChoose({ allowPartial })}
              aria-label={t('localModels.catalog.selects.allowPartial')}
            />
            <Typography as="span" variant="body-sm" color="muted">
              {t('localModels.catalog.selects.allowPartial')}
            </Typography>
          </div>
        ) : null}
      </div>
      {rec.status === 'ok' ? (
        <div className={styles.hint}>
          <Typography variant="caption" color="muted">
            {t(`localModels.catalog.selects.hint${differs ? '' : 'On'}${where}`, {
              gb: memory,
              quant: quantTitle(row.model, rec.quant, t),
              context: contextLabel(rec.context),
            })}
            {rec.lowQuality ? ` — ${t('localModels.catalog.selects.lowNote')}` : ''}
          </Typography>
          {differs ? (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => onChoose({ quant: rec.quant, context: rec.context })}
            >
              {t('localModels.catalog.selects.apply')}
            </Button>
          ) : null}
        </div>
      ) : (
        <Typography variant="caption" color="warning">
          {t(`localModels.catalog.selects.hintNone${where}`, {
            gb: memory,
            min: AGENT_MIN_CONTEXT / 1024,
          })}
        </Typography>
      )}
      {problem ? (
        <Typography variant="caption" color="warning">
          {problem}
        </Typography>
      ) : null}
    </div>
  );
}
