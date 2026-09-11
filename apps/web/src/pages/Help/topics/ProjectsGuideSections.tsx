import { HelpSection, Callout, GuideSteps, GuideStep, HelpShot, HelpDiagram } from '../ui';

interface SectionProps {
  /** Перевод ключа `help.topics.projects.<key>` — словарь у документа один. */
  tr: (key: string) => string;
}

/**
 * Середина документа «Проекты»: как это устроено и оба пути в снимках.
 *
 * Сценария два, и делятся они по входу, а не по объёму. `setup` — папка
 * становится проектом: обзор каталогов сервера, три вкладки конфигурации и тот
 * же проект глазами другого CLI; проходится один раз на проект. `local` — в
 * репозитории уже лежит свой `.claude`, и человек приходит не настраивать, а
 * понять, что Claude Code подхватит поверх личного набора и почему это нельзя
 * выключить тумблером. Тому, у кого второй случай, первый путь не нужен вовсе.
 *
 * Схемы стоят ПЕРЕД шагами намеренно: снимки показывают вкладки, но не то, что
 * за ними лежит на диске, — а первым возникает именно этот вопрос, и ни одно
 * состояние экрана на него не отвечает.
 *
 * Ни одного пути к картинке здесь нет: `HelpShot` и `HelpDiagram` собирают и
 * адрес файла, и ключ подписи по одному правилу. Целость связки
 * «кадр ↔ подпись ↔ файл» проверяет `node tools/qa/check-help-shots.mjs`.
 */
export function ProjectsGuideSections({ tr }: SectionProps) {
  const g = (key: string): string => tr(`guide.${key}`);

  return (
    <>
      <HelpSection title={g('mapTitle')} caption={g('mapCaption')}>
        <HelpDiagram topic="projects" name="registry-and-files" />
        <HelpDiagram topic="projects" name="other-cli" />
        {/* Тот же путь словами: читатель справки вполне может не видеть
            картинку вовсе, и тогда схема без текста — пустое место. */}
        <Callout tone="info" title={g('pathTextTitle')}>
          {g('pathTextText')}
        </Callout>
      </HelpSection>

      <HelpSection title={g('setupTitle')} caption={g('setupCaption')}>
        <GuideSteps>
          <GuideStep title={g('sEmpty')} text={g('sEmptyText')}>
            <HelpShot topic="projects" scenario="setup" frame="01-empty" side="panel" />
          </GuideStep>
          <GuideStep title={g('sPicker')} text={g('sPickerText')}>
            <HelpShot topic="projects" scenario="setup" frame="02-picker" side="panel" />
          </GuideStep>
          <GuideStep title={g('sRules')} text={g('sRulesText')}>
            <HelpShot topic="projects" scenario="setup" frame="03-rules" side="panel" />
          </GuideStep>
          <GuideStep title={g('sMcp')} text={g('sMcpText')}>
            <HelpShot topic="projects" scenario="setup" frame="04-mcp" side="panel" />
          </GuideStep>
          <GuideStep title={g('sPerms')} text={g('sPermsText')}>
            <HelpShot topic="projects" scenario="setup" frame="05-permissions" side="panel" />
          </GuideStep>
          <GuideStep title={g('sForeign')} text={g('sForeignText')}>
            <HelpShot topic="projects" scenario="setup" frame="06-foreign" side="panel" />
          </GuideStep>
        </GuideSteps>
      </HelpSection>

      <HelpSection title={g('localTitle')} caption={g('localCaption')}>
        <GuideSteps>
          <GuideStep title={g('lTab')} text={g('lTabText')}>
            <HelpShot topic="projects" scenario="local" frame="01-tab" side="panel" />
          </GuideStep>
          <GuideStep title={g('lSkills')} text={g('lSkillsText')}>
            <HelpShot topic="projects" scenario="local" frame="02-skills" side="panel" />
          </GuideStep>
          <GuideStep title={g('lHooks')} text={g('lHooksText')}>
            <HelpShot topic="projects" scenario="local" frame="03-hooks" side="panel" />
          </GuideStep>
          <GuideStep title={g('lRules')} text={g('lRulesText')}>
            <HelpShot topic="projects" scenario="local" frame="04-rules" side="panel" />
          </GuideStep>
        </GuideSteps>
      </HelpSection>

      <Callout tone="info" title={g('shotsTitle')}>
        {g('shotsText')}
      </Callout>
    </>
  );
}
