import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { PriorityLadder } from '@shared/ui/diagram';
import { HelpSection, FieldTable, Callout, CapabilityGrid, OptionCards } from '../ui';

/**
 * Документ раздела «Обзор».
 *
 * Схемы потока здесь нет намеренно: страница ничего не делает, а только
 * показывает. Зато есть лестница — порядок поиска каталога конфигурации,
 * из-за которого чаще всего и возникают вопросы к этой странице.
 */
export function OverviewTopic() {
  const { t } = useTranslation();
  const tr = (key: string): string => t(`help.topics.overview.${key}`);

  return (
    <>
      <HelpSection title={t('help.common.whyTitle')}>
        <OptionCards
          items={[
            { title: tr('whyWhere'), text: tr('whyWhereText') },
            { title: tr('whyBroken'), text: tr('whyBrokenText') },
            { title: tr('whyEntry'), text: tr('whyEntryText') },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('sourceTitle')} caption={tr('sourceCaption')}>
        <PriorityLadder
          ariaLabel={tr('sourceTitle')}
          topLabel={tr('sourceTop')}
          steps={[
            { id: 'manual', label: 'manual', caption: tr('sourceManual'), tone: 'accent' },
            { id: 'env', label: 'env', caption: tr('sourceEnv'), tone: 'info' },
            { id: 'home', label: 'home', caption: tr('sourceHome') },
          ]}
        />
        <Callout tone="info" title={tr('sourceNote')} />
      </HelpSection>

      <HelpSection title={`${t('help.common.canTitle')} · ${t('help.common.cantTitle')}`}>
        <CapabilityGrid
          canTitle={t('help.common.canTitle')}
          cantTitle={t('help.common.cantTitle')}
          can={[
            tr('canSee'),
            tr('canPath'),
            tr('canMissing'),
            tr('canBroken'),
            tr('canBackups'),
            tr('canChanges'),
            tr('canJump'),
          ]}
          cant={[tr('cantEdit'), tr('cantDeep')]}
        />
      </HelpSection>

      <HelpSection title={tr('tilesTitle')}>
        <FieldTable
          nameHeader={t('help.common.fieldName')}
          descriptionHeader={t('help.common.fieldPurpose')}
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
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('notesTitle')}>
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
          <Callout tone="info" title={tr('noteToastTitle')}>
            {tr('noteToastText')}
          </Callout>
        </Stack>
      </HelpSection>
    </>
  );
}
