// Builds the desktop app's native audio host (Electron utility process) to dist-electron/native-host.cjs.
import { defineConfig } from 'vite';

export default defineConfig({
  publicDir: false,
  build: {
    outDir: 'dist-electron',
    emptyOutDir: true,
    target: 'node18',
    minify: false,
    sourcemap: false,
    lib: { entry: 'src/native/host.ts', formats: ['cjs'], fileName: () => 'native-host.cjs' },
    rollupOptions: { external: [/^node:/] },
  },
});
