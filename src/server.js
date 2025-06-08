const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const dotenv = require('dotenv');
const connectDB = require('./config/database');

// Import models
const Driver = require('./models/Driver');
const Location = require('./models/Location');
const Admin = require('./models/Admin');

// Load environment variables
dotenv.config();

// Create Express app
const app = express();
const server = http.createServer(app);

// Initialize Socket.IO
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Middleware
app.use(cors());
app.use(express.json());

// In-memory storage for drivers when DB is not available
let drivers = new Map();
let locations = [];

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Admin login endpoint
app.post('/api/admin/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    // Use environment variables only
    const ADMIN_USERNAME = process.env.ADMIN_USERNAME;
    const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
    
    // Check if environment variables are set
    if (!ADMIN_USERNAME || !ADMIN_PASSWORD) {
      console.error('Admin credentials not configured in environment variables');
      return res.status(500).json({ 
        success: false, 
        message: 'Server configuration error - admin credentials not set' 
      });
    }
    
    console.log('Login attempt:', { username, hasEnvVars: !!ADMIN_USERNAME });
    
    if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
      res.json({ 
        success: true, 
        message: 'Login successful',
        admin: { username: ADMIN_USERNAME }
      });
    } else {
      res.status(401).json({ 
        success: false, 
        message: 'Invalid credentials' 
      });
    }
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error' 
    });
  }
});

// Get all drivers
app.get('/api/drivers', async (req, res) => {
  try {
    if (process.env.MONGODB_URI) {
      const dbDrivers = await Driver.find({}).sort({ lastSeen: -1 });
      res.json({ success: true, drivers: dbDrivers });
    } else {
      const driverList = Array.from(drivers.values());
      res.json({ success: true, drivers: driverList });
    }
  } catch (error) {
    console.error('Error fetching drivers:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Get driver locations
app.get('/api/locations/:deviceId', async (req, res) => {
  try {
    const { deviceId } = req.params;
    
    if (process.env.MONGODB_URI) {
      const dbLocations = await Location.find({ deviceId })
        .sort({ timestamp: -1 })
        .limit(100);
      res.json({ success: true, locations: dbLocations });
    } else {
      const driverLocations = locations.filter(loc => loc.deviceId === deviceId);
      res.json({ success: true, locations: driverLocations });
    }
  } catch (error) {
    console.error('Error fetching locations:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Get all recent locations
app.get('/api/locations', async (req, res) => {
  try {
    if (process.env.MONGODB_URI) {
      // Get latest location for each driver from database
      const dbLocations = await Location.aggregate([
        {
          $sort: { deviceId: 1, timestamp: -1 }
        },
        {
          $group: {
            _id: '$deviceId',
            latestLocation: { $first: '$$ROOT' }
          }
        },
        {
          $replaceRoot: { newRoot: '$latestLocation' }
        }
      ]);
      res.json({ success: true, locations: dbLocations });
    } else {
      // Get last location for each driver from memory
      const recentLocations = [];
      drivers.forEach((driver, deviceId) => {
        const driverLocations = locations.filter(loc => loc.deviceId === deviceId);
        if (driverLocations.length > 0) {
          recentLocations.push(driverLocations[driverLocations.length - 1]);
        }
      });
      res.json({ success: true, locations: recentLocations });
    }
  } catch (error) {
    console.error('Error fetching locations:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Mobile API status
app.get('/api/mobile/status', (req, res) => {
  res.json({
    success: true,
    message: 'Mobile API is running',
    timestamp: new Date().toISOString()
  });
});

// Socket connection handling
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  // Handle driver registration
  socket.on('register-driver', async (data) => {
    const { deviceId, driverName } = data;
    
    const driverData = {
      deviceId,
      driverName,
      isOnline: true,
      lastSeen: new Date().toISOString(),
      socketId: socket.id
    };
    
    try {
      if (process.env.MONGODB_URI) {
        // Save to database
        await Driver.findOneAndUpdate(
          { deviceId },
          { 
            driverName,
            isOnline: true,
            lastSeen: new Date()
          },
          { upsert: true, new: true }
        );
      }
      
      // Also keep in memory for real-time updates
      drivers.set(deviceId, driverData);
      socket.deviceId = deviceId;
      
      console.log(`Driver registered: ${driverName} (${deviceId})`);
      
      // Broadcast driver list update to all clients
      io.emit('drivers-updated', Array.from(drivers.values()));
    } catch (error) {
      console.error('Error registering driver:', error);
    }
  });

  // Handle location updates
  socket.on('location-update', async (locationData) => {
    const { deviceId } = locationData;
    
    // Create location object
    const location = {
      ...locationData,
      timestamp: new Date().toISOString(),
      isOnline: true
    };
    
    try {
      if (process.env.MONGODB_URI) {
        // Save to database
        const newLocation = new Location({
          deviceId: location.deviceId,
          driverName: location.driverName,
          latitude: location.latitude,
          longitude: location.longitude,
          accuracy: location.accuracy,
          speed: location.speed,
          heading: location.heading,
          timestamp: new Date(location.timestamp),
          isOnline: location.isOnline
        });
        await newLocation.save();
        
        // Update driver's last seen
        await Driver.findOneAndUpdate(
          { deviceId },
          { 
            lastSeen: new Date(),
            isOnline: true
          }
        );
      }
      
      // Store in memory for real-time updates
      locations.push(location);
      
      // Keep only last 100 locations per driver in memory
      const deviceLocations = locations.filter(loc => loc.deviceId === deviceId);
      if (deviceLocations.length > 100) {
        const firstOldLocationIndex = locations.findIndex(loc => loc.deviceId === deviceId);
        locations.splice(firstOldLocationIndex, 1);
      }
      
      // Update driver info in memory
      if (drivers.has(deviceId)) {
        const driver = drivers.get(deviceId);
        driver.lastSeen = new Date().toISOString();
        driver.isOnline = true;
        drivers.set(deviceId, driver);
      }
      
      console.log(`Location update from ${deviceId}: ${locationData.latitude}, ${locationData.longitude}`);
      
      // Broadcast location to all admin clients
      io.emit('location-update', location);
    } catch (error) {
      console.error('Error saving location:', error);
    }
  });

  // Handle disconnection
  socket.on('disconnect', async () => {
    console.log('Client disconnected:', socket.id);
    
    if (socket.deviceId) {
      try {
        if (process.env.MONGODB_URI) {
          // Update database
          await Driver.findOneAndUpdate(
            { deviceId: socket.deviceId },
            { 
              isOnline: false,
              lastSeen: new Date()
            }
          );
        }
        
        // Update memory
        if (drivers.has(socket.deviceId)) {
          const driver = drivers.get(socket.deviceId);
          driver.isOnline = false;
          driver.lastSeen = new Date().toISOString();
          drivers.set(socket.deviceId, driver);
          
          // Broadcast driver status update
          io.emit('drivers-updated', Array.from(drivers.values()));
        }
      } catch (error) {
        console.error('Error updating driver status:', error);
      }
    }
  });
});

// Error handling
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({
    success: false,
    message: 'Internal Server Error'
  });
});

// Start server
const PORT = process.env.PORT || 3001;

const startServer = async () => {
  try {
    // Connect to database (optional for MVP)
    if (process.env.MONGODB_URI) {
      await connectDB();
      console.log('📁 Database connected');
      
      // Load existing drivers from database to memory for real-time updates
      const dbDrivers = await Driver.find({ isOnline: true });
      dbDrivers.forEach(driver => {
        drivers.set(driver.deviceId, {
          deviceId: driver.deviceId,
          driverName: driver.driverName,
          isOnline: driver.isOnline,
          lastSeen: driver.lastSeen.toISOString(),
          socketId: null
        });
      });
      console.log(`📊 Loaded ${dbDrivers.length} drivers from database`);
    } else {
      console.log('📁 Using in-memory storage (no database configured)');
    }
    
    server.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
      console.log(`📱 Mobile API: http://localhost:${PORT}/api/mobile`);
      console.log(`🖥️  Admin API: http://localhost:${PORT}/api`);
    });
    
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
};

startServer(); 