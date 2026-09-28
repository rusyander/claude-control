import { useTranslation } from 'react-i18next';
import { PATH_ANCHORS, knobId } from '@agentdeck/contracts';
import { Modal } from '@shared/ui/modal';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import type { PathRow } from '../model/pathRows';
import type { StepSource } from '../model/stepSource';
import { KnobSelect } from './KnobSelect';
import { RowTextView } from './RowTextView';
import { SourceChip } from './SourceChip';
import type {
  FactProps,
  StepDetailModalProps,
  StepTextsProps,
  SummaryTextsProps,
} from './StepDetailModal.types';
import styles from './StepDetailModal.module.scss';

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

function Fact({ label, children }: FactProps) {
  return (
    <>
      <dt>
        <Typography variant="caption" color="subtle" as="span">
          {label}
        </Typography>
      </dt>
      <dd>{children}</dd>
    </>
  );
}

/**
 * Краткое описание на обоих языках: русское видит человек, английское — то,
 * что знает о шаге модель. Язык интерфейса — первым.
 */
function SummaryTexts({ summary }: SummaryTextsProps) {
  const { t, i18n } = useTranslation();
  const sides: ('ru' | 'en')[] = i18n.language.startsWith('en') ? ['en', 'ru'] : ['ru', 'en'];
  return (
    <>
      {sides.map((side) => (
        <Fact key={side} label={`${t('groupBuilder.detail.summary')} · ${side.toUpperCase()}`}>
          <Typography variant="body-sm" as="span" lang={side} className={styles.text}>
            {summary[side]}
          </Typography>
        </Fact>
      ))}
    </>
  );
}

/** Обе стороны своего шага: русскую видит человек, английскую читает прогон. */
function StepTexts({ step }: StepTextsProps) {
  const { t } = useTranslation();
  return (
    <>
      <Fact label={t('groupPath.detail.promptRu')}>
        <Typography variant="body-sm" as="span" lang="ru" className={styles.text}>
          {step.prompt.ru || t('groupPath.detail.noDescription')}
        </Typography>
      </Fact>
      <Fact label={t('groupPath.detail.promptEn')}>
        <Typography variant="body-sm" as="span" lang="en" className={styles.text}>
          {step.prompt.en || t('groupPath.detail.noDescription')}
        </Typography>
      </Fact>
      {/* Условие готовности — тоже обе стороны: прогон проверяет английское,
          а показывали только язык окна. */}
      {step.gate?.ru && (
        <Fact label={t('groupPath.detail.gateRu')}>
          <Typography variant="body-sm" as="span" lang="ru" className={styles.text}>
            {step.gate.ru}
          </Typography>
        </Fact>
      )}
      {step.gate?.en && (
        <Fact label={t('groupPath.detail.gateEn')}>
          <Typography variant="body-sm" as="span" lang="en" className={styles.text}>
            {step.gate.en}
          </Typography>
        </Fact>
      )}
    </>
  );
}

type Translate = ReturnType<typeof useTranslation>['t'];

function originText(t: Translate, source: StepSource): string {
  const params = {
    id: source.id ?? '',
    project: source.project ?? '',
    plugin: source.plugin ?? '',
  };
  const own = t(`groupPath.detail.origin.${source.kind}`, params);
  // Шаг, превращённый в скилл: сперва — что с ним сделали, затем — где скилл лежит.
  return source.resourceType === 'skill'
    ? `${t('groupPath.detail.promotedSkill', params)} ${own}`
    : own;
}

function whereText(t: Translate, row: PathRow): string {
  if (row.kind === 'skill') return t('groupPath.detail.whereWhole');
  const { entry } = row;
  if (entry.kind === 'builtin') {
    return t('groupPath.detail.whereBuiltin', {
      number: PATH_ANCHORS.indexOf(entry.stage) + 1,
      total: PATH_ANCHORS.length,
    });
  }
  if (entry.kind === 'skill-step') {
    return t('groupPath.detail.whereSkill', { number: entry.index + 1, id: entry.skillId });
  }
  const { within } = entry.step;
  if (within) {
    return within.after
      ? t('groupPath.detail.whereWithin', { id: within.skillId, step: within.after })
      : t('groupPath.detail.whereWithinFirst', { id: within.skillId });
  }
  return t('groupPath.detail.whereAfter', { stage: t(`groupPath.stage.${entry.step.anchor}`) });
}
