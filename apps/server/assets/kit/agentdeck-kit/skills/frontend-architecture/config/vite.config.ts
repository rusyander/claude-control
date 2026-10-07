// Reference Vite config of the frontend doctrine. Adapt plugins/aliases to the project.
// npm i -D vite @vitejs/plugin-react vite-tsconfig-paths
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  // React Compiler (when the project enables it — quality.md §Optimisation):
  //   react({ babel: { plugins: [['babel-plugin-react-compiler', {}]] } })
  plugins: [react(), tsconfigPaths()],
  build: { target: 'es2022', sourcemap: true },
  server: { port: 5173 },
});
