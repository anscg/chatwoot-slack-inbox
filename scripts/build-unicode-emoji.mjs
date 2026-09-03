/**
 * Regenerates public/unicode-emoji.json, the standard emoji the dashboard script needs so
 * its picker can replace Chatwoot's own instead of sitting next to it.
 *
 * The set is Chatwoot's (MIT), so the glyphs and search terms an agent sees are exactly the
 * ones Chatwoot would have shown. Run it when bumping the Chatwoot version you target:
 *   node scripts/build-unicode-emoji.mjs [chatwoot-tag]
 */
import { writeFileSync } from "node:fs";

const tag = process.argv[2] ?? "v4.17.1";
const source = `https://raw.githubusercontent.com/chatwoot/chatwoot/${tag}/app/javascript/shared/components/emoji/emojisGroup.json`;

const groups = await fetch(source).then((res) => {
  if (!res.ok) throw new Error(`${source}: HTTP ${res.status}`);
  return res.json();
});

const out = {
  _source: `${source} (Chatwoot, MIT)`,
  groups: groups.map((group) => group.name),
  // [glyph, name, slug, group index] — slug carries Chatwoot's search synonyms.
  emoji: groups.flatMap((group, index) => group.emojis.map((e) => [e.emoji, e.name, e.slug, index])),
};

const path = new URL("../public/unicode-emoji.json", import.meta.url).pathname;
writeFileSync(path, JSON.stringify(out));
console.log(`${out.emoji.length} emoji in ${out.groups.length} groups -> ${path}`);
