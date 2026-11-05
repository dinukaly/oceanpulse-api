import User from "../model/UserSchema.js";
import bcrypt from "bcryptjs";
import { successResponse } from "../utils/responseHandler.js";
import { AppError } from "../middleware/errorHandler.js";
import { clearVerification, issueVerification, verifyCode } from '../utils/verification.js';
import { requireEmailDelivery, sendVerificationEmail } from '../services/verificationEmail.js';
import { generateAccessToken, generateResetToken, verifyJwt } from '../utils/jwt.js';
import { jsonObject, text } from '../utils/validation.js';
import { pagination, pageResult } from '../utils/pagination.js';

const assertPassword = (password) => {
  if (typeof password !== 'string' || Buffer.byteLength(password, 'utf8') > 72 || !/^(?=.*[A-Za-z])(?=.*\d).{8,}$/.test(password)) {
    throw new AppError('Password must have at least 8 characters, a letter and a number', 400);
  }
};

const deliverCode = async (user, purpose) => {
  requireEmailDelivery();
  const code = issueVerification(user, purpose);
  await user.save();
  try {
    await sendVerificationEmail(user.email, code, purpose);
  } catch (error) {
    clearVerification(user);
    await user.save();
    throw error;
  }
};

const generateUsername = (firstName, lastName) => {
  const randomDigits = Math.floor(1000 + Math.random() * 9000);
  return `${firstName.toLowerCase()}.${lastName.toLowerCase()}${randomDigits}`;
};

// Helper to create consistent user response object
const formatUserResponse = (user) => ({
  role: user.role ?? 'fisherman',
  userId: user._id,
  username: user.username,
  email: user.email,
  firstName: user.firstName,
  lastName: user.lastName,
  isActive: user.isActive,
  contact: user.contact || '',
  language: user.language || 'Sinhala',
  boatId: user.boatId || '',
});

const registerUser = async (req, res, next) => {
  try {
    const { firstName, lastName, email, boatId, contact, password } = req.body;
    if (typeof firstName !== 'string' || !firstName.trim() || typeof lastName !== 'string' || !lastName.trim() ||
        typeof email !== 'string' || !email.includes('@') || typeof contact !== 'string' || !contact.trim()) {
      throw new AppError('Name, email and contact are required', 400);
    }
    assertPassword(password);
    requireEmailDelivery();

    const existingEmail = await User.findOne({ email });
    if (existingEmail) {
      throw new AppError("Email already exists", 400);
    }

    const username = generateUsername(firstName, lastName);
    const existingUser = await User.findOne({ username });
    if (existingUser) {
      throw new AppError("Username already exists", 400);
    }

    const salt = bcrypt.genSaltSync(10);
    const hashedPassword = bcrypt.hashSync(password, salt);

    const newUser = new User({
      username,
      firstName,
      lastName,
      email,
      contact,
      password: hashedPassword,
      boatId,
      isActive: false,
      role: 'fisherman',
    });

    await deliverCode(newUser, 'account');

    successResponse(
      res,
      {
        message: "User registered successfully, please verify OTP",
        user: formatUserResponse(newUser),
      },
      201
    );
  } catch (error) {
    next(error);
  }
};

const verifyOtp = async (req, res, next) => {
  try {
    const { username, otp } = req.body;
    const user = await User.findOne({ username });
    if (!user) {
      throw new AppError("User not found", 404);
    }

    if (user.isActive) {
      throw new AppError('Account is already verified', 400);
    }
    await verifyCode(user, 'account', otp);
    user.isActive = true;
    await user.save();

    // Generate new token after OTP verification
    const token = generateAccessToken(user);

    successResponse(res, {
      message: "OTP verified successfully. User account is now active.",
      token,
      user: formatUserResponse(user),
    });
  } catch (error) {
    next(error);
  }
};

const verifyResetOtp = async (req, res, next) => {
  try {
    const { email, otp } = req.body;

    if (!email || !otp) {
      throw new AppError("Email and OTP are required", 400);
    }

    const user = await User.findOne({ email });
    if (!user) {
      throw new AppError("User not found", 404);
    }

    await verifyCode(user, 'password-reset', otp);

    // Generate a special short-lived token for password reset
    const resetToken = generateResetToken(user);

    // Clear the OTP after successful verification
    await user.save();

    successResponse(res, {
      message: "OTP verified successfully. You can now reset your password.",
      success: true,
      resetToken,
      email: user.email,
    });
  } catch (error) {
    next(error);
  }
};

const resetPassword = async (req, res, next) => {
  try {
    const { email, password, resetToken } = req.body;

    if (!email || !password || !resetToken) {
      throw new AppError("Email, password and reset token are required", 400);
    }
    assertPassword(password);

    // Verify reset token
    let decoded;
    try {
      decoded = verifyJwt(resetToken);
    } catch (error) {
      throw new AppError("Invalid or expired reset token", 401);
    }

    // Check if token is for password reset and matches the email
    if (decoded.purpose !== "reset-password" || decoded.email !== email) {
      throw new AppError("Invalid reset token", 401);
    }

    const user = await User.findOne({ email });
    if (!user) {
      throw new AppError("User not found", 404);
    }
    if (decoded.userId !== user._id.toString() || decoded.resetVersion !== (user.resetVersion || 0)) {
      throw new AppError('Invalid reset token', 401);
    }

    // Update password
    const salt = bcrypt.genSaltSync(10);
    const hashedPassword = bcrypt.hashSync(password, salt);
    user.password = hashedPassword;
    user.authVersion = (user.authVersion || 0) + 1;
    user.resetVersion = (user.resetVersion || 0) + 1;
    await user.save();

    successResponse(res, {
      message: "Password reset successfully",
      success: true,
    });
  } catch (error) {
    next(error);
  }
};

const loginUser = async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (typeof email !== 'string' || typeof password !== 'string') {
      throw new AppError('Email and password are required', 400);
    }
    const user = await User.findOne({ email });
    if (!user) {
      throw new AppError("Invalid email or password", 401);
    }

    const isPasswordValid = bcrypt.compareSync(password, user.password);
    if (!isPasswordValid) {
      throw new AppError("Invalid email or password", 401);
    }

    if (user.otp) {
      user.otp = undefined;
      await user.save();
    }

    if (!user.isActive) {
      successResponse(res, { message: 'Account verification required', requiresVerification: true, user: formatUserResponse(user) });
      return;
    }

    successResponse(res, { message: 'Login successful', token: generateAccessToken(user), user: formatUserResponse(user) });
  } catch (error) {
    next(error);
  }
};

const forgotPassword = async (req, res, next) => {
  try {
    const { email } = req.body;

    if (!email) {
      throw new AppError("Email is required", 400);
    }

    const user = await User.findOne({ email });
    if (user) {
      user.resetVersion = (user.resetVersion || 0) + 1;
      await deliverCode(user, 'password-reset');
    }
    successResponse(res, { message: 'If the account exists, a password reset code has been sent' });
  } catch (error) {
    next(error);
  }
};

const resendVerification = async (req, res, next) => {
  try {
    const { username, email } = req.body;
    if (!username || !email) {
      throw new AppError('Username and email are required', 400);
    }
    const user = await User.findOne({ username, email });
    if (user && !user.isActive) {
      await deliverCode(user, 'account');
    }
    successResponse(res, { message: 'If the account needs verification, a code has been sent' });
  } catch (error) {
    next(error);
  }
};

const getUserProfile = async (req, res, next) => {
  try {
    const user = await User.findById(req.user.userId);
    if (!user) {
      throw new AppError('User not found', 404);
    }

    successResponse(res, {
      user: formatUserResponse(user),
      profileVersion: user.__v || 0,
    });
  } catch (error) {
    next(error);
  }
};
const updateUserProfile = async (req, res, next) => {
  try {
    const body = jsonObject(req.body);
    const allowed = ['firstName', 'lastName', 'contact', 'language', 'boatId'];
    const fields = Object.keys(body).filter(
      (field) => field !== 'expectedVersion',
    );
    if (!fields.length || fields.some((field) => !allowed.includes(field))) {
      throw new AppError(
        'Supply only editable profile fields: firstName, lastName, contact, language, boatId',
        400,
      );
    }
    const update = {};
    for (const field of fields)
      update[field] = text(body[field], field, 100, field === 'boatId');
    if (
      body.expectedVersion !== undefined &&
      (!Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 0)
    ) {
      throw new AppError('expectedVersion must be a nonnegative integer', 400);
    }
    if (
      update.language !== undefined &&
      !['Sinhala', 'Tamil'].includes(update.language)
    ) {
      throw new AppError('Language must be Sinhala or Tamil', 400);
    }

    const user = await User.findById(req.user.userId);
    if (!user) {
      throw new AppError('User not found', 404);
    }

    if (
      body.expectedVersion !== undefined &&
      body.expectedVersion !== (user.__v || 0)
    ) {
      throw new AppError(
        'Profile changed since it was loaded. Reload before saving again.',
        409,
        'PROFILE_CONFLICT',
      );
    }
    Object.assign(user, update);

    await user.save({ w: 'majority', wtimeout: 5000 });

    successResponse(res, {
      message: 'Profile updated successfully',
      user: formatUserResponse(user),
      profileVersion: user.__v || 0,
    });
  } catch (error) {
    next(error);
  }
};

const fetchUsers = async (req, res, next) => {
  try {
    const { limit, filter } = pagination(req.query);
    const users = await User.find(
      { $and: [{ _id: { $ne: req.user.userId }, isActive: true }, filter] },
      'firstName lastName username _id'
    ).sort({ _id: -1 }).limit(limit + 1).lean();
    const page = pageResult(users, limit);
    const formattedUsers = page.items.map((user) => ({ userId: String(user._id),
      firstName: user.firstName, lastName: user.lastName, username: user.username }));
    successResponse(res, formattedUsers, 200, { pagination: page.pagination });
  } catch (error) {
    next(error);
  }
};

export default {
  registerUser,
  verifyOtp,
  verifyResetOtp,
  resetPassword,
  loginUser,
  fetchUsers,
  forgotPassword,
  resendVerification,
  getUserProfile,
  updateUserProfile,
};
