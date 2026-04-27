# Spoffline

Spoffline is a local offline music player with a Spotify-like interface.

## What it does

- Imports your local music from a folder or a set of files
- Plays music fully offline in the browser
- Stores queue, history, favorites, and Spotify matches locally
- Connects to Spotify with Authorization Code + PKCE
- Finds matching Spotify tracks for your local songs
- Syncs listened tracks into a private `Spoffline Activity` Spotify playlist
- Can send a matched track to a live Spotify device so playback appears natively in Spotify

## Important Spotify limitation

Spotify's public Web API lets apps:

- authenticate users
- read profile and devices
- search the Spotify catalog
- create playlists and add items
- start playback on an active Spotify device

It does **not** let third-party apps mark an arbitrary local MP3 as the user's current Spotify playback. Because of that, Spoffline uses two honest alternatives:

1. Sync listened tracks into a private `Spoffline Activity` playlist.
2. Send the matched Spotify version of a track to an active Spotify device when you want true Spotify-side activity.

## Run locally

```bash
npm run dev
```

Then open:

```text
http://127.0.0.1:4173
```

## Spotify setup

1. Create an app in the Spotify Developer Dashboard.
2. Copy its Client ID.
3. Add this Redirect URI to the app:

```text
http://127.0.0.1:4173
```

4. Paste the Client ID and the same Redirect URI into Spoffline.
5. Click `Подключить Spotify`.

## Notes

- Folder/file persistence works best in Chromium-based browsers because Spoffline uses modern file access APIs when available.
- Fallback imports still work, but browser-only fallback files may need to be selected again after a page reload.
