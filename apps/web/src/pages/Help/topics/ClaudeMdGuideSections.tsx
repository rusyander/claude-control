import { HelpSection, Callout, GuideSteps, GuideStep, HelpShot, HelpDiagram } from '../ui';

interface SectionProps {
  /** Перевод ключа `help.topics.claudeMd.<key>` — словарь у документа один. */
  tr: (key: string) => string;
}

/**
 * Середина документа «CLAUDE.md»: устройство и путь одной правки в снимках.
 *
 * Схемы стоят перед шагами по той же причине, что и в остальных путеводителях:
 * снимок показывает состояние, но не показывает, что панель считает «своим»
 * текстом, а что «чужим», — а именно это и решает, заменит она поле или
 * покажет расхождение.
 *
 * Последний кадр сценария снят настоящим расхождением: пока в поле лежала
 * несохранённая правка, файл переписали со стороны, наблюдатель принёс новую
 * версию, и карточку нарисовала сама панель. Подложить такое состояние было бы
 * проще, но кадр доказывал бы разметку, а не поведение.
 */
export function ClaudeMdGuideSections({ tr }: SectionProps) {
  const g = (key: string): string => tr(`guide.${key}`);

  return (
    <>
      <HelpSection title={g('mapTitle')} caption={g('mapCaption')}>
        <HelpDiagram topic="claudeMd" name="instruction-layers" />
        <HelpDiagram topic="claudeMd" name="save-and-conflict" />
        {/* Тот же путь словами: читатель справки вполне может не видеть
            картинку вовсе, и тогда схема без текста — пустое место. */}
        <Callout tone="info" title={g('pathTextTitle')}>
          {g('pathTextText')}
        </Callout>
      </HelpSection>

      <HelpSection title={g('fileTitle')} caption={g('fileCaption')}>
        <GuideSteps>
          <GuideStep title={g('uEditor')} text={g('uEditorText')}>
            <HelpShot topic="claudeMd" scenario="file" frame="01-editor" side="panel" />
          </GuideStep>
          <GuideStep title={g('uUnsaved')} text={g('uUnsavedText')}>
            <HelpShot topic="claudeMd" scenario="file" frame="02-unsaved" side="panel" />
          </GuideStep>
          <GuideStep title={g('uConflict')} text={g('uConflictText')}>
            <HelpShot topic="claudeMd" scenario="file" frame="03-conflict" side="panel" />
          </GuideStep>
        </GuideSteps>
      </HelpSection>
    </>
  );
}
