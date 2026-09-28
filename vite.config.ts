import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: { target: 'es2022', sourcemap: true },
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
} as any);
