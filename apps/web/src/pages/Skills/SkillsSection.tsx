import { useProviders, activeProvider } from '@entities/Provider';
import { ProviderSkillsPage } from '@pages/ProviderSkills/ProviderSkillsPage';
import { SkillsPage } from './SkillsPage';

/**
 * Раздел скиллов по МОДЕЛИ активного провайдера, а не по его id. Моделей две:
 *
 *  - `claude` — богатый раздел скиллов панели (включение переносом в
 *    `skills-disabled`, группы, ассистент формы). Открывает ПРЕЖНЯЯ страница без
 *    единого изменения — регресс-ноль;
 *  - `files` — скиллы самого CLI (OpenCode: каталог `<каталог>/<имя>/SKILL.md`).
 *
 * Модель приходит с сервера (`skillsModel`); пока данные не загружены,
 * показываем страницу Claude — дефолтный провайдер именно такой.
 */
export function SkillsSection() {
  const { data } = useProviders();
  const model = activeProvider(data)?.skillsModel ?? 'claude';

  if (model === 'files') return <ProviderSkillsPage />;
  return <SkillsPage />;
}
