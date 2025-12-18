const { app, BrowserWindow, ipcMain, session, shell } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');

const GOOGLE_API_KEY = "AIzaSyAu1iIlBuxPgCRoGDAqUrLZsuSrBvSq2Xs"; 
const DATA_PATH = path.join(app.getPath('userData'), 'library.json');
const DOWNLOAD_DIR = path.join(os.homedir(), 'Downloads', 'FreedomMusic');

// --- INIT ---
if (!fs.existsSync(DATA_PATH)) {
    fs.writeFileSync(DATA_PATH, JSON.stringify({ likedSongs: [], playlists: [], history: [] }, null, 2));
}
if (!fs.existsSync(DOWNLOAD_DIR)) {
    fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

function getLibrary() { 
    try {
        const raw = fs.readFileSync(DATA_PATH);
        let data = JSON.parse(raw);
        if (!data.history) data.history = [];
        if (!data.likedSongs) data.likedSongs = [];
        if (!data.playlists) data.playlists = [];
        return data;
    } catch(e) {
        return { likedSongs: [], playlists: [], history: [] };
    }
}

function saveLibrary(data) { fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2)); }

// --- HELPER: SAFE FILENAME ---
// This ensures we always look for "My_Song_ID.m4a" consistently
function getSafeFilename(title, videoId) {
    const safeTitle = title.replace(/[^a-z0-9]/gi, '_'); 
    return `${safeTitle}_${videoId}.m4a`;
}

// --- WINDOW ---
process.env['ELECTRON_DISABLE_SECURITY_WARNINGS'] = 'true';
app.commandLine.appendSwitch('ignore-certificate-errors');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

function createWindow() {
  const win = new BrowserWindow({
    width: 1200, height: 800,
    webPreferences: { nodeIntegration: true, contextIsolation: false, webSecurity: false }
  });
  
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    if (details.url.includes('googlevideo.com')) {
      delete details.requestHeaders['Origin']; delete details.requestHeaders['Referer'];
    }
    callback({ cancel: false, requestHeaders: details.requestHeaders });
  });
  
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'index.html'));
}
app.whenReady().then(createWindow);

// --- HANDLERS ---

// 1. GET ALL DOWNLOADS
ipcMain.handle('get-downloaded-files', async () => {
    try {
        if (!fs.existsSync(DOWNLOAD_DIR)) return [];
        return fs.readdirSync(DOWNLOAD_DIR);
    } catch (e) { return []; }
});

// 2. CHECK OFFLINE STATUS
ipcMain.handle('check-offline', async (event, { videoId, title }) => {
    // 1. Check DB (Exact Match)
    const db = getLibrary();
    let foundSong = db.likedSongs.find(s => s.id === videoId) || db.history.find(s => s.id === videoId);
    
    if (!foundSong) {
        for (const pl of db.playlists) {
            foundSong = pl.songs.find(s => s.id === videoId);
            if (foundSong) break;
        }
    }

    if (foundSong && foundSong.localPath && fs.existsSync(foundSong.localPath)) {
        return { success: true, url: foundSong.localPath }; 
    }

    // 2. Check File System (Fallback using filename generation)
    const filename = getSafeFilename(title, videoId);
    const filePath = path.join(DOWNLOAD_DIR, filename);
    
    if (fs.existsSync(filePath)) {
        return { success: true, url: filePath }; 
    }
    return { success: false };
});

// 3. CHECK PLAYLIST STATUS
ipcMain.handle('check-playlist-downloaded', async (event, songs) => {
    if (!songs || songs.length === 0) return false;
    // Check if every song file exists on disk
    const allExist = songs.every(song => {
        const filename = getSafeFilename(song.title, song.id);
        return fs.existsSync(path.join(DOWNLOAD_DIR, filename));
    });
    return allExist;
});

// 4. DOWNLOADER (FIXED)
ipcMain.handle('yt-download', async (event, payload) => {
    return new Promise((resolve) => {
        // Fix: Handle both 'id' and 'videoId' to prevent "undefined" error
        const videoId = payload.videoId || payload.id;
        const title = payload.title;

        if (!videoId) {
            console.error("Error: No Video ID provided for download");
            resolve({ success: false });
            return;
        }

        const exePath = app.isPackaged 
        const filename = getSafeFilename(title, videoId);
        const outputPath = path.join(DOWNLOAD_DIR, filename);

        // Success Callback
        const onDownloadSuccess = () => {
            const db = getLibrary();
            const localPath = outputPath;

            const updateList = (list) => {
                const item = list.find(s => s.id === videoId);
                if (item) item.localPath = localPath;
            };

            updateList(db.likedSongs);
            updateList(db.history);
            db.playlists.forEach(pl => updateList(pl.songs));

            saveLibrary(db);
            resolve({ success: true, localPath: localPath });
        };

        if (fs.existsSync(outputPath)) {
            onDownloadSuccess();
            return;
        }

        console.log(`Downloading: ${title} [${videoId}]`);

        const ytDlp = spawn(exePath, [
            '-f', 'bestaudio[ext=m4a]', 
            '-o', outputPath, 
            `https://www.youtube.com/watch?v=${videoId}`
        ]);
        
        ytDlp.on('close', (code) => {
            if (code === 0) onDownloadSuccess();
            else resolve({ success: false });
        });
    });
});

// 5. SEARCH & STREAM
ipcMain.handle('yt-search', async (event, query) => {
    try {
        const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&type=video&videoCategoryId=10&maxResults=20&key=${GOOGLE_API_KEY}`;
        const res = await fetch(url);
        const json = await res.json();
        if (json.error) throw new Error(json.error.message);
        return { success: true, data: json.items.map(i => ({ id: i.id.videoId, title: i.snippet.title, artist: i.snippet.channelTitle, img: i.snippet.thumbnails.high.url })) };
    } catch (e) { return { success: false, error: e.message }; }
});

ipcMain.handle('yt-stream', async (event, videoId) => {
    return new Promise((resolve) => {
        const exePath = app.isPackaged 
        const ytDlp = spawn(exePath, ['-g', '-f', 'bestaudio[ext=m4a]/bestaudio', `https://www.youtube.com/watch?v=${videoId}`]);
        let raw = "";
        ytDlp.stdout.on('data', d => raw += d.toString());
        ytDlp.on('close', c => resolve(c === 0 ? { success: true, url: raw.trim() } : { success: false }));
    });
});

ipcMain.handle('get-lyrics', async (event, { title, artist }) => {
    try {
        const res = await fetch(`https://lrclib.net/api/search?q=${encodeURIComponent(title + " " + artist)}`);
        const json = await res.json();
        return (json && json.length) ? { success: true, lyrics: json[0].syncedLyrics || json[0].plainLyrics } : { success: false };
    } catch (e) { return { success: false }; }
});

// --- LIBRARY MANAGEMENT ---
ipcMain.handle('get-library', async () => getLibrary());

ipcMain.handle('create-playlist', async (event, name) => {
    const db = getLibrary();
    if (!db.playlists.find(p => p.name === name)) {
        db.playlists.push({ name: name, songs: [] });
        saveLibrary(db);
    }
    return { success: true };
});

ipcMain.handle('delete-playlist', async (event, name) => {
    const db = getLibrary();
    db.playlists = db.playlists.filter(p => p.name !== name);
    saveLibrary(db);
    return { success: true };
});

ipcMain.handle('remove-from-playlist', async (event, { playlistName, songId }) => {
    const db = getLibrary();
    if (playlistName === 'Liked Songs') db.likedSongs = db.likedSongs.filter(s => s.id !== songId);
    else {
        const pl = db.playlists.find(p => p.name === playlistName);
        if (pl) pl.songs = pl.songs.filter(s => s.id !== songId);
    }
    saveLibrary(db);
    return { success: true };
});

ipcMain.handle('add-to-playlist', async (event, { playlistName, song }) => {
    const db = getLibrary();
    
    // Check if we have path
    let existingPath = null;
    const findPath = (list) => {
        const found = list.find(s => s.id === song.id);
        if(found && found.localPath) existingPath = found.localPath;
    }
    findPath(db.likedSongs);
    findPath(db.history);
    db.playlists.forEach(pl => findPath(pl.songs));

    const newSongObj = { ...song, localPath: existingPath || song.localPath };

    if (playlistName === 'Liked Songs') {
        const idx = db.likedSongs.findIndex(s => s.id === song.id);
        if (idx === -1) db.likedSongs.unshift(newSongObj);
        else db.likedSongs.splice(idx, 1);
    } else {
        const pl = db.playlists.find(p => p.name === playlistName);
        if (pl && !pl.songs.find(s => s.id === song.id)) pl.songs.push(newSongObj);
    }
    saveLibrary(db);
    return { success: true };
});

ipcMain.handle('add-to-history', async (event, song) => {
    const db = getLibrary();
    if (!Array.isArray(db.history)) db.history = [];
    
    let existingPath = null;
    const existingEntry = db.history.find(s => s.id === song.id);
    if(existingEntry && existingEntry.localPath) existingPath = existingEntry.localPath;

    db.history = db.history.filter(s => s.id !== song.id);
    db.history.unshift({ ...song, localPath: existingPath || song.localPath });
    
    if (db.history.length > 20) db.history.pop();
    saveLibrary(db);
    return { success: true };
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });