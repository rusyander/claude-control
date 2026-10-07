// Reference Vitest config of the frontend doctrine.
// npm i -D vitest jsdom @testing-library/react @testing-library/jest-dom @vitejs/plugin-react vite-tsconfig-paths
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [react(), tsconfigPaths()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'], // import '@testing-library/jest-dom'
    coverage: { provider: 'v8', reporter: ['text', 'html'] },
  },
});
