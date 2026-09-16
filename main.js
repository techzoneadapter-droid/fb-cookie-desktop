const { app, BrowserWindow, session, ipcMain, clipboard, dialog, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { autoUpdater } = require('electron-updater');
const {
  parseCookieText,
  extractCookieSegment,
  parseAccountCookieLine,
  parseAccountCookieFile
} = require('./src/cookie-parser');

// Partition không persist: cookie/token chỉ tồn tại trong phiên chạy hiện tại, không ghi vào hồ sơ trình duyệt mặc định.
const FACEBOOK_PARTITION = 'facebook-auth-private';
const BATCH_CONCURRENCY = 2;
const FACEBOOK_ENTRY_URL = 'https://adsmanager.facebook.com/adsmanager/manage/campaigns/';
const FACEBOOK_WEB_DOMAINS = ['facebook.com', 'fb.com', 'facebook.net', 'fbcdn.net', 'fbsbx.com'];
const FACEBOOK_COOKIE_DOMAINS = ['facebook.com', 'fb.com'];
let facebookSession = null;
const guardedFacebookSessions = new WeakSet();

function isDomainOrSubdomain(host, allowedDomain) {
  return host === allowedDomain || host.endsWith('.' + allowedDomain);
}

function isAllowedDomain(host, allowedDomains) {
  const normalized = String(host || '').trim().toLowerCase().replace(/^\.+/, '');
  return !!normalized && allowedDomains.some(domain => isDomainOrSubdomain(normalized, domain));
}

function isAllowedFacebookUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'https:') return false;
    const host = url.hostname.toLowerCase();
    return isAllowedDomain(host, FACEBOOK_WEB_DOMAINS);
  } catch (e) {
    return false;
  }
}

function normalizeFacebookCookieDomain(rawDomain) {
  let original = String(rawDomain || '.facebook.com').trim().toLowerCase();
  if (/^https?:\/\//.test(original)) {
    try { original = new URL(original).hostname; } catch (e) { return null; }
  }
  const host = original.replace(/^\.+/, '');
  if (!isAllowedDomain(host, FACEBOOK_COOKIE_DOMAINS)) return null;
  return original.startsWith('.') ? '.' + host : host;
}

function configureFacebookSession(ses) {
  if (!guardedFacebookSessions.has(ses)) {
    guardedFacebookSessions.add(ses);
    ses.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
      callback({ cancel: !isAllowedFacebookUrl(details.url) });
    });
    ses.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    ses.on('will-download', (event) => event.preventDefault());
  }
  return ses;
}

function getFacebookSession() {
  if (!facebookSession) {
    facebookSession = configureFacebookSession(session.fromPartition(FACEBOOK_PARTITION));
  }
  return facebookSession;
}

function getBatchFacebookSession(workerId) {
  return configureFacebookSession(session.fromPartition(`${FACEBOOK_PARTITION}-batch-${workerId}`));
}

// Tắt auto download mặc định, chỉ khi user bấm
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;

let mainWindow = null;
let hiddenFbWindow = null;
const batchWorkers = [];
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

async function getAllFacebookCookies(ses = getFacebookSession()) {
  try {
    const cookies = await ses.cookies.get({});
    return cookies.filter(cookie => isAllowedDomain(cookie.domain, FACEBOOK_COOKIE_DOMAINS));
  } catch (e) {
    return [];
  }
}

async function clearAllFacebookCookies(ses = getFacebookSession()) {
  const cookies = await getAllFacebookCookies(ses);
  for (const cookie of cookies) {
    const domain = cookie.domain.startsWith('.') ? cookie.domain.slice(1) : cookie.domain;
    try {
      await ses.cookies.remove(`https://${domain}${cookie.path || '/'}`, cookie.name);
    } catch (e) {}
  }
  return cookies.length;
}

async function setCookiesList(cookies, ses = getFacebookSession()) {
  let success = 0;
  let rejected = 0;
  let failed = 0;
  for (const cookie of cookies) {
    const domain = normalizeFacebookCookieDomain(cookie.domain);
    if (!domain) {
      rejected++;
      continue;
    }
    const host = domain.replace(/^\./, '');
    try {
      const details = {
        url: `https://${host}/`,
        name: cookie.name,
        value: cookie.value,
        domain,
        path: cookie.path || '/',
        secure: true,
        httpOnly: !!cookie.httpOnly
      };
      if (Number.isFinite(cookie.expirationDate) && cookie.expirationDate > Date.now() / 1000) {
        details.expirationDate = cookie.expirationDate;
      }
      await ses.cookies.set(details);
      success++;
    } catch (e) {
      failed++;
    }
  }
  return { success, rejected, failed };
}

// ===== EXTRACT NHANH =====
async function extractTokenFast(win) {
  if (!win || win.isDestroyed()) return { success: false, error: 'no window' };
  try {
    const result = await win.webContents.executeJavaScript(`
      (function() {
        const href = location.href || '';
        const host = (location.hostname || '').toLowerCase();
        const isFacebookHost = host === 'facebook.com' || host.endsWith('.facebook.com') ||
          host === 'fb.com' || host.endsWith('.fb.com');
        const isCheckpoint = ['/checkpoint', '/two_step_verification', '/auth_platform']
          .some(path => href.toLowerCase().includes(path));
        const isRestricted = ['/disabled', '/locked', '/account_recovery']
          .some(path => href.toLowerCase().includes(path));
        const isLogin = href.toLowerCase().includes('/login') || href.toLowerCase().includes('login.php') ||
          !!document.querySelector('input[name="email"]') || !!document.querySelector('#email');
        if (isCheckpoint) return { token: null, uid: null, authStatus: 'checkpoint' };
        if (isRestricted) return { token: null, uid: null, authStatus: 'restricted' };
        if (isLogin) return { token: null, uid: null, authStatus: 'not_logged_in' };

        let token = null, method = '', uid = null, invalidToken = false;
        const tokenPattern = /EAA[A-Za-z0-9_-]{77,}/g;

        function isPlausibleToken(candidate) {
          const body = candidate.slice(3);
          const counts = {};
          for (const char of body) counts[char] = (counts[char] || 0) + 1;
          const dominantRatio = Math.max(...Object.values(counts)) / body.length;
          return body.length >= 77 &&
            new Set(body).size >= 10 &&
            dominantRatio < 0.45 &&
            /[a-z]/.test(body) &&
            /[0-9]/.test(body);
        }

        function findToken(value, source, depth) {
          if (value === null || value === undefined || depth > 5) return null;
          if (typeof value === 'string') {
            const candidates = value.match(tokenPattern) || [];
            const direct = candidates.find(isPlausibleToken);
            if (direct) return { token: direct, method: source };
            if (candidates.length) invalidToken = true;
            if (value.length > 20) {
              try {
                const parsed = JSON.parse(value);
                return findToken(parsed, source + '-json', depth + 1);
              } catch (e) {}
            }
            return null;
          }
          if (typeof value !== 'object') return null;
          const priorityKeys = ['access_token', 'accessToken', 'token', 'accessTokenValue'];
          for (const key of priorityKeys) {
            if (Object.prototype.hasOwnProperty.call(value, key)) {
              const found = findToken(value[key], source + '-' + key, depth + 1);
              if (found) return found;
            }
          }
          if (Array.isArray(value)) {
            for (const item of value) {
              const found = findToken(item, source, depth + 1);
              if (found) return found;
            }
          }
          return null;
        }

        function scanStorage(storage, source) {
          try {
            for (let i = 0; i < storage.length; i++) {
              const key = storage.key(i);
              const found = findToken(storage.getItem(key), source + ':' + key, 0);
              if (found) return found;
            }
          } catch (e) {}
          return null;
        }

        let found = scanStorage(localStorage, 'localStorage') || scanStorage(sessionStorage, 'sessionStorage');
        if (found) { token = found.token; method = found.method; }

        // Facebook thường đặt dữ liệu trong các script được tạo sau khi trang tải xong.
        if (!token) {
          try {
            const nodes = document.querySelectorAll('script, body');
            for (const node of nodes) {
              const foundInNode = findToken(node.textContent || node.innerHTML || '', 'dom', 0);
              if (foundInNode) { token = foundInNode.token; method = foundInNode.method; break; }
            }
          } catch (e) {}
        }

        if (!token) {
          try {
            const html = document.documentElement.outerHTML || '';
            const foundInHtml = findToken(html, 'html', 0);
            if (foundInHtml) { token = foundInHtml.token; method = foundInHtml.method; }
          } catch (e) {}
        }

        // UID
        try {
          const c = document.cookie.split(';').find(x => x.trim().startsWith('c_user='));
          if (c) uid = c.split('=')[1].trim();
        } catch(e) {}

        return {
          token, method, uid, invalidToken,
          authStatus: isFacebookHost ? 'authenticated' : 'loading'
        };
      })();
    `);
    const statusMessages = {
      not_logged_in: 'Cookie không đăng nhập được: Facebook đã chuyển về trang đăng nhập. Cookie có thể sai, thiếu hoặc đã hết hạn.',
      checkpoint: 'Cookie đã được nhận nhưng Facebook yêu cầu xác minh/checkpoint.',
      restricted: 'Facebook báo tài khoản đang bị khóa hoặc hạn chế.',
      loading: 'Đang chờ Facebook tải trang đăng nhập.'
    };
    return {
      success: !!result.token && result.authStatus === 'authenticated',
      authenticated: result.authStatus === 'authenticated',
      authStatus: result.authStatus || 'loading',
      token: result.token || null,
      method: result.method || null,
      uid: result.uid || null,
      isLoginPage: result.authStatus === 'not_logged_in',
      error: statusMessages[result.authStatus] || (result.token ? null :
        (result.invalidToken ? 'Đăng nhập được nhưng Facebook trả về token không hợp lệ.' :
          'Đăng nhập được nhưng chưa tìm thấy Access Token.'))
    };
  } catch (err) {
    return { success: false, authenticated: false, authStatus: 'page_error', error: 'Không thể kiểm tra trạng thái trang Facebook.' };
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
      partition: FACEBOOK_PARTITION,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: false,
      backgroundThrottling: false,
      images: true,
      javascript: true
    }
  });

  hiddenFbWindow.webContents.on('will-navigate', (e, url) => {
    if (!isAllowedFacebookUrl(url)) {
      e.preventDefault();
    }
  });

  hiddenFbWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedFacebookUrl(url)) {
      setImmediate(() => {
        if (hiddenFbWindow && !hiddenFbWindow.isDestroyed()) hiddenFbWindow.loadURL(url).catch(() => {});
      });
    }
    return { action: 'deny' };
  });

  hiddenFbWindow.on('closed', () => {
    hiddenFbWindow = null;
    windowReady = false;
  });

  return hiddenFbWindow;
}

async function ensureBatchWorker(workerId) {
  let worker = batchWorkers[workerId];
  if (worker && worker.win && !worker.win.isDestroyed()) return worker;

  const partition = `${FACEBOOK_PARTITION}-batch-${workerId}`;
  worker = {
    id: workerId,
    ses: getBatchFacebookSession(workerId),
    win: null
  };

  worker.win = new BrowserWindow({
    width: 1100,
    height: 800,
    show: false,
    webPreferences: {
      partition,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: false,
      backgroundThrottling: false,
      images: true,
      javascript: true
    }
  });

  worker.win.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedFacebookUrl(url)) event.preventDefault();
  });

  worker.win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedFacebookUrl(url)) {
      setImmediate(() => {
        if (worker.win && !worker.win.isDestroyed()) worker.win.loadURL(url).catch(() => {});
      });
    }
    return { action: 'deny' };
  });

  worker.win.on('closed', () => {
    worker.win = null;
    batchWorkers[workerId] = null;
  });

  batchWorkers[workerId] = worker;
  return worker;
}

// ===== LẤY TOKEN NHANH =====
async function fetchTokenFast(targetWindow = null, entryUrl = FACEBOOK_ENTRY_URL) {
  const win = targetWindow || await ensureHiddenWindow();

  return new Promise(async (resolve) => {
    let done = false;
    let lastResult = null;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };

    const timer = setTimeout(() => {
      finish(lastResult || {
        success: false,
        authenticated: false,
        authStatus: 'timeout',
        error: 'Facebook không phản hồi trạng thái đăng nhập sau 12 giây.'
      });
    }, 12000); // tối đa 12s mỗi cookie

    const onLoad = async () => {
      let result = { success: false, error: 'Đang chờ Facebook tải dữ liệu', isLoginPage: false };
      // Facebook tải dữ liệu đăng nhập bất đồng bộ, vì vậy cần kiểm tra nhiều lần.
      for (let attempt = 0; attempt < 10; attempt++) {
        await new Promise(r => setTimeout(r, attempt === 0 ? 1200 : 1000));
        result = await extractTokenFast(win);
        lastResult = result;
        if (result.success || ['not_logged_in', 'checkpoint', 'restricted', 'page_error'].includes(result.authStatus)) {
          finish(result);
          return;
        }
      }
      finish(result);
    };

    // Nếu đã có listener cũ thì remove
    win.webContents.removeAllListeners('did-finish-load');
    win.webContents.once('did-finish-load', onLoad);

    try {
      await win.loadURL(entryUrl, { extraHeaders: 'pragma: no-cache\n' });
    } catch (e) {
      finish({
        success: false,
        authenticated: false,
        authStatus: 'navigation_error',
        error: 'Không thể mở Ads Manager. Hãy kiểm tra kết nối mạng hoặc trạng thái Facebook.'
      });
    }
  });
}

// ===== PARSE FILE =====
function parseMultipleCookiesFromText(text) {
  const raw = String(text || '').replace(/^\uFEFF/, '').trim();
  if (!raw) return [];
  const lines = raw.split(/\r?\n/);
  const results = [];

  // JSON array/object và Netscape cookies.txt thường đại diện cho một tài khoản.
  if (raw.startsWith('[') || raw.startsWith('{') ||
      lines.some(line => !line.trim().startsWith('#') && line.split('\t').length >= 7)) {
    const cookies = parseCookieText(raw);
    if (cookies.length) results.push({ cookies, type: 'cookie' });
    return results;
  }

  const meaningfulLines = lines.map(line => line.trim()).filter(line => line && !line.startsWith('#'));
  const looksLikeOneCookiePerLine = meaningfulLines.length > 1 && meaningfulLines.every(line => {
    if (line.includes('|')) return false;
    const parsed = parseCookieText(line);
    return parsed.length === 1;
  });
  if (looksLikeOneCookiePerLine) {
    const cookies = parseCookieText(meaningfulLines.join('; '));
    if (cookies.length) results.push({ cookies, type: 'cookie' });
    return results;
  }

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    if (trimmed.includes('|') && trimmed.includes('business.facebook.com/invitation')) {
      results.push({ cookies: [], type: 'invitation', uid: trimmed.split('|')[0].trim() });
      continue;
    }

    const account = parseAccountCookieLine(trimmed);
    if (account.recognized) {
      const hasSession = account.cookies.some(cookie =>
        ['c_user', 'xs', 'fr', 'datr', 'sb'].includes(cookie.name.toLowerCase())
      );
      results.push({
        cookies: hasSession ? account.cookies : [],
        type: hasSession ? 'account-cookie' : 'invalid-account',
        uid: account.uid
      });
      continue;
    }

    const cookieStr = extractCookieSegment(trimmed);
    const cookies = parseCookieText(cookieStr);
    const hasSession = cookies.some(c => ['c_user', 'xs', 'fr', 'datr', 'sb'].includes(c.name.toLowerCase()));
    if (cookies.length >= 1 && (hasSession || cookies.length >= 3)) {
      // Chỉ giữ cookie; không lưu account/password hoặc preview dòng gốc.
      results.push({ cookies, type: 'cookie' });
    }
  }
  return results;
}

// ===== IPC =====
ipcMain.handle('clear-facebook-cookies', async () => await clearAllFacebookCookies());

ipcMain.handle('login-and-get-token', async (event, cookies) => {
  const facebookCookies = (cookies || []).filter(cookie => normalizeFacebookCookieDomain(cookie.domain));
  const cookieNames = new Set(facebookCookies.map(c => String(c.name || '').trim().toLowerCase()));
  const missing = ['c_user', 'xs'].filter(name => !cookieNames.has(name));
  if (missing.length > 0) {
    return {
      success: false,
      authenticated: false,
      authStatus: 'missing_required',
      error: 'Cookie Facebook thiếu ' + missing.join(' và ') + '. Hãy sao chép đầy đủ cookie từ phiên đăng nhập của chính bạn.'
    };
  }
  await clearAllFacebookCookies();
  const setResult = await setCookiesList(facebookCookies);
  if (setResult.success === 0) {
    return { success: false, authenticated: false, authStatus: 'set_failed', error: 'Không thể nạp cookie Facebook hợp lệ.' };
  }
  sendToRenderer('status-update', { message: 'Đang xác thực cookie với Facebook...', type: 'info' });
  const r = await fetchTokenFast();
  return {
    success: r.authenticated,
    authenticated: r.authenticated,
    authStatus: r.authStatus,
    token: r.token,
    method: r.method,
    uid: r.uid,
    error: r.error
  };
});

ipcMain.handle('open-facebook-external', async () => {
  const win = await ensureHiddenWindow();
  try {
    await win.loadURL(FACEBOOK_ENTRY_URL);
  } catch (e) {}
  return true;
});

ipcMain.handle('copy-text', async (e, text) => {
  clipboard.writeText(text || '');
  return true;
});

ipcMain.handle('select-cookie-file', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: 'Chọn file cookie',
    filters: [{ name: 'Text', extensions: ['txt', 'csv', 'json', 'log'] }, { name: 'All', extensions: ['*'] }],
    properties: ['openFile']
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('select-account-file', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: 'Chọn file tài khoản có cookie',
    filters: [{ name: 'Text', extensions: ['txt', 'csv', 'log'] }, { name: 'All', extensions: ['*'] }],
    properties: ['openFile']
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('parse-cookie-file', async (e, filePath) => {
  try {
    const items = parseMultipleCookiesFromText(fs.readFileSync(filePath, 'utf8'));
    const validCount = items.filter(item => item.cookies && item.cookies.length).length;
    return { success: true, count: items.length, validCount, invalidCount: items.length - validCount };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('parse-account-file', async (e, filePath) => {
  try {
    const items = parseAccountCookieFile(fs.readFileSync(filePath, 'utf8'));
    const validCount = items.filter(item => item.cookies && item.cookies.length).length;
    return { success: true, count: items.length, validCount, invalidCount: items.length - validCount };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

function normalizeBatchOptions(options) {
  const secondWorkerEnabled = options && options.secondWorkerEnabled === true;
  if (!secondWorkerEnabled) {
    return { secondWorkerEnabled: false, secondWorkerUrl: FACEBOOK_ENTRY_URL };
  }

  const secondWorkerUrl = String(options.secondWorkerUrl || '').trim();
  if (!isAllowedFacebookUrl(secondWorkerUrl)) {
    throw new Error('Link của luồng thứ 2 phải là liên kết HTTPS thuộc Facebook');
  }
  return { secondWorkerEnabled: true, secondWorkerUrl };
}

async function runBatch(filePath, parseFile, mode, options) {
  if (isBatchRunning) return { success: false, error: 'Đang chạy' };
  isBatchRunning = true;
  shouldStopBatch = false;

  try {
    const batchOptions = normalizeBatchOptions(options);
    const items = parseFile(fs.readFileSync(filePath, 'utf8'));
    if (!items.length) {
      isBatchRunning = false;
      return {
        success: false,
        error: mode === 'account' ? 'Không tìm thấy dòng tài khoản' : 'Không tìm thấy cookie hợp lệ'
      };
    }

    const requestedWorkerCount = batchOptions.secondWorkerEnabled ? BATCH_CONCURRENCY : 1;
    const workerCount = Math.min(requestedWorkerCount, items.length);
    sendToRenderer('batch-start', { total: items.length, mode, workerCount });
    const workers = await Promise.all(
      Array.from({ length: workerCount }, (_, index) => ensureBatchWorker(index))
    );

    let authenticatedCount = 0, tokenCount = 0, failCount = 0, processedCount = 0;
    const tokens = [];
    let nextIndex = 0;

    async function processItem(worker, i) {
      const item = items[i];
      processedCount++;
      sendToRenderer('batch-progress', {
        current: processedCount,
        total: items.length,
        mode,
        message: `Worker ${worker.id + 1}: đang xử lý dòng ${i + 1}/${items.length}${item.uid ? ` | UID: ${item.uid}` : ''}`
      });

      if (item.type === 'invitation' || item.type === 'invalid-account' ||
          item.type === 'invalid-account-format' || !item.cookies || !item.cookies.length) {
        failCount++;
        const reason = item.type === 'invitation'
          ? 'Bỏ qua dòng invitation'
          : (item.type === 'invalid-account'
            ? 'Không tìm thấy cookie Facebook trong dòng tài khoản'
            : (item.type === 'invalid-account-format'
              ? 'Sai định dạng UID|Mật khẩu|...|cookie'
              : 'Cookie không hợp lệ'));
        sendToRenderer('batch-line', {
          index: i + 1, status: 'fail',
          message: `[${i + 1}] FAIL${item.uid ? ` | UID: ${item.uid}` : ''} | ${reason}`
        });
        return;
      }

      const cookieNames = new Set(item.cookies.map(cookie => String(cookie.name || '').trim().toLowerCase()));
      const missing = ['c_user', 'xs'].filter(name => !cookieNames.has(name));
      if (missing.length) {
        failCount++;
        sendToRenderer('batch-line', {
          index: i + 1,
          status: 'fail',
          message: `[${i + 1}] FAIL${item.uid ? ` | UID: ${item.uid}` : ''} | Cookie thiếu ${missing.join(' và ')}`
        });
        return;
      }

      await clearAllFacebookCookies(worker.ses);
      const setResult = await setCookiesList(item.cookies, worker.ses);
      if (setResult.success === 0) {
        failCount++;
        sendToRenderer('batch-line', { index: i + 1, status: 'fail', message: `[${i + 1}] Không set được cookie` });
        return;
      }

      const entryUrl = worker.id === 1 ? batchOptions.secondWorkerUrl : FACEBOOK_ENTRY_URL;
      const result = await fetchTokenFast(worker.win, entryUrl);

      if (result.authenticated) {
        authenticatedCount++;
        const uid = result.uid || item.uid || 'N/A';
        if (result.token) {
          tokenCount++;
          tokens.push(result.token);
          sendToRenderer('batch-line', {
            index: i + 1, status: 'success',
            message: `[${i + 1}] OK | UID: ${uid} | Đăng nhập thành công, đã lấy token từ Ads Manager`
          });
          sendToRenderer('token-obtained', { index: i + 1, uid, token: result.token });
        } else {
          sendToRenderer('batch-line', {
            index: i + 1, status: 'warning',
            message: `[${i + 1}] LOGIN OK | UID: ${uid} | Đã vào Ads Manager nhưng chưa tìm thấy Access Token`
          });
        }
      } else {
        failCount++;
        const reasonByStatus = {
          not_logged_in: 'Cookie sai, thiếu hoặc đã hết hạn',
          checkpoint: 'Facebook yêu cầu xác minh/checkpoint',
          restricted: 'Tài khoản bị khóa hoặc hạn chế',
          timeout: 'Facebook không phản hồi sau 12 giây',
          navigation_error: 'Không mở được Ads Manager',
          page_error: 'Không kiểm tra được trạng thái trang Facebook'
        };
        const reason = reasonByStatus[result.authStatus] || result.error || 'Đăng nhập không thành công';
        sendToRenderer('batch-line', {
          index: i + 1, status: 'fail',
          message: `[${i + 1}] FAIL${item.uid ? ` | UID: ${item.uid}` : ''} | ${reason}`
        });
      }
    }

    async function runWorker(worker) {
      while (!shouldStopBatch) {
        const i = nextIndex++;
        if (i >= items.length) return;
        await processItem(worker, i);
        if (!shouldStopBatch) await new Promise(resolve => setTimeout(resolve, 200));
      }
    }

    await Promise.all(workers.map(runWorker));

    isBatchRunning = false;
    const stopped = shouldStopBatch && processedCount < items.length;
    sendToRenderer('batch-done', {
      total: items.length,
      processed: processedCount,
      authenticated: authenticatedCount,
      success: tokenCount,
      fail: failCount,
      stopped,
      mode,
      tokens: tokens.filter(Boolean)
    });
    return {
      success: true,
      total: items.length,
      processedCount,
      authenticatedCount,
      tokenCount,
      failCount,
      stopped
    };
  } catch (err) {
    isBatchRunning = false;
    return { success: false, error: err.message };
  }
}

ipcMain.handle('start-batch', async (e, filePath, options) =>
  await runBatch(filePath, parseMultipleCookiesFromText, 'cookie', options));

ipcMain.handle('start-account-batch', async (e, filePath, options) =>
  await runBatch(filePath, parseAccountCookieFile, 'account', options));

ipcMain.handle('stop-batch', async () => {
  shouldStopBatch = true;
  return true;
});

ipcMain.handle('stop-account-batch', async () => {
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
