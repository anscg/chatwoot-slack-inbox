/**
 * Slack custom emoji for the Chatwoot agent dashboard.
 *
 * Chatwoot only knows Unicode emoji, so a workspace's custom ones (:parrot:, :yay:) are
 * invisible to agents. This script adds them in the two places agents reach for emoji:
 *
 *   1. a "Slack" section pinned to the top of the emoji picker, following its search box
 *   2. the `:` typeahead, where Slack matches are listed above Chatwoot's Unicode ones
 *
 * Both insert the plain shortcode `:name:`, which Slack expands when the bridge relays
 * the reply. The list comes from this bridge's /dashboard/slack-emoji.json.
 *
 * Chatwoot's composer is ProseMirror (a contenteditable), so text goes in through
 * execCommand("insertText") over a selected range — the same path a paste takes — which
 * is what keeps ProseMirror's own state in sync. Older Chatwoot builds used a textarea;
 * both are handled.
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
  var CACHE_KEY = "cw-slack-emoji:v2:" + DATA_URL;
  var CACHE_TTL = 24 * 60 * 60 * 1000;
  var MAX_IN_TYPEAHEAD = 6;
  var MAX_IN_PICKER = 300;

  /** [{name, url}] sorted by name; empty until the list arrives. */
  var emoji = [];

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
        warn("loaded from another origin without data-bridge=\"https://your-bridge\"; no emoji will load");
      }
    } catch (err) {
      /* opaque src; fall through and try anyway */
    }
    return SOURCE.replace(/slack-emoji\.js(\?.*)?$/, "slack-emoji.json");
  }

  // ---------------------------------------------------------------- emoji list

  function cached() {
    try {
      var parsed = JSON.parse(window.localStorage.getItem(CACHE_KEY) || "null");
      return parsed && Date.now() - parsed.at < CACHE_TTL ? parsed : null;
    } catch (err) {
      return null;
    }
  }

  /** The server sends the shared `https://emoji.slack-edge.com/<team>/` prefix separately. */
  function adopt(body) {
    var map = body.emoji || {};
    var prefix = body.prefix || "";
    emoji = Object.keys(map)
      .sort()
      .map(function (name) {
        return { name: name, url: prefix + map[name] };
      });
    decorate(); // a picker may already be open when the list lands
  }

  function load() {
    var fromCache = cached();
    if (fromCache) adopt(fromCache);
    fetch(DATA_URL, { credentials: "omit" })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (body) {
        adopt(body);
        try {
          window.localStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), prefix: body.prefix, emoji: body.emoji }));
        } catch (err) {
          /* a big workspace can outgrow the quota; the in-memory copy still serves this tab */
        }
      })
      .catch(function (err) {
        if (!fromCache) warn("could not load the emoji list from " + DATA_URL, err);
      });
  }

  /** Substring match, earliest hit first, then shortest name. */
  function search(query, limit) {
    var q = String(query || "").toLowerCase().replace(/^:+|:+$/g, "");
    if (!q) return emoji.slice(0, limit);
    var hits = [];
    for (var i = 0; i < emoji.length; i++) {
      var at = emoji[i].name.indexOf(q);
      if (at !== -1) hits.push({ item: emoji[i], at: at });
    }
    hits.sort(function (a, b) {
      return a.at - b.at || a.item.name.length - b.item.name.length || (a.item.name < b.item.name ? -1 : 1);
    });
    return hits.slice(0, limit).map(function (h) {
      return h.item;
    });
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

  /** The last `:query` in the editor's text, as a DOM range we can overwrite. */
  function triggerRange(el, query) {
    var needle = ":" + query;
    var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    var node;
    var found = null;
    while ((node = walker.nextNode())) {
      var at = node.data.lastIndexOf(needle);
      if (at !== -1) found = { node: node, start: at, end: at + needle.length };
    }
    return found;
  }

  /**
   * Insert `:name: `, replacing the `:query` that triggered the typeahead when there is one.
   * execCommand is deprecated but is still the only way to hand text to ProseMirror from
   * outside without a reference to its EditorView: it fires the same beforeinput the editor
   * already handles for typing and pasting.
   */
  function insertShortcode(name, query, near) {
    var editor = currentEditor(near);
    if (!editor) return;
    var text = ":" + name + ": ";

    if (!editor.rich) {
      var el = editor.el;
      var from = el.selectionStart;
      var to = el.selectionEnd;
      if (query != null) {
        var before = el.value.slice(0, from).lastIndexOf(":" + query);
        if (before !== -1) from = before;
      }
      el.focus();
      el.setRangeText(text, from, to, "end");
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }

    editor.el.focus();
    if (query != null) {
      var span = triggerRange(editor.el, query);
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

  // ---------------------------------------------------------------- the emoji picker

  /** The picker is a dialog holding a search box and a grid of emoji buttons. */
  function isEmojiDialog(node) {
    if (!node.matches) return false;
    if (node.matches(".emoji-dialog")) return true;
    return node.matches('[role="dialog"]') && !!node.querySelector("input") && !!node.querySelector(".grid button, .emoji--row button");
  }

  function findDialogs(root) {
    var out = [];
    if (isEmojiDialog(root)) out.push(root);
    var candidates = root.querySelectorAll ? root.querySelectorAll('.emoji-dialog, [role="dialog"]') : [];
    for (var i = 0; i < candidates.length; i++) if (isEmojiDialog(candidates[i])) out.push(candidates[i]);
    return out;
  }

  function decorateDialog(dialog) {
    if (!emoji.length || dialog.querySelector(".cw-slack-section")) return;

    var section = document.createElement("div");
    section.className = "cw-slack-section";
    section.innerHTML = '<h5 class="cw-slack-title">Slack</h5><div class="cw-slack-grid"></div><p class="cw-slack-empty"></p>';
    var grid = section.querySelector(".cw-slack-grid");
    var empty = section.querySelector(".cw-slack-empty");

    function fill(query) {
      // With thousands of emoji an unfiltered grid is just the first few hundred names
      // alphabetically, so it stays closed until there is something to match on.
      if (!String(query || "").replace(/:/g, "").trim()) {
        grid.innerHTML = "";
        empty.hidden = false;
        empty.textContent = "Type to search " + emoji.length.toLocaleString() + " Slack emoji.";
        return;
      }
      var hits = search(query, MAX_IN_PICKER);
      grid.innerHTML = hits
        .map(function (item) {
          return '<button type="button" class="cw-slack-btn" title=":' + item.name + ':" data-emoji="' + item.name + '"><img src="' + item.url + '" alt=":' + item.name + ':" loading="lazy"></button>';
        })
        .join("");
      empty.hidden = hits.length > 0;
      empty.textContent = "No Slack emoji match.";
    }

    section.addEventListener("mousedown", function (e) {
      e.preventDefault(); // don't let the dialog steal the selection we are about to replace
    });
    section.addEventListener("click", function (e) {
      var button = e.target.closest("[data-emoji]");
      if (!button) return;
      insertShortcode(button.getAttribute("data-emoji"), null, dialog);
      closePicker();
    });

    // Sit between the search box and the (virtualised) Unicode grid rather than inside it.
    var scroller = dialog.querySelector(".emoji-item") || scrollableIn(dialog);
    if (scroller && scroller.parentElement) scroller.parentElement.insertBefore(section, scroller);
    else dialog.appendChild(section);

    var box = dialog.querySelector('input[type="text"], input[type="search"]');
    if (box) {
      box.addEventListener("input", function () {
        fill(box.value);
      });
    }
    fill(box ? box.value : "");
  }

  /** Chatwoot closes both pickers on Escape; ours reuses that rather than reaching into Vue. */
  function closePicker() {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  }

  function scrollableIn(dialog) {
    var divs = dialog.querySelectorAll("div");
    for (var i = 0; i < divs.length; i++) {
      if (divs[i].scrollHeight > divs[i].clientHeight + 8) return divs[i];
    }
    return null;
  }

  /**
   * Decorating means writing to the DOM, which the observer below would see as a change to
   * decorate again, so it is detached for the duration. The budget is a second line of
   * defence: if something still manages to loop, the observer is dropped rather than
   * pinning the tab's main thread.
   */
  var observer = null;
  var budget = { count: 0, since: 0 };
  var scheduled = false;

  function decorate() {
    var now = Date.now();
    if (now - budget.since > 1000) {
      budget.since = now;
      budget.count = 0;
    }
    if (++budget.count > 60) {
      if (observer) observer.disconnect();
      observer = null;
      warn("decorating too often; stopped watching the DOM");
      return;
    }
    if (observer) observer.disconnect();
    try {
      var dialogs = findDialogs(document.body);
      for (var i = 0; i < dialogs.length; i++) decorateDialog(dialogs[i]);
      var popover = findEmojiPopover();
      if (popover) decoratePopover(popover);
    } finally {
      if (observer) {
        observer.takeRecords();
        observer.observe(document.documentElement, { childList: true, subtree: true });
      }
    }
  }

  // ---------------------------------------------------------------- the `:` typeahead

  // Chatwoot ships its own `:` picker (a combobox teleported to the body, listing Unicode
  // emoji). Rather than fight it, Slack matches are added to the same list, above the
  // Unicode ones. Its own keyboard handling stays in charge until the selection moves up
  // into the Slack rows, at which point the arrow/Enter/Tab keys are claimed in the capture
  // phase so Chatwoot's document-level handlers never see them.
  var slackIndex = -1; // -1 = Chatwoot's list has the selection

  // Chatwoot uses the same popover for canned responses and variables; the emoji one is
  // recognised once, by its rows carrying `:shortcode:` subtitles, and remembered after that.
  var knownEmojiPopovers = new WeakSet();

  function findEmojiPopover() {
    var popovers = document.querySelectorAll("[data-popover-content]");
    for (var i = 0; i < popovers.length; i++) {
      var popover = popovers[i];
      if (knownEmojiPopovers.has(popover)) return popover;
      var list = popover.querySelector('ul[role="listbox"]');
      if (!list || !popover.querySelector("input")) continue;
      var row = list.querySelector('[role="option"]');
      if (row && /(^|\s):[a-z0-9_+-]+:/.test(row.textContent || "")) {
        knownEmojiPopovers.add(popover);
        return popover;
      }
    }
    return null;
  }

  function popoverQuery(popover) {
    var input = popover.querySelector("input");
    return input ? input.value : "";
  }

  function decoratePopover(popover) {
    if (!emoji.length) return;
    var list = popover.querySelector('ul[role="listbox"]');
    if (!list) return;

    var host = list.parentElement || popover;
    var section = host.querySelector(".cw-slack-rows");
    if (!section) {
      // Outside the <ul>, which Vue re-renders on every keystroke, but inside its scroll area.
      section = document.createElement("div");
      section.className = "cw-slack-rows";
      section.addEventListener("mousedown", function (e) {
        e.preventDefault();
      });
      section.addEventListener("click", function (e) {
        var row = e.target.closest("[data-emoji]");
        if (row) pick(row.getAttribute("data-emoji"), popoverQuery(popover));
      });
      host.insertBefore(section, list);
    }

    var query = popoverQuery(popover);
    if (section.dataset.query === query) return; // nothing to redraw
    section.dataset.query = query;
    var hits = search(query, MAX_IN_TYPEAHEAD);
    slackIndex = -1;
    section.innerHTML = hits.length
      ? '<div class="cw-slack-rows-title">Slack</div>' +
        hits
          .map(function (item, i) {
            return '<div class="cw-slack-row" data-emoji="' + item.name + '" data-i="' + i + '"><img src="' + item.url + '" alt="" loading="lazy"><span class="cw-slack-row-name">' + item.name + '</span><span class="cw-slack-row-code">:' + item.name + ':</span></div>';
          })
          .join("")
      : "";
    section.hidden = !hits.length;
    popover.classList.toggle("cw-slack-has-rows", hits.length > 0);
  }

  function slackRows() {
    var popover = findEmojiPopover();
    return popover ? popover.querySelectorAll(".cw-slack-row") : [];
  }

  function highlight(index) {
    var rows = slackRows();
    slackIndex = index;
    for (var i = 0; i < rows.length; i++) rows[i].classList.toggle("is-active", i === index);
    if (rows[index]) rows[index].scrollIntoView({ block: "nearest" });
    // Chatwoot keeps its own row highlighted; dim it while the Slack section has the selection.
    var popover = findEmojiPopover();
    if (popover) popover.classList.toggle("cw-slack-owns-selection", index >= 0);
  }

  function pick(name, query) {
    highlight(-1);
    insertShortcode(name, query);
    // Removing the trigger text usually closes the picker on its own; Escape covers the rest.
    if (findEmojiPopover()) closePicker();
  }

  /** Chatwoot's selected row index, from the combobox's aria-activedescendant. */
  function nativeIndex(popover) {
    var input = popover.querySelector("input");
    var active = input && input.getAttribute("aria-activedescendant");
    var row = active && popover.querySelector("#" + CSS.escape(active));
    var index = row && row.getAttribute("data-index");
    return index == null ? -1 : Number(index);
  }

  document.addEventListener(
    "keydown",
    function (e) {
      var popover = findEmojiPopover();
      if (!popover) return;
      var rows = slackRows();
      if (!rows.length) return;
      var query = popoverQuery(popover);

      if (e.key === "ArrowUp") {
        if (slackIndex > 0) {
          claim(e);
          highlight(slackIndex - 1);
        } else if (slackIndex === -1 && nativeIndex(popover) <= 0) {
          claim(e); // step off the top of Chatwoot's list into the Slack rows
          highlight(rows.length - 1);
        }
        return;
      }
      if (e.key === "ArrowDown" && slackIndex >= 0) {
        claim(e);
        if (slackIndex === rows.length - 1) highlight(-1); // hand the selection back
        else highlight(slackIndex + 1);
        return;
      }
      if ((e.key === "Enter" || e.key === "Tab") && slackIndex >= 0) {
        claim(e);
        pick(rows[slackIndex].getAttribute("data-emoji"), query);
        return;
      }
      if (e.key === "Escape" && slackIndex >= 0) highlight(-1);
    },
    true,
  );

  function claim(e) {
    e.preventDefault();
    e.stopPropagation();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
  }

  // ---------------------------------------------------------------- wiring

  document.addEventListener("input", function (e) {
    var popover = findEmojiPopover();
    if (popover && popover.contains(e.target)) decorate();
  });

  var style = document.createElement("style");
  style.textContent = [
    ".cw-slack-section{padding:0 8px 4px}",
    ".cw-slack-title,.cw-slack-rows-title{margin:4px 2px;font-size:11px;font-weight:500;letter-spacing:.04em;text-transform:uppercase;opacity:.6}",
    ".cw-slack-grid{display:grid;grid-template-columns:repeat(10,minmax(0,1fr));gap:2px;max-height:5.5rem;overflow-y:auto;scrollbar-width:none}",
    ".cw-slack-btn{display:flex;align-items:center;justify-content:center;padding:3px;border:0;background:none;border-radius:8px;cursor:pointer;aspect-ratio:1}",
    ".cw-slack-btn:hover{background:rgba(127,127,127,.18)}",
    ".cw-slack-btn img{width:20px;height:20px;object-fit:contain}",
    ".cw-slack-empty{margin:4px 2px 6px;font-size:12px;opacity:.6}",
    ".cw-slack-rows{padding:0 0 4px;border-bottom:1px solid rgba(127,127,127,.2)}",
    ".cw-slack-row{display:flex;align-items:center;gap:8px;padding:4px 8px;border-radius:8px;cursor:pointer;font-size:13px}",
    ".cw-slack-row img{width:18px;height:18px;object-fit:contain}",
    ".cw-slack-row-code{margin-inline-start:auto;opacity:.55;font-size:12px}",
    ".cw-slack-row:hover,.cw-slack-row.is-active{background:rgba(127,127,127,.22)}",
    '.cw-slack-owns-selection li[role="option"][aria-selected="true"]{background:transparent!important}',
  ].join("");
  document.head.appendChild(style);

  observer = new MutationObserver(function () {
    if (scheduled) return; // coalesce a burst of Vue patches into one pass
    scheduled = true;
    requestAnimationFrame(function () {
      scheduled = false;
      decorate();
    });
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  load();
})();
