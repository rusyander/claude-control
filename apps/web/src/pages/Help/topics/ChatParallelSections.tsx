import { useTranslation } from 'react-i18next';
import { HelpSection, Callout, OptionCards } from '../ui';

/**
 * Три соседних раздела документа «Чат» об одном и том же: как работа одного
 * проекта расходится по нескольким разговорам — копии репозитория руками,
 * разделение задач, которое предлагает сам агент, и продолжение закрытого этапа
 * в чистой сессии. Вынесены из `ChatTopic` целиком: вместе они переваливали
 * документ за предел длины файла.
 */
export function ChatParallelSections() {
  const { t } = useTranslation();
  const tr = (key: string): string => t(`help.topics.chat.${key}`);

  return (
    <>
      <HelpSection title={tr('parallelTitle')} caption={tr('parallelCaption')}>
        <OptionCards
          minWidth={320}
          items={[
            { title: tr('parallelWhy'), text: tr('parallelWhyText') },
            { title: tr('parallelCreate'), text: tr('parallelCreateText') },
            { title: tr('parallelWork'), text: tr('parallelWorkText') },
            { title: tr('parallelRemove'), text: tr('parallelRemoveText') },
            { title: tr('parallelMemory'), text: tr('parallelMemoryText') },
          ]}
        />
        <Callout tone="warning" title={tr('parallelNote')} />
      </HelpSection>

      {/* Разделение задач по чатам — продолжение параллельных копий: там про то,
          как копия заводится руками, здесь — как её предлагает сам агент. */}
      <HelpSection title={tr('splitTitle')} caption={tr('splitCaption')}>
        <OptionCards
          minWidth={320}
          items={[
            { title: tr('splitWhen'), text: tr('splitWhenText') },
            { title: tr('splitCard'), text: tr('splitCardText') },
            { title: tr('splitWhat'), text: tr('splitWhatText') },
            { title: tr('splitTree'), text: tr('splitTreeText') },
            { title: tr('splitButton'), text: tr('splitButtonText') },
            { title: tr('splitOff'), text: tr('splitOffText') },
          ]}
        />
        <Callout tone="warning" title={tr('splitNote')} />
      </HelpSection>

      {/* Продолжение в чистой сессии: там работа расходится вширь, здесь —
          вперёд, оставляя позади дорогой контекст закрытого этапа. */}
      <HelpSection title={tr('handoffTitle')} caption={tr('handoffCaption')}>
        <OptionCards
          minWidth={320}
          items={[
            { title: tr('handoffWhen'), text: tr('handoffWhenText') },
            { title: tr('handoffSize'), text: tr('handoffSizeText') },
            { title: tr('handoffCard'), text: tr('handoffCardText') },
            { title: tr('handoffWhat'), text: tr('handoffWhatText') },
            { title: tr('handoffAuto'), text: tr('handoffAutoText') },
            { title: tr('handoffTidy'), text: tr('handoffTidyText') },
            { title: tr('handoffOff'), text: tr('handoffOffText') },
          ]}
        />
        <Callout tone="warning" title={tr('handoffNote')} />
      </HelpSection>
    </>
  );
}
