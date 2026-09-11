import { HelpSection, StorageCard, FieldTable, CapabilityGrid } from '../ui';

interface SectionProps {
  /** Перевод ключа `help.topics.prompts.<key>`. */
  tr: (key: string) => string;
  /** Общий ключ справки: `help.common.<key>`. */
  common: (key: string) => string;
}

/**
 * Обязательные блоки документа «Промпты приложения»: чем раздел НЕ является, где
 * лежат оба слоя, пределы и отказы дословно.
 *
 * «Чем не является» стоит первым и это не формальность: слово «промпт» в панели
 * означает четыре разные вещи (то, что человек пишет агенту; системный промпт
 * CLI; проектный CLAUDE.md; текст режима), и человек, пришедший сюда за первыми
 * тремя, должен уйти в нужный раздел с первого экрана, а не после правки чужого
 * текста.
 */
export function PromptsLimitsSections({ tr, common }: SectionProps) {
  return (
    <>
      <HelpSection title={tr('notTitle')} caption={tr('notCaption')}>
        <FieldTable
          nameHeader={tr('notColumn')}
          descriptionHeader={tr('notMeaningColumn')}
          rows={[
            { name: tr('notChat'), description: tr('notChatText'), isMono: false },
            { name: tr('notCli'), description: tr('notCliText'), isMono: false },
            { name: tr('notClaudeMd'), description: tr('notClaudeMdText'), isMono: false },
            { name: tr('notPerProject'), description: tr('notPerProjectText'), isMono: false },
            { name: tr('notShared'), description: tr('notSharedText'), isMono: false },
          ]}
        />
      </HelpSection>

      <HelpSection title={common('storageTitle')} caption={tr('storageCaption')}>
        <StorageCard
          title={tr('title')}
          rows={[
            { label: tr('storageBuiltin'), value: tr('storageBuiltinValue'), isMono: true },
            { label: tr('storageOverride'), value: tr('storageOverrideValue'), isMono: true },
            { label: tr('storageIndex'), value: tr('storageIndexValue'), isMono: true },
            { label: tr('storageSeen'), value: tr('storageSeenValue') },
          ]}
        />
      </HelpSection>

      <HelpSection title={`${common('canTitle')} · ${common('cantTitle')}`}>
        <CapabilityGrid
          canTitle={common('canTitle')}
          cantTitle={common('cantTitle')}
          can={[
            tr('canRead'),
            tr('canEdit'),
            tr('canReset'),
            tr('canNotice'),
            tr('canTransfer'),
            tr('canSurvive'),
          ]}
          cant={[
            tr('cantBuiltin'),
            tr('cantPerProject'),
            tr('cantVersion'),
            tr('cantCheck'),
            tr('cantHighlight'),
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('refusalsTitle')} caption={tr('refusalsCaption')}>
        <FieldTable
          nameHeader={tr('refusalsColumn')}
          descriptionHeader={tr('refusalsMeaningColumn')}
          rows={[
            { name: tr('refusalUnknown'), description: tr('refusalUnknownText'), isMono: false },
            { name: tr('refusalEmpty'), description: tr('refusalEmptyText'), isMono: false },
            { name: tr('refusalTooLong'), description: tr('refusalTooLongText'), isMono: false },
            { name: tr('refusalBroken'), description: tr('refusalBrokenText'), isMono: false },
            { name: tr('refusalNewer'), description: tr('refusalNewerText'), isMono: false },
          ]}
        />
      </HelpSection>
    </>
  );
}
