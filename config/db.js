const mysql = require('mysql2/promise');
require('dotenv').config();

// Defaults match the "db" service in docker-compose.yml.
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 3307,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || 'geoattend_root',
  database: process.env.DB_NAME || 'geoattend_pro',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  dateStrings: true,
  // Keep-alive and a short idleTimeout reduce the chance of being handed a
  // connection MySQL already closed; the one-time retry below covers the rest.
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000,
  idleTimeout: 60000
});

// Without a listener, a dropped idle connection crashes the process.
pool.pool.on('error', (err) => {
  console.error('MySQL pool connection error (recovered):', err.code || err.message);
});

// Retry once when a pooled connection turns out to be dead before the query ran.
const FATAL_CONNECTION_CODES = new Set([
  'ECONNRESET',
  'PROTOCOL_CONNECTION_LOST',
  'EPIPE',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ECONNREFUSED'
]);

function isRetriableConnectionError(err) {
  return !!err && (FATAL_CONNECTION_CODES.has(err.code) || err.fatal === true);
}

for (const method of ['query', 'execute']) {
  const original = pool[method].bind(pool);
  pool[method] = async (...args) => {
    try {
      return await original(...args);
    } catch (err) {
      if (!isRetriableConnectionError(err)) throw err;
      console.warn(`MySQL ${method} hit a dead connection (${err.code}); retrying once on a fresh connection.`);
      return await original(...args);
    }
  };
}

// Run MySQL sessions in Philippine time so NOW() matches stored event times.
pool.pool.on('connection', (conn) => {
  conn.query(`SET time_zone = '${process.env.DB_TIMEZONE || '+08:00'}'`);
});

pool.getConnection()
  .then(conn => {
    console.log('MySQL connected successfully.');
    conn.release();
  })
  .catch(err => {
    console.error('MySQL connection failed:', err.message);
    console.error('Check your .env DB_* values and that the MySQL container is running (docker compose up -d db).');
  });

module.exports = pool;
