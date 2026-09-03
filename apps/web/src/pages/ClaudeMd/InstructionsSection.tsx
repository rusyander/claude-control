import { SkeletonList } from '@shared/ui/skeleton';
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
 * показываем скелет, а не «однофайловую» страницу: та сразу запрашивает
 * /api/claude-md, и у провайдера без глобальных инструкций (Continue) запрос
 * отвечал 400 ещё до того, как раздел успевал показать свою заглушку.
 */
export function InstructionsSection() {
  const { data } = useProviders();
  if (data === undefined) return <SkeletonList rows={6} withActions={false} />;
  const model = activeProvider(data)?.instructionsModel ?? 'file';

  if (model === 'list') return <ProviderInstructionsPage />;
  if (model === 'rules') return <ProviderRulesPage />;
  return <ClaudeMdPage />;
}
