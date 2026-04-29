import sys

file_path = 'public/app.js'
try:
    with open(file_path, 'r', encoding='utf-8') as f:
        content = f.read()
except UnicodeDecodeError:
    with open(file_path, 'r', encoding='utf-16') as f:
        content = f.read()

# Find the start of corruption
# Corruption starts with " a s y n c   f u n c t i o n "
corruption_anchor = ' a s y n c   f u n c t i o n'
if corruption_anchor in content:
    print(f"Found corruption at {content.find(corruption_anchor)}")
    clean_content = content.split(corruption_anchor)[0]
    
    # The correct function
    scan_func = """
async function scanMobileMusic() {
  if (!window.Capacitor?.isNativePlatform()) return;

  const { Filesystem, Directory } = window.Capacitor.Plugins;
  try {
    const status = await Filesystem.requestPermissions();
    if (status.publicStorage !== "granted") {
      showToast("Нужно разрешение на доступ к файлам");
      return;
    }

    showToast("Сканирую устройство...");
    const folders = ["Music", "Download", "Documents"];
    const knownFingerprints = new Set(state.library.map(t => t.sourceFingerprint));
    const freshTracks = [];

    for (const folder of folders) {
      try {
        const result = await Filesystem.readdir({
          path: folder,
          directory: Directory.ExternalStorage
        });

        for (const file of result.files) {
          if (file.type === "file" && isAudioFile(file.name)) {
            const fullPath = `${folder}/${file.name}`;
            const fingerprint = `mobile_${fullPath}`;
            
            if (knownFingerprints.has(fingerprint)) continue;

            const mockFile = { name: file.name };
            const track = await buildTrackRecord(mockFile, {
              relativePath: fullPath,
              sourceFingerprint: fingerprint,
              persistent: true,
              mobilePath: fullPath
            });

            freshTracks.push(track);
            knownFingerprints.add(fingerprint);
          }
        }
      } catch (err) {
        console.warn(`Folder ${folder} not accessible`, err);
      }
    }

    if (freshTracks.length > 0) {
      state.library = [...state.library, ...freshTracks].sort(sortTracks);
      saveState();
      render();
      showToast(`Найдено ${freshTracks.length} новых треков!`);
    } else {
      showToast("Ничего нового не найдено.");
    }
  } catch (e) {
    console.error("Scan error", e);
    showToast("Ошибка при сканировании");
  }
}
"""
    with open(file_path, 'w', encoding='utf-8') as f:
        f.write(clean_content.strip() + "\n" + scan_func)
    print("File fixed successfully.")
else:
    print("Corruption anchor not found.")
