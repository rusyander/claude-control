import { HelpSection, Callout, GuideSteps, GuideStep, HelpShot, HelpDiagram } from '../ui';

interface SectionProps {
  /** Перевод ключа `help.topics.settings.<key>` — словарь у документа один. */
  tr: (key: string) => string;
}

/**
 * Середина документа «Настройки»: схема записи и два пути в снимках.
 *
 * Пути делятся по входу, а не по объёму. В первый приходят с только что
 * открытой панелью и вопросом «она вообще смотрит в тот каталог?»; во второй —
 * когда всё работает и вопрос другой: «что она сделала с моими файлами и как
 * это вернуть».
 *
 * Схема стоит ПЕРЕД шагами намеренно: и мастер, и карточки безопасности — про
 * одно и то же событие, запись в чужой файл, и без него шаги читаются как набор
 * тумблеров.
 */
export function SettingsGuideSections({ tr }: SectionProps) {
  const g = (key: string): string => tr(`guide.${key}`);

  return (
    <>
      <HelpSection title={tr('mapTitle')} caption={tr('mapCaption')}>
        <HelpDiagram topic="settings" name="what-happens-before-a-write" />
        {/* Тот же путь словами: справку читают и без картинок. */}
        <Callout tone="info" title={tr('pathTextTitle')}>
          {tr('pathTextText')}
        </Callout>
      </HelpSection>

      <HelpSection title={g('firstRunTitle')} caption={g('firstRunCaption')}>
        <GuideSteps>
          <GuideStep title={g('firstRunIntro')} text={g('firstRunIntroText')}>
            <HelpShot topic="settings" scenario="first-run" frame="01-wizard-intro" side="panel" />
          </GuideStep>
          <GuideStep title={g('firstRunLocation')} text={g('firstRunLocationText')}>
            <HelpShot
              topic="settings"
              scenario="first-run"
              frame="02-wizard-location"
              side="panel"
            />
          </GuideStep>
          <GuideStep title={g('firstRunProviders')} text={g('firstRunProvidersText')}>
            <HelpShot
              topic="settings"
              scenario="first-run"
              frame="03-wizard-providers"
              side="panel"
            />
          </GuideStep>
          <GuideStep title={g('firstRunAccess')} text={g('firstRunAccessText')}>
            <HelpShot topic="settings" scenario="first-run" frame="04-wizard-access" side="panel" />
          </GuideStep>
          <GuideStep title={g('firstRunTabs')} text={g('firstRunTabsText')}>
            <HelpShot topic="settings" scenario="first-run" frame="05-tabs" side="panel" />
          </GuideStep>
          <GuideStep title={g('firstRunDir')} text={g('firstRunDirText')}>
            <HelpShot topic="settings" scenario="first-run" frame="06-access-dir" side="panel" />
          </GuideStep>
          <GuideStep title={g('firstRunCreds')} text={g('firstRunCredsText')}>
            <HelpShot
              topic="settings"
              scenario="first-run"
              frame="07-access-credentials"
              side="panel"
            />
          </GuideStep>
          <GuideStep title={g('firstRunRemote')} text={g('firstRunRemoteText')}>
            <HelpShot topic="settings" scenario="first-run" frame="08-remote" side="panel" />
          </GuideStep>
        </GuideSteps>
      </HelpSection>

      <HelpSection title={g('safetyTitle')} caption={g('safetyCaption')}>
        <GuideSteps>
          <GuideStep title={g('safetySettings')} text={g('safetySettingsText')}>
            <HelpShot topic="settings" scenario="safety" frame="01-safety" side="panel" />
          </GuideStep>
          <GuideStep title={g('safetyBackups')} text={g('safetyBackupsText')}>
            <HelpShot topic="settings" scenario="safety" frame="02-backups" side="panel" />
          </GuideStep>
          <GuideStep title={g('safetyEncrypt')} text={g('safetyEncryptText')}>
            <HelpShot topic="settings" scenario="safety" frame="03-encrypt" side="panel" />
          </GuideStep>
          <GuideStep title={g('safetySpend')} text={g('safetySpendText')}>
            <HelpShot topic="settings" scenario="safety" frame="04-spend" side="panel" />
          </GuideStep>
          <GuideStep title={g('safetyTransfer')} text={g('safetyTransferText')}>
            <HelpShot topic="settings" scenario="safety" frame="05-transfer" side="panel" />
          </GuideStep>
          <GuideStep title={g('safetyEnv')} text={g('safetyEnvText')}>
            <HelpShot topic="settings" scenario="safety" frame="06-env-transfer" side="panel" />
          </GuideStep>
        </GuideSteps>
      </HelpSection>
    </>
  );
}
