import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { HelpSection, Callout, OptionCards } from '../ui';
import { PortabilityGuideSections } from './PortabilityGuideSections';
import { PortabilityLimitsSections } from './PortabilityLimitsSections';

/**
 * Документ раздела «Паспорт среды» — что настроено, что доедет до другого CLI,
 * что изменится в его файлах и как держать цель согласованной.
 *
 * Порядок тот же, что у соседей: зачем это вообще → два пути в снимках → чем
 * раздел НЕ является → что читает и пишет → что умеет и чего нет → пять
 * уровней верности → пределы → тонкости.
 */
export function PortabilityTopic() {
  const { t } = useTranslation();
  const tr = (key: string): string => t(`help.topics.portability.${key}`);
  const common = (key: string): string => t(`help.common.${key}`);

  return (
    <>
      {/* Страница длинная и отвечает на четыре разных вопроса: первое, что ей
          нужно сказать, — из чего она состоит. */}
      <Callout tone="info" title={tr('guideTitle')}>
        {tr('guideText')}
      </Callout>

      <HelpSection title={common('whyTitle')}>
        <OptionCards
          items={[
            { title: tr('whyPassport'), text: tr('whyPassportText') },
            { title: tr('whyFidelity'), text: tr('whyFidelityText') },
            { title: tr('whyTransfer'), text: tr('whyTransferText') },
            { title: tr('whySubscription'), text: tr('whySubscriptionText') },
          ]}
        />
      </HelpSection>

      <PortabilityGuideSections tr={tr} />

      <PortabilityLimitsSections tr={tr} common={common} />

      <HelpSection title={common('notesTitle')}>
        <Stack gap="var(--spacing-xs)">
          {/* Первой стоит путаница «источник против канона»: она единственная
              заставляет человека ждать пересборки не из того места. */}
          <Callout tone="warning" title={tr('noteCanonTitle')}>
            {tr('noteCanonText')}
          </Callout>
          <Callout tone="info" title={tr('noteBlockTitle')}>
            {tr('noteBlockText')}
          </Callout>
          <Callout tone="warning" title={tr('noteUnsubscribeTitle')}>
            {tr('noteUnsubscribeText')}
          </Callout>
          <Callout tone="info" title={tr('noteBackupTitle')}>
            {tr('noteBackupText')}
          </Callout>
          <Callout tone="info" title={tr('noteRestartTitle')}>
            {tr('noteRestartText')}
          </Callout>
        </Stack>
      </HelpSection>
    </>
  );
}
