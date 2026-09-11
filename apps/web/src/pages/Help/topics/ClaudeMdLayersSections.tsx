import { HelpSection, Callout, GuideSteps, GuideStep, HelpShot, OptionCards } from '../ui';

interface SectionProps {
  /** Перевод ключа `help.topics.claudeMd.<key>` — словарь у документа один. */
  tr: (key: string) => string;
}

/**
 * Второй вход в раздел: инструкции лежат не только здесь.
 *
 * Сценарий снят настоящим проектом рядом с репозиторием, а не подложенным
 * ответом сервера: уровни — это про файлы на диске, и подменённый список
 * доказывал бы только разметку страницы.
 *
 * Блок «какое правило главнее» стоит сразу за снимками и отвечает коротко:
 * никакое. Это самый частый вопрос про правила и единственное место справки,
 * где на него отвечают прямо: панель не назначает старшинства, и исключение
 * приходится писать словами в том файле, где оно уместно.
 */
export function ClaudeMdLayersSections({ tr }: SectionProps) {
  const l = (key: string): string => tr(`layers.${key}`);

  return (
    <>
      <HelpSection title={l('title')} caption={l('caption')}>
        <GuideSteps>
          <GuideStep title={l('lProjects')} text={l('lProjectsText')}>
            <HelpShot topic="claudeMd" scenario="layers" frame="01-projects" side="panel" />
          </GuideStep>
          <GuideStep title={l('lFile')} text={l('lFileText')}>
            <HelpShot topic="claudeMd" scenario="layers" frame="02-project-file" side="panel" />
          </GuideStep>
          <GuideStep title={l('lLocal')} text={l('lLocalText')}>
            <HelpShot topic="claudeMd" scenario="layers" frame="03-project-local" side="panel" />
          </GuideStep>
        </GuideSteps>
      </HelpSection>

      <HelpSection title={l('orderTitle')} caption={l('orderCaption')}>
        <Callout tone="warning" title={l('orderNoRank')}>
          {l('orderNoRankText')}
        </Callout>
        <OptionCards
          minWidth={320}
          items={[
            { title: l('orderCan'), text: l('orderCanText') },
            { title: l('orderCant'), text: l('orderCantText') },
            { title: l('orderMarks'), text: l('orderMarksText') },
            { title: l('orderWhen'), text: l('orderWhenText') },
          ]}
        />
      </HelpSection>
    </>
  );
}
