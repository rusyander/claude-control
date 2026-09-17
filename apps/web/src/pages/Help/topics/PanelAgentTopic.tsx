import { useTranslation } from 'react-i18next';
import { HelpSection, FieldTable, Callout, OptionCards } from '../ui';
import { PanelAgentGuideSections } from './PanelAgentGuideSections';
import { PanelAgentLimitsSections } from './PanelAgentLimitsSections';

/**
 * Документ «Агент панели».
 *
 * Главное, что он обязан донести: агент ничего не делает сам. Он просит действие
 * из закрытого списка, панель выполняет его маршрутом раздела и — если действие
 * что-то меняет — только после клика человека. Поэтому таблица действий идёт с
 * классом риска у каждого раздела, а ключи и отказы описаны не мелким шрифтом,
 * а отдельным путём со снимками: «агент не сделал» здесь почти всегда защита.
 */
export function PanelAgentTopic() {
  const { t } = useTranslation();
  const tr = (key: string): string => t(`help.topics.panelAgent.${key}`);
  const row = (key: string) => ({ name: tr(key), description: tr(`${key}Text`), isMono: false });
  const readRow = (key: string) => ({
    ...row(key),
    badge: tr('riskRead'),
    badgeTone: 'neutral' as const,
  });
  const changeRow = (key: string) => ({
    ...row(key),
    badge: tr('riskChange'),
    badgeTone: 'info' as const,
  });
  const dangerRow = (key: string) => ({
    ...row(key),
    badge: tr('riskDanger'),
    badgeTone: 'danger' as const,
  });
  const riskyRow = (key: string) => ({
    ...changeRow(key),
    badge2: tr('riskDanger'),
    badge2Tone: 'danger' as const,
  });

  return (
    <>
      <Callout tone="info" title={tr('guideTitle')}>
        {tr('guideText')}
      </Callout>

      <HelpSection title={tr('whyTitle')}>
        <OptionCards
          items={[
            { title: tr('whyWords'), text: tr('whyWordsText') },
            { title: tr('whySame'), text: tr('whySameText') },
            { title: tr('whyTrace'), text: tr('whyTraceText') },
          ]}
        />
      </HelpSection>

      <PanelAgentGuideSections tr={tr} />

      <HelpSection title={tr('askTitle')} caption={tr('askCaption')}>
        <OptionCards
          items={[
            { title: tr('askHow'), text: tr('askHowText') },
            { title: tr('askDo'), text: tr('askDoText') },
            { title: tr('askNot'), text: tr('askNotText') },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('actionsTitle')} caption={tr('actionsCaption')}>
        <FieldTable
          nameHeader={tr('actionsSection')}
          descriptionHeader={tr('actionsWhat')}
          rows={[
            readRow('secNavigation'),
            riskyRow('secProjects'),
            riskyRow('secRules'),
            dangerRow('secClaudeMd'),
            riskyRow('secSkills'),
            riskyRow('secHooks'),
            riskyRow('secEnv'),
            riskyRow('secMcp'),
            riskyRow('secPermissions'),
            riskyRow('secScripts'),
            riskyRow('secGroups'),
            riskyRow('secPlugins'),
            riskyRow('secHistory'),
            riskyRow('secSettings'),
            riskyRow('secEndpoints'),
            riskyRow('secIntegrations'),
            changeRow('secDlp'),
            riskyRow('secContour'),
            riskyRow('secTests'),
            readRow('secHelp'),
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('cardTitle')} caption={tr('cardCaption')}>
        <FieldTable
          nameHeader={tr('cardHeader')}
          descriptionHeader={tr('cardWhat')}
          rows={[
            row('cardChange'),
            row('cardDanger'),
            row('cardFocus'),
            row('cardDiff'),
            row('cardStale'),
            row('cardTimeout'),
            row('cardOnlyWindow'),
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('routeTitle')} caption={tr('routeCaption')}>
        <FieldTable
          nameHeader={tr('routeHeader')}
          descriptionHeader={tr('routeWhat')}
          rows={[row('routeDefault'), row('routeContour'), row('routeEndpoint')]}
        />
      </HelpSection>

      <PanelAgentLimitsSections tr={tr} />
    </>
  );
}
