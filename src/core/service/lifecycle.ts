import { spawn } from 'child_process';
import { CoreInfo, coreRequest, liveCore } from './coreFile';

/**
 * Finding or starting the core from a front door (3c-2): "the first front door
 * that needs it starts it". The core runs as `node <cli> serve`, detached, so
 * it outlives whoever started it and exits on its own after an idle period.
 */

/** The running core, after checking it answers; undefined if none does. */
export async function findCore(home: string): Promise<CoreInfo | undefined> {
  const info = liveCore(home);
  if (!info) return undefined;
  try {
    const res = await coreRequest(info.port, info.token, 'GET', '/health', undefined, 2_000);
    return res.status === 200 ? info : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The running core, or one started in the background from the CLI script at
 * cliPath. In VS Code's extension host process.execPath is Electron, which
 * ELECTRON_RUN_AS_NODE makes run as Node; plain Node ignores it.
 */
export async function ensureCore(home: string, cliPath: string, opts: { idleMinutes?: number; timeoutMs?: number; collect?: boolean } = {}): Promise<CoreInfo> {
  const running = await findCore(home);
  if (running) return running;
  const args = [cliPath, 'serve'];
  if (opts.idleMinutes !== undefined) args.push('--idle-minutes', String(opts.idleMinutes));
  if (opts.collect === false) args.push('--no-collect');
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, SNAGBOAT_HOME: home, ELECTRON_RUN_AS_NODE: '1' },
    windowsHide: true,
  });
  child.unref();
  const deadline = Date.now() + (opts.timeoutMs ?? 10_000);
  while (Date.now() < deadline) {
    const info = await findCore(home);
    if (info) return info;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`the core didn't start within ${Math.round((opts.timeoutMs ?? 10_000) / 1000)}s`);
}
