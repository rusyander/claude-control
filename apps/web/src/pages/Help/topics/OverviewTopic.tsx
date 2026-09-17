import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { HelpSection, FieldTable, Callout, OptionCards } from '../ui';
import { OverviewGuideSections } from './OverviewGuideSections';
import { OverviewLimitsSections } from './OverviewLimitsSections';

/**
 * Документ раздела «Обзор».
 *
 * Порядок тот же, что у соседей: зачем это вообще → как устроено (лестница
 * выбора каталога и схема происхождения чисел) → два пути в снимках → чем раздел
 * НЕ является → что он читает и пишет → пределы и отказы → что стоит за каждой
 * плиткой → тонкости.
 *
 * Лестница выбора каталога осталась рукодельной: она показывает ПОРЯДОК из трёх
 * правил, и ради этого её и рисовали. Схема рядом отвечает на другой вопрос —
 * откуда взялось само число на плитке, — и одна другую не заменяет.
 */
export function OverviewTopic() {
  const { t } = useTranslation();
  const tr = (key: string): string => t(`help.topics.overview.${key}`);
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
            { title: tr('whyWhere'), text: tr('whyWhereText') },
            { title: tr('whyBroken'), text: tr('whyBrokenText') },
            { title: tr('whyEntry'), text: tr('whyEntryText') },
          ]}
        />
      </HelpSection>

      <OverviewGuideSections tr={tr} />

      <OverviewLimitsSections tr={tr} common={common} />

      <HelpSection title={tr('tilesTitle')} caption={tr('tilesCaption')}>
        <FieldTable
          nameHeader={common('fieldName')}
          descriptionHeader={common('fieldPurpose')}
          rows={[
            { name: tr('tileRules'), description: tr('tileRulesText'), isMono: false },
            { name: tr('tileScripts'), description: tr('tileScriptsText'), isMono: false },
            {
              name: tr('tileHooksBroken'),
              description: tr('tileHooksBrokenText'),
              isMono: false,
              badge: '!',
              badgeTone: 'danger',
            },
            { name: tr('tileMcp'), description: tr('tileMcpText'), isMono: false },
            { name: tr('tileGroups'), description: tr('tileGroupsText'), isMono: false },
            { name: tr('tileBackups'), description: tr('tileBackupsText'), isMono: false },
            { name: tr('tileContour'), description: tr('tileContourText'), isMono: false },
            { name: tr('tileChanges'), description: tr('tileChangesText'), isMono: false },
          ]}
        />
      </HelpSection>

      <HelpSection title={common('notesTitle')}>
        <Stack gap="var(--spacing-xs)">
          <Callout tone="warning" title={tr('noteZeroTitle')}>
            {tr('noteZeroText')}
          </Callout>
          <Callout tone="info" title={tr('noteLiveTitle')}>
            {tr('noteLiveText')}
          </Callout>
          <Callout tone="info" title={tr('noteMissingTitle')}>
            {tr('noteMissingText')}
          </Callout>
          <Callout tone="info" title={tr('noteHealthTitle')}>
            {tr('noteHealthText')}
          </Callout>
          <Callout tone="info" title={tr('noteToastTitle')}>
            {tr('noteToastText')}
          </Callout>
          <Callout tone="info" title={tr('noteCrashTitle')}>
            {tr('noteCrashText')}
          </Callout>
        </Stack>
      </HelpSection>
    </>
  );
}
