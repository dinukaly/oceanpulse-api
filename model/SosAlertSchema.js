import mongoose from "mongoose";

const SosNoteSchema = new mongoose.Schema(
  {
    message: {
      type: String,
      required: true,
      trim: true,
      maxlength: 1000,
    },
    authorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    authorName: {
      type: String,
      required: true,
      trim: true,
    },
    action: {
      type: String,
      enum: ['CREATED', 'ACKNOWLEDGE', 'DISPATCH', 'NOTE', 'RESOLVE', 'CANCEL'],
      default: 'NOTE',
      required: true,
    },
    timestamp: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: true }
);

const SosAlertSchema = new mongoose.Schema(
  {
    latitude: {
      type: Number,
      required: true,
    },
    longitude: {
      type: Number,
      required: true,
    },
    timestamp: {
      type: Date,
    },
    userId: {
      type: String,
      required: true,
    },
    username: {
      type: String,
      required: true,
    },
    fishermanName: {
      type: String,
      default: '',
      trim: true,
    },
    contact: {
      type: String,
      default: '',
      trim: true,
    },
    boatId: {
      type: String,
      default: '',
      trim: true,
    },
    status: {
      type: String,
      enum: ['ACTIVE', 'ACKNOWLEDGED', 'RESOLVED', 'CANCELLED'],
      default: 'ACTIVE',
      required: true,
    },
    isHandled: {
      type: Boolean,
      default: false,
    },
    handledBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    handledByName: {
      type: String,
      default: null,
      trim: true,
    },
    acknowledgedAt: {
      type: Date,
      default: null,
    },
    resolvedAt: {
      type: Date,
      default: null,
    },
    cancelledAt: {
      type: Date,
      default: null,
    },
    notes: {
      type: [SosNoteSchema],
      default: [],
    },
  },
  { timestamps: true }
);

// Canonical status derivation: isHandled is strictly derived from status
SosAlertSchema.pre('save', function (next) {
  this.isHandled = ['RESOLVED', 'CANCELLED'].includes(this.status);
  next();
});

SosAlertSchema.index({ userId: 1, isHandled: 1, _id: -1 });
SosAlertSchema.index({ userId: 1 }, {
  name: 'one_active_sos_per_user', unique: true, partialFilterExpression: { isHandled: false },
});
SosAlertSchema.index({ status: 1, _id: -1 });
SosAlertSchema.index({ isHandled: 1, _id: -1 });

export default mongoose.model("SOSAlert", SosAlertSchema);
