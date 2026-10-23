"""Generates the three conversation-view mockup SVGs from synthetic data
shaped like real Claude Code sessions (1M-token context, ~10 prompts, one
compaction, two subagents). Run from the repo root: python3 docs/design/images/generate_mockups.py docs/design/images"""
import random, sys, os

OUT = sys.argv[1]
random.seed(7)

# ---------- shared style: light/dark tokens, validated categorical slots ----------
STYLE = """
<style>
  .s { --surface:#ffffff; --ink:#1f2328; --muted:#59636e; --grid:#d1d9e0;
       --c1:#2a78d6; --c2:#eb6834; --c3:#1baf7a; --warn:#9a6700; --neutral:#8c959f; --neutral-2:#d0d7de; }
  @media (prefers-color-scheme: dark) {
    .s { --surface:#0d1117; --ink:#e6edf3; --muted:#9198a1; --grid:#3d444d;
         --c1:#3987e5; --c2:#d95926; --c3:#199e70; --warn:#d29922; --neutral:#6e7681; --neutral-2:#30363d; }
  }
  .bg { fill: var(--surface); }
  .t  { fill: var(--ink); font: 12px -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif; }
  .tm { fill: var(--muted); font: 11px -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif; }
  .th { fill: var(--ink); font: 600 14px -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif; }
  .grid { stroke: var(--grid); stroke-width: 1; shape-rendering: crispEdges; }
  .rule { stroke: var(--ink); stroke-width: 1; opacity: .55; shape-rendering: crispEdges; }
  .c1 { fill: var(--c1); } .c2 { fill: var(--c2); } .c3 { fill: var(--c3); }
  .warnf { fill: var(--warn); } .warns { stroke: var(--warn); }
  .neutral { fill: var(--neutral); } .neutral2 { fill: var(--neutral-2); }
  .gap { stroke: var(--surface); stroke-width: 2; }
</style>"""

def svg(w, h, body, title):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" class="s" width="{w}" height="{h}" viewBox="0 0 {w} {h}" '
            f'role="img" aria-label="{title}">{STYLE}<rect class="bg" width="{w}" height="{h}" rx="6"/>{body}</svg>\n')

def esc(s): return s.replace('&', '&amp;').replace('<', '&lt;')

def compact(n):
    if n >= 1e6: return f"{n/1e6:.0f}M" if n % 1e6 == 0 else f"{n/1e6:.1f}M"
    if n >= 1e3: return f"{n/1e3:.0f}K"
    return str(int(n))

def warn_badge(x, y, label, anchor='start'):
    # status color + icon + label: never color alone
    tri = f'<path class="warnf" d="M{x},{y-9} l5.5,9.5 h-11 z"/>'
    tx = x + 9 if anchor == 'start' else x - 9
    return tri + f'<text class="t" x="{tx}" y="{y}" text-anchor="{anchor}">{esc(label)}</text>'

# ---------- synthetic session ----------
LIMIT = 1_000_000
PROMPTS = [0, 9, 22, 30, 47, 63, 70, 88, 101, 112]          # minutes
SUBAGENTS = [("Explore", 31, 38), ("general-purpose", 64, 69)]
COMPACT_AT = 80
END = 120
calls = []  # (t, cache_read, cache_create, fresh, output, prompt_idx)
ctx = 24_000
t = 0.0
p = 0
while t < END:
    while p + 1 < len(PROMPTS) and t >= PROMPTS[p + 1]:
        p += 1
    first_in_turn = any(abs(t - pt) < 0.01 for pt in PROMPTS)
    thrash = 52 <= t <= 58
    if abs(t - COMPACT_AT) < 0.7:
        ctx = 72_000
        create = 70_000
    else:
        grow = random.randint(4_000, 14_000) if t < COMPACT_AT else random.randint(3_000, 9_000)
        ctx = min(ctx + grow, 960_000)
        create = grow + (random.randint(150_000, 260_000) if thrash and random.random() < 0.55 else 0)
        if first_in_turn:
            create += random.randint(8_000, 20_000)
    create = min(create, ctx)
    fresh = random.randint(1, 4) * 600
    read = max(ctx - create - fresh, 0)
    calls.append((t, read, create, fresh, random.randint(200, 2500), p))
    # runaway turn P5 (47-63) has dense calls; others sparser
    t += random.uniform(0.25, 0.55) if 47 <= t < 63 else random.uniform(0.8, 2.2)

# ---------- 1. context timeline ----------
def context_timeline():
    W, H = 900, 500
    L, R, T, B = 64, 24, 70, 220
    pw, ph = W - L - R, H - T - B
    x = lambda m: L + m / END * pw
    y = lambda v: T + ph - v / LIMIT * ph
    out = [f'<text class="th" x="{L}" y="26">Context per API call: session 7f3a (synthetic)</text>',
           f'<text class="tm" x="{L}" y="44">Each step is one model call; height is the context it sent. Hover a step for its breakdown and the prompt it served.</text>']
    # legend
    lx = L
    for cls, name in (("c1", "cache read"), ("c2", "cache creation"), ("c3", "fresh input")):
        out.append(f'<rect class="{cls}" x="{lx}" y="54" width="10" height="10" rx="2"/><text class="t" x="{lx+15}" y="63">{name}</text>')
        lx += 15 + len(name) * 7 + 22
    # grid + axis
    for v in (0, 250_000, 500_000, 750_000, 1_000_000):
        out.append(f'<line class="grid" x1="{L}" x2="{L+pw}" y1="{y(v):.1f}" y2="{y(v):.1f}"/>')
        out.append(f'<text class="tm" x="{L-8}" y="{y(v)+4:.1f}" text-anchor="end">{compact(v)}</text>')
    # two separate, labeled marks (each drawn only once known)
    for val, label, dy in ((987_250, "limit 987K (auto-compaction)", -5), (964_050, "largest seen 964K", 12)):
        out.append(f'<line class="rule" x1="{L}" x2="{L+pw}" y1="{y(val):.1f}" y2="{y(val):.1f}" stroke-width="1.5"/>')
        out.append(f'<text class="t" x="{L+pw-4}" y="{y(val)+dy:.1f}" text-anchor="end">{label}</text>')
    # stacked stepped areas
    for idx, (t0, rd, cr, fr, _o, _p) in enumerate(calls):
        t1 = calls[idx + 1][0] if idx + 1 < len(calls) else END
        x0, x1 = x(t0), max(x(t1) - 1, x(t0) + 1)
        base = 0
        for cls, val in (("c1", rd), ("c2", cr), ("c3", fr)):
            if val <= 0: continue
            out.append(f'<rect class="{cls}" x="{x0:.1f}" y="{y(base+val):.1f}" width="{x1-x0:.1f}" height="{(y(base)-y(base+val)):.1f}"/>')
            base += val
    # prompt markers
    for i, pt in enumerate(PROMPTS):
        out.append(f'<line class="rule" x1="{x(pt):.1f}" x2="{x(pt):.1f}" y1="{T-4}" y2="{T+ph}"/>')
        out.append(f'<text class="t" x="{x(pt)+3:.1f}" y="{T+ph+16}">P{i+1}</text>')
    # compaction marker
    cx = x(COMPACT_AT)
    out.append(f'<path class="warnf" d="M{cx:.1f},{y(880_000):.1f} l5,-9 h-10 z" opacity=".0"/>')
    out.append(f'<text class="t" x="{cx+6:.1f}" y="{y(200_000):.1f}">⤓ compacted</text>')
    # findings on the timeline
    p5_calls = sum(1 for c in calls if c[5] == 4)
    out.append(f'<line class="warns" x1="{x(47):.1f}" x2="{x(63):.1f}" y1="{T+20}" y2="{T+20}" stroke-width="2"/>')
    out.append(warn_badge(x(47) + 4, T + 14, f"runaway turn: P5, {p5_calls} calls"))
    out.append(warn_badge(x(52) + 4, T + 30, "cache thrash"))
    out.append(warn_badge(x(73) + 4, T + 46, "context pressure (91%)"))
    # output tokens: a separate small panel with its own scale (not a second y-axis)
    oy0, oh = T + ph + 30, 54
    omax = 3000
    oy = lambda v: oy0 + oh - v / omax * oh
    out.append(f'<text class="tm" x="{L-8}" y="{oy0+8}" text-anchor="end">output</text>')
    for v in (0, 1500, 3000):
        out.append(f'<line class="grid" x1="{L}" x2="{L+pw}" y1="{oy(v):.1f}" y2="{oy(v):.1f}"/>')
        out.append(f'<text class="tm" x="{L+pw+4}" y="{oy(v)+4:.1f}">{compact(v)}</text>')
    for (t0, _rd, _cr, _fr, o, _p) in calls:
        out.append(f'<rect class="c1" x="{x(t0):.1f}" y="{oy(o):.1f}" width="2" height="{oy(0)-oy(o):.1f}" rx="1" opacity=".55"/>')
    out.append(f'<text class="tm" x="{L+pw-2}" y="{oy0-4}" text-anchor="end">output tokens per call (own scale)</text>')
    # x axis (time)
    for m in range(0, END + 1, 15):
        out.append(f'<text class="tm" x="{x(m):.1f}" y="{oy0+oh+16}" text-anchor="middle">{m}m</text>')
    # subagent lanes
    lane_y = oy0 + oh + 28
    out.append(f'<text class="tm" x="{L-8}" y="{lane_y+11}" text-anchor="end">subagents</text>')
    for k, (name, a, b) in enumerate(SUBAGENTS):
        yy = lane_y + k * 20
        out.append(f'<rect class="neutral" x="{x(a):.1f}" y="{yy}" width="{x(b)-x(a):.1f}" height="14" rx="4"/>')
        out.append(f'<text class="t" x="{x(b)+6:.1f}" y="{yy+11}">{name}</text>')
    out.append(f'<text class="tm" x="{L}" y="{H-14}">Prompts are vertical rules; findings are pinned where their triggering events occur. Subagents run in their own context, so their calls appear in their own lane.</text>')
    return svg(W, H, "".join(out), "Context per API call over one session, stacked by cache read, cache creation and fresh input, with prompt markers, a compaction, findings and subagent lanes")

# ---------- 2. cost per prompt ----------
def cost_per_prompt():
    W, H = 900, 372
    L, R, T, B = 64, 24, 92, 82
    pw, ph = W - L - R, H - T - B
    per = []
    for i in range(len(PROMPTS)):
        cs = [c for c in calls if c[5] == i]
        rd = sum(c[1] for c in cs); cr = sum(c[2] for c in cs); fr = sum(c[3] + c[4] for c in cs)
        tools = int(len(cs) * random.uniform(1.0, 1.8))
        per.append((rd, cr, fr, len(cs), tools))
    mx = max(a + b + c for a, b, c, _, _ in per)
    top = 25_000_000 if mx <= 25_000_000 else 30_000_000
    y = lambda v: T + ph - v / top * ph
    band = pw / len(per)
    colw = min(24, band * 0.5)
    out = [f'<text class="th" x="{L}" y="26">Tokens spent per prompt: session 7f3a (synthetic)</text>',
           f'<text class="tm" x="{L}" y="44">Everything the agent sent and received between one prompt and the next, including subagents. Calls and tool calls listed under each bar.</text>']
    lx = L
    for cls, name in (("c1", "cache read"), ("c2", "cache creation"), ("c3", "fresh input + output")):
        out.append(f'<rect class="{cls}" x="{lx}" y="56" width="10" height="10" rx="2"/><text class="t" x="{lx+15}" y="65">{name}</text>')
        lx += 15 + len(name) * 7 + 22
    for v in range(0, top + 1, 5_000_000):
        out.append(f'<line class="grid" x1="{L}" x2="{L+pw}" y1="{y(v):.1f}" y2="{y(v):.1f}"/>')
        out.append(f'<text class="tm" x="{L-8}" y="{y(v)+4:.1f}" text-anchor="end">{compact(v)}</text>')
    findings = {4: "runaway turn", 6: "context pressure"}
    for i, (rd, cr, fr, n, tools) in enumerate(per):
        cx = L + band * i + band / 2
        x0 = cx - colw / 2
        base = 0
        segs = [(c, v) for c, v in (("c1", rd), ("c2", cr), ("c3", fr)) if v > 0]
        for j, (cls, val) in enumerate(segs):
            h = y(base) - y(base + val)
            top_seg = j == len(segs) - 1
            gap = 2 if j > 0 and h > 3 else 0
            if top_seg:
                r = min(4, h - gap, colw / 2)
                yt = y(base + val)
                out.append(f'<path class="{cls}" d="M{x0:.1f},{yt+h-gap:.1f} V{yt+r:.1f} Q{x0:.1f},{yt:.1f} {x0+r:.1f},{yt:.1f} H{x0+colw-r:.1f} Q{x0+colw:.1f},{yt:.1f} {x0+colw:.1f},{yt+r:.1f} V{yt+h-gap:.1f} Z"/>')
            else:
                out.append(f'<rect class="{cls}" x="{x0:.1f}" y="{y(base+val):.1f}" width="{colw:.1f}" height="{h-gap:.1f}"/>')
            base += val
        total = rd + cr + fr
        out.append(f'<text class="t" x="{cx:.1f}" y="{y(total)-6:.1f}" text-anchor="middle">{compact(total)}</text>')
        if i in findings:
            out.append(warn_badge(cx - 4, y(total) - 22, findings[i]))
        out.append(f'<text class="t" x="{cx:.1f}" y="{T+ph+18}" text-anchor="middle">P{i+1}</text>')
        out.append(f'<text class="tm" x="{cx:.1f}" y="{T+ph+34}" text-anchor="middle">{n} calls</text>')
        out.append(f'<text class="tm" x="{cx:.1f}" y="{T+ph+48}" text-anchor="middle">{tools} tools</text>')
    out.append(f'<text class="tm" x="{L}" y="{H-12}">Hover a bar for the prompt\'s time, duration, and findings; click to jump to it in the context timeline.</text>')
    return svg(W, H, "".join(out), "Stacked columns of tokens spent per prompt, by cache read, cache creation and fresh input plus output, with call and tool counts and finding badges")

# ---------- 3. turn tree (icicle) ----------
def turn_tree():
    W, H = 900, 290
    L, R, T = 24, 24, 64
    pw = W - L - R
    rowh, gap = 46, 6
    per = []
    for i in range(len(PROMPTS)):
        cs = [c for c in calls if c[5] == i]
        per.append(sum(c[1] + c[2] + c[3] + c[4] for c in cs))
    total = sum(per)
    out = [f'<text class="th" x="{L}" y="26">Where the tokens went: session 7f3a (synthetic)</text>',
           f'<text class="tm" x="{L}" y="44">Width is tokens. Session, then prompts, then who did the work, then what the work was. Click a block to zoom in.</text>']
    def block(x0, x1, row, cls, label, sub=None, opacity=None):
        yy = T + row * (rowh + gap)
        w = x1 - x0
        op = f' opacity="{opacity}"' if opacity else ''
        s = f'<rect class="{cls}" x="{x0+1:.1f}" y="{yy}" width="{max(w-2,1):.1f}" height="{rowh}" rx="3"{op}/>'
        if w > 34:
            s += f'<text class="t" x="{x0+7:.1f}" y="{yy+19}">{esc(label)}</text>'
            if sub and w > 60:
                s += f'<text class="tm" x="{x0+7:.1f}" y="{yy+35}">{esc(sub)}</text>'
        return s
    out.append(block(L, L + pw, 0, "neutral2", "Session 7f3a", f"{compact(total)} tokens · {len(PROMPTS)} prompts · 2h"))
    xs = L
    for i, v in enumerate(per):
        w = v / total * pw
        out.append(block(xs, xs + w, 1, "neutral2", f"P{i+1}", compact(v)))
        if i == 4:
            out.append(warn_badge(xs + w - 8, T + 1 * (rowh + gap) + 19, "runaway", anchor='end'))
        # row 2: main agent vs subagent share
        sub_share = 0.32 if i == 3 else (0.22 if i == 5 else 0)
        mw = w * (1 - sub_share)
        out.append(block(xs, xs + mw, 2, "neutral2", "main agent" if mw > 90 else "main"))
        if sub_share:
            name = "Explore" if i == 3 else "general-purpose"
            out.append(block(xs + mw, xs + w, 2, "neutral", name if (xs + w - xs - mw) > 70 else "sub"))
        # row 3: tool mix for the big prompts
        if w > 120:
            mix = [("File edit", .34), ("Tests and builds", .24), ("Script", .16), ("File read", .16), ("other", .10)]
            tx = xs
            for name, frac in mix:
                out.append(block(tx, tx + w * frac, 3, "neutral2", name, "≈ " + compact(v * frac)))
                tx += w * frac
        xs += w
    out.append(f'<text class="tm" x="{L}" y="{H-12}">Row 4 is approximate (≈): each call\'s tokens are credited to tool categories (file edit, script, tests…) by the attribution rules in the design doc.</text>')
    return svg(W, H, "".join(out), "Icicle chart: the session split into prompts, then main agent versus subagents, then by tool")

# ---------- 4. session view wireframe (layout, not data) ----------
def session_view_wireframe():
    W, H = 900, 470
    FW, FH, GAP = 420, 380, 36
    out = ['<text class="th" x="24" y="26">Session view: layout (wireframe)</text>',
           '<text class="tm" x="24" y="44">Left: normal. Right: timeline expanded. Shapes stand in for the charts; see the chart mockups for content.</text>']
    def frame(ox, expanded):
        o = []
        oy = 64
        o.append(f'<rect class="neutral2" x="{ox}" y="{oy}" width="{FW}" height="{FH}" rx="6" opacity=".35"/>')
        o.append(f'<text class="tm" x="{ox}" y="{oy+FH+18}">{"Timeline expanded" if expanded else "Normal"}</text>')
        # tabs
        o.append(f'<text class="tm" x="{ox+12}" y="{oy+20}">Overview</text>')
        o.append(f'<text class="t" x="{ox+82}" y="{oy+20}">Sessions</text>')
        o.append(f'<rect class="c1" x="{ox+82}" y="{oy+25}" width="54" height="2"/>')
        y = oy + 40
        if not expanded:
            # session list
            for i, (when, who, tok) in enumerate((("● 14:02", "Claude Code · opus-5-5", "39.2M  ▲2"), ("11:40", "Copilot", "1.1M"), ("09:15", "Claude Code · sonnet-5", "8.4M  ▲1"))):
                cls = "neutral2" if i == 0 else None
                if cls: o.append(f'<rect class="{cls}" x="{ox+8}" y="{y-12}" width="{FW-16}" height="17" rx="3"/>')
                o.append(f'<text class="tm" x="{ox+14}" y="{y}">{when}</text><text class="tm" x="{ox+70}" y="{y}">{who}</text><text class="tm" x="{ox+FW-14}" y="{y}" text-anchor="end">{tok}</text>')
                y += 20
            y += 4
        else:
            o.append(f'<text class="tm" x="{ox+12}" y="{y}">Session 7f3a ▾  (list collapsed to a picker)</text>')
            y += 14
        # breadcrumb
        o.append(f'<text class="t" x="{ox+12}" y="{y+6}">Sessions › 7f3a › P5</text>')
        y += 18
        if not expanded:
            # icicle
            rows = [[(0, 1)], [(0, .03), (.03, .06), (.06, .09), (.09, .21), (.21, .73), (.73, .8), (.8, .93), (.93, .96), (.96, 1)], [(0, .21), (.21, .73), (.73, 1)], [(.21, .42), (.42, .56), (.56, .66), (.66, .73)]]
            iw = FW - 24
            for r, cells in enumerate(rows):
                for a, b in cells:
                    sel = r == 1 and a == .21
                    o.append(f'<rect class="{"neutral" if sel else "neutral2"}" x="{ox+12+a*iw+1:.1f}" y="{y}" width="{max((b-a)*iw-2,1):.1f}" height="24" rx="2"/>')
                y += 27
            o.append(f'<text class="tm" x="{ox+12}" y="{y+10}">Turn tree (icicle): click a block to zoom; the timeline follows</text>')
            y += 22
        else:
            # icicle collapsed to its prompt row, acting as an overview
            iw = FW - 24
            for a, b in [(0, .03), (.03, .06), (.06, .09), (.09, .21), (.21, .73), (.73, .8), (.8, .93), (.93, .96), (.96, 1)]:
                sel = a == .21
                o.append(f'<rect class="{"neutral" if sel else "neutral2"}" x="{ox+12+a*iw+1:.1f}" y="{y}" width="{max((b-a)*iw-2,1):.1f}" height="14" rx="2"/>')
            o.append(f'<text class="tm" x="{ox+12}" y="{y+28}">Tree shrinks to its prompt row</text>')
            y += 38
        # timeline panel
        ph = (oy + FH) - y - 12
        o.append(f'<rect class="neutral2" x="{ox+8}" y="{y}" width="{FW-16}" height="{ph}" rx="4" opacity=".6"/>')
        o.append(f'<text class="t" x="{ox+16}" y="{y+17}">Context timeline</text>')
        o.append(f'<text class="t" x="{ox+FW-16}" y="{y+17}" text-anchor="end">{"⤡ Collapse" if expanded else "⤢ Expand"}</text>')
        # silhouette of the stepped area, with the selected prompt's span highlighted
        cy0, ch = y + 28, ph - 44
        steps = 60
        for k in range(steps):
            frac = k / steps
            v = (frac * 0.85 if frac < 0.66 else (frac - 0.66) * 0.5 + 0.08)
            bx = ox + 16 + frac * (FW - 32)
            bh = max(v * ch, 2)
            o.append(f'<rect class="c1" x="{bx:.1f}" y="{cy0+ch-bh:.1f}" width="{(FW-32)/steps-1:.1f}" height="{bh:.1f}" opacity="{.9 if .39 <= frac <= .53 else .35}"/>')
        if expanded:
            o.append(f'<text class="tm" x="{ox+16}" y="{y+ph-6}">Full timeline: context, output strip, subagent lanes; drag to zoom</text>')
        else:
            o.append(f'<text class="tm" x="{ox+16}" y="{y+ph-6}">Selected prompt highlighted; output strip and lanes below when expanded</text>')
        return o
    out += frame(24, False)
    out += frame(24 + FW + GAP, True)
    return svg(W, H, "".join(out), "Wireframe of the session view: turn tree above a context timeline panel, normal and with the timeline expanded")

# cost_per_prompt is kept for reference but not generated: that view is deferred.
for name, fn in (("context-timeline.svg", context_timeline), ("turn-tree.svg", turn_tree), ("session-view.svg", session_view_wireframe)):
    with open(os.path.join(OUT, name), "w") as f:
        f.write(fn())
print("wrote", len(calls), "synthetic calls into 3 mockups")
