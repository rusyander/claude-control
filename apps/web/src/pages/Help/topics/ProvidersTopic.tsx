import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { PriorityLadder } from '@shared/ui/diagram';
import { HelpSection, StorageCard, FieldTable, Callout, OptionCards, StepList } from '../ui';

/**
 * Документ «Провайдеры» — единственный сквозной: он не про один раздел панели, а
 * про то, почему набор разделов меняется. Живёт рядом с «Настройками», потому
 * что переключатель провайдера стоит именно там.
 *
 * Карта возможностей набирается таблицей полей: строка — раздел панели, значение
 * — честный статус у каждого CLI. Дублировать её из кода нельзя (карта в коде —
 * машинная, здесь нужен человеческий разбор с причинами), поэтому при изменении
 * `providers/catalog.ts` эту таблицу правят руками.
 */
export function ProvidersTopic() {
  const { t } = useTranslation();
  const tr = (key: string): string => t(`help.topics.providers.${key}`);

  return (
    <>
      <HelpSection title={t('help.common.whyTitle')}>
        <OptionCards
          items={[
            { title: tr('whyOne'), text: tr('whyOneText') },
            { title: tr('whyDefault'), text: tr('whyDefaultText') },
            { title: tr('whySafe'), text: tr('whySafeText') },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('chooseTitle')} caption={tr('chooseCaption')}>
        <StepList
          steps={[
            { title: tr('chooseStep1'), text: tr('chooseStep1Text') },
            { title: tr('chooseStep2'), text: tr('chooseStep2Text') },
            { title: tr('chooseStep3'), text: tr('chooseStep3Text') },
            { title: tr('chooseStep4'), text: tr('chooseStep4Text') },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('statusTitle')} caption={tr('statusCaption')}>
        <OptionCards
          minWidth={260}
          items={[
            {
              title: tr('statusVerified'),
              text: tr('statusVerifiedText'),
              badge: tr('statusVerifiedBadge'),
              badgeTone: 'success',
            },
            {
              title: tr('statusExperimental'),
              text: tr('statusExperimentalText'),
              badge: tr('statusExperimentalBadge'),
              badgeTone: 'warning',
            },
            {
              title: tr('statusReady'),
              text: tr('statusReadyText'),
              badge: tr('statusReadyBadge'),
              badgeTone: 'success',
            },
            {
              title: tr('statusPlanned'),
              text: tr('statusPlannedText'),
              badge: tr('statusPlannedBadge'),
              badgeTone: 'info',
            },
            {
              title: tr('statusHidden'),
              text: tr('statusHiddenText'),
              badge: tr('statusHiddenBadge'),
              badgeTone: 'neutral',
            },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('mapTitle')} caption={tr('mapCaption')}>
        <FieldTable
          nameHeader={tr('mapSection')}
          descriptionHeader={tr('mapProviders')}
          rows={[
            { name: tr('mapInstructions'), description: tr('mapInstructionsValue'), isMono: false },
            { name: tr('mapMcp'), description: tr('mapMcpValue'), isMono: false },
            { name: tr('mapEnv'), description: tr('mapEnvValue'), isMono: false },
            { name: tr('mapPermissions'), description: tr('mapPermissionsValue'), isMono: false },
            { name: tr('mapChat'), description: tr('mapChatValue'), isMono: false },
            { name: tr('mapHooks'), description: tr('mapHooksValue'), isMono: false },
            { name: tr('mapPlugins'), description: tr('mapPluginsValue'), isMono: false },
            { name: tr('mapSkills'), description: tr('mapSkillsValue'), isMono: false },
            { name: tr('mapScripts'), description: tr('mapScriptsValue'), isMono: false },
            { name: tr('mapProjects'), description: tr('mapProjectsValue'), isMono: false },
            { name: tr('mapClaudeOnly'), description: tr('mapClaudeOnlyValue'), isMono: false },
            { name: tr('mapPanel'), description: tr('mapPanelValue'), isMono: false },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('gapTitle')} caption={tr('gapCaption')}>
        <OptionCards
          minWidth={320}
          items={[
            { title: tr('gapNone'), text: tr('gapNoneText') },
            { title: tr('gapNoFile'), text: tr('gapNoFileText') },
            { title: tr('gapReadOnly'), text: tr('gapReadOnlyText') },
            { title: tr('gapOwned'), text: tr('gapOwnedText') },
          ]}
        />
      </HelpSection>

      <HelpSection title={t('help.common.storageTitle')} caption={tr('filesCaption')}>
        <Stack gap="var(--spacing-xs)">
          <StorageCard
            title="Claude Code"
            rows={[
              { label: tr('fileInstructions'), value: '~/.claude/CLAUDE.md', isMono: true },
              { label: tr('fileRest'), value: tr('fileClaudeRest'), isMono: true },
            ]}
          />
          <StorageCard
            title="Codex (OpenAI)"
            rows={[
              { label: tr('fileInstructions'), value: '~/.codex/AGENTS.md', isMono: true },
              { label: tr('fileRest'), value: '~/.codex/config.toml', isMono: true },
              { label: tr('fileOverride'), value: 'CODEX_HOME', isMono: true },
            ]}
          />
          <StorageCard
            title="Gemini CLI"
            rows={[
              { label: tr('fileInstructions'), value: '~/.gemini/GEMINI.md', isMono: true },
              // settings.json обслуживает и MCP, и права (GEMINI-2); переменные
              // окружения у Gemini живут в отдельном .env (GEMINI-3).
              { label: tr('fileMcp'), value: '~/.gemini/settings.json', isMono: true },
              { label: tr('fileEnv'), value: '~/.gemini/.env', isMono: true },
            ]}
          />
          {/* Qwen Code — форк Gemini CLI: та же структура каталога, но свой ключ
              прав (tools.approvalMode + permissions.*) и своя переменная переноса
              каталога QWEN_HOME. */}
          <StorageCard
            title="Qwen Code"
            rows={[
              { label: tr('fileInstructions'), value: '~/.qwen/QWEN.md', isMono: true },
              { label: tr('fileMcp'), value: '~/.qwen/settings.json', isMono: true },
              { label: tr('fileEnv'), value: '~/.qwen/.env', isMono: true },
              { label: tr('fileOverride'), value: 'QWEN_HOME', isMono: true },
            ]}
          />
          {/* Continue: MCP и права лежат в РАЗНЫХ файлах одного каталога, а
              инструкций глобально нет вовсе — только каталог правил проекта. */}
          <StorageCard
            title="Continue"
            rows={[
              { label: tr('fileMcp'), value: '~/.continue/config.yaml', isMono: true },
              { label: tr('fileRest'), value: '~/.continue/permissions.yaml', isMono: true },
              { label: tr('fileEnv'), value: '~/.continue/.env', isMono: true },
              { label: tr('fileProject'), value: '<project>/.continue/rules/*.md', isMono: true },
            ]}
          />
          {/* Goose: один config.yaml держит и расширения (MCP), и режим аппрувов;
              путь под Windows отличается не только разделителями. */}
          <StorageCard
            title="Goose"
            rows={[
              { label: tr('fileInstructions'), value: '~/.config/goose/.goosehints', isMono: true },
              { label: tr('fileMcp'), value: '~/.config/goose/config.yaml', isMono: true },
              {
                label: tr('fileWindows'),
                value: '%APPDATA%\\Block\\goose\\config\\',
                isMono: true,
              },
              { label: tr('fileProject'), value: '<project>/.goosehints', isMono: true },
            ]}
          />
          {/* Kimi Code: MCP и права в РАЗНЫХ файлах одного каталога; проектного
              config.toml нет — CLI читает ровно один пользовательский файл. */}
          <StorageCard
            title="Kimi Code"
            rows={[
              { label: tr('fileInstructions'), value: '~/.kimi-code/AGENTS.md', isMono: true },
              { label: tr('fileMcp'), value: '~/.kimi-code/mcp.json', isMono: true },
              { label: tr('fileRest'), value: '~/.kimi-code/config.toml', isMono: true },
              { label: tr('fileOverride'), value: 'KIMI_CODE_HOME', isMono: true },
            ]}
          />
          <StorageCard
            title="Cursor"
            rows={[
              { label: tr('fileMcp'), value: '~/.cursor/mcp.json', isMono: true },
              { label: tr('fileRules'), value: '~/.cursor/rules/*.mdc', isMono: true },
            ]}
          />
          <StorageCard
            title="OpenCode"
            rows={[
              {
                label: tr('fileInstructions'),
                value: '~/.config/opencode/AGENTS.md',
                isMono: true,
              },
              // opencode.json обслуживает и MCP, и права (ключ `permission`, OPENCODE-1).
              { label: tr('fileMcp'), value: '~/.config/opencode/opencode.json', isMono: true },
              {
                label: tr('fileOverride'),
                value: 'XDG_CONFIG_HOME, OPENCODE_CONFIG',
                isMono: true,
              },
            ]}
          />
          {/* У Aider один файл обслуживает и инструкции (СПИСОК ссылок `read`),
              и переменные (`set-env`), и проектный уровень: конфиг ищется в
              домашнем каталоге и в корне git-репозитория. */}
          <StorageCard
            title="Aider"
            rows={[
              { label: tr('fileInstructions'), value: '~/.aider.conf.yml → read', isMono: true },
              { label: tr('fileEnv'), value: '~/.aider.conf.yml → set-env', isMono: true },
              { label: tr('fileProject'), value: '<project>/.aider.conf.yml', isMono: true },
            ]}
          />
        </Stack>
      </HelpSection>

      <HelpSection title={tr('runnerTitle')} caption={tr('runnerCaption')}>
        <PriorityLadder
          ariaLabel={tr('runnerTitle')}
          topLabel={tr('runnerTop')}
          bottomLabel={tr('runnerBottom')}
          steps={[
            { id: 'cli', label: 'CLI', caption: tr('runnerCli'), tone: 'accent' },
            { id: 'api', label: 'API', caption: tr('runnerApi'), tone: 'info' },
            { id: 'none', label: '—', caption: tr('runnerNone'), tone: 'warning' },
          ]}
        />
        <Callout tone="info" title={tr('runnerKeyTitle')}>
          {tr('runnerKeyText')}
        </Callout>
      </HelpSection>

      <HelpSection title={tr('notesTitle')}>
        <Stack gap="var(--spacing-xs)">
          <Callout tone="warning" title={tr('noteMissingTitle')}>
            {tr('noteMissingText')}
          </Callout>
          <Callout tone="info" title={tr('noteSafeTitle')}>
            {tr('noteSafeText')}
          </Callout>
          <Callout tone="info" title={tr('noteHistoryTitle')}>
            {tr('noteHistoryText')}
          </Callout>
          <Callout tone="danger" title={tr('noteFirstRunTitle')}>
            {tr('noteFirstRunText')}
          </Callout>
        </Stack>
      </HelpSection>
    </>
  );
}
