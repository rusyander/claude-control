import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { FlowDiagram } from '@shared/ui/diagram';
import {
  HelpSection,
  StorageCard,
  FieldTable,
  StepList,
  Callout,
  CapabilityGrid,
  OptionCards,
} from '../ui';

/** Документ раздела «MCP-серверы». */
export function McpTopic() {
  const { t } = useTranslation();
  const tr = (key: string): string => t(`help.topics.mcp.${key}`);

  return (
    <>
      <HelpSection title={t('help.common.whyTitle')}>
        <OptionCards
          items={[
            { title: tr('whyTools'), text: tr('whyToolsText') },
            { title: tr('whyCheck'), text: tr('whyCheckText') },
            { title: tr('whyImport'), text: tr('whyImportText') },
          ]}
        />
      </HelpSection>

      <HelpSection title={t('help.common.storageTitle')}>
        <StorageCard
          title="~/.claude.json"
          rows={[
            { label: tr('storageFile'), value: tr('storageFileValue'), isMono: true },
            { label: tr('storageWhy'), value: tr('storageWhyValue') },
            { label: tr('storageOff'), value: tr('storageOffValue') },
            { label: tr('storageRestart'), value: tr('storageRestartValue') },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('flowTitle')} caption={tr('flowCaption')}>
        <FlowDiagram
          ariaLabel={tr('flowTitle')}
          nodes={[
            {
              id: 'config',
              label: tr('flowConfig'),
              caption: tr('flowConfigCaption'),
              tone: 'accent',
              icon: 'mcp',
            },
            {
              id: 'start',
              label: tr('flowStart'),
              caption: tr('flowStartCaption'),
              tone: 'info',
              icon: 'refresh',
            },
            {
              id: 'list',
              label: tr('flowList'),
              caption: tr('flowListCaption'),
              icon: 'file',
            },
            {
              id: 'use',
              label: tr('flowUse'),
              caption: tr('flowUseCaption'),
              tone: 'success',
              icon: 'check',
            },
          ]}
        />
      </HelpSection>

      <HelpSection title={`${t('help.common.canTitle')} · ${t('help.common.cantTitle')}`}>
        <CapabilityGrid
          canTitle={t('help.common.canTitle')}
          cantTitle={t('help.common.cantTitle')}
          can={[
            tr('canPreset'),
            tr('canImport'),
            tr('canTransport'),
            tr('canHeaders'),
            tr('canOAuth'),
            tr('canAssistant'),
            tr('canHealth'),
            tr('canProbe'),
            tr('canToggle'),
            tr('canAutoCheck'),
          ]}
          cant={[tr('cantInstall'), tr('cantSecrets'), tr('cantPerTool')]}
        />
      </HelpSection>

      <HelpSection title={tr('transportTitle')} caption={tr('transportCaption')}>
        <OptionCards
          items={[
            { title: tr('transportStdio'), text: tr('transportStdioText') },
            { title: tr('transportSse'), text: tr('transportSseText') },
            { title: tr('transportHttp'), text: tr('transportHttpText') },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('presetsTitle')} caption={tr('presetsCaption')}>
        <OptionCards
          items={[
            { title: tr('presetFs'), text: tr('presetFsText') },
            { title: tr('presetGithub'), text: tr('presetGithubText') },
            { title: tr('presetGitlab'), text: tr('presetGitlabText') },
            { title: tr('presetPostgres'), text: tr('presetPostgresText') },
            { title: tr('presetPlaywright'), text: tr('presetPlaywrightText') },
            { title: tr('presetSse'), text: tr('presetSseText') },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('importTitle')} caption={tr('importCaption')}>
        <Callout tone="info" title={tr('importNote')} />
      </HelpSection>

      <HelpSection title={tr('fieldsTitle')}>
        <FieldTable
          caption={tr('fieldsCaption')}
          nameHeader={t('help.common.fieldName')}
          descriptionHeader={t('help.common.fieldPurpose')}
          rows={[
            {
              name: 'name',
              description: tr('fieldName'),
              badge: t('help.common.required'),
              badgeTone: 'accent',
            },
            {
              name: 'transport',
              description: tr('fieldTransport'),
              badge: t('help.common.required'),
              badgeTone: 'accent',
            },
            { name: 'command', description: tr('fieldCommand') },
            { name: 'args', description: tr('fieldArgs') },
            { name: 'url', description: tr('fieldUrl') },
            { name: 'env', description: tr('fieldEnv') },
            { name: 'headers', description: tr('fieldHeaders') },
            {
              name: 'health',
              description: tr('fieldHealth'),
              badge: t('help.common.readOnly'),
            },
            {
              name: 'toolCount',
              description: tr('fieldTools'),
              badge: t('help.common.readOnly'),
            },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('recipesTitle')}>
        <StepList
          steps={[
            { title: tr('recipe1'), text: tr('recipe1Text') },
            { title: tr('recipe2'), text: tr('recipe2Text') },
            { title: tr('recipe3'), text: tr('recipe3Text') },
            { title: tr('recipe4'), text: tr('recipe4Text') },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('notesTitle')}>
        <Stack gap="var(--spacing-xs)">
          <Callout tone="danger" title={tr('noteSecretTitle')}>
            {tr('noteSecretText')}
          </Callout>
          <Callout tone="warning" title={tr('noteRestartTitle')}>
            {tr('noteRestartText')}
          </Callout>
          <Callout tone="success" title={tr('noteHandshakeTitle')}>
            {tr('noteHandshakeText')}
          </Callout>
          <Callout tone="info" title={tr('noteHealthTitle')}>
            {tr('noteHealthText')}
          </Callout>
          <Callout tone="info" title={tr('noteTimeoutTitle')}>
            {tr('noteTimeoutText')}
          </Callout>
          <Callout tone="info" title={tr('noteWindowsTitle')}>
            {tr('noteWindowsText')}
          </Callout>
          <Callout tone="info" title={tr('noteProjectTitle')}>
            {tr('noteProjectText')}
          </Callout>
          <Callout tone="info" title={tr('noteProviderTitle')}>
            {tr('noteProviderText')}
          </Callout>
        </Stack>
      </HelpSection>
    </>
  );
}
