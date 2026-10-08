import { HelpSection, GuideSteps, GuideStep, HelpShot } from '../../ui';
import type { SectionProps } from './PhoneGuideSections.types';

/**
 * Три пути документа «Телефон» в снимках обеих сторон.
 *
 * Пути делятся по входу. Первый проходят один раз — спарить телефон, и кадры в
 * нём чередуются: карточка панели на компьютере, затем экран приложения. Второй
 * — обычный день, когда телефон уже подключён. Третий — «не отвечает»: вопрос,
 * с которым приходят чаще всего, и ответ на него должен быть виден, а не
 * выведен из схемы.
 */
export function PhoneGuideSections({ tr }: SectionProps) {
  const g = (key: string): string => tr(`guide.${key}`);
  return (
    <>
      <HelpSection title={g('pairTitle')} caption={g('pairCaption')}>
        <GuideSteps>
          <GuideStep title={g('pairOff')} text={g('pairOffText')}>
            <HelpShot topic="phone" scenario="pair" frame="01-remote-off" side="panel" />
          </GuideStep>
          <GuideStep title={g('pairOn')} text={g('pairOnText')}>
            <HelpShot topic="phone" scenario="pair" frame="02-remote-on" side="panel" />
          </GuideStep>
          <GuideStep title={g('pairCode')} text={g('pairCodeText')}>
            <HelpShot topic="phone" scenario="pair" frame="03-pairing-code" side="panel" />
          </GuideStep>
          <GuideStep title={g('pairPhone')} text={g('pairPhoneText')}>
            <HelpShot topic="phone" scenario="pair" frame="04-phone-not-paired" side="phone" />
          </GuideStep>
          <GuideStep title={g('pairScreen')} text={g('pairScreenText')}>
            <HelpShot topic="phone" scenario="pair" frame="05-phone-pair-screen" side="phone" />
          </GuideStep>
          <GuideStep title={g('pairOnline')} text={g('pairOnlineText')}>
            <HelpShot topic="phone" scenario="pair" frame="06-phone-online" side="phone" />
          </GuideStep>
        </GuideSteps>
      </HelpSection>

      <HelpSection title={g('dayTitle')} caption={g('dayCaption')}>
        <GuideSteps>
          <GuideStep title={g('dayHome')} text={g('dayHomeText')}>
            <HelpShot topic="phone" scenario="day" frame="01-home" side="phone" />
          </GuideStep>
          <GuideStep title={g('dayQuestions')} text={g('dayQuestionsText')}>
            <HelpShot topic="phone" scenario="day" frame="02-questions" side="phone" />
          </GuideStep>
          <GuideStep title={g('dayChat')} text={g('dayChatText')}>
            <HelpShot topic="phone" scenario="day" frame="03-chat" side="phone" />
          </GuideStep>
          <GuideStep title={g('dayAgent')} text={g('dayAgentText')}>
            <HelpShot topic="phone" scenario="day" frame="04-agent" side="phone" />
          </GuideStep>
          <GuideStep title={g('dayProjects')} text={g('dayProjectsText')}>
            <HelpShot topic="phone" scenario="day" frame="05-projects" side="phone" />
          </GuideStep>
          <GuideStep title={g('dayTests')} text={g('dayTestsText')}>
            <HelpShot topic="phone" scenario="day" frame="06-tests" side="phone" />
          </GuideStep>
          <GuideStep title={g('dayAnalytics')} text={g('dayAnalyticsText')}>
            <HelpShot topic="phone" scenario="day" frame="07-analytics" side="phone" />
          </GuideStep>
        </GuideSteps>
      </HelpSection>

      <HelpSection title={g('offTitle')} caption={g('offCaption')}>
        <GuideSteps>
          <GuideStep title={g('offHome')} text={g('offHomeText')}>
            <HelpShot topic="phone" scenario="offline" frame="01-home-silent" side="phone" />
          </GuideStep>
          <GuideStep title={g('offSettings')} text={g('offSettingsText')}>
            <HelpShot topic="phone" scenario="offline" frame="02-settings-silent" side="phone" />
          </GuideStep>
        </GuideSteps>
      </HelpSection>
    </>
  );
}
