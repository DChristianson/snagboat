import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { downloadAndUnzipVSCode, runTests } from '@vscode/test-electron';

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
 * Runs the integration suite twice: with VS Code's per-window storage (the
 * default), then with snagboat.storage.perUserStore on, set in a private user
 * settings folder, so every test also passes against the per-user store. Each
 * run gets fresh folders.
 */
async function runSuite(vscodeExecutablePath: string, perUserStore: boolean): Promise<void> {
  const extensionDevelopmentPath = path.resolve(__dirname, '../../');
  const extensionTestsPath = path.resolve(__dirname, './suite/index');

  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-test-workspace-'));
  const transcriptsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-test-transcripts-'));
  const snagboatHome = fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-test-home-'));
  const copilotSessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-test-copilot-sessions-'));
  const launchArgs = [workspaceDir, '--disable-extensions'];
  if (perUserStore) {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-test-user-data-'));
    fs.mkdirSync(path.join(userDataDir, 'User'));
    fs.writeFileSync(path.join(userDataDir, 'User', 'settings.json'), JSON.stringify({ 'snagboat.storage.perUserStore': true }));
    launchArgs.push(`--user-data-dir=${userDataDir}`);
  }

  console.log(`\n=== integration suite, ${perUserStore ? 'per-user store (snagboat.storage.perUserStore on)' : "VS Code's storage"}`);
  await runTests({
    vscodeExecutablePath,
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs,
    // A private Snagboat home (hook routes and script, and the per-user store) and
    // alternate OTLP port, so this doesn't touch or collide with a real window you
    // might have open (~/.snagboat, port 4318).
    extensionTestsEnv: {
      SNAGBOAT_CLAUDE_TRANSCRIPTS_DIR: transcriptsDir,
      SNAGBOAT_HOME: snagboatHome,
      SNAGBOAT_COPILOT_SESSIONS_DIR: copilotSessionsDir,
      SNAGBOAT_COPILOT_DISCOVERY_MS: '500',
      SNAGBOAT_COPILOT_OTLP_PORT: '4319',
      SNAGBOAT_TEST_PER_USER_STORE: perUserStore ? '1' : '',
    },
  });
}

async function main() {
  clearInheritedVsCodeEnv();
  try {
    // CI also tests the minimum supported VS Code (engines.vscode); default is the latest stable.
    const vscodeExecutablePath = await downloadVSCode(process.env.SNAGBOAT_TEST_VSCODE_VERSION || 'stable');
    await runSuite(vscodeExecutablePath, false);
    await runSuite(vscodeExecutablePath, true);
  } catch (err) {
    console.error('Failed to run tests', err);
    process.exit(1);
  }
}

main();
