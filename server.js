const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const mongoose = require('mongoose');
const dotenv = require('dotenv');

// Load environment variables
dotenv.config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// MongoDB Connection
const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('📦 MongoDB connected successfully');
  } catch (error) {
    console.error('❌ MongoDB connection error:', error);
    process.exit(1);
  }
};

// Location Schema
const locationSchema = new mongoose.Schema({
  deviceId: {
    type: String,
    required: true,
    index: true
  },
  driverName: {
    type: String,
    default: 'Unknown Driver'
  },
  latitude: {
    type: Number,
    required: true
  },
  longitude: {
    type: Number,
    required: true
  },
  accuracy: {
    type: Number,
    default: 0
  },
  timestamp: {
    type: Date,
    default: Date.now,
    index: true
  },
  speed: {
    type: Number,
    default: 0
  },
  heading: {
    type: Number,
    default: 0
  },
  isOnline: {
    type: Boolean,
    default: true
  }
});

const Location = mongoose.model('Location', locationSchema);

// Driver Schema
const driverSchema = new mongoose.Schema({
  deviceId: {
    type: String,
    required: true,
    unique: true
  },
  driverName: {
    type: String,
    required: true
  },
  isActive: {
    type: Boolean,
    default: true
  },
  lastSeen: {
    type: Date,
    default: Date.now
  },
  currentLocation: {
    latitude: Number,
    longitude: Number,
    timestamp: Date
  }
});

const Driver = mongoose.model('Driver', driverSchema);

// Store active connections
const activeConnections = new Map();

// Connect to MongoDB
connectDB();

// Basic routes
app.get('/', (req, res) => {
  res.json({
    message: 'Logistics Location Tracker Backend',
    status: 'running',
    activeDrivers: activeConnections.size
  });
});

// Get all active drivers
app.get('/api/drivers', async (req, res) => {
  try {
    const drivers = await Driver.find({ isActive: true }).sort({ lastSeen: -1 });
    res.json(drivers);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get driver's location history
app.get('/api/locations/:deviceId', async (req, res) => {
  try {
    const { deviceId } = req.params;
    const { hours = 24 } = req.query;
    
    const startTime = new Date(Date.now() - hours * 60 * 60 * 1000);
    const locations = await Location.find({
      deviceId,
      timestamp: { $gte: startTime }
    }).sort({ timestamp: -1 });
    
    res.json(locations);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log('New client connected:', socket.id);

  // Handle driver registration
  socket.on('registerDriver', async (driverData) => {
    try {
      const { deviceId, driverName } = driverData;
      
      // Update or create driver record
      await Driver.findOneAndUpdate(
        { deviceId },
        { 
          driverName,
          isActive: true,
          lastSeen: new Date()
        },
        { upsert: true, new: true }
      );

      // Store connection info
      activeConnections.set(socket.id, { deviceId, driverName });
      
      console.log(`Driver registered: ${driverName} (${deviceId})`);
      
      // Send active drivers to admin panels
      const activeDrivers = await Driver.find({ isActive: true });
      io.emit('driversUpdate', activeDrivers);
      
    } catch (error) {
      console.error('Driver registration error:', error);
      socket.emit('error', 'Failed to register driver');
    }
  });

  // Handle location updates from mobile app
  socket.on('sendLocation', async (locationData) => {
    try {
      const connectionInfo = activeConnections.get(socket.id);
      if (!connectionInfo) {
        socket.emit('error', 'Driver not registered');
        return;
      }

      const { deviceId } = connectionInfo;
      
      // Save location to database
      const location = new Location({
        ...locationData,
        deviceId,
        timestamp: new Date(locationData.timestamp),
        isOnline: true
      });
      
      await location.save();

      // Update driver's current location and last seen
      await Driver.findOneAndUpdate(
        { deviceId },
        {
          currentLocation: {
            latitude: locationData.latitude,
            longitude: locationData.longitude,
            timestamp: new Date()
          },
          lastSeen: new Date()
        }
      );

      console.log(`Location saved for driver ${deviceId}:`, locationData);

      // Broadcast location to all connected admin panels
      io.emit('locationUpdate', {
        ...locationData,
        deviceId,
        driverName: connectionInfo.driverName,
        socketId: socket.id
      });

    } catch (error) {
      console.error('Location save error:', error);
      socket.emit('error', 'Failed to save location');
    }
  });

  // Handle bulk location sync (for offline data)
  socket.on('syncLocations', async (locationsArray) => {
    try {
      const connectionInfo = activeConnections.get(socket.id);
      if (!connectionInfo) {
        socket.emit('error', 'Driver not registered');
        return;
      }

      const { deviceId } = connectionInfo;
      
      // Process bulk locations
      const locationDocs = locationsArray.map(loc => ({
        ...loc,
        deviceId,
        timestamp: new Date(loc.timestamp),
        isOnline: false // Mark as synced offline data
      }));

      await Location.insertMany(locationDocs);
      
      console.log(`Synced ${locationsArray.length} offline locations for driver ${deviceId}`);
      
      // Send confirmation
      socket.emit('syncComplete', { 
        count: locationsArray.length,
        message: 'Locations synced successfully'
      });

      // Update admin panels with latest location
      if (locationsArray.length > 0) {
        const latestLocation = locationsArray[locationsArray.length - 1];
        io.emit('locationUpdate', {
          ...latestLocation,
          deviceId,
          driverName: connectionInfo.driverName,
          socketId: socket.id
        });
      }

    } catch (error) {
      console.error('Bulk location sync error:', error);
      socket.emit('syncError', 'Failed to sync offline locations');
    }
  });

  // Handle disconnection
  socket.on('disconnect', async () => {
    const connectionInfo = activeConnections.get(socket.id);
    if (connectionInfo) {
      console.log(`Driver disconnected: ${connectionInfo.driverName} (${connectionInfo.deviceId})`);
      
      // Update driver status but don't set inactive immediately
      // (they might reconnect soon)
      try {
        await Driver.findOneAndUpdate(
          { deviceId: connectionInfo.deviceId },
          { lastSeen: new Date() }
        );
      } catch (error) {
        console.error('Error updating driver on disconnect:', error);
      }
      
      activeConnections.delete(socket.id);
    }
  });

  // Handle errors
  socket.on('error', (error) => {
    console.error('Socket error:', error);
  });
});

// Cleanup inactive drivers periodically (every 5 minutes)
setInterval(async () => {
  try {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    await Driver.updateMany(
      { lastSeen: { $lt: fiveMinutesAgo } },
      { isActive: false }
    );
  } catch (error) {
    console.error('Error cleaning up inactive drivers:', error);
  }
}, 5 * 60 * 1000);

server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📍 Logistics location tracking backend ready`);
  console.log(`🚛 Multiple driver support enabled`);
  console.log(`💾 MongoDB integration active`);
}); 