import { HelpSection, StorageCard, FieldTable, CapabilityGrid } from '../ui';

interface SectionProps {
  /** Перевод ключа `help.topics.mcp.<key>`. */
  tr: (key: string) => string;
  /** Общий ключ справки: `help.common.<key>`. */
  common: (key: string) => string;
}

/**
 * Четыре обязательных блока раздела «MCP-серверы»: чем он НЕ является, что
 * пишет на диске, пределы и отказы.
 *
 * Порядок тот же, что у «Прав», и по той же причине: «это здесь или в соседнем
 * разделе» спрашивают до того, как что-то сломается, а таблицу отказов читают
 * уже с красной карточкой на экране.
 */
export function McpLimitsSections({ tr, common }: SectionProps) {
  return (
    <>
      <HelpSection title={tr('notTitle')} caption={tr('notCaption')}>
        <FieldTable
          nameHeader={tr('notColumn')}
          descriptionHeader={tr('notMeaningColumn')}
          rows={[
            { name: tr('notPermissions'), description: tr('notPermissionsText'), isMono: false },
            { name: tr('notEnv'), description: tr('notEnvText'), isMono: false },
            { name: tr('notProjects'), description: tr('notProjectsText'), isMono: false },
            { name: tr('notIntegrations'), description: tr('notIntegrationsText'), isMono: false },
            { name: tr('notSandbox'), description: tr('notSandboxText'), isMono: false },
          ]}
        />
      </HelpSection>

      <HelpSection title={common('storageTitle')}>
        <StorageCard
          title="~/.claude.json"
          rows={[
            { label: tr('storageFile'), value: tr('storageFileValue'), isMono: true },
            { label: tr('storageWhy'), value: tr('storageWhyValue') },
            { label: tr('storageOff'), value: tr('storageOffValue') },
            { label: tr('storageHealth'), value: tr('storageHealthValue'), isMono: true },
            { label: tr('storageTokens'), value: tr('storageTokensValue') },
            { label: tr('storageRestart'), value: tr('storageRestartValue') },
          ]}
        />
      </HelpSection>

      <HelpSection title={`${common('canTitle')} · ${common('cantTitle')}`}>
        <CapabilityGrid
          canTitle={common('canTitle')}
          cantTitle={common('cantTitle')}
          can={[
            tr('canPreset'),
            tr('canImport'),
            tr('canTransport'),
            tr('canHeaders'),
            tr('canOAuth'),
            tr('canAssistant'),
            tr('canHealth'),
            tr('canTools'),
            tr('canProbe'),
            tr('canToggle'),
            tr('canAutoCheck'),
          ]}
          cant={[
            tr('cantInstall'),
            tr('cantSecrets'),
            tr('cantPerTool'),
            tr('cantKeepRunning'),
            tr('cantDuplicate'),
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('refusalsTitle')} caption={tr('refusalsCaption')}>
        <FieldTable
          nameHeader={tr('refusalsColumn')}
          descriptionHeader={tr('refusalsMeaningColumn')}
          rows={[
            { name: tr('refusalProcess'), description: tr('refusalProcessText'), isMono: false },
            { name: tr('refusalVar'), description: tr('refusalVarText'), isMono: false },
            { name: tr('refusalRejected'), description: tr('refusalRejectedText'), isMono: false },
            { name: tr('refusalOauth'), description: tr('refusalOauthText'), isMono: false },
            { name: tr('refusalZero'), description: tr('refusalZeroText'), isMono: false },
            {
              name: tr('refusalInvisible'),
              description: tr('refusalInvisibleText'),
              isMono: false,
            },
          ]}
        />
      </HelpSection>
    </>
  );
}
