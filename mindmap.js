/**
 * FULL-PAGE MIND MAP
 *
 * A wide, read-only view of one video's mind map. It reuses the tree and the
 * translations the side panel already cached, so opening this page never costs
 * an extra generation.
 */
const TRANSLATION_BATCH_SIZE = 3;
const DISPLAY_LANGUAGE_MODE_KEY = "ytd_display_language_modes_by_video";
const DISPLAY_LANGUAGE_MODES = ["original", "zh", "bilingual"];

const state = {
  videoId: "",
  videoTitle: "",
  tree: null,
  mode: "original",
  collapsed: new Set(),
  interfaceCache: new Map(),
  interfaceFailures: new Set(),
  inFlight: new Set(),
};

function translationCacheKey(id, text) {
  return `${state.videoId || "none"}:zh:mindmap:${id}:${text}`;
}

function showEmpty(message) {
  const empty = document.getElementById("mindmapEmpty");
  if (!empty) return;
  empty.textContent = message;
  empty.style.display = "block";
}

/** Opens as a two-level overview, matching the side panel's default. */
function defaultCollapsedIds(tree) {
  const layout = YTD_MINDMAP.buildLayout(tree, { compact: false });
  return new Set(
    layout.nodes
      .filter((node) => node.hasChildren && node.depth >= 1)
      .map((node) => node.id),
  );
}

function allBranchIds(tree) {
  const layout = YTD_MINDMAP.buildLayout(tree, { compact: false });
  return new Set(
    layout.nodes.filter((node) => node.hasChildren).map((node) => node.id),
  );
}

/** Swaps each label for the text of the active language mode. */
function localizeTree(tree, mode) {
  if (!tree || mode === "original") return tree;

  const labelForMode = (node, path) => {
    const label = YTD_MINDMAP.nodeLabel(node);
    const key = translationCacheKey(
      YTD_MINDMAP.segmentId(YTD_MINDMAP.getNodeId(path)),
      label,
    );
    const translated = state.interfaceCache.get(key);

    if (mode === "zh") {
      if (translated) return translated;
      return state.interfaceFailures.has(key)
        ? "Translation unavailable"
        : "Translating...";
    }
    return translated ? `${label} \u00b7 ${translated}` : label;
  };

  const cloneNode = (node, path) => {
    const children = Array.isArray(node.children) ? node.children : [];
    return {
      label: labelForMode(node, path),
      timestamp: YTD_MINDMAP.nodeTimestamp(node),
      // Keep the numeric seconds: the layout layer needs them for seeking.
      timestampSeconds: YTD_MINDMAP.nodeTimestampSeconds(node),
      children: children.map((child, index) =>
        cloneNode(child, path.concat(index)),
      ),
    };
  };

  const children = Array.isArray(tree.children) ? tree.children : [];
  // Translate the root as well, matching the side panel, so the centre node
  // cannot be the only label left in the original language.
  const rootLabel = labelForMode(tree, [0]);
  return {
    label: rootLabel,
    title: rootLabel,
    children: children.map((child, index) => cloneNode(child, [0, index])),
  };
}

function render() {
  const body = document.getElementById("mindmapBody");
  if (!body || !state.tree) return;

  const layout = YTD_MINDMAP.buildLayout(localizeTree(state.tree, state.mode), {
    compact: false,
    collapsedIds: state.collapsed,
  });
  YTD_MINDMAP.renderSvg(body, layout, {
    onNodeClick: (node) => {
      if (Number.isFinite(node.timestampSeconds)) {
        void seekVideo(node.timestampSeconds);
      }
    },
    onToggle: (nodeId) => {
      if (state.collapsed.has(nodeId)) state.collapsed.delete(nodeId);
      else state.collapsed.add(nodeId);
      render();
    },
  });
}

/**
 * Seeks the open YouTube tab when this video is already playing; otherwise
 * opens it in a new tab at the right moment.
 */
async function seekVideo(seconds) {
  const videoUrl = `https://www.youtube.com/watch?v=${state.videoId}`;
  try {
    const tabs = await chrome.tabs.query({
      url: "https://www.youtube.com/watch*",
    });
    const match = tabs.find((tab) =>
      (tab.url || "").includes(`v=${state.videoId}`),
    );
    if (match) {
      await chrome.tabs.sendMessage(match.id, { action: "seekTo", seconds });
      await chrome.tabs.update(match.id, { active: true });
      if (Number.isInteger(match.windowId)) {
        await chrome.windows
          .update(match.windowId, { focused: true })
          .catch(() => {});
      }
      return;
    }
  } catch (error) {
    // The video tab may be gone; fall through to opening a new one.
  }
  chrome.tabs.create({
    url: `${videoUrl}&t=${Math.max(0, Math.floor(seconds))}s`,
  });
}

/** Merges freshly translated labels back into the shared digest cache. */
async function persistTranslations() {
  if (!state.videoId) return;
  const key = `digest_${state.videoId}`;
  try {
    const stored = await chrome.storage.local.get(key);
    const cached = stored[key];
    if (!cached) return;
    const interfaceCache = { ...(cached.interfaceCache || {}) };
    for (const [cacheKey, value] of state.interfaceCache) {
      if (cacheKey.startsWith(`${state.videoId}:`)) {
        interfaceCache[cacheKey] = value;
      }
    }
    cached.interfaceCache = interfaceCache;
    await chrome.storage.local.set({ [key]: cached });
  } catch (error) {
    console.warn("[YouTube Digest] Could not persist mind map translations:", error);
  }
}

/** Translates missing labels in small batches, revealing each as it lands. */
async function translateMissing() {
  if (state.mode === "original" || !state.tree) return;

  const segments = YTD_MINDMAP.toSegments(state.tree).filter(
    (segment) => segment.text,
  );
  const missing = segments.filter((segment) => {
    const key = translationCacheKey(segment.id, segment.text);
    return (
      !state.interfaceCache.has(key) &&
      !state.interfaceFailures.has(key) &&
      !state.inFlight.has(key)
    );
  });
  if (!missing.length) return;

  missing.forEach((segment) =>
    state.inFlight.add(translationCacheKey(segment.id, segment.text)),
  );

  try {
    for (let start = 0; start < missing.length; start += TRANSLATION_BATCH_SIZE) {
      const batch = missing.slice(start, start + TRANSLATION_BATCH_SIZE);
      let result = null;
      try {
        result = await chrome.runtime.sendMessage({
          action: "translateContent",
          content: { segments: batch.map(({ id, text }) => ({ id, text })) },
          contentType: "interfaceBatch",
          targetLanguage: "zh",
          videoTitle: state.videoTitle,
        });
      } catch (error) {
        result = null;
      }

      const returned =
        result?.success && Array.isArray(result.translatedContent?.segments)
          ? result.translatedContent.segments
          : [];
      const byId = new Map(
        returned
          .filter(
            (item) =>
              typeof item?.id === "string" && typeof item?.text === "string",
          )
          .map((item) => [item.id, item.text.trim()]),
      );

      batch.forEach((segment) => {
        const key = translationCacheKey(segment.id, segment.text);
        const text = byId.get(segment.id) || "";
        if (text) state.interfaceCache.set(key, text);
        else state.interfaceFailures.add(key);
      });

      render();
      await persistTranslations();
    }
  } finally {
    missing.forEach((segment) =>
      state.inFlight.delete(translationCacheKey(segment.id, segment.text)),
    );
  }
}

function sanitizeFilename(value) {
  const cleaned = String(value || "")
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 60)
    .toLowerCase();
  return cleaned || "mind-map";
}

async function copyMarkdown() {
  const button = document.getElementById("copyMarkdownBtn");
  if (!button || !state.tree) return;
  const original = button.textContent;
  try {
    await navigator.clipboard.writeText(YTD_MINDMAP.toMarkdown(state.tree));
    button.textContent = "Copied";
  } catch (error) {
    button.textContent = "Copy failed";
  }
  setTimeout(() => {
    button.textContent = original;
  }, 1600);
}

function exportSvg() {
  const svg = document.querySelector("#mindmapBody svg");
  if (!svg || !state.tree) return;
  const markup = `<?xml version="1.0" encoding="UTF-8"?>\n${svg.outerHTML}`;
  const blob = new Blob([markup], { type: "image/svg+xml" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${sanitizeFilename(state.tree.title)}.svg`;
  anchor.click();
  URL.revokeObjectURL(url);
}

async function load() {
  const params = new URLSearchParams(window.location.search);
  state.videoId = (params.get("video") || "").trim();
  if (!state.videoId) {
    showEmpty("No video was provided. Open the Mind Map from the side panel.");
    return;
  }

  const stored = await chrome.storage.local.get([
    `digest_${state.videoId}`,
    DISPLAY_LANGUAGE_MODE_KEY,
  ]);
  const cached = stored[`digest_${state.videoId}`];
  if (!cached || !cached.mindmap) {
    showEmpty(
      "No mind map yet. Open this video in the side panel and open the Mind Map tab once.",
    );
    return;
  }

  state.tree = cached.mindmap;
  state.videoTitle = cached.videoTitle || "";
  const storedMode = stored[DISPLAY_LANGUAGE_MODE_KEY]?.[state.videoId]?.mode;
  state.mode = DISPLAY_LANGUAGE_MODES.includes(storedMode)
    ? storedMode
    : "original";
  for (const [key, value] of Object.entries(cached.interfaceCache || {})) {
    state.interfaceCache.set(key, value);
  }

  const title = state.tree.title || state.videoTitle || "Mind Map";
  document.getElementById("mindmapTitle").textContent = title;
  document.getElementById("mindmapSubtitle").textContent =
    state.videoTitle || "";
  document.title = `${title} \u00b7 YouTube Digest`;

  state.collapsed = defaultCollapsedIds(state.tree);
  render();
  void translateMissing();
}

document.getElementById("expandAllBtn").addEventListener("click", () => {
  state.collapsed = new Set();
  render();
});

document.getElementById("collapseAllBtn").addEventListener("click", () => {
  if (!state.tree) return;
  state.collapsed = allBranchIds(state.tree);
  render();
});

document
  .getElementById("copyMarkdownBtn")
  .addEventListener("click", copyMarkdown);
document.getElementById("exportSvgBtn").addEventListener("click", exportSvg);

load();
