import { useTranslation } from 'react-i18next';
import type { Group } from '@agentdeck/contracts';
import { skillApi } from '@entities/Skill';
import { hookApi } from '@entities/Hook';
import { useLocation } from '@entities/AppConfig';
import { useGroupMembers } from '@entities/Group';
import type { KnownSkill } from './describe';
import { skillTextSteps } from './skillText';
import { rowWords } from './rowWords';
import { skillSource } from './stepSource';
import type { PathRow } from './pathRows.types';
import { rowType } from './rowType';
import { skillBlockType } from './skillBlockType';
import type { WordsSource } from './rowWords.types';
import { rowBilingual } from './rowBilingual';
import type { StepSource } from './stepSource.types';
import { entrySource } from './entrySource';
import { sourceFile } from './sourceFile';
import { pickLang } from '../lib/pickLang';

/**
 * Всё, что строке порядка работы нужно знать о мире вокруг группы: какие
 * скиллы наши (и их тексты), где лежат каталоги провайдера, пути скриптов
 * хуков, описания участников. Списки уже есть в кэше страниц конфигурации,
 * описания — один запрос на группу; отдельных запросов на строку нет.
 */
export function usePathContext(group: Pick<Group, 'id' | 'scope' | 'members'>) {
  const { t, i18n } = useTranslation();
  const skills = skillApi.useList();
  const hooks = hookApi.useList();
  const location = useLocation();
  const briefs = useGroupMembers(group.id);
  const ourSkills = skills.data ? new Set(skills.data.map((skill) => skill.id)) : undefined;
  const context = { group, ourSkills };

  // Текст берём только у НАШЕГО скилла: у скилла проекта тёзка из общего
  // каталога — другой файл, и его разделы здесь соврали бы.
  const known = new Map<string, KnownSkill>();
  for (const skill of skills.data ?? []) {
    if (skillSource(skill.id, context).kind === 'our-skill') {
      known.set(skill.id, { description: skill.description, body: skill.body });
    }
  }
  // Скиллу проекта и чужому описание даёт сервер — из файла там, где он лежит.
  for (const brief of briefs.data?.members ?? []) {
    if (brief.kind === 'skill' && brief.description && !known.has(brief.id)) {
      known.set(brief.id, { description: brief.description, body: '' });
    }
  }

  const sourceOf = (row: PathRow): StepSource =>
    row.kind === 'skill' ? skillSource(row.skillId, context) : entrySource(row.entry, context);

  const fileOf = (source: StepSource): string | undefined => {
    // Скрипт хука ищется в общем списке — у хука проекта его там нет.
    const hookScript =
      source.kind === 'hook' && !source.project
        ? hooks.data?.find((hook) => hook.id === source.id)?.scriptPath
        : undefined;
    return sourceFile(source, location.data?.paths, hookScript);
  };

  const words: WordsSource = {
    language: i18n.language,
    view: briefs.data,
    stageTitle: (stage) => t(`groupPath.stage.${stage}`),
    stageHint: (stage) => t(`groupPath.stageHint.${stage}`),
    wholeTitle: (id) => t('groupPath.wholeSkill', { id }),
    pendingStepTitle: (number) => t('groupPath.pendingStep', { number }),
    notDescribedLine: t('groupPath.notDescribedStep'),
    sectionText: (skillId, index) => {
      const body = known.get(skillId)?.body;
      return body ? skillTextSteps(body)[index]?.body : undefined;
    },
  };

  return {
    language: i18n.language,
    known,
    sourceOf,
    fileOf,
    typeOf: (row: PathRow) => rowType(sourceOf(row)),
    /** Вид блока скилла — по скиллу, не по первой строке блока. */
    blockTypeOf: (skillId: string) => skillBlockType(skillId, context),
    wordsOf: (row: PathRow) => rowWords(row, words),
    bilingualOf: (row: PathRow) => rowBilingual(row, words),
    /** Имя скилла на языке интерфейса — заголовок его блока. */
    skillTitle: (skillId: string): string => {
      const member = briefs.data?.members.find(
        (item) => item.kind === 'skill' && item.id === skillId,
      );
      return member?.title ? pickLang(member.title, i18n.language) : skillId;
    },
  };
}
