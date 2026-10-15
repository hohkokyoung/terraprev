// terraprev dev: runs the API (:4610) and the web app (:4600) together, on any OS.
// Stops both when either exits or on Ctrl+C.
//
//   node server/src/cli/dev.ts      (what `npm run dev` runs)

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { ROOT } from '../config.ts';

const win = process.platform === 'win32';
const children: ChildProcess[] = [];
let stopping = false;

for (const workspace of ['server', 'web']) {
  // npm is npm.cmd on Windows, which Node only launches through a shell.
  const child = spawn('npm', ['run', 'dev', '-w', workspace], { cwd: ROOT, stdio: 'inherit', shell: win });
  child.on('exit', (code) => stop(code ?? 1));
  children.push(child);
}

process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));

function stop(code: number) {
  if (stopping) return;
  stopping = true;
  for (const c of children) {
    if (c.exitCode !== null || c.pid === undefined) continue;
    // On Windows, killing the shell leaves npm, node and vite running; take down the whole tree.
    if (win) spawnSync('taskkill', ['/pid', String(c.pid), '/t', '/f'], { stdio: 'ignore' });
    else c.kill('SIGTERM');
  }
  process.exitCode = code;
}
