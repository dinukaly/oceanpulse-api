import mongoose from "mongoose";

const UserSchema = new mongoose.Schema({
  role: {
    type: String,
    enum: ['fisherman', 'coastguard', 'admin'],
    default: 'fisherman',
    required: true,
  },
  username: {
    type: String,
    required: true,
    unique: true,
  },
  firstName: {
    type: String,
    required: true,
  },
  lastName: {
    type: String,
    required: true,
  },
  email: {
    type: String,
    required: true,
    unique: true,
  },
  otp: {
    type: String,
  },
  verificationCodeHash: String,
  verificationPurpose: {
    type: String,
    enum: ['account', 'password-reset'],
  },
  verificationExpiresAt: Date,
  verificationAttempts: { type: Number, default: 0 },
  verificationSentAt: Date,
  authVersion: { type: Number, default: 0 },
  resetVersion: { type: Number, default: 0 },

  avator: {
    type: Object, //[{hash, resourceUrl, directory, filename}]
  },
  password: {
    type: String,
    required: true,
  },
  isActive: {
    type: Boolean,
  },
  contact: {
    type: String,
    required: true,
  },
  language: {
    type: String,
    enum: ["Sinhala", "Tamil"],
    default: "Sinhala",
  },
  boatId: String, // Only applicable to fishermen

  // emergencyContact: {
  //   name: String,
  //   phone: String,
  // },
}, { optimisticConcurrency: true });

UserSchema.index({ isActive: 1, _id: -1 });
export default mongoose.model("User", UserSchema);
