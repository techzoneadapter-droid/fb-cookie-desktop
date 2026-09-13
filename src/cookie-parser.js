(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.CookieParser = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const DEFAULT_DOMAIN = '.facebook.com';
  const MAX_INPUT_LENGTH = 2 * 1024 * 1024;
  const MAX_COOKIE_COUNT = 500;
  const MAX_COOKIE_NAME_LENGTH = 256;
  const MAX_COOKIE_VALUE_LENGTH = 16 * 1024;
  const ATTRIBUTES = new Set([
    'domain', 'path', 'expires', 'max-age', 'secure', 'httponly',
    'samesite', 'priority', 'hostonly', 'session', 'storeid', 'partitioned'
  ]);
  const JSON_METADATA = new Set([
    'uid', 'userid', 'user_id', 'timestamp', 'createdat', 'updatedat',
    'name', 'value', 'domain', 'path', 'secure', 'httponly', 'samesite',
    'expirationdate', 'expires', 'cookies', 'data', 'items', 'results',
    'headers', 'header', 'raw', 'url', 'size', 'priority', 'sameparty',
    'sourceport', 'sourcescheme', 'partitionkey', 'partitioned'
  ]);
  const COOKIE_TEXT_KEYS = new Set([
    'cookie', 'cookieheader', 'cookie_header', 'set-cookie', 'setcookie', 'rawcookie'
  ]);

  function isCookieName(name) {
    return !!name && name.length <= MAX_COOKIE_NAME_LENGTH &&
      /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name);
  }

  function normalizeExpiration(value) {
    const expiration = Number(value);
    if (!Number.isFinite(expiration) || expiration <= 0) return undefined;
    return expiration > 1e12 ? Math.floor(expiration / 1000) : expiration;
  }

  function normalizeCookie(item, defaults) {
    if (!item || typeof item !== 'object') return null;
    const name = String(item.name ?? item.key ?? '').trim();
    const rawValue = item.value ?? item.val ?? item.content;
    if (!isCookieName(name) || ATTRIBUTES.has(name.toLowerCase()) || rawValue === undefined) return null;

    const value = String(rawValue).trim();
    if (value.length > MAX_COOKIE_VALUE_LENGTH || /[\u0000\r\n]/.test(value)) return null;

    const cookie = {
      name,
      value,
      domain: String(item.domain || (defaults && defaults.domain) || DEFAULT_DOMAIN).trim() || DEFAULT_DOMAIN,
      path: String(item.path || (defaults && defaults.path) || '/'),
      secure: item.secure !== false,
      httpOnly: !!(item.httpOnly ?? item.httponly)
    };
    const expirationDate = normalizeExpiration(item.expirationDate ?? item.expirationdate ?? item.expires);
    if (expirationDate) cookie.expirationDate = expirationDate;
    return cookie;
  }

  function dedupe(cookies) {
    const map = new Map();
    for (const cookie of cookies) {
      if (!cookie) continue;
      const key = [cookie.name.toLowerCase(), cookie.domain.toLowerCase(), cookie.path].join('|');
      map.set(key, cookie);
      if (map.size >= MAX_COOKIE_COUNT) break;
    }
    return Array.from(map.values());
  }

  function unwrapText(value) {
    let text = String(value || '').trim();
    for (let i = 0; i < 2; i++) {
      const first = text[0];
      const last = text[text.length - 1];
      if (text.length >= 2 && ((first === '"' && last === '"') ||
          (first === "'" && last === "'") || (first === '`' && last === '`'))) {
        text = text.slice(1, -1).trim();
      }
    }
    if (/%(?:3[dD]|3[bB]|0[aA]|09)/.test(text)) {
      try { text = decodeURIComponent(text); } catch (e) {}
    }
    return text;
  }

  function cleanCookieSource(value) {
    let source = unwrapText(value).replace(/^\uFEFF/, '');
    source = source.replace(/\\r\\n|\\n/g, '\n').replace(/\\t/g, '\t');
    source = source.replace(/^\s*(?:document\.cookie|cookies?|cookie_header)\s*=\s*/i, '');
    source = source.replace(/(^|\r?\n)\s*(?:set-cookie|cookie)\s*:\s*/gi, '$1');
    source = source.replace(/([,;]\s*)(?:set-cookie|cookie)\s*:\s*/gi, '$1');

    const embeddedHeader = source.match(/(?:^|\s)(?:set-cookie|cookie)\s*:\s*/i);
    if (embeddedHeader) source = source.slice(embeddedHeader.index + embeddedHeader[0].length);
    return unwrapText(source);
  }

  function stripValueQuotes(value) {
    let result = String(value || '').trim();
    if (result.length >= 2 && ((result[0] === '"' && result[result.length - 1] === '"') ||
        (result[0] === "'" && result[result.length - 1] === "'") ||
        (result[0] === '`' && result[result.length - 1] === '`'))) {
      result = result.slice(1, -1);
    }
    return result.trim();
  }

  function parsePairs(text, defaults) {
    const source = cleanCookieSource(text);
    if (!source) return [];

    // Tách bằng ;, dấu phẩy, xuống dòng hoặc khoảng trắng khi phía sau chắc chắn là name=.
    // Dấu = và dấu phẩy nằm trong value vẫn được giữ nếu không mở đầu một cookie kế tiếp.
    const pairStart = /(^|[;,\r\n]+|\s+(?=[!#$%&'*+\-.^_`|~0-9A-Za-z]+\s*=))\s*([!#$%&'*+\-.^_`|~0-9A-Za-z]+)\s*=\s*/g;
    const matches = [];
    let match;
    while ((match = pairStart.exec(source)) !== null) {
      matches.push({ name: match[2], valueStart: pairStart.lastIndex, matchStart: match.index });
      if (matches.length > MAX_COOKIE_COUNT * 2) break;
    }

    const output = [];
    for (let i = 0; i < matches.length; i++) {
      const current = matches[i];
      const end = i + 1 < matches.length ? matches[i + 1].matchStart : source.length;
      const rawValue = source.slice(current.valueStart, end)
        .replace(/(?:;\s*(?:secure|httponly|partitioned)\s*)+$/i, '')
        .replace(/[;,\s]+$/, '');
      const value = stripValueQuotes(rawValue);
      const cookie = normalizeCookie({ name: current.name, value }, defaults);
      if (cookie) output.push(cookie);
    }
    return output;
  }

  function appendJson(value, output, defaults, depth, inHeaders) {
    if (depth > 12 || output.length >= MAX_COOKIE_COUNT) return;
    if (typeof value === 'string') {
      output.push(...parsePairs(value, defaults));
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(item => appendJson(item, output, defaults, depth + 1, inHeaders));
      return;
    }
    if (!value || typeof value !== 'object') return;

    const headerName = String(value.name ?? value.key ?? '').trim().toLowerCase();
    const headerValue = value.value ?? value.val ?? value.content;
    if (COOKIE_TEXT_KEYS.has(headerName) && typeof headerValue === 'string') {
      output.push(...parsePairs(headerValue, defaults));
      return;
    }
    if (inHeaders && (value.name !== undefined || value.key !== undefined)) return;

    const direct = normalizeCookie(value, defaults);
    if (direct) {
      output.push(direct);
      return;
    }

    const inheritedDefaults = {
      domain: value.domain || (defaults && defaults.domain),
      path: value.path || (defaults && defaults.path)
    };

    for (const [key, val] of Object.entries(value)) {
      const lower = key.toLowerCase();
      if (COOKIE_TEXT_KEYS.has(lower) && typeof val === 'string') {
        output.push(...parsePairs(val, inheritedDefaults));
      } else if (val !== null && typeof val === 'object') {
        appendJson(val, output, inheritedDefaults, depth + 1, lower === 'headers');
      } else if (!inHeaders && !JSON_METADATA.has(lower)) {
        const cookie = normalizeCookie({ name: key, value: val }, inheritedDefaults);
        if (cookie) output.push(cookie);
      }
    }
  }

  function parseCookieObject(value, defaults) {
    const output = [];
    appendJson(value, output, defaults, 0, false);
    return dedupe(output);
  }

  function parseNetscape(lines) {
    const output = [];
    for (const rawLine of lines) {
      let line = rawLine.trim();
      if (!line || (line.startsWith('#') && !line.startsWith('#HttpOnly_'))) continue;
      let httpOnly = false;
      if (line.startsWith('#HttpOnly_')) {
        httpOnly = true;
        line = line.slice('#HttpOnly_'.length);
      }
      const fields = line.split('\t');
      if (fields.length < 7) continue;
      const cookie = normalizeCookie({
        name: fields[5], value: fields.slice(6).join('\t'), domain: fields[0],
        path: fields[2], secure: fields[3].toUpperCase() === 'TRUE',
        httpOnly, expirationDate: fields[4]
      });
      if (cookie) output.push(cookie);
    }
    return output;
  }

  function parseCsvRow(line, delimiter) {
    const fields = [];
    let field = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        if (quoted && line[i + 1] === '"') { field += '"'; i++; } else { quoted = !quoted; }
      } else if (char === delimiter && !quoted) {
        fields.push(field.trim());
        field = '';
      } else {
        field += char;
      }
    }
    fields.push(field.trim());
    return fields;
  }

  function parseCookieTable(lines) {
    if (lines.length < 2) return [];
    const delimiter = lines[0].includes('\t') ? '\t' : ',';
    const headers = parseCsvRow(lines[0], delimiter).map(value => value.toLowerCase().replace(/[^a-z]/g, ''));
    const nameIndex = headers.indexOf('name');
    const valueIndex = headers.indexOf('value');
    if (nameIndex < 0 || valueIndex < 0) return [];

    const indexOf = (...names) => headers.findIndex(header => names.includes(header));
    const domainIndex = indexOf('domain', 'host');
    const pathIndex = indexOf('path');
    const secureIndex = indexOf('secure');
    const httpOnlyIndex = indexOf('httponly');
    const expirationIndex = indexOf('expirationdate', 'expires', 'expiration');
    const output = [];

    for (const line of lines.slice(1)) {
      if (!line.trim()) continue;
      const row = parseCsvRow(line, delimiter);
      const cookie = normalizeCookie({
        name: row[nameIndex], value: row[valueIndex],
        domain: domainIndex >= 0 ? row[domainIndex] : undefined,
        path: pathIndex >= 0 ? row[pathIndex] : undefined,
        secure: secureIndex >= 0 ? !/^(false|0)$/i.test(row[secureIndex]) : true,
        httpOnly: httpOnlyIndex >= 0 && /^(true|1)$/i.test(row[httpOnlyIndex]),
        expirationDate: expirationIndex >= 0 ? row[expirationIndex] : undefined
      });
      if (cookie) output.push(cookie);
    }
    return output;
  }

  function parseCookieText(input) {
    const raw = String(input ?? '').replace(/^\uFEFF/, '').trim();
    if (!raw) return [];
    if (raw.length > MAX_INPUT_LENGTH) throw new Error('Dữ liệu cookie vượt quá giới hạn an toàn 2 MB');

    if (raw.startsWith('[') || raw.startsWith('{') || raw.startsWith('"')) {
      try {
        const jsonCookies = parseCookieObject(JSON.parse(raw));
        if (jsonCookies.length) return jsonCookies;
      } catch (error) {
        // Không dừng ở đây: chuỗi cookie thô đôi khi bắt đầu bằng dấu ngoặc hoặc dấu nháy.
      }
    }

    const lines = raw.split(/\r?\n/);
    const hasNetscapeRows = lines.some(line => !line.trim().startsWith('#') && line.split('\t').length >= 7);
    if (hasNetscapeRows) return dedupe(parseNetscape(lines));

    const tableCookies = parseCookieTable(lines);
    if (tableCookies.length) return dedupe(tableCookies);

    let candidate = raw;
    if (raw.includes('|')) {
      const parts = raw.split('|');
      candidate = parts.find(part => /(?:^|[;,\s])(c_user|xs|fr|datr|sb|wd)\s*=/i.test(part)) ||
        parts.find(part => part.includes('=') && /[;,]/.test(part)) || parts[parts.length - 1];
    }
    return dedupe(parsePairs(candidate));
  }

  return { parseCookieText, parseCookieObject, normalizeCookie };
});
