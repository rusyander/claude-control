import { useProviders, activeProvider } from '@entities/Provider';
import { ProviderInstructionsPage } from '@pages/ProviderInstructions/ProviderInstructionsPage';
import { ProviderRulesPage } from '@pages/ProviderRules/ProviderRulesPage';
import { ClaudeMdPage } from './ClaudeMdPage';

/**
 * Раздел инструкций по МОДЕЛИ активного провайдера, а не по его id. Моделей три:
 *
 *  - `file` — ОДИН файл (CLAUDE.md / AGENTS.md / GEMINI.md): Claude, Codex,
 *    Gemini, OpenCode. Открывает прежняя страница без изменений (регресс-ноль);
 *  - `list` — СПИСОК ССЫЛОК (Aider: опция `read` в `.aider.conf.yml`);
 *  - `rules` — КАТАЛОГ ПРАВИЛ `.mdc` (Cursor: `~/.cursor/rules/`).
 *
 * Модель приходит с сервера (`instructionsModel`); пока данные не загружены,
 * показываем «однофайловую» страницу — дефолтный провайдер claude именно такой.
 */
export function InstructionsSection() {
  const { data } = useProviders();
  const model = activeProvider(data)?.instructionsModel ?? 'file';

  if (model === 'list') return <ProviderInstructionsPage />;
  if (model === 'rules') return <ProviderRulesPage />;
  return <ClaudeMdPage />;
}
