import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { HelpSection, Callout, OptionCards, FieldTable } from '../ui';
import { CompareGuideSections } from './CompareGuideSections';
import { CompareLimitsSections } from './CompareLimitsSections';

/**
 * Документ раздела «Сравнение конфигураций» — что где настроено и перенос между
 * CLI.
 *
 * Порядок тот же, что у соседей: зачем это вообще → схема охвата → два пути в
 * снимках → чем раздел НЕ является → что читает и пишет → что умеет и чего нет →
 * пределы и отказы → как читать строку → тонкости.
 */
export function CompareTopic() {
  const { t } = useTranslation();
  const tr = (key: string): string => t(`help.topics.compare.${key}`);
  const common = (key: string): string => t(`help.common.${key}`);

  return (
    <>
      {/* Страница длинная: первое, что ей нужно сказать, — из чего она состоит. */}
      <Callout tone="info" title={tr('guideTitle')}>
        {tr('guideText')}
      </Callout>

      <HelpSection title={common('whyTitle')}>
        <OptionCards
          items={[
            { title: tr('whyMemory'), text: tr('whyMemoryText') },
            { title: tr('whyMeaning'), text: tr('whyMeaningText') },
            { title: tr('whyMove'), text: tr('whyMoveText') },
          ]}
        />
      </HelpSection>

      <CompareGuideSections tr={tr} />

      <CompareLimitsSections tr={tr} common={common} />

      <HelpSection title={tr('readTitle')} caption={tr('readCaption')}>
        <FieldTable
          nameHeader={tr('readColumn')}
          descriptionHeader={tr('readMeaningColumn')}
          rows={[
            { name: tr('readSame'), description: tr('readSameText'), isMono: false },
            { name: tr('readDiffers'), description: tr('readDiffersText'), isMono: false },
            { name: tr('readOnly'), description: tr('readOnlyText'), isMono: false },
            {
              name: tr('readSecret'),
              description: tr('readSecretText'),
              isMono: false,
              badge: '!',
              badgeTone: 'danger',
            },
            { name: tr('readBlocked'), description: tr('readBlockedText'), isMono: false },
          ]}
        />
      </HelpSection>

      <HelpSection title={common('notesTitle')}>
        <Stack gap="var(--spacing-xs)">
          <Callout tone="warning" title={tr('noteTitle')}>
            {tr('noteText')}
          </Callout>
          <Callout tone="info" title={tr('noteActiveTitle')}>
            {tr('noteActiveText')}
          </Callout>
          <Callout tone="info" title={tr('notePreviewTitle')}>
            {tr('notePreviewText')}
          </Callout>
          <Callout tone="info" title={tr('noteRestartTitle')}>
            {tr('noteRestartText')}
          </Callout>
        </Stack>
      </HelpSection>
    </>
  );
}
