import { defineConfig } from 'vitest/config';

/**
 * Тесты телефона — только логика (`shared/lib`): стор прогонов, транспорт,
 * очередь. Нативные модули (expo/fetch, AsyncStorage, react-native) в тестах
 * подменяются — их поведение проверяется на устройстве, а не здесь.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    clearMocks: true,
  },
});
