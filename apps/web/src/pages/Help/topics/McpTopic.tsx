import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { HelpSection, FieldTable, Callout, OptionCards } from '../ui';
import { McpGuideSections } from './McpGuideSections';
import { McpLimitsSections } from './McpLimitsSections';

/**
 * Документ раздела «MCP-серверы».
 *
 * Порядок задан вопросами, в которых человек приходит: зачем это вообще → как
 * устроено (две схемы) → весь путь в снимках, двумя сценариями по входу → чем
 * раздел НЕ является → что пишет на диске → пределы и отказы → справочные
 * таблицы → тонкости.
 *
 * Рукодельной схемы здесь больше нет: её место заняли две сгенерированные,
 * которые показывают то, чего абстрактная цепочка «конфиг → старт → список →
 * работа» не показывала, — развилки отказа и границу ответственности панели.
 */
export function McpTopic() {
  const { t } = useTranslation();
  const tr = (key: string): string => t(`help.topics.mcp.${key}`);
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
            { title: tr('whyTools'), text: tr('whyToolsText') },
            { title: tr('whyCheck'), text: tr('whyCheckText') },
            { title: tr('whyImport'), text: tr('whyImportText') },
          ]}
        />
      </HelpSection>

      <McpGuideSections tr={tr} />

      <McpLimitsSections tr={tr} common={common} />

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
          nameHeader={common('fieldName')}
          descriptionHeader={common('fieldPurpose')}
          rows={[
            {
              name: 'name',
              description: tr('fieldName'),
              badge: common('required'),
              badgeTone: 'accent',
            },
            {
              name: 'transport',
              description: tr('fieldTransport'),
              badge: common('required'),
              badgeTone: 'accent',
            },
            { name: 'command', description: tr('fieldCommand') },
            { name: 'args', description: tr('fieldArgs') },
            { name: 'url', description: tr('fieldUrl') },
            { name: 'env', description: tr('fieldEnv') },
            { name: 'headers', description: tr('fieldHeaders') },
            { name: 'health', description: tr('fieldHealth'), badge: common('readOnly') },
            { name: 'toolCount', description: tr('fieldTools'), badge: common('readOnly') },
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
