import { useTranslation } from 'react-i18next';
import { HelpSection, FieldTable, Callout, OptionCards, HelpDiagram } from '../ui';
import { PhoneGuideSections } from './PhoneGuideSections';
import { PhoneLimitsSections } from './PhoneLimitsSections';

/**
 * Документ «Телефон» — приложение для Android над той же панелью.
 *
 * Главное, что он обязан донести: телефон — окно в ЭТУ панель, а не вторая
 * панель. Своих данных у него нет, поэтому схема пути запроса стоит до снимков:
 * без неё «не отвечает» на телефоне читается как поломка приложения, а это
 * почти всегда спящий компьютер или выключенный Tailscale.
 */
export function PhoneTopic() {
  const { t } = useTranslation();
  const tr = (key: string): string => t(`help.topics.phone.${key}`);
  const row = (key: string) => ({ name: tr(key), description: tr(`${key}Text`), isMono: false });

  return (
    <>
      <Callout tone="info" title={tr('guideTitle')}>
        {tr('guideText')}
      </Callout>

      <HelpSection title={tr('whyTitle')}>
        <OptionCards
          items={[
            { title: tr('whyAway'), text: tr('whyAwayText') },
            { title: tr('whyAnswer'), text: tr('whyAnswerText') },
            { title: tr('whySame'), text: tr('whySameText') },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('mapTitle')} caption={tr('mapCaption')}>
        <HelpDiagram topic="phone" name="phone-path" />
        {/* Тот же путь словами: справку читают и без картинок. */}
        <Callout tone="info" title={tr('mapTextTitle')}>
          {tr('mapTextText')}
        </Callout>
      </HelpSection>

      <PhoneGuideSections tr={tr} />

      <HelpSection title={tr('screensTitle')} caption={tr('screensCaption')}>
        <FieldTable
          nameHeader={tr('screenColumn')}
          descriptionHeader={tr('screenWhatColumn')}
          rows={[
            row('screenHome'),
            row('screenQuestions'),
            row('screenChat'),
            row('screenAgent'),
            row('screenProjects'),
            row('screenTests'),
            row('screenAnalytics'),
            row('screenSettings'),
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('offlineTitle')} caption={tr('offlineCaption')}>
        <FieldTable
          nameHeader={tr('offlineColumn')}
          descriptionHeader={tr('offlineMeaningColumn')}
          rows={[
            row('offlineLast'),
            row('offlineStream'),
            row('offlineAgent'),
            row('offlineQueue'),
            row('offlineAnswered'),
            row('offlinePush'),
            row('offlineAwake'),
          ]}
        />
      </HelpSection>

      <PhoneLimitsSections tr={tr} />
    </>
  );
}
