import { HelpSection, GuideSteps, GuideStep, HelpShot } from '../ui';

interface SectionProps {
  /** Перевод ключа `help.topics.portability.<key>` — словарь у документа один. */
  tr: (key: string) => string;
}

/**
 * Середина документа «Паспорт среды»: три пути в снимках.
 *
 * Путей ровно три, потому что вопросов три и они РАЗНЫЕ. «Перенеси то, что
 * есть сейчас» — разовый перенос, он кончается применённым планом и кнопкой
 * отмены. «Держи это согласованным» — подписка, она не кончается вовсе, и её
 * главный шаг не пересборка, а правка руками: единственное место во всём
 * разделе, где панель обязана остановиться и спросить. «А работа?» — перенос
 * незакрытых разговоров, и он стоит последним, потому что возникает уже ПОСЛЕ
 * переезда среды: человек открыл новый CLI и обнаружил, что работа осталась в
 * старом.
 */
export function PortabilityGuideSections({ tr }: SectionProps) {
  const g = (key: string): string => tr(`guide.${key}`);

  return (
    <>
      <HelpSection title={g('transferTitle')} caption={g('transferCaption')}>
        <GuideSteps>
          <GuideStep title={g('transferPassport')} text={g('transferPassportText')}>
            <HelpShot topic="portability" scenario="transfer" frame="01-passport" side="panel" />
          </GuideStep>
          <GuideStep title={g('transferFidelity')} text={g('transferFidelityText')}>
            <HelpShot topic="portability" scenario="transfer" frame="02-fidelity" side="panel" />
          </GuideStep>
          <GuideStep title={g('transferPlan')} text={g('transferPlanText')}>
            <HelpShot topic="portability" scenario="transfer" frame="03-plan" side="panel" />
          </GuideStep>
          <GuideStep title={g('transferApplied')} text={g('transferAppliedText')}>
            <HelpShot topic="portability" scenario="transfer" frame="04-applied" side="panel" />
          </GuideStep>
        </GuideSteps>
      </HelpSection>

      <HelpSection title={g('subscribeTitle')} caption={g('subscribeCaption')}>
        <GuideSteps>
          <GuideStep title={g('subscribeLayers')} text={g('subscribeLayersText')}>
            <HelpShot topic="portability" scenario="subscribe" frame="01-layers" side="panel" />
          </GuideStep>
          <GuideStep title={g('subscribePlan')} text={g('subscribePlanText')}>
            <HelpShot topic="portability" scenario="subscribe" frame="02-plan" side="panel" />
          </GuideStep>
          <GuideStep title={g('subscribeDrift')} text={g('subscribeDriftText')}>
            <HelpShot topic="portability" scenario="subscribe" frame="03-drift" side="panel" />
          </GuideStep>
          <GuideStep title={g('subscribeResolved')} text={g('subscribeResolvedText')}>
            <HelpShot topic="portability" scenario="subscribe" frame="04-resolved" side="panel" />
          </GuideStep>
        </GuideSteps>
      </HelpSection>

      <HelpSection title={g('carryTitle')} caption={g('carryCaption')}>
        <GuideSteps>
          <GuideStep title={g('carryList')} text={g('carryListText')}>
            <HelpShot topic="portability" scenario="carry" frame="01-list" side="panel" />
          </GuideStep>
          <GuideStep title={g('carryRefusal')} text={g('carryRefusalText')}>
            <HelpShot topic="portability" scenario="carry" frame="02-refusal" side="panel" />
          </GuideStep>
        </GuideSteps>
      </HelpSection>
    </>
  );
}
