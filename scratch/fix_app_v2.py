import sys

file_path = 'public/app.js'

with open(file_path, 'rb') as f:
    data = f.read()

# Find the point where UTF-16LE starts
# We look for a sequence of 0x00 bytes alternating with ASCII
# Or just find the first 0x00 byte after line 2500
# Looking at my previous view_file, corruption starts around line 2575.
# Total size is ~88670.

# Let's find the last occurrence of a clean string
anchor = b'navigator.serviceWorker.register'
pos = data.rfind(anchor)

if pos != -1:
    print(f"Found clean anchor at {pos}")
    # Find the end of that block
    end_of_clean = data.find(b'}', pos)
    if end_of_clean != -1:
        end_of_clean = data.find(b'}', end_of_clean + 1) # Skip one more } just in case
        if end_of_clean != -1:
             end_of_clean += 1
        
        print(f"Truncating at {end_of_clean}")
        clean_data = data[:end_of_clean]
        
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
        with open(file_path, 'wb') as f:
            f.write(clean_data.rstrip())
            f.write(b"\n\n")
            f.write(scan_func.encode('utf-8'))
        print("File fixed successfully.")
else:
    print("Could not find anchor.")
