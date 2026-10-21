const crypto = require('crypto');

const ENJOY_KEY_HASH = 'd80a77aab8cc2d00b06f6d60554cb261744550048a6d706ca5c143a1181b118e';
const SUCAN_KEY_HASH = '990ff403b746103a970458371c406dfcfda6a757bc4d80186b8471af6a3d9449';

function digest(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest();
}

module.exports = function companyAccess(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false });
  }

  const key = typeof req.body?.key === 'string' ? req.body.key.trim() : '';
  if (!key || key.length > 64) return res.status(401).json({ ok: false });

  const provided = digest(key);
  const matches = hash => crypto.timingSafeEqual(provided, Buffer.from(hash, 'hex'));
  const company = matches(ENJOY_KEY_HASH) ? 'ENJOY' : matches(SUCAN_KEY_HASH) ? 'SUCAN' : null;
  if (!company) return res.status(401).json({ ok: false });
  return res.status(200).json({ ok: true, nombre: company });
};
