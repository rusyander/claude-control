import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ClaudeLocation } from '@claude-control/contracts';
import type { AppStore } from '../../lib/app-store.ts';
import { readClaudeCredentials, writeSecretFile } from '../../lib/credentials.ts';
import { removeTree, sandboxKey, sandboxPaths } from './SandboxPaths.ts';
import { forgetExpired, forgetSandbox } from './SandboxRegistry.ts';
import { armSandboxSweeper } from './SandboxSweep.ts';
import { copyScripts, copySkills, writeRules } from './SandboxContents.ts';
import { buildSettings } from './SandboxSettings.ts';
import type { Sandbox, SandboxDescription, SandboxSelection } from './SandboxConfig.types.ts';

/**
 * Собирает песочницу под выбранные элементы.
 *
 * Учётные данные — единственное, что переносится из настоящего каталога:
 * без них Claude Code отвечает «Not logged in» и проверить ничего нельзя.
 * Файл с токенами MCP-серверов не копируется никогда.
 */
export function createSandbox(
  id: string,
  selection: SandboxSelection,
  location: ClaudeLocation,
  store: AppStore,
): Sandbox {
  const { root, configDir, workDir } = sandboxPaths(id);

  // Первая же песочница взводит периодическое подметание: иначе брошенная копия
  // доступа лежала бы на диске до перезапуска сервера (см. startSandboxSweeper).
  // Сервер взводит его и на старте, но createSandbox бывает и вне сервера.
  armSandboxSweeper();

  // Собранная заново песочница живая, чем бы ни была прежняя с тем же именем.
  forgetExpired(id);

  // Старую песочницу с тем же id сносим ПРОВЕРЕННО: если от неё что-то уцелело,
  // это «что-то» окажется внутри новой — вместе с чужими скиллами и настройками.
  const wiped = removeTree(root);
  if (!wiped.ok) throw new Error(`Не удалось очистить прежнюю песочницу: ${wiped.error}`);

  mkdirSync(configDir, { recursive: true });
  mkdirSync(workDir, { recursive: true });

  // Источник токена зависит от системы: файл на Windows и Linux, связка ключей
  // на macOS. Не нашлось — песочницу всё равно собираем: пусть человек увидит
  // внятную причину в интерфейсе, а не «Not logged in» из недр CLI.
  const credentials = readClaudeCredentials(location.paths.root);
  if (credentials.content) {
    // Именно writeSecretFile: это копия настоящего доступа к аккаунту, и она
    // не должна ни мгновения лежать с правами по умолчанию.
    writeSecretFile(join(configDir, '.credentials.json'), credentials.content);
  }

  const description: SandboxDescription = {
    rules: writeRules(configDir, selection, location, store),
    skills: copySkills(configDir, selection, location, store),
    scripts: [],
    hooks: [],
    mcpServers: [],
  };

  copyScripts(configDir, selection, location, description);

  const settings = buildSettings(configDir, selection, location, store, description);
  writeFileSync(join(configDir, 'settings.json'), JSON.stringify(settings, null, 2), 'utf8');

  return {
    id,
    configDir,
    workDir,
    description,
    credentials: { source: credentials.source, reason: credentials.reason },
    // Окружение запуска этой песочницы. Рабочая папка едет здесь, а не через
    // глобальный process.env: раньше collectHooks писал её в process.env сервера,
    // и при параллельной сборке двух песочниц значение протекало во все
    // последующие дочерние процессы (побеждала последняя). Здесь оно привязано к
    // конкретной песочнице. Ключ API файлом не кладётся — Claude Code читает его
    // из окружения.
    env: {
      CLAUDE_CONTROL_SANDBOX_WORKDIR: workDir,
      ...(credentials.apiKey ? { ANTHROPIC_API_KEY: credentials.apiKey } : {}),
    },
  };
}

/**
 * Удаление песочницы. Ошибку НЕ глотаем: внутри лежит копия доступа к аккаунту,
 * и «удалили» вместо «не смогли удалить» — худший из возможных ответов. Маршрут
 * `DELETE /api/sandbox/:id` возвращает `{ok:true}` последней строкой, поэтому
 * непроверенный отказ доходил до пользователя как успех; брошенное исключение
 * до этой строки не доводит.
 */
export function removeSandbox(id: string): void {
  const { root } = sandboxPaths(id);
  const result = removeTree(root);

  // Удалили по просьбе — это не «время вышло»: следующий прогон с тем же id
  // должен собрать песочницу заново, а не получить отказ по истечению.
  forgetSandbox(sandboxKey(id));

  if (!result.ok) {
    throw new Error(
      `Песочницу не удалось удалить (${result.error}). В ней осталась копия доступа к аккаунту — удалите папку ${root} вручную.`,
    );
  }
}
