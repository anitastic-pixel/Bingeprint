# Privacy Policy — Bingeprint (Smart Scoring for Crunchyroll)

**Last updated: 2026-05-21**

Bingeprint is built to be private. It runs **entirely in your browser**. There are no Bingeprint servers, no accounts, no analytics, no telemetry, and no tracking. Your data is never sold or transferred for advertising, and the developer never receives it.

## What the extension accesses

To score and recommend anime for you, Bingeprint reads the following **on your device**:

- **Your Crunchyroll watch history** — which series you've watched, completion percentage, your ratings, and timing — read through the Crunchyroll session your browser already has. *(Disclosed to the Chrome Web Store as "Web history.")*
- **Crunchyroll page content** — series metadata (titles, tags) on the pages you view, used to score the show in front of you. *(Disclosed as "Website content.")*
- **Account identifiers** — your Crunchyroll profile ID (used to keep your taste data separate per profile) and, only if you choose to connect AniList, your **public AniList username**. *(Disclosed as "Personally identifiable information.")*

It does **not** access passwords, credentials, tokens, payment or financial data, health data, location, personal messages, or your general (non-Crunchyroll) browsing history. It does not log clicks, scrolling, mouse movement, or keystrokes.

## Where your data is stored

All of it lives in `chrome.storage.local` **on your own machine**. It never leaves your device except for the specific third-party requests described below. Uninstalling the extension deletes everything.

## Third-party services

Bingeprint contacts these public services only to deliver the features you use. No data is sent to any developer-controlled server (there is none).

- **AniList (`graphql.anilist.co`)** — sends show titles/IDs to fetch public anime metadata (tags, community scores, recommendations). If you connect AniList, your **public** username is sent to retrieve your public list. No login and no token are used or stored. See AniList's privacy policy.
- **Crunchyroll (`crunchyroll.com`)** — the extension reads *your own* watch history and ratings using the session already active in your browser. It does not read or store your Crunchyroll credentials. See Crunchyroll's privacy policy.
- **anime-offline-database (`github.com` / `release-assets.githubusercontent.com`)** — downloads a public, read-only dataset ([manami-project's anime-offline-database](https://github.com/manami-project/anime-offline-database), ODbL v1.0) used to match Crunchyroll titles to AniList entries. **No user data is sent** in this request.

## How your data is used

Only to provide the extension's single purpose: scoring and recommending anime based on your taste. It is not used for any unrelated purpose, is not sold or transferred to third parties outside the cases above, and is never used to determine creditworthiness or for lending.

## Your control

- **Remove an imported list** any time from the toolbar popup.
- **Clear your Quick Taste Check taps** from the popup.
- **Uninstall** the extension to erase all stored data immediately.
- Optional **Backup & restore** lets you export your data to a local JSON file that you control; it is never uploaded anywhere.

## Children

Bingeprint is a general-audience tool and is not directed at children under 13.

## Changes

If this policy changes, the "Last updated" date above will change and the new version will be published in this repository.

## Contact

Questions or concerns: open an issue at <https://github.com/anitastic-pixel/Bingeprint/issues>.

---

*Not affiliated with or endorsed by Crunchyroll or AniList.*
