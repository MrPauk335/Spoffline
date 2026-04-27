import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const host = "127.0.0.1";
const port = Number(process.env.PORT || 4173);
const root = process.cwd();
const MUSICBRAINZ_DELAY_MS = 1100;
const MUSICBRAINZ_USER_AGENT = "Spoffline/1.0 (local metadata proxy)";

let lastMusicBrainzRequestAt = 0;
let musicBrainzQueue = Promise.resolve();

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".webp": "image/webp"
};

function safePath(urlPath) {
  const requested = urlPath === "/" ? "/index.html" : urlPath;
  const normalized = normalize(requested).replace(/^(\.\.[/\\])+/, "");
  return join(root, normalized);
}

function writeJson(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForMusicBrainzSlot() {
  const p = musicBrainzQueue.then(async () => {
    const elapsed = Date.now() - lastMusicBrainzRequestAt;
    const waitMs = MUSICBRAINZ_DELAY_MS - elapsed;
    if (waitMs > 0) {
      await sleep(waitMs);
    }
    lastMusicBrainzRequestAt = Date.now();
  });
  musicBrainzQueue = p;
  return p;
}

async function fetchJson(url, init = {}) {
  const response = await fetch(url, init);
  if (!response.ok) {
    const message = await response.text().catch(() => "");
    const error = new Error(message || `${response.status} ${response.statusText}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

function cleanTerm(value) {
  return String(value || "")
    .replace(/[!()[\]{}^~*?:\\"/]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function normalizeCompare(value) {
  return cleanTerm(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function stripFeaturing(value) {
  return cleanTerm(value)
    .replace(/\s*\((?:feat|ft)\.?\s[^)]*(?:\)|$)/i, "")
    .replace(/\s*[-–—]\s*(?:feat|ft)\.?\s.+$/i, "")
    .trim();
}

function quoteQueryValue(value) {
  return `"${cleanTerm(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function buildSearchQueries({ title, titleAlt, artist, album }) {
  const titles = [title, titleAlt]
    .map((value) => cleanTerm(value))
    .filter(Boolean);
  const queries = [];

  for (const currentTitle of titles) {
    const titleTerm = `recording:${quoteQueryValue(currentTitle)}`;
    if (artist && album) {
      queries.push(`${titleTerm} AND artist:${quoteQueryValue(artist)} AND release:${quoteQueryValue(album)}`);
    }
    if (artist) {
      queries.push(`${titleTerm} AND artist:${quoteQueryValue(artist)}`);
    }
    queries.push(titleTerm);
  }

  return [...new Set(queries)];
}

function formatArtistCredit(artistCredit = []) {
  return artistCredit
    .map((part) => part?.name || part?.artist?.name || "")
    .filter(Boolean)
    .join(", ");
}

function pickPrimaryRelease(recording) {
  const releases = Array.isArray(recording?.releases) ? recording.releases : [];
  return (
    releases.find((release) => String(release?.status || "").toLowerCase() === "official") ||
    releases[0] ||
    null
  );
}

function scoreRecording(recording, wanted) {
  let score = Number(recording?.score || 0);

  const wantedTitle = normalizeCompare(wanted.title);
  const wantedTitleAlt = normalizeCompare(wanted.titleAlt);
  const wantedArtist = normalizeCompare(wanted.artist);
  const wantedAlbum = normalizeCompare(wanted.album);

  const recordingTitle = normalizeCompare(recording?.title);
  const recordingArtist = normalizeCompare(formatArtistCredit(recording?.["artist-credit"]));
  const recordingAlbum = normalizeCompare(pickPrimaryRelease(recording)?.title);

  if (recordingTitle && wantedTitle && recordingTitle === wantedTitle) {
    score += 40;
  }
  if (recordingTitle && wantedTitleAlt && recordingTitle === wantedTitleAlt) {
    score += 24;
  }
  const recordingReleases = Array.isArray(recording?.releases) ? recording.releases : [];
  const isArtistMatch = recordingArtist && wantedArtist && (recordingArtist.includes(wantedArtist) || wantedArtist.includes(recordingArtist));
  const isArtistActuallyAlbum = wantedArtist && recordingReleases.some(rel => normalizeCompare(rel.title) === wantedArtist);

  if (isArtistMatch || isArtistActuallyAlbum) {
    score += 30;
  } else if (recordingArtist && wantedArtist) {
    score -= 100;
  }
  if (recordingAlbum && wantedAlbum && recordingAlbum === wantedAlbum) {
    score += 18;
  }

  const wantedDuration = Number(wanted.durationMs || 0);
  const recordingDuration = Number(recording?.length || 0);
  if (wantedDuration > 0 && recordingDuration > 0) {
    const diff = Math.abs(wantedDuration - recordingDuration);
    if (diff <= 2500) {
      score += 12;
    } else if (diff <= 7000) {
      score += 6;
    } else if (diff >= 25000) {
      score -= 8;
    }
  }

  return score;
}

async function searchMusicBrainz(params) {
  const queries = buildSearchQueries(params);
  let bestRecording = null;
  let bestScore = -Infinity;

  for (const query of queries) {
    await waitForMusicBrainzSlot();

    const searchUrl = new URL("https://musicbrainz.org/ws/2/recording");
    searchUrl.search = new URLSearchParams({
      fmt: "json",
      limit: "10",
      query
    }).toString();

    try {
      const payload = await fetchJson(searchUrl, {
        headers: {
          Accept: "application/json",
          "User-Agent": MUSICBRAINZ_USER_AGENT
        }
      });

      const recordings = Array.isArray(payload?.recordings) ? payload.recordings : [];
      for (const recording of recordings) {
        const score = scoreRecording(recording, params);
        if (score > bestScore) {
          bestScore = score;
          bestRecording = recording;
        }
      }
    } catch (error) {
      console.error("MusicBrainz query failed:", error.message);
    }

    if (bestScore >= 110) {
      break;
    }
  }

  // Fallback: If no recording found, try searching for a release (album) with this name.
  if (!bestRecording || bestScore < 70) {
    const releaseQueries = [];
    if (params.artist) {
      releaseQueries.push(`release:${quoteQueryValue(params.title)} AND artist:${quoteQueryValue(params.artist)}`);
      releaseQueries.push(`release:${quoteQueryValue(params.artist)}`); // The "artist" might be the album name!
    }
    releaseQueries.push(`release:${quoteQueryValue(params.title)}`);

    for (const relQuery of releaseQueries) {
      const releaseUrl = `https://musicbrainz.org/ws/2/release?fmt=json&limit=5&query=${encodeURIComponent(relQuery)}`;
      await waitForMusicBrainzSlot();
      try {
        const payload = await fetchJson(releaseUrl, {
          headers: {
            Accept: "application/json",
            "User-Agent": MUSICBRAINZ_USER_AGENT
          }
        });
        if (payload.releases?.length > 0) {
          const rel = payload.releases[0];
          // Check if artist matches if provided
          if (params.artist) {
            const relArtist = normalizeCompare(formatArtistCredit(rel["artist-credit"]));
            const wantedArtist = normalizeCompare(params.artist);
            if (!relArtist.includes(wantedArtist) && !wantedArtist.includes(relArtist)) {
              continue;
            }
          }
          // Synthetic recording from release info
          return {
            id: rel.id, // Not a recording ID, but we use it as a fallback
            title: rel.title,
            "artist-credit": rel["artist-credit"],
            releases: [rel],
            score: 100
          };
        }
      } catch (error) {
        console.error("MusicBrainz release query failed:", error.message);
      }
    }
  }

  return bestScore >= 70 ? bestRecording : null;
}

async function fetchCoverArt(releaseId) {
  if (!releaseId) {
    return "";
  }

  try {
    const payload = await fetchJson(`https://coverartarchive.org/release/${encodeURIComponent(releaseId)}`, {
      headers: {
        Accept: "application/json",
        "User-Agent": MUSICBRAINZ_USER_AGENT
      }
    });

    const images = Array.isArray(payload?.images) ? payload.images : [];
    const cover = images.find((image) => image?.front) || images[0];
    return cover?.thumbnails?.large || cover?.thumbnails?.small || cover?.image || "";
  } catch (error) {
    if (error?.status === 404) {
      return "";
    }
    throw error;
  }
}

function buildMatchPayload(recording, artworkUrl) {
  const release = pickPrimaryRelease(recording);
  const artist = formatArtistCredit(recording?.["artist-credit"]);
  const releaseUrl = release?.id ? `https://musicbrainz.org/release/${release.id}` : "";

  return {
    source: "musicbrainz",
    sourceLabel: "MusicBrainz",
    sourceUrl: releaseUrl || `https://musicbrainz.org/recording/${recording.id}`,
    title: cleanTerm(recording?.title),
    artist,
    album: cleanTerm(release?.title),
    artworkUrl,
    recordingId: recording?.id || "",
    releaseId: release?.id || "",
    matchedAt: Date.now()
  };
}

async function handleMetadataSearch(url, res) {
  const title = cleanTerm(url.searchParams.get("title"));
  if (!title) {
    writeJson(res, 400, { error: "title is required" });
    return;
  }

  try {
    const params = {
      title,
      titleAlt: cleanTerm(url.searchParams.get("titleAlt")),
      artist: cleanTerm(url.searchParams.get("artist")),
      album: cleanTerm(url.searchParams.get("album")),
      durationMs: cleanTerm(url.searchParams.get("durationMs"))
    };

    const recording = await searchMusicBrainz(params);
    if (!recording) {
      writeJson(res, 404, { match: null });
      return;
    }

    let artworkUrl = "";
    try {
      artworkUrl = await fetchCoverArt(pickPrimaryRelease(recording)?.id || "");
    } catch (err) {
      console.error("Cover art lookup failed (returning metadata anyway):", err.message);
    }

    writeJson(res, 200, {
      match: buildMatchPayload(recording, artworkUrl)
    });
  } catch (error) {
    console.error("Search failed:", error);
    writeJson(res, 502, { error: "metadata lookup failed" });
  }
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${host}:${port}`);

    if (url.pathname === "/api/metadata/search") {
      await handleMetadataSearch(url, res);
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      writeJson(res, 404, { error: "not found" });
      return;
    }

    const filePath = safePath(url.pathname);
    const ext = extname(filePath).toLowerCase();
    const body = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": mimeTypes[ext] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    res.end(body);
  } catch {
    try {
      const body = await readFile(join(root, "index.html"));
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store"
      });
      res.end(body);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
    }
  }
}).listen(port, host, () => {
  console.log(`Spoffline is live at http://${host}:${port}`);
});
