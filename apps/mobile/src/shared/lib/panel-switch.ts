import type { MachineIdentity } from '@agentdeck/contracts';
import { api } from '../api/client';
import {
  currentConnection,
  describePanel,
  removePanel,
  saveConnection,
  switchPanel,
} from '../api/connection';
import { resetRuns } from './runs';
import { forgetWorkspace, loadWorkspace } from './workspace';

/**
 * Смена компьютера целиком. Пара для запросов — только часть: ещё потоки
 * прогонов прежней машины (иначе они дописывали бы её ответы в экраны новой) и
 * рабочее место — проект и разговор у каждой машины свои. Кэш запросов и
 * подхват идущих прогонов делает корень приложения по смене `activeId`.
 */

export async function activatePanel(id: string): Promise<void> {
  if (id === currentConnection().activeId) return;
  resetRuns();
  await switchPanel(id);
  await loadWorkspace(currentConnection().activeId);
}

/** Машина называет себя; без сети или на старой панели (без номера) имя остаётся прежним. */
export async function refreshIdentity(): Promise<void> {
  const { activeId } = currentConnection();
  if (!activeId) return;
  try {
    const info = await api.get<Partial<MachineIdentity>>('/system');
    if (typeof info.machineId !== 'string' || !info.machineId) return;
    await describePanel(activeId, {
      machineId: info.machineId,
      machineName: info.machineName ?? '',
      platform: info.platform ?? '',
    });
  } catch {
    // Машина не ответила — подпись обновится при следующем запуске.
  }
}

/** Спаривание по коду или руками: новый компьютер или новый адрес знакомого. */
export async function pairPanel(url: string, token: string): Promise<void> {
  const before = currentConnection().activeId;
  const id = await saveConnection(url, token);
  if (id !== before) resetRuns();
  await refreshIdentity();
  const after = currentConnection().activeId;
  if (after !== before) await loadWorkspace(after);
}

/** Забыть компьютер: токен, место и — если был выбран — его потоки. */
export async function forgetPanel(id: string): Promise<void> {
  const wasActive = id === currentConnection().activeId;
  if (wasActive) resetRuns();
  await removePanel(id);
  await forgetWorkspace(id);
  if (wasActive) await loadWorkspace(currentConnection().activeId);
}

/** Компьютер, с которого пришло уведомление, — по номеру машины из push. */
export function panelForMachine(machineId: unknown): string | undefined {
  if (typeof machineId !== 'string' || !machineId) return undefined;
  return currentConnection().panels.find((entry) => entry.machineId === machineId)?.id;
}
