// Quick Taste Check — curated anchor list.
//
// 265 anime, 12+ non-mature per archetype × 18 archetypes. Auteur
// runs deepest (~29 entries) since Studio Ghibli, Shinkai, Hosoda,
// Yuasa, Ponoc, Trigger, and the Netflix-original films all live
// there. Every AL ID was verified against the live AniList GraphQL
// API — search results matched titles, then individual IDs were
// spot-checked against the franchise root.
//
// Each entry carries:
//   aniListId      — primary key for AL lookup + cache reference
//   archetypeId    — which of the 18 archetypes this anchor represents
//   displayName    — fallback label if AL data hasn't landed yet
//   tier           — 1 (most-mainstream pick) → higher = deeper cut
//   mature         — true: hidden unless surveyMatureFilter is on
//   services       — array of streaming service ids (US availability,
//                    best-effort as of 2026-04). Primary host first.
//                    See STREAMING_SERVICES below for valid ids.
//
// Tier semantics:
//   Mainstream view = tier 1–5 (top 5 popular per archetype = 90 tiles)
//   All view        = all tiers (12+ per archetype, full horizontal scroll)
//   Deep Cuts view  = tier 9+ (bottom ~1/3 per archetype, ~120 tiles)
//   Tiers 6–8 are mid-tier and exclusive to the All view.
//
// Top-5 mainstream curation: tiers 1–5 are intentionally the actually-
// recognizable picks within each archetype. Naruto / One Piece /
// Demon Slayer beat HxH / Bleach for shounen mainstream. Spirited
// Away / Your Name beat Sonny Boy / Tatami Galaxy for auteur (the
// niche-but-loved picks stay in the list, just lower tiered). 2026-04
// rebalance — see commit history for prior orderings.
//
// Mature-gated entries don't count toward the 12-tile non-mature
// minimum; archetypes with mature entries carry extra non-mature tiles
// to guarantee ≥12 visible with the mature toggle off.
//
// Service-tag policy: tag the primary streaming home + up to 2 other
// notable services. Funimation merged into Crunchyroll; HiDive out of
// scope. Tags can be wrong/stale — easy to fix per entry, no schema
// change needed.

export const SURVEY_ANCHOR_VERSION = 11;

export const SURVEY_ANCHORS = [
  // ── Mainstream Shounen (14) ────────────────────────────────────
  { aniListId: 21459,  archetypeId: 'mainstream-shounen', displayName: 'My Hero Academia',                        tier: 1,  services: ['crunchyroll', 'hulu'] },
  { aniListId: 113415, archetypeId: 'mainstream-shounen', displayName: 'JUJUTSU KAISEN',                          tier: 2,  services: ['crunchyroll'] },
  { aniListId: 11061,  archetypeId: 'mainstream-shounen', displayName: 'Hunter x Hunter (2011)',                  tier: 6,  services: ['crunchyroll', 'netflix'] },
  { aniListId: 101922, archetypeId: 'mainstream-shounen', displayName: 'Demon Slayer',                            tier: 4,  services: ['crunchyroll', 'netflix', 'hulu'] },
  { aniListId: 116674, archetypeId: 'mainstream-shounen', displayName: 'Bleach: Thousand-Year Blood War',         tier: 7,  services: ['hulu', 'disney'] },
  { aniListId: 20,     archetypeId: 'mainstream-shounen', displayName: 'Naruto',                                  tier: 3,  services: ['crunchyroll', 'hulu', 'netflix'] },
  { aniListId: 21,     archetypeId: 'mainstream-shounen', displayName: 'One Piece',                               tier: 5,  services: ['crunchyroll', 'netflix'] },
  { aniListId: 813,    archetypeId: 'mainstream-shounen', displayName: 'Dragon Ball Z',                           tier: 8,  services: ['crunchyroll'] },
  { aniListId: 140960, archetypeId: 'mainstream-shounen', displayName: 'SPY x FAMILY',                            tier: 9,  services: ['crunchyroll', 'hulu'] },
  { aniListId: 105333, archetypeId: 'mainstream-shounen', displayName: 'Dr. STONE',                               tier: 10, services: ['crunchyroll'] },
  { aniListId: 392,    archetypeId: 'mainstream-shounen', displayName: 'Yu Yu Hakusho',                           tier: 11, services: ['crunchyroll', 'hulu'] },
  { aniListId: 105310, archetypeId: 'mainstream-shounen', displayName: 'Fire Force',                              tier: 12, services: ['crunchyroll', 'hulu'] },
  { aniListId: 120120, archetypeId: 'mainstream-shounen', displayName: 'Tokyo Revengers',                         tier: 13, services: ['crunchyroll', 'disney', 'hulu'] },
  { aniListId: 119683, archetypeId: 'mainstream-shounen', displayName: 'EDENS ZERO',                              tier: 14, services: ['crunchyroll', 'netflix'] },

  // ── Magic-Academy (17) ─────────────────────────────────────────
  { aniListId: 154587, archetypeId: 'magic-academy', displayName: 'Frieren: Beyond Journey\'s End',               tier: 1,  services: ['crunchyroll'] },
  { aniListId: 97940,  archetypeId: 'magic-academy', displayName: 'Black Clover',                                 tier: 2,  services: ['crunchyroll', 'hulu'] },
  { aniListId: 21858,  archetypeId: 'magic-academy', displayName: 'Little Witch Academia (TV)',                  tier: 3,  services: ['netflix'] },
  { aniListId: 6702,   archetypeId: 'magic-academy', displayName: 'Fairy Tail',                                   tier: 4,  services: ['crunchyroll', 'hulu'] },
  { aniListId: 98436,  archetypeId: 'magic-academy', displayName: 'The Ancient Magus\' Bride',                   tier: 5,  services: ['crunchyroll'] },
  { aniListId: 20458,  archetypeId: 'magic-academy', displayName: 'The Irregular at Magic High School',          tier: 6,  services: ['crunchyroll'] },
  { aniListId: 151801, archetypeId: 'magic-academy', displayName: 'Mashle: Magic and Muscles',                   tier: 7,  services: ['crunchyroll'] },
  { aniListId: 14513,  archetypeId: 'magic-academy', displayName: 'Magi: The Labyrinth of Magic',                tier: 8,  services: ['crunchyroll'] },
  { aniListId: 112609, archetypeId: 'magic-academy', displayName: 'Wandering Witch: The Journey of Elaina',      tier: 9,  services: ['crunchyroll'] },
  { aniListId: 112301, archetypeId: 'magic-academy', displayName: 'The Misfit of Demon King Academy',            tier: 10, services: ['crunchyroll'] },
  { aniListId: 534,    archetypeId: 'magic-academy', displayName: 'Slayers',                                      tier: 11, services: ['crunchyroll'] },
  { aniListId: 20829,  archetypeId: 'magic-academy', displayName: 'Seraph of the End',                            tier: 12, services: ['crunchyroll', 'hulu'] },
  { aniListId: 431,    archetypeId: 'magic-academy', displayName: 'Howl\'s Moving Castle',                        tier: 13, services: ['max'] },
  { aniListId: 512,    archetypeId: 'magic-academy', displayName: 'Kiki\'s Delivery Service',                     tier: 14, services: ['max'] },
  { aniListId: 140291, archetypeId: 'magic-academy', displayName: 'Disney Twisted-Wonderland',                    tier: 15, services: ['disney'] },
  { aniListId: 97981,  archetypeId: 'magic-academy', displayName: 'Mary and the Witch\'s Flower',                 tier: 16, services: ['prime'] },
  { aniListId: 142598, archetypeId: 'magic-academy', displayName: 'Reign of the Seven Spellblades',               tier: 17, services: ['disney', 'hulu'] },

  // ── Comfort/Junk Isekai (13: 12 nm + 1 m) ──────────────────────
  { aniListId: 21202,  archetypeId: 'comfort-isekai', displayName: 'KONOSUBA',                                    tier: 1,  services: ['crunchyroll'] },
  { aniListId: 101280, archetypeId: 'comfort-isekai', displayName: 'That Time I Got Reincarnated as a Slime',    tier: 2,  services: ['crunchyroll', 'hulu'] },
  { aniListId: 106479, archetypeId: 'comfort-isekai', displayName: 'BOFURI',                                     tier: 6,  services: ['crunchyroll'] },
  { aniListId: 20832,  archetypeId: 'comfort-isekai', displayName: 'Overlord',                                   tier: 4,  services: ['crunchyroll'] },
  { aniListId: 99263,  archetypeId: 'comfort-isekai', displayName: 'The Rising of the Shield Hero',              tier: 5,  services: ['crunchyroll'] },
  { aniListId: 19815,  archetypeId: 'comfort-isekai', displayName: 'No Game No Life',                            tier: 3,  services: ['crunchyroll', 'hulu'] },
  { aniListId: 101004, archetypeId: 'comfort-isekai', displayName: 'How NOT to Summon a Demon Lord',             tier: 7,  services: ['crunchyroll'], mature: true },
  { aniListId: 105156, archetypeId: 'comfort-isekai', displayName: 'Cautious Hero',                              tier: 8,  services: ['crunchyroll'] },
  { aniListId: 98491,  archetypeId: 'comfort-isekai', displayName: 'In Another World With My Smartphone',        tier: 9,  services: ['crunchyroll'] },
  { aniListId: 15809,  archetypeId: 'comfort-isekai', displayName: 'The Devil is a Part-Timer!',                 tier: 10, services: ['crunchyroll'] },
  { aniListId: 103632, archetypeId: 'comfort-isekai', displayName: 'So I\'m a Spider, So What?',                 tier: 11, services: ['crunchyroll'] },
  { aniListId: 139587, archetypeId: 'comfort-isekai', displayName: 'Reincarnated as a Sword',                    tier: 12, services: ['crunchyroll'] },
  { aniListId: 112608, archetypeId: 'comfort-isekai', displayName: 'I\'ve Been Killing Slimes for 300 Years',    tier: 13, services: ['crunchyroll'] },

  // ── Serious-Craft Isekai (13) ──────────────────────────────────
  { aniListId: 21355,  archetypeId: 'serious-isekai', displayName: 'Re:ZERO -Starting Life in Another World-',   tier: 1,  services: ['crunchyroll'] },
  { aniListId: 108465, archetypeId: 'serious-isekai', displayName: 'Mushoku Tensei: Jobless Reincarnation',       tier: 2,  services: ['crunchyroll'] },
  { aniListId: 21613,  archetypeId: 'serious-isekai', displayName: 'The Saga of Tanya the Evil',                  tier: 3,  services: ['crunchyroll'] },
  { aniListId: 17265,  archetypeId: 'serious-isekai', displayName: 'Log Horizon',                                 tier: 4,  services: ['crunchyroll'] },
  { aniListId: 11757,  archetypeId: 'serious-isekai', displayName: 'Sword Art Online',                            tier: 5,  services: ['crunchyroll', 'hulu'] },
  { aniListId: 153,    archetypeId: 'serious-isekai', displayName: 'The Twelve Kingdoms',                         tier: 6,  services: ['crunchyroll'] },
  { aniListId: 20994,  archetypeId: 'serious-isekai', displayName: 'GATE',                                        tier: 7,  services: ['crunchyroll'] },
  { aniListId: 21428,  archetypeId: 'serious-isekai', displayName: 'Grimgar of Fantasy and Ash',                  tier: 8,  services: ['crunchyroll'] },
  { aniListId: 21123,  archetypeId: 'serious-isekai', displayName: 'DRIFTERS',                                    tier: 9,  services: ['crunchyroll'] },
  { aniListId: 132473, archetypeId: 'serious-isekai', displayName: 'The Faraway Paladin',                         tier: 10, services: ['crunchyroll'] },
  { aniListId: 125206, archetypeId: 'serious-isekai', displayName: 'TSUKIMICHI -Moonlit Fantasy-',                tier: 11, services: ['crunchyroll'] },
  { aniListId: 126213, archetypeId: 'serious-isekai', displayName: 'Banished from the Hero\'s Party',             tier: 12, services: ['crunchyroll'] },
  { aniListId: 97980,  archetypeId: 'serious-isekai', displayName: 'Re:CREATORS',                                 tier: 13, services: ['prime', 'crunchyroll'] },

  // ── Romance-Open (15) ──────────────────────────────────────────
  { aniListId: 4224,   archetypeId: 'romance-open', displayName: 'Toradora!',                                     tier: 1,  services: ['crunchyroll', 'netflix'] },
  { aniListId: 101921, archetypeId: 'romance-open', displayName: 'Kaguya-sama: Love is War',                      tier: 2,  services: ['crunchyroll'] },
  { aniListId: 98202,  archetypeId: 'romance-open', displayName: 'Tsuki ga Kirei',                                tier: 7,  services: ['crunchyroll'] },
  { aniListId: 132405, archetypeId: 'romance-open', displayName: 'My Dress-Up Darling',                           tier: 4,  services: ['crunchyroll'] },
  { aniListId: 14813,  archetypeId: 'romance-open', displayName: 'My Teen Romantic Comedy SNAFU',                 tier: 5,  services: ['crunchyroll'] },
  { aniListId: 2167,   archetypeId: 'romance-open', displayName: 'Clannad',                                       tier: 6,  services: ['crunchyroll'] },
  { aniListId: 20665,  archetypeId: 'romance-open', displayName: 'Your Lie in April',                             tier: 3,  services: ['crunchyroll', 'netflix'] },
  { aniListId: 99578,  archetypeId: 'romance-open', displayName: 'Wotakoi: Love is Hard for Otaku',               tier: 8,  services: ['prime'] },
  { aniListId: 124080, archetypeId: 'romance-open', displayName: 'Horimiya',                                      tier: 9,  services: ['crunchyroll'] },
  { aniListId: 103572, archetypeId: 'romance-open', displayName: 'The Quintessential Quintuplets',                tier: 10, services: ['crunchyroll'] },
  { aniListId: 101291, archetypeId: 'romance-open', displayName: 'Rascal Does Not Dream of Bunny Girl Senpai',    tier: 11, services: ['crunchyroll'] },
  { aniListId: 105334, archetypeId: 'romance-open', displayName: 'Fruits Basket (2019)',                          tier: 12, services: ['crunchyroll', 'hulu'] },
  { aniListId: 153930, archetypeId: 'romance-open', displayName: 'Romantic Killer',                               tier: 13, services: ['netflix'] },
  { aniListId: 1689,   archetypeId: 'romance-open', displayName: '5 Centimeters per Second',                      tier: 14, services: ['crunchyroll'] },
  { aniListId: 16782,  archetypeId: 'romance-open', displayName: 'The Garden of Words',                           tier: 15, services: ['crunchyroll'] },

  // ── Otome/Villainess (12) ──────────────────────────────────────
  { aniListId: 104647, archetypeId: 'otome-villainess', displayName: 'My Next Life as a Villainess',              tier: 1,  services: ['crunchyroll'] },
  { aniListId: 168374, archetypeId: 'otome-villainess', displayName: '7th Time Loop',                             tier: 2,  services: ['crunchyroll'] },
  { aniListId: 144533, archetypeId: 'otome-villainess', displayName: 'Bibliophile Princess',                      tier: 9,  services: ['crunchyroll'] },
  { aniListId: 108268, archetypeId: 'otome-villainess', displayName: 'Ascendance of a Bookworm',                  tier: 4,  services: ['crunchyroll'] },
  { aniListId: 123802, archetypeId: 'otome-villainess', displayName: 'The Saint\'s Magic Power is Omnipotent',    tier: 6,  services: ['crunchyroll'] },
  { aniListId: 130298, archetypeId: 'otome-villainess', displayName: 'The Eminence in Shadow',                    tier: 5,  services: ['crunchyroll'] },
  { aniListId: 139820, archetypeId: 'otome-villainess', displayName: 'I\'m the Villainess, Taming the Final Boss', tier: 7,  services: ['crunchyroll'] },
  { aniListId: 21058,  archetypeId: 'otome-villainess', displayName: 'Snow White with the Red Hair',              tier: 8,  services: ['crunchyroll'] },
  { aniListId: 161645, archetypeId: 'otome-villainess', displayName: 'The Apothecary Diaries',                    tier: 3,  services: ['crunchyroll'] },
  { aniListId: 142074, archetypeId: 'otome-villainess', displayName: 'Trapped in a Dating Sim',                   tier: 10, services: ['crunchyroll'] },
  { aniListId: 153629, archetypeId: 'otome-villainess', displayName: 'The Magical Revolution of the Reincarnated Princess', tier: 11, services: ['crunchyroll'] },
  { aniListId: 166794, archetypeId: 'otome-villainess', displayName: 'A Sign of Affection',                       tier: 12, services: ['crunchyroll'] },

  // ── Auteur Curiosity (29) ──────────────────────────────────────
  { aniListId: 21507,  archetypeId: 'auteur', displayName: 'Mob Psycho 100',                                      tier: 1,  services: ['crunchyroll', 'netflix'] },
  { aniListId: 132126, archetypeId: 'auteur', displayName: 'Sonny Boy',                                           tier: 13, services: ['crunchyroll'] },
  { aniListId: 7785,   archetypeId: 'auteur', displayName: 'The Tatami Galaxy',                                   tier: 19, services: ['crunchyroll'] },
  { aniListId: 20607,  archetypeId: 'auteur', displayName: 'Ping Pong the Animation',                             tier: 9,  services: ['crunchyroll'] },
  { aniListId: 323,    archetypeId: 'auteur', displayName: 'Paranoia Agent',                                      tier: 14, services: ['crunchyroll'] },
  { aniListId: 440,    archetypeId: 'auteur', displayName: 'Revolutionary Girl Utena',                            tier: 6,  services: ['crunchyroll'] },
  { aniListId: 98460,  archetypeId: 'auteur', displayName: 'Devilman Crybaby',                                    tier: 7,  services: ['netflix'] },
  { aniListId: 99088,  archetypeId: 'auteur', displayName: 'Pluto',                                               tier: 8,  services: ['netflix'] },
  { aniListId: 47,     archetypeId: 'auteur', displayName: 'Akira',                                               tier: 4,  services: ['crunchyroll', 'hulu'] },
  { aniListId: 437,    archetypeId: 'auteur', displayName: 'Perfect Blue',                                        tier: 10, services: ['hulu'] },
  { aniListId: 227,    archetypeId: 'auteur', displayName: 'FLCL',                                                tier: 11, services: ['crunchyroll', 'hulu'] },
  { aniListId: 101571, archetypeId: 'auteur', displayName: 'Aggretsuko',                                          tier: 12, services: ['netflix'] },
  { aniListId: 199,    archetypeId: 'auteur', displayName: 'Spirited Away',                                       tier: 2,  services: ['max'] },
  { aniListId: 164,    archetypeId: 'auteur', displayName: 'Princess Mononoke',                                   tier: 5,  services: ['max'] },
  { aniListId: 513,    archetypeId: 'auteur', displayName: 'Castle in the Sky',                                   tier: 15, services: ['max'] },
  { aniListId: 137819, archetypeId: 'auteur', displayName: 'The Tatami Time Machine Blues',                       tier: 16, services: ['disney', 'hulu'] },
  { aniListId: 127271, archetypeId: 'auteur', displayName: 'BELLE',                                               tier: 17, services: ['hulu', 'max'] },
  { aniListId: 110354, archetypeId: 'auteur', displayName: 'BNA: Brand New Animal',                               tier: 18, services: ['netflix'] },
  { aniListId: 21519,  archetypeId: 'auteur', displayName: 'Your Name',                                           tier: 3,  services: ['crunchyroll', 'hulu'] },
  { aniListId: 106286, archetypeId: 'auteur', displayName: 'Weathering With You',                                 tier: 20, services: ['crunchyroll', 'hulu'] },
  { aniListId: 142770, archetypeId: 'auteur', displayName: 'Suzume',                                              tier: 21, services: ['crunchyroll'] },
  { aniListId: 572,    archetypeId: 'auteur', displayName: 'Nausicaä of the Valley of the Wind',                  tier: 22, services: ['max'] },
  { aniListId: 16662,  archetypeId: 'auteur', displayName: 'The Wind Rises',                                      tier: 23, services: ['max'] },
  { aniListId: 578,    archetypeId: 'auteur', displayName: 'Grave of the Fireflies',                              tier: 24, services: ['max'] },
  { aniListId: 109979, archetypeId: 'auteur', displayName: 'The Boy and the Heron',                               tier: 25, services: ['max'] },
  { aniListId: 416,    archetypeId: 'auteur', displayName: 'Porco Rosso',                                         tier: 26, services: ['max'] },
  { aniListId: 16664,  archetypeId: 'auteur', displayName: 'The Tale of the Princess Kaguya',                     tier: 27, services: ['max'] },
  { aniListId: 585,    archetypeId: 'auteur', displayName: 'Whisper of the Heart',                                tier: 28, services: ['max'] },
  { aniListId: 103887, archetypeId: 'auteur', displayName: 'Modest Heroes',                                       tier: 29, services: ['netflix'] },

  // ── Fujoshi/Yuri-Lover (12) ────────────────────────────────────
  { aniListId: 108430, archetypeId: 'fujoshi-yuri', displayName: 'Given',                                         tier: 1,  services: ['crunchyroll'] },
  { aniListId: 101573, archetypeId: 'fujoshi-yuri', displayName: 'Bloom Into You',                                tier: 2,  services: ['crunchyroll'] },
  { aniListId: 109287, archetypeId: 'fujoshi-yuri', displayName: 'Adachi to Shimamura',                           tier: 8,  services: ['crunchyroll'] },
  { aniListId: 126288, archetypeId: 'fujoshi-yuri', displayName: 'Sasaki to Miyano',                              tier: 4,  services: ['crunchyroll'] },
  { aniListId: 21096,  archetypeId: 'fujoshi-yuri', displayName: 'Doukyusei -Classmates-',                        tier: 10, services: ['crunchyroll'] },
  { aniListId: 20520,  archetypeId: 'fujoshi-yuri', displayName: 'Love Stage!!',                                  tier: 6,  services: ['crunchyroll'] },
  { aniListId: 149028, archetypeId: 'fujoshi-yuri', displayName: 'Yuri Is My Job!',                               tier: 7,  services: ['crunchyroll'] },
  { aniListId: 100388, archetypeId: 'fujoshi-yuri', displayName: 'Banana Fish',                                   tier: 3,  services: ['prime'] },
  { aniListId: 10495,  archetypeId: 'fujoshi-yuri', displayName: 'YuruYuri',                                      tier: 9,  services: ['crunchyroll'] },
  { aniListId: 21311,  archetypeId: 'fujoshi-yuri', displayName: 'Bungo Stray Dogs',                              tier: 5,  services: ['crunchyroll', 'hulu'] },
  { aniListId: 97832,  archetypeId: 'fujoshi-yuri', displayName: 'Citrus',                                        tier: 11, services: ['crunchyroll'] },
  { aniListId: 87494,  archetypeId: 'fujoshi-yuri', displayName: 'Hitorijime My Hero',                            tier: 12, services: ['crunchyroll'] },

  // ── CGDCT (15) ─────────────────────────────────────────────────
  { aniListId: 5680,   archetypeId: 'cgdct', displayName: 'K-On!',                                                tier: 1,  services: ['crunchyroll'] },
  { aniListId: 98444,  archetypeId: 'cgdct', displayName: 'Laid-Back Camp (Yuru Camp△)',                          tier: 2,  services: ['crunchyroll'] },
  { aniListId: 17549,  archetypeId: 'cgdct', displayName: 'Non Non Biyori',                                       tier: 7,  services: ['crunchyroll'] },
  { aniListId: 20517,  archetypeId: 'cgdct', displayName: 'Is the Order a Rabbit?',                               tier: 11, services: ['crunchyroll'] },
  { aniListId: 130003, archetypeId: 'cgdct', displayName: 'Bocchi the Rock!',                                     tier: 5,  services: ['crunchyroll'] },
  { aniListId: 1887,   archetypeId: 'cgdct', displayName: 'Lucky Star',                                           tier: 6,  services: ['crunchyroll'] },
  { aniListId: 143270, archetypeId: 'cgdct', displayName: 'Lycoris Recoil',                                       tier: 3,  services: ['crunchyroll'] },
  { aniListId: 1852,   archetypeId: 'cgdct', displayName: 'Hidamari Sketch',                                      tier: 8,  services: ['crunchyroll'] },
  { aniListId: 99426,  archetypeId: 'cgdct', displayName: 'A Place Further Than the Universe',                    tier: 9,  services: ['crunchyroll'] },
  { aniListId: 20912,  archetypeId: 'cgdct', displayName: 'Sound! Euphonium',                                     tier: 10, services: ['crunchyroll'] },
  { aniListId: 133965, archetypeId: 'cgdct', displayName: 'Komi Can\'t Communicate',                              tier: 4,  services: ['netflix'] },
  { aniListId: 20812,  archetypeId: 'cgdct', displayName: 'SHIROBAKO',                                            tier: 12, services: ['crunchyroll'] },
  { aniListId: 138882, archetypeId: 'cgdct', displayName: 'The Yakuza\'s Guide to Babysitting',                   tier: 13, services: ['disney', 'hulu', 'crunchyroll'] },
  { aniListId: 523,    archetypeId: 'cgdct', displayName: 'My Neighbor Totoro',                                   tier: 14, services: ['max'] },
  { aniListId: 143653, archetypeId: 'cgdct', displayName: 'Insomniacs After School',                              tier: 15, services: ['disney', 'hulu'] },

  // ── Sports (12) ────────────────────────────────────────────────
  { aniListId: 20464,  archetypeId: 'sports', displayName: 'Haikyuu!!',                                           tier: 1,  services: ['crunchyroll', 'hulu', 'netflix'] },
  { aniListId: 21709,  archetypeId: 'sports', displayName: 'Yuri!!! on ICE',                                      tier: 2,  services: ['crunchyroll'] },
  { aniListId: 101903, archetypeId: 'sports', displayName: 'Run with the Wind',                                   tier: 7,  services: ['crunchyroll'] },
  { aniListId: 11771,  archetypeId: 'sports', displayName: 'Kuroko\'s Basketball',                                tier: 4,  services: ['crunchyroll', 'netflix'] },
  { aniListId: 263,    archetypeId: 'sports', displayName: 'Hajime no Ippo',                                      tier: 8,  services: ['crunchyroll'] },
  { aniListId: 18507,  archetypeId: 'sports', displayName: 'Free!',                                               tier: 6,  services: ['crunchyroll'] },
  { aniListId: 137822, archetypeId: 'sports', displayName: 'Blue Lock',                                           tier: 3,  services: ['crunchyroll', 'netflix'] },
  { aniListId: 170,    archetypeId: 'sports', displayName: 'Slam Dunk',                                           tier: 5,  services: ['hulu'] },
  { aniListId: 100298, archetypeId: 'sports', displayName: 'Megalobox',                                           tier: 9,  services: ['crunchyroll', 'netflix'] },
  { aniListId: 18689,  archetypeId: 'sports', displayName: 'Ace of the Diamond',                                  tier: 10, services: ['crunchyroll'] },
  { aniListId: 185,    archetypeId: 'sports', displayName: 'Initial D',                                           tier: 11, services: ['crunchyroll'] },
  { aniListId: 15,     archetypeId: 'sports', displayName: 'Eyeshield 21',                                        tier: 12, services: ['crunchyroll'] },

  // ── Mecha (14) ─────────────────────────────────────────────────
  { aniListId: 1575,   archetypeId: 'mecha', displayName: 'Code Geass: Lelouch of the Rebellion',                 tier: 1,  services: ['crunchyroll', 'hulu'] },
  { aniListId: 30,     archetypeId: 'mecha', displayName: 'Neon Genesis Evangelion',                              tier: 2,  services: ['netflix'] },
  { aniListId: 80,     archetypeId: 'mecha', displayName: 'Mobile Suit Gundam (0079)',                            tier: 4,  services: ['crunchyroll'] },
  { aniListId: 2001,   archetypeId: 'mecha', displayName: 'Gurren Lagann',                                        tier: 3,  services: ['crunchyroll', 'netflix'] },
  { aniListId: 116589, archetypeId: 'mecha', displayName: '86 EIGHTY-SIX',                                        tier: 5,  services: ['crunchyroll'] },
  { aniListId: 99423,  archetypeId: 'mecha', displayName: 'DARLING in the FRANXX',                                tier: 6,  services: ['crunchyroll'] },
  { aniListId: 237,    archetypeId: 'mecha', displayName: 'Eureka Seven',                                         tier: 7,  services: ['crunchyroll'] },
  { aniListId: 21268,  archetypeId: 'mecha', displayName: 'Mobile Suit Gundam: Iron-Blooded Orphans',             tier: 8,  services: ['crunchyroll'] },
  { aniListId: 3572,   archetypeId: 'mecha', displayName: 'Macross Frontier',                                     tier: 9,  services: ['crunchyroll'] },
  { aniListId: 71,     archetypeId: 'mecha', displayName: 'Full Metal Panic!',                                    tier: 10, services: ['crunchyroll'] },
  { aniListId: 90,     archetypeId: 'mecha', displayName: 'Mobile Suit Gundam Wing',                              tier: 11, services: ['crunchyroll'] },
  { aniListId: 139274, archetypeId: 'mecha', displayName: 'Mobile Suit Gundam: The Witch from Mercury',           tier: 12, services: ['crunchyroll'] },
  { aniListId: 19775,  archetypeId: 'mecha', displayName: 'Knights of Sidonia',                                   tier: 13, services: ['netflix'] },
  { aniListId: 139303, archetypeId: 'mecha', displayName: 'Black Rock Shooter: Dawn Fall',                        tier: 14, services: ['disney'] },

  // ── Horror / Dark (16: 14 nm + 2 m) ────────────────────────────
  { aniListId: 97986,  archetypeId: 'horror', displayName: 'Made in Abyss',                                       tier: 1,  services: ['prime'] },
  { aniListId: 934,    archetypeId: 'horror', displayName: 'Higurashi: When They Cry',                            tier: 8,  services: ['crunchyroll'] },
  { aniListId: 7724,   archetypeId: 'horror', displayName: 'Shiki',                                               tier: 9,  services: ['crunchyroll'] },
  { aniListId: 20623,  archetypeId: 'horror', displayName: 'Parasyte -the maxim-',                                tier: 4,  services: ['crunchyroll', 'hulu'] },
  { aniListId: 11111,  archetypeId: 'horror', displayName: 'Another',                                             tier: 5,  services: ['crunchyroll'] },
  { aniListId: 226,    archetypeId: 'horror', displayName: 'Elfen Lied',                                          tier: 6,  services: ['crunchyroll'], mature: true },
  { aniListId: 777,    archetypeId: 'horror', displayName: 'Hellsing Ultimate',                                   tier: 7,  services: ['crunchyroll', 'netflix'], mature: true },
  { aniListId: 127230, archetypeId: 'horror', displayName: 'Chainsaw Man',                                        tier: 2,  services: ['crunchyroll'] },
  { aniListId: 20605,  archetypeId: 'horror', displayName: 'Tokyo Ghoul',                                         tier: 3,  services: ['crunchyroll', 'hulu'] },
  { aniListId: 99940,  archetypeId: 'horror', displayName: 'Junji Ito Collection',                                tier: 10, services: ['crunchyroll'] },
  { aniListId: 2246,   archetypeId: 'horror', displayName: 'Mononoke',                                            tier: 11, services: ['crunchyroll'] },
  { aniListId: 20931,  archetypeId: 'horror', displayName: 'Death Parade',                                        tier: 12, services: ['crunchyroll', 'hulu'] },
  { aniListId: 21341,  archetypeId: 'horror', displayName: 'Ajin: Demi-Human',                                    tier: 13, services: ['netflix'] },
  { aniListId: 131083, archetypeId: 'horror', displayName: 'Mieruko-chan',                                        tier: 14, services: ['crunchyroll'] },
  { aniListId: 105228, archetypeId: 'horror', displayName: 'Dorohedoro',                                          tier: 15, services: ['netflix'] },
  { aniListId: 101165, archetypeId: 'horror', displayName: 'GOBLIN SLAYER',                                       tier: 16, services: ['crunchyroll', 'hulu'], mature: true },

  // ── Mahou Shoujo (14: 13 nm + 1 m) ─────────────────────────────
  { aniListId: 9756,   archetypeId: 'mahou-shoujo', displayName: 'Puella Magi Madoka Magica',                     tier: 1,  services: ['crunchyroll', 'hulu'] },
  { aniListId: 530,    archetypeId: 'mahou-shoujo', displayName: 'Sailor Moon',                                   tier: 2,  services: ['hulu'] },
  { aniListId: 232,    archetypeId: 'mahou-shoujo', displayName: 'Cardcaptor Sakura',                             tier: 3,  services: ['crunchyroll'] },
  { aniListId: 721,    archetypeId: 'mahou-shoujo', displayName: 'Princess Tutu',                                 tier: 4,  services: ['crunchyroll'] },
  { aniListId: 76,     archetypeId: 'mahou-shoujo', displayName: 'Magical Girl Lyrical Nanoha',                   tier: 5,  services: ['crunchyroll'] },
  { aniListId: 440,    archetypeId: 'mahou-shoujo', displayName: 'Revolutionary Girl Utena',                      tier: 6,  services: ['crunchyroll'] },
  { aniListId: 100010, archetypeId: 'mahou-shoujo', displayName: 'Magical Girl Site',                             tier: 7,  services: ['crunchyroll'], mature: true },
  { aniListId: 20800,  archetypeId: 'mahou-shoujo', displayName: 'Yuki Yuna is a Hero',                           tier: 8,  services: ['crunchyroll'] },
  { aniListId: 104051, archetypeId: 'mahou-shoujo', displayName: 'Magia Record',                                  tier: 9,  services: ['crunchyroll'] },
  { aniListId: 435,    archetypeId: 'mahou-shoujo', displayName: 'Magic Knight Rayearth',                         tier: 10, services: ['crunchyroll'] },
  { aniListId: 687,    archetypeId: 'mahou-shoujo', displayName: 'Tokyo Mew Mew',                                 tier: 11, services: ['crunchyroll'] },
  { aniListId: 2923,   archetypeId: 'mahou-shoujo', displayName: 'Shugo Chara!',                                  tier: 12, services: ['crunchyroll'] },
  { aniListId: 603,    archetypeId: 'mahou-shoujo', displayName: 'Pretty Cure',                                   tier: 13, services: ['crunchyroll'] },
  { aniListId: 117196, archetypeId: 'mahou-shoujo', displayName: 'Tokyo Mew Mew New',                             tier: 14, services: ['disney', 'hulu'] },

  // ── Mind-Game Thriller (15) ────────────────────────────────────
  { aniListId: 1535,   archetypeId: 'mind-game-thriller', displayName: 'Death Note',                              tier: 1,  services: ['netflix', 'hulu'] },
  { aniListId: 19,     archetypeId: 'mind-game-thriller', displayName: 'Monster',                                 tier: 2,  services: ['netflix'] },
  { aniListId: 3002,   archetypeId: 'mind-game-thriller', displayName: 'Kaiji: Ultimate Survivor',                tier: 3,  services: ['crunchyroll'] },
  { aniListId: 101759, archetypeId: 'mind-game-thriller', displayName: 'The Promised Neverland',                  tier: 4,  services: ['crunchyroll', 'hulu'] },
  { aniListId: 19815,  archetypeId: 'mind-game-thriller', displayName: 'No Game No Life',                         tier: 5,  services: ['crunchyroll', 'hulu'] },
  { aniListId: 110350, archetypeId: 'mind-game-thriller', displayName: 'ID: INVADED',                             tier: 6,  services: ['crunchyroll'] },
  { aniListId: 21711,  archetypeId: 'mind-game-thriller', displayName: '91 Days',                                 tier: 7,  services: ['crunchyroll', 'hulu'] },
  { aniListId: 98659,  archetypeId: 'mind-game-thriller', displayName: 'Classroom of the Elite',                  tier: 8,  services: ['crunchyroll'] },
  { aniListId: 10620,  archetypeId: 'mind-game-thriller', displayName: 'The Future Diary',                        tier: 9,  services: ['crunchyroll', 'netflix'] },
  { aniListId: 21234,  archetypeId: 'mind-game-thriller', displayName: 'ERASED',                                  tier: 10, services: ['crunchyroll', 'netflix'] },
  { aniListId: 20661,  archetypeId: 'mind-game-thriller', displayName: 'Terror in Resonance',                     tier: 11, services: ['crunchyroll'] },
  { aniListId: 98314,  archetypeId: 'mind-game-thriller', displayName: 'Kakegurui',                               tier: 12, services: ['netflix'] },
  { aniListId: 129201, archetypeId: 'mind-game-thriller', displayName: 'Summer Time Rendering',                   tier: 13, services: ['disney', 'hulu'] },
  { aniListId: 101349, archetypeId: 'mind-game-thriller', displayName: 'BABYLON',                                 tier: 14, services: ['prime'] },
  { aniListId: 116566, archetypeId: 'mind-game-thriller', displayName: 'Akudama Drive',                           tier: 15, services: ['crunchyroll'] },

  // ── Hard Sci-Fi / Cyberpunk (13) ───────────────────────────────
  { aniListId: 9253,   archetypeId: 'hard-scifi', displayName: 'Steins;Gate',                                     tier: 1,  services: ['crunchyroll', 'hulu'] },
  { aniListId: 13601,  archetypeId: 'hard-scifi', displayName: 'Psycho-Pass',                                     tier: 2,  services: ['crunchyroll', 'netflix'] },
  { aniListId: 339,    archetypeId: 'hard-scifi', displayName: 'Serial Experiments Lain',                         tier: 9,  services: ['crunchyroll'] },
  { aniListId: 43,     archetypeId: 'hard-scifi', displayName: 'Ghost in the Shell (1995)',                       tier: 4,  services: ['hulu'] },
  { aniListId: 790,    archetypeId: 'hard-scifi', displayName: 'Ergo Proxy',                                      tier: 8,  services: ['crunchyroll'] },
  { aniListId: 329,    archetypeId: 'hard-scifi', displayName: 'Planetes',                                        tier: 6,  services: ['crunchyroll'] },
  { aniListId: 128546, archetypeId: 'hard-scifi', displayName: 'Vivy: Fluorite Eye\'s Song',                      tier: 7,  services: ['crunchyroll'] },
  { aniListId: 120377, archetypeId: 'hard-scifi', displayName: 'Cyberpunk: Edgerunners',                          tier: 5,  services: ['netflix'] },
  { aniListId: 1,      archetypeId: 'hard-scifi', displayName: 'Cowboy Bebop',                                    tier: 3,  services: ['crunchyroll', 'hulu'] },
  { aniListId: 13125,  archetypeId: 'hard-scifi', displayName: 'From the New World',                              tier: 10, services: ['crunchyroll'] },
  { aniListId: 155783, archetypeId: 'hard-scifi', displayName: 'Heavenly Delusion',                               tier: 11, services: ['hulu', 'disney'] },
  { aniListId: 6,      archetypeId: 'hard-scifi', displayName: 'Trigun',                                          tier: 12, services: ['crunchyroll'] },
  { aniListId: 108353, archetypeId: 'hard-scifi', displayName: 'SPRIGGAN',                                        tier: 13, services: ['netflix'] },

  // ── Battle Seinen (17: 16 nm + 1 m) ────────────────────────────
  { aniListId: 101348, archetypeId: 'battle-seinen', displayName: 'Vinland Saga',                                 tier: 1,  services: ['crunchyroll', 'netflix'] },
  { aniListId: 33,     archetypeId: 'battle-seinen', displayName: 'Berserk (1997)',                               tier: 2,  services: ['crunchyroll'] },
  { aniListId: 101347, archetypeId: 'battle-seinen', displayName: 'Dororo',                                       tier: 8,  services: ['prime'] },
  { aniListId: 16498,  archetypeId: 'battle-seinen', displayName: 'Attack on Titan',                              tier: 4,  services: ['crunchyroll', 'hulu', 'netflix'] },
  { aniListId: 14719,  archetypeId: 'battle-seinen', displayName: 'JoJo\'s Bizarre Adventure',                    tier: 5,  services: ['netflix', 'crunchyroll'] },
  { aniListId: 1818,   archetypeId: 'battle-seinen', displayName: 'Claymore',                                     tier: 6,  services: ['crunchyroll'] },
  { aniListId: 889,    archetypeId: 'battle-seinen', displayName: 'Black Lagoon',                                 tier: 7,  services: ['crunchyroll'], mature: true },
  { aniListId: 5114,   archetypeId: 'battle-seinen', displayName: 'Fullmetal Alchemist: Brotherhood',             tier: 3,  services: ['crunchyroll', 'netflix', 'hulu'] },
  { aniListId: 205,    archetypeId: 'battle-seinen', displayName: 'Samurai Champloo',                             tier: 9,  services: ['crunchyroll', 'hulu'] },
  { aniListId: 107660, archetypeId: 'battle-seinen', displayName: 'BEASTARS',                                     tier: 10, services: ['netflix'] },
  { aniListId: 12031,  archetypeId: 'battle-seinen', displayName: 'Kingdom',                                      tier: 11, services: ['crunchyroll'] },
  { aniListId: 3588,   archetypeId: 'battle-seinen', displayName: 'Soul Eater',                                   tier: 12, services: ['crunchyroll', 'netflix'] },
  { aniListId: 127399, archetypeId: 'battle-seinen', displayName: 'Record of Ragnarok',                           tier: 13, services: ['netflix'] },
  { aniListId: 131930, archetypeId: 'battle-seinen', displayName: 'Yasuke',                                       tier: 14, services: ['netflix'] },
  { aniListId: 97922,  archetypeId: 'battle-seinen', displayName: 'INUYASHIKI LAST HERO',                         tier: 15, services: ['prime', 'crunchyroll'] },
  { aniListId: 159831, archetypeId: 'battle-seinen', displayName: 'Zom 100: Bucket List of the Dead',             tier: 16, services: ['netflix', 'hulu'] },
  { aniListId: 20935,  archetypeId: 'battle-seinen', displayName: 'The Heroic Legend of Arslan',                  tier: 17, services: ['prime', 'crunchyroll'] },

  // ── Xianxia / Cultivation (12) ─────────────────────────────────
  { aniListId: 101972, archetypeId: 'xianxia', displayName: 'Mo Dao Zu Shi',                                      tier: 1,  services: ['crunchyroll'] },
  { aniListId: 101920, archetypeId: 'xianxia', displayName: 'Soul Land (Douluo Dalu)',                            tier: 2,  services: ['crunchyroll'] },
  { aniListId: 113260, archetypeId: 'xianxia', displayName: 'Heaven Official\'s Blessing',                        tier: 3,  services: ['netflix', 'crunchyroll'] },
  { aniListId: 98861,  archetypeId: 'xianxia', displayName: 'The King\'s Avatar',                                 tier: 4,  services: ['crunchyroll', 'netflix'] },
  { aniListId: 114121, archetypeId: 'xianxia', displayName: 'The Daily Life of the Immortal King',                tier: 5,  services: ['crunchyroll'] },
  { aniListId: 102464, archetypeId: 'xianxia', displayName: 'Battle Through the Heavens',                         tier: 6,  services: ['crunchyroll'] },
  { aniListId: 126403, archetypeId: 'xianxia', displayName: 'Link Click',                                         tier: 7,  services: ['crunchyroll'] },
  { aniListId: 107912, archetypeId: 'xianxia', displayName: 'Scissor Seven',                                      tier: 8,  services: ['netflix'] },
  { aniListId: 99200,  archetypeId: 'xianxia', displayName: 'Full-Time Magister',                                 tier: 9,  services: ['crunchyroll'] },
  { aniListId: 21840,  archetypeId: 'xianxia', displayName: 'Hitori no Shita - The Outcast',                      tier: 10, services: ['crunchyroll'] },
  { aniListId: 112023, archetypeId: 'xianxia', displayName: 'The Legend of Hei',                                  tier: 11, services: ['crunchyroll'] },
  { aniListId: 122510, archetypeId: 'xianxia', displayName: 'Sword Snow Stride',                                  tier: 12, services: ['crunchyroll'] },

  // ── Josei / Adult Romance (12) ─────────────────────────────────
  { aniListId: 877,    archetypeId: 'josei', displayName: 'NANA',                                                 tier: 1,  services: ['crunchyroll'] },
  { aniListId: 16,     archetypeId: 'josei', displayName: 'Honey and Clover',                                     tier: 2,  services: ['crunchyroll'] },
  { aniListId: 21366,  archetypeId: 'josei', displayName: 'March Comes In Like a Lion',                           tier: 3,  services: ['crunchyroll', 'prime'] },
  { aniListId: 10800,  archetypeId: 'josei', displayName: 'Chihayafuru',                                          tier: 4,  services: ['crunchyroll'] },
  { aniListId: 322,    archetypeId: 'josei', displayName: 'Paradise Kiss',                                        tier: 7,  services: ['crunchyroll'] },
  { aniListId: 6045,   archetypeId: 'josei', displayName: 'Kimi ni Todoke',                                       tier: 6,  services: ['crunchyroll', 'netflix'] },
  { aniListId: 141911, archetypeId: 'josei', displayName: 'Skip and Loafer',                                      tier: 5,  services: ['crunchyroll'] },
  { aniListId: 1698,   archetypeId: 'josei', displayName: 'Nodame Cantabile',                                     tier: 8,  services: ['crunchyroll'] },
  { aniListId: 8129,   archetypeId: 'josei', displayName: 'Princess Jellyfish',                                   tier: 9,  services: ['crunchyroll'] },
  { aniListId: 2966,   archetypeId: 'josei', displayName: 'Spice and Wolf',                                       tier: 10, services: ['crunchyroll'] },
  { aniListId: 145,    archetypeId: 'josei', displayName: 'His and Her Circumstances',                            tier: 11, services: ['crunchyroll'] },
  { aniListId: 112353, archetypeId: 'josei', displayName: 'Wave, Listen to Me!',                                  tier: 12, services: ['crunchyroll'] },
];

// Map archetype id → display label for the tile grid section headers.
export const ARCHETYPE_LABEL_BY_ID = {
  'mainstream-shounen':  'Mainstream Shounen',
  'magic-academy':       'Magic-Academy',
  'comfort-isekai':      'Comfort Isekai',
  'serious-isekai':      'Serious-Craft Isekai',
  'romance-open':        'Romance-Open',
  'otome-villainess':    'Otome / Villainess',
  'auteur':              'Auteur Curiosity',
  'fujoshi-yuri':        'Fujoshi / Yuri-Lover',
  'cgdct':               'Cute Girls Doing Cute Things',
  'sports':              'Sports',
  'mecha':               'Mecha',
  'horror':              'Horror / Dark',
  'mahou-shoujo':        'Mahou Shoujo',
  'mind-game-thriller':  'Mind-Game Thriller',
  'hard-scifi':          'Hard Sci-Fi / Cyberpunk',
  'battle-seinen':       'Battle Seinen',
  'xianxia':             'Xianxia / Cultivation',
  'josei':               'Josei / Adult Romance',
};

// View-filter helpers for the Mainstream / All / Deep Cuts switcher.
//   Mainstream = tier 1–5 (top 5 popular per archetype = 90 tiles)
//   All        = every tier (12+ per archetype, guarantees horizontal scroll)
//   Deep Cuts  = tier 9+ (bottom ~1/3 per archetype, ~120 tiles)
// Mature-flagged entries are filtered separately by visibleAnchors() in
// survey.js and are excluded from all views unless matureOn is set.
export const SURVEY_VIEW_FILTERS = {
  mainstream: anchor => anchor.tier <= 5,
  all:        () => true,
  deepcuts:   anchor => anchor.tier >= 9,
};

// Streaming services for the per-tile badge + filter UI (PR 3).
//
// Brand colors are the official primary marketing colors (used for the
// tile badge stripe + active-state filter pill halo). `order` controls
// the filter pill display order. `id` is the value stored in each
// anchor's `services` array.
//
// To add a service: append an entry here, tag relevant anchors, and
// the filter UI will pick it up automatically.
export const STREAMING_SERVICES = [
  { id: 'crunchyroll', label: 'Crunchyroll',   shortLabel: 'CR',     color: '#F47521', order: 1 },
  { id: 'netflix',     label: 'Netflix',       shortLabel: 'NFLX',   color: '#E50914', order: 2 },
  { id: 'hulu',        label: 'Hulu',          shortLabel: 'Hulu',   color: '#1CE783', order: 3 },
  { id: 'prime',       label: 'Amazon Prime',  shortLabel: 'Prime',  color: '#00A8E1', order: 4 },
  { id: 'disney',      label: 'Disney+',       shortLabel: 'D+',     color: '#0063E5', order: 5 },
  { id: 'max',         label: 'Max',           shortLabel: 'Max',    color: '#9D34DA', order: 6 },
];

// Stable lookup: service id → service object (for color/label resolution
// in the render layer without re-iterating STREAMING_SERVICES).
export const STREAMING_SERVICE_BY_ID = Object.fromEntries(
  STREAMING_SERVICES.map(s => [s.id, s])
);

// Safe accessor: returns the service array for an anchor, defaulting
// to ['crunchyroll'] for legacy entries that haven't been tagged yet.
// Use this in survey.js / engine code instead of reading anchor.services
// directly so the UI doesn't crash on untagged shows.
export function servicesForAnchor(anchor) {
  return Array.isArray(anchor?.services) && anchor.services.length > 0
    ? anchor.services
    : ['crunchyroll'];
}
