import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { HelpSection, StorageCard, FieldTable, Callout, OptionCards } from '../ui';
import { EndpointsGuideSections } from './EndpointsGuideSections';
import { EndpointsLimitsSections } from './EndpointsLimitsSections';

/**
 * Документ «Свой эндпоинт» — второй сквозной после «Провайдеров»: блок стоит в
 * «Настройках», но правит окружение выбранного CLI, а не настройки панели.
 *
 * Таблица «кто принимает профиль» набрана руками и повторяет поле
 * `endpointConfig` каталога провайдеров. Дублирование намеренное: в коде лежат
 * имена переменных, здесь — причина, по которой у соседа их нет. Меняется
 * `endpointConfig` — правится эта таблица.
 *
 * Рукописных шагов заведения профиля здесь больше нет: те же шаги показаны
 * кадрами настоящего блока в `EndpointsGuideSections`.
 */
export function EndpointsTopic() {
  const { t } = useTranslation();
  const tr = (key: string): string => t(`help.topics.endpoints.${key}`);
  const common = (key: string): string => t(`help.common.${key}`);

  return (
    <>
      {/* Документ длинный: первым делом он говорит, из чего состоит. */}
      <Callout tone="info" title={tr('guideTitle')}>
        {tr('guideText')}
      </Callout>

      <HelpSection title={common('whyTitle')}>
        <OptionCards
          items={[
            { title: tr('whyLocal'), text: tr('whyLocalText') },
            { title: tr('whyOnce'), text: tr('whyOnceText') },
            { title: tr('whySecret'), text: tr('whySecretText') },
          ]}
        />
      </HelpSection>

      <EndpointsGuideSections tr={tr} />

      <EndpointsLimitsSections tr={tr} common={common} />

      <HelpSection title={tr('kindTitle')} caption={tr('kindCaption')}>
        <FieldTable
          nameHeader={tr('kindHeader')}
          descriptionHeader={tr('kindWhen')}
          rows={[
            { name: 'openai-compat', description: tr('kindOpenai') },
            { name: 'anthropic', description: tr('kindAnthropic') },
            { name: 'google', description: tr('kindGoogle') },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('targetsTitle')} caption={tr('targetsCaption')}>
        <FieldTable
          nameHeader={tr('targetsCli')}
          descriptionHeader={tr('targetsVars')}
          rows={[
            {
              name: 'Claude Code',
              description: tr('targetClaude'),
              isMono: false,
              badge: 'anthropic',
              badgeTone: 'success',
            },
            {
              name: 'Gemini CLI',
              description: tr('targetGemini'),
              isMono: false,
              badge: 'google',
              badgeTone: 'success',
            },
            {
              name: 'Qwen Code',
              description: tr('targetQwen'),
              isMono: false,
              badge: 'openai-compat',
              badgeTone: 'success',
              badge2: 'anthropic',
              badge2Tone: 'success',
            },
            {
              name: 'Aider',
              description: tr('targetAider'),
              isMono: false,
              badge: 'openai-compat',
              badgeTone: 'success',
            },
            {
              name: tr('targetAssistant'),
              description: tr('targetAssistantText'),
              isMono: false,
              badge: tr('targetAnyKind'),
              badgeTone: 'info',
            },
            {
              name: 'Codex, Continue',
              description: tr('targetNoVar'),
              isMono: false,
              badge: tr('targetSkipped'),
              badgeTone: 'neutral',
            },
            {
              name: 'Goose, Kimi Code, Cursor, OpenCode',
              description: tr('targetNoEnv'),
              isMono: false,
              badge: tr('targetSkipped'),
              badgeTone: 'neutral',
            },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('filesTitle')} caption={tr('filesCaption')}>
        <Stack gap="var(--spacing-xs)">
          <StorageCard
            title={tr('filePanelTitle')}
            rows={[
              {
                label: tr('fileProfiles'),
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
            title={tr('fileCliTitle')}
            rows={[
              { label: 'Claude Code', value: '~/.claude/settings.json → env', isMono: true },
              { label: 'Gemini CLI', value: '~/.gemini/.env', isMono: true },
              { label: 'Qwen Code', value: '~/.qwen/.env', isMono: true },
              { label: 'Aider', value: '~/.aider.conf.yml → set-env', isMono: true },
            ]}
          />
        </Stack>
      </HelpSection>

      <HelpSection title={tr('notesTitle')}>
        <Stack gap="var(--spacing-xs)">
          <Callout tone="info" title={tr('noteProbeTitle')}>
            {tr('noteProbeText')}
          </Callout>
          <Callout tone="warning" title={tr('noteTokenTitle')}>
            {tr('noteTokenText')}
          </Callout>
          <Callout tone="info" title={tr('noteAssistantTitle')}>
            {tr('noteAssistantText')}
          </Callout>
          <Callout tone="warning" title={tr('noteRestartTitle')}>
            {tr('noteRestartText')}
          </Callout>
          <Callout tone="danger" title={tr('notePrivacyTitle')}>
            {tr('notePrivacyText')}
          </Callout>
        </Stack>
      </HelpSection>
    </>
  );
}
