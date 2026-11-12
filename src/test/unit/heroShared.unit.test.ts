import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import { SessionView } from '@snagboat/schema';
import { EventSet } from 'factory-clock/web';
import { syntheticEvents, syntheticSessionIds } from 'factory-clock/web';
import { replayFindings } from '../../web/findings';

/**
 * The hero views' shared helpers in the visualization kit, packages/viz/vizkit.js (replay, force
 * layout), run in Node; and the detail view's media/shared.js on Snagboat's own kit, media/drawings/kit.js.
 * The files are plain browser scripts, so it's loaded into a sandbox with a bare window;
 * only the parts that build DOM need a document, and these tests don't touch them.
 * Synthetic sessions only: real traces never go in unit tests.
 */
interface Clock {
  events: Array<{ t: number; kind: string; sessionId: string; index: number }>;
  start: number;
  end: number;
  time: number;
  shown: number;
  playing: boolean;
  speed: number;
  mode(): 'live' | 'replay';
  atEnd(): boolean;
  setSessions(views: SessionView[]): void;
  play(): void;
  pause(): void;
  seek(t: number): void;
  seekShown(n: number): void;
  setting: string;
  loop: boolean;
  setSpeed(s: number | string): void;
  setLoop(on: boolean): void;
  setActive(on: boolean): void;
  destroy(): void;
}
interface Shared {
  replayEvents(views: SessionView[]): Clock['events'];
  countUpTo(events: Clock['events'], t: number): number;
  createReplay(opts: Record<string, unknown>): Clock;
  REPLAY_SPEEDS: number[];
  REPLAY_CHOICES: Array<[string, string]>;
  getReplayPrefs(): { speed: string; loop: boolean };
  setReplayPrefs(p: { speed?: string | number; loop?: boolean }): void;
  onReplayPrefs(cb: (p: { speed: string; loop: boolean }) => void): () => void;
  forceLayout(nodes: Array<{ id: string; r?: number; pin?: Pt }>, links: Array<{ source: string; target: string; weight: number }>, opts: Record<string, unknown>): Map<string, Pt>;
  drift(id: string, t: number, amplitude: number): { dx: number; dy: number };
}
interface Pt {
  x: number;
  y: number;
}
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

/** Runs page files (repo-relative), in order, in one sandbox with a bare window, and returns the window. */
function loadMedia(...files: string[]): Record<string, unknown> {
  const sandbox = { window: {} as Record<string, unknown> };
  for (const name of files) {
    const file = path.join(__dirname, '..', '..', '..', name);
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
  }
  return sandbox.window;
}

/** A frame scheduler under the test's control: run(ms) fires the pending frame at wall time + ms. */
function frames() {
  let pending: ((t: number) => void) | null = null;
  let wall = 0;
  let ids = 0;
  return {
    raf: (fn: (t: number) => void) => {
      pending = fn;
      return ++ids;
    },
    caf: () => {
      pending = null;
    },
    get pending() {
      return pending !== null;
    },
    run(ms: number) {
      wall += ms;
      const fn = pending;
      pending = null;
      if (fn) fn(wall);
    },
  };
}

async function main() {
  const tests: Array<[string, () => Promise<void> | void]> = [];
  const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);
  const shared = loadMedia('packages/viz/vizkit.js').factoryClockKit as Shared;
  const set = new EventSet(syntheticEvents(), replayFindings);
  const views = set.explorerState(syntheticSessionIds()).sessions;
  const one = [views[0]];
  const longAfter = () => Date.parse('2030-01-01T00:00:00Z'); // the examples are long finished

  test('shared.js is Snagboat\'s drawing kit plus the detail view\'s own helpers, and the kit has none of them', () => {
    const win = loadMedia('media/drawings/kit.js', 'media/shared.js');
    const kit = win.snagboatKit as Record<string, unknown>;
    const page = win.snagboatShared as Record<string, unknown>;
    for (const name of Object.keys(kit)) assert.strictEqual(page[name], kit[name], name);
    assert.deepStrictEqual(Object.keys(page).filter((k) => !(k in kit)), ['formatDay']);
  });

  test('replay merges prompts, calls, tools, and compactions in time order, the same way every time', () => {
    const a = shared.replayEvents(views);
    const b = shared.replayEvents(views);
    assert.deepStrictEqual(a, b);
    const total = views.reduce((n, v) => n + v.prompts.length + v.calls.length + v.tools.length + v.compactions.length, 0);
    assert.strictEqual(a.length, total);
    for (let i = 1; i < a.length; i++) assert.ok(a[i - 1].t <= a[i].t, `event ${i} is in order`);
    assert.ok(a.some((e) => e.kind === 'compaction'), 'the examples include a compaction');
  });

  test('within one timestamp, a prompt comes before the call and tool it led to', () => {
    const ts = '2026-10-22T10:00:00.000Z';
    const view = {
      summary: { sessionId: 'S' },
      prompts: [{ turnId: 'p1', ts, index: 1 }],
      calls: [{ ts, turnId: 'p1', input: 1, cacheRead: 0, cacheCreation: 0, output: 1 }],
      tools: [{ ts, turnId: 'p1', category: 'read', colorGroup: 0, status: 'success' }],
      compactions: [{ ts, trigger: 'auto' }],
    } as unknown as SessionView;
    assert.deepStrictEqual([...shared.replayEvents([view]).map((e) => e.kind)], ['prompt', 'compaction', 'call', 'tool']);
  });

  test('countUpTo counts the events at or before a time', () => {
    const events = shared.replayEvents(one);
    assert.strictEqual(shared.countUpTo(events, events[0].t - 1), 0);
    assert.strictEqual(shared.countUpTo(events, events[events.length - 1].t), events.length);
    const mid = events[Math.floor(events.length / 2)].t;
    assert.strictEqual(shared.countUpTo(events, mid), events.filter((e) => e.t <= mid).length);
  });

  test('a finished session opens at the start, autoplays once active, and stops at the end', () => {
    const f = frames();
    let drawn = 0;
    const clock = shared.createReplay({ onFrame: () => drawn++, raf: f.raf, caf: f.caf, now: longAfter, reducedMotion: false });
    clock.setSessions(one);
    assert.strictEqual(clock.time, clock.start);
    assert.strictEqual(clock.playing, false, 'nothing runs before the slide is active');
    assert.strictEqual(f.pending, false);
    clock.setActive(true);
    assert.strictEqual(clock.playing, true);
    assert.strictEqual(clock.mode(), 'replay');
    let guard = 0;
    while (f.pending && guard++ < 100000) f.run(16);
    assert.ok(clock.atEnd(), 'played to the end');
    assert.strictEqual(clock.playing, false);
    assert.strictEqual(clock.shown, clock.events.length);
    assert.ok(drawn > 2);
    // Quiet gaps are skipped: no event waits more than QUIET_MAX (1.5s) of playback, about 90 frames.
    // A steady pace: the whole session at the clock's speed, 16ms of wall time a frame.
    const expected = (clock.end - clock.start) / clock.speed / 16;
    assert.ok(Math.abs(guard - expected) <= 3, `played in ${guard} frames, expected about ${Math.round(expected)}`);
  });

  test('time moves at a steady pace through busy and quiet stretches alike', () => {
    const f = frames();
    const clock = shared.createReplay({ raf: f.raf, caf: f.caf, now: longAfter, reducedMotion: false });
    clock.setSessions(one);
    clock.setActive(true);
    f.run(16); // the first frame only starts the clock
    let prev = clock.time;
    let guard = 0;
    while (f.pending && guard++ < 100000) {
      f.run(16);
      const moved = clock.time - prev;
      if (!clock.atEnd()) assert.ok(Math.abs(moved - 16 * clock.speed) < 1e-6 * clock.speed, 'every frame moves the same amount of session time');
      prev = clock.time;
    }
    assert.ok(clock.atEnd());
  });

  test('an inactive slide does not tick, and picks up where it was', () => {
    const f = frames();
    const clock = shared.createReplay({ raf: f.raf, caf: f.caf, now: longAfter, reducedMotion: false });
    clock.setSessions(one);
    clock.setActive(true);
    f.run(16);
    f.run(500);
    const at = clock.time;
    clock.setActive(false);
    assert.strictEqual(f.pending, false);
    assert.strictEqual(clock.playing, true, 'still meant to play');
    clock.setActive(true);
    assert.strictEqual(f.pending, true);
    f.run(16); // the first frame after resuming measures from here, not from when it stopped
    assert.strictEqual(clock.time, at);
  });

  test('reduced motion opens on the final state and never autoplays; scrubbing still works', () => {
    const f = frames();
    const clock = shared.createReplay({ raf: f.raf, caf: f.caf, now: longAfter, reducedMotion: true });
    clock.setSessions(one);
    clock.setActive(true);
    assert.ok(clock.atEnd());
    assert.strictEqual(clock.playing, false);
    assert.strictEqual(f.pending, false);
    clock.seekShown(3);
    assert.strictEqual(clock.shown, 3);
    clock.seekShown(0);
    assert.strictEqual(clock.shown, 0);
  });

  test('a recent session opens live at the end, and an update keeps it there', () => {
    const f = frames();
    const partial = { ...one[0], calls: one[0].calls.slice(0, Math.floor(one[0].calls.length / 2)), tools: [], compactions: [] } as SessionView;
    const partialEvents = shared.replayEvents([partial]);
    let wall = partialEvents[partialEvents.length - 1].t + 60_000; // a minute after the last event so far
    const clock = shared.createReplay({ raf: f.raf, caf: f.caf, now: () => wall, reducedMotion: false });
    clock.setSessions([partial]);
    clock.setActive(true);
    assert.strictEqual(clock.playing, false, 'live does not autoplay from the top');
    const full = shared.replayEvents(one);
    wall = full[full.length - 1].t + 60_000;
    clock.setSessions(one);
    assert.ok(clock.atEnd(), 'stayed at the end as events arrived');
    assert.strictEqual(clock.mode(), 'live');
    clock.seekShown(1);
    assert.strictEqual(clock.mode(), 'replay', 'scrubbing back leaves live');
    clock.seek(clock.end);
    assert.strictEqual(clock.mode(), 'live', 'and returning to the end comes back');
  });

  test('away from the end, an update leaves the position alone', () => {
    const clock = shared.createReplay({ raf: frames().raf, caf: () => undefined, now: longAfter, reducedMotion: true });
    clock.setSessions(one);
    clock.seekShown(5);
    const t = clock.time;
    clock.setSessions(one);
    assert.strictEqual(clock.time, t);
    assert.strictEqual(clock.shown, 5);
  });

  test('speed is one of the offered settings, shared by every clock on the page', () => {
    shared.setReplayPrefs({ speed: 'fit:30', loop: false });
    const a = shared.createReplay({ raf: frames().raf, caf: () => undefined, now: longAfter, reducedMotion: true });
    const b = shared.createReplay({ raf: frames().raf, caf: () => undefined, now: longAfter, reducedMotion: true });
    a.setSessions(one);
    b.setSessions(one);
    a.setSpeed(10);
    assert.strictEqual(a.speed, 10);
    assert.strictEqual(b.speed, 10, 'one clock’s change applies to the others');
    a.setSpeed(7);
    assert.strictEqual(a.speed, 10, 'a speed not on the menu is ignored');
    assert.deepStrictEqual([...shared.REPLAY_SPEEDS], [1, 10, 60, 600]);
    assert.deepStrictEqual([...shared.REPLAY_CHOICES.map((c) => c[0])], ['fit:60', 'fit:30', 'fit:10', '1', '10', '60', '600']);
    let heard = null as null | { speed: string; loop: boolean };
    const stop = shared.onReplayPrefs((p) => (heard = p));
    a.setLoop(true);
    assert.deepStrictEqual({ ...heard }, { speed: '10', loop: true });
    stop();
    a.destroy();
    b.destroy();
    shared.setReplayPrefs({ speed: 'fit:30', loop: false });
  });

  test('a fit speed plays the whole span in that many seconds, at a steady pace, however long it is', () => {
    shared.setReplayPrefs({ speed: 'fit:10', loop: false });
    const f = frames();
    const clock = shared.createReplay({ raf: f.raf, caf: f.caf, now: longAfter, reducedMotion: false });
    clock.setSessions(views); // every example session: a longer span than one
    assert.strictEqual(clock.setting, 'fit:10');
    assert.ok(Math.abs(clock.speed - (clock.end - clock.start) / 10000) < 1e-9);
    clock.setActive(true);
    let n = 0;
    while (f.pending && n++ < 100000) f.run(16);
    assert.ok(clock.atEnd());
    assert.ok(Math.abs(n - 10000 / 16) <= 3, `played in ${n} frames, about ${Math.round(10000 / 16)} expected`);
    // A week of events at the same setting still takes ten seconds: the speed scales with the span.
    const week = { ...one[0], calls: [...one[0].calls, { ...one[0].calls[0], ts: new Date(Date.parse(one[0].calls[0].ts) + 7 * 86400000).toISOString() }] } as SessionView;
    clock.setSessions([week]);
    assert.ok(clock.speed > 60000, `a week at fit:10 runs at ×${Math.round(clock.speed)}`);
    clock.destroy();
    shared.setReplayPrefs({ speed: 'fit:30' });
  });

  test('with loop on, playback starts over at the end instead of stopping', () => {
    shared.setReplayPrefs({ speed: 'fit:10', loop: true });
    const f = frames();
    const clock = shared.createReplay({ raf: f.raf, caf: f.caf, now: longAfter, reducedMotion: false });
    clock.setSessions(one);
    clock.setActive(true);
    let wrapped = false;
    let prev = clock.time;
    for (let i = 0; i < 2000 && f.pending; i++) {
      f.run(16);
      if (clock.time < prev) wrapped = true;
      prev = clock.time;
    }
    assert.ok(wrapped, 'went back to the start');
    assert.strictEqual(clock.playing, true, 'and kept playing');
    clock.setLoop(false);
    let guard = 0;
    while (f.pending && guard++ < 5000) f.run(16);
    assert.ok(clock.atEnd() && !clock.playing, 'with loop off it stops at the end');
    clock.destroy();
    shared.setReplayPrefs({ speed: 'fit:30', loop: false });
  });

  // A star of an agent with tools and subagents, as Living Network will give it.
  const star = () => {
    const nodes = [{ id: 'you', r: 10 }, { id: 'agent', r: 12 }, ...Array.from({ length: 8 }, (_, i) => ({ id: `tool:${i}`, r: 6 })), { id: 'sub:a', r: 8 }, { id: 'sub:b', r: 8 }];
    const links = [
      { source: 'you', target: 'agent', weight: 20 },
      ...Array.from({ length: 8 }, (_, i) => ({ source: 'agent', target: `tool:${i}`, weight: i === 0 ? 40 : 2 })),
      { source: 'agent', target: 'sub:a', weight: 5 },
      { source: 'agent', target: 'sub:b', weight: 5 },
      { source: 'sub:a', target: 'tool:1', weight: 3 },
    ];
    return { nodes, links };
  };
  const box = { width: 600, height: 400 };

  test('the force layout gives the same picture every time', () => {
    const { nodes, links } = star();
    const a = shared.forceLayout(nodes, links, box);
    const b = shared.forceLayout(nodes, links, box);
    assert.deepStrictEqual([...a.entries()], [...b.entries()]);
    // Order of the input doesn't decide where a node goes first either.
    const c = shared.forceLayout([...nodes].reverse(), links, box);
    for (const n of nodes) assert.ok(Number.isFinite(c.get(n.id)!.x));
  });

  test('every node stays inside the box, clear of the padding', () => {
    const { nodes, links } = star();
    const pos = shared.forceLayout(nodes, links, { ...box, padding: 20 });
    for (const n of nodes) {
      const p = pos.get(n.id)!;
      assert.ok(p.x >= 20 + n.r - 0.1 && p.x <= box.width - 20 - n.r + 0.1, `${n.id} x ${p.x}`);
      assert.ok(p.y >= 20 + n.r - 0.1 && p.y <= box.height - 20 - n.r + 0.1, `${n.id} y ${p.y}`);
    }
  });

  test('a heavier link pulls its ends closer, and nodes don’t overlap', () => {
    const { nodes, links } = star();
    const pos = shared.forceLayout(nodes, links, box);
    const heavy = dist(pos.get('agent')!, pos.get('tool:0')!);
    const light = Math.min(...[1, 2, 3, 4, 5, 6, 7].map((i) => dist(pos.get('agent')!, pos.get(`tool:${i}`)!)));
    assert.ok(heavy < light, `heavy ${heavy.toFixed(1)} < lightest-but-one ${light.toFixed(1)}`);
    for (let i = 0; i < nodes.length; i++)
      for (let j = i + 1; j < nodes.length; j++) {
        const d = dist(pos.get(nodes[i].id)!, pos.get(nodes[j].id)!);
        assert.ok(d >= (nodes[i].r + nodes[j].r) * 0.8, `${nodes[i].id} and ${nodes[j].id} are ${d.toFixed(1)} apart`);
      }
  });

  test('an update starts from the previous positions and moves nodes gently', () => {
    const { nodes, links } = star();
    const before = shared.forceLayout(nodes, links, box);
    const more = { nodes: [...nodes, { id: 'tool:new', r: 6 }], links: [...links, { source: 'agent', target: 'tool:new', weight: 2 }] };
    const after = shared.forceLayout(more.nodes, more.links, { ...box, previous: before });
    const moved = nodes.map((n) => dist(before.get(n.id)!, after.get(n.id)!));
    const mean = moved.reduce((a, b) => a + b, 0) / moved.length;
    assert.ok(mean < 40, `known nodes moved ${mean.toFixed(1)}px on average`);
    assert.ok(dist(after.get('tool:new')!, after.get('agent')!) < 250, 'the new node starts near its neighbor');
  });

  test('a pinned node stays where it was put', () => {
    const { nodes, links } = star();
    const pinned = nodes.map((n) => (n.id === 'you' ? { ...n, pin: { x: 50, y: 200 } } : n));
    const pos = shared.forceLayout(pinned, links, box);
    assert.deepStrictEqual({ ...pos.get('you') }, { x: 50, y: 200 });
  });

  test('drift is small, smooth, and the same for the same id', () => {
    const a = shared.drift('agent', 1000, 3);
    assert.deepStrictEqual({ ...a }, { ...shared.drift('agent', 1000, 3) });
    assert.ok(Math.abs(a.dx) <= 3 && Math.abs(a.dy) <= 3);
    const b = shared.drift('agent', 1016, 3);
    assert.ok(Math.abs(a.dx - b.dx) < 0.1 && Math.abs(a.dy - b.dy) < 0.1, 'one frame later it has barely moved');
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
