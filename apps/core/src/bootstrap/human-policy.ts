import type { ModelToolDeps } from '../conductor/model-tools/model-tools.types.ts';
import { readCoreConfig } from '../platform/core-config/read.ts';
import type { CoreHomeLayout } from '../platform/core-home.ts';
import { withFloor } from '../policy/human-point/floor.ts';
import { grantRequiredFor } from './session-road/permit-sources.ts';
import { sourceRepoOf } from './session-road/source-repo.ts';

/**
 * Политика человека задачи для вопросов модели (06:22, P130): пол платформы ∪ раздел
 * `humanPoints` конфига ядра ∪ строки `grantRequired` проекта задачи (тот же отбор по исходному
 * репозиторию, что у судьи права дороги). Читается на каждый вопрос — правка через
 * `/v1/config` действует со следующего. Настройка не прочлась — пол: пункты платформы не
 * пропадают, а расширения человека без файла назвать нельзя.
 */
export function humanPolicyOf(
  layout: Pick<CoreHomeLayout, 'config'>,
): ModelToolDeps['humanPolicy'] {
  return (task, b) => {
    const read = readCoreConfig(layout);
    const points = 'value' in read ? read.value.doc.humanPoints : undefined;
    const rows = grantRequiredFor(layout.config, sourceRepoOf(task, b.stepId)).entries;
    return withFloor(points, rows);
  };
}
