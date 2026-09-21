import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { runTests } from '@vscode/test-electron';

async function main() {
  const extensionDevelopmentPath = path.resolve(__dirname, '../../');
  const extensionTestsPath = path.resolve(__dirname, './suite/index');

  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-test-workspace-'));
  const transcriptsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-test-transcripts-'));

  try {
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [workspaceDir, '--disable-extensions'],
      // Alternate ports/dir so this doesn't collide with a real Dev Host window
      // you might have open using the real defaults (45679 / 4318).
      extensionTestsEnv: {
        SNAGBOAT_CLAUDE_TRANSCRIPTS_DIR: transcriptsDir,
        SNAGBOAT_CLAUDE_HOOKS_PORT: '45680',
        SNAGBOAT_COPILOT_OTLP_PORT: '4319',
      },
    });
  } catch (err) {
    console.error('Failed to run tests', err);
    process.exit(1);
  }
}

main();
