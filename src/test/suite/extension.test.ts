import * as assert from 'assert';
import * as vscode from 'vscode';
import { SnagboatTestApi } from '../../extension';

suite('Snagboat core plumbing', () => {
  test('emitting a test event flows through bus -> aggregate -> snapshot', async () => {
    const ext = vscode.extensions.getExtension<SnagboatTestApi>('snagboat.snagboat');
    assert.ok(ext, 'extension should be present');
    const api = await ext!.activate();

    const before = api.getAggregateSnapshot();
    const beforeTokens = before.totalTokens;
    const beforeEvents = before.perAgent['claude-code']?.eventCount ?? 0;

    await vscode.commands.executeCommand('snagboat._emitTestEvent');
    await vscode.commands.executeCommand('snagboat._emitTestEvent');

    const after = api.getAggregateSnapshot();
    assert.strictEqual(after.totalTokens, beforeTokens + 2 * 35, 'total tokens should include both emitted events');
    assert.strictEqual(
      after.perAgent['claude-code'].eventCount,
      beforeEvents + 2,
      'claude-code event count should increase by 2'
    );
  });
});
