const { app, BrowserWindow, session, ipcMain, shell, clipboard, dialog, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { autoUpdater } = require('electron-updater');

// Tắt auto download mặc định, chỉ khi user bấm
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;

let mainWindow = null;
let hiddenFbWindow = null;
let isBatchRunning = false;
let shouldStopBatch = false;
let windowReady = false;

function createMainWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  mainWindow = new BrowserWindow({
    width: Math.min(width, 1100),
    height: Math.min(height, 820),
    minWidth: 900,
    minHeight: 650,
    resizable: true,
    maximizable: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    title: 'FB Cookie & Token Tool',
    autoHideMenuBar: true,
    show: false
  });
  mainWindow.loadFile('src/index.html');
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.maximize();
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.includes('facebook.com') || url.includes('fb.com')) shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  createMainWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

async function getAllFacebookCookies() {
  const ses = session.defaultSession;
  const domains = ['.facebook.com', 'facebook.com', '.fb.com'];
  const map = new Map();
  for (const d of domains) {
    try {
      (await ses.cookies.get({ domain: d })).forEach(c => map.set(c.name, c));
    } catch (e) {}
  }
  return Array.from(map.values());
}

async function clearAllFacebookCookies() {
  const cookies = await getAllFacebookCookies();
  for (const cookie of cookies) {
    const domain = cookie.domain.startsWith('.') ? cookie.domain.slice(1) : cookie.domain;
    try {
      await session.defaultSession.cookies.remove(`https://${domain}${cookie.path || '/'}`, cookie.name);
    } catch (e) {}
  }
  return cookies.length;
}

async function setCookiesList(cookies) {
  const ses = session.defaultSession;
  let success = 0;
  for (const cookie of cookies) {
    const domain = (cookie.domain || '.facebook.com').toLowerCase();
    if (!domain.includes('facebook.com') && !domain.includes('fb.com') && domain !== '') continue;
    try {
      await ses.cookies.set({
        url: 'https://www.facebook.com',
        name: cookie.name,
        value: cookie.value,
        domain: domain.startsWith('.') ? domain : (domain ? '.' + domain : '.facebook.com'),
        path: cookie.path || '/',
        secure: true,
        httpOnly: !!cookie.httpOnly,
        expirationDate: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 90
      });
      success++;
    } catch (e) {}
  }
  return success;
}

// ===== EXTRACT NHANH =====
async function extractTokenFast(win) {
  if (!win || win.isDestroyed()) return { success: false, error: 'no window' };
  try {
    const result = await win.webContents.executeJavaScript(`
      (function() {
        const href = location.href || '';
        const isLogin = href.includes('/login') || href.includes('login.php') ||
          !!document.querySelector('input[name="email"]') || !!document.querySelector('#email');
        if (isLogin) return { token: null, uid: null, isLoginPage: true };

        let token = null, method = '', uid = null;

        // localStorage nhanh
        try {
          for (let i = 0; i < localStorage.length; i++) {
            const v = localStorage.getItem(localStorage.key(i));
            if (!v || typeof v !== 'string') continue;
            if (v.startsWith('EAA') && v.length > 60) { token = v; method = 'ls'; break; }
            if (v.includes('EAA') && v.length > 80) {
              try {
                const p = JSON.parse(v);
                if (p && (p.access_token || p.accessToken)) {
                  const t = p.access_token || p.accessToken;
                  if (String(t).startsWith('EAA')) { token = t; method = 'ls-json'; break; }
                }
              } catch(e) {}
            }
          }
        } catch(e) {}

        // HTML scan nhanh nếu chưa có
        if (!token) {
          try {
            const html = document.documentElement.innerHTML;
            const m = html.match(/"accessToken"\\s*:\\s*"(EAA[^"]{50,})"/) ||
                      html.match(/"access_token"\\s*:\\s*"(EAA[^"]{50,})"/) ||
                      html.match(/(EAA[A-Za-z0-9]{80,})/);
            if (m) { token = m[1] || m[0]; method = 'html'; }
          } catch(e) {}
        }

        // UID
        try {
          const c = document.cookie.split(';').find(x => x.trim().startsWith('c_user='));
          if (c) uid = c.split('=')[1].trim();
        } catch(e) {}

        return { token, method, uid, isLoginPage: false };
      })();
    `);
    return {
      success: !!result.token && !result.isLoginPage,
      token: result.token || null,
      method: result.method || null,
      uid: result.uid || null,
      isLoginPage: !!result.isLoginPage,
      error: result.isLoginPage ? 'Cookie hết hạn' : (result.token ? null : 'Không tìm thấy Access Token')
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

function sendToRenderer(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

// ===== TẠO / TÁI SỬ DỤNG CỬA SỔ ẨN (nhanh hơn destroy mỗi lần) =====
async function ensureHiddenWindow() {
  if (hiddenFbWindow && !hiddenFbWindow.isDestroyed()) return hiddenFbWindow;

  hiddenFbWindow = new BrowserWindow({
    width: 1100, height: 800, show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false,
      images: false,          // không load ảnh → nhanh hơn
      javascript: true
    }
  });

  hiddenFbWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.includes('facebook.com') && !url.includes('fb.com') && !url.includes('facebook.net')) {
      e.preventDefault();
    }
  });

  hiddenFbWindow.on('closed', () => {
    hiddenFbWindow = null;
    windowReady = false;
  });

  return hiddenFbWindow;
}

// ===== LẤY TOKEN NHANH =====
async function fetchTokenFast() {
  const win = await ensureHiddenWindow();

  return new Promise(async (resolve) => {
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };

    const timer = setTimeout(() => {
      finish({ success: false, error: 'Timeout', isLoginPage: false });
    }, 12000); // max 12s mỗi cookie

    const onLoad = async () => {
      // Đợi ngắn cho JS chạy
      await new Promise(r => setTimeout(r, 900));

      let result = await extractTokenFast(win);
      if (result.success || result.isLoginPage) {
        finish(result);
        return;
      }

      // Thử thêm 1 lần sau 1.2s
      await new Promise(r => setTimeout(r, 1200));
      result = await extractTokenFast(win);
      finish(result);
    };

    // Nếu đã có listener cũ thì remove
    win.webContents.removeAllListeners('did-finish-load');
    win.webContents.once('did-finish-load', onLoad);

    try {
      // Load nhanh, bỏ cache nếu cần
      await win.loadURL('https://www.facebook.com/', { extraHeaders: 'pragma: no-cache\n' });
    } catch (e) {
      finish({ success: false, error: e.message });
    }
  });
}

// ===== PARSE FILE =====
function parseMultipleCookiesFromText(text) {
  const results = [];
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));

  function makeCookieObj(name, value) {
    return {
      name: String(name).trim(),
      value: String(value).trim(),
      domain: '.facebook.com',
      path: '/',
      secure: true,
      httpOnly: false,
      expirationDate: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 90
    };
  }

  function parseCookieString(str) {
    if (!str) return [];
    return str.split(';').map(part => {
      const idx = part.indexOf('=');
      if (idx === -1) return null;
      const name = part.slice(0, idx).trim();
      const value = part.slice(idx + 1).trim();
      if (!name) return null;
      return makeCookieObj(name, value);
    }).filter(Boolean);
  }

  for (const line of lines) {
    if (line.length < 15) continue;
    let cookieStr = null, preview = line.slice(0, 90) + (line.length > 90 ? '...' : ''), uidHint = null;

    if (line.includes('|') && (line.includes('c_user=') || line.includes('xs=') || line.includes(';'))) {
      const parts = line.split('|');
      if (parts.length >= 3) {
        cookieStr = parts.slice(2).join('|').trim();
        uidHint = parts[0].trim();
      } else if (parts.length === 2) {
        cookieStr = parts[1].trim();
        uidHint = parts[0].trim();
      }
    }

    if (!cookieStr && line.includes('|') && line.includes('business.facebook.com/invitation')) {
      const parts = line.split('|');
      results.push({
        raw: preview, cookies: [], type: 'invitation',
        uid: parts[0] ? parts[0].trim() : null
      });
      continue;
    }

    if (!cookieStr && line.startsWith('[')) {
      try {
        const arr = JSON.parse(line);
        if (Array.isArray(arr) && arr[0] && arr[0].name) {
          results.push({
            raw: preview,
            cookies: arr.map(c => makeCookieObj(c.name, c.value)),
            type: 'json'
          });
          continue;
        }
      } catch (e) {}
    }

    if (!cookieStr && (line.includes('c_user=') || line.includes('xs=') || (line.includes('=') && line.includes(';')))) {
      cookieStr = line;
    }

    if (cookieStr) {
      const cookies = parseCookieString(cookieStr);
      const hasSession = cookies.some(c => ['c_user', 'xs', 'fr', 'datr', 'sb'].includes(c.name));
      if (cookies.length >= 1 && (hasSession || cookies.length >= 3)) {
        results.push({ raw: preview, cookies, type: 'cookie', uid: uidHint });
      }
    }
  }
  return results;
}

// ===== IPC =====
ipcMain.handle('clear-facebook-cookies', async () => await clearAllFacebookCookies());

ipcMain.handle('login-and-get-token', async (event, cookies) => {
  await clearAllFacebookCookies();
  const count = await setCookiesList(cookies);
  if (count === 0) return { success: false, error: 'Không set được cookie' };
  sendToRenderer('status-update', { message: 'Đang lấy token...', type: 'info' });
  const r = await fetchTokenFast();
  return { success: r.success, token: r.token, method: r.method, uid: r.uid, error: r.error };
});

ipcMain.handle('open-facebook-external', async () => {
  await shell.openExternal('https://www.facebook.com');
  return true;
});

ipcMain.handle('copy-text', async (e, text) => {
  clipboard.writeText(text || '');
  return true;
});

ipcMain.handle('get-cookie-and-uid', async () => {
  const cookies = await getAllFacebookCookies();
  return {
    cookie: cookies.map(c => c.name + '=' + c.value).join('; '),
    uid: (cookies.find(c => c.name === 'c_user') || {}).value || null
  };
});

ipcMain.handle('select-cookie-file', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: 'Chọn file cookie',
    filters: [{ name: 'Text', extensions: ['txt', 'csv', 'json', 'log'] }, { name: 'All', extensions: ['*'] }],
    properties: ['openFile']
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('parse-cookie-file', async (e, filePath) => {
  try {
    const items = parseMultipleCookiesFromText(fs.readFileSync(filePath, 'utf8'));
    return { success: true, count: items.length };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('start-batch', async (e, filePath) => {
  if (isBatchRunning) return { success: false, error: 'Đang chạy' };
  isBatchRunning = true;
  shouldStopBatch = false;

  try {
    const items = parseMultipleCookiesFromText(fs.readFileSync(filePath, 'utf8'));
    if (!items.length) {
      isBatchRunning = false;
      return { success: false, error: 'Không tìm thấy cookie hợp lệ' };
    }

    sendToRenderer('batch-start', { total: items.length });
    // Pre-create window
    await ensureHiddenWindow();

    let successCount = 0, failCount = 0;
    const tokens = [];

    for (let i = 0; i < items.length; i++) {
      if (shouldStopBatch) break;

      const item = items[i];
      sendToRenderer('batch-progress', {
        current: i + 1,
        total: items.length,
        message: `${i + 1}/${items.length}`
      });

      if (item.type === 'invitation' || !item.cookies || !item.cookies.length) {
        failCount++;
        sendToRenderer('batch-line', {
          index: i + 1, status: 'fail',
          message: `[${i + 1}] ${item.type === 'invitation' ? 'Bỏ qua invitation' : 'Cookie không hợp lệ'}`
        });
        continue;
      }

      await clearAllFacebookCookies();
      const setCount = await setCookiesList(item.cookies);
      if (setCount === 0) {
        failCount++;
        sendToRenderer('batch-line', { index: i + 1, status: 'fail', message: `[${i + 1}] Không set được cookie` });
        continue;
      }

      const result = await fetchTokenFast();

      if (result.success && result.token) {
        successCount++;
        tokens.push(result.token);
        const uid = result.uid || item.uid || 'N/A';
        sendToRenderer('batch-line', {
          index: i + 1, status: 'success',
          message: `[${i + 1}] OK | UID: ${uid}`
        });
        sendToRenderer('token-obtained', { index: i + 1, uid, token: result.token });
      } else {
        failCount++;
        const reason = result.isLoginPage || (result.error && result.error.includes('hết hạn'))
          ? 'Cookie hết hạn'
          : (result.error || 'Không tìm thấy Access Token');
        sendToRenderer('batch-line', {
          index: i + 1, status: 'fail',
          message: `[${i + 1}] ${reason}`
        });
      }

      // Nghỉ rất ngắn
      await new Promise(r => setTimeout(r, 200));
    }

    isBatchRunning = false;
    sendToRenderer('batch-done', { total: items.length, success: successCount, fail: failCount, tokens });
    return { success: true, total: items.length, successCount, failCount };
  } catch (err) {
    isBatchRunning = false;
    return { success: false, error: err.message };
  }
});

ipcMain.handle('stop-batch', async () => {
  shouldStopBatch = true;
  return true;
});


// ===== UPDATE =====
ipcMain.handle('get-app-version', () => {
  return app.getVersion();
});

ipcMain.handle('check-for-update', async () => {
  try {
    // Nếu chưa cấu hình publish URL thật, trả về hướng dẫn
    const result = await autoUpdater.checkForUpdates();
    if (!result || !result.updateInfo) {
      return { available: false, message: 'Không có bản cập nhật hoặc chưa cấu hình server update' };
    }
    const info = result.updateInfo;
    const current = app.getVersion();
    if (info.version === current) {
      return { available: false, message: 'Bạn đang dùng bản mới nhất (v' + current + ')' };
    }
    return {
      available: true,
      version: info.version,
      current: current,
      message: 'Có bản mới: v' + info.version
    };
  } catch (err) {
    // Lỗi thường gặp khi chưa có server update
    return {
      available: false,
      message: 'Chưa cấu hình server cập nhật. Xem hướng dẫn trong README để setup.',
      error: err.message
    };
  }
});

ipcMain.handle('download-update', async () => {
  try {
    await autoUpdater.downloadUpdate();
    return { success: true, message: 'Đang tải bản cập nhật...' };
  } catch (err) {
    return { success: false, message: err.message };
  }
});

ipcMain.handle('install-update', () => {
  autoUpdater.quitAndInstall(false, true);
  return true;
});

// Events từ autoUpdater → gửi về UI
autoUpdater.on('update-available', (info) => {
  sendToRenderer('update-status', { type: 'available', version: info.version, message: 'Có bản mới: v' + info.version });
});

autoUpdater.on('update-not-available', () => {
  sendToRenderer('update-status', { type: 'not-available', message: 'Đang dùng bản mới nhất' });
});

autoUpdater.on('download-progress', (p) => {
  sendToRenderer('update-status', {
    type: 'progress',
    percent: Math.round(p.percent),
    message: 'Đang tải: ' + Math.round(p.percent) + '%'
  });
});

autoUpdater.on('update-downloaded', (info) => {
  sendToRenderer('update-status', {
    type: 'downloaded',
    version: info.version,
    message: 'Đã tải xong v' + info.version + '. Bấm Cài đặt để cập nhật.'
  });
});

autoUpdater.on('error', (err) => {
  sendToRenderer('update-status', { type: 'error', message: 'Lỗi cập nhật: ' + (err.message || String(err)) });
});
