/**
 * MIND MAP RENDERER (shared, dependency-free)
 *
 * Pure layout and serialization helpers shared by the side panel and the
 * full-page mind map view. Everything here is deterministic so it can be unit
 * tested in Node; only renderSvg() touches the DOM.
 *
 * Loaded as a plain <script> in extension pages (global: YTD_MINDMAP) and via
 * require() in the repository's Node tests.
 */
var YTD_MINDMAP = (() => {
  // Two density presets: the narrow side panel and the wide full-page view.
  const METRICS = Object.freeze({
    compact: Object.freeze({
      rowHeight: 30,
      lineHeight: 15,
      maxLines: 2,
      verticalGap: 8,
      horizontalGap: 26,
      paddingX: 10,
      charWidth: 6.2,
      minWidth: 76,
      maxWidth: 240,
    }),
    full: Object.freeze({
      rowHeight: 40,
      lineHeight: 19,
      maxLines: 2,
      verticalGap: 12,
      horizontalGap: 46,
      paddingX: 16,
      charWidth: 7.4,
      minWidth: 110,
      maxWidth: 420,
    }),
  });

  /** Structural path joined into a stable, collision-free node id. */
  function getNodeId(path) {
    return path.join("-");
  }

  /** Stable translation key for one node, independent of collapse state. */
  function segmentId(nodeId) {
    return `mindmap-${nodeId}`;
  }

  function nodeLabel(node) {
    return String(node?.label ?? node?.title ?? "").trim();
  }

  function nodeTimestamp(node) {
    return typeof node?.timestamp === "string" ? node.timestamp.trim() : "";
  }

  /**
   * Numeric seconds used for seeking. A missing or out-of-range value becomes
   * null, so a node without a usable timestamp can never seek to 0 by accident.
   */
  function nodeTimestampSeconds(node) {
    const value = node?.timestampSeconds;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      return null;
    }
    return Math.floor(value);
  }

  // Concrete colours, emitted as SVG presentation attributes.
  //
  // These CANNOT be CSS variables: an exported SVG is a standalone file with no
  // stylesheet, so var(--x) would not resolve and an unstyled <rect> would fall
  // back to solid black. Attributes travel with the markup and always render.
  const THEMES = Object.freeze({
    compact: Object.freeze({
      edgeColor: "#ddd4c4",
      edgeWidth: 1.5,
      boxFill: "#fbf8f2",
      branchFill: "#edefeb",
      boxStroke: "#ddd4c4",
      boxStrokeWidth: 1,
      labelColor: "#2e2a24",
      fontSize: 12,
      fontFamily:
        "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      toggleFill: "#ffffff",
      toggleStroke: "#c8674f",
      toggleStrokeWidth: 1.5,
    }),
    full: Object.freeze({
      edgeColor: "#ddd4c4",
      edgeWidth: 1.8,
      boxFill: "#ffffff",
      branchFill: "#edefeb",
      boxStroke: "#ddd4c4",
      boxStrokeWidth: 1,
      labelColor: "#2e2a24",
      fontSize: 14,
      fontFamily:
        "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      toggleFill: "#ffffff",
      toggleStroke: "#c8674f",
      toggleStrokeWidth: 1.5,
    }),
  });

  // CJK and fullwidth characters take roughly twice a latin character's room.
  const WIDE_CHARACTER = 1.9;

  function isWideChar(char) {
    const code = char.codePointAt(0);
    return (
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0x303e) ||
      (code >= 0x3041 && code <= 0x33ff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0xa000 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x20000 && code <= 0x3fffd)
    );
  }

  /** Text length in latin-character units, so translated labels size correctly. */
  function visualWidth(text) {
    let total = 0;
    for (const char of String(text ?? "")) {
      total += isWideChar(char) ? WIDE_CHARACTER : 1;
    }
    return total;
  }

  /** Unclamped text width, used to decide whether a label has to wrap. */
  function rawTextWidth(text, metrics) {
    return visualWidth(text) * metrics.charWidth + metrics.paddingX * 2;
  }

  function measureText(text, metrics) {
    return Math.round(
      Math.min(
        metrics.maxWidth,
        Math.max(metrics.minWidth, rawTextWidth(text, metrics)),
      ),
    );
  }

  function truncateForWidth(text, width, metrics) {
    const available = Math.max(0, width - metrics.paddingX * 2);
    const source = String(text ?? "");
    if (visualWidth(source) * metrics.charWidth <= available) return source;

    // Reserve room for the ellipsis, then fill with whole characters.
    const budget = available - metrics.charWidth;
    let used = 0;
    let output = "";
    for (const char of source) {
      const charWidth =
        (isWideChar(char) ? WIDE_CHARACTER : 1) * metrics.charWidth;
      if (used + charWidth > budget) break;
      output += char;
      used += charWidth;
    }
    return `${output.trimEnd()}\u2026`;
  }

  /**
   * Splits a label into units that must never be broken apart: each CJK
   * character is its own unit, while a latin word keeps its trailing space.
   */
  function tokenizeLabel(text) {
    const tokens = [];
    let buffer = "";
    for (const char of String(text ?? "")) {
      if (isWideChar(char)) {
        if (buffer) {
          tokens.push(buffer);
          buffer = "";
        }
        tokens.push(char);
      } else if (char === " ") {
        tokens.push(`${buffer}${char}`);
        buffer = "";
      } else {
        buffer += char;
      }
    }
    if (buffer) tokens.push(buffer);
    return tokens;
  }

  /**
   * Wraps a label into at most maxLines lines that each fit the box. The
   * leading timestamp stays glued to the first word so "0:51 Sail" never
   * splits across lines. Anything that still overflows is cut with an ellipsis.
   */
  function wrapLabel(text, width, metrics) {
    const availableUnits = Math.max(
      1,
      (width - metrics.paddingX * 2) / metrics.charWidth,
    );
    const tokens = tokenizeLabel(text);
    if (!tokens.length) return [""];

    if (tokens.length >= 2) {
      const glued = `${tokens[0]}${tokens[1]}`;
      if (visualWidth(glued) <= availableUnits) tokens.splice(0, 2, glued);
    }

    const lines = [];
    let current = "";
    for (const token of tokens) {
      const candidate = current ? `${current}${token}` : token;
      if (current && visualWidth(candidate.trimEnd()) > availableUnits) {
        lines.push(current.trimEnd());
        current = token;
      } else {
        current = candidate;
      }
    }
    if (current) lines.push(current.trimEnd());

    if (lines.length <= metrics.maxLines) return lines;

    const head = lines.slice(0, metrics.maxLines - 1);
    const overflow = lines.slice(metrics.maxLines - 1).join("");
    return [...head, truncateForWidth(overflow, width, metrics)];
  }

  /**
   * Lays the visible tree out left to right.
   *
   * Node ids are structural paths, so collapsing a branch never changes the id
   * of any other node and cached translations stay valid. Leaf order decides the
   * vertical position; a parent is centered on its first and last child.
   */
  function buildLayout(tree, { compact = true, collapsedIds } = {}) {
    const metrics = compact ? METRICS.compact : METRICS.full;
    const theme = compact ? THEMES.compact : THEMES.full;
    const collapsed =
      collapsedIds instanceof Set ? collapsedIds : new Set(collapsedIds || []);
    const nodes = [];
    const edges = [];
    const widestByDepth = [];
    let nextLeafY = 0;

    const walk = (node, depth, path, parentId) => {
      const id = getNodeId(path);
      const label = nodeLabel(node);
      const timestamp = nodeTimestamp(node);
      const timestampSeconds = nodeTimestampSeconds(node);
      const text = timestamp ? `${timestamp}  ${label}` : label;

      // Short labels stay on one line. Long ones wrap to at most maxLines and
      // the box grows taller instead of wider.
      const fitsOneLine = rawTextWidth(text, metrics) <= metrics.maxWidth;
      const width = fitsOneLine
        ? measureText(text, metrics)
        : metrics.maxWidth;
      const lines = fitsOneLine
        ? [text]
        : wrapLabel(text, width, metrics).map((line) =>
            truncateForWidth(line, width, metrics),
          );
      const height =
        metrics.rowHeight + (lines.length - 1) * metrics.lineHeight;

      const children = Array.isArray(node?.children) ? node.children : [];
      const hasChildren = children.length > 0;
      const isCollapsed = hasChildren && collapsed.has(id);

      const entry = {
        id,
        depth,
        label,
        timestamp,
        timestampSeconds,
        text,
        lines,
        width,
        height,
        hasChildren,
        collapsed: isCollapsed,
        parentId,
        childIds: [],
        x: 0,
        y: 0,
      };
      nodes.push(entry);
      widestByDepth[depth] = Math.max(widestByDepth[depth] || 0, width);
      // Register the edge as the node is created so edges read in pre-order.
      if (parentId !== null) edges.push({ from: parentId, to: id });

      if (!hasChildren || isCollapsed) {
        entry.y = nextLeafY;
        nextLeafY += height + metrics.verticalGap;
        return entry;
      }

      const childEntries = children.map((child, index) => {
        const childEntry = walk(child, depth + 1, path.concat(index), id);
        entry.childIds.push(childEntry.id);
        return childEntry;
      });
      entry.y = (childEntries[0].y + childEntries[childEntries.length - 1].y) / 2;
      return entry;
    };

    walk(tree, 0, [0], null);

    // Each column starts after the widest node of the previous column, so long
    // labels can never overlap the next level.
    const xByDepth = [];
    let runningX = 0;
    for (let depth = 0; depth < widestByDepth.length; depth += 1) {
      xByDepth[depth] = runningX;
      runningX += (widestByDepth[depth] || 0) + metrics.horizontalGap;
    }
    nodes.forEach((node) => {
      node.x = xByDepth[node.depth] || 0;
    });

    const width = Math.max(0, runningX - metrics.horizontalGap);
    const height = nodes.reduce(
      (max, node) => Math.max(max, node.y + node.height),
      0,
    );

    return { nodes, edges, width, height, metrics, theme };
  }

  /** Renders the tree as a Markdown outline for copy and export. */
  function toMarkdown(tree) {
    const lines = [];
    const title = String(tree?.title ?? "").trim();
    if (title) lines.push(`# ${title}`);

    const walk = (node, depth) => {
      const label = nodeLabel(node);
      if (!label) return;
      const stamp = nodeTimestamp(node);
      lines.push(`${"  ".repeat(depth)}- ${label}${stamp ? ` (${stamp})` : ""}`);
      const children = Array.isArray(node?.children) ? node.children : [];
      children.forEach((child) => walk(child, depth + 1));
    };

    const children = Array.isArray(tree?.children) ? tree.children : [];
    children.forEach((child) => walk(child, 0));
    return lines.join("\n");
  }

  /**
   * Flattens every non-root node into translation segments keyed by its stable
   * structural id, so the universal language control can reuse cached results.
   */
  function toSegments(tree) {
    const segments = [];
    const walk = (node, path) => {
      const label = nodeLabel(node);
      if (!label) return;
      segments.push({ id: segmentId(getNodeId(path)), text: label });
      const children = Array.isArray(node?.children) ? node.children : [];
      children.forEach((child, index) => walk(child, path.concat(index)));
    };

    const children = Array.isArray(tree?.children) ? tree.children : [];
    children.forEach((child, index) => walk(child, [0, index]));
    return segments;
  }

  function escapeXml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /**
   * Builds the SVG as a string. Keeping this pure makes it easy to test and
   * lets renderSvg() stay a thin DOM wrapper.
   */
  function toSvgMarkup(layout, { padding = 24 } = {}) {
    const { nodes, edges, width, height, metrics } = layout;
    const theme = layout.theme || THEMES.compact;
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const canvasWidth = width + padding * 2;
    const canvasHeight = height + padding * 2;
    const parts = [
      `<svg xmlns="http://www.w3.org/2000/svg" class="mindmap-svg" width="${canvasWidth}" height="${canvasHeight}" viewBox="0 0 ${canvasWidth} ${canvasHeight}" role="tree" aria-label="Mind map">`,
      `<g transform="translate(${padding},${padding})">`,
    ];

    edges.forEach((edge) => {
      const from = byId.get(edge.from);
      const to = byId.get(edge.to);
      if (!from || !to) return;
      const x1 = from.x + from.width;
      const y1 = from.y + from.height / 2;
      const x2 = to.x;
      const y2 = to.y + to.height / 2;
      const midX = x1 + (x2 - x1) / 2;
      parts.push(
        `<path class="mindmap-edge" d="M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}" fill="none" stroke="${theme.edgeColor}" stroke-width="${theme.edgeWidth}" />`,
      );
    });

    nodes.forEach((node) => {
      const classes = ["mindmap-node"];
      if (node.hasChildren) classes.push("has-children");
      if (node.collapsed) classes.push("collapsed");
      if (node.timestamp) classes.push("has-time");

      const lines = node.lines && node.lines.length ? node.lines : [node.text];
      const stride = (lines.length - 1) * metrics.lineHeight;
      const firstCenter = (node.height - stride) / 2;
      const tspans = lines
        .map(
          (line, index) =>
            `<tspan x="${metrics.paddingX}" y="${firstCenter + index * metrics.lineHeight}">${escapeXml(line)}</tspan>`,
        )
        .join("");
      const radius = Math.min(12, node.height / 2);
      // Branch nodes keep their tint as an attribute, so an exported file looks
      // identical without any stylesheet.
      const boxFill =
        node.hasChildren && !node.collapsed ? theme.branchFill : theme.boxFill;

      parts.push(
        `<g class="${classes.join(" ")}" data-node-id="${escapeXml(node.id)}" transform="translate(${node.x},${node.y})">`,
        // Native tooltip: the untruncated text, shown on hover.
        `<title>${escapeXml(node.text)}</title>`,
        `<rect class="mindmap-node-box" width="${node.width}" height="${node.height}" rx="${radius}" fill="${boxFill}" stroke="${theme.boxStroke}" stroke-width="${theme.boxStrokeWidth}" />`,
        `<text class="mindmap-node-label" fill="${theme.labelColor}" font-family="${theme.fontFamily}" font-size="${theme.fontSize}" dominant-baseline="middle">${tspans}</text>`,
      );
      if (node.hasChildren) {
        parts.push(
          `<circle class="mindmap-toggle" data-toggle-id="${escapeXml(node.id)}" cx="${node.width}" cy="${node.height / 2}" r="7" fill="${theme.toggleFill}" stroke="${theme.toggleStroke}" stroke-width="${theme.toggleStrokeWidth}" />`,
        );
      }
      parts.push("</g>");
    });

    parts.push("</g>", "</svg>");
    return parts.join("");
  }

  /**
   * Draws the layout into a container and wires one delegated click handler.
   * Clicking the small circle toggles a branch; clicking the box reports the
   * node so the host can seek the video.
   */
  function renderSvg(container, layout, { onNodeClick, onToggle } = {}) {
    if (!container) return null;
    container.innerHTML = toSvgMarkup(layout);
    const svg = container.querySelector("svg");
    if (!svg) return null;

    const byId = new Map(layout.nodes.map((node) => [node.id, node]));
    svg.addEventListener("click", (event) => {
      const target = event.target;
      const toggle = target?.closest?.(".mindmap-toggle");
      if (toggle) {
        event.stopPropagation();
        if (onToggle) onToggle(toggle.getAttribute("data-toggle-id"));
        return;
      }
      const group = target?.closest?.(".mindmap-node");
      if (!group) return;
      const node = byId.get(group.getAttribute("data-node-id"));
      if (node && onNodeClick) onNodeClick(node);
    });

    return svg;
  }

  return {
    METRICS,
    THEMES,
    buildLayout,
    escapeXml,
    getNodeId,
    isWideChar,
    measureText,
    nodeLabel,
    nodeTimestamp,
    nodeTimestampSeconds,
    rawTextWidth,
    renderSvg,
    segmentId,
    toMarkdown,
    toSegments,
    toSvgMarkup,
    tokenizeLabel,
    truncateForWidth,
    visualWidth,
    wrapLabel,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = YTD_MINDMAP;
}
