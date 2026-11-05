import { AppError } from './errorHandler.js';
import User from '../model/UserSchema.js';
import mongoose from 'mongoose';
import { verifyJwt } from '../utils/jwt.js';

export const verifyToken = (token) => {
  try {
    return verifyJwt(token);
  } catch (error) {
    throw new AppError('Invalid token', 401); 
  }
};

// HTTP and WebSocket sessions must enforce the same account/version policy.
export const authenticateAccessToken = async (token) => {
  const decoded = verifyToken(token);
  if (decoded.purpose !== 'access' || !mongoose.isValidObjectId(decoded.userId)) {
    throw new AppError('Invalid token', 401);
  }
  const user = await User.findById(decoded.userId).select('_id username isActive authVersion role');
  if (!user || !user.isActive || decoded.authVersion !== (user.authVersion || 0)) {
    throw new AppError('Account is not active', 401);
  }
  // Legacy accounts/tokens remain fishermen; current database role is authoritative.
  const role = user.role ?? 'fisherman';
  if (!['fisherman', 'coastguard', 'admin'].includes(role)) {
    throw new AppError('Invalid account role', 403);
  }
  return { userId: user._id.toString(), username: user.username, role, expiresAt: decoded.exp };
};

export const authenticateToken = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = /^Bearer (\S+)$/i.exec(authHeader || '')?.[1];

  if (!token) {
    return next(new AppError('Access denied. No token provided.', 401)); 
  }

  try {
    const user = await authenticateAccessToken(token);
    req.user = { userId: user.userId, username: user.username, role: user.role };
    next(); 
  } catch (error) {
    next(error); 
  }
};

export const requireRole = (...allowedRoles) => (req, res, next) => {
  if (!req.user || !allowedRoles.includes(req.user.role)) {
    return next(new AppError('Forbidden: Insufficient privileges for emergency operations', 403));
  }
  next();
};
