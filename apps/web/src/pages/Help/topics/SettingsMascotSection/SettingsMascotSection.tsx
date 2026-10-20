import { Stack } from '@shared/ui/stack';
import { HelpSection, Callout, GuideSteps, GuideStep, HelpShot } from '../../ui';
import type { SectionProps } from './SettingsMascotSection.types';

/**
 * Маскот «Дека» в документе «Настройки»: где он стоит, что значит его вид,
 * что в сводке и как его приглушить или спрятать — кадрами настоящей панели
 * (`tools/help-shots/settings-mascot.mjs`).
 *
 * Раздел в «Настройках», потому что выключатель живёт там; «чего Дека не
 * делает» — после шагов: вопрос «а он не будет мешать?» встаёт, когда его уже
 * увидели.
 */
export function SettingsMascotSection({ tr }: SectionProps) {
  const g = (key: string): string => tr(`mascot.${key}`);

  return (
    <HelpSection title={g('title')} caption={g('caption')}>
      <Stack gap="var(--spacing-md)">
        <GuideSteps>
          <GuideStep title={g('where')} text={g('whereText')}>
            <HelpShot topic="settings" scenario="mascot" frame="01-ask" side="panel" />
          </GuideStep>
          <GuideStep title={g('panel')} text={g('panelText')}>
            <HelpShot topic="settings" scenario="mascot" frame="02-panel" side="panel" />
          </GuideStep>
          <GuideStep title={g('chat')} text={g('chatText')}>
            <HelpShot topic="settings" scenario="mascot" frame="03-chat" side="panel" />
          </GuideStep>
          <GuideStep title={g('settings')} text={g('settingsText')}>
            <HelpShot topic="settings" scenario="mascot" frame="04-settings" side="panel" />
          </GuideStep>
        </GuideSteps>

        <Callout tone="info" title={g('quietTitle')}>
          {g('quietText')}
        </Callout>
      </Stack>
    </HelpSection>
  );
}
