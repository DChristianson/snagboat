import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

// Two theme boundaries. Factory Clock (packages/viz) styles itself with its own --fc-* tokens from
// packages/viz/theme.css, so it can leave Snagboat. Snagboat's pages and its two session drawings
// style themselves with Snagboat's own --sb-* tokens from media/theme.css (its own copy since
// 2026-11-12, docs/design/factory-clock-plan.md). Only the webview's mapping,
// media/vscodeTheme.css, may read VS Code's theme variables.

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
  // Snagboat's own page files: everything under media/ but the webview's mapping and the compact
  // findings panel, which is styled in VS Code's own colors.
  const snagboatFiles = filesUnder('media').filter((f) => f !== 'media/vscodeTheme.css' && !f.startsWith('media/findingsView.'));

  const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');
  const decls = (prefix: string, css: string): Map<string, string> =>
    new Map([...stripComments(css).matchAll(new RegExp(`(${prefix}[\\w-]+)\\s*:\\s*([^;]+);`, 'g'))].map((m) => [m[1], m[2].trim()]));
  interface Theme {
    light: Map<string, string>;
    dark: Map<string, string>;
    hasDark: boolean;
  }
  const themeOf = (file: string, prefix: string): Theme => {
    const [lightCss, darkCss] = stripComments(read(file)).split('@media (prefers-color-scheme: dark)');
    return { light: decls(prefix, lightCss), dark: decls(prefix, darkCss ?? ''), hasDark: darkCss !== undefined };
  };
  const pkg = themeOf('packages/viz/theme.css', '--fc-');
  const own = themeOf('media/theme.css', '--sb-');
  const vscodeCss = stripComments(read('media/vscodeTheme.css'));
  const [vscodeBodyCss, vscodeDarkCss] = vscodeCss.split('body.vscode-dark');
  const vscodeBody = decls('--sb-', vscodeBodyCss);
  const vscodeDark = decls('--sb-', vscodeDarkCss ?? '');
  const palette = [...own.light.keys()].filter((k) => /^--sb-(series|turn|cat)-/.test(k));

  test('no package file and no Snagboat page file reads a VS Code theme variable or theme class', () => {
    for (const file of [...packageFiles, ...snagboatFiles]) {
      const text = read(file);
      assert.ok(!text.includes('--vscode-'), `${file} reads a --vscode-* variable; use a theme token`);
      assert.ok(!/\bvscode-(dark|light|high-contrast)\b/.test(text), `${file} keys on a VS Code theme class`);
    }
  });

  const definesAll = (name: string, t: Theme, prefix: string, files: string[]) => {
    assert.ok(t.hasDark, `${name} has no prefers-color-scheme: dark block`);
    for (const file of files) {
      for (const [token] of read(file).matchAll(new RegExp(`${prefix}[\\w-]+`, 'g'))) {
        assert.ok(t.light.has(token), `${file} uses ${token}, which ${name} does not define`);
      }
    }
    for (const token of t.dark.keys()) assert.ok(t.light.has(token), `${name} sets ${token} only in dark`);
    for (const token of t.light.keys()) {
      if (/-(font|font-size|mono)$/.test(token)) continue;
      assert.ok(t.dark.has(token), `${name} has no dark value for ${token}`);
    }
  };

  test('packages/viz/theme.css defines every token the package uses, in light and dark', () => {
    definesAll('packages/viz/theme.css', pkg, '--fc-', packageFiles);
  });

  test("media/theme.css defines every token Snagboat's pages use, in light and dark, and none uses Factory Clock's", () => {
    const files = [...snagboatFiles, 'media/vscodeTheme.css'];
    definesAll('media/theme.css', own, '--sb-', files);
    for (const file of files) assert.ok(!read(file).includes('--fc-'), `${file} uses a Factory Clock --fc-* token`);
  });

  test('the webview maps every token, and only it reads VS Code variables', () => {
    for (const token of own.light.keys()) assert.ok(vscodeBody.has(token), `vscodeTheme.css does not map ${token}`);
    for (const token of vscodeBody.keys()) assert.ok(own.light.has(token), `vscodeTheme.css maps ${token}, which theme.css does not define`);
    for (const [token, value] of vscodeBody) {
      if (palette.includes(token)) continue;
      assert.match(value, /^var\(--vscode-/, `vscodeTheme.css maps ${token} to ${value}, not a VS Code variable`);
    }
  });

  test("the webview's chart palettes match theme.css's", () => {
    assert.ok(palette.length > 0);
    for (const token of palette) {
      assert.strictEqual(vscodeBody.get(token), own.light.get(token), `light ${token}`);
      assert.strictEqual(vscodeDark.get(token), own.dark.get(token), `dark ${token}`);
    }
    assert.deepStrictEqual([...vscodeDark.keys()].sort(), [...palette].sort(), 'the dark theme class switches only the palettes');
  });

  test('each host loads its theme, then the base and drawing styles, before the page styles', () => {
    const panel = read('src/ui/detailPanel.ts');
    const order = panel.match(/\[('theme\.css'[^\]]*)\]/);
    assert.ok(order, 'detailPanel.ts lists no stylesheets');
    assert.strictEqual(order[1], "'theme.css', 'vscodeTheme.css', 'base.css', 'drawings/drawings.css', 'detail.css'");
    const links = (file: string) => [...read(file).matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map((m) => m[1]);
    assert.deepStrictEqual(links('media/ui/index.html'), ['theme.css', 'base.css', 'drawings/drawings.css', 'app.css']);
    assert.deepStrictEqual(links('packages/viz/hosts/web/index.html'), ['theme.css', 'viz.css', 'web.css']);
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
