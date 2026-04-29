const STORAGE_KEY = "spoffline-state-v1";
const DB_NAME = "spoffline-handle-db";
const DB_VERSION = 1;
const HANDLE_STORE = "track-handles";
const HISTORY_LIMIT = 18;
const MUSICBRAINZ_LOOKUP_DELAY_MS = 1100;

const runtimeFiles = new Map();
const audio = new Audio();
audio.preload = "auto";
audio.volume = 0.85;

let toastTimer = null;
let currentObjectUrl = null;
let playContextIds = [];
let playbackRecordedTrackId = null;
let metadataEnrichmentInFlight = false;
let lastMusicBrainzRequestAt = 0;

const dom = {};

function populateDom() {
  dom.addFolderBtn = document.querySelector("#add-folder-btn");
  dom.addFilesBtn = document.querySelector("#add-files-btn");
  dom.clearLibraryBtn = document.querySelector("#clear-library-btn");
  dom.playRandomBtn = document.querySelector("#play-random-btn");
  dom.resumeLastBtn = document.querySelector("#resume-last-btn");
  dom.searchInput = document.querySelector("#search-input");
  dom.favoritesOnly = document.querySelector("#favorites-only");
  dom.trackList = document.querySelector("#track-list");
  dom.emptyState = document.querySelector("#empty-state");
  dom.filterSummary = document.querySelector("#filter-summary");
  dom.libraryCount = document.querySelector("#library-count");
  dom.libraryDuration = document.querySelector("#library-duration");
  dom.favoritesCount = document.querySelector("#favorites-count");
  dom.heroTitle = document.querySelector("#hero-title");
  dom.heroSubtitle = document.querySelector("#hero-subtitle");
  dom.playlistArtGrid = document.querySelector("#playlist-art-grid");
  dom.playlistArtFallback = document.querySelector("#playlist-art-fallback");
  dom.queueList = document.querySelector("#queue-list");
  dom.queueCount = document.querySelector("#queue-count");
  dom.historyList = document.querySelector("#history-list");
  dom.coverArt = document.querySelector("#cover-art");
  dom.nowTitle = document.querySelector("#now-title");
  dom.nowArtist = document.querySelector("#now-artist");
  dom.nowTimeCurrent = document.querySelector("#now-time-current");
  dom.nowTimeTotal = document.querySelector("#now-time-total");
  dom.progressInput = document.querySelector("#progress-input");
  dom.prevBtn = document.querySelector("#prev-btn");
  dom.playPauseBtn = document.querySelector("#play-pause-btn");
  dom.nextBtn = document.querySelector("#next-btn");
  dom.volumeInput = document.querySelector("#volume-input");
  dom.toast = document.querySelector("#toast");
  dom.fallbackFolderInput = document.querySelector("#fallback-folder-input");
  dom.fallbackFileInput = document.querySelector("#fallback-file-input");
  dom.emptyAddFolderBtn = document.querySelector("#empty-add-folder-btn");
  dom.emptyAddFilesBtn = document.querySelector("#empty-add-files-btn");
  dom.shuffleBtn = document.querySelector("#shuffle-btn");
  dom.repeatBtn = document.querySelector("#repeat-btn");
  dom.playerHeartBtn = document.querySelector("#player-heart-btn");
  dom.railHomeBtn = document.querySelector("#rail-home-btn");
  dom.railSearchBtn = document.querySelector("#rail-search-btn");
  dom.railLibraryBtn = document.querySelector("#rail-library-btn");
  dom.navBackBtn = document.querySelector("#nav-back-btn");
  dom.navForwardBtn = document.querySelector("#nav-forward-btn");
  dom.collectionPills = document.querySelector("#collection-pills");
  dom.shortcutLiked = document.querySelector("#shortcut-liked");
  dom.shortcutHistory = document.querySelector("#shortcut-history");
  dom.heroPlayBtnMobile = document.querySelector("#hero-play-btn-mobile");
  dom.newPlaylistBtn = document.querySelector("#new-playlist-btn");
}

const state = loadState();



async function init() {
  populateDom();
  await restoreFolderHandles();
  normalizeLibraryRecords();
  bindUi();
  render();
  void fixMissingDurations();
  void enrichLibraryMetadata(null, { silent: true, limit: 9999 });
}

async function restoreFolderHandles() {
  // We look for any track that was marked as persistent
  const persistentTracks = state.library.filter(t => t.persistent);
  if (!persistentTracks.length) return;

  // Try to restore the root handle if we have one
  const rootHandle = await getHandle("library_root");
  if (rootHandle) {
    try {
      // Browsers often require a user gesture to re-request permission, 
      // but we can at least try to get the files if permission was already granted.
      const permission = await rootHandle.queryPermission({ mode: "read" });
      if (permission === "granted") {
        const entries = [];
        await collectDirectoryFiles(rootHandle, "", entries);
        await importHandleEntries(entries);
      }
    } catch (e) {
      console.warn("Could not restore folder handle:", e);
    }
  }
}

async function fixMissingDurations() {
  const tracksToFix = state.library.filter(t => !t.duration || t.duration === 0);
  if (!tracksToFix.length) return;
  
  for (const track of tracksToFix) {
    const file = await resolveTrackFile(track);
    if (file) {
      void hydrateTrackDuration(track.id, file);
      // Small delay to avoid blocking
      await new Promise(r => setTimeout(r, 100));
    }
  }
}

function bindUi() {
  if (dom.searchInput) {
    dom.searchInput.value = state.searchQuery;
    dom.searchInput.addEventListener("input", () => {
      state.searchQuery = dom.searchInput.value.trim();
      saveState();
      renderSummary();
      renderTrackTable();
    });
  }

  if (dom.favoritesOnly) {
    dom.favoritesOnly.checked = state.favoritesOnly;
    dom.favoritesOnly.addEventListener("change", () => {
      state.favoritesOnly = dom.favoritesOnly.checked;
      saveState();
      renderSummary();
      renderTrackTable();
    });
  }

  if (dom.volumeInput) {
    dom.volumeInput.value = String(state.volume);
    audio.volume = state.volume;
    dom.volumeInput.style.setProperty("--volume-progress", `${state.volume * 100}%`);
    dom.volumeInput.addEventListener("input", () => {
      const vol = Number(dom.volumeInput.value);
      state.volume = vol;
      audio.volume = vol;
      dom.volumeInput.style.setProperty("--volume-progress", `${vol * 100}%`);
      saveState();
    });
  }

  const heroMetaItems = document.querySelectorAll(".hero-meta span");
  if (heroMetaItems[2]) {
    heroMetaItems[2].textContent = "Открытые обложки и релизы";
  }

  dom.addFolderBtn?.addEventListener("click", importFromFolder);
  dom.addFilesBtn?.addEventListener("click", importFromFiles);
  dom.clearLibraryBtn?.addEventListener("click", clearLibrary);
  dom.playRandomBtn?.addEventListener("click", playRandomTrack);
  dom.heroPlayBtnMobile?.addEventListener("click", playRandomTrack);
  dom.newPlaylistBtn?.addEventListener("click", createPlaylist);
  dom.resumeLastBtn?.addEventListener("click", resumeLastTrack);
  
  dom.emptyAddFolderBtn?.addEventListener("click", importFromFolder);
  dom.emptyAddFilesBtn?.addEventListener("click", importFromFiles);


  dom.trackList?.addEventListener("click", handleTrackAction);
  dom.queueList?.addEventListener("click", handleQueueAction);
  dom.historyList?.addEventListener("click", handleHistoryAction);

  // Library menu toggle
  const libToggle = document.querySelector("#lib-add-toggle");
  const libMenu = document.querySelector("#library-menu");
  
  if (libToggle && libMenu) {
    libToggle.addEventListener("click", (e) => {
      e.stopPropagation();
      libMenu.classList.toggle("is-visible");
    });

    document.addEventListener("click", (e) => {
      if (!libMenu.contains(e.target) && !libToggle.contains(e.target)) {
        libMenu.classList.remove("is-visible");
      }
    });
  }

  libMenu?.addEventListener("click", (e) => e.stopPropagation());

  dom.playPauseBtn?.addEventListener("click", togglePlayPause);
  dom.prevBtn?.addEventListener("click", playPreviousTrack);
  dom.nextBtn?.addEventListener("click", playNextTrack);
  dom.shuffleBtn?.addEventListener("click", toggleShuffle);
  dom.repeatBtn?.addEventListener("click", toggleRepeat);
  dom.playerHeartBtn?.addEventListener("click", () => {
    if (state.currentTrackId) toggleFavorite(state.currentTrackId);
  });

  dom.railHomeBtn?.addEventListener("click", () => {
    state.searchQuery = "";
    state.favoritesOnly = false;
    if (dom.searchInput) dom.searchInput.value = "";
    if (dom.favoritesOnly) dom.favoritesOnly.checked = false;
    saveState();
    render();
    window.scrollTo({ top: 0, behavior: "smooth" });
    pushNavigationHistory();
  });

  dom.railSearchBtn?.addEventListener("click", () => dom.searchInput?.focus());

  dom.railLibraryBtn?.addEventListener("click", () => {
    document.querySelector(".track-panel")?.scrollIntoView({ behavior: "smooth" });
  });

  dom.collectionPills?.addEventListener("click", (e) => {
    const pill = e.target.closest(".collection-pill");
    if (!pill) return;
    
    const filter = pill.dataset.filter;
    if (filter === "favorites") {
      state.viewMode = "tracks";
      state.favoritesOnly = true;
      if (dom.favoritesOnly) dom.favoritesOnly.checked = true;
    } else if (filter === "playlists") {
      state.viewMode = "playlists";
      state.favoritesOnly = false;
    } else if (filter === "all") {
      state.viewMode = "tracks";
      state.favoritesOnly = false;
      if (dom.favoritesOnly) dom.favoritesOnly.checked = false;
    } else if (filter === "history") {
      document.querySelector("#history-section")?.scrollIntoView({ behavior: "smooth" });
      return;
    }
    
    saveState();
    render();
    pushNavigationHistory();
  });

  dom.shortcutLiked?.addEventListener("click", () => {
    state.favoritesOnly = true;
    if (dom.favoritesOnly) dom.favoritesOnly.checked = true;
    saveState();
    render();
    pushNavigationHistory();
  });

  dom.shortcutHistory?.addEventListener("click", () => {
    document.querySelector("#history-section")?.scrollIntoView({ behavior: "smooth" });
  });

  dom.navBackBtn?.addEventListener("click", () => navigateHistory(-1));
  dom.navForwardBtn?.addEventListener("click", () => navigateHistory(1));

  // Bottom Nav Mobile
  const bottomNavItems = document.querySelectorAll(".nav-item");
  bottomNavItems.forEach(item => {
    item.addEventListener("click", () => {
      const tab = item.dataset.tab;
      bottomNavItems.forEach(i => i.classList.remove("active"));
      item.classList.add("active");
      
      if (tab === "home") {
        state.searchQuery = "";
        state.favoritesOnly = false;
        render();
        window.scrollTo({ top: 0, behavior: "smooth" });
      } else if (tab === "search") {
        dom.searchInput?.focus();
      } else if (tab === "library") {
        document.querySelector(".track-panel")?.scrollIntoView({ behavior: "smooth" });
      }
    });
  });

  dom.progressInput?.addEventListener("input", seekPlayback);

  dom.fallbackFolderInput?.addEventListener("change", async (event) => {
    const files = Array.from(event.target.files || []);
    if (files.length) {
      await importFallbackFiles(files, true);
      dom.fallbackFolderInput.value = "";
    }
  });

  dom.fallbackFileInput?.addEventListener("change", async (event) => {
    const files = Array.from(event.target.files || []);
    if (files.length) {
      await importFallbackFiles(files, false);
      dom.fallbackFileInput.value = "";
    }
  });

  audio.addEventListener("timeupdate", () => {
    handleTimeUpdate();
    if (audio.duration && audio.currentTime > audio.duration / 2) {
      void preloadNextTrack();
    }
  });
  audio.addEventListener("ended", playNextTrack);
  audio.addEventListener("loadedmetadata", handleLoadedMetadata);
  audio.addEventListener("play", () => renderPlayer());
  audio.addEventListener("pause", () => renderPlayer());
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
      shuffle: Boolean(parsed.shuffle),
      repeat: ["off", "one", "all"].includes(parsed.repeat) ? parsed.repeat : "off",
      volume: typeof parsed.volume === "number" ? parsed.volume : 0.85,
      settings: {
        metadataAutoEnrich: parsed.settings?.metadataAutoEnrich ?? parsed.settings?.spotifyAutoSync ?? true
      },
      viewMode: parsed.viewMode || "tracks",
      navigationHistory: Array.isArray(parsed.navigationHistory) ? parsed.navigationHistory : [],
      navigationPointer: typeof parsed.navigationPointer === "number" ? parsed.navigationPointer : -1,
      playlists: Array.isArray(parsed.playlists) ? parsed.playlists : []
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
      shuffle: false,
      repeat: "off",
      volume: 0.85,
      settings: {
        metadataAutoEnrich: true
      },
      navigationHistory: [],
      navigationPointer: -1,
      playlists: []
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

  const mainTrack = artTracks[0];
  const palette = paletteFromTrack(mainTrack);
  const heroPanel = document.querySelector(".hero-panel");
  if (heroPanel && palette) {
    heroPanel.style.setProperty("--hero-color", palette.main);
  }
}

function renderTrackTable() {
  if (state.viewMode === "playlists") {
    renderPlaylistsGrid();
    return;
  }

  const filteredTracks = getFilteredTracks();
  const currentTrackId = state.currentTrackId;
  dom.trackList.innerHTML = filteredTracks
    .map((track, index) => {
      const isCurrent = currentTrackId === track.id;
      const isFavorite = state.favorites.includes(track.id);
      const artistLabel = getArtistLabel(track);
      const albumLabel = getAlbumLabel(track);

      return `
        <tr class="track-row ${isCurrent ? "is-current" : ""}" data-track-id="${track.id}">
          <td class="cell-order">
            <span class="track-index">${index + 1}</span>
            <button class="row-play-btn" data-action="play">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
            </button>
          </td>
          <td class="cell-main">
            <div class="track-main">
              ${renderArtworkThumb(track, "track-thumb", initialsForTrack(track))}
              <div class="track-title">
                <strong>${escapeHtml(track.title)}</strong>
                <span class="track-subline">${escapeHtml(artistLabel)}</span>
              </div>
            </div>
          </td>
          <td class="cell-album">${escapeHtml(albumLabel || "-")}</td>
          <td class="cell-heart">
            <div class="cell-actions">
               <button class="heart-btn-table ${isFavorite ? "is-favorite" : ""}" data-action="favorite" data-track-id="${track.id}">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>
              </button>
              <button class="more-btn" data-action="add-to-playlist" data-track-id="${track.id}">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></svg>
              </button>
            </div>
          </td>
          <td class="cell-time">${formatDuration(track.duration || 0)}</td>
        </tr>
      `;
    })
    .join("");

  const isEmpty = !filteredTracks.length;
  dom.emptyState.classList.toggle("is-visible", isEmpty);

  if (isEmpty) {
    const emptyTitle = dom.emptyState.querySelector("h4");
    const emptyDesc = dom.emptyState.querySelector("p");
    const emptyActions = dom.emptyState.querySelector(".empty-actions");

    if (state.favoritesOnly) {
      emptyTitle.textContent = "В избранном пока пусто";
      emptyDesc.textContent = "Нажми на сердечко у любого трека, чтобы он появился здесь. Твоя любимая музыка всегда будет под рукой.";
      emptyActions.style.display = "none";
    } else if (state.searchQuery) {
      emptyTitle.textContent = "Ничего не нашлось";
      emptyDesc.textContent = `По запросу "${state.searchQuery}" ничего не найдено. Попробуй изменить запрос или проверь библиотеку.`;
      emptyActions.style.display = "none";
    } else {
      emptyTitle.textContent = "Твоя музыка ждет тебя";
      emptyDesc.textContent = "Spoffline воспроизводит музыку прямо из твоих локальных папок. Никаких загрузок на сервер — всё остается у тебя.";
      emptyActions.style.display = "flex";
    }
  }

  dom.filterSummary.textContent = filteredTracks.length
    ? `${filteredTracks.length} ${pluralizeTracks(filteredTracks.length)} в текущем списке`
    : (state.favoritesOnly ? "Список избранного пуст" : "Ничего не найдено");
}

function renderPlaylistsGrid() {
  if (!state.playlists.length) {
    dom.trackList.innerHTML = `<tr><td colspan="5" style="text-align:center; padding: 40px; color: var(--text-soft);">
      У вас пока нет плейлистов. Создайте первый, нажав на "+" в Медиатеке.
    </td></tr>`;
    return;
  }

  dom.trackList.innerHTML = state.playlists.map(pl => `
    <tr class="track-row playlist-row" data-playlist-id="${pl.id}">
      <td class="cell-order">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M3 12h18M3 6h18M3 18h18"/>
        </svg>
      </td>
      <td class="cell-main">
        <div class="track-main">
          <div class="track-thumb playlist-thumb">PL</div>
          <div class="track-title">
            <strong>${escapeHtml(pl.name)}</strong>
            <span class="track-subline">${pl.trackIds.length} треков</span>
          </div>
        </div>
      </td>
      <td class="cell-album">Персональный плейлист</td>
      <td class="cell-heart">
        <button class="table-btn" data-action="play-playlist" data-playlist-id="${pl.id}">Слушать</button>
      </td>
      <td class="cell-time"></td>
    </tr>
  `).join("");

  dom.filterSummary.textContent = `${state.playlists.length} плейлистов создано`;
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
    : '<p class="helper">Очередь пока пустая.</p>';
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
    : '<p class="helper">История пока пуста.</p>';
}

function renderPlayer() {
  const track = getTrackById(state.currentTrackId);
  if (!track) {
    dom.nowTitle.textContent = "Ничего не играет";
    dom.nowArtist.textContent = "Импортируй библиотеку, чтобы начать";
    dom.coverArt.classList.remove("has-artwork");
    dom.coverArt.style.backgroundImage = "";
    dom.coverArt.textContent = "SO";
    dom.coverArt.style.setProperty("--cover-a", "#d8fd96");
    dom.coverArt.style.setProperty("--cover-b", "#89df34");
    dom.nowTimeCurrent.textContent = "0:00";
    dom.nowTimeTotal.textContent = "0:00";
    dom.progressInput.value = "0";
    dom.playPauseBtn.innerHTML = `<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`;
    return;
  }

  const palette = paletteFromTrack(track);
  dom.nowTitle.textContent = track.title;
  dom.nowArtist.textContent = getArtistLabel(track);
  applyArtworkToElement(dom.coverArt, track, initialsForTrack(track), palette);
  
  const glowEl = document.querySelector(".player-glow");
  if (glowEl) {
    glowEl.style.setProperty("--glow-color", palette ? palette.a : "transparent");
  }

  // Set on the dock itself so mobile CSS can pick it up
  const dockEl = document.querySelector(".player-dock");
  if (dockEl) {
    const artworkUrl = getTrackArtworkUrl(track);
    if (artworkUrl) {
      extractDominantColor(artworkUrl).then(color => {
        if (color && state.currentTrackId === track.id) {
          dockEl.style.setProperty("--glow-color", color);
          if (glowEl) glowEl.style.setProperty("--glow-color", color);
        }
      });
    }
    dockEl.style.setProperty("--glow-color", palette ? palette.a : "#282828");
  }

  dom.nowTimeCurrent.textContent = formatDuration(audio.currentTime || 0);
  dom.nowTimeTotal.textContent = formatDuration(audio.duration || track.duration || 0);
  const progressValue = audio.duration ? (audio.currentTime / audio.duration) * 100 : 0;
  dom.progressInput.value = String(progressValue * 10);
  dom.progressInput.style.setProperty("--progress", `${progressValue}%`);
  
  const isPlaying = !audio.paused;
  dom.playPauseBtn.innerHTML = isPlaying 
    ? `<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>`
    : `<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`;

  // Update Shuffle/Repeat styles
  dom.shuffleBtn.classList.toggle("is-active", state.shuffle);
  dom.repeatBtn.classList.toggle("is-active", state.repeat !== "off");
  if (state.repeat === "one") {
    dom.repeatBtn.classList.add("repeat-one");
  } else {
    dom.repeatBtn.classList.remove("repeat-one");
  }

  // Update heart btn
  const isFavorite = state.favorites.includes(state.currentTrackId);
  dom.playerHeartBtn.classList.toggle("is-favorite", isFavorite);

  // Update pills
  if (dom.collectionPills) {
    const pills = dom.collectionPills.querySelectorAll(".collection-pill");
    pills.forEach(p => {
      const filter = p.dataset.filter;
      const active = (filter === "favorites" && state.favoritesOnly) || (filter === "all" && !state.favoritesOnly);
      p.classList.toggle("active", active);
    });
  }

  updateNavButtons();
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
      await putHandle("library_root", directoryHandle);
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
  return probeDuration(file);
}

async function handleTrackAction(event) {
  const row = event.target.closest(".track-row");
  if (!row) return;

  const trackId = row.dataset.trackId;
  const playlistId = row.dataset.playlistId;
  const actionBtn = event.target.closest("[data-action]");
  const action = actionBtn ? actionBtn.dataset.action : "play";
  const filteredIds = getFilteredTracks().map((track) => track.id);

  if (action === "favorite") {
    toggleFavorite(trackId);
  } else if (action === "play") {
    await playTrack(trackId, filteredIds);
  } else if (action === "add-to-playlist") {
    if (!state.playlists.length) {
      showToast("Сначала создайте плейлист в Медиатеке.");
      return;
    }
    const names = state.playlists.map((p, i) => `${i+1}. ${p.name}`).join("\n");
    const choice = window.prompt(`Добавить в плейлист (введите номер):\n${names}`);
    const index = parseInt(choice) - 1;
    if (state.playlists[index]) {
      addTrackToPlaylist(trackId, state.playlists[index].id);
    }
  } else if (action === "play-playlist") {
    const playlist = state.playlists.find(p => p.id === playlistId);
    if (playlist && playlist.trackIds.length) {
      playTrack(playlist.trackIds[0], playlist.trackIds);
    } else {
      showToast("В этом плейлисте пока нет треков.");
    }
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

function createPlaylist() {
  const name = window.prompt("Введите название плейлиста:", "Мой плейлист");
  if (!name || !name.trim()) return;

  const id = "pl_" + Date.now();
  state.playlists.push({
    id,
    name: name.trim(),
    trackIds: [],
    createdAt: Date.now()
  });
  saveState();
  render();
  showToast(`Плейлист "${name}" создан.`);
}

function addTrackToPlaylist(trackId, playlistId) {
  const playlist = state.playlists.find(p => p.id === playlistId);
  if (!playlist) return;
  
  if (playlist.trackIds.includes(trackId)) {
    showToast("Трек уже есть в этом плейлисте.");
    return;
  }
  
  playlist.trackIds.push(trackId);
  saveState();
  showToast(`Добавлено в "${playlist.name}".`);
}

const fileCache = new Map();

async function resolveTrackFile(track) {
  if (runtimeFiles.has(track.id)) {
    return runtimeFiles.get(track.id);
  }
  
  if (fileCache.has(track.id)) {
    return fileCache.get(track.id);
  }

  const handle = await getHandle(track.id);
  if (!handle) {
    return null;
  }

  try {
    const permission = await handle.queryPermission({ mode: "read" });
    if (permission !== "granted") {
      // We can't request permission automatically here as it requires user gesture,
      // but we can try to use what we have.
    }

    const file = await handle.getFile();
    // Cache the file object for the session to avoid repeated handle.getFile() calls
    fileCache.set(track.id, file);
    return file;
  } catch (e) {
    console.warn("Failed to get file from handle:", e);
    return null;
  }
}

let preloadedTrackId = null;
let preloadedObjectUrl = null;

async function preloadNextTrack() {
  const context = playContextIds.length ? playContextIds : getFilteredTracks().map((track) => track.id);
  const currentIndex = context.indexOf(state.currentTrackId);
  let nextTrackId = null;

  if (state.queue.length > 0) {
    nextTrackId = state.queue[0];
  } else if (currentIndex >= 0 && currentIndex < context.length - 1) {
    nextTrackId = context[currentIndex + 1];
  } else if (state.repeat === "all" && context.length > 0) {
    nextTrackId = context[0];
  }

  if (!nextTrackId || nextTrackId === preloadedTrackId || nextTrackId === state.currentTrackId) {
    return;
  }

  const track = getTrackById(nextTrackId);
  if (!track) return;

  const file = await resolveTrackFile(track);
  if (file) {
    if (preloadedObjectUrl) URL.revokeObjectURL(preloadedObjectUrl);
    preloadedTrackId = nextTrackId;
    preloadedObjectUrl = URL.createObjectURL(file);
    // This pre-creates the blob URL and keeps the file ready in memory cache
    console.log("Preloaded next track:", track.title);
  }
}

async function playTrack(trackId, contextIds = []) {
  const track = getTrackById(trackId);
  if (!track) {
    return;
  }

  let file;
  if (trackId === preloadedTrackId && preloadedObjectUrl) {
    currentObjectUrl = preloadedObjectUrl;
    preloadedObjectUrl = null;
    preloadedTrackId = null;
  } else {
    file = await resolveTrackFile(track);
    if (!file) {
      showToast("Файл недоступен. Попробуй импортировать его снова.");
      return;
    }
    if (currentObjectUrl) {
      URL.revokeObjectURL(currentObjectUrl);
    }
    currentObjectUrl = URL.createObjectURL(file);
  }

  audio.src = currentObjectUrl;
  audio.currentTime = 0;
  await audio.play();

  state.currentTrackId = trackId;
  playbackRecordedTrackId = null;

  playContextIds = contextIds.length ? contextIds.slice() : state.library.map((item) => item.id);
  
  if (state.shuffle && !contextIds.length) {
    // If we're playing from library and shuffle is on, shuffle the context
    playContextIds = shuffleArray(playContextIds);
    // Ensure current track is first or at its position
  }

  state.queue = state.queue.filter((id) => id !== trackId);
  saveState();
  render();
}

function probeDuration(file) {
  return new Promise((resolve) => {
    const tempAudio = new Audio();
    const url = URL.createObjectURL(file);
    tempAudio.src = url;
    tempAudio.addEventListener("loadedmetadata", () => {
      const d = tempAudio.duration;
      URL.revokeObjectURL(url);
      resolve(d);
    });
    tempAudio.addEventListener("error", () => {
      URL.revokeObjectURL(url);
      resolve(0);
    });
    // Timeout for safety
    setTimeout(() => resolve(0), 4000);
  });
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
  if (state.repeat === "one" && state.currentTrackId) {
    await playTrack(state.currentTrackId, playContextIds);
    return;
  }

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

  if (state.repeat === "all" && context.length > 0) {
    await playTrack(context[0], context);
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

function toggleShuffle() {
  state.shuffle = !state.shuffle;
  if (state.shuffle && playContextIds.length) {
    playContextIds = shuffleArray(playContextIds);
  } else {
    // Restore natural order if possible, or just keep as is for now
    // A better way would be to store original context
  }
  saveState();
  renderPlayer();
  showToast(state.shuffle ? "Перемешивание включено" : "Перемешивание выключено");
}

function toggleRepeat() {
  const modes = ["off", "all", "one"];
  const currentIndex = modes.indexOf(state.repeat);
  state.repeat = modes[(currentIndex + 1) % modes.length];
  saveState();
  renderPlayer();
  const labels = { off: "Повтор выключен", all: "Повтор всех", one: "Повтор трека" };
  showToast(labels[state.repeat]);
}

function shuffleArray(array) {
  const newArr = [...array];
  for (let i = newArr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [newArr[i], newArr[j]] = [newArr[j], newArr[i]];
  }
  return newArr;
}

function pushNavigationHistory() {
  const entry = {
    searchQuery: state.searchQuery,
    favoritesOnly: state.favoritesOnly
  };
  
  // Don't push duplicate consecutive states
  const lastEntry = state.navigationHistory[state.navigationPointer];
  if (lastEntry && lastEntry.searchQuery === entry.searchQuery && lastEntry.favoritesOnly === entry.favoritesOnly) {
    return;
  }

  state.navigationHistory = state.navigationHistory.slice(0, state.navigationPointer + 1);
  state.navigationHistory.push(entry);
  if (state.navigationHistory.length > 50) state.navigationHistory.shift();
  state.navigationPointer = state.navigationHistory.length - 1;
  saveState();
  updateNavButtons();
}

function navigateHistory(direction) {
  const newPointer = state.navigationPointer + direction;
  if (newPointer < 0 || newPointer >= state.navigationHistory.length) return;
  
  state.navigationPointer = newPointer;
  const entry = state.navigationHistory[newPointer];
  
  state.searchQuery = entry.searchQuery;
  state.favoritesOnly = entry.favoritesOnly;
  
  dom.searchInput.value = state.searchQuery;
  dom.favoritesOnly.checked = state.favoritesOnly;
  
  saveState();
  render();
  updateNavButtons();
}

function updateNavButtons() {
  if (dom.navBackBtn) dom.navBackBtn.disabled = state.navigationPointer <= 0;
  if (dom.navForwardBtn) dom.navForwardBtn.disabled = state.navigationPointer >= state.navigationHistory.length - 1;
}

function handleTimeUpdate() {
  if (!state.currentTrackId) {
    return;
  }

  renderPlayer();

  // Update progress CSS variable for mobile view
  if (audio.duration) {
    const progressPercent = (audio.currentTime / audio.duration) * 100;
    const progressRow = document.querySelector(".progress-row");
    if (progressRow) progressRow.style.setProperty("--progress", `${progressPercent}%`);
  }

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

const colorCache = new Map();

async function extractDominantColor(imageUrl) {
  if (!imageUrl) return null;
  if (colorCache.has(imageUrl)) return colorCache.get(imageUrl);

  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "Anonymous";
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        canvas.width = 10; // small size for averaging
        canvas.height = 10;
        ctx.drawImage(img, 0, 0, 10, 10);
        const data = ctx.getImageData(0, 0, 10, 10).data;
        
        let r = 0, g = 0, b = 0, count = 0;
        for (let i = 0; i < data.length; i += 4) {
          // Skip very dark or very light pixels if possible
          const brightness = (data[i] + data[i+1] + data[i+2]) / 3;
          if (brightness > 20 && brightness < 240) {
            r += data[i];
            g += data[i+1];
            b += data[i+2];
            count++;
          }
        }
        
        if (count === 0) { // Fallback if image is all dark/light
          for (let i = 0; i < data.length; i += 4) {
            r += data[i]; g += data[i+1]; b += data[i+2]; count++;
          }
        }
        
        const color = `rgb(${Math.round(r/count)}, ${Math.round(g/count)}, ${Math.round(b/count)})`;
        colorCache.set(imageUrl, color);
        resolve(color);
      } catch (e) {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = imageUrl;
  });
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

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(HANDLE_STORE)) {
        request.result.createObjectStore(HANDLE_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      dbPromise = null;
      reject(request.error);
    };
  });
  return dbPromise;
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

// Start the app
queueMicrotask(() => init().catch((error) => {
  console.error("Initialization failed:", error);
  showToast("Ошибка при запуске. Попробуй перезагрузить страницу.");
}));
