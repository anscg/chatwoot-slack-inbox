/**
 * Slack emoji for the Chatwoot agent dashboard.
 *
 * Chatwoot only knows Unicode emoji, so a workspace's custom ones (:parrot:, :yay:) are
 * invisible to agents. This script makes both of Chatwoot's emoji surfaces Slack's:
 *
 *   1. the emoji picker — Chatwoot's grid is replaced by one list holding the workspace's
 *      custom emoji and the standard set together
 *   2. the `:` typeahead — the same list, Slack matches first, replacing Chatwoot's own
 *   3. message bubbles — `:shortcode:` renders as the emoji instead of as text
 *
 * A custom emoji is inserted as the plain shortcode `:name:`, which Slack expands when the
 * bridge relays the reply; a standard one is inserted as the character, exactly as Chatwoot
 * would have.
 *
 * Custom emoji are searched on the bridge rather than downloaded: a workspace can hold tens
 * of thousands of them, which is megabytes of JSON no dashboard tab should be parsing. Only
 * matches and the names a message mentions come over the wire, and both are memoised here.
 * The standard set is small and static, so it ships as unicode-emoji.json next to this file
 * (Chatwoot's own list, so agents keep the glyphs and search terms they know).
 *
 * Chatwoot's composer is ProseMirror, a contenteditable it reconciles on every change, so
 * text goes in through execCommand("insertText") over a selected range — the path a paste
 * takes — and nothing is ever written into the composer's DOM directly.
 *
 * Load it from Chatwoot's DASHBOARD_SCRIPTS, either from the bridge itself:
 *   <script src="https://bridge.example.com/dashboard/slack-emoji.js"></script>
 * or from a CDN, in which case name the bridge so it knows where the list lives:
 *   <script src="https://cdn.jsdelivr.net/gh/owner/repo@sha/public/slack-emoji.js"
 *           data-bridge="https://bridge.example.com"></script>
 */
(function () {
  "use strict";

  var SELF = document.currentScript;
  var SOURCE = (SELF && SELF.src) || "";
  var BRIDGE = (SELF && (SELF.getAttribute("data-bridge") || queryParam(SOURCE, "bridge"))) || "";
  var DATA_URL = dataUrl();
  var UNICODE_URL = SOURCE ? SOURCE.replace(/slack-emoji\.js(\?.*)?$/, "unicode-emoji.json") : "/dashboard/unicode-emoji.json";
  var SEARCH_URL = DATA_URL.replace(/slack-emoji\.json$/, "slack-emoji/search");
  var LOOKUP_URL = DATA_URL.replace(/slack-emoji\.json$/, "slack-emoji/lookup");

  var TYPEAHEAD_CUSTOM = 8; // Slack rows before the standard ones in the `:` list
  var TYPEAHEAD_STANDARD = 8;
  var PICKER_CUSTOM = 120; // images cost a request each, so the searched grid stays bounded
  var PICKER_STANDARD = 300;
  var DEBOUNCE_MS = 120;
  var DONE = "data-slack-emoji"; // marks what has been handled, and keeps the observer cheap

  /** Standard emoji, held locally: {name, slug, char, group}. */
  var standard = [];
  var groups = [];

  /** Custom emoji the bridge has told us about so far, by name: {name, url}. */
  var known = Object.create(null);
  var searches = Object.create(null); // query -> [names], so a repeated keystroke costs nothing
  var missing = Object.create(null); // names the bridge said it does not have

  function warn(message, detail) {
    if (window.console) console.warn("[slack-emoji] " + message, detail || "");
  }

  function queryParam(url, name) {
    try {
      return new URL(url, location.href).searchParams.get(name);
    } catch (err) {
      return null;
    }
  }

  /**
   * The emoji list comes from the bridge, which is wherever this script was served from
   * unless `data-bridge` says otherwise — served off a CDN, it has to be told.
   */
  function dataUrl() {
    if (BRIDGE) return BRIDGE.replace(/\/+$/, "") + "/dashboard/slack-emoji.json";
    if (!SOURCE) return "/dashboard/slack-emoji.json";
    try {
      if (new URL(SOURCE, location.href).origin !== location.origin) {
        warn('loaded from another origin without data-bridge="https://your-bridge"; no emoji will load');
      }
    } catch (err) {
      /* opaque src; fall through and try anyway */
    }
    return SOURCE.replace(/slack-emoji\.js(\?.*)?$/, "slack-emoji.json");
  }

  function json(res) {
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.json();
  }

  /** Fold a `{prefix, emoji}` answer into what we know, and hand back the names it carried. */
  function absorb(body) {
    var prefix = body.prefix || "";
    var map = body.emoji || {};
    var names = Object.keys(map);
    for (var i = 0; i < names.length; i++) {
      var value = map[names[i]];
      known[names[i]] = { name: names[i], url: /^https?:/.test(value) ? value : prefix + value };
    }
    return names;
  }

  function searchCustom(query, limit, then) {
    var q = normalise(query);
    if (!q) return then([]);
    if (searches[q]) return then(named(searches[q], limit));
    fetch(SEARCH_URL + "?limit=" + PICKER_CUSTOM + "&q=" + encodeURIComponent(q), { credentials: "omit" })
      .then(json)
      .then(function (body) {
        searches[q] = absorb(body);
        then(named(searches[q], limit));
      })
      .catch(function (err) {
        searches[q] = [];
        warn("emoji search failed", err);
        then([]);
      });
    return undefined;
  }

  function named(names, limit) {
    var out = [];
    for (var i = 0; i < names.length && out.length < limit; i++) if (known[names[i]]) out.push(known[names[i]]);
    return out;
  }

  // Opening a conversation renders every message at once, so the names they mention are
  // pooled for a tick and asked for together instead of one request per bubble.
  var pooled = Object.create(null);
  var waiting = [];
  var flushing = null;

  function lookup(names, then) {
    var wanted = names.filter(function (name) {
      return !known[name] && !missing[name];
    });
    if (!wanted.length) return then();
    for (var i = 0; i < wanted.length; i++) pooled[wanted[i]] = true;
    waiting.push(then);
    if (!flushing) flushing = setTimeout(flushLookups, 30);
    return undefined;
  }

  function flushLookups() {
    flushing = null;
    var names = Object.keys(pooled);
    var callbacks = waiting;
    pooled = Object.create(null);
    waiting = [];

    var batches = [];
    for (var i = 0; i < names.length; i += 200) batches.push(names.slice(i, i + 200));

    Promise.all(
      batches.map(function (batch) {
        return fetch(LOOKUP_URL + "?names=" + encodeURIComponent(batch.join(",")), { credentials: "omit" })
          .then(json)
          .then(absorb)
          .catch(function (err) {
            warn("emoji lookup failed", err);
          });
      }),
    ).then(function () {
      for (var j = 0; j < names.length; j++) if (!known[names[j]]) missing[names[j]] = true;
      for (var k = 0; k < callbacks.length; k++) callbacks[k]();
    });
  }

  function loadStandard() {
    fetch(UNICODE_URL, { credentials: "omit" })
      .then(json)
      .then(function (body) {
        groups = body.groups || [];
        standard = (body.emoji || []).map(function (row) {
          return { char: row[0], name: row[1], slug: row[2], group: row[3] };
        });
        redraw();
      })
      .catch(function (err) {
        warn("could not load the standard emoji list from " + UNICODE_URL + "; only custom emoji will show", err);
      });
  }

  /** A list can land after a picker is open or a bubble is drawn; both are redone in place. */
  var drawers = [];

  function redraw() {
    drawers = drawers.filter(function (drawer) {
      return drawer.node.isConnected;
    });
    for (var i = 0; i < drawers.length; i++) drawers[i].draw();
  }

  function normalise(query) {
    return String(query || "").toLowerCase().replace(/:/g, "").trim();
  }

  function searchStandard(query, limit) {
    var q = normalise(query).replace(/_/g, " ");
    if (!q) return [];
    var hits = [];
    for (var i = 0; i < standard.length; i++) {
      var item = standard[i];
      var at = item.name.indexOf(q);
      if (at === -1) at = item.slug.replace(/_/g, " ").indexOf(q);
      if (at !== -1) hits.push({ at: at, key: item.name, item: item });
    }
    hits.sort(function (a, b) {
      return a.at - b.at || a.key.length - b.key.length || (a.key < b.key ? -1 : 1);
    });
    return hits.slice(0, limit).map(function (hit) {
      return hit.item;
    });
  }

  /** One trailing call per burst of typing, so a fast typist makes one request, not eight. */
  function debounce(fn) {
    var timer = null;
    return function () {
      var args = arguments;
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () {
        timer = null;
        fn.apply(null, args);
      }, DEBOUNCE_MS);
    };
  }

  // ---------------------------------------------------------------- the composer

  var lastEditor = null;

  function editorOf(node) {
    if (!node || !node.closest) return null;
    if (node.tagName === "TEXTAREA" && !node.readOnly && !node.disabled) return { rich: false, el: node };
    var rich = node.closest('[contenteditable="true"]');
    return rich ? { rich: true, el: rich } : null;
  }

  document.addEventListener(
    "focusin",
    function (e) {
      var found = editorOf(e.target);
      if (found) lastEditor = found;
    },
    true,
  );

  function currentEditor(near) {
    var found = editorOf(document.activeElement);
    if (found) lastEditor = found;
    if (lastEditor && document.contains(lastEditor.el)) return lastEditor;
    return near ? editorNear(near) : null;
  }

  /** Nothing focused (the agent clicked straight into the picker): take the closest composer. */
  function editorNear(node) {
    for (var el = node; el && el !== document.documentElement; el = el.parentElement) {
      var candidate = el.querySelector('[contenteditable="true"], textarea:not([readonly]):not([disabled])');
      if (candidate) return editorOf(candidate);
    }
    return null;
  }

  /**
   * The `:query` at the end of the editor's text. The popover's own search box can run ahead
   * of what the editor holds, so the trigger is found by its shape rather than by the query.
   */
  function triggerAtEnd(el) {
    var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    var last = null;
    var node;
    while ((node = walker.nextNode())) if (node.data) last = node;
    if (!last) return null;
    var match = /:[a-z0-9_+'-]*$/i.exec(last.data);
    return match ? { node: last, start: match.index, end: last.data.length } : null;
  }

  /**
   * execCommand is deprecated but remains the only way to hand text to ProseMirror without a
   * reference to its EditorView: it raises the same beforeinput the editor already handles
   * for typing and pasting, so the editor's own state stays authoritative.
   */
  function insert(item, replaceTrigger, near) {
    var editor = currentEditor(near);
    if (!editor) return;
    var text = item.char ? item.char : ":" + item.name + ": ";

    if (!editor.rich) {
      var el = editor.el;
      var from = el.selectionStart;
      if (replaceTrigger) {
        var trigger = /:[a-z0-9_+'-]*$/i.exec(el.value.slice(0, from));
        if (trigger) from = trigger.index;
      }
      el.focus();
      el.setRangeText(text, from, el.selectionEnd, "end");
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }

    editor.el.focus();
    if (replaceTrigger) {
      var span = triggerAtEnd(editor.el);
      if (span) {
        var range = document.createRange();
        range.setStart(span.node, span.start);
        range.setEnd(span.node, span.end);
        var selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      }
    }
    document.execCommand("insertText", false, text);
  }

  /** Chatwoot closes both pickers on Escape; ours reuses that rather than reaching into Vue. */
  function closePicker() {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  }

  // ---------------------------------------------------------------- shared rendering

  function esc(value) {
    return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function faceFor(item) {
    return item.char
      ? '<span class="cw-slack-glyph">' + esc(item.char) + "</span>"
      : '<img class="cw-slack-img" src="' + esc(item.url) + '" alt="" loading="lazy">';
  }

  function tileFor(item, index) {
    var label = item.char ? item.name : ":" + item.name + ":";
    return '<button type="button" class="cw-slack-tile" title="' + esc(label) + '" data-i="' + index + '">' + faceFor(item) + "</button>";
  }

  /** One flat array behind both surfaces, so a click and a keypress resolve the same way. */
  var shown = [];

  function itemAt(node) {
    var index = node && node.getAttribute("data-i");
    return index == null ? null : shown[Number(index)];
  }

  // ---------------------------------------------------------------- the emoji picker

  function isEmojiDialog(node) {
    if (!node || !node.matches) return false;
    if (node.matches(".emoji-dialog")) return true;
    if (!node.matches('[role="dialog"]') || !node.querySelector("input")) return false;
    // A dialog holding a search box over a fixed-height pane of emoji buttons. The pane is
    // matched by shape, not by content: when Chatwoot's own search finds nothing it swaps
    // the grid for an empty state, and the picker has to stay recognisable either way.
    return !!node.querySelector(".h-60, .emoji-item, .grid button, .emoji--row button");
  }

  /**
   * Chatwoot's picker is a search box followed by two sibling `h-60` panes it swaps between:
   * the emoji list, or a "no emoji" state when its own search comes up empty. Both are Vue's
   * to create and destroy, so they are hidden by a stylesheet rule rather than by touching
   * the nodes, and ours is appended after them where a re-render leaves it alone.
   */
  function takeOverDialog(dialog) {
    var box = dialog.querySelector('input[type="text"], input[type="search"]');
    var wrapper = box && box.parentElement && box.parentElement.parentElement;
    if (!wrapper) return;
    dialog.setAttribute(DONE, "picker");

    var panel = document.createElement("div");
    panel.className = "cw-slack-panel";
    wrapper.appendChild(panel);

    // The Slack half arrives from the bridge, so the standard half is painted at once and
    // the Slack section drops in above it when the answer lands.
    function draw() {
      var query = box ? box.value : "";
      paint([], !normalise(query));
      if (normalise(query)) searchSoon(query);
    }

    var searchSoon = debounce(function (query) {
      searchCustom(query, PICKER_CUSTOM, function (hits) {
        if (box && box.value === query) paint(hits, true);
      });
    });

    function paint(hits, settled) {
      var query = box ? box.value : "";
      var parts = [];
      shown = [];

      if (hits.length) parts.push(section("Slack", hits));

      if (normalise(query)) {
        var matches = searchStandard(query, PICKER_STANDARD);
        if (matches.length) parts.push(section("Emoji", matches));
        if (!hits.length && !matches.length) parts.push('<p class="cw-slack-note">' + (settled ? "No emoji match " + esc(query) : "Searching…") + "</p>");
      } else {
        // Idle: the standard set, grouped the way Chatwoot groups it.
        for (var g = 0; g < groups.length; g++) {
          var inGroup = standard.filter(byGroup(g));
          if (inGroup.length) parts.push(section(groups[g], inGroup));
        }
      }
      panel.innerHTML = parts.join("");
    }

    function section(title, items) {
      var tiles = items
        .map(function (item) {
          shown.push(item);
          return tileFor(item, shown.length - 1);
        })
        .join("");
      return '<h5 class="cw-slack-heading">' + esc(title) + '</h5><div class="cw-slack-grid">' + tiles + "</div>";
    }

    panel.addEventListener("mousedown", function (e) {
      e.preventDefault(); // keep the composer's selection, which is what we are about to replace
    });
    panel.addEventListener("click", function (e) {
      var tile = e.target.closest("[data-i]");
      if (!tile) return;
      var item = itemAt(tile);
      if (!item) return;
      insert(item, false, dialog);
      closePicker();
    });
    if (box) box.addEventListener("input", draw);
    drawers.push({ node: dialog, draw: draw });
    draw();
  }

  function byGroup(index) {
    return function (item) {
      return item.group === index;
    };
  }

  // ---------------------------------------------------------------- the `:` typeahead

  // Chatwoot ships its own `:` picker: a combobox teleported to the body, listing Unicode
  // emoji. Its list is hidden and ours put in its place, holding the workspace's custom
  // emoji first and the standard ones after, so one list answers the whole `:` query. Its
  // keys are claimed in the capture phase, ahead of Chatwoot's document-level handlers.
  var selected = 0;

  function isEmojiPopover(node) {
    if (!node || !node.matches || !node.matches("[data-popover-content]")) return false;
    var row = node.querySelector('[role="option"]');
    // The emoji list is the one whose rows carry a `:shortcode:` subtitle.
    return !!row && /:[a-z0-9_+'-]{2,}:/.test(row.textContent || "");
  }

  function takeOverPopover(popover) {
    popover.setAttribute(DONE, "emoji");
    var list = popover.querySelector('ul[role="listbox"]');
    var box = popover.querySelector("input");
    if (!list || !box) return;

    var ours = document.createElement("ul");
    ours.className = "cw-slack-rows";
    ours.setAttribute("role", "listbox");
    list.parentElement.insertBefore(ours, list);

    function draw() {
      var query = box.value;
      paint([], !normalise(query));
      if (normalise(query)) searchSoon(query);
    }

    var searchSoon = debounce(function (query) {
      searchCustom(query, TYPEAHEAD_CUSTOM, function (hits) {
        if (box.value === query) paint(hits, true);
      });
    });

    function paint(hits, settled) {
      var query = box.value;
      shown = hits.concat(searchStandard(query, TYPEAHEAD_STANDARD));
      selected = 0;
      ours.innerHTML = shown.length
        ? shown
            .map(function (item, i) {
              return (
                '<li role="option" class="cw-slack-row' +
                (i === 0 ? " is-active" : "") +
                '" data-i="' +
                i +
                '">' +
                faceFor(item) +
                '<span class="cw-slack-row-name">' +
                esc(item.name) +
                '</span><span class="cw-slack-row-code">' +
                esc(item.char ? "" : ":" + item.name + ":") +
                "</span></li>"
              );
            })
            .join("")
        : '<li class="cw-slack-note">' + (settled ? "No emoji match " + esc(query) : "Searching…") + "</li>";
    }

    ours.addEventListener("mousedown", function (e) {
      e.preventDefault();
    });
    ours.addEventListener("mousemove", function (e) {
      var row = e.target.closest("[data-i]");
      if (row) highlight(Number(row.getAttribute("data-i")));
    });
    ours.addEventListener("click", function (e) {
      var row = e.target.closest("[data-i]");
      if (row) choose(itemAt(row));
    });

    box.addEventListener("input", draw);
    drawers.push({ node: popover, draw: draw });
    draw();
  }

  function openPopover() {
    var popovers = document.querySelectorAll('[data-popover-content][' + DONE + '="emoji"]');
    for (var i = 0; i < popovers.length; i++) if (popovers[i].isConnected) return popovers[i];
    return null;
  }

  function highlight(index) {
    var popover = openPopover();
    if (!popover) return;
    var rows = popover.querySelectorAll(".cw-slack-row");
    if (!rows.length) return;
    selected = (index + rows.length) % rows.length;
    for (var i = 0; i < rows.length; i++) rows[i].classList.toggle("is-active", i === selected);
    rows[selected].scrollIntoView({ block: "nearest" });
  }

  function choose(item) {
    if (!item) return;
    insert(item, true, null);
    closePicker();
  }

  document.addEventListener(
    "keydown",
    function (e) {
      var popover = openPopover();
      if (!popover || !shown.length) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        claim(e);
        highlight(selected + (e.key === "ArrowDown" ? 1 : -1));
      } else if (e.key === "Enter" || e.key === "Tab") {
        claim(e);
        choose(shown[selected]);
      }
    },
    true,
  );

  function claim(e) {
    e.preventDefault();
    e.stopPropagation();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
  }

  // ---------------------------------------------------------------- message bubbles

  var SHORTCODE = /:([a-z0-9_+'-]{1,100}):/gi;

  /** Swap `:name:` for the image inside one rendered message. */
  function renderBubble(node) {
    node.setAttribute(DONE, "");
    var wanted = [];
    var text = node.textContent || "";
    SHORTCODE.lastIndex = 0;
    var found;
    while ((found = SHORTCODE.exec(text))) wanted.push(found[1].toLowerCase());
    if (!wanted.length) return;
    // Names this message mentions, asked for in one request and remembered for the next.
    lookup(wanted, function () {
      if (node.isConnected) paintBubble(node);
    });
  }

  function paintBubble(node) {
    var walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    var texts = [];
    var text;
    while ((text = walker.nextNode())) if (text.data.indexOf(":") !== -1) texts.push(text);

    for (var i = 0; i < texts.length; i++) {
      var parts = document.createDocumentFragment();
      var at = 0;
      var found = false;
      var data = texts[i].data;
      SHORTCODE.lastIndex = 0;
      var match;
      while ((match = SHORTCODE.exec(data))) {
        var item = known[match[1].toLowerCase()];
        if (!item) continue;
        found = true;
        if (match.index > at) parts.appendChild(document.createTextNode(data.slice(at, match.index)));
        var img = document.createElement("img");
        img.className = "cw-slack-inline";
        img.src = item.url;
        img.alt = match[0];
        img.title = match[0];
        img.loading = "lazy";
        parts.appendChild(img);
        at = match.index + match[0].length;
      }
      if (!found) continue;
      if (at < data.length) parts.appendChild(document.createTextNode(data.slice(at)));
      texts[i].parentNode.replaceChild(parts, texts[i]);
    }
  }

  // ---------------------------------------------------------------- wiring

  // One selector answers "is there anything to do?", so the observer stays cheap on a
  // dashboard that mutates constantly. Everything handled is marked and never revisited.
  var PENDING =
    ".emoji-dialog:not([" + DONE + "]), [role='dialog']:not([" + DONE + "]), [data-popover-content]:not([" + DONE + "]), .prose-bubble:not([" + DONE + "])";

  var observer = null;
  var scheduled = false;
  var budget = { count: 0, since: 0 };

  function refresh() {
    reclaim();
    if (!document.querySelector(PENDING)) return;
    if (!spend()) return;
    if (observer) observer.disconnect();
    try {
      var pending = document.querySelectorAll(PENDING);
      for (var i = 0; i < pending.length; i++) {
        var node = pending[i];
        if (node.matches(".prose-bubble")) renderBubble(node);
        else if (isEmojiPopover(node)) takeOverPopover(node);
        else if (isEmojiDialog(node)) takeOverDialog(node);
        else if (node.matches("[role='dialog'], [data-popover-content]")) node.setAttribute(DONE, "skip");
      }
    } finally {
      if (observer) {
        observer.takeRecords();
        observer.observe(document.documentElement, { childList: true, subtree: true });
      }
    }
  }

  /**
   * Vue owns these surfaces and rebuilds them as its own state changes, which can take our
   * list with it. Anything we marked but no longer holds our list is unmarked, and the next
   * pass takes it over again.
   */
  function reclaim() {
    var picker = document.querySelector('[' + DONE + '="picker"]');
    if (picker && !picker.querySelector(".cw-slack-panel")) picker.removeAttribute(DONE);
    var popover = document.querySelector('[' + DONE + '="emoji"]');
    if (popover && !popover.querySelector(".cw-slack-rows")) popover.removeAttribute(DONE);
  }

  /** If decorating ever runs away, stop watching rather than pinning the tab's main thread. */
  function spend() {
    var now = Date.now();
    if (now - budget.since > 1000) {
      budget.since = now;
      budget.count = 0;
    }
    if (++budget.count <= 60) return true;
    if (observer) observer.disconnect();
    observer = null;
    warn("decorating too often; stopped watching the DOM");
    return false;
  }

  observer = new MutationObserver(function () {
    if (scheduled) return; // coalesce a burst of Vue patches into one pass
    scheduled = true;
    requestAnimationFrame(function () {
      scheduled = false;
      refresh();
    });
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  var style = document.createElement("style");
  style.textContent = [
    ".cw-slack-panel{height:15rem;overflow-y:auto;padding:0 8px 8px;scrollbar-width:none}",
    ".cw-slack-panel::-webkit-scrollbar{display:none}",
    ".cw-slack-heading{margin:6px 2px 2px;font-size:11px;font-weight:500;letter-spacing:.04em;text-transform:uppercase;opacity:.6}",
    ".cw-slack-grid{display:grid;grid-template-columns:repeat(10,minmax(0,1fr));gap:2px}",
    ".cw-slack-tile{display:flex;align-items:center;justify-content:center;padding:2px;border:0;background:none;border-radius:8px;cursor:pointer;aspect-ratio:1;font-size:20px;line-height:1}",
    ".cw-slack-tile:hover{background:rgba(127,127,127,.18)}",
    ".cw-slack-img{width:20px;height:20px;object-fit:contain}",
    ".cw-slack-glyph{font-size:20px;line-height:1}",
    ".cw-slack-note{margin:8px 2px;font-size:12px;opacity:.6}",
    ".cw-slack-rows{margin:0;padding:0;list-style:none}",
    ".cw-slack-row{display:flex;align-items:center;gap:8px;padding:4px 8px;border-radius:8px;cursor:pointer;font-size:13px}",
    ".cw-slack-row .cw-slack-img,.cw-slack-row .cw-slack-glyph{width:18px;height:18px;font-size:16px;text-align:center}",
    ".cw-slack-row-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
    ".cw-slack-row-code{margin-inline-start:auto;opacity:.55;font-size:12px}",
    ".cw-slack-row:hover,.cw-slack-row.is-active{background:rgba(127,127,127,.22)}",
    ".cw-slack-inline{display:inline-block;width:1.35em;height:1.35em;object-fit:contain;vertical-align:-0.3em}",
    // Chatwoot's own panes, in the surfaces this script owns: the picker's list and its
    // "no emoji" state (sibling h-60 divs it swaps between), and the typeahead's list and
    // "no items found" notice. Hidden by rule, since Vue recreates the nodes as it likes.
    '[data-slack-emoji="picker"] .h-60{display:none!important}',
    '[data-slack-emoji="emoji"] ul[role="listbox"]:not(.cw-slack-rows){display:none!important}',
    '[data-slack-emoji="emoji"] [role="status"]{display:none!important}',
  ].join("");
  document.head.appendChild(style);

  loadStandard();
})();
