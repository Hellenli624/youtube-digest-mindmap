const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

function loadBackgroundHelpers({
  settings = {
    provider: "deepseek",
    aiApiKey: "test-key",
    aiBaseUrl: "https://api.deepseek.com",
    aiModel: "deepseek-v4-flash",
  },
  fetchImpl = fetch,
} = {}) {
  const listeners = { addListener() {} };
  const localStorage = { ytd_settings: settings };
  const sandbox = {
    console,
    URL,
    TextDecoder,
    TextEncoder,
    fetch: fetchImpl,
    AbortController,
    setTimeout: () => 0,
    clearTimeout: () => {},
    importScripts() {},
    chrome: {
      storage: {
        local: {
          setAccessLevel: () => Promise.resolve(),
          get: async (key) => {
            if (key === null) return { ...localStorage };
            if (Array.isArray(key)) {
              return Object.fromEntries(
                key.map((item) => [item, localStorage[item]]),
              );
            }
            return { [key]: localStorage[key] };
          },
          set: async (values) => Object.assign(localStorage, values),
          remove: async (keys) => {
            for (const key of Array.isArray(keys) ? keys : [keys]) {
              delete localStorage[key];
            }
          },
        },
      },
      action: { onClicked: listeners },
      sidePanel: { setPanelBehavior() {}, setOptions: () => Promise.resolve() },
      runtime: {
        onInstalled: listeners,
        onMessage: listeners,
        openOptionsPage() {},
        getURL: (resourcePath) => `chrome-extension://test/${resourcePath}`,
        sendMessage: () => Promise.resolve({ success: true }),
      },
      tabs: { onUpdated: listeners, onActivated: listeners },
    },
    YTD_SETTINGS: {
      STORAGE_KEY: "ytd_settings",
      normalize: (value) => value,
      chatCompletionsUrl: (baseUrl) => `${baseUrl}/chat/completions`,
      canonicalYouTubeUrl: (videoId) =>
        `https://www.youtube.com/watch?v=${videoId}`,
    },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(read("background.js"), sandbox);
  return sandbox.__YTD_TRANSLATION_TESTING__;
}

const countNodes = (nodes) =>
  nodes.reduce((sum, node) => sum + 1 + countNodes(node.children || []), 0);
const treeDepth = (node) =>
  1 + Math.max(0, ...(node.children || []).map(treeDepth));

test("video bounds follow the last transcript marker and the 75% threshold", () => {
  const { computeVideoBounds } = loadBackgroundHelpers();

  const fromTranscript = computeVideoBounds("[0:00] a\n[12:30] b", 500);
  assert.equal(fromTranscript.effectiveSeconds, 750);
  assert.equal(fromTranscript.durationFormatted, "12:30");
  assert.equal(fromTranscript.maxTimestampSeconds, 750);
  assert.equal(fromTranscript.lateThreshold, "9:22");

  const fromMetadata = computeVideoBounds("[0:10] a", 600);
  assert.equal(fromMetadata.effectiveSeconds, 600);
  assert.equal(fromMetadata.durationFormatted, "10:00");
});

test("mind map validation rebuilds a sorted, timestamped tree", () => {
  const { validateMindmap } = loadBackgroundHelpers();
  const tree = validateMindmap(
    {
      title: "  How caching works  ",
      children: [
        {
          label: "Later topic",
          timestampSeconds: 300,
          children: [{ label: "Detail", timestampSeconds: 420 }],
        },
        { label: "Earlier topic", timestampSeconds: 30 },
      ],
    },
    { maxSeconds: 600, fallbackTitle: "Fallback" },
  );

  assert.equal(tree.title, "How caching works");
  assert.deepEqual(
    JSON.parse(JSON.stringify(tree.children.map((node) => node.label))),
    ["Earlier topic", "Later topic"],
  );
  assert.equal(tree.children[1].timestamp, "5:00");
  assert.equal(tree.children[1].children[0].timestamp, "7:00");
});

test("mind map validation drops out-of-range timestamps but keeps the node", () => {
  const { validateMindmap } = loadBackgroundHelpers();
  const tree = validateMindmap(
    {
      children: [
        { label: "Beyond the end", timestampSeconds: 9999 },
        { label: "Negative", timestampSeconds: -4 },
        { label: "Not a number", timestampSeconds: "later" },
      ],
    },
    { maxSeconds: 600, fallbackTitle: "Video" },
  );

  assert.equal(tree.children.length, 3);
  for (const node of tree.children) {
    assert.equal(node.timestampSeconds, null);
    assert.equal(node.timestamp, "");
  }
});

test("mind map validation removes duplicate sibling labels", () => {
  const { validateMindmap } = loadBackgroundHelpers();
  const tree = validateMindmap(
    {
      title: "T",
      children: [
        { label: "Same label", timestampSeconds: 10 },
        { label: "same label", timestampSeconds: 20 },
      ],
    },
    { maxSeconds: 100, fallbackTitle: "T" },
  );

  assert.equal(tree.children.length, 1);
});

test("mind map validation caps the tree at four levels", () => {
  const { validateMindmap } = loadBackgroundHelpers();
  const tree = validateMindmap(
    {
      title: "T",
      children: [
        {
          label: "L1",
          children: [
            {
              label: "L2",
              children: [
                {
                  label: "L3",
                  children: [{ label: "L4", children: [{ label: "L5" }] }],
                },
              ],
            },
          ],
        },
      ],
    },
    { maxSeconds: 1000, fallbackTitle: "T" },
  );

  assert.equal(treeDepth(tree.children[0]), 3);
});

test("mind map validation caps the total node count at 120", () => {
  const { validateMindmap } = loadBackgroundHelpers();
  const wide = Array.from({ length: 200 }, (_, index) => ({
    label: `Branch ${index}`,
    timestampSeconds: index,
  }));
  const tree = validateMindmap(
    { title: "T", children: wide },
    { maxSeconds: 10000, fallbackTitle: "T" },
  );

  assert.equal(countNodes(tree.children), 120);
});

test("mind map validation rejects a tree with no usable nodes", () => {
  const { validateMindmap } = loadBackgroundHelpers();

  assert.equal(
    validateMindmap({}, { maxSeconds: 100, fallbackTitle: "T" }),
    null,
  );
  assert.equal(
    validateMindmap(
      { children: [{ label: "   " }, { label: 42 }, "nope"] },
      { maxSeconds: 100, fallbackTitle: "T" },
    ),
    null,
  );
});

test("mind map generation validates the provider response before returning", async () => {
  const helpers = loadBackgroundHelpers({
    fetchImpl: async (url) => {
      if (url.startsWith("chrome-extension://")) {
        return { ok: true, text: async () => read("prompts/mindmap.md") };
      }
      return {
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content:
                  '{"title":"Topic","children":[{"label":"Theme","timestampSeconds":30,"children":[]}]}',
              },
            },
          ],
        }),
      };
    },
  });

  const result = await helpers.handleGenerateMindmap(
    "[0:00] hello\n[1:00] world",
    "Title",
    "Channel",
    "Desc",
    120,
  );

  assert.equal(result.success, true);
  assert.equal(result.mindmap.title, "Topic");
  assert.equal(result.mindmap.children[0].timestamp, "0:30");
});

test("the side panel exposes a wired, cached Mind Map tab", () => {
  const html = read("sidepanel.html");
  const js = read("sidepanel.js");

  assert.match(
    html,
    /<button class="tab" data-tab="mindmap">Mind Map<\/button>/,
  );
  assert.match(html, /<div class="tab-panel" data-panel="mindmap">/);
  assert.match(html, /id="mindmapCanvas"/);
  assert.match(html, /id="mindmapStatus"/);
  assert.match(html, /id="mindmapExpandBtn"/);
  assert.match(html, /id="mindmapCollapseBtn"/);
  assert.match(html, /<script src="mindmap-render\.js"><\/script>/);

  assert.match(js, /action: "generateMindmap"/);
  assert.match(js, /YTD_MINDMAP\.buildLayout/);
  assert.match(js, /YTD_MINDMAP\.renderSvg/);
  assert.match(js, /tabName === "mindmap"/);
  assert.match(js, /defaultCollapsedMindmapIds/);
  assert.match(js, /mindmap: currentMindmap/);
  assert.match(js, /cached\.mindmap/);
  assert.match(js, /YTD_MINDMAP\.toSegments/);
  assert.match(js, /localizeMindmapTree/);
  assert.match(js, /translateInterfaceSegments\("mindmap", segments/);
  assert.match(html, /id="mindmapFullViewBtn"/);
  assert.match(js, /openMindmapFullView/);
  assert.match(js, /mindmap\.html/);
  // The localized clone must keep the numeric seconds, or seeking breaks in
  // Chinese and bilingual modes.
  assert.match(js, /timestampSeconds: YTD_MINDMAP\.nodeTimestampSeconds/);
});

test("the full-page mind map reuses the cached tree and exports it", () => {
  const html = read("mindmap.html");
  const js = read("mindmap.js");

  assert.match(html, /<link rel="stylesheet" href="mindmap\.css"/);
  assert.match(html, /<script src="mindmap-render\.js"><\/script>/);
  assert.match(html, /<script src="mindmap\.js"><\/script>/);
  assert.match(html, /id="copyMarkdownBtn"/);
  assert.match(html, /id="exportSvgBtn"/);

  assert.match(js, /digest_\$\{state\.videoId\}/);
  assert.match(js, /YTD_MINDMAP\.toMarkdown/);
  assert.match(js, /image\/svg\+xml/);
  assert.match(js, /action: "seekTo"/);
  assert.match(js, /action: "translateContent"/);
  assert.match(js, /timestampSeconds: YTD_MINDMAP\.nodeTimestampSeconds/);
});

test("mind map generation reports an unusable provider response", async () => {
  const helpers = loadBackgroundHelpers({
    fetchImpl: async (url) => {
      if (url.startsWith("chrome-extension://")) {
        return { ok: true, text: async () => read("prompts/mindmap.md") };
      }
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '{"title":"Topic"}' } }],
        }),
      };
    },
  });

  const result = await helpers.handleGenerateMindmap(
    "[0:00] hi",
    "Title",
    "Channel",
    "Desc",
    60,
  );

  assert.equal(result.success, false);
  assert.equal(result.error, "INVALID_MINDMAP");
});
