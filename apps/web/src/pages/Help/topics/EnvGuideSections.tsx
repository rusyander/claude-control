import { HelpSection, Callout, GuideSteps, GuideStep, HelpShot, HelpDiagram } from '../ui';

interface SectionProps {
  /** Перевод ключа `help.topics.env.<key>` — словарь у документа один. */
  tr: (key: string) => string;
}

/**
 * Середина документа «Переменные»: схема трёх файлов и два пути в снимках.
 *
 * Сценариев два, по входу: «завести токен» проходят на каждый секрет, «перенести
 * пачку» — когда переменных сразу много. Первый заканчивается показом значения,
 * второй — удалением, и пересекаются они только списком.
 *
 * Схема стоит перед шагами: главный вопрос раздела — не «куда нажимать», а «кто
 * прочитает то, что я сохранил», и ответ на него у трёх файлов разный.
 */
export function EnvGuideSections({ tr }: SectionProps) {
  const g = (key: string): string => tr(`guide.${key}`);

  return (
    <>
      <HelpSection title={tr('mapTitle')} caption={tr('mapCaption')}>
        <HelpDiagram topic="env" name="where-a-value-goes" />
        {/* Тот же путь словами: справку читают и без картинок. */}
        <Callout tone="info" title={tr('pathTextTitle')}>
          {tr('pathTextText')}
        </Callout>
      </HelpSection>

      <HelpSection title={g('secretTitle')} caption={g('secretCaption')}>
        <GuideSteps>
          <GuideStep title={g('secretPlain')} text={g('secretPlainText')}>
            <HelpShot topic="env" scenario="secret" frame="01-list-plain" side="panel" />
          </GuideStep>
          <GuideStep title={g('secretForm')} text={g('secretFormText')}>
            <HelpShot topic="env" scenario="secret" frame="02-form" side="panel" />
          </GuideStep>
          <GuideStep title={g('secretMasked')} text={g('secretMaskedText')}>
            <HelpShot topic="env" scenario="secret" frame="03-list-masked" side="panel" />
          </GuideStep>
          <GuideStep title={g('secretReveal')} text={g('secretRevealText')}>
            <HelpShot topic="env" scenario="secret" frame="04-revealed" side="panel" />
          </GuideStep>
          <GuideStep title={g('secretEdit')} text={g('secretEditText')}>
            <HelpShot topic="env" scenario="secret" frame="05-secret-edit" side="panel" />
          </GuideStep>
        </GuideSteps>
      </HelpSection>

      <HelpSection title={g('bulkTitle')} caption={g('bulkCaption')}>
        <GuideSteps>
          <GuideStep title={g('bulkPaste')} text={g('bulkPasteText')}>
            <HelpShot topic="env" scenario="bulk" frame="01-bulk" side="panel" />
          </GuideStep>
          <GuideStep title={g('bulkList')} text={g('bulkListText')}>
            <HelpShot topic="env" scenario="bulk" frame="02-list-mixed" side="panel" />
          </GuideStep>
          <GuideStep title={g('bulkMove')} text={g('bulkMoveText')}>
            <HelpShot topic="env" scenario="bulk" frame="03-local" side="panel" />
          </GuideStep>
          <GuideStep title={g('bulkGroup')} text={g('bulkGroupText')}>
            <HelpShot topic="env" scenario="bulk" frame="04-group" side="panel" />
          </GuideStep>
          <GuideStep title={g('bulkDelete')} text={g('bulkDeleteText')}>
            <HelpShot topic="env" scenario="bulk" frame="05-delete" side="panel" />
          </GuideStep>
        </GuideSteps>
      </HelpSection>
    </>
  );
}
