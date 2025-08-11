require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const AWS = require('aws-sdk');

const app = express();
app.use(express.json());
app.use(cors({ origin: process.env.CORS_ORIGINS.split(',') }));

// DB
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// S3
AWS.config.update({
  region: process.env.AWS_REGION,
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
});
const s3 = new AWS.S3();
console.log('Using AWS key:', AWS.config.credentials.accessKeyId);
const BUCKET = process.env.S3_BUCKET;

function signPhotoUrl(key, expiresSeconds = 3600) {
  if (!key) return null;
  return s3.getSignedUrl('getObject', {
    Bucket: BUCKET,
    Key: key,
    Expires: expiresSeconds,
  });
}

function toNum(v) {
  return v === undefined || v === null ? null : Number(v);
}


// Health
app.get('/health', async (_req, res) => {
  try {
    const r = await pool.query('SELECT NOW()');
    res.json({ ok: true, time: r.rows[0] });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Presign upload
app.post('/photos/presign', async (req, res) => {
  try {
    const { filename = 'photo.jpg', filetype = 'image/jpeg' } = req.body || {};
    const key = `bookings/${Date.now()}-${Math.random().toString(36).slice(2)}-${filename}`;

    const presigned = await new Promise((resolve, reject) => {
      s3.createPresignedPost(
        {
          Bucket: process.env.S3_BUCKET,
          Fields: { key },
          Expires: 60,
          Conditions: [
            ['content-length-range', 1, 5_000_000],
            // ['starts-with', '$Content-Type', '']
          ]
        },
        (err, data) => (err ? reject(err) : resolve(data))
      );
    });

    res.json({ key, presigned });
  } catch (err) {
    console.error('presign error', err);
    res.status(500).json({ error: 'presign_failed' });
  }
});

// Create a booking (and photo row if provided)
app.post('/bookings', async (req, res) => {
  const client = await pool.connect();
  try {
    const { shift_id, type, lat, lng, photo_key, taken_at } = req.body || {};

    if (!shift_id || !type) {
      return res.status(400).json({ ok: false, error: 'shift_id and type are required' });
    }
    if (!['on', 'off'].includes(String(type))) {
      return res.status(400).json({ ok: false, error: "type must be 'on' or 'off'" });
    }

    const latNum = toNum(lat);
    const lngNum = toNum(lng);
    if ((lat !== undefined && Number.isNaN(latNum)) || (lng !== undefined && Number.isNaN(lngNum))) {
      return res.status(400).json({ ok: false, error: 'lat/lng must be numbers if provided' });
    }

    const takenAtParam = taken_at ? new Date(taken_at) : null;
    const takenAtValid = takenAtParam instanceof Date && !Number.isNaN(takenAtParam.valueOf());

    await client.query('BEGIN');

    let photoId = null;
    let photoUrl = null;
    if (photo_key) {
      const pr = await client.query(
        `INSERT INTO photos (s3_key) VALUES ($1) RETURNING id, s3_key`,
        [String(photo_key)]
      );
      photoId = pr.rows[0].id;
      photoUrl = signPhotoUrl(pr.rows[0].s3_key);
    }

    const br = await client.query(
      `INSERT INTO bookings (shift_id, type, lat, lng, photo_id, captured_at)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6::timestamptz, NOW()))
       RETURNING id, shift_id, type, lat, lng, photo_id, captured_at`,
      [Number(shift_id), String(type), latNum, lngNum, photoId, takenAtValid ? takenAtParam.toISOString() : null]
    );

    await client.query('COMMIT');

    const booking = br.rows[0];
    return res.status(201).json({ ok: true, booking: { ...booking, photo_url: photoUrl } });
  } catch (e) {
    await client.query('ROLLBACK');
    // 23503 = foreign key violation (e.g., shift_id not found)
    if (e && e.code === '23503') {
      return res.status(400).json({ ok: false, error: 'foreign_key_violation', detail: e.detail });
    }
    console.error('POST /bookings error:', e);
    res.status(500).json({ ok: false, error: 'server_error' });
  } finally {
    client.release();
  }
});


app.listen(process.env.PORT, () => {
  console.log(`API running on port ${process.env.PORT}`);
});
