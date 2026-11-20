import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { downloadAndUnzipVSCode, runTests } from '@vscode/test-electron';
import { sanitizeCwd } from '../adapters/claude-code/workspace';
import { coreRequest, readCoreFile } from '../core/service/coreFile';

/**
 * When npm test is started by a process running inside VS Code's extension
 * host (an AI agent in VS Code, say), it inherits ELECTRON_RUN_AS_NODE=1 and
 * VS Code's internal VSCODE_* variables. ELECTRON_RUN_AS_NODE makes the test
 * VS Code start as plain Node, which then fails with "Cannot find module
 * <workspace folder>". Clear them so the test instance always starts as an app.
 */
function clearInheritedVsCodeEnv(): void {
  for (const name of Object.keys(process.env)) {
    if (name === 'ELECTRON_RUN_AS_NODE' || name === 'ELECTRON_NO_ATTACH_CONSOLE' || name.startsWith('VSCODE_')) delete process.env[name];
  }
}

/** Downloads the VS Code to test with, retrying network failures (CI runners hit them now and then); the tests themselves aren't retried. */
async function downloadVSCode(version: string, attempts = 3): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await downloadAndUnzipVSCode(version);
    } catch (err) {
      if (attempt >= attempts) throw err;
      console.warn(`Downloading VS Code ${version} failed (attempt ${attempt} of ${attempts}); retrying in ${attempt * 10}s`, err);
      await new Promise((resolve) => setTimeout(resolve, attempt * 10_000));
    }
  }
}

/**
 * Runs the integration suite with no setting changed, as a fresh install gets
 * it: the window starts the core and is its client. Fresh folders each run.
 */
async function runSuite(vscodeExecutablePath: string): Promise<void> {
  const extensionDevelopmentPath = path.resolve(__dirname, '../../');
  const extensionTestsPath = path.resolve(__dirname, './suite/index');

  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-test-workspace-'));
  // Claude Code's projects folder, which the core reads; the suite writes the test workspace's transcripts in it.
  const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-test-projects-'));
  const transcriptsDir = path.join(projectsDir, sanitizeCwd(workspaceDir));
  fs.mkdirSync(transcriptsDir);
  const snagboatHome = fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-test-home-'));
  const copilotSessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-test-copilot-sessions-'));
  // VS Code's own user data, fresh each run (no state from an earlier run), and short: its IPC socket lives
  // there, and a deep checkout's .vscode-test/user-data can pass the OS's limit on socket path length.
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-test-user-data-'));

  await runTests({
    vscodeExecutablePath,
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: [workspaceDir, '--disable-extensions', `--user-data-dir=${userDataDir}`],
    // A private Snagboat home (the hook script, the per-user store and the core) and
    // alternate OTLP port, so this doesn't touch or collide with a real window you
    // might have open (~/.snagboat, port 4318).
    extensionTestsEnv: {
      SNAGBOAT_TEST_TRANSCRIPTS_DIR: transcriptsDir,
      SNAGBOAT_CLAUDE_PROJECTS_DIR: projectsDir,
      SNAGBOAT_HOME: snagboatHome,
      SNAGBOAT_COPILOT_SESSIONS_DIR: copilotSessionsDir,
      SNAGBOAT_COPILOT_DISCOVERY_MS: '500',
      SNAGBOAT_COPILOT_OTLP_PORT: '4319',
    },
  }).finally(() => stopCore(snagboatHome));
}

/** The core the test window started outlives it (it exits when idle); stop it with the run. */
async function stopCore(home: string): Promise<void> {
  const info = readCoreFile(home);
  if (!info) return;
  await coreRequest(info.port, info.token, 'POST', '/shutdown', {}).catch(() => undefined);
}

async function main() {
  clearInheritedVsCodeEnv();
  try {
    // CI also tests the minimum supported VS Code (engines.vscode); default is the latest stable.
    const vscodeExecutablePath = await downloadVSCode(process.env.SNAGBOAT_TEST_VSCODE_VERSION || 'stable');
    await runSuite(vscodeExecutablePath);
  } catch (err) {
    console.error('Failed to run tests', err);
    process.exit(1);
  }
}

main();
