import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { HelpSection, FieldTable, Callout, OptionCards } from '../ui';
import { HistoryGuideSections } from './HistoryGuideSections';
import { HistoryLimitsSections } from './HistoryLimitsSections';

/**
 * Документ раздела «История изменений» — лента правок конфигурации с диффом.
 *
 * Порядок тот же, что у соседей: зачем это вообще → схема происхождения ленты →
 * путь в снимках до возврата блока → чем раздел НЕ является → что читает и пишет
 * → что умеет и чего нет → пределы → как читать строку ленты → тонкости.
 */
export function HistoryTopic() {
  const { t } = useTranslation();
  const tr = (key: string): string => t(`help.topics.history.${key}`);
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
            { title: tr('whyWhat'), text: tr('whyWhatText') },
            { title: tr('whyDiff'), text: tr('whyDiffText') },
            { title: tr('whyBack'), text: tr('whyBackText') },
          ]}
        />
      </HelpSection>

      <HistoryGuideSections tr={tr} />

      <HistoryLimitsSections tr={tr} common={common} />

      <HelpSection title={tr('rowTitle')} caption={tr('rowCaption')}>
        <FieldTable
          nameHeader={tr('rowColumn')}
          descriptionHeader={tr('rowMeaningColumn')}
          rows={[
            { name: tr('rowFile'), description: tr('rowFileText'), isMono: false },
            { name: tr('rowAgainst'), description: tr('rowAgainstText'), isMono: false },
            { name: tr('rowCurrent'), description: tr('rowCurrentText'), isMono: false },
            { name: tr('rowCounts'), description: tr('rowCountsText'), isMono: false },
            { name: tr('rowFirst'), description: tr('rowFirstText'), isMono: false },
            { name: tr('rowProvider'), description: tr('rowProviderText'), isMono: false },
          ]}
        />
      </HelpSection>

      <HelpSection title={common('notesTitle')}>
        <Stack gap="var(--spacing-xs)">
          <Callout tone="danger" title={tr('noteSecretTitle')}>
            {tr('noteSecretText')}
          </Callout>
          <Callout tone="warning" title={tr('noteRestartTitle')}>
            {tr('noteRestartText')}
          </Callout>
          <Callout tone="info" title={tr('noteRevertTitle')}>
            {tr('noteRevertText')}
          </Callout>
          <Callout tone="info" title={tr('noteWholeTitle')}>
            {tr('noteWholeText')}
          </Callout>
          <Callout tone="info" title={tr('noteBigTitle')}>
            {tr('noteBigText')}
          </Callout>
        </Stack>
      </HelpSection>
    </>
  );
}
