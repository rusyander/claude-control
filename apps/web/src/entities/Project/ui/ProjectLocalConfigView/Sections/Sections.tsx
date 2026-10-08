import type { ProjectLocalConfig } from '@agentdeck/contracts';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Section } from '../Section/Section';
import { SkillRow } from '../../SkillRow/SkillRow';
import { HookRow } from '../../HookRow/HookRow';
import { RuleRow } from '../../RuleRow/RuleRow';

/** Три раздела подряд — общая часть полного и раскрытого компактного вида. */
export function Sections({ config }: { config: ProjectLocalConfig }) {
  const { t } = useTranslation();

  return (
    <Stack gap="var(--spacing-md)">
      <Section
        title={t('projectLocal.skills')}
        count={config.skills.length}
        empty={t('projectLocal.emptySkills')}
      >
        {config.skills.map((skill) => (
          <SkillRow key={skill.id} skill={skill} />
        ))}
      </Section>
      <Section
        title={t('projectLocal.hooks')}
        count={config.hooks.length}
        empty={t('projectLocal.emptyHooks')}
      >
        {config.hooks.map((hook) => (
          <HookRow key={hook.id} hook={hook} />
        ))}
      </Section>
      <Section
        title={t('projectLocal.rules')}
        count={config.rules.length}
        empty={t('projectLocal.emptyRules')}
      >
        {config.rules.map((rule) => (
          <RuleRow key={rule.path} rule={rule} />
        ))}
      </Section>
    </Stack>
  );
}
