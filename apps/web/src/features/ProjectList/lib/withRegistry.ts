import type { Project } from '@agentdeck/contracts';
import type { ProjectInfo } from '@entities/Project';
import { normalizeProjectPath } from '@shared/lib/workspace';

/** Строка списка проектов чата: проект и его запись на странице «Проекты», если есть. */
export interface ListedProject {
  info: ProjectInfo;
  registered?: Project;
}

/**
 * Проекты чата = история Claude Code плюс реестр страницы «Проекты».
 *
 * История знает только каталоги, где уже были разговоры: папку, открытую в чате
 * и закрытую до первого сообщения, она забывала, и вернуть её можно было только
 * новым поиском по диску. Реестр помнит проект, пока человек сам его не уберёт,
 * поэтому его записи стоят в списке всегда — и первыми.
 *
 * Каталогов истории, которых на диске уже нет, в списке нет (как и раньше); о
 * записи реестра клиент этого не знает — сервер проверил каталог при добавлении.
 */
export function withRegistry(history: ProjectInfo[], registry: Project[]): ListedProject[] {
  const byPath = new Map(registry.map((project) => [normalizeProjectPath(project.path), project]));
  const seen = new Set<string>();
  const saved: ListedProject[] = [];
  const rest: ListedProject[] = [];
  for (const info of history) {
    const key = normalizeProjectPath(info.path);
    const registered = byPath.get(key);
    if (registered) {
      seen.add(key);
      saved.push({ info, registered });
    } else if (info.exists) {
      rest.push({ info });
    }
  }
  for (const project of registry) {
    const key = normalizeProjectPath(project.path);
    if (seen.has(key)) continue;
    seen.add(key);
    saved.push({
      info: { path: project.path, name: project.name, exists: true, lastActivity: '', chats: [] },
      registered: project,
    });
  }
  // Свежая активность выше; проекты без разговоров — после, по имени.
  saved.sort(
    (a, b) =>
      b.info.lastActivity.localeCompare(a.info.lastActivity) ||
      a.info.name.localeCompare(b.info.name),
  );
  return [...saved, ...rest];
}
