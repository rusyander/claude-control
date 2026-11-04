import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import {
  HelpSection,
  FieldTable,
  Callout,
  OptionCards,
  GuideSteps,
  GuideStep,
  HelpShot,
} from '../../ui';

/**
 * Документ «Песочница».
 *
 * Своей страницы у песочницы нет — она открывается окном из раздела настройки, поэтому первым
 * идёт «чем проверяется каждый вид»: без этого человек ищет разговор у хука. Раздел «что видит
 * Claude Code внутри» обязателен: без него ответ без правила выглядит поломкой, а не следствием
 * того, что настоящие слои в песочницу не попадают.
 */
export function SandboxTopic() {
  const { t } = useTranslation();
  const tr = (key: string): string => t(`help.topics.sandbox.${key}`);
  const common = (key: string): string => t(`help.common.${key}`);
  const row = (key: string) => ({
    name: tr(key),
    description: tr(`${key}Text`),
    isMono: false,
  });

  return (
    <>
      <Callout tone="info" title={tr('guideTitle')}>
        {tr('guideText')}
      </Callout>

      <HelpSection title={common('whyTitle')}>
        <OptionCards
          items={[
            { title: tr('whyIsolated'), text: tr('whyIsolatedText') },
            { title: tr('whySafe'), text: tr('whySafeText') },
            { title: tr('whyCompare'), text: tr('whyCompareText') },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('kindsTitle')} caption={tr('kindsCaption')}>
        <FieldTable
          nameHeader={tr('kindHeader')}
          descriptionHeader={tr('kindWhat')}
          rows={[row('kindProbe'), row('kindTools'), row('kindChat')]}
        />
      </HelpSection>

      <HelpSection title={tr('stepsTitle')} caption={tr('stepsCaption')}>
        <GuideSteps>
          <GuideStep title={tr('stepComposition')} text={tr('stepCompositionText')}>
            <HelpShot topic="sandbox" scenario="conversation" frame="01-composition" side="panel" />
          </GuideStep>
          <GuideStep title={tr('stepWaiting')} text={tr('stepWaitingText')}>
            <HelpShot topic="sandbox" scenario="conversation" frame="02-waiting" side="panel" />
          </GuideStep>
          <GuideStep title={tr('stepAnswer')} text={tr('stepAnswerText')}>
            <HelpShot topic="sandbox" scenario="conversation" frame="03-answer" side="panel" />
          </GuideStep>
          <GuideStep title={tr('stepRefused')} text={tr('stepRefusedText')}>
            <HelpShot topic="sandbox" scenario="conversation" frame="04-refused" side="panel" />
          </GuideStep>
        </GuideSteps>
      </HelpSection>

      <HelpSection title={tr('insideTitle')} caption={tr('insideCaption')}>
        <FieldTable
          nameHeader={tr('insideHeader')}
          descriptionHeader={tr('insideWhat')}
          rows={[row('insideConfig'), row('insideSources'), row('insideBrief'), row('insideStop')]}
        />
      </HelpSection>

      <HelpSection title={tr('notesTitle')}>
        <Stack gap="var(--spacing-xs)">
          {['noteMemory', 'noteExpired', 'noteApiKey', 'noteCore'].map((key) => (
            <Callout key={key} tone="info" title={tr(`${key}Title`)}>
              {tr(key)}
            </Callout>
          ))}
        </Stack>
      </HelpSection>

      <HelpSection title={tr('cantTitle')}>
        <Stack gap="var(--spacing-xs)">
          {['cantOtherCli', 'cantKeep', 'cantReal'].map((key) => (
            <Callout key={key} tone="warning" title={tr(`${key}Title`)}>
              {tr(key)}
            </Callout>
          ))}
        </Stack>
      </HelpSection>
    </>
  );
}
