import { useTranslation } from 'react-i18next';
import { knobId } from '@agentdeck/contracts';
import { Modal } from '@shared/ui/modal';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { KnobSelect } from '../KnobSelect/KnobSelect';
import { RowTextView } from '../RowTextView/RowTextView';
import { SourceChip } from '../SourceChip/SourceChip';
import type { StepDetailModalProps } from './StepDetailModal.types';
import styles from './StepDetailModal.module.scss';
import { Fact } from './Fact/Fact';
import { SummaryTexts } from './SummaryTexts/SummaryTexts';
import { StepTexts } from './StepTexts/StepTexts';
import { originText } from '../../lib/originText';
import { whereText } from '../../lib/whereText';

/**
 * Окно шага: что это и откуда (наш скилл из какого каталога, скилл проекта или
 * плагина, чужой, промпт панели, хук), где стоит в порядке, полный текст —
 * раздел скилла дословно или обе стороны своего шага (английская уходит в
 * прогон), числа шага с цитатой из скилла и путь к файлу.
 */
export function StepDetailModal({
  row,
  title,
  source,
  text,
  bilingual,
  file,
  isKnobSaving,
  onKnob,
  onEdit,
  onClose,
}: StepDetailModalProps) {
  const { t } = useTranslation();
  const step = row.kind === 'entry' && row.entry.kind === 'custom' ? row.entry.step : undefined;

  return (
    <Modal
      isOpen
      onOpenChange={(open) => !open && onClose()}
      title={title}
      size="lg"
      headerActions={
        <>
          <SourceChip source={source} />
          {step && onEdit && (
            <Button
              size="sm"
              leftIcon={<Icon name="edit" size={16} />}
              onClick={() => onEdit(step)}
            >
              {t('common.edit')}
            </Button>
          )}
        </>
      }
    >
      <dl className={styles.facts}>
        <Fact label={t('groupPath.detail.what')}>
          <Typography variant="body-sm" as="span">
            {originText(t, source)}
          </Typography>
        </Fact>
        {file && (
          <Fact label={t('groupPath.detail.file')}>
            <Typography variant="mono" as="span" className={styles.path}>
              {file}
            </Typography>
          </Fact>
        )}
        <Fact label={t('groupPath.detail.where')}>
          <Typography variant="body-sm" as="span">
            {whereText(t, row)}
          </Typography>
          {step?.anchor === 'triage' && (
            <Typography variant="caption" color="subtle" as="span" className={styles.block}>
              {t('groupPath.triageChat')}
            </Typography>
          )}
        </Fact>
        {bilingual?.summary && <SummaryTexts summary={bilingual.summary} />}
        {step && <StepTexts step={step} />}
        {!step && bilingual?.original && (
          <Fact label={t('groupBuilder.detail.original')}>
            <Typography variant="body-sm" as="span" lang="en" className={styles.text}>
              {bilingual.original}
            </Typography>
          </Fact>
        )}
        {!step && !bilingual?.original && (
          <Fact label={t('groupPath.detail.description')}>
            <RowTextView text={text} variant="full" />
          </Fact>
        )}
        {step?.resource && (
          <Fact label={t('groupPath.detail.description')}>
            <RowTextView
              text={{
                kind: 'summary',
                type: step.resource.type,
                id: step.resource.id,
                ...(source.project ? { project: source.project } : {}),
              }}
              variant="full"
            />
          </Fact>
        )}
        {row.knobs.length > 0 && (
          <Fact label={t('groupPath.detail.knobs')}>
            <ul className={styles.knobs}>
              {row.knobs.map((knob) => (
                <li key={knobId(knob)} className={styles.knob}>
                  <KnobSelect
                    knob={knob}
                    stepTitle={title}
                    isSaving={isKnobSaving}
                    onChange={(value) => onKnob(knob, value)}
                  />
                  <Typography variant="caption" color="subtle" as="span" className={styles.quote}>
                    {t('groupKnobs.quote', { quote: knob.quote })}
                  </Typography>
                </li>
              ))}
            </ul>
            <Typography variant="caption" color="subtle" as="span" className={styles.block}>
              {t('groupKnobs.autoHint')}
            </Typography>
          </Fact>
        )}
      </dl>
    </Modal>
  );
}
