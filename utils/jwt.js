import jwt from 'jsonwebtoken';
import { config } from '../config/env.js';

export const generateAccessToken = (user) => jwt.sign(
  { userId: user._id, role: user.role ?? 'fisherman', purpose: 'access', authVersion: user.authVersion || 0 },
  config.jwtSecret,
  { expiresIn: '7d' }
);

export const generateResetToken = (user) => jwt.sign(
  { userId: user._id, email: user.email, purpose: 'reset-password', resetVersion: user.resetVersion || 0 },
  config.jwtSecret,
  { expiresIn: '1h' }
);

export const verifyJwt = (token) => jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
