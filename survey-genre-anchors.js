// Quick Taste Check — Genres mode anchor list.
//
// 55 tags grouped into 5 sections. Each entry pairs a canonical AniList
// tag name with a representative anime cover (via aniListCache lookup).
// Tile cover is illustrative — the disclaimer in survey.html makes
// this explicit so users don't read the cover as endorsement of the
// entire tag.
//
// Sections:
//   Demographics  (5)  — always visible
//   Genres       (14)  — always visible
//   Themes       (22)  — always visible
//   Settings      (8)  — always visible
//   Mature        (6)  — gated by surveyMatureFilter toggle
//
// Tag taps feed taste-vector via direct +0.6/-0.6 injection into
// raw[tag] (see SURVEY_TAG_WEIGHT in taste-vector.js); this bypasses
// the show-shape pipeline (no IDF / recency / drop-attribution) since
// the user is naming a tag preference directly, not a show experience.
//
// Curation policy: best-picks-with-flags. AL IDs flagged [verify-id]
// are best-guess; spot-check on next reload, fix any non-rendering
// tile by swapping its aniListId.
//
// Editorial swaps welcome — flag with [editorial-veto] in the comment
// next to the entry, change one line, redeploy.

export const SURVEY_GENRE_ANCHOR_VERSION = 2;

export const SURVEY_GENRE_ANCHORS = [
  // ── Demographics (5) ───────────────────────────────────────────
  { tag: 'Shounen',            category: 'Demographics', representativeAniListId: 21459,  displayName: 'Shounen',            mature: false },
  { tag: 'Shoujo',             category: 'Demographics', representativeAniListId: 105334, displayName: 'Shoujo',             mature: false /*Fruits Basket (2019)*/ },
  { tag: 'Seinen',             category: 'Demographics', representativeAniListId: 101348, displayName: 'Seinen',             mature: false /*Vinland Saga*/ },
  { tag: 'Josei',              category: 'Demographics', representativeAniListId: 16,     displayName: 'Josei',              mature: false /*Hachimitsu to Clover*/ },
  { tag: 'Kids',               category: 'Demographics', representativeAniListId: 527,    displayName: 'Kids',               mature: false /*Pokemon TV*/ },

  // ── Genres (14) ────────────────────────────────────────────────
  { tag: 'Action',             category: 'Genres', representativeAniListId: 101922, displayName: 'Action',             mature: false /*Demon Slayer*/ },
  { tag: 'Adventure',          category: 'Genres', representativeAniListId: 11061,  displayName: 'Adventure',          mature: false },
  { tag: 'Comedy',             category: 'Genres', representativeAniListId: 21202,  displayName: 'Comedy',             mature: false },
  { tag: 'Drama',              category: 'Genres', representativeAniListId: 9989,   displayName: 'Drama',              mature: false /*Anohana*/ },
  { tag: 'Horror',             category: 'Genres', representativeAniListId: 97986,  displayName: 'Horror',             mature: false /*Made in Abyss*/ },
  { tag: 'Mystery',            category: 'Genres', representativeAniListId: 12189,  displayName: 'Mystery',            mature: false /*Hyouka*/ },
  { tag: 'Romance',            category: 'Genres', representativeAniListId: 4224,   displayName: 'Romance',            mature: false },
  { tag: 'Sci-Fi',             category: 'Genres', representativeAniListId: 9253,   displayName: 'Sci-Fi',             mature: false },
  { tag: 'Slice of Life',      category: 'Genres', representativeAniListId: 5680,   displayName: 'Slice of Life',      mature: false },
  { tag: 'Sports',             category: 'Genres', representativeAniListId: 20464,  displayName: 'Sports',             mature: false /*Haikyuu!!*/ },
  { tag: 'Music',              category: 'Genres', representativeAniListId: 130003, displayName: 'Music',              mature: false /*Bocchi the Rock*/ },
  { tag: 'Mecha',              category: 'Genres', representativeAniListId: 1575,   displayName: 'Mecha',              mature: false },
  { tag: 'Mahou Shoujo',       category: 'Genres', representativeAniListId: 9756,   displayName: 'Mahou Shoujo',       mature: false },
  { tag: 'Supernatural',       category: 'Genres', representativeAniListId: 457,    displayName: 'Supernatural',       mature: false /*Mushishi*/ },

  // ── Themes (22) ────────────────────────────────────────────────
  { tag: 'Magic',              category: 'Themes', representativeAniListId: 154587, displayName: 'Magic',              mature: false },
  { tag: 'School',             category: 'Themes', representativeAniListId: 5680,   displayName: 'School',             mature: false /*[K-On! — duplicate of Slice of Life is fine]*/ },
  { tag: 'Revenge',            category: 'Themes', representativeAniListId: 33,     displayName: 'Revenge',            mature: false /*Berserk 1997*/ },
  { tag: 'Time Loop',          category: 'Themes', representativeAniListId: 21355,  displayName: 'Time Loop',          mature: false },
  { tag: 'Reincarnation',      category: 'Themes', representativeAniListId: 108465, displayName: 'Reincarnation',      mature: false },
  { tag: 'Found Family',       category: 'Themes', representativeAniListId: 140960, displayName: 'Found Family',       mature: false /*Spy x Family*/ },
  { tag: 'Anti-Hero',          category: 'Themes', representativeAniListId: 1535,   displayName: 'Anti-Hero',          mature: false },
  { tag: 'Tournament',         category: 'Themes', representativeAniListId: 11061,  displayName: 'Tournament',         mature: false /*HxH — duplicate of Adventure is fine*/ },
  { tag: 'Cultivation',        category: 'Themes', representativeAniListId: 101972, displayName: 'Cultivation',        mature: false /*Mo Dao Zu Shi*/ },
  { tag: 'Wuxia',              category: 'Themes', representativeAniListId: 101920, displayName: 'Wuxia',              mature: false /*Soul Land*/ },
  { tag: 'Dystopian',          category: 'Themes', representativeAniListId: 13601,  displayName: 'Dystopian',          mature: false /*Psycho-Pass*/ },
  { tag: 'Tragedy',            category: 'Themes', representativeAniListId: 4181,   displayName: 'Tragedy',            mature: false /*Clannad After Story*/ },
  { tag: 'Coming of Age',      category: 'Themes', representativeAniListId: 20954,  displayName: 'Coming of Age',      mature: false /*A Silent Voice*/ },
  { tag: 'Iyashikei',          category: 'Themes', representativeAniListId: 4081,   displayName: 'Iyashikei',          mature: false /*Natsume Yuujinchou S1*/ },
  { tag: 'Survival',           category: 'Themes', representativeAniListId: 16498,  displayName: 'Survival',           mature: false /*Attack on Titan*/ },
  { tag: 'Mind Games',         category: 'Themes', representativeAniListId: 3002,   displayName: 'Mind Games',         mature: false /*Kaiji*/ },
  { tag: 'Crime',              category: 'Themes', representativeAniListId: 21234,  displayName: 'Crime',              mature: false /*Erased*/ },
  { tag: 'Female Protagonist', category: 'Themes', representativeAniListId: 104647, displayName: 'Female Protagonist', mature: false /*Bakarina*/ },
  { tag: 'Time Manipulation',  category: 'Themes', representativeAniListId: 7785,   displayName: 'Time Manipulation',  mature: false /*Tatami Galaxy*/ },
  { tag: 'Achronological Order', category: 'Themes', representativeAniListId: 132126, displayName: 'Achronological Order', mature: false /*Sonny Boy*/ },
  { tag: 'Henshin',            category: 'Themes', representativeAniListId: 232,    displayName: 'Henshin',            mature: false /*Cardcaptor Sakura*/ },
  { tag: 'Ensemble Cast',      category: 'Themes', representativeAniListId: 1,      displayName: 'Ensemble Cast',      mature: false /*Cowboy Bebop*/ },

  // ── Settings (8) ───────────────────────────────────────────────
  { tag: 'Modern',             category: 'Settings', representativeAniListId: 21507,  displayName: 'Modern',             mature: false /*Mob Psycho 100*/ },
  { tag: 'Historical',         category: 'Settings', representativeAniListId: 101347, displayName: 'Historical',         mature: false /*Dororo*/ },
  { tag: 'Urban Fantasy',      category: 'Settings', representativeAniListId: 113415, displayName: 'Urban Fantasy',      mature: false /*JJK*/ },
  { tag: 'High Fantasy',       category: 'Settings', representativeAniListId: 154587, displayName: 'High Fantasy',       mature: false /*Frieren — duplicate w/ Magic is fine*/ },
  { tag: 'Cyberpunk',          category: 'Settings', representativeAniListId: 43,     displayName: 'Cyberpunk',          mature: false /*Ghost in the Shell (1995 movie)*/ },
  { tag: 'Post-Apocalyptic',   category: 'Settings', representativeAniListId: 47,     displayName: 'Post-Apocalyptic',   mature: false /*Akira*/ },
  { tag: 'Asian Setting',      category: 'Settings', representativeAniListId: 113260, displayName: 'Asian Setting',      mature: false /*Tian Guan Cifu — Heaven Official\'s Blessing*/ },
  { tag: 'Space',              category: 'Settings', representativeAniListId: 2001,   displayName: 'Space',              mature: false /*Gurren Lagann*/ },

  // ── Mature (6, gated by surveyMatureFilter) ────────────────────
  // Note: Hentai dropped from v1 — CR doesn't host hentai shows so
  // there's no representative cover to surface. Shotacon dropped per
  // 2026-04-26 grilling — no tame canonical exemplar exists.
  // Lewd cover preference: the user wants explicit 18+ promotional art
  // for Ecchi / Sexual Content / Nudity / Loli (not the official AL
  // covers, which are usually tame). Drop a JPG at images/covers/
  // matching the localCoverPath; the render layer prefers it over the
  // AL bridge cache. Until the local file is dropped, the AL cover
  // (now correctly resolving to the show with the right ID) renders
  // as fallback.
  { tag: 'Ecchi',              category: 'Mature', representativeAniListId: 132405, displayName: 'Ecchi',              mature: true, localCoverPath: 'images/covers/mature-ecchi.jpg' /*Dress Up Darling — Marin Kitagawa cover*/ },
  // 'Sexual Content' tile removed 2026-04-30: AniList exposes 'Sexual
  // Content' as a CATEGORY (parent of tags like Sex, Nudity, Sexual
  // Abuse, Fanservice), not a tag itself. The tile silently produced
  // a tap-vector entry on a tag name no AniList show actually carries
  // — neither the override nor the seed CTA could ever surface
  // anything. Users wanting that surface should tap Nudity / Ecchi
  // (which DO match real AniList tags). If we want a "Sexual Content"
  // surface in the future, it needs to remap to one or more child
  // tags at survey-fold time.
  { tag: 'Nudity',             category: 'Mature', representativeAniListId: 11617,  displayName: 'Nudity',             mature: true, localCoverPath: 'images/covers/mature-nudity.jpg' /*High School DxD — DxD S1 cover art*/ },
  { tag: 'Loli',               category: 'Mature', representativeAniListId: 7627,   displayName: 'Loli',               mature: true, localCoverPath: 'images/covers/mature-loli.jpg' /*Mitsudomoe — disclaimer applies; cover illustrative only*/ },
  { tag: 'Gore',               category: 'Mature', representativeAniListId: 20605,  displayName: 'Gore',               mature: true /*Tokyo Ghoul — official AL cover is fine*/ },
  { tag: 'Body Horror',        category: 'Mature', representativeAniListId: 127230, displayName: 'Body Horror',        mature: true /*Chainsaw Man — body horror is core conceit*/ },
];

// Section render order. Mature is conditionally appended only when
// the toggle is on; the four always-visible sections render first.
export const GENRE_SECTION_ORDER = ['Demographics', 'Genres', 'Themes', 'Settings', 'Mature'];

export const GENRE_SECTION_LABEL_BY_ID = {
  'Demographics': 'Demographics',
  'Genres':       'Genres',
  'Themes':       'Themes',
  'Settings':     'Settings',
  'Mature':       'Mature',
};
