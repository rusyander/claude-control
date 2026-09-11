import { HelpSection, Callout, GuideSteps, GuideStep, HelpShot, HelpDiagram } from '../ui';

interface SectionProps {
  /** Перевод ключа `help.topics.scripts.<key>` — словарь у документа один. */
  tr: (key: string) => string;
}

/**
 * Середина документа «Скрипты»: схема привязки и оба пути в снимках.
 *
 * Схема ровно одна, и она про единственное, чего не видно ни в одном состоянии
 * экрана: как получается пометка «используется». Она транзитивна — общий модуль,
 * которого нет ни в одной команде хука, всё равно считается привязанным, — и без
 * рисунка это читается как ошибка панели.
 *
 * Сценариев съёмки два, и делятся они по входу. `files` — каталог уже не пустой:
 * пометки, содержимое, промах поиска и предупреждение при удалении. `new` —
 * файла ещё нет: каркасы, заполненный код и пакетное создание.
 *
 * Ни одного пути к картинке здесь нет: `HelpShot` и `HelpDiagram` собирают и
 * адрес файла, и ключ подписи по одному правилу. Целость связки
 * «кадр ↔ подпись ↔ файл» проверяет `node tools/qa/check-help-shots.mjs`.
 */
export function ScriptsGuideSections({ tr }: SectionProps) {
  const g = (key: string): string => tr(`guide.${key}`);

  return (
    <>
      <HelpSection title={g('mapTitle')} caption={g('mapCaption')}>
        <HelpDiagram topic="scripts" name="script-usage" />
        {/* Тот же путь словами: читатель справки вполне может не видеть
            картинку вовсе, и тогда схема без текста — пустое место. */}
        <Callout tone="info" title={g('pathTextTitle')}>
          {g('pathTextText')}
        </Callout>
      </HelpSection>

      <HelpSection title={g('filesTitle')} caption={g('filesCaption')}>
        <GuideSteps>
          <GuideStep title={g('fList')} text={g('fListText')}>
            <HelpShot topic="scripts" scenario="files" frame="01-list" side="panel" />
          </GuideStep>
          <GuideStep title={g('fContent')} text={g('fContentText')}>
            <HelpShot topic="scripts" scenario="files" frame="02-content" side="panel" />
          </GuideStep>
          <GuideStep title={g('fSearch')} text={g('fSearchText')}>
            <HelpShot topic="scripts" scenario="files" frame="03-search" side="panel" />
          </GuideStep>
          <GuideStep title={g('fDelete')} text={g('fDeleteText')}>
            <HelpShot topic="scripts" scenario="files" frame="04-delete" side="panel" />
          </GuideStep>
        </GuideSteps>
      </HelpSection>

      <HelpSection title={g('newTitle')} caption={g('newCaption')}>
        <GuideSteps>
          <GuideStep title={g('nForm')} text={g('nFormText')}>
            <HelpShot topic="scripts" scenario="new" frame="01-form" side="panel" />
          </GuideStep>
          <GuideStep title={g('nTemplate')} text={g('nTemplateText')}>
            <HelpShot topic="scripts" scenario="new" frame="02-template" side="panel" />
          </GuideStep>
          <GuideStep title={g('nBulk')} text={g('nBulkText')}>
            <HelpShot topic="scripts" scenario="new" frame="03-bulk" side="panel" />
          </GuideStep>
        </GuideSteps>
      </HelpSection>

      <Callout tone="info" title={g('shotsTitle')}>
        {g('shotsText')}
      </Callout>
    </>
  );
}
