import * as assert from 'assert';
import { SessionView } from '@snagboat/schema';
import { buildExplorerState, CATALOG, TAXONOMY, validateCatalog, VisualizerEntry } from 'factory-clock';

// Factory Clock's catalog and explorer state (packages/viz). Snagboat no longer has Explore; these
// tests stay with the package until it moves to its own repository.

const entry = (over: Partial<VisualizerEntry>): VisualizerEntry => ({ ...CATALOG[0], ...over });

async function main() {
  const tests: Array<[string, () => Promise<void> | void]> = [];
  const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

  test('the catalog conforms to the taxonomy', () => {
    assert.deepStrictEqual(validateCatalog(CATALOG, TAXONOMY), []);
    assert.deepStrictEqual(Object.keys(TAXONOMY), ['category', 'purpose', 'level', 'dimension', 'language']);
    assert.deepStrictEqual(Object.keys(TAXONOMY.category.values), ['temporal', 'actor', 'conversational', 'dependency', 'quantitative', 'state', 'semantic']);
    assert.deepStrictEqual(CATALOG.map((v) => v.id), ['turn-tree', 'context-timeline', 'session-strips', 'cost-per-prompt', 'context-fill', 'sequence-diagram', 'event-graph', 'actor-graph', 'prompt-terms', 'gantt', 'treemap', 'heatmap', 'tool-ribbon', 'week-picture', 'histogram', 'box-violin', 'ridgeline', 'scatter', 'bubble', 'sunburst', 'calendar-heatmap', 'radar', 'parallel-coords', 'streamgraph', 'sankey', 'adjacency-matrix', 'swimlane', 'living-network', 'session-fingerprint', 'conversation-landscape', 'terminal-board', 'factory-clock']);
  });

  test('only hero views leave the standard design language, each with a language of its own, and they come last', () => {
    const heroes: Record<string, string> = { 'living-network': 'cinematic', 'session-fingerprint': 'risograph', 'conversation-landscape': 'edgeless', 'terminal-board': 'split-flap', 'factory-clock': 'horology' };
    assert.deepStrictEqual(Object.keys(TAXONOMY.language.values), ['standard', ...Object.values(heroes)]);
    for (const v of CATALOG) assert.deepStrictEqual(v.tags.language, [heroes[v.id] ?? 'standard'], v.id);
    const firstHero = CATALOG.findIndex((v) => v.id in heroes);
    assert.ok(CATALOG.slice(firstHero).every((v) => v.id in heroes), 'no standard view after the first hero');
  });

  test('a broken catalog names each problem', () => {
    const problems = (catalog: VisualizerEntry[]) => validateCatalog(catalog, TAXONOMY);
    assert.strictEqual(problems([CATALOG[0], CATALOG[0]]).length, 1);
    assert.match(problems([CATALOG[0], CATALOG[0]])[0], /duplicate id "turn-tree"/);
    assert.match(problems([entry({ tags: { ...CATALOG[0].tags, purpose: [] } })])[0], /"purpose" is missing or empty/);
    const missing = { ...CATALOG[0].tags } as Partial<VisualizerEntry['tags']>;
    delete missing.level;
    assert.match(problems([entry({ tags: missing as VisualizerEntry['tags'] })])[0], /"level" is missing or empty/);
    assert.match(problems([entry({ tags: { ...CATALOG[0].tags, category: ['temporal', 'musical'] } })])[0], /"musical" is not a category value/);
    assert.match(problems([entry({ title: '' })])[0], /empty title/);
    assert.match(problems([entry({ description: '' })])[0], /empty description/);
    assert.match(problems([entry({ id: '' })])[0], /no id/);
    assert.match(problems([entry({ tags: { ...CATALOG[0].tags, mood: ['calm'] } as VisualizerEntry['tags'] })])[0], /"mood" is not a facet/);
  });

  test('the explorer state keeps the picked order and names the ids without a view', () => {
    const views: Record<string, SessionView> = { a: { summary: { sessionId: 'a' } } as SessionView, c: { summary: { sessionId: 'c' } } as SessionView };
    const state = buildExplorerState(['c', 'b', 'a'], (id) => views[id]);
    assert.deepStrictEqual(state.sessions.map((s) => s.summary.sessionId), ['c', 'a']);
    assert.deepStrictEqual(state.notLoaded, ['b']);
    assert.strictEqual(state.catalog, CATALOG);
    assert.strictEqual(state.taxonomy, TAXONOMY);
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
