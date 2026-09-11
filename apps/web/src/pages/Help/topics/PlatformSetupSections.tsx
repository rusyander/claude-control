import type { ReactNode } from 'react';
import { HelpSection, Callout, FieldTable, StepList } from '../ui';
import { PlatformKeyDiagram, PlatformRequestDiagram } from './PlatformDiagrams';

interface SectionProps {
  /** Перевод ключа `help.topics.platform.<key>`. */
  tr: (key: string) => string;
  /**
   * Путь в снимках. Приходит извне, а не импортом: середина документа — самая
   * тяжёлая его часть, и место, куда она встаёт, решает сам документ.
   */
  guide: ReactNode;
}

/**
 * Первая половина документа «Контур»: чем он отличается от соседних способов,
 * весь путь подключения в снимках, что ещё живёт в админке, что происходит с
 * ключом дальше и куда идёт запрос.
 *
 * Вынесено из `PlatformTopic` не ради красоты: документ вырос до девяти
 * разделов, и один файл на них перестал читаться.
 */
export function PlatformSetupSections({ tr, guide }: SectionProps) {
  return (
    <>
      <HelpSection title={tr('neighboursTitle')} caption={tr('neighboursCaption')}>
        <FieldTable
          nameHeader={tr('neighboursColumn')}
          descriptionHeader={tr('neighboursMeaningColumn')}
          rows={[
            {
              name: tr('neighboursEndpoint'),
              description: tr('neighboursEndpointText'),
              isMono: false,
            },
            { name: tr('neighboursDlp'), description: tr('neighboursDlpText'), isMono: false },
            {
              name: tr('neighboursContour'),
              description: tr('neighboursContourText'),
              isMono: false,
            },
          ]}
        />
      </HelpSection>

      {guide}

      <HelpSection title={tr('getKeyTitle')} caption={tr('getKeyCaption')}>
        <StepList
          steps={[
            { title: tr('getKeyProvider'), text: tr('getKeyProviderText') },
            { title: tr('getKeyModel'), text: tr('getKeyModelText') },
            { title: tr('getKeyOwner'), text: tr('getKeyOwnerText') },
            { title: tr('getKeyKey'), text: tr('getKeyKeyText') },
            { title: tr('getKeyChecks'), text: tr('getKeyChecksText') },
            { title: tr('getKeyTools'), text: tr('getKeyToolsText') },
            { title: tr('getKeyProbe'), text: tr('getKeyProbeText') },
          ]}
        />
        <Callout tone="warning" title={tr('getKeyOnceTitle')}>
          {tr('getKeyOnceText')}
        </Callout>
      </HelpSection>

      <HelpSection title={tr('keyLifeTitle')} caption={tr('keyLifeCaption')}>
        <PlatformKeyDiagram tr={tr} />
        <FieldTable
          nameHeader={tr('keyLifeColumn')}
          descriptionHeader={tr('keyLifeMeaningColumn')}
          rows={[
            { name: tr('keyLifeWhere'), description: tr('keyLifeWhereText'), isMono: false },
            { name: tr('keyLifeCrypto'), description: tr('keyLifeCryptoText'), isMono: false },
            { name: tr('keyLifeConfigs'), description: tr('keyLifeConfigsText'), isMono: false },
            { name: tr('keyLifeOutside'), description: tr('keyLifeOutsideText'), isMono: false },
          ]}
        />
      </HelpSection>

      {/* Картинка «кто с кем говорит» отсюда ушла: её место заняла схема «две
          системы рядом» наверху, и держать обе значило бы дважды отвечать на
          один вопрос. Эта осталась ради трёх мест, где запрос кончается
          отказом, — их не показывает ни одна из верхних схем. Тот же путь
          словами стоит там же, наверху: читатель может не видеть картинок. */}
      <HelpSection title={tr('pathTitle')} caption={tr('pathCaption')}>
        <PlatformRequestDiagram tr={tr} />
      </HelpSection>
    </>
  );
}
