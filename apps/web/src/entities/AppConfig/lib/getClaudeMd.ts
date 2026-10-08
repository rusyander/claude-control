import type { InstructionsFileInfo } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';

export async function getClaudeMd(): Promise<InstructionsFileInfo> {
  // Раздел универсален по активному провайдеру: сервер отдаёт содержимое файла
  // инструкций (CLAUDE.md/AGENTS.md/GEMINI.md) вместе с метаданными — имя файла,
  // путь, обнаружен ли CLI и данные провайдера, — по которым адаптируется страница.
  const { data } = await apiClient.get<InstructionsFileInfo>('/claude-md');
  return data;
}
