# Bingeprint — Smart Scoring for Crunchyroll

Bingeprint scores every anime on Crunchyroll against **your** taste — not what's trending — and shows its reasoning. Crunchyroll's rows show what's popular; Bingeprint asks a different question: *is this show for you?*

It runs entirely in your browser. No account, no servers, no telemetry, no tracking.

## What it does

- **Smart Score on every series page** — a taste-match percentage, a plain-English tier (TRUST ME → SKIP), and the specific signals pulling for and against the show.
- **Smart Picks side panel** — ranked recommendations across eight lenses (Peak, Comfort, In the Air, People You Trust, Take a Chance, You've Missed, Try Again, Rewatched), with a "Vibe today" mood filter.
- **Your Taste Shape** — an eight-axis radar of what you actually gravitate toward.
- **Quick Taste Check** — a 3-minute survey to get useful recommendations fast.
- **Optional import** — link AniList by public username, or upload a MyAnimeList/AniList list export (XML) for richer signal.

## Privacy

All taste data lives in `chrome.storage.local` on your machine and never leaves the browser. Uninstalling wipes it. AniList import is by **public username** — no passwords or tokens are ever stored. The only network requests fetch public data: anime metadata from AniList's GraphQL API, and a public title-mapping dataset (see below).

## Install (unpacked)

1. Clone or download this repo.
2. Open `chrome://extensions`, enable **Developer mode**.
3. **Load unpacked** → select this folder.
4. Open any Crunchyroll series page to see your first Smart Score; take the Quick Taste Check from the toolbar icon to sharpen things.

Built for Chromium browsers (Chrome, Edge, Brave, Arc, Opera).

## Third-party data

- **AniList** — public anime metadata (tags, community scores, recommendations) via `graphql.anilist.co`.
- **anime-offline-database** ([manami-project](https://github.com/manami-project/anime-offline-database)) — a public dataset fetched at runtime to map Crunchyroll titles to AniList IDs. Not bundled here.
- The optional collaborative-filtering re-ranker (off by default) relies on pre-trained model files that are **not included in this repository** due to source-dataset licensing; the extension builds and runs without them.

## License

MIT — see [LICENSE](LICENSE).

Not affiliated with or endorsed by Crunchyroll or AniList.
