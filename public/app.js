const STORAGE_KEY = "spoffline-state-v1";
const DB_NAME = "spoffline-handle-db";
const DB_VERSION = 1;
const HANDLE_STORE = "track-handles";
const HISTORY_LIMIT = 18;
const MUSICBRAINZ_LOOKUP_DELAY_MS = 1100;

const runtimeFiles = new Map();
const audio = new Audio();
audio.preload = "metadata";
audio.volume = 0.85;

let toastTimer = null;
let currentObjectUrl = null;
let playContextIds = [];
let playbackRecordedTrackId = null;
let metadataEnrichmentInFlight = false;
let lastMusicBrainzRequestAt = 0;

const dom = {
  addFolderBtn: document.querySelector("#add-folder-btn"),
  addFilesBtn: document.querySelector("#add-files-btn"),
  clearLibraryBtn: document.querySelector("#clear-library-btn"),
  playRandomBtn: document.querySelector("#play-random-btn"),
  resumeLastBtn: document.querySelector("#resume-last-btn"),
  searchInput: document.querySelector("#search-input"),
  favoritesOnly: document.querySelector("#favorites-only"),
  trackList: document.querySelector("#track-list"),
  emptyState: document.querySelector("#empty-state"),
  filterSummary: document.querySelector("#filter-summary"),
  libraryCount: document.querySelector("#library-count"),
  libraryDuration: document.querySelector("#library-duration"),
  favoritesCount: document.querySelector("#favorites-count"),
  heroTitle: document.querySelector("#hero-title"),
  heroSubtitle: document.querySelector("#hero-subtitle"),
  playlistArtGrid: document.querySelector("#playlist-art-grid"),
  playlistArtFallback: document.querySelector("#playlist-art-fallback"),
  queueList: document.querySelector("#queue-list"),
  queueCount: document.querySelector("#queue-count"),
  historyList: document.querySelector("#history-list"),
  coverArt: document.querySelector("#cover-art"),
  nowTitle: document.querySelector("#now-title"),
  nowArtist: document.querySelector("#now-artist"),
  nowAlbum: document.querySelector("#now-album"),
  nowTimeCurrent: document.querySelector("#now-time-current"),
  nowTimeTotal: document.querySelector("#now-time-total"),
  progressInput: document.querySelector("#progress-input"),
  prevBtn: document.querySelector("#prev-btn"),
  playPauseBtn: document.querySelector("#play-pause-btn"),
  nextBtn: document.querySelector("#next-btn"),
  volumeInput: document.querySelector("#volume-input"),
  matchCurrentBtn: document.querySelector("#match-current-btn"),
  syncCurrentBtn: document.querySelector("#sync-current-btn"),
  openCurrentSpotifyBtn: document.querySelector("#open-current-spotify-btn"),
  spotifyPlayBtn: document.querySelector("#spotify-play-btn"),
  spotifyStatus: document.querySelector("#spotify-status"),
  spotifyAvatar: document.querySelector("#spotify-avatar"),
  spotifyDisplayName: document.querySelector("#spotify-display-name"),
  spotifyHint: document.querySelector("#spotify-hint"),
  spotifyAutoSync: document.querySelector("#spotify-auto-sync"),
  spotifyConnectBtn: document.querySelector("#spotify-connect-btn"),
  spotifyDisconnectBtn: document.querySelector("#spotify-disconnect-btn"),
  spotifyConnectBtnPanel: document.querySelector("#spotify-connect-btn-panel"),
  spotifyDisconnectBtnPanel: document.querySelector("#spotify-disconnect-btn-panel"),
  spotifyPlaylistState: document.querySelector("#spotify-playlist-state"),
  fallbackFolderInput: document.querySelector("#fallback-folder-input"),
  fallbackFileInput: document.querySelector("#fallback-file-input"),
  toast: document.querySelector("#toast")
};

const state = loadState();

queueMicrotask(() => init().catch((error) => {
  console.error(error);
  showToast("Что-то пошло не так во время запуска.");
}));

async function init() {
  normalizeLibraryRecords();
  bindUi();
  render();
  void enrichLibraryMetadata(null, { silent: true, limit: 9999 });
}

function bindUi() {
  dom.searchInput.value = state.searchQuery;
  dom.favoritesOnly.checked = state.favoritesOnly;
  dom.spotifyAutoSync.checked = state.settings.metadataAutoEnrich;
  dom.volumeInput.value = String(state.volume);
  audio.volume = state.volume;
  dom.volumeInput.style.setProperty("--volume-progress", `${state.volume * 100}%`);
  dom.spotifyPlayBtn.textContent = "Сбросить данные";

  const noteLead = document.querySelector(".library-note .helper");
  const noteSub = document.querySelector(".library-note .helper-muted");
  const heroMetaItems = document.querySelectorAll(".hero-meta span");
  if (noteLead) {
    noteLead.textContent = "MusicBrainz и Cover Art Archive помогают подтягивать названия, артистов, альбомы и обложки без Spotify Premium.";
  }
  if (noteSub) {
    noteSub.textContent = "Лучше всего работают нормальные имена файлов и встроенные теги в самих аудиофайлах.";
  }
  if (heroMetaItems[2]) {
    heroMetaItems[2].textContent = "Открытые обложки и релизы";
  }

  dom.addFolderBtn.addEventListener("click", importFromFolder);
  dom.addFilesBtn.addEventListener("click", importFromFiles);
  dom.clearLibraryBtn.addEventListener("click", clearLibrary);
  dom.playRandomBtn.addEventListener("click", playRandomTrack);
  dom.resumeLastBtn.addEventListener("click", resumeLastTrack);

  dom.searchInput.addEventListener("input", () => {
    state.searchQuery = dom.searchInput.value.trim();
    saveState();
    renderSummary();
    renderTrackTable();
  });

  dom.favoritesOnly.addEventListener("change", () => {
    state.favoritesOnly = dom.favoritesOnly.checked;
    saveState();
    renderSummary();
    renderTrackTable();
  });

  dom.spotifyAutoSync.addEventListener("change", saveSettingsFromForm);
  dom.spotifyConnectBtn.addEventListener("click", () => {
    void enrichLibraryMetadata(null, { silent: false, limit: 9999, force: true });
  });
  dom.spotifyDisconnectBtn.addEventListener("click", clearLibraryArtwork);
  dom.spotifyConnectBtnPanel?.addEventListener("click", () => {
    void enrichLibraryMetadata(null, { silent: false, limit: 9999, force: true });
  });
  dom.spotifyDisconnectBtnPanel?.addEventListener("click", clearLibraryArtwork);

  dom.trackList.addEventListener("click", handleTrackAction);
  dom.queueList.addEventListener("click", handleQueueAction);
  dom.historyList.addEventListener("click", handleHistoryAction);

  dom.playPauseBtn.addEventListener("click", togglePlayPause);
  dom.prevBtn.addEventListener("click", playPreviousTrack);
  dom.nextBtn.addEventListener("click", playNextTrack);
  dom.progressInput.addEventListener("input", seekPlayback);
  dom.volumeInput.addEventListener("input", () => {
    state.volume = Number(dom.volumeInput.value);
    audio.volume = state.volume;
    dom.volumeInput.style.setProperty("--volume-progress", `${state.volume * 100}%`);
    saveState();
  });

  dom.matchCurrentBtn.addEventListener("click", () => withCurrentTrack((trackId) => matchTrackToSpotify(trackId, { silent: false, applyMetadata: true, force: true })));
  dom.syncCurrentBtn.addEventListener("click", () => {
    void enrichLibraryMetadata(null, { silent: false, limit: 9999, force: true });
  });
  dom.openCurrentSpotifyBtn.addEventListener("click", () => withCurrentTrack(openMatchedTrackInSpotify));
  dom.spotifyPlayBtn.addEventListener("click", () => withCurrentTrack(clearTrackMetadata));

  dom.fallbackFolderInput.addEventListener("change", async (event) => {
    const files = Array.from(event.target.files || []);
    if (!files.length) {
      return;
    }
    await importFallbackFiles(files, true);
    dom.fallbackFolderInput.value = "";
  });

  dom.fallbackFileInput.addEventListener("change", async (event) => {
    const files = Array.from(event.target.files || []);
    if (!files.length) {
      return;
    }
    await importFallbackFiles(files, false);
    dom.fallbackFileInput.value = "";
  });

  audio.addEventListener("timeupdate", handleTimeUpdate);
  audio.addEventListener("loadedmetadata", handleLoadedMetadata);
  audio.addEventListener("play", renderPlayer);
  audio.addEventListener("pause", renderPlayer);
  audio.addEventListener("ended", () => {
    void playNextTrack();
  });
}

function loadState() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    return {
      library: Array.isArray(parsed.library) ? parsed.library : [],
      currentTrackId: parsed.currentTrackId || null,
      queue: Array.isArray(parsed.queue) ? parsed.queue : [],
      history: Array.isArray(parsed.history) ? parsed.history : [],
      favorites: Array.isArray(parsed.favorites) ? parsed.favorites : [],
      spotifyMatches: parsed.spotifyMatches && typeof parsed.spotifyMatches === "object"
        ? parsed.spotifyMatches
        : {},
      searchQuery: parsed.searchQuery || "",
      favoritesOnly: Boolean(parsed.favoritesOnly),
      volume: typeof parsed.volume === "number" ? parsed.volume : 0.85,
      settings: {
        metadataAutoEnrich: parsed.settings?.metadataAutoEnrich ?? parsed.settings?.spotifyAutoSync ?? true
      }
    };
  } catch {
    return {
      library: [],
      currentTrackId: null,
      queue: [],
      history: [],
      favorites: [],
      spotifyMatches: {},
      searchQuery: "",
      favoritesOnly: false,
      volume: 0.85,
      settings: {
        metadataAutoEnrich: true
      }
    };
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function saveSettingsFromForm() {
  state.settings.metadataAutoEnrich = dom.spotifyAutoSync.checked;
  saveState();
  renderSpotifyPanel();
}

function normalizeLibraryRecords() {
  let changed = false;

  state.library = state.library.map((track) => {
    const baseName = String(track.fileName || "").replace(/\.[^.]+$/, "");
    const parsed = parseTrackDetails(baseName || track.title, track.relativePath || track.fileName || "");
    const normalizedTitle = parsed.title || track.title || "Без названия";
    const normalizedArtist = isUsefulMetadata(track.artist) ? cleanTrackText(track.artist) : parsed.artist;
    const normalizedAlbum = isUsefulMetadata(track.album)
      ? cleanTrackText(track.album)
      : sanitizeAlbumName(
          (track.relativePath || "").split("/").filter(Boolean).slice(-2, -1)[0] || "",
          normalizedTitle
        );

    const nextTrack = {
      ...track,
      title: normalizedTitle,
      artist: normalizedArtist,
      album: normalizedAlbum,
      artworkUrl: track.artworkUrl || state.spotifyMatches[track.id]?.artworkUrl || ""
    };

    if (
      nextTrack.title !== track.title ||
      nextTrack.artist !== track.artist ||
      nextTrack.album !== track.album
    ) {
      changed = true;
    }

    return nextTrack;
  });

  if (changed) {
    saveState();
  }
}

function render() {
  renderSummary();
  renderHeroArtwork();
  renderTrackTable();
  renderQueue();
  renderHistory();
  renderPlayer();
  renderSpotifyPanel();
}

function renderSummary() {
  const totalSeconds = state.library.reduce((sum, track) => sum + (track.duration || 0), 0);
  const filteredTracks = getFilteredTracks();
  dom.libraryCount.textContent = String(state.library.length);
  dom.libraryDuration.textContent = formatLibraryDuration(totalSeconds);
  dom.favoritesCount.textContent = String(state.favorites.length);

  if (!state.library.length) {
    dom.heroTitle.textContent = "Spoffline Mix";
    dom.heroSubtitle.textContent =
      "Импортируй локальную музыку, собирай свою библиотеку и слушай её оффлайн в аккуратном desktop-плеере.";
    return;
  }

  dom.heroTitle.textContent = state.library.length > 1
    ? `Моя медиатека`
    : state.library[0].title;
  dom.heroSubtitle.textContent =
    filteredTracks.length === state.library.length
      ? `В библиотеке уже ${state.library.length} ${pluralizeTracks(state.library.length)}. Выбирай любой трек и слушай музыку полностью локально.`
      : `Фильтр оставил ${filteredTracks.length} ${pluralizeTracks(filteredTracks.length)} из всей библиотеки.`;
}

function renderHeroArtwork() {
  if (!dom.playlistArtGrid || !dom.playlistArtFallback) {
    return;
  }

  const artTracks = state.library.filter((track) => Boolean(getTrackArtworkUrl(track))).slice(0, 4);
  if (!artTracks.length) {
    dom.playlistArtGrid.innerHTML = "";
    dom.playlistArtGrid.classList.remove("is-visible");
    dom.playlistArtGrid.dataset.count = "0";
    dom.playlistArtFallback.hidden = false;
    return;
  }

  dom.playlistArtGrid.dataset.count = String(artTracks.length);
  dom.playlistArtGrid.innerHTML = artTracks
    .map((track) => renderHeroArtTile(track))
    .join("");

  dom.playlistArtGrid.classList.add("is-visible");
  dom.playlistArtFallback.hidden = true;
}

function renderTrackTable() {
  const filteredTracks = getFilteredTracks();
  const currentTrackId = state.currentTrackId;
  dom.trackList.innerHTML = filteredTracks
    .map((track, index) => {
      const isCurrent = currentTrackId === track.id;
      const isFavorite = state.favorites.includes(track.id);
      const match = state.spotifyMatches[track.id];
      const artistLabel = getArtistLabel(track);
      const albumLabel = getAlbumLabel(track);
      const pathLabel = getPathLabel(track);
      const fileLabel = getFileLabel(track);

      return `
        <tr class="${isCurrent ? "is-current" : ""}">
          <td class="cell-order" data-label="#">${index + 1}</td>
          <td class="cell-track" data-label="Название">
            <div class="track-main">
              ${renderArtworkThumb(track, "track-thumb", "♪")}
              <div class="track-title">
                <strong>${escapeHtml(track.title)}</strong>
                <span class="track-subline">${escapeHtml(fileLabel)}</span>
              </div>
            </div>
          </td>
          <td class="cell-artist" data-label="Исполнитель">${escapeHtml(artistLabel)}</td>
          <td class="cell-album" data-label="Альбом / путь">
            <div class="track-title">
              <strong>${escapeHtml(albumLabel)}</strong>
              <span class="track-subline">${escapeHtml(pathLabel)}</span>
            </div>
          </td>
          <td class="cell-time" data-label="Время">${formatDuration(track.duration)}</td>
          <td class="cell-actions" data-label="Действия">
            <div class="track-actions">
              <button class="table-btn" data-action="play" data-track-id="${track.id}">Слушать</button>
              <button class="table-btn" data-action="queue" data-track-id="${track.id}">В очередь</button>
              <button class="table-btn ${isFavorite ? "is-favorite" : ""}" data-action="favorite" data-track-id="${track.id}">
                ${isFavorite ? "В избранном" : "Нравится"}
              </button>
              <button class="table-btn" data-action="match" data-track-id="${track.id}">
                ${match ? "Открыть релиз" : "Найти релиз"}
              </button>
            </div>
          </td>
        </tr>
      `;
    })
    .join("");

  dom.emptyState.classList.toggle("is-visible", !filteredTracks.length);
  dom.filterSummary.textContent = filteredTracks.length
    ? `${filteredTracks.length} ${pluralizeTracks(filteredTracks.length)} в текущем списке`
    : "Ничего не найдено";
}

function renderQueue() {
  const items = state.queue
    .map((id) => getTrackById(id))
    .filter(Boolean)
    .slice(0, 8);

  dom.queueCount.textContent = String(state.queue.length);
  dom.queueList.innerHTML = items.length
    ? items
        .map(
          (track) => `
            <article class="list-card">
              <div class="list-card-row">
                ${renderArtworkThumb(track, "mini-track-thumb", "♪")}
                <div class="list-card-copy">
                  <strong>${escapeHtml(track.title)}</strong>
                  <span class="helper">${escapeHtml(getArtistLabel(track))}</span>
                </div>
              </div>
              <button class="table-btn" data-action="play-from-queue" data-track-id="${track.id}">Играть сейчас</button>
            </article>
          `
        )
        .join("")
    : '<p class="helper">Очередь пока пустая. Добавь треки из таблицы.</p>';
}

function renderHistory() {
  const items = state.history
    .map((entry) => ({ entry, track: getTrackById(entry.trackId) }))
    .filter(({ track }) => Boolean(track))
    .slice(0, 8);

  dom.historyList.innerHTML = items.length
    ? items
        .map(
          ({ entry, track }) => `
            <article class="list-card">
              <div class="list-card-row">
                ${renderArtworkThumb(track, "mini-track-thumb", "♪")}
                <div class="list-card-copy">
                  <strong>${escapeHtml(track.title)}</strong>
                  <span class="helper">${escapeHtml(getArtistLabel(track))}</span>
                  <span class="helper">${formatPlayedAt(entry.playedAt)}</span>
                </div>
              </div>
              <button class="table-btn" data-action="play-from-history" data-track-id="${track.id}">Повторить</button>
            </article>
          `
        )
        .join("")
    : '<p class="helper">История появится после первого прослушивания.</p>';
}

function renderPlayer() {
  const track = getTrackById(state.currentTrackId);
  if (!track) {
    dom.nowTitle.textContent = "Ничего не играет";
    dom.nowArtist.textContent = "Импортируй библиотеку, чтобы начать";
    dom.nowAlbum.textContent = "Оффлайн режим";
    dom.coverArt.classList.remove("has-artwork");
    dom.coverArt.style.backgroundImage = "";
    dom.coverArt.textContent = "SO";
    dom.coverArt.style.setProperty("--cover-a", "#d8fd96");
    dom.coverArt.style.setProperty("--cover-b", "#89df34");
    dom.nowTimeCurrent.textContent = "0:00";
    dom.nowTimeTotal.textContent = "0:00";
    dom.progressInput.value = "0";
    dom.playPauseBtn.textContent = "▶";
    return;
  }

  const palette = paletteFromTrack(track);
  dom.nowTitle.textContent = track.title;
  dom.nowArtist.textContent = getArtistLabel(track);
  dom.nowAlbum.textContent = getAlbumLabel(track) || track.relativePath || "Локальный файл";
  applyArtworkToElement(dom.coverArt, track, initialsForTrack(track), palette);
  
  const glowEl = document.querySelector(".player-glow");
  if (glowEl) {
    glowEl.style.setProperty("--glow-color", palette ? palette.main : "transparent");
  }

  dom.nowTimeCurrent.textContent = formatDuration(audio.currentTime || 0);
  dom.nowTimeTotal.textContent = formatDuration(audio.duration || track.duration || 0);
  const progressValue = audio.duration ? (audio.currentTime / audio.duration) * 100 : 0;
  dom.progressInput.value = String(progressValue * 10);
  dom.progressInput.style.setProperty("--progress", `${progressValue}%`);
  dom.playPauseBtn.textContent = audio.paused ? "▶" : "❚❚";
}


function getFilteredTracks() {
  const query = state.searchQuery.toLowerCase();
  return state.library.filter((track) => {
    if (state.favoritesOnly && !state.favorites.includes(track.id)) {
      return false;
    }

    if (!query) {
      return true;
    }

    const haystack = [
      track.title,
      track.artist,
      track.album,
      track.fileName,
      track.relativePath
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    return haystack.includes(query);
  });
}

function getTrackById(trackId) {
  return state.library.find((track) => track.id === trackId) || null;
}

async function importFromFolder() {
  if ("showDirectoryPicker" in window) {
    try {
      const directoryHandle = await window.showDirectoryPicker();
      const entries = [];
      await collectDirectoryFiles(directoryHandle, "", entries);
      await importHandleEntries(entries);
      return;
    } catch (error) {
      if (error?.name !== "AbortError") {
        console.error(error);
        showToast("Не получилось открыть папку, пробую запасной вариант.");
      }
    }
  }

  dom.fallbackFolderInput.click();
}

async function importFromFiles() {
  if ("showOpenFilePicker" in window) {
    try {
      const handles = await window.showOpenFilePicker({
        multiple: true,
        types: [
          {
            description: "Audio files",
            accept: {
              "audio/*": [".mp3", ".wav", ".ogg", ".aac", ".m4a", ".flac", ".webm"]
            }
          }
        ]
      });
      const entries = handles.map((handle) => ({
        handle,
        relativePath: handle.name
      }));
      await importHandleEntries(entries);
      return;
    } catch (error) {
      if (error?.name !== "AbortError") {
        console.error(error);
        showToast("Не получилось открыть файлы, переключаюсь на запасной вариант.");
      }
    }
  }

  dom.fallbackFileInput.click();
}

async function collectDirectoryFiles(directoryHandle, parentPath, entries) {
  for await (const [name, handle] of directoryHandle.entries()) {
    if (handle.kind === "directory") {
      await collectDirectoryFiles(handle, joinPath(parentPath, name), entries);
      continue;
    }

    if (isAudioFile(name) || isImageFile(name)) {
      entries.push({
        handle,
        name,
        kind: isAudioFile(name) ? "audio" : "image",
        relativePath: joinPath(parentPath, name)
      });
    }
  }
}

async function importHandleEntries(entries) {
  const freshTracks = [];
  const knownFingerprints = new Set(state.library.map((track) => track.sourceFingerprint));

  // Pre-process images per directory
  const imageMap = new Map();
  for (const entry of entries) {
    if (entry.kind === "image") {
      const dirPath = entry.relativePath.substring(0, Math.max(0, entry.relativePath.lastIndexOf("/")));
      if (!imageMap.has(dirPath)) imageMap.set(dirPath, []);
      imageMap.get(dirPath).push(entry);
    }
  }

  for (const entry of entries) {
    if (entry.kind !== "audio") continue;

    const file = await entry.handle.getFile();
    const sourceFingerprint = createSourceFingerprint(file, entry.relativePath);

    if (knownFingerprints.has(sourceFingerprint)) {
      continue;
    }

    const track = await buildTrackRecord(file, {
      relativePath: entry.relativePath,
      sourceFingerprint,
      persistent: true
    });

    // Look for local artwork
    const dirPath = entry.relativePath.substring(0, Math.max(0, entry.relativePath.lastIndexOf("/")));
    const dirImages = imageMap.get(dirPath) || [];
    const baseName = entry.name.replace(/\.[^.]+$/, "");
    
    const bestImage = 
      dirImages.find(img => img.name.replace(/\.[^.]+$/, "") === baseName) ||
      dirImages.find(img => /cover|folder|album|front/i.test(img.name)) ||
      dirImages[0];

    if (bestImage) {
      await putHandle(track.id + "_artwork", bestImage.handle);
      track.artworkUrl = "local://" + track.id;
    }

    await putHandle(track.id, entry.handle);
    freshTracks.push(track);
    knownFingerprints.add(sourceFingerprint);
    void hydrateTrackDuration(track.id, file);
  }

  if (!freshTracks.length) {
    showToast("Новых треков не нашлось. Возможно, они уже импортированы.");
    return;
  }

  state.library = [...state.library, ...freshTracks].sort(sortTracks);
  saveState();
  render();
  void enrichLibraryMetadata(freshTracks.map((track) => track.id), { silent: true, limit: 9999 });
  showToast(`Добавлено ${freshTracks.length} ${pluralizeTracks(freshTracks.length)}.`);
}

async function importFallbackFiles(files, fromFolder) {
  const freshTracks = [];
  const knownFingerprints = new Set(state.library.map((track) => track.sourceFingerprint));

  for (const file of files) {
    if (!isAudioFile(file.name)) {
      continue;
    }

    const relativePath =
      fromFolder && file.webkitRelativePath ? file.webkitRelativePath : file.name;
    const sourceFingerprint = createSourceFingerprint(file, relativePath);
    if (knownFingerprints.has(sourceFingerprint)) {
      continue;
    }

    const track = await buildTrackRecord(file, {
      relativePath,
      sourceFingerprint,
      persistent: false
    });

    runtimeFiles.set(track.id, file);
    freshTracks.push(track);
    knownFingerprints.add(sourceFingerprint);
    void hydrateTrackDuration(track.id, file);
  }

  if (!freshTracks.length) {
    showToast("Новых треков не нашлось.");
    return;
  }

  state.library = [...state.library, ...freshTracks].sort(sortTracks);
  saveState();
  render();
  void enrichLibraryMetadata(freshTracks.map((track) => track.id), { silent: true, limit: 9999 });
  showToast("Файлы добавлены. После перезагрузки страницы запасной импорт придётся повторить.");
}

async function readBasicTags(file) {
  try {
    // Read the first 128KB which usually contains the ID3 header
    const buffer = await file.slice(0, 128 * 1024).arrayBuffer();
    const view = new DataView(buffer);
    
    // Check for ID3v2
    if (view.getUint8(0) !== 0x49 || view.getUint8(1) !== 0x44 || view.getUint8(2) !== 0x33) {
      return null;
    }

    const tags = {};
    let offset = 10; // Skip header
    const limit = view.byteLength - 10;

    while (offset < limit) {
      const frameId = String.fromCharCode(view.getUint8(offset), view.getUint8(offset+1), view.getUint8(offset+2), view.getUint8(offset+3));
      if (!/^[A-Z0-9]{4}$/.test(frameId)) break;

      // ID3v2.3 uses regular integers, v2.4 uses synchsafe. 
      // Most files are v2.3. Let's try regular first, then fallback.
      let frameSize = view.getUint32(offset + 4);
      const version = view.getUint8(3);
      if (version === 4) {
        frameSize = ((view.getUint8(offset+4) & 0x7f) << 21) | ((view.getUint8(offset+5) & 0x7f) << 14) | ((view.getUint8(offset+6) & 0x7f) << 7) | (view.getUint8(offset+7) & 0x7f);
      }
      
      offset += 10;

      if (frameSize <= 0 || offset + frameSize > view.byteLength) break;

      if (frameId === "TPE1" || frameId === "TALB" || frameId === "TIT2") {
        const encoding = view.getUint8(offset);
        let text = "";
        try {
          const data = new Uint8Array(buffer, offset + 1, frameSize - 1);
          if (encoding === 1 || encoding === 2) {
            text = new TextDecoder("utf-16").decode(data);
          } else if (encoding === 3) {
            text = new TextDecoder("utf-8").decode(data);
          } else {
            text = new TextDecoder("windows-1251").decode(data); // Common for Russian MP3s
          }
        } catch (err) {
          console.warn("Decoding error", err);
        }
        
        text = text.replace(/\0+$/, "").trim();
        if (frameId === "TPE1") tags.artist = text;
        if (frameId === "TALB") tags.album = text;
        if (frameId === "TIT2") tags.title = text;
      }

      offset += frameSize;
    }
    return tags;
  } catch (e) {
    return null;
  }
}

async function buildTrackRecord(file, options) {
  const baseName = file.name.replace(/\.[^.]+$/, "");
  const parsed = parseTrackDetails(baseName, options.relativePath);
  
  const tags = await readBasicTags(file);
  
  const artist = tags?.artist || parsed.artist;
  const album = tags?.album || parsed.album;
  const title = tags?.title || parsed.title;

  return {
    id: crypto.randomUUID(),
    title: title || baseName,
    artist: artist || "",
    album: album || "",
    duration: 0,
    fileName: file.name,
    relativePath: options.relativePath,
    artworkUrl: "",
    persistent: options.persistent,
    addedAt: Date.now(),
    sourceFingerprint: options.sourceFingerprint
  };
}

function createSourceFingerprint(file, relativePath) {
  return `${relativePath}::${file.size}::${file.lastModified}`;
}

function sortTracks(a, b) {
  return `${a.artist} ${a.title}`.localeCompare(`${b.artist} ${b.title}`, "ru", {
    sensitivity: "base"
  });
}

async function hydrateTrackDuration(trackId, file) {
  const duration = await readAudioDuration(file);
  const track = getTrackById(trackId);
  if (!track || !duration) {
    return;
  }
  track.duration = duration;
  saveState();
  renderSummary();
  renderTrackTable();
  renderPlayer();
}

function readAudioDuration(file) {
  return new Promise((resolve) => {
    const tempAudio = document.createElement("audio");
    const objectUrl = URL.createObjectURL(file);
    tempAudio.preload = "metadata";
    tempAudio.src = objectUrl;

    const finalize = (value) => {
      URL.revokeObjectURL(objectUrl);
      resolve(Number.isFinite(value) ? value : 0);
    };

    tempAudio.addEventListener("loadedmetadata", () => finalize(tempAudio.duration), {
      once: true
    });
    tempAudio.addEventListener("error", () => finalize(0), { once: true });
  });
}

async function handleTrackAction(event) {
  const button = event.target.closest("button[data-action]");
  if (!button) {
    return;
  }

  const trackId = button.dataset.trackId;
  const action = button.dataset.action;
  const filteredIds = getFilteredTracks().map((track) => track.id);

  if (action === "play") {
    await playTrack(trackId, filteredIds);
    return;
  }

  if (action === "queue") {
    enqueueTrack(trackId);
    return;
  }

  if (action === "favorite") {
    toggleFavorite(trackId);
    return;
  }

  if (action === "match") {
    if (state.spotifyMatches[trackId]) {
      await openMatchedTrackInSpotify(trackId);
      return;
    }
    await matchTrackToSpotify(trackId);
  }
}

async function handleQueueAction(event) {
  const button = event.target.closest("button[data-action='play-from-queue']");
  if (!button) {
    return;
  }
  await playTrack(button.dataset.trackId, state.queue.slice());
}

async function handleHistoryAction(event) {
  const button = event.target.closest("button[data-action='play-from-history']");
  if (!button) {
    return;
  }
  await playTrack(button.dataset.trackId, getFilteredTracks().map((track) => track.id));
}

function enqueueTrack(trackId) {
  if (!getTrackById(trackId)) {
    return;
  }
  state.queue = [...state.queue.filter((id) => id !== trackId), trackId];
  saveState();
  renderQueue();
  showToast("Трек добавлен в очередь.");
}

function toggleFavorite(trackId) {
  if (state.favorites.includes(trackId)) {
    state.favorites = state.favorites.filter((id) => id !== trackId);
  } else {
    state.favorites = [...state.favorites, trackId];
  }
  saveState();
  renderSummary();
  renderTrackTable();
}

async function resolveTrackFile(track) {
  if (runtimeFiles.has(track.id)) {
    return runtimeFiles.get(track.id);
  }

  const handle = await getHandle(track.id);
  if (!handle) {
    return null;
  }

  const permission = await handle.queryPermission({ mode: "read" });
  if (permission !== "granted") {
    const requested = await handle.requestPermission({ mode: "read" });
    if (requested !== "granted") {
      return null;
    }
  }

  return handle.getFile();
}

async function playTrack(trackId, contextIds = []) {
  const track = getTrackById(trackId);
  if (!track) {
    return;
  }

  const file = await resolveTrackFile(track);
  if (!file) {
    showToast("Файл недоступен. Попробуй импортировать его снова.");
    return;
  }

  if (currentObjectUrl) {
    URL.revokeObjectURL(currentObjectUrl);
  }

  currentObjectUrl = URL.createObjectURL(file);
  audio.src = currentObjectUrl;
  audio.currentTime = 0;
  await audio.play();

  state.currentTrackId = trackId;
  playbackRecordedTrackId = null;

  playContextIds = contextIds.length ? contextIds.slice() : state.library.map((item) => item.id);
  state.queue = state.queue.filter((id) => id !== trackId);
  saveState();
  render();
}

async function togglePlayPause() {
  if (!state.currentTrackId) {
    if (state.library.length) {
      await playTrack(state.library[0].id, getFilteredTracks().map((track) => track.id));
    } else {
      showToast("Сначала добавь музыку в библиотеку.");
    }
    return;
  }

  if (audio.paused) {
    await audio.play();
  } else {
    audio.pause();
  }
}

async function playNextTrack() {
  const queuedTrackId = state.queue[0];
  if (queuedTrackId) {
    state.queue = state.queue.slice(1);
    saveState();
    await playTrack(queuedTrackId, playContextIds);
    return;
  }

  const context = playContextIds.length ? playContextIds : getFilteredTracks().map((track) => track.id);
  const currentIndex = context.indexOf(state.currentTrackId);
  if (currentIndex >= 0 && currentIndex < context.length - 1) {
    await playTrack(context[currentIndex + 1], context);
    return;
  }

  showToast("Очередь закончилась.");
  audio.pause();
}

async function playPreviousTrack() {
  if (audio.currentTime > 5) {
    audio.currentTime = 0;
    return;
  }

  const context = playContextIds.length ? playContextIds : getFilteredTracks().map((track) => track.id);
  const currentIndex = context.indexOf(state.currentTrackId);
  if (currentIndex > 0) {
    await playTrack(context[currentIndex - 1], context);
  }
}

function seekPlayback() {
  if (!audio.duration) {
    return;
  }
  audio.currentTime = (Number(dom.progressInput.value) / 1000) * audio.duration;
  renderPlayer();
}

function handleTimeUpdate() {
  if (!state.currentTrackId) {
    return;
  }

  renderPlayer();

  if (playbackRecordedTrackId === state.currentTrackId) {
    return;
  }

  const shouldRecord = audio.currentTime >= Math.min(30, Math.max(8, (audio.duration || 0) * 0.45));
  if (!shouldRecord) {
    return;
  }

  playbackRecordedTrackId = state.currentTrackId;
  recordPlayback(state.currentTrackId).catch((error) => {
    console.error(error);
  });
}

function handleLoadedMetadata() {
  const track = getTrackById(state.currentTrackId);
  if (track && audio.duration && track.duration !== audio.duration) {
    track.duration = audio.duration;
    saveState();
    renderSummary();
    renderTrackTable();
  }
  renderPlayer();
}


function playRandomTrack() {
  if (!state.library.length) {
    showToast("Сначала добавь музыку в библиотеку.");
    return;
  }
  const pool = getFilteredTracks();
  const nextTrack = pool[Math.floor(Math.random() * pool.length)];
  if (nextTrack) {
    void playTrack(nextTrack.id, pool.map((track) => track.id));
  }
}

function resumeLastTrack() {
  if (!state.currentTrackId) {
    showToast("Последний трек ещё не выбран.");
    return;
  }
  void playTrack(state.currentTrackId, getFilteredTracks().map((track) => track.id));
}

async function clearLibrary() {
  const confirmed = window.confirm("Очистить библиотеку, очередь, историю и сохранённые ручки файлов?");
  if (!confirmed) {
    return;
  }

  if (currentObjectUrl) {
    URL.revokeObjectURL(currentObjectUrl);
    currentObjectUrl = null;
  }

  audio.pause();
  audio.removeAttribute("src");
  audio.load();
  runtimeFiles.clear();
  await clearHandles();
  state.library = [];
  state.currentTrackId = null;
  state.queue = [];
  state.history = [];
  state.favorites = [];
  state.spotifyMatches = {};
  playbackRecordedTrackId = null;
  playContextIds = [];
  saveState();
  render();
  showToast("Библиотека очищена.");
}

function withCurrentTrack(callback) {
  if (!state.currentTrackId) {
    showToast("Сначала запусти какой-нибудь трек.");
    return;
  }
  void callback(state.currentTrackId);
}

async function handleSpotifyRedirect() {
  const url = new URL(window.location.href);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  if (error) {
    showToast(`Spotify вернул ошибку: ${error}`);
    cleanupAuthQuery();
    return;
  }

  if (!code) {
    return;
  }

  const pkcePayload = JSON.parse(localStorage.getItem(PKCE_KEY) || "null");
  if (!pkcePayload?.codeVerifier || !state.settings.spotifyClientId || !state.settings.spotifyRedirectUri) {
    cleanupAuthQuery();
    showToast("Не удалось завершить Spotify-авторизацию.");
    return;
  }

  const body = new URLSearchParams({
    client_id: state.settings.spotifyClientId,
    grant_type: "authorization_code",
    code,
    redirect_uri: state.settings.spotifyRedirectUri,
    code_verifier: pkcePayload.codeVerifier
  });

  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });

  const payload = await response.json();
  if (!response.ok) {
    cleanupAuthQuery();
    showToast(payload.error_description || "Spotify не выдал токен.");
    return;
  }

  authState.accessToken = payload.access_token;
  authState.refreshToken = payload.refresh_token || authState.refreshToken;
  authState.expiresAt = Date.now() + payload.expires_in * 1000;
  saveAuth();
  localStorage.removeItem(PKCE_KEY);
  cleanupAuthQuery();
  showToast("Spotify подключён.");
}

function cleanupAuthQuery() {
  const cleanUrl = `${window.location.origin}${window.location.pathname}`;
  window.history.replaceState({}, document.title, cleanUrl);
}

async function connectSpotify() {
  saveSettingsFromForm();

  if (!state.settings.spotifyClientId) {
    showToast("Вставь Spotify Client ID.");
    return;
  }

  if (!state.settings.spotifyRedirectUri) {
    showToast("Укажи Redirect URI.");
    return;
  }

  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);
  const authUrl = new URL("https://accounts.spotify.com/authorize");

  localStorage.setItem(PKCE_KEY, JSON.stringify({ codeVerifier }));

  authUrl.search = new URLSearchParams({
    client_id: state.settings.spotifyClientId,
    response_type: "code",
    redirect_uri: state.settings.spotifyRedirectUri,
    scope: SPOTIFY_SCOPES,
    code_challenge_method: "S256",
    code_challenge: codeChallenge
  }).toString();

  window.location.href = authUrl.toString();
}

async function disconnectSpotify() {
  delete authState.accessToken;
  delete authState.refreshToken;
  delete authState.expiresAt;
  spotifyProfile = null;
  saveAuth();
  renderSpotifyPanel();
  showToast("Spotify отключён.");
}

async function restoreSpotifyProfile() {
  if (!authState?.accessToken) {
    return;
  }

  try {
    await ensureFreshSpotifyToken();
    spotifyProfile = await spotifyApi("/me");
  } catch (error) {
    console.error(error);
    spotifyProfile = null;
    delete authState.accessToken;
    delete authState.refreshToken;
    delete authState.expiresAt;
    saveAuth();
  }
}

async function ensureFreshSpotifyToken() {
  if (!authState?.accessToken) {
    throw new Error("Spotify is not connected.");
  }

  if (Date.now() < (authState.expiresAt || 0) - 30_000) {
    return;
  }

  if (!authState.refreshToken) {
    throw new Error("Spotify refresh token is missing.");
  }

  const body = new URLSearchParams({
    client_id: state.settings.spotifyClientId,
    grant_type: "refresh_token",
    refresh_token: authState.refreshToken
  });

  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error_description || "Spotify token refresh failed.");
  }

  authState.accessToken = payload.access_token;
  authState.refreshToken = payload.refresh_token || authState.refreshToken;
  authState.expiresAt = Date.now() + payload.expires_in * 1000;
  saveAuth();
}

async function spotifyApi(path, options = {}) {
  await ensureFreshSpotifyToken();

  const response = await fetch(`https://api.spotify.com/v1${path}`, {
    method: options.method || "GET",
    headers: {
      Authorization: `Bearer ${authState.accessToken}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  if (response.status === 204) {
    return null;
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error?.message || payload.error_description || "Spotify request failed.");
  }
  return payload;
}





function shouldEnrichTrackMetadata(track) {
  if (!track) {
    return false;
  }

  // If we don't have an artist, don't auto-enrich to avoid random matches
  if (!isUsefulMetadata(track.artist)) {
    return false;
  }

  return (
    !getTrackArtworkUrl(track) ||
    !isUsefulMetadata(track.album)
  );
}



async function ensureActivityPlaylist() {
  if (state.spotifyActivityPlaylistId) {
    return state.spotifyActivityPlaylistId;
  }

  const existing = await spotifyApi("/me/playlists?limit=50");
  const found = existing.items?.find((playlist) => playlist.name === ACTIVITY_PLAYLIST_NAME);
  if (found) {
    state.spotifyActivityPlaylistId = found.id;
    saveState();
    renderSpotifyPanel();
    return found.id;
  }

  const created = await spotifyApi("/me/playlists", {
    method: "POST",
    body: {
      name: ACTIVITY_PLAYLIST_NAME,
      public: false,
      description: "Auto-synced local listening history from Spoffline."
    }
  });

  state.spotifyActivityPlaylistId = created.id;
  saveState();
  renderSpotifyPanel();
  return created.id;
}

async function syncTrackToSpotifyActivity(trackId, silent = false) {
  if (!authState?.accessToken) {
    if (!silent) {
      showToast("Сначала подключи Spotify.");
    }
    return;
  }

  const match = await matchTrackToSpotify(trackId);
  if (!match?.uri) {
    if (!silent) {
      showToast("Сначала нужно найти совпадение в Spotify.");
    }
    return;
  }

  const playlistId = await ensureActivityPlaylist();
  await spotifyApi(`/playlists/${playlistId}/items`, {
    method: "POST",
    body: {
      uris: [match.uri]
    }
  });

  if (!silent) {
    showToast("Трек записан в плейлист активности Spotify.");
  }
}

async function playMatchedTrackOnSpotify(trackId) {
  if (!authState?.accessToken) {
    showToast("Сначала подключи Spotify.");
    return;
  }

  const match = await matchTrackToSpotify(trackId);
  if (!match?.uri) {
    showToast("Совпадение в Spotify не найдено.");
    return;
  }

  const devicesPayload = await spotifyApi("/me/player/devices");
  const device = devicesPayload.devices?.find((item) => !item.is_restricted);

  if (!device?.id) {
    showToast("Открой Spotify на телефоне, ПК или вебе, чтобы появился активный девайс.");
    return;
  }

  await spotifyApi(`/me/player/play?device_id=${encodeURIComponent(device.id)}`, {
    method: "PUT",
    body: {
      uris: [match.uri]
    }
  });

  showToast("Трек отправлен на Spotify-устройство. Так он уже появится как нативное Spotify-воспроизведение.");
}

function generateCodeVerifier() {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const values = crypto.getRandomValues(new Uint8Array(64));
  return values.reduce((acc, value) => acc + alphabet[value % alphabet.length], "");
}

async function generateCodeChallenge(codeVerifier) {
  const data = new TextEncoder().encode(codeVerifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function renderSpotifyPanel() {
  const matchedCount = state.library.filter((track) => Boolean(state.spotifyMatches[track.id]?.sourceUrl)).length;
  const artworkCount = state.library.filter((track) => Boolean(getTrackArtworkUrl(track))).length;
  dom.spotifyStatus.textContent = matchedCount ? "Активно" : "Готово";
  dom.spotifyStatus.className = matchedCount ? "status-pill online" : "status-pill";
  dom.spotifyAutoSync.checked = state.settings.metadataAutoEnrich;
  dom.spotifyAvatar.textContent = "MB";
  dom.spotifyDisplayName.textContent = "MusicBrainz + Cover Art Archive";
  dom.spotifyHint.textContent =
    "Spoffline подтягивает более чистые названия, артистов, альбомы и обложки через открытые музыкальные базы.";
  dom.spotifyPlaylistState.textContent = state.library.length
    ? `Метаданные найдены для ${matchedCount} из ${state.library.length} треков, обложки есть у ${artworkCount}.`
    : "Сначала импортируй музыку, а потом можно обновить данные и обложки.";
}

async function recordPlayback(trackId) {
  state.history = [
    { trackId, playedAt: Date.now() },
    ...state.history.filter((entry) => entry.trackId !== trackId)
  ].slice(0, HISTORY_LIMIT);
  saveState();
  renderHistory();

  if (shouldEnrichTrackMetadata(getTrackById(trackId))) {
    void enrichLibraryMetadata([trackId], { silent: true, limit: 1 });
  }
}

async function waitForMusicBrainzSlot() {
  const elapsed = Date.now() - lastMusicBrainzRequestAt;
  const waitMs = MUSICBRAINZ_LOOKUP_DELAY_MS - elapsed;
  if (waitMs > 0) {
    await new Promise((resolve) => window.setTimeout(resolve, waitMs));
  }
  lastMusicBrainzRequestAt = Date.now();
}

function stripFeaturingSuffix(value) {
  return cleanTrackText(value)
    .replace(/\s*\((?:feat|ft)\.?\s[^)]*(?:\)|$)/i, "")
    .replace(/\s*[-–—]\s*(?:feat|ft)\.?\s.+$/i, "")
    .trim();
}

async function fetchOpenMetadata(track) {
  await waitForMusicBrainzSlot();

  const params = new URLSearchParams();
  params.set("title", cleanTrackText(track.title || ""));

  const titleAlt = stripFeaturingSuffix(track.title || "");
  if (titleAlt && titleAlt !== cleanTrackText(track.title || "")) {
    params.set("titleAlt", titleAlt);
  }

  if (isUsefulMetadata(track.artist)) {
    params.set("artist", cleanTrackText(track.artist));
  }

  if (isUsefulMetadata(track.album)) {
    params.set("album", cleanTrackText(track.album));
  }

  if (Number.isFinite(track.duration) && track.duration > 0) {
    params.set("durationMs", String(Math.round(track.duration * 1000)));
  }

  const response = await fetch(`/api/metadata/search?${params.toString()}`, {
    headers: {
      Accept: "application/json"
    }
  });

  const payload = await response.json().catch(() => ({}));
  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error(payload.error || "Metadata request failed.");
  }

  return payload.match || null;
}

async function matchTrackToSpotify(trackId, options = {}) {
  const {
    silent = false,
    applyMetadata = true,
    force = false,
    rerender = true
  } = options;

  const track = getTrackById(trackId);
  if (!track) {
    return null;
  }

  const cachedMatch = state.spotifyMatches[trackId];
  const cachedMatchIsComplete = Boolean(cachedMatch?.artworkUrl || cachedMatch?.album || cachedMatch?.artist);
  const cachedMatchIsLegacySpotify = Boolean(cachedMatch?.url && !cachedMatch?.sourceUrl);

  if (
    cachedMatch &&
    !force &&
    !cachedMatchIsLegacySpotify &&
    (!applyMetadata || cachedMatchIsComplete || getTrackArtworkUrl(track))
  ) {
    if (applyMetadata) {
      applySpotifyMetadataToTrack(trackId, cachedMatch);
      saveState();
      if (rerender) {
        render();
      }
    }
    return cachedMatch;
  }

  if (!silent) {
    showToast("Ищу обложку и метаданные...");
  }

  try {
    const match = await fetchOpenMetadata(track);
    if (!match) {
      if (!silent) {
        showToast("Не нашёл уверенного совпадения в открытых базах.");
      }
      return null;
    }

    state.spotifyMatches[trackId] = match;
    if (applyMetadata) {
      applySpotifyMetadataToTrack(trackId, match);
    }
    saveState();
    if (rerender) {
      render();
    }
    if (!silent) {
      showToast("Данные найдены.");
    }
    return match;
  } catch (error) {
    console.error(error);
    if (!silent) {
      showToast("Не удалось обновить метаданные прямо сейчас.");
    }
    return null;
  }
}

async function enrichLibraryMetadata(trackIds = null, options = {}) {
  const {
    silent = true,
    limit = 20,
    force = false
  } = options;

  if (!force && !state.settings.metadataAutoEnrich) {
    return;
  }

  if (metadataEnrichmentInFlight) {
    return;
  }

  const candidates = (trackIds || state.library.map((track) => track.id))
    .map((id) => getTrackById(id))
    .filter(Boolean)
    .filter((track) => force || shouldEnrichTrackMetadata(track))
    .slice(0, limit);

  if (!candidates.length) {
    if (!silent) {
      showToast("Новых данных для обновления нет.");
    }
    return;
  }

  metadataEnrichmentInFlight = true;
  let enrichedCount = 0;

  try {
    for (let i = 0; i < candidates.length; i++) {
      const track = candidates[i];
      await matchTrackToSpotify(track.id, {
        silent: true,
        applyMetadata: true,
        force,
        rerender: false // Don't rerender every single track
      });
      enrichedCount += 1;

      // Render every 10 tracks to show progress without flickering
      if (enrichedCount % 10 === 0) {
        render();
      }
    }

    if (enrichedCount) {
      saveState();
      render();
      if (!silent) {
        showToast(`Обновлено ${enrichedCount} ${pluralizeTracks(enrichedCount)}.`);
      }
    } else if (!silent) {
      showToast("Точных совпадений пока не нашлось.");
    }
  } finally {
    metadataEnrichmentInFlight = false;
  }
}

function applySpotifyMetadataToTrack(trackId, match) {
  const track = getTrackById(trackId);
  if (!track || !match) {
    return false;
  }

  let changed = false;

  const nextTitle = cleanTrackText(match.title || track.title);
  const nextArtist = cleanTrackText(match.artist || track.artist);
  const nextAlbum = cleanTrackText(match.album || track.album);
  const nextArtworkUrl = match.artworkUrl || track.artworkUrl || "";

  if (nextTitle && track.title !== nextTitle) {
    track.title = nextTitle;
    changed = true;
  }

  if (isUsefulMetadata(nextArtist) && track.artist !== nextArtist) {
    track.artist = nextArtist;
    changed = true;
  }

  if (isUsefulMetadata(nextAlbum) && track.album !== nextAlbum) {
    track.album = nextAlbum;
    changed = true;
  }

  if (nextArtworkUrl && track.artworkUrl !== nextArtworkUrl) {
    track.artworkUrl = nextArtworkUrl;
    changed = true;
  }

  return changed;
}

async function openMatchedTrackInSpotify(trackId) {
  let match = await matchTrackToSpotify(trackId, { silent: true });
  if (match?.url && !match?.sourceUrl) {
    match = await matchTrackToSpotify(trackId, { silent: true, force: true });
  }

  const sourceUrl = match?.sourceUrl || match?.url;
  if (!sourceUrl) {
    showToast("Сначала найди данные для этого трека.");
    return;
  }
  window.open(sourceUrl, "_blank", "noopener");
}

function deriveLocalMetadata(track) {
  const baseName = String(track.fileName || "").replace(/\.[^.]+$/, "");
  const parsed = parseTrackDetails(baseName || track.title, track.relativePath || track.fileName || "");
  const pathBits = String(track.relativePath || "").split("/").filter(Boolean);
  const rawAlbum = pathBits.length > 1 ? pathBits[pathBits.length - 2] : "";

  return {
    title: parsed.title || "Без названия",
    artist: parsed.artist,
    album: sanitizeAlbumName(rawAlbum, parsed.title)
  };
}

async function clearTrackMetadata(trackId) {
  const track = getTrackById(trackId);
  if (!track) {
    return;
  }

  const fallback = deriveLocalMetadata(track);
  track.title = fallback.title;
  track.artist = fallback.artist;
  track.album = fallback.album;
  track.artworkUrl = "";
  delete state.spotifyMatches[trackId];
  saveState();
  render();
  showToast("Данные трека сброшены до локальной версии.");
}

function clearLibraryArtwork() {
  let clearedCount = 0;

  for (const track of state.library) {
    if (!track.artworkUrl) {
      continue;
    }
    track.artworkUrl = "";
    clearedCount += 1;
  }

  for (const [trackId, match] of Object.entries(state.spotifyMatches)) {
    if (!match?.artworkUrl) {
      continue;
    }
    state.spotifyMatches[trackId] = {
      ...match,
      artworkUrl: ""
    };
  }

  saveState();
  render();
  showToast(
    clearedCount
      ? `Очищены обложки у ${clearedCount} ${pluralizeTracks(clearedCount)}.`
      : "Обложки уже были пустыми."
  );
}

function showToast(message) {
  dom.toast.textContent = message;
  dom.toast.classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    dom.toast.classList.remove("is-visible");
  }, 2800);
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return "0:00";
  }
  const safeSeconds = Math.floor(seconds);
  const mins = Math.floor(safeSeconds / 60);
  const secs = safeSeconds % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

function formatLibraryDuration(seconds) {
  if (!seconds) {
    return "0 мин";
  }
  const minutes = Math.round(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (!hours) {
    return `${minutes} мин`;
  }
  return `${hours} ч ${restMinutes} мин`;
}

function pluralizeTracks(count) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) {
    return "трек";
  }
  if (mod10 >= 2 && mod10 <= 4 && !(mod100 >= 12 && mod100 <= 14)) {
    return "трека";
  }
  return "треков";
}

function formatPlayedAt(timestamp) {
  const date = new Date(timestamp);
  return `Слушал ${date.toLocaleDateString("ru-RU")} в ${date.toLocaleTimeString("ru-RU", {
    hour: "2-digit",
    minute: "2-digit"
  })}`;
}

const localArtworkCache = new Map();

function getTrackArtworkUrl(track) {
  if (!track) {
    return "";
  }
  const url = track.artworkUrl || state.spotifyMatches[track.id]?.artworkUrl || "";
  if (url.startsWith("local://")) {
    return localArtworkCache.get(track.id) || "";
  }
  return url;
}

async function resolveLocalArtwork(trackId) {
  if (localArtworkCache.has(trackId)) return;
  const handle = await getHandle(trackId + "_artwork");
  if (handle) {
    const file = await handle.getFile();
    const url = URL.createObjectURL(file);
    localArtworkCache.set(trackId, url);
    
    // Update any elements currently showing this track's artwork
    const elements = document.querySelectorAll(`[data-artwork-track-id="${trackId}"]`);
    elements.forEach(el => {
      el.classList.add("has-artwork");
      el.style.backgroundImage = `url("${escapeUrl(url)}")`;
      el.textContent = "";
    });
  }
}

function renderArtworkThumb(track, className, fallbackText = "♪") {
  const artworkUrl = getTrackArtworkUrl(track);
  if (track?.artworkUrl?.startsWith("local://") && !localArtworkCache.has(track.id)) {
    void resolveLocalArtwork(track.id);
  }
  
  const hasArt = !!artworkUrl;
  const style = hasArt ? `style="background-image: url('${escapeUrl(artworkUrl)}')" ` : "";
  const classList = `${className} ${hasArt ? "has-artwork" : ""}`;
  
  return `<div class="${classList}" ${style} data-artwork-track-id="${track.id}">${hasArt ? "" : escapeHtml(fallbackText)}</div>`;
}

function renderHeroArtTile(track) {
  const artworkUrl = getTrackArtworkUrl(track);
  const hasArt = !!artworkUrl;
  const style = hasArt ? `style="background-image: url('${escapeUrl(artworkUrl)}')" ` : "";
  const classList = `art-tile ${hasArt ? "has-artwork" : ""}`;
  
  return `<div class="${classList}" ${style} data-artwork-track-id="${track.id}"></div>`;
}

function applyArtworkToElement(element, track, fallbackText, palette = null) {
  const artworkUrl = getTrackArtworkUrl(track);
  element.setAttribute("data-artwork-track-id", track.id);
  
  if (track?.artworkUrl?.startsWith("local://") && !localArtworkCache.has(track.id)) {
    void resolveLocalArtwork(track.id);
  }
  if (artworkUrl) {
    element.classList.add("has-artwork");
    element.style.backgroundImage = `url("${escapeUrl(artworkUrl)}")`;
    element.textContent = "";
    return;
  }

  element.classList.remove("has-artwork");
  element.style.backgroundImage = "";
  element.textContent = fallbackText;
  if (palette) {
    element.style.setProperty("--cover-a", palette.a);
    element.style.setProperty("--cover-b", palette.b);
  }
}

function getFileLabel(track) {
  return cleanTrackText(track.fileName || track.title || "Локальный файл");
}

function getPathLabel(track) {
  const relativePath = track.relativePath || "";
  if (!relativePath.includes("/")) {
    return "Импортирован локально";
  }

  const parts = relativePath.split("/").filter(Boolean);
  const folderPath = parts.slice(0, -1).map((part) => cleanTrackText(part)).filter(Boolean).join(" / ");
  return folderPath || "Импортирован локально";
}

function initialsForTrack(track) {
  return initialsFromText(`${track.title} ${getArtistLabel(track)}`);
}

function initialsFromText(text) {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || "")
    .join("") || "SO";
}

function paletteFromTrack(track) {
  const seed = hashString(`${track.title}:${track.artist}:${track.album}`);
  const hueA = seed % 360;
  const hueB = (seed * 1.6 + 75) % 360;
  return {
    a: `hsl(${hueA} 82% 76%)`,
    b: `hsl(${hueB} 78% 56%)`
  };
}

function hashString(value) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index);
    hash |= 0;
  }
  return Math.abs(hash);
}

function joinPath(prefix, name) {
  return prefix ? `${prefix}/${name}` : name;
}

function isAudioFile(name) {
  return /\.(mp3|wav|ogg|aac|m4a|flac|webm)$/i.test(name);
}

function isImageFile(name) {
  return /\.(png|jpe?g|webp|gif|bmp)$/i.test(name);
}

function parseTrackDetails(baseName, relativePath) {
  const cleanedBaseName = cleanTrackText(baseName);
  const pathBits = relativePath.split("/").filter(Boolean);
  
  let artist = "";
  let album = "";
  let title = cleanedBaseName;

  // 1. Try splitting "Artist - Title" from filename
  const dashedParts = cleanedBaseName.split(/\s[-–—]\s(.+)/).filter(Boolean);
  if (dashedParts.length > 1) {
    artist = cleanTrackText(dashedParts[0]);
    title = cleanTrackText(dashedParts[1]) || cleanedBaseName;
  }

  // 2. Extract metadata from folder structure (e.g., Artist/Album/Track.mp3)
  if (pathBits.length >= 3) {
    const folderAlbum = cleanTrackText(pathBits[pathBits.length - 2]);
    const folderArtist = cleanTrackText(pathBits[pathBits.length - 3]);
    if (!artist && isUsefulMetadata(folderArtist)) artist = folderArtist;
    if (!album && isUsefulMetadata(folderAlbum)) album = folderAlbum;
  } else if (pathBits.length === 2) {
    const parentFolder = cleanTrackText(pathBits[pathBits.length - 2]);
    if (isUsefulMetadata(parentFolder) && parentFolder !== cleanedBaseName) {
      // If only one folder level, it might be Artist OR Album. 
      // We'll treat it as artist for now, server fallback will handle if it's an album.
      if (!artist) artist = parentFolder;
    }
  }

  // 3. Extract and MERGE "feat." artists from title
  const featMatch = baseName.match(/\s\((?:feat|ft)\.?\s([^)]+)(?:\)|$)/i);
  if (featMatch) {
    const featArtist = cleanTrackText(featMatch[1]);
    if (artist) {
      if (!artist.toLowerCase().includes(featArtist.toLowerCase())) {
        artist += " feat. " + featArtist;
      }
    } else {
      artist = featArtist;
    }
  }

  return {
    artist: artist || "",
    album: album || "",
    title: title || "Без названия"
  };
}

function cleanTrackText(value) {
  return String(value || "")
    .replace(/\.(mp3|wav|ogg|aac|m4a|flac|webm)$/i, "")
    .replace(/^\d{1,2}\s*[-_.)(\]]\s*/g, "")
    .replace(/\s*\[(?:[A-Za-z0-9_-]{6,}|official.*?|audio|video|lyrics?)\]\s*$/i, "")
    .replace(/\s*\((?:official.*?|audio|video|lyrics?)\)\s*$/i, "")
    .replace(/[_]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function sanitizeAlbumName(rawAlbum, title) {
  const cleanedAlbum = cleanTrackText(rawAlbum);
  if (!isUsefulMetadata(cleanedAlbum)) {
    return "";
  }
  if (cleanedAlbum.toLowerCase() === cleanTrackText(title).toLowerCase()) {
    return "";
  }
  return cleanedAlbum;
}

function isUsefulMetadata(value) {
  if (!value) {
    return false;
  }
  const lowered = value.toLowerCase();
  return lowered !== "unknown album" && lowered !== "unknown artist" && lowered !== "unknown";
}

function getArtistLabel(track) {
  return isUsefulMetadata(track.artist) ? track.artist : "Не указан";
}

function getAlbumLabel(track) {
  return isUsefulMetadata(track.album) ? track.album : "Локальный файл";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeUrl(value) {
  return String(value).replaceAll('"', "%22").replaceAll("'", "%27");
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(HANDLE_STORE)) {
        request.result.createObjectStore(HANDLE_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function putHandle(key, handle) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(HANDLE_STORE, "readwrite");
    transaction.objectStore(HANDLE_STORE).put(handle, key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

async function getHandle(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(HANDLE_STORE, "readonly");
    const request = transaction.objectStore(HANDLE_STORE).get(key);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

async function clearHandles() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(HANDLE_STORE, "readwrite");
    transaction.objectStore(HANDLE_STORE).clear();
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}
