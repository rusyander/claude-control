import {
  HelpSection,
  OptionCards,
  Callout,
  GuideSteps,
  GuideStep,
  HelpShot,
  HelpDiagram,
} from '../ui';

interface SectionProps {
  /** Перевод ключа `help.topics.platform.<key>` — словарь у документа один. */
  tr: (key: string) => string;
}

/**
 * Середина документа «Контур»: весь путь подключения в снимках.
 *
 * Это не отдельный документ и больше им не будет. Разделять «как устроено» и
 * «куда нажимать» на две страницы оказалось ошибкой: человек, пришедший
 * подключать контур, всё равно читает подряд, а две страницы означают два
 * оглавления, две ссылки и вопрос «а это я уже читал?» на каждом переходе.
 *
 * Снимки берутся из общего каталога справки по одному правилу (`HelpShot`
 * собирает и адрес файла, и ключ подписи), поэтому здесь нет ни одного пути к
 * картинке. Целость связки «кадр ↔ подпись ↔ файл» проверяет
 * `node tools/qa/check-help-shots.mjs`.
 */
export function PlatformGuideSections({ tr }: SectionProps) {
  const g = (key: string): string => tr(`guide.${key}`);

  return (
    <>
      <HelpSection title={g('needTitle')} caption={g('needCaption')}>
        <OptionCards
          items={[
            { title: g('needAccess'), text: g('needAccessText') },
            { title: g('needModel'), text: g('needModelText') },
            { title: g('needAddress'), text: g('needAddressText') },
          ]}
          minWidth={280}
        />
      </HelpSection>

      {/* Схемы стоят ПЕРЕД шагами: восемнадцать снимков подряд отвечают на
          вопрос «куда нажимать», но не на вопрос «что вообще происходит», а
          второй возникает первым. */}
      <HelpSection title={g('mapTitle')} caption={g('mapCaption')}>
        <HelpDiagram topic="platform" name="request-path" />
        <HelpDiagram topic="platform" name="who-creates-what" />
        <HelpDiagram topic="platform" name="two-systems" />
        {/* Тот же путь словами: читатель справки вполне может не видеть
            картинку вовсе, и тогда схема без текста — пустое место. */}
        <Callout tone="info" title={tr('pathTextTitle')}>
          {tr('pathTextText')}
        </Callout>
      </HelpSection>

      <HelpSection title={g('enterprise-platformTitle')} caption={g('enterprise-platformCaption')}>
        <GuideSteps>
          <GuideStep title={g('gLogin')} text={g('gLoginText')}>
            <HelpShot topic="platform" scenario="connect" frame="01-admin-login" side="enterprise-platform" />
          </GuideStep>
          <GuideStep title={g('gDashboard')} text={g('gDashboardText')}>
            <HelpShot
              topic="platform"
              scenario="connect"
              frame="02-admin-dashboard"
              side="enterprise-platform"
            />
          </GuideStep>
          <GuideStep title={g('gModels')} text={g('gModelsText')}>
            <HelpShot topic="platform" scenario="connect" frame="03-admin-models" side="enterprise-platform" />
          </GuideStep>
          <GuideStep title={g('gModelCreate')} text={g('gModelCreateText')}>
            <HelpShot
              topic="platform"
              scenario="connect"
              frame="04-admin-model-create"
              side="enterprise-platform"
            />
          </GuideStep>
          <GuideStep title={g('gKeys')} text={g('gKeysText')}>
            <HelpShot topic="platform" scenario="connect" frame="05-admin-keys" side="enterprise-platform" />
          </GuideStep>
          <GuideStep title={g('gKeyCreate')} text={g('gKeyCreateText')}>
            <HelpShot
              topic="platform"
              scenario="connect"
              frame="06-admin-key-create"
              side="enterprise-platform"
            />
          </GuideStep>
          <GuideStep title={g('gKeyIssued')} text={g('gKeyIssuedText')}>
            <HelpShot
              topic="platform"
              scenario="connect"
              frame="07-admin-key-issued"
              side="enterprise-platform"
            />
          </GuideStep>
          <GuideStep title={g('gUsage')} text={g('gUsageText')}>
            <HelpShot topic="platform" scenario="connect" frame="08-admin-usage" side="enterprise-platform" />
          </GuideStep>
        </GuideSteps>
      </HelpSection>

      <HelpSection title={g('panelTitle')} caption={g('panelCaption')}>
        <GuideSteps>
          <GuideStep title={g('pEmpty')} text={g('pEmptyText')}>
            <HelpShot topic="platform" scenario="connect" frame="09-panel-empty" side="panel" />
          </GuideStep>
          <GuideStep title={g('pAddress')} text={g('pAddressText')}>
            <HelpShot topic="platform" scenario="connect" frame="10-wizard-address" side="panel" />
          </GuideStep>
          <GuideStep title={g('pProbe')} text={g('pProbeText')}>
            <HelpShot topic="platform" scenario="connect" frame="11-wizard-probe" side="panel" />
          </GuideStep>
          <GuideStep title={g('pKey')} text={g('pKeyText')}>
            <HelpShot topic="platform" scenario="connect" frame="12-wizard-key" side="panel" />
          </GuideStep>
          <GuideStep title={g('pCapabilities')} text={g('pCapabilitiesText')}>
            <HelpShot
              topic="platform"
              scenario="connect"
              frame="13-wizard-capabilities"
              side="panel"
            />
          </GuideStep>
          <GuideStep title={g('pTargets')} text={g('pTargetsText')}>
            <HelpShot topic="platform" scenario="connect" frame="14-wizard-targets" side="panel" />
          </GuideStep>
          <GuideStep title={g('pGateway')} text={g('pGatewayText')}>
            <HelpShot topic="platform" scenario="connect" frame="15-wizard-gateway" side="panel" />
          </GuideStep>
          <GuideStep title={g('pCard')} text={g('pCardText')}>
            <HelpShot topic="platform" scenario="connect" frame="16-panel-card" side="panel" />
          </GuideStep>
          <GuideStep title={g('pSpend')} text={g('pSpendText')}>
            <HelpShot topic="platform" scenario="connect" frame="17-panel-spend" side="panel" />
          </GuideStep>
          <GuideStep title={g('pDelete')} text={g('pDeleteText')}>
            <HelpShot topic="platform" scenario="connect" frame="18-panel-delete" side="panel" />
          </GuideStep>
        </GuideSteps>
        {/* Цена режима «обязательно» — рядом с шагом, на котором его выбирают,
            а не в конце документа: узнать её лучше до, а не после. */}
        <Callout tone="warning" title={tr('wizardRequired')}>
          {tr('wizardRequiredText')}
        </Callout>
      </HelpSection>

      <Callout tone="info" title={g('shotsTitle')}>
        {g('shotsText')}
      </Callout>
    </>
  );
}
