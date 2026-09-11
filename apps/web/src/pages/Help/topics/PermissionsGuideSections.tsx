import { HelpSection, Callout, GuideSteps, GuideStep, HelpShot, HelpDiagram } from '../ui';

interface SectionProps {
  /** Перевод ключа `help.topics.permissions.<key>` — словарь у документа один. */
  tr: (key: string) => string;
}

/**
 * Середина документа «Права»: схемы механизма и два пути в снимках.
 *
 * Сценариев ровно два, и делятся они ПО ВХОДУ, а не по объёму: «первая
 * настройка» — это человек, у которого прав ещё нет и Claude спрашивает про
 * каждый вызов; «ревизия» — тот, у кого их уже двадцать и нужно найти одно.
 * Читателю первого не приходится листать второй.
 *
 * Схемы стоят ПЕРЕД шагами: тринадцать снимков подряд отвечают на вопрос «куда
 * нажимать», но не на вопрос «кто вообще принимает решение», а второй возникает
 * первым — именно из него растёт «я же разрешил, почему не работает».
 *
 * Адресов картинок здесь нет ни одного: `HelpShot` собирает и путь к файлу, и
 * ключ подписи по одному правилу, а целость связки «кадр ↔ подпись ↔ файл»
 * проверяет `node tools/qa/check-help-shots.mjs`.
 */
export function PermissionsGuideSections({ tr }: SectionProps) {
  const g = (key: string): string => tr(`guide.${key}`);

  return (
    <>
      <HelpSection title={tr('mapTitle')} caption={tr('mapCaption')}>
        <HelpDiagram topic="permissions" name="decision-order" />
        <HelpDiagram topic="permissions" name="where-rules-live" />
        {/* Тот же путь словами: читатель справки вполне может не видеть
            картинку вовсе, и тогда схема без текста — пустое место. */}
        <Callout tone="info" title={tr('pathTextTitle')}>
          {tr('pathTextText')}
        </Callout>
      </HelpSection>

      <HelpSection title={g('setupTitle')} caption={g('setupCaption')}>
        <GuideSteps>
          <GuideStep title={g('setupEmpty')} text={g('setupEmptyText')}>
            <HelpShot topic="permissions" scenario="setup" frame="01-system-empty" side="panel" />
          </GuideStep>
          <GuideStep title={g('setupPreset')} text={g('setupPresetText')}>
            <HelpShot topic="permissions" scenario="setup" frame="02-form-preset" side="panel" />
          </GuideStep>
          <GuideStep title={g('setupWarning')} text={g('setupWarningText')}>
            <HelpShot topic="permissions" scenario="setup" frame="03-form-warning" side="panel" />
          </GuideStep>
          <GuideStep title={g('setupBulk')} text={g('setupBulkText')}>
            <HelpShot topic="permissions" scenario="setup" frame="04-bulk" side="panel" />
          </GuideStep>
          <GuideStep title={g('setupConfigured')} text={g('setupConfiguredText')}>
            <HelpShot
              topic="permissions"
              scenario="setup"
              frame="05-system-configured"
              side="panel"
            />
          </GuideStep>
          <GuideStep title={g('setupShadowed')} text={g('setupShadowedText')}>
            <HelpShot topic="permissions" scenario="setup" frame="06-form-shadowed" side="panel" />
          </GuideStep>
          <GuideStep title={g('setupShadowedList')} text={g('setupShadowedListText')}>
            <HelpShot
              topic="permissions"
              scenario="setup"
              frame="07-system-shadowed"
              side="panel"
            />
          </GuideStep>
        </GuideSteps>
      </HelpSection>

      <HelpSection title={g('auditTitle')} caption={g('auditCaption')}>
        <GuideSteps>
          <GuideStep title={g('auditAll')} text={g('auditAllText')}>
            <HelpShot topic="permissions" scenario="audit" frame="01-all-rules" side="panel" />
          </GuideStep>
          <GuideStep title={g('auditSearch')} text={g('auditSearchText')}>
            <HelpShot topic="permissions" scenario="audit" frame="02-search" side="panel" />
          </GuideStep>
          <GuideStep title={g('auditLocal')} text={g('auditLocalText')}>
            <HelpShot topic="permissions" scenario="audit" frame="03-local" side="panel" />
          </GuideStep>
          <GuideStep title={g('auditDisabled')} text={g('auditDisabledText')}>
            <HelpShot topic="permissions" scenario="audit" frame="04-disabled" side="panel" />
          </GuideStep>
          <GuideStep title={g('auditMcp')} text={g('auditMcpText')}>
            <HelpShot topic="permissions" scenario="audit" frame="05-mcp-tab" side="panel" />
          </GuideStep>
          <GuideStep title={g('auditDelete')} text={g('auditDeleteText')}>
            <HelpShot topic="permissions" scenario="audit" frame="06-delete" side="panel" />
          </GuideStep>
        </GuideSteps>
      </HelpSection>
    </>
  );
}
