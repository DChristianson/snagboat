import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import * as jsonc from 'jsonc-parser';
import { runCli } from '../../cli/main';
import { applyDevcontainerPlan, BEADS_EXPORT_SCRIPT, BEADS_EXPORT_START, describePlan, personalConfigPath, planDevcontainer, SAME_PATH_MOUNT, unifiedDiff } from '../../core/devcontainerSetup';

// `snagboat containers allow` checks the folder's dev container and, with --edit, sets it up (bead snagboat-05p).

const SHARED = `// The team's dev container.
{
  "name": "proj-dev",
  "build": { "dockerfile": "Dockerfile" },
  "remoteUser": "vscode",
  "features": {
    "./local-feature": {},
    "ghcr.io/devcontainers/features/node:1": { "version": "24" }
  },
  "postStartCommand": "echo started"
}
`;

function project(shared = SHARED) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-devcontainer-')));
  const folder = path.join(root, 'proj');
  fs.mkdirSync(path.join(folder, '.devcontainer'), { recursive: true });
  assert.strictEqual(spawnSync('git', ['init', '-q', folder]).status, 0);
  const configPath = path.join(folder, '.devcontainer', 'devcontainer.json');
  fs.writeFileSync(configPath, shared);
  return { root, folder, configPath, home: path.join(root, 'home', '.snagboat') };
}

const exclude = (folder: string) => fs.readFileSync(path.join(folder, '.git', 'info', 'exclude'), 'utf8');

const tests: Array<[string, () => void | Promise<void>]> = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn]);

test('no devcontainer.json: nothing to plan', () => {
  const { folder, configPath } = project();
  fs.rmSync(configPath);
  assert.strictEqual(planDevcontainer(folder), undefined);
  assert.strictEqual(describePlan(undefined), 'no devcontainer.json');
});

test('a personal config: the shared one plus the mounts, paths rebased, comments kept; then ready', () => {
  const { folder, configPath } = project();
  const plan = planDevcontainer(folder)!;
  assert.strictEqual(plan.state, 'changes');
  assert.strictEqual(plan.outPath, personalConfigPath(folder));
  assert.strictEqual(plan.personalName, 'proj-dev (Snagboat)');
  assert.ok(plan.createsTranscriptsDir);
  assert.deepStrictEqual(plan.ignoreLines, ['/.snagboat/', '/.devcontainer/snagboat/']);
  const after = jsonc.parse(plan.after);
  assert.strictEqual(after.workspaceMount, SAME_PATH_MOUNT);
  assert.strictEqual(after.workspaceFolder, '${localWorkspaceFolder}');
  assert.deepStrictEqual(after.mounts, ['source=${localWorkspaceFolder}/.snagboat/claude-projects,target=/home/vscode/.claude/projects,type=bind']);
  assert.deepStrictEqual(after.build, { dockerfile: '../Dockerfile', context: '..' });
  assert.ok('../local-feature' in after.features && !('./local-feature' in after.features), JSON.stringify(after.features));
  assert.match(after.postStartCommand, /safe\.directory.*; echo started$/);
  assert.match(plan.after, /\/\/ The team's dev container\./);
  assert.match(plan.after, /^\/\/ snagboat-personal-config base=\w+ generated=\w+$/m);
  assert.match(describePlan(plan), /^not set up: \.devcontainer\/snagboat\/devcontainer\.json to write/);

  const wrote = applyDevcontainerPlan(plan);
  assert.strictEqual(wrote.length, 3, wrote.join('\n'));
  assert.strictEqual(fs.readFileSync(configPath, 'utf8'), SHARED, 'the shared config is untouched');
  assert.ok(fs.statSync(path.join(folder, '.snagboat', 'claude-projects')).isDirectory());
  assert.match(exclude(folder), /^\/\.snagboat\/\n\/\.devcontainer\/snagboat\/\n$/m);

  const again = planDevcontainer(folder)!;
  assert.strictEqual(again.state, 'ready', JSON.stringify(again, null, 2));
  assert.strictEqual(describePlan(again), 'set up (.devcontainer/snagboat/devcontainer.json)');
  assert.deepStrictEqual(applyDevcontainerPlan(again), []);
});

test('the shared config changes: the personal one is regenerated; edited by hand: refused unless forced', () => {
  const { folder, configPath } = project();
  applyDevcontainerPlan(planDevcontainer(folder)!);
  fs.writeFileSync(configPath, SHARED.replace('"remoteUser": "vscode"', '"remoteUser": "dev"'));
  const regen = planDevcontainer(folder)!;
  assert.strictEqual(regen.state, 'changes');
  assert.ok(regen.notes.some((n) => /changed since .* was made: regenerating it/.test(n)), regen.notes.join('\n'));
  assert.match(regen.after, /target=\/home\/dev\/\.claude\/projects/);
  applyDevcontainerPlan(regen);

  const personal = personalConfigPath(folder);
  fs.writeFileSync(personal, fs.readFileSync(personal, 'utf8').replace('"proj-dev (Snagboat)"', '"mine"'));
  const refused = planDevcontainer(folder)!;
  assert.strictEqual(refused.state, 'refused');
  assert.match(refused.problem!, /edited since it was made/);
  assert.deepStrictEqual(applyDevcontainerPlan(refused), []);
  assert.match(fs.readFileSync(personal, 'utf8'), /"mine"/);
  const forced = planDevcontainer(folder, { force: true })!;
  assert.strictEqual(forced.state, 'changes');
  applyDevcontainerPlan(forced);
  assert.match(fs.readFileSync(personal, 'utf8'), /"proj-dev \(Snagboat\)"/);
});

test('in place: edits the shared config and .gitignore; a shared config already set up needs no personal one', () => {
  const { folder, configPath } = project();
  const plan = planDevcontainer(folder, { inPlace: true })!;
  assert.strictEqual(plan.outPath, configPath);
  assert.deepStrictEqual(plan.ignoreLines, ['.snagboat/']);
  assert.strictEqual(plan.personalName, undefined);
  applyDevcontainerPlan(plan);
  assert.strictEqual(jsonc.parse(fs.readFileSync(configPath, 'utf8')).name, 'proj-dev');
  assert.match(fs.readFileSync(path.join(folder, '.gitignore'), 'utf8'), /^\.snagboat\/$/m);
  assert.strictEqual(planDevcontainer(folder, { inPlace: true })!.state, 'ready');
  const personal = planDevcontainer(folder)!;
  assert.strictEqual(personal.state, 'ready', JSON.stringify(personal, null, 2));
  assert.strictEqual(describePlan(personal), 'set up (.devcontainer/devcontainer.json)');
  assert.ok(!fs.existsSync(personalConfigPath(folder)));
});

test('refused: compose configs, another workspaceMount (unless forced), another transcripts mount, a linked .snagboat', () => {
  let p = project('{ "dockerComposeFile": "compose.yml", "service": "app" }');
  assert.match(planDevcontainer(p.folder)!.problem!, /dockerComposeFile/);

  p = project('{ "workspaceMount": "source=${localWorkspaceFolder},target=/work,type=bind", "workspaceFolder": "/work" }');
  assert.match(planDevcontainer(p.folder)!.problem!, /not the same-path mount\. Rerun with --force/);
  assert.strictEqual(jsonc.parse(planDevcontainer(p.folder, { force: true })!.after).workspaceMount, SAME_PATH_MOUNT);

  p = project('{ "mounts": ["source=claude,target=/root/.claude/projects,type=volume"] }');
  assert.match(planDevcontainer(p.folder)!.problem!, /already targets \/root\/\.claude\/projects/);

  p = project('{}');
  fs.symlinkSync(p.root, path.join(p.folder, '.snagboat'));
  assert.match(planDevcontainer(p.folder)!.problem!, /is a link or a file/);
});

test('CLAUDE_CONFIG_DIR and root decide where the transcripts mount goes', () => {
  let p = project('{ "containerEnv": { "CLAUDE_CONFIG_DIR": "/data/claude/" } }');
  assert.match(planDevcontainer(p.folder)!.after, /target=\/data\/claude\/projects,type=bind/);
  p = project('{}');
  assert.match(planDevcontainer(p.folder)!.after, /target=\/root\/\.claude\/projects,type=bind/);
});

test('no .beads: no beads exporter', () => {
  const { folder } = project();
  const plan = planDevcontainer(folder)!;
  assert.strictEqual(plan.beadsExportPath, undefined);
  assert.strictEqual(plan.writesBeadsExport, false);
  assert.ok(!jsonc.parse(plan.after).postStartCommand.includes('beads-export'));
});

test('with .beads: writes .snagboat/bin/beads-export.sh and starts it last on start; then ready; an old copy is updated', () => {
  const { folder } = project();
  fs.mkdirSync(path.join(folder, '.beads'));
  const script = path.join(folder, '.snagboat', 'bin', 'beads-export.sh');
  const plan = planDevcontainer(folder)!;
  assert.strictEqual(plan.state, 'changes');
  assert.strictEqual(plan.beadsExportPath, script);
  assert.ok(plan.writesBeadsExport);
  const post: string = jsonc.parse(plan.after).postStartCommand;
  assert.ok(post.endsWith(`; echo started; ${BEADS_EXPORT_START}`), post);
  assert.ok(plan.changes.some((c) => /starts \.snagboat\/bin\/beads-export\.sh last/.test(c)), plan.changes.join('\n'));
  assert.match(describePlan(plan), /\.snagboat\/bin\/beads-export\.sh to write/);

  const wrote = applyDevcontainerPlan(plan);
  assert.ok(wrote.includes('wrote .snagboat/bin/beads-export.sh'), wrote.join('\n'));
  assert.strictEqual(fs.readFileSync(script, 'utf8'), BEADS_EXPORT_SCRIPT);
  assert.strictEqual(fs.statSync(script).mode & 0o777, 0o755);
  assert.strictEqual(planDevcontainer(folder)!.state, 'ready');

  fs.writeFileSync(script, '#!/bin/sh\n# an older one\n');
  const update = planDevcontainer(folder)!;
  assert.strictEqual(update.state, 'changes');
  assert.ok(update.writesBeadsExport && !update.writesConfig);
  assert.match(describePlan(update), /beads-export\.sh to update/);
  applyDevcontainerPlan(update);
  assert.strictEqual(fs.readFileSync(script, 'utf8'), BEADS_EXPORT_SCRIPT);

  // The start step is a no-op where the script isn't there (a collaborator's clone of an in-place config).
  fs.rmSync(script);
  const run = spawnSync('sh', ['-c', BEADS_EXPORT_START.replace('${containerWorkspaceFolder}', folder)], { cwd: folder, encoding: 'utf8' });
  assert.strictEqual(run.status, 0, run.stderr);
});

test('with .beads: in place too; a config that starts its own beads-export.sh needs no copy; a linked script is refused', () => {
  let p = project();
  fs.mkdirSync(path.join(p.folder, '.beads'));
  applyDevcontainerPlan(planDevcontainer(p.folder, { inPlace: true })!);
  assert.ok(jsonc.parse(fs.readFileSync(p.configPath, 'utf8')).postStartCommand.endsWith(BEADS_EXPORT_START));
  assert.ok(fs.existsSync(path.join(p.folder, '.snagboat', 'bin', 'beads-export.sh')));
  assert.strictEqual(planDevcontainer(p.folder, { inPlace: true })!.state, 'ready');

  p = project(SHARED.replace('"echo started"', '"bash .devcontainer/beads-export.sh start"'));
  fs.mkdirSync(path.join(p.folder, '.beads'));
  const own = planDevcontainer(p.folder)!;
  assert.strictEqual(own.beadsExportPath, undefined);
  assert.ok(!own.changes.some((c) => c.includes('beads')), own.changes.join('\n'));

  p = project();
  fs.mkdirSync(path.join(p.folder, '.beads'));
  fs.mkdirSync(path.join(p.folder, '.snagboat', 'bin'), { recursive: true });
  fs.symlinkSync(path.join(p.root, 'elsewhere.sh'), path.join(p.folder, '.snagboat', 'bin', 'beads-export.sh'));
  assert.match(planDevcontainer(p.folder)!.problem!, /beads-export\.sh is a link or a folder/);
});

test('unifiedDiff', () => {
  assert.strictEqual(unifiedDiff('a\nb\n', 'a\nb\n', 'x', 'y'), '');
  const d = unifiedDiff(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'].join('\n'), ['1', '2', '3', '4', 'five', '6', '7', '8', '9', '10', '11', '12', '13'].join('\n'), 'a/f', 'b/f');
  assert.strictEqual(d, ['--- a/f', '+++ b/f', '@@ -2,7 +2,7 @@', ' 2', ' 3', ' 4', '-5', '+five', ' 6', ' 7', ' 8', '@@ -10,3 +10,4 @@', ' 10', ' 11', ' 12', '+13', ''].join('\n'));
});

test('snagboat containers allow shows the change, --edit makes it, status reports it', async () => {
  const { folder, home } = project();
  const saved = process.env.SNAGBOAT_HOME;
  process.env.SNAGBOAT_HOME = home;
  const run = async (argv: string[]) => {
    let out = '';
    let err = '';
    const code = await runCli(argv, { out: (t: string) => (out += t), err: (t: string) => (err += t), cwd: folder, now: new Date() }, 'test');
    return { code, out, err };
  };
  try {
    let r = await run(['containers', 'allow']);
    assert.strictEqual(r.code, 0, r.err);
    assert.match(r.out, /added .* to containers\.allow/);
    assert.match(r.out, /\+ mounts: \/home\/vscode\/\.claude\/projects -> <folder>\/\.snagboat\/claude-projects/);
    assert.match(r.out, /^\+\s+"workspaceMount": /m);
    assert.match(r.out, /rerun with --edit/);
    assert.ok(!fs.existsSync(personalConfigPath(folder)), 'allow alone writes no dev container config');

    r = await run(['containers', 'status']);
    assert.match(r.out, /dev container not set up: .*`snagboat containers allow --edit`/);

    assert.strictEqual((await run(['containers', 'allow', '--in-place'])).code, 2);
    assert.strictEqual((await run(['containers', 'status', '--edit'])).code, 2);

    r = await run(['containers', 'allow', '--edit']);
    assert.strictEqual(r.code, 0, r.err);
    assert.match(r.out, /already allowed/);
    assert.match(r.out, /Done: wrote \.devcontainer\/snagboat\/devcontainer\.json; created \.snagboat\/claude-projects\//);
    assert.match(r.out, /pick "proj-dev \(Snagboat\)"/);
    assert.ok(fs.existsSync(personalConfigPath(folder)));

    r = await run(['containers', 'status', '--json']);
    assert.strictEqual(JSON.parse(r.out).folders[0].devcontainer, 'set up (.devcontainer/snagboat/devcontainer.json)');
    r = await run(['containers', 'allow', '--json']);
    assert.strictEqual(JSON.parse(r.out).devcontainer.state, 'ready');

    fs.mkdirSync(path.join(folder, '.beads'));
    r = await run(['containers', 'allow']);
    assert.match(r.out, /\+ write \.snagboat\/bin\/beads-export\.sh \(the container runs it on start/);
    r = await run(['containers', 'allow', '--edit']);
    assert.match(r.out, /Done: wrote \.devcontainer\/snagboat\/devcontainer\.json; wrote \.snagboat\/bin\/beads-export\.sh\./);

    fs.writeFileSync(personalConfigPath(folder), '{}');
    r = await run(['containers', 'allow', '--edit']);
    assert.strictEqual(r.code, 1);
    assert.match(r.out, /didn't change anything\. .*edited since it was made/);
  } finally {
    if (saved === undefined) delete process.env.SNAGBOAT_HOME;
    else process.env.SNAGBOAT_HOME = saved;
  }
});

async function main() {
  let failures = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`PASS  ${name}`);
    } catch (err) {
      failures += 1;
      console.error(`FAIL  ${name}`);
      console.error(err);
    }
  }
  console.log(`\n${tests.length - failures}/${tests.length} passed`);
  process.exit(failures > 0 ? 1 : 0);
}

main();
