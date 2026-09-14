const test = require("node:test");
const assert = require("node:assert/strict");

const YTD_MINDMAP = require("../mindmap-render.js");

const sampleTree = {
  title: "Caching",
  children: [
    {
      label: "First theme",
      timestamp: "0:30",
      timestampSeconds: 30,
      children: [
        {
          label: "Point A",
          timestamp: "0:45",
          timestampSeconds: 45,
          children: [],
        },
        { label: "Point B", timestamp: "", timestampSeconds: null, children: [] },
      ],
    },
    {
      label: "Second theme",
      timestamp: "5:00",
      timestampSeconds: 300,
      children: [],
    },
  ],
};

test("layout ids follow structural paths and columns grow to the right", () => {
  const layout = YTD_MINDMAP.buildLayout(sampleTree);

  assert.deepEqual(
    layout.nodes.map((node) => node.id),
    ["0", "0-0", "0-0-0", "0-0-1", "0-1"],
  );

  const [root, first, pointA] = layout.nodes;
  assert.equal(root.depth, 0);
  assert.equal(first.depth, 1);
  assert.equal(pointA.depth, 2);
  assert.ok(pointA.x > first.x);
  assert.ok(first.x > root.x);
});

test("leaf order drives vertical position and parents sit in the middle", () => {
  const layout = YTD_MINDMAP.buildLayout(sampleTree);
  const [, first, pointA, pointB, second] = layout.nodes;

  assert.ok(pointA.y < pointB.y);
  assert.ok(pointB.y < second.y);
  assert.equal(first.y, (pointA.y + pointB.y) / 2);
});

test("collapsing a branch hides descendants but keeps other ids", () => {
  const layout = YTD_MINDMAP.buildLayout(sampleTree, {
    collapsedIds: new Set(["0-0"]),
  });

  assert.deepEqual(
    layout.nodes.map((node) => node.id),
    ["0", "0-0", "0-1"],
  );
  assert.deepEqual(
    layout.edges.map((edge) => `${edge.from}>${edge.to}`),
    ["0>0-0", "0>0-1"],
  );
  assert.equal(layout.nodes[1].collapsed, true);
});

test("every visible parent is connected to each of its children", () => {
  const layout = YTD_MINDMAP.buildLayout(sampleTree);

  assert.deepEqual(
    layout.edges.map((edge) => `${edge.from}>${edge.to}`),
    ["0>0-0", "0-0>0-0-0", "0-0>0-0-1", "0>0-1"],
  );
});

test("translation segments use stable ids and skip the root", () => {
  const segments = YTD_MINDMAP.toSegments(sampleTree);

  assert.deepEqual(
    segments.map((segment) => segment.id),
    ["mindmap-0-0", "mindmap-0-0-0", "mindmap-0-0-1", "mindmap-0-1"],
  );
  assert.deepEqual(
    segments.map((segment) => segment.text),
    ["First theme", "Point A", "Point B", "Second theme"],
  );
});

test("the markdown outline keeps the hierarchy and timestamps", () => {
  const markdown = YTD_MINDMAP.toMarkdown(sampleTree);

  assert.equal(
    markdown,
    [
      "# Caching",
      "- First theme (0:30)",
      "  - Point A (0:45)",
      "  - Point B",
      "- Second theme (5:00)",
    ].join("\n"),
  );
});

test("svg markup escapes labels and exposes node ids", () => {
  const layout = YTD_MINDMAP.buildLayout({
    title: "T",
    children: [
      {
        label: '<script>alert("x")</script>',
        timestampSeconds: 5,
        children: [],
      },
    ],
  });
  const markup = YTD_MINDMAP.toSvgMarkup(layout);

  assert.doesNotMatch(markup, /<script>/);
  assert.match(markup, /&lt;script&gt;/);
  assert.match(markup, /data-node-id="0-0"/);
  assert.match(markup, /class="mindmap-edge"/);
  assert.match(markup, /class="mindmap-toggle" data-toggle-id="0"/);
});

test("over-long labels are truncated to fit their box", () => {
  const metrics = YTD_MINDMAP.METRICS.compact;
  const long = "x".repeat(500);
  const output = YTD_MINDMAP.truncateForWidth(long, metrics.maxWidth, metrics);

  assert.ok(output.length < long.length);
  assert.ok(output.endsWith("\u2026"));
});

test("an empty tree still lays out a single root node", () => {
  const layout = YTD_MINDMAP.buildLayout({});

  assert.equal(layout.nodes.length, 1);
  assert.equal(layout.edges.length, 0);
  assert.ok(layout.width > 0);
  assert.ok(layout.height > 0);
});

test("CJK labels measure wider than the same number of latin letters", () => {
  const metrics = YTD_MINDMAP.METRICS.compact;

  assert.ok(
    YTD_MINDMAP.measureText("\u4e2d\u6587\u4e2d\u6587\u4e2d\u6587", metrics) >
      YTD_MINDMAP.measureText("abcdef", metrics),
  );
  assert.equal(YTD_MINDMAP.isWideChar("\u4e2d"), true);
  assert.equal(YTD_MINDMAP.isWideChar("a"), false);
});

test("long CJK labels truncate inside their box", () => {
  const metrics = YTD_MINDMAP.METRICS.compact;
  const long = "\u4e2d\u6587".repeat(100);
  const output = YTD_MINDMAP.truncateForWidth(long, metrics.maxWidth, metrics);

  assert.ok(output.length < long.length);
  assert.ok(output.endsWith("\u2026"));
  assert.ok(
    YTD_MINDMAP.visualWidth(output) * metrics.charWidth <= metrics.maxWidth,
  );
});

test("long labels wrap onto a second line and grow the box", () => {
  const metrics = YTD_MINDMAP.METRICS.compact;
  const label = "\u4e2d\u6587".repeat(12);
  const layout = YTD_MINDMAP.buildLayout({
    title: "T",
    children: [{ label, timestampSeconds: 5, children: [] }],
  });
  const node = layout.nodes[1];

  assert.ok(node.width <= metrics.maxWidth);
  assert.equal(node.lines.length, 2);
  assert.equal(node.height, metrics.rowHeight + metrics.lineHeight);
});

test("wrapping never exceeds two lines and ellipsizes the overflow", () => {
  const metrics = YTD_MINDMAP.METRICS.compact;
  const lines = YTD_MINDMAP.wrapLabel(
    "\u4e2d\u6587".repeat(40),
    metrics.maxWidth,
    metrics,
  );

  assert.equal(lines.length, metrics.maxLines);
  assert.ok(lines.at(-1).endsWith("\u2026"));
});

test("the leading timestamp stays glued to the first word", () => {
  const metrics = YTD_MINDMAP.METRICS.compact;
  const lines = YTD_MINDMAP.wrapLabel(
    "0:51 Sail Research in the token economy of large models",
    metrics.maxWidth,
    metrics,
  );

  assert.match(lines[0], /^0:51 Sail /);
});

test("svg carries a native tooltip and one tspan per line", () => {
  const label = "\u4e2d\u6587".repeat(40);
  const layout = YTD_MINDMAP.buildLayout({
    title: "T",
    children: [{ label, timestampSeconds: 5, children: [] }],
  });
  const markup = YTD_MINDMAP.toSvgMarkup(layout);
  const group =
    markup.match(/data-node-id="0-0"[\s\S]*?<\/g>/)?.[0] || "";

  assert.match(group, /<title>[\u4e00-\u9fff]+<\/title>/);
  assert.equal((group.match(/<tspan/g) || []).length, 2);
});

test("svg markup is self-contained so exported files keep their styling", () => {
  const layout = YTD_MINDMAP.buildLayout(sampleTree);
  const markup = YTD_MINDMAP.toSvgMarkup(layout);

  const rect = markup.match(/<rect[^>]*>/)[0];
  assert.match(rect, /fill="#/);
  assert.match(rect, /stroke="#/);
  assert.match(rect, /stroke-width="1"/);

  const text = markup.match(/<text[^>]*>/)[0];
  assert.match(text, /fill="#/);
  assert.match(text, /font-size="12"/);
  assert.match(text, /font-family="/);

  const edge = markup.match(/<path[^>]*>/)[0];
  assert.match(edge, /fill="none"/);
  assert.match(edge, /stroke="#/);

  const toggle = markup.match(/<circle[^>]*>/)[0];
  assert.match(toggle, /fill="#/);
  assert.match(toggle, /stroke="#/);
});

test("branch boxes carry their own tint in the markup, leaves do not", () => {
  const layout = YTD_MINDMAP.buildLayout(sampleTree);
  const markup = YTD_MINDMAP.toSvgMarkup(layout);
  const fillOf = (id) => {
    const group = markup.match(
      new RegExp(`data-node-id="${id}"[\\s\\S]*?</g>`),
    )[0];
    return group.match(/<rect[^>]*fill="([^"]+)"/)[1];
  };

  assert.equal(fillOf("0-0"), YTD_MINDMAP.THEMES.compact.branchFill);
  assert.equal(fillOf("0-0-1"), YTD_MINDMAP.THEMES.compact.boxFill);
  assert.notEqual(fillOf("0-0"), fillOf("0-0-1"));
});

test("numeric timestamps survive into the layout and never default to zero", () => {
  const layout = YTD_MINDMAP.buildLayout(sampleTree);

  assert.equal(layout.nodes[1].timestampSeconds, 30);
  assert.equal(layout.nodes[4].timestampSeconds, 300);
  // A node without a usable timestamp reports null, never 0.
  assert.equal(layout.nodes[3].timestampSeconds, null);

  assert.equal(YTD_MINDMAP.nodeTimestampSeconds({}), null);
  assert.equal(
    YTD_MINDMAP.nodeTimestampSeconds({ timestampSeconds: null }),
    null,
  );
  assert.equal(
    YTD_MINDMAP.nodeTimestampSeconds({ timestampSeconds: "30" }),
    null,
  );
  assert.equal(
    YTD_MINDMAP.nodeTimestampSeconds({ timestampSeconds: 42.9 }),
    42,
  );
});
