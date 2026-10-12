import { useTranslation } from 'react-i18next';
import { HelpSection, Callout, OptionCards } from '../../ui';

/**
 * Окно «Окружение» из ряда проекта: сервисы Docker Compose, база данных, API и защита
 * бэкенда (дальше — логи). Отдельный файл — у раздела своя работа и свои снимки, а документ чата
 * и без него самый длинный в справке.
 */
export function ChatEnvironmentSections() {
  const { t } = useTranslation();
  const tr = (key: string): string => t(`help.topics.chat.${key}`);

  return (
    <>
      <HelpSection title={tr('envTitle')} caption={tr('envCaption')}>
        <OptionCards
          minWidth={320}
          items={[
            { title: tr('envFind'), text: tr('envFindText') },
            { title: tr('envStates'), text: tr('envStatesText') },
            { title: tr('envActions'), text: tr('envActionsText') },
            { title: tr('envRemove'), text: tr('envRemoveText') },
            { title: tr('envNotReady'), text: tr('envNotReadyText') },
          ]}
        />
        <Callout tone="info" title={tr('envNote')} />
      </HelpSection>
      <HelpSection title={tr('dbTitle')} caption={tr('dbCaption')}>
        <OptionCards
          minWidth={320}
          items={[
            { title: tr('dbFind'), text: tr('dbFindText') },
            { title: tr('dbQuery'), text: tr('dbQueryText') },
            { title: tr('dbSafe'), text: tr('dbSafeText') },
            { title: tr('dbMigrations'), text: tr('dbMigrationsText') },
            { title: tr('dbAgent'), text: tr('dbAgentText') },
          ]}
        />
        <Callout tone="info" title={tr('dbNote')} />
      </HelpSection>
      <HelpSection title={tr('apiTitle')} caption={tr('apiCaption')}>
        <OptionCards
          minWidth={320}
          items={[
            { title: tr('apiFind'), text: tr('apiFindText') },
            { title: tr('apiSend'), text: tr('apiSendText') },
            { title: tr('apiCheck'), text: tr('apiCheckText') },
            { title: tr('apiAuth'), text: tr('apiAuthText') },
            { title: tr('apiHistory'), text: tr('apiHistoryText') },
          ]}
        />
        <Callout tone="info" title={tr('apiNote')} />
      </HelpSection>
      <HelpSection title={tr('logsTitle')} caption={tr('logsCaption')}>
        <OptionCards
          minWidth={320}
          items={[
            { title: tr('logsSources'), text: tr('logsSourcesText') },
            { title: tr('logsLevels'), text: tr('logsLevelsText') },
            { title: tr('logsSearch'), text: tr('logsSearchText') },
            { title: tr('logsFollow'), text: tr('logsFollowText') },
            { title: tr('logsAsk'), text: tr('logsAskText') },
          ]}
        />
        <Callout tone="info" title={tr('logsNote')} />
      </HelpSection>
      <HelpSection title={tr('guardTitle')} caption={tr('guardCaption')}>
        <OptionCards
          minWidth={320}
          items={[
            { title: tr('guardWhat'), text: tr('guardWhatText') },
            { title: tr('guardProd'), text: tr('guardProdText') },
            { title: tr('guardCheck'), text: tr('guardCheckText') },
            { title: tr('guardWhere'), text: tr('guardWhereText') },
            { title: tr('guardRemove'), text: tr('guardRemoveText') },
          ]}
        />
        <Callout tone="info" title={tr('guardNote')} />
      </HelpSection>
    </>
  );
}
