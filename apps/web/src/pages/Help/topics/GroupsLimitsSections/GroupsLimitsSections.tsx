import { HelpSection, OptionCards } from '../../ui';
import type { SectionProps } from '../GroupsGuideSections/GroupsGuideSections.types';

/**
 * Что ядро от прежней группы не берёт (этап 10): ветку, копию и чат, недоведённый запуск,
 * русскую сторону переведённого шага, участников группы. Человек приходит сюда с вопросом
 * «куда делось» — ответ на каждое одной карточкой.
 */
export function GroupsLimitsSections({ tr }: SectionProps) {
  return (
    <HelpSection title={tr('carryTitle')} caption={tr('carryCaption')}>
      <OptionCards
        minWidth={320}
        items={[
          { title: tr('carryBranch'), text: tr('carryBranchText') },
          { title: tr('carryHalf'), text: tr('carryHalfText') },
          { title: tr('carryLanguage'), text: tr('carryLanguageText') },
          { title: tr('carryMembers'), text: tr('carryMembersText') },
        ]}
      />
    </HelpSection>
  );
}
