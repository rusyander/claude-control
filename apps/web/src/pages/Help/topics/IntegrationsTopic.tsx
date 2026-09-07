import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { HelpSection, StorageCard, FieldTable, Callout, OptionCards, StepList } from '../ui';

/**
 * Документ «Интеграции» — про вкладку настроек и про то, что она включает в
 * остальных разделах: привязку проекта, публикацию отчёта, дефекты в Jira.
 *
 * Живёт в группе «Интеграции» рядом с MCP намеренно: вопрос у читателя один —
 * «как панель разговаривает с чужими системами», и MCP отвечает на его половину
 * со стороны агента, а этот документ — со стороны человека.
 */
export function IntegrationsTopic() {
  const { t } = useTranslation();
  const tr = (key: string): string => t(`help.topics.integrations.${key}`);

  return (
    <>
      <HelpSection title={t('help.common.whyTitle')}>
        <OptionCards
          items={[
            { title: tr('whyOne'), text: tr('whyOneText') },
            { title: tr('whyBoth'), text: tr('whyBothText') },
            { title: tr('whySecret'), text: tr('whySecretText') },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('stepsTitle')} caption={tr('stepsCaption')}>
        <StepList
          steps={[
            { title: tr('step1'), text: tr('step1Text') },
            { title: tr('step2'), text: tr('step2Text') },
            { title: tr('step3'), text: tr('step3Text') },
            { title: tr('step4'), text: tr('step4Text') },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('cardsTitle')} caption={tr('cardsCaption')}>
        <FieldTable
          nameHeader={tr('cardsHeader')}
          descriptionHeader={tr('cardsWhat')}
          rows={[
            { name: tr('cardAtlassian'), description: tr('cardAtlassianText'), isMono: false },
            { name: tr('cardForge'), description: tr('cardForgeText'), isMono: false },
            { name: tr('cardTelegram'), description: tr('cardTelegramText'), isMono: false },
            { name: tr('cardTms'), description: tr('cardTmsText'), isMono: false },
            { name: tr('cardCi'), description: tr('cardCiText'), isMono: false },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('linksTitle')} caption={tr('linksCaption')}>
        <FieldTable
          nameHeader={t('help.common.fieldName')}
          descriptionHeader={t('help.common.fieldPurpose')}
          rows={[
            { name: 'jiraIssueKey', description: tr('fieldIssue') },
            { name: 'jiraProjectKey', description: tr('fieldProject') },
            { name: 'confluencePageId', description: tr('fieldPage') },
            { name: 'forgeRepo', description: tr('fieldRepo') },
            { name: 'note', description: tr('fieldNote') },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('testsTitle')} caption={tr('testsCaption')}>
        <OptionCards
          items={[
            { title: tr('testsDefect'), text: tr('testsDefectText') },
            { title: tr('testsPublish'), text: tr('testsPublishText') },
            { title: tr('testsPdf'), text: tr('testsPdfText') },
            { title: tr('testsBaseline'), text: tr('testsBaselineText') },
          ]}
        />
      </HelpSection>

      <HelpSection title={t('help.common.storageTitle')} caption={tr('filesCaption')}>
        <Stack gap="var(--spacing-xs)">
          <StorageCard
            title={tr('filePanelTitle')}
            rows={[
              {
                label: tr('fileSettings'),
                value: '~/.claude/agentdeck/state.json',
                isMono: true,
              },
              {
                label: tr('fileToken'),
                value: '~/.claude/agentdeck/provider-keys.enc',
                isMono: true,
              },
            ]}
          />
          <StorageCard
            title={tr('fileProjectTitle')}
            rows={[
              { label: tr('fileBaselines'), value: '.agent/tests/baselines/', isMono: true },
              { label: tr('fileAttachments'), value: '.agent/tests/attachments/', isMono: true },
            ]}
          />
        </Stack>
      </HelpSection>

      <HelpSection title={t('help.common.notesTitle')}>
        <Stack gap="var(--spacing-xs)">
          <Callout tone="danger" title={tr('noteTokenTitle')}>
            {tr('noteTokenText')}
          </Callout>
          <Callout tone="warning" title={tr('noteWritesTitle')}>
            {tr('noteWritesText')}
          </Callout>
          <Callout tone="info" title={tr('noteOfflineTitle')}>
            {tr('noteOfflineText')}
          </Callout>
          <Callout tone="info" title={tr('noteMcpTitle')}>
            {tr('noteMcpText')}
          </Callout>
        </Stack>
      </HelpSection>
    </>
  );
}
