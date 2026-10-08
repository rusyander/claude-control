import { Stack } from '@shared/ui/stack';
import { HelpSection, Callout, GuideSteps, GuideStep, HelpShot } from '../../ui';
import type { SectionProps } from './SettingsGlobalLayerSection.types';

/**
 * Вкладка «Глобальный слой» в документе «Настройки»: сверка, итог, отметка
 * правки, перенос и запись предложения — кадрами настоящей панели на
 * одноразовом стенде (`tools/help-shots/settings-global-layer.mjs`).
 *
 * «Сама панель слой не правит» стоит после шагов: это ответ на вопрос, который
 * появляется у кнопки «Записать», а не до первой сверки.
 */
export function SettingsGlobalLayerSection({ tr }: SectionProps) {
  const g = (key: string): string => tr(`globalLayer.${key}`);

  return (
    <HelpSection title={g('title')} caption={g('caption')}>
      <Stack gap="var(--spacing-md)">
        <GuideSteps>
          <GuideStep title={g('open')} text={g('openText')}>
            <HelpShot topic="settings" scenario="global-layer" frame="01-verdict" side="panel" />
          </GuideStep>
          <GuideStep title={g('read')} text={g('readText')}>
            <HelpShot topic="settings" scenario="global-layer" frame="02-cases" side="panel" />
          </GuideStep>
          <GuideStep title={g('changed')} text={g('changedText')}>
            <HelpShot topic="settings" scenario="global-layer" frame="03-changed" side="panel" />
          </GuideStep>
          <GuideStep title={g('transfer')} text={g('transferText')} />
          <GuideStep title={g('proposal')} text={g('proposalText')}>
            <HelpShot topic="settings" scenario="global-layer" frame="04-proposal" side="panel" />
          </GuideStep>
        </GuideSteps>

        <Callout tone="info" title={g('neverTitle')}>
          {g('neverText')}
        </Callout>
      </Stack>
    </HelpSection>
  );
}
