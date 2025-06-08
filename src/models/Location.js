const mongoose = require('mongoose');

const locationSchema = new mongoose.Schema({
  deviceId: {
    type: String,
    required: true,
    index: true
  },
  driverName: {
    type: String,
    required: true
  },
  latitude: {
    type: Number,
    required: true,
    min: -90,
    max: 90
  },
  longitude: {
    type: Number,
    required: true,
    min: -180,
    max: 180
  },
  accuracy: {
    type: Number,
    default: 0
  },
  speed: {
    type: Number,
    default: 0
  },
  heading: {
    type: Number,
    default: 0
  },
  timestamp: {
    type: Date,
    required: true,
    default: Date.now,
    index: true
  },
  isOnline: {
    type: Boolean,
    default: true
  }
}, {
  timestamps: true
});

// Index for performance
locationSchema.index({ deviceId: 1, timestamp: -1 });

module.exports = mongoose.model('Location', locationSchema); 