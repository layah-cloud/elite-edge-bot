const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway')
    ? { rejectUnauthorized: false }
    : false
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS members (
      id SERIAL PRIMARY KEY,
      telegram_username VARCHAR(255),
      telegram_id VARCHAR(255),
      full_name VARCHAR(255) NOT NULL,
      join_date DATE,
      plan VARCHAR(255),
      custom_amount DECIMAL(10,2),
      payments_paid INTEGER DEFAULT 0,
      amount_paid DECIMAL(10,2) DEFAULT 0,
      balance_owed DECIMAL(10,2) DEFAULT 0,
      next_payment_due DATE,
      renewal_date DATE,
      payment_schedule TEXT,
      alert VARCHAR(500),
      status VARCHAR(50) DEFAULT 'pending',
      notes TEXT,
      archived_reason TEXT,
      archived_date DATE,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // Add payment_schedule column if it doesn't exist (for existing databases)
  await pool.query(`
    ALTER TABLE members ADD COLUMN IF NOT EXISTS payment_schedule TEXT
  `).catch(() => {});

  // Add email column if it doesn't exist
  await pool.query(`
    ALTER TABLE members ADD COLUMN IF NOT EXISTS email VARCHAR(255)
  `).catch(() => {});

  // Add next_payment_amount column if it doesn't exist
  await pool.query(`
    ALTER TABLE members ADD COLUMN IF NOT EXISTS next_payment_amount DECIMAL(10,2)
  `).catch(() => {});

  // Payments ledger — every payment and renewal logged with date
  await pool.query(`
    CREATE TABLE IF NOT EXISTS payments_ledger (
      id SERIAL PRIMARY KEY,
      member_id INTEGER,
      source VARCHAR(50) NOT NULL DEFAULT 'crm',
      type VARCHAR(50) NOT NULL DEFAULT 'payment',
      amount DECIMAL(10,2) NOT NULL,
      plan VARCHAR(255),
      notes TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // Copy trading member payments table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ct_member_payments (
      id SERIAL PRIMARY KEY,
      bot_member_id INTEGER NOT NULL,
      telegram_username VARCHAR(255),
      full_name VARCHAR(255),
      approval_date DATE,
      amount_paid DECIMAL(10,2) DEFAULT 0,
      renewal_date DATE,
      notes TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // Copy trading deposits — people who paid a deposit but not fully paid yet
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ct_deposits (
      id SERIAL PRIMARY KEY,
      telegram_username VARCHAR(255),
      full_name VARCHAR(255),
      amount_paid DECIMAL(10,2) DEFAULT 0,
      total_owed DECIMAL(10,2) DEFAULT 0,
      balance_owed DECIMAL(10,2) DEFAULT 0,
      next_payment_due DATE,
      next_payment_amount DECIMAL(10,2),
      notes TEXT,
      status VARCHAR(50) DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
}

module.exports = { pool, initDB };
