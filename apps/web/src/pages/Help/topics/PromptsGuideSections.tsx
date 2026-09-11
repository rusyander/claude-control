import { HelpSection, Callout, GuideSteps, GuideStep, HelpShot } from '../ui';

interface SectionProps {
  /** Перевод ключа `help.topics.prompts.<key>`. */
  tr: (key: string) => string;
}

/**
 * Середина документа «Промпты приложения»: путь правки в кадрах настоящего
 * раздела.
 *
 * Перед шагами стоит предупреждение о том, ЧТО меняет сохранение. Промпт уезжает
 * модели в каждом запросе режима, и человек, открывший поле, правит не подпись на
 * экране, а поведение продукта: шаги без этой рамки читаются как «поле — значит
 * можно попробовать».
 */
export function PromptsGuideSections({ tr }: SectionProps) {
  const g = (key: string): string => tr(`guide.${key}`);

  return (
    <HelpSection title={g('title')} caption={g('caption')}>
      <Callout tone="warning" title={g('careTitle')}>
        {g('careText')}
      </Callout>

      <GuideSteps>
        <GuideStep title={g('list')} text={g('listText')}>
          <HelpShot topic="prompts" scenario="library" frame="01-list" side="panel" />
        </GuideStep>
        <GuideStep title={g('open')} text={g('openText')}>
          <HelpShot topic="prompts" scenario="library" frame="02-builtin" side="panel" />
        </GuideStep>
        <GuideStep title={g('save')} text={g('saveText')}>
          <HelpShot topic="prompts" scenario="library" frame="03-edited" side="panel" />
        </GuideStep>
        <GuideStep title={g('reset')} text={g('resetText')}>
          <HelpShot topic="prompts" scenario="library" frame="04-reset" side="panel" />
        </GuideStep>
      </GuideSteps>
    </HelpSection>
  );
}
