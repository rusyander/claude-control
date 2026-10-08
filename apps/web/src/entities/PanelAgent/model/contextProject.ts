/**
 * Проект контекста. На «Тестировании» проект выбран в самом разделе (свой
 * выбор, не вкладка рабочей области), и вопрос «что упало в последнем прогоне»
 * без него агент решал по самому свежему прогону любого проекта.
 */
export function contextProject<T>(pathname: string, workspace?: T, tests?: T): T | undefined {
  const onTests = pathname === '/tests' || pathname.startsWith('/tests/');
  return (onTests ? tests : undefined) ?? workspace;
}
