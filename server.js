// load the env variables
require('dotenv').config();
// import express web framework
const express = require('express');
// import cors
const cors = require('cors');
// import postgreSQL pool
const { Pool } = require('pg');
// import AWS SDK for S3
const AWS = require('aws-sdk');

// create the express app instance
const app = express();
// parse incoming JSON request bodies into req.body
app.use(express.json());
// enable CORS for the allowed origins from the env var (comma-separated)
app.use(cors({ origin: process.env.CORS_ORIGINS.split(',') }));

// ===================
// DB (PostgreSQL)
// ===================

// create a connection pool using DATABASE_URL; allow SSL even if cert not fully verified
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ===================
// AWS S3
// ===================

// configure AWS SDK with region and credentials from env
AWS.config.update({
  region: process.env.AWS_REGION,
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
});
// s3 client instance for making S3 calls
const s3 = new AWS.S3();
// log the access key id in use (helpful for debugging; consider removing in prod)
console.log('Using AWS key:', AWS.config.credentials.accessKeyId);
// target S3 bucket name from env
const BUCKET = process.env.S3_BUCKET;

// helper: create a time-limited (signed) URL to download an object from S3
function signPhotoUrl(key, expiresSeconds = 3600) {
  // if no key was provided, return null
  if (!key) return null;
  // return a pre-signed GET URL valid for expiresSeconds
  return s3.getSignedUrl('getObject', {
    Bucket: BUCKET,
    Key: key,
    Expires: expiresSeconds,
  });
} 

// helper: convert a value to Number, preserving null for undefined/null inputs
function toNum(v) {
  return v === undefined || v === null ? null : Number(v);
}

// ===================
// Health check route
// ===================

// GET /health — verifies API + DB connectivity
app.get('/health', async (_req, res) => {
  try {
    // simple query to ensure DB is reachable
    const r = await pool.query('SELECT NOW()');
    // respond with ok status and DB time
    res.json({ ok: true, time: r.rows[0] });
  } catch (e) {
    // on failure, return 500 and the error message
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ===================
// S3 presigned upload
// ===================

// POST /photos/presign — returns a presigned POST form so client can upload directly to S3
app.post('/photos/presign', async (req, res) => {
  try {
    // optional filename and filetype from client; defaults if not provided
    const { filename = 'photo.jpg', filetype = 'image/jpeg' } = req.body || {};
    // generate a unique S3 object key under bookings/ using timestamp + random suffix
    const key = `bookings/${Date.now()}-${Math.random().toString(36).slice(2)}-${filename}`;

    // create a presigned POST (browser/app can upload directly to S3 with the returned fields)
    const presigned = await new Promise((resolve, reject) => {
      s3.createPresignedPost(
        {
          Bucket: process.env.S3_BUCKET,
          // Fields lets us lock in the object key being uploaded
          Fields: { key /*, 'Content-Type': filetype */ },
          // presigned form is valid for 60 seconds
          Expires: 60,
          // conditions to enforce on upload (max 5MB here)
          Conditions: [
            ['content-length-range', 1, 5_000_000],
            // you can enforce MIME with Content-Type if needed:
            // ['starts-with', '$Content-Type', 'image/']
          ]
        },
        // node-style callback converted to a promise resolve/reject
        (err, data) => (err ? reject(err) : resolve(data))
      );
    });

    // return the S3 key (client will later store it) and the presigned POST payload
    res.json({ key, presigned });
  } catch (err) {
    // log and return a generic error to client
    console.error('presign error', err);
    res.status(500).json({ error: 'presign_failed' });
  }
});

// ============================================
// Create a booking (optional photo association)
// ============================================

// POST /bookings — inserts a booking row, and a photo row if photo_key is provided
app.post('/bookings', async (req, res) => {
  // get a dedicated client so we can run a transaction
  const client = await pool.connect();
  try {
    // pull fields from the JSON body
    const { shift_id, type, lat, lng, photo_key, taken_at } = req.body || {};

    // validate required fields shift_id and type
    if (!shift_id || !type) {
      return res.status(400).json({ ok: false, error: 'shift_id and type are required' });
    }
    // type must be 'on' or 'off'
    if (!['on', 'off'].includes(String(type))) {
      return res.status(400).json({ ok: false, error: "type must be 'on' or 'off'" });
    }

    // coerce lat/lng to numbers if provided
    const latNum = toNum(lat);
    const lngNum = toNum(lng);
    // if provided but NaN, reject
    if ((lat !== undefined && Number.isNaN(latNum)) || (lng !== undefined && Number.isNaN(lngNum))) {
      return res.status(400).json({ ok: false, error: 'lat/lng must be numbers if provided' });
    }

    // parse optional taken_at (client-side capture timestamp); verify it is a valid date
    const takenAtParam = taken_at ? new Date(taken_at) : null;
    const takenAtValid = takenAtParam instanceof Date && !Number.isNaN(takenAtParam.valueOf());

    // start a database transaction so both photo and booking write atomically
    await client.query('BEGIN');

    // defaults for photo linkage
    let photoId = null;
    let photoUrl = null;

    // if client uploaded a photo and gave us its S3 key, insert a photos row
    if (photo_key) {
      const pr = await client.query(
        `INSERT INTO photos (s3_key) VALUES ($1) RETURNING id, s3_key`,
        [String(photo_key)]
      );
      // remember the new photo id to link from bookings
      photoId = pr.rows[0].id;
      // also generate a signed GET url so client can view immediately
      photoUrl = signPhotoUrl(pr.rows[0].s3_key);
    }

    // insert the booking; captured_at uses taken_at if valid, else defaults to NOW()
    const br = await client.query(
      `INSERT INTO bookings (shift_id, type, lat, lng, photo_id, captured_at)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6::timestamptz, NOW()))
       RETURNING id, shift_id, type, lat, lng, photo_id, captured_at`,
      [
        Number(shift_id),
        String(type),
        latNum,
        lngNum,
        photoId,
        takenAtValid ? takenAtParam.toISOString() : null
      ]
    );

    // commit the transaction (both inserts succeed)
    await client.query('COMMIT');

    // return the new booking plus the signed photo_url (if any)
    const booking = br.rows[0];
    return res.status(201).json({ ok: true, booking: { ...booking, photo_url: photoUrl } });
  } catch (e) {
    // on error, rollback the transaction so nothing partial is saved
    await client.query('ROLLBACK');
    // handle foreign key violations explicitly (e.g., invalid shift_id)
    // Postgres error code 23503 = foreign_key_violation
    if (e && e.code === '23503') {
      return res.status(400).json({ ok: false, error: 'foreign_key_violation', detail: e.detail });
    }
    // log the error and return generic server_error
    console.error('POST /bookings error:', e);
    res.status(500).json({ ok: false, error: 'server_error' });
  } finally {
    // always release the client back to the pool
    client.release();
  }
});

// ===================
// Server bootstrap
// ===================

// start the HTTP server on the port from env
app.listen(process.env.PORT, () => {
  console.log(`API running on port ${process.env.PORT}`);
  console.log("server running ih");
});
