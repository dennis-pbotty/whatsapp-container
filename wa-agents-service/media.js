const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CDN_HOST = 'mmg.whatsapp.net';
const MEDIA_CACHE_DIR = process.env.MEDIA_CACHE_DIR || '/data/media';

const MEDIA_INFO = {
  image:    'WhatsApp Image Keys',
  video:    'WhatsApp Video Keys',
  audio:    'WhatsApp Audio Keys',
  document: 'WhatsApp Document Keys',
  sticker:  'WhatsApp Image Keys',
};

function deriveKeys(mediaKeyBuf, mediaType) {
  const info = MEDIA_INFO[mediaType] || 'WhatsApp Image Keys';
  const salt = Buffer.alloc(32, 0);
  const hkdf = crypto.hkdfSync('sha256', mediaKeyBuf, salt, info, 112);
  return {
    iv:        Buffer.from(hkdf.slice(0, 16)),
    cipherKey: Buffer.from(hkdf.slice(16, 48)),
  };
}

function decrypt(encData, mediaKeyBuf, mediaType) {
  const { iv, cipherKey } = deriveKeys(mediaKeyBuf, mediaType);
  // WhatsApp appends 10-byte HMAC; strip it before decrypting
  const payload = encData.slice(0, -10);
  const decipher = crypto.createDecipheriv('aes-256-cbc', cipherKey, iv);
  decipher.setAutoPadding(true);
  return Buffer.concat([decipher.update(payload), decipher.final()]);
}

function download(directPath) {
  return new Promise((resolve, reject) => {
    const url = `https://${CDN_HOST}${directPath}`;
    const req = https.get(url, { headers: { 'User-Agent': 'WhatsApp/2.24.3.78 A' } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`CDN ${res.statusCode} for ${directPath.slice(0, 50)}`));
      }
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(30_000, () => { req.destroy(new Error('CDN download timeout')); });
  });
}

function mimeToExt(mimeType, filename, mediaType) {
  if (filename) {
    const ext = path.extname(filename);
    if (ext) return ext;
  }
  const mimeMap = {
    'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp',
    'image/gif': '.gif', 'video/mp4': '.mp4', 'video/3gpp': '.3gp',
    'audio/ogg; codecs=opus': '.ogg', 'audio/ogg': '.ogg',
    'audio/mp4': '.m4a', 'audio/aac': '.aac', 'application/pdf': '.pdf',
  };
  if (mimeType && mimeMap[mimeType]) return mimeMap[mimeType];
  const fallback = { image: '.jpg', video: '.mp4', audio: '.ogg', document: '.bin', sticker: '.webp' };
  return fallback[mediaType] || '.bin';
}

async function fetchMedia(msg) {
  // msg: { rowid, media_type, media_key (Buffer), direct_path, mime_type, filename }
  if (!msg.media_key || !msg.direct_path) throw new Error('no media_key or direct_path');

  const ext = mimeToExt(msg.mime_type, msg.filename, msg.media_type);
  const cachePath = path.join(MEDIA_CACHE_DIR, `${msg.rowid}${ext}`);

  if (fs.existsSync(cachePath)) {
    return { data: fs.readFileSync(cachePath), mimeType: msg.mime_type || 'application/octet-stream' };
  }

  const encData = await download(msg.direct_path);
  const data = decrypt(encData, msg.media_key, msg.media_type);

  fs.mkdirSync(MEDIA_CACHE_DIR, { recursive: true });
  fs.writeFileSync(cachePath, data);

  return { data, mimeType: msg.mime_type || 'application/octet-stream' };
}

module.exports = { fetchMedia };
