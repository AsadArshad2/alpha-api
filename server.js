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
    const { shift_id, type, lat, lng, photo_key } = req.body || {};
    if (!shift_id || !type || typeof lat !== 'number' || typeof lng !== 'number') {
      return res.status(400).json({ error: 'missing_or_invalid_fields' });
    }
    if (!['on', 'off'].includes(type)) {
      return res.status(400).json({ error: 'invalid_type' });
    }

    await client.query('BEGIN');

    let photoId = null;
    if (photo_key) {
      const pr = await client.query(
        'INSERT INTO photos (s3_key) VALUES ($1) RETURNING id',
        [photo_key]
      );
      photoId = pr.rows[0].id;
    }

    const br = await client.query(
      `INSERT INTO bookings (shift_id, type, lat, lng, photo_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, captured_at`,
      [shift_id, type, lat, lng, photoId]
    );

    await client.query('COMMIT');
    res.json({ id: br.rows[0].id, captured_at: br.rows[0].captured_at });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.status(500).json({ error: 'server_error' });
  } finally {
    client.release();
  }
});

app.listen(process.env.PORT, () => {
  console.log(`API running on port ${process.env.PORT}`);
});
