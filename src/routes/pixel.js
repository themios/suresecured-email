const express = require('express');
const { pool } = require('../db');

const router = express.Router();

// Hardcoded 43-byte transparent 1x1 GIF — no image library needed
const PIXEL_GIF = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==',
  'base64'
);

// GET /pixel/:token
// Public — no auth. Must be registered before any auth middleware in index.js.
router.get('/:token', async (req, res) => {
  // Respond immediately — email clients time out image requests in ~1-2 seconds
  res.set({
    'Content-Type':   'image/gif',
    'Content-Length': PIXEL_GIF.length,
    'Cache-Control':  'no-store, no-cache, must-revalidate',
    'Pragma':         'no-cache',
  });
  res.end(PIXEL_GIF);

  // Fire-and-forget: increment open_count, set opened_at on first hit
  pool.query(
    `UPDATE email_sends
     SET open_count = open_count + 1,
         opened_at  = COALESCE(opened_at, NOW())
     WHERE pixel_token = $1`,
    [req.params.token]
  ).catch(err => console.error('[pixel] db update error:', err.message));
});

module.exports = router;
