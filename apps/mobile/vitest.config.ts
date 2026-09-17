import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Тесты телефона — только логика (`shared/lib`): стор прогонов, транспорт,
 * очередь. Нативные модули (expo/fetch, AsyncStorage, react-native) в тестах
 * подменяются — их поведение проверяется на устройстве, а не здесь.
 */
export default defineConfig({
  resolve: {
    // Модули-значения контрактов — прямо в исходник, как в `metro.config.js`.
    alias: [
      {
        find: /^@agentdeck\/contracts\/(.+)$/,
        replacement: fileURLToPath(new URL('../../packages/contracts/src/$1.ts', import.meta.url)),
      },
    ],
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    clearMocks: true,
  },
});
