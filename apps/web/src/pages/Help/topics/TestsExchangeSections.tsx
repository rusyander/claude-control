import { useTranslation } from 'react-i18next';
import { Callout, HelpSection, OptionCards, StepList } from '../ui';

/**
 * Разделы документа «Тесты» про обмен с внешним миром: доступы стенда, импорт и
 * выгрузка, дефекты, терминальный вход и то, что умеют только настроенные
 * интеграции.
 *
 * Терминальный вход стоит СРАЗУ после импорта из CI: человек, который дочитал до
 * «результаты приходят из CI», следующим вопросом спрашивает, как в том же CI
 * позвать линтер, сравнение и сборку плана.
 */
export function TestsExchangeSections() {
  const { t } = useTranslation();
  const tr = (key: string): string => t(`help.topics.tests.${key}`);

  return (
    <>
      {/* Доступы стенда — единственное место, где сказано, ГДЕ лежит пароль и
          почему его не видно обратно: без этого его ищут в файле проекта. */}
      <HelpSection title={tr('secretsTitle')} caption={tr('secretsCaption')}>
        <OptionCards
          items={[
            { title: tr('secretsWhere'), text: tr('secretsWhereText') },
            { title: tr('secretsSplit'), text: tr('secretsSplitText') },
            { title: tr('secretsRun'), text: tr('secretsRunText') },
            { title: tr('secretsMissing'), text: tr('secretsMissingText') },
          ]}
        />
        <Callout tone="info" title={tr('secretsShowTitle')}>
          {tr('secretsShowText')}
        </Callout>
        <Callout tone="warning" title={tr('secretsReservedTitle')}>
          {tr('secretsReservedText')}
        </Callout>
      </HelpSection>

      <HelpSection title={tr('importTitle')} caption={tr('importCaption')}>
        <OptionCards
          items={[
            { title: tr('importResults'), text: tr('importResultsText') },
            { title: tr('importCases'), text: tr('importCasesText') },
            { title: tr('importExport'), text: tr('importExportText') },
          ]}
        />
        <Callout tone="warning" title={tr('importMatchTitle')}>
          {tr('importMatchText')}
        </Callout>
      </HelpSection>

      <HelpSection title={tr('defectsTitle')} caption={tr('defectsCaption')}>
        <StepList
          steps={[
            { title: tr('defectStep1'), text: tr('defectStep1Text') },
            { title: tr('defectStep2'), text: tr('defectStep2Text') },
            { title: tr('defectStep3'), text: tr('defectStep3Text') },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('cliTitle')} caption={tr('cliCaption')}>
        <OptionCards
          items={[
            { title: tr('cliLint'), text: tr('cliLintText') },
            { title: tr('cliDiff'), text: tr('cliDiffText') },
            { title: tr('cliPlan'), text: tr('cliPlanText') },
          ]}
        />
      </HelpSection>

      {/* Что раздел умеет ТОЛЬКО с настроенными интеграциями. Подробности —
          отдельный документ; здесь достаточно знать, что эти кнопки есть и
          откуда они берутся, иначе их ищут в разделе и не находят. */}
      <HelpSection title={tr('externalTitle')} caption={tr('externalCaption')}>
        <OptionCards
          items={[
            { title: tr('externalDefect'), text: tr('externalDefectText') },
            { title: tr('externalDefectState'), text: tr('externalDefectStateText') },
            { title: tr('externalPublish'), text: tr('externalPublishText') },
            { title: tr('externalPdf'), text: tr('externalPdfText') },
            { title: tr('externalBaseline'), text: tr('externalBaselineText') },
          ]}
        />
      </HelpSection>
    </>
  );
}
