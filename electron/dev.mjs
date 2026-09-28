// Development: start the Vite dev server and open it inside Electron with hot reload.
import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import electronPath from 'electron';

const server = await createServer();
await server.listen();
const url = server.resolvedUrls.local[0];
const child = spawn(electronPath, ['.', ...process.argv.slice(2)], { stdio: 'inherit', env: { ...process.env, CAL_DEV_URL: url } });
child.on('exit', async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
