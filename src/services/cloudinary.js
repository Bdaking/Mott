// Cloudinary (server side only). Admin uploads go through the backend so the API secret is never in a browser.
const fs = require('fs');
const { v2: cloudinary } = require('cloudinary');
const config = require('../config');
const { HttpError } = require('../utils/errors');

const c = config.cloudinary;
const configured = () => Boolean(c.cloudName && c.apiKey && c.apiSecret);
if (configured()) cloudinary.config({ cloud_name: c.cloudName, api_key: c.apiKey, api_secret: c.apiSecret, secure: true });

// kind: poster | backdrop | trailer. Returns { publicId, url }.
async function upload(filePath, { movieId, kind }) {
  if (!configured()) throw new HttpError(503, 'Cloudinary is not configured. Set CLOUDINARY_* in backend/.env', 'CLOUDINARY_NOT_CONFIGURED');
  const isVideo = kind === 'trailer';
  const base = {
    folder: `${c.folder}/movies/${movieId}`,
    public_id: `${kind}-${Date.now()}`,
    resource_type: isVideo ? 'video' : 'image',
    ...(isVideo ? { chunk_size: 6000000 } : {}),
  };
  try {
    let r;
    try {
      // Images: downscale once at upload time (safe incoming transformation, no f_auto).
      r = await cloudinary.uploader.upload(filePath, isVideo ? base : { ...base, transformation: [{ width: 1280, crop: 'limit' }] });
    } catch (e1) {
      if (isVideo) throw e1;
      r = await cloudinary.uploader.upload(filePath, base); // fall back to the untouched original
    }
    // Store the PLAIN delivery URL. URL transformations such as f_auto/q_auto are blocked on accounts
    // with "Strict transformations" enabled, which made the image fail to load in the admin and the app.
    return { publicId: r.public_id, url: r.secure_url };
  } catch (err) {
    throw new HttpError(502, `Cloudinary upload failed: ${err.message || err.error?.message || 'unknown error'}`, 'CLOUDINARY_ERROR');
  } finally { fs.unlink(filePath, () => {}); }
}

async function ping() {
  if (!configured()) throw new Error('CLOUDINARY_* is not set');
  await cloudinary.api.ping();
}

async function destroy(ref, kind) {
  if (!ref?.publicId || !configured()) return;
  await cloudinary.uploader.destroy(ref.publicId, { resource_type: kind === 'trailer' ? 'video' : 'image', invalidate: true })
    .catch((e) => console.error('Cloudinary delete failed:', e.message));
}
async function destroyFolder(movieId) {
  if (!configured()) return;
  const prefix = `${c.folder}/movies/${movieId}`;
  for (const rt of ['image', 'video']) await cloudinary.api.delete_resources_by_prefix(prefix, { resource_type: rt }).catch(() => {});
  await cloudinary.api.delete_folder(prefix).catch(() => {});
}

module.exports = { configured, ping, upload, destroy, destroyFolder };
