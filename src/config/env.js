'use strict';

// Centralised environment configuration.
// Every value provides a hard-coded fallback so the app boots even when no
// .env file is present (development convenience).
require('dotenv').config();

const config = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT, 10) || 4000,

  // Full connection string is preferred; falls back to a local default.
  databaseUrl:
    process.env.DATABASE_URL ||
    'postgresql://mcp_user:mcp_password@localhost:5432/mcp_rag',

  jwtSecret: process.env.JWT_SECRET || 'default_jwt_secret_for_development',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  bcryptSaltRounds: parseInt(process.env.BCRYPT_SALT_ROUNDS, 10) || 10,

  corsOrigin: process.env.CORS_ORIGIN || '*',
};

module.exports = config;
