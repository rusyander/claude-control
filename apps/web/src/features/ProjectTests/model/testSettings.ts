import type {
  ProjectTestAttributeDef,
  ProjectTestEnvironment,
  ProjectTestGroup,
  ProjectTestPlan,
} from '@agentdeck/contracts';

/**
 * Счёт и проверки окна «Настройки набора».
 *
 * Всё здесь чистое и считается по тому же виду, который уже приехал на экран:
 * лишний запрос ради «в скольких кейсах используется общий шаг» означал бы
 * второй источник правды о файлах, которые панель и так держит целиком.
 */

/**
 * Сколько кейсов ссылается на каждый общий шаг.
 *
 * Ссылка — это `ref` шага кейса; `action` при ней держит подпись для чтения,
 * поэтому считать по названиям нельзя. Архивные кейсы считаются наравне:
 * шаг, оставшийся только в архиве, всё равно сломает архивный кейс, если его
 * удалить, — а удалять шаг никто не мешает, просто теперь видно, что чинить.
 */
export function sharedStepUsage(groups: ProjectTestGroup[]): Map<string, number> {
  const usage = new Map<string, number>();
  for (const group of groups) {
    if (group.error) continue;
    for (const testCase of group.cases) {
      const refs = new Set(
        testCase.steps.map((step) => step.ref).filter((ref): ref is string => Boolean(ref)),
      );
      for (const ref of refs) usage.set(ref, (usage.get(ref) ?? 0) + 1);
    }
  }
  return usage;
}

/** Планы, которые останутся без окружения, если его убрать. */
export function plansUsingEnvironment(
  plans: ProjectTestPlan[],
  environmentId: string,
): ProjectTestPlan[] {
  return plans.filter((plan) => plan.environmentIds?.includes(environmentId));
}

/**
 * Что не так со своим полем — строкой для человека, или ничего.
 *
 * Проверяется то же, что и на сервере, и по той же причине: ключ уезжает в
 * каждый кейс (`attributes[key]`), а поле-выбор без вариантов нечем заполнить.
 * Дублировать не жалко — форма обязана сказать это ДО отправки, а сервер
 * остаётся последним рубежом для всех остальных входов.
 */
export function attributeProblem(
  draft: ProjectTestAttributeDef,
  existing: ProjectTestAttributeDef[],
  originalKey?: string,
): 'key' | 'duplicate' | 'options' | undefined {
  const key = draft.key.trim();
  if (!/^[a-zA-Z0-9._-]+$/.test(key)) return 'key';
  if (key !== originalKey && existing.some((item) => item.key === key)) return 'duplicate';
  if (draft.type === 'select' && (draft.options ?? []).filter(Boolean).length === 0) {
    return 'options';
  }
  return undefined;
}

/**
 * Живые окружения: архивные уезжают вниз, а не исчезают.
 *
 * Убранное в архив окружение продолжает называться в старых прогонах, и прятать
 * его совсем значило бы оставить в истории ссылку на «неизвестно что».
 */
export function sortEnvironments(items: ProjectTestEnvironment[]): ProjectTestEnvironment[] {
  return [...items].sort((left, right) => {
    if (Boolean(left.archived) !== Boolean(right.archived)) return left.archived ? 1 : -1;
    if (Boolean(left.isDefault) !== Boolean(right.isDefault)) return left.isDefault ? -1 : 1;
    return left.title.localeCompare(right.title, 'ru');
  });
}
