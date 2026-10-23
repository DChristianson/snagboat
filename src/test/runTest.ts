import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { runTests } from '@vscode/test-electron';

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

async function main() {
  clearInheritedVsCodeEnv();
  const extensionDevelopmentPath = path.resolve(__dirname, '../../');
  const extensionTestsPath = path.resolve(__dirname, './suite/index');

  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-test-workspace-'));
  const transcriptsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-test-transcripts-'));
  const snagboatHome = fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-test-home-'));

  try {
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [workspaceDir, '--disable-extensions'],
      // A private Snagboat home (hook routes and script) and alternate OTLP
      // port, so this doesn't touch or collide with a real window you might
      // have open (~/.snagboat, port 4318).
      extensionTestsEnv: {
        SNAGBOAT_CLAUDE_TRANSCRIPTS_DIR: transcriptsDir,
        SNAGBOAT_HOME: snagboatHome,
        SNAGBOAT_COPILOT_OTLP_PORT: '4319',
      },
    });
  } catch (err) {
    console.error('Failed to run tests', err);
    process.exit(1);
  }
}

main();
