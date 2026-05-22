// Friendly-voice phrase map for AniList tags. Phase A of the
// phrase-generation layer (see phrase-engine.js for the composition
// logic). Each entry maps a canonical AniList tag name → an
// editorial phrase keyed by sign:
//
//   { pos: 'positive-frame phrase', neg?: 'negative-frame phrase' }
//
// `pos` is the chip text when the tag fires with positive userWeight
// (taste alignment). `neg` is the chip text when it fires negatively
// (taste mismatch); if absent, the renderer falls back to `pos` and
// signs it via chip color/prefix only.
//
// Voice: anime-savvy, concise (2–4 words), evocative but not memey.
// Industry terms (shōnen, isekai, ufotable, Madhouse) used naturally;
// editorial framing on culturally-loaded tags. NOT meme-y — no
// "Powers go brrrr", no "Truck-kun delivery". Aim for the register
// of the onboarding tour mock chips: "Slice-of-life fantasy",
// "Reflective tone", "Power-up formula".
//
// `neg` coverage is sparse — only tags that fire with culturally
// distinct positive vs. negative framings need both. Most tags are
// either consistently positive (Found Family, Coming of Age) or
// consistently negative (Fanservice, Filler) — those fall back to
// `pos` with a sign-via-color signal.
//
// Coverage strategy (Q5 of design grilling): top ~80 tags from
// the user's chip-frequency distribution + ~30–40 universal-common
// tags absent from his profile (Sports, Mecha, Tournament, Harem,
// idol/sport-specific clusters, etc.). Total ~140 entries.
//
// AUTHORING NOTES:
//   - Keys MUST be the canonical AniList tag name (case-sensitive).
//     Mismatches won't fire. Verify against AniList API tag list
//     when adding entries.
//   - No duplicate keys. JS object literals silently overwrite;
//     duplicates were a hand-merge hazard in earlier drafts.
//   - Phrases land at ~12px font in the chip; aim for ≤4 words.
//   - Hyphenate compound modifiers ("Slow-burn", "Slice-of-life")
//     to read as a single editorial unit, not two adjectives.

(function () {
  'use strict';

  const PHRASE_MAP = Object.freeze({
    // ── Core genres (also fire as tags) ─────────────────────────
    'Action':                  { pos: 'Action-driven' },
    'Adventure':               { pos: 'Adventure scope' },
    'Comedy':                  { pos: 'Comedy beats' },
    'Drama':                   { pos: 'Dramatic core' },
    'Romance':                 { pos: 'Romance threads' },
    'Sci-Fi':                  { pos: 'Sci-fi premise' },
    'Slice of Life':           { pos: 'Slice-of-life pacing' },
    'Mystery':                 { pos: 'Mystery hooks' },
    'Supernatural':            { pos: 'Supernatural beats' },
    'Thriller':                { pos: 'Thriller pacing',     neg: 'Heavy tension' },
    'Horror':                  { pos: 'Horror atmosphere',   neg: 'Horror atmosphere' },
    'Sports':                  { pos: 'Sports drama' },
    'Mecha':                   { pos: 'Mecha pilots' },
    'Music':                   { pos: 'Music-forward' },
    'Psychological':           { pos: 'Psychological weight' },
    'Ecchi':                   { pos: 'Fanservice-forward', neg: 'Heavy fanservice' },
    'Fantasy':                 { pos: 'Fantasy worldbuilding' },
    'Mahou Shoujo':            { pos: 'Magical-girl beats' },
    'Hentai':                  { pos: 'Adult-explicit',     neg: 'Adult-explicit' },

    // ── Demographic / publication category ──────────────────────
    'Shounen':                 { pos: 'Shōnen energy',      neg: 'Shōnen formula fatigue' },
    'Shoujo':                  { pos: 'Shoujo heart',       neg: 'Shoujo conventions' },
    'Seinen':                  { pos: 'Seinen weight' },
    'Josei':                   { pos: 'Josei adulting' },

    // ── Setting / era ───────────────────────────────────────────
    'School':                  { pos: 'School setting' },
    'High School':             { pos: 'High-school setting', neg: 'Yet another high school' },
    'Middle School':           { pos: 'Middle-school setting' },
    'University':              { pos: 'College-age cast' },
    'Workplace':               { pos: 'Workplace drama' },
    'Historical':              { pos: 'Period setting' },
    'Modern':                  { pos: 'Modern-day setting' },
    'Urban':                   { pos: 'City-life backdrop' },
    'Rural':                   { pos: 'Countryside frame' },
    'Post-Apocalyptic':        { pos: 'Post-apocalypse' },
    'Dystopian':               { pos: 'Dystopian frame' },
    'Cyberpunk':               { pos: 'Cyberpunk grit' },
    'Steampunk':               { pos: 'Steampunk gears' },
    'Other World':             { pos: 'Otherworld setting' },
    'Space':                   { pos: 'Space-faring' },
    'Underground':             { pos: 'Subterranean setting' },
    'Edo Period':              { pos: 'Edo-era Japan' },
    'Feudal':                  { pos: 'Feudal-era setting' },
    'Japan':                   { pos: 'Japan-set' },
    'China':                   { pos: 'Chinese setting' },
    'Korea':                   { pos: 'Korean setting' },
    'Europe':                  { pos: 'European setting' },

    // ── Themes / tropes ─────────────────────────────────────────
    'Magic':                   { pos: 'Spellcasting' },
    'Magic School':            { pos: 'Magic-academy' },
    'Isekai':                  { pos: 'Isekai premise',     neg: 'Isekai setup' },
    'Reincarnation':           { pos: 'Reincarnation arc',  neg: 'Reincarnation isekai' },
    'Time Travel':             { pos: 'Time-travel hook' },
    'Time Loop':               { pos: 'Time-loop puzzle' },
    'Time Skip':               { pos: 'Major time skip' },
    'Survival':                { pos: 'Survival stakes' },
    'War':                     { pos: 'Wartime stakes' },
    'Politics':                { pos: 'Throne-room scheming' },
    'Conspiracy':              { pos: 'Conspiracy threads' },
    'Espionage':               { pos: 'Spycraft' },
    'Detective':               { pos: 'Whodunit' },
    'Crime':                   { pos: 'Crime drama' },
    'Tragedy':                 { pos: 'Tragic stakes' },
    'Coming of Age':           { pos: 'Coming-of-age' },
    'Found Family':            { pos: 'Found-family beats' },
    'Friendship':              { pos: 'Friendship at the core' },
    'Love Triangle':           { pos: 'Love-triangle drama', neg: 'Love-triangle drag' },
    'Identity':                { pos: 'Identity questions' },
    'Memory':                  { pos: 'Memory motif' },
    'Loss':                    { pos: 'Grief and loss' },
    'Death':                   { pos: 'Mortality stakes' },
    'Loneliness':              { pos: 'Solitary lens' },
    'Mental Health':           { pos: 'Mental-health threads' },
    'Revenge':                 { pos: 'Revenge plot' },
    'Memoir':                  { pos: 'Memoir frame' },
    'Otaku Culture':           { pos: 'Otaku-culture lens' },

    // ── Combat / action specifics ───────────────────────────────
    'Battle':                  { pos: 'Battle-heavy' },
    'Combat':                  { pos: 'Combat-driven' },
    'Martial Arts':            { pos: 'Martial-arts choreography' },
    'Swordplay':               { pos: 'Steel-on-steel' },
    'Gunfights':               { pos: 'Gunplay choreography' },
    'Tournament':              { pos: 'Tournament arcs',    neg: 'Tournament-arc grind' },
    'Tournament Arc':          { pos: 'Tournament arcs',    neg: 'Tournament-arc grind' },
    // 'Super Power' is AniList's catch-all for both supernatural-power
    // shows AND highly-skilled-human shows (assassins, hitmen, sport
    // prodigies). Without a co-tag gate the chip "Powered protagonists"
    // fires on Marriagetoxin (poison master), Inuyashiki (cybernetic),
    // and similar non-powered protagonists. Gated to require at least
    // one tag that confirms an actual super-natural power source.
    'Super Power':             { pos: 'Powered protagonists', neg: 'Power-fantasy lead', requireAny: ['Magic', 'Supernatural', 'Mutation', 'Henshin', 'Espers', 'Mahou Shoujo', 'Sci-Fi', 'Cyborg'] },
    'Power-Up':                { pos: 'Escalating powers',  neg: 'Power-up formula' },
    'Henshin':                 { pos: 'Transformation sequences' },
    'Crossdressing':           { pos: 'Gender play' },
    'Gender Bender':           { pos: 'Gender-swap setup' },
    'Battle Royale':           { pos: 'Battle-royale stakes' },
    'Death Game':              { pos: 'Death-game stakes' },

    // ── Creatures / fantasy beings ──────────────────────────────
    'Demons':                  { pos: 'Demonic foes' },
    'Vampires':                { pos: 'Vampire mythos' },
    'Ghost':                   { pos: 'Ghost stories' },
    'Monsters':                { pos: 'Monster-of-the-week' },
    'Aliens':                  { pos: 'First-contact' },
    'Robots':                  { pos: 'Robot cast' },
    'Espers':                  { pos: 'Esper powers' },
    'Yokai':                   { pos: 'Yokai folklore' },
    'Dragons':                 { pos: 'Dragon lore' },
    'Mythology':               { pos: 'Mythic frame' },

    // ── Romance / character-relationship tropes ─────────────────
    'Harem':                   { pos: 'Harem dynamics',     neg: 'Harem dynamics' },
    'Reverse Harem':           { pos: 'Reverse-harem cast', neg: 'Reverse-harem dynamics' },
    'Tsundere':                { pos: 'Tsundere lead' },
    'Yandere':                 { pos: 'Yandere streak' },
    'Kuudere':                 { pos: 'Kuudere lead' },
    'Childhood Friends':       { pos: 'Childhood-friend romance' },
    'Marriage':                { pos: 'Marriage stakes' },
    'Office Lady':             { pos: 'OL adulting' },
    'Boys\' Love':             { pos: 'BL romance' },
    'Yuri':                    { pos: 'Yuri romance' },
    'Yaoi':                    { pos: 'Yaoi romance' },
    'Shounen Ai':              { pos: 'Soft-BL beats' },
    'Shoujo Ai':               { pos: 'Soft-yuri beats' },

    // ── Tone / mood ─────────────────────────────────────────────
    'Bittersweet':             { pos: 'Bittersweet pacing' },
    'Melancholy':              { pos: 'Melancholic lens' },
    'Philosophical':           { pos: 'Philosophical bent' },
    'Reflective':              { pos: 'Reflective tone' },
    'Wholesome':               { pos: 'Wholesome warmth' },
    'Gritty':                  { pos: 'Gritty edge' },
    'Dark':                    { pos: 'Dark tone' },
    'Lighthearted':            { pos: 'Lighthearted' },
    'Atmospheric':             { pos: 'Atmospheric pacing' },
    'Surreal':                 { pos: 'Surreal lens' },
    'Slow Pacing':             { pos: 'Slow-burn pacing',   neg: 'Glacial pacing' },
    'Fast-Paced':              { pos: 'Tight pacing' },
    'Iyashikei':               { pos: 'Iyashikei calm' },

    // ── Production / craft ──────────────────────────────────────
    'Stunning Visuals':        { pos: 'Stunning visuals' },
    'Cinematic':               { pos: 'Cinematic craft' },
    'Distinct Art Style':      { pos: 'Distinct art style' },
    'Beautiful Art':           { pos: 'Lush art' },
    'CGI':                     { pos: 'CGI-forward',        neg: 'Heavy CGI' },
    'Stop Motion':             { pos: 'Stop-motion' },
    'Hand Drawn':              { pos: 'Traditional animation' },

    // ── Comedy specifics ────────────────────────────────────────
    'Slapstick':               { pos: 'Slapstick comedy',   neg: 'Broad slapstick' },
    'Parody':                  { pos: 'Parody humor',       neg: 'Parody humor' },
    'Satire':                  { pos: 'Satirical bent' },
    'Dark Comedy':             { pos: 'Dark comedy' },

    // ── Specific show shapes ────────────────────────────────────
    'Anthology':               { pos: 'Anthology format' },
    'Episodic':                { pos: 'Episodic structure', neg: 'Episodic drag' },
    'Non-Linear':              { pos: 'Non-linear plotting' },
    'Slow Burn':               { pos: 'Slow-burn',          neg: 'Glacial buildup' },
    'Filler':                  { pos: 'Some filler',        neg: 'Heavy filler' },

    // ── Premise / hook tags ─────────────────────────────────────
    'Cooking':                 { pos: 'Foodie focus' },
    'Idol':                    { pos: 'Idol scene' },
    'Maid':                    { pos: 'Maid trope' },
    'Cute Girls Doing Cute Things': { pos: 'CGDCT vibes' },
    'Cute Boys Doing Cute Things':  { pos: 'CBDCT vibes' },

    // ── Sports specifics ────────────────────────────────────────
    'Boxing':                  { pos: 'Boxing focus' },
    'Baseball':                { pos: 'Baseball focus' },
    'Basketball':              { pos: 'Basketball focus' },
    'Volleyball':              { pos: 'Volleyball focus' },
    'Soccer':                  { pos: 'Soccer focus' },
    'Tennis':                  { pos: 'Tennis focus' },
    'Swimming':                { pos: 'Swimming focus' },
    'Racing':                  { pos: 'Racing-driven' },
    'Cycling':                 { pos: 'Cycling focus' },
    'Card Game':               { pos: 'Card-game stakes' },
    'Mahjong':                 { pos: 'Mahjong drama' },
    'Shogi':                   { pos: 'Shogi drama' },
    'Go':                      { pos: 'Go-game tension' },

    // ── Negatives / dealbreakers ────────────────────────────────
    // Tags that almost always fire negatively. neg is set even when
    // pos exists, because positive framing is rare and contextual.
    'Gore':                    { pos: 'Visceral combat',    neg: 'Graphic violence' },
    'Body Horror':             { pos: 'Body-horror imagery', neg: 'Body horror' },
    'Fanservice':              { pos: 'Fanservice-forward', neg: 'Heavy fanservice' },
    'Loli':                    { pos: 'Loli-coded cast',    neg: 'Loli content' },
    'Shota':                   { pos: 'Shota-coded cast',   neg: 'Shota content' },
    'Nudity':                  { pos: 'Nudity-forward',     neg: 'Nudity-forward' },
    'Sexual Abuse':            { pos: 'Heavy themes',       neg: 'Sexual-abuse content' },
    'Drugs':                   { pos: 'Drug culture',       neg: 'Drug content' },
    'Suicide':                 { pos: 'Suicide themes',     neg: 'Suicide content' },
    'Bullying':                { pos: 'Bullying themes',    neg: 'Bullying content' },
  });

  if (typeof window !== 'undefined') window.crsmartPhraseMap = PHRASE_MAP;
  if (typeof globalThis !== 'undefined') globalThis.crsmartPhraseMap = PHRASE_MAP;
})();
