const mongoose = require('mongoose');

const driverSchema = new mongoose.Schema({
  deviceId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  driverName: {
    type: String,
    required: true,
    trim: true
  },
  isOnline: {
    type: Boolean,
    default: false
  },
  lastSeen: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

// Index for performance
driverSchema.index({ lastSeen: -1 });

module.exports = mongoose.model('Driver', driverSchema); 