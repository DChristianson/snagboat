import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

// The visualizations style themselves with their own --sv-* tokens from packages/viz/theme.css
// (docs/design/factory-clock-plan.md, step 3), so they can leave VS Code. Only the
// webview's mapping, media/vscodeTheme.css, may read VS Code's theme variables.

async function main() {
  const tests: Array<[string, () => Promise<void> | void]> = [];
  const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

  // Compiled to out/test/unit; the repo root is three levels up.
  const root = path.resolve(__dirname, '..', '..', '..');
  const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
  const filesUnder = (rel: string): string[] =>
    fs.readdirSync(path.join(root, rel), { withFileTypes: true }).flatMap((e) => {
      const child = `${rel}/${e.name}`;
      if (e.isDirectory()) return filesUnder(child);
      return /\.(js|ts|css|html)$/.test(e.name) ? [child] : [];
    });
  // The Factory Clock package (step 4), and the web page's entry that Snagboat builds.
  const packageFiles = [
    'packages/viz/theme.css',
    'packages/viz/viz.css',
    'packages/viz/vizkit.js',
    'packages/viz/explore.js',
    ...filesUnder('packages/viz/viz'),
    ...filesUnder('packages/viz/hosts/web').filter((f) => !f.startsWith('packages/viz/hosts/web/demo/')),
    ...filesUnder('packages/viz/src'),
    ...filesUnder('src/web'),
  ];

  const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');
  const decls = (css: string): Map<string, string> =>
    new Map([...stripComments(css).matchAll(/(--sv-[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
  const theme = stripComments(read('packages/viz/theme.css'));
  const [lightCss, darkCss] = theme.split('@media (prefers-color-scheme: dark)');
  const light = decls(lightCss);
  const dark = decls(darkCss ?? '');
  const vscodeCss = stripComments(read('media/vscodeTheme.css'));
  const [vscodeBodyCss, vscodeDarkCss] = vscodeCss.split('body.vscode-dark');
  const vscodeBody = decls(vscodeBodyCss);
  const vscodeDark = decls(vscodeDarkCss ?? '');
  const palette = [...light.keys()].filter((k) => /^--sv-(series|turn|cat)-/.test(k));

  test('no package file reads a VS Code theme variable or theme class', () => {
    for (const file of packageFiles) {
      const text = read(file);
      assert.ok(!text.includes('--vscode-'), `${file} reads a --vscode-* variable; use a --sv-* token from packages/viz/theme.css`);
      assert.ok(!/\bvscode-(dark|light|high-contrast)\b/.test(text), `${file} keys on a VS Code theme class`);
    }
  });

  test('theme.css defines every token the package uses, in light and dark', () => {
    assert.ok(darkCss, 'theme.css has no prefers-color-scheme: dark block');
    for (const file of [...packageFiles, 'media/vscodeTheme.css', 'media/detail.css']) {
      for (const [token] of read(file).matchAll(/--sv-[\w-]+/g)) {
        assert.ok(light.has(token), `${file} uses ${token}, which theme.css does not define`);
      }
    }
    for (const token of dark.keys()) assert.ok(light.has(token), `theme.css sets ${token} only in dark`);
    for (const token of light.keys()) {
      if (/^--sv-(font|font-size|mono)$/.test(token)) continue;
      assert.ok(dark.has(token), `theme.css has no dark value for ${token}`);
    }
  });

  test('the webview maps every token, and only it reads VS Code variables', () => {
    for (const token of light.keys()) assert.ok(vscodeBody.has(token), `vscodeTheme.css does not map ${token}`);
    for (const token of vscodeBody.keys()) assert.ok(light.has(token), `vscodeTheme.css maps ${token}, which theme.css does not define`);
    for (const [token, value] of vscodeBody) {
      if (palette.includes(token)) continue;
      assert.match(value, /^var\(--vscode-/, `vscodeTheme.css maps ${token} to ${value}, not a VS Code variable`);
    }
  });

  test("the webview's chart palettes match theme.css's", () => {
    assert.ok(palette.length > 0);
    for (const token of palette) {
      assert.strictEqual(vscodeBody.get(token), light.get(token), `light ${token}`);
      assert.strictEqual(vscodeDark.get(token), dark.get(token), `dark ${token}`);
    }
    assert.deepStrictEqual([...vscodeDark.keys()].sort(), [...palette].sort(), 'the dark theme class switches only the palettes');
  });

  test('each host loads theme.css, then viz.css, before the page styles', () => {
    const panel = read('src/ui/detailPanel.ts');
    const order = panel.match(/\[('theme\.css'[^\]]*)\]/);
    assert.ok(order, 'detailPanel.ts lists no stylesheets');
    assert.strictEqual(order[1], "'theme.css', 'vscodeTheme.css', 'viz.css', 'detail.css'");
    const page = read('packages/viz/hosts/web/index.html');
    const links = [...page.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map((m) => m[1]);
    assert.deepStrictEqual(links, ['theme.css', 'viz.css', 'web.css']);
    assert.ok(read('packages/viz/scripts/webDemo.js').includes("['theme.css', 'theme.css']"), 'webDemo.js does not copy theme.css');
    assert.ok(read('packages/viz/scripts/webDemo.js').includes("['viz.css', 'viz.css']"), 'webDemo.js does not copy viz.css');
  });

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
  if (failures > 0) process.exit(1);
}

main();
