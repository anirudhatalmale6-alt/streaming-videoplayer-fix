import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { createClient, RedisClientType } from 'redis';
import { Pool } from 'pg';
import multer from 'multer';
import * as mm from 'music-metadata';
import * as schedule from 'node-schedule';
import { v4 as uuidv4 } from 'uuid';
import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as jwt from 'jsonwebtoken';

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // For Icecast auth POST data

// JWT Secret
const JWT_SECRET = process.env.JWT_SECRET || 'your_jwt_secret_here';

// Authenticated request interface
interface AuthRequest extends Request {
  user?: {
    id: string;
    email: string;
    role: string;
    services: string[];
  };
}

// Authentication middleware
const authMiddleware = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET) as any;

    req.user = {
      id: decoded.id,
      email: decoded.email,
      role: decoded.role,
      services: decoded.services || []
    };

    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid token' });
  }
};

// Check if user has audio service access
const checkAudioAccess = (req: AuthRequest, res: Response, next: NextFunction) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Admins have full access
  if (req.user.role === 'admin') {
    return next();
  }

  // Check if user has audio service
  if (!req.user.services.includes('audio')) {
    return res.status(403).json({ error: 'Audio service not enabled for this account' });
  }

  next();
};

// Helper to check station access
async function checkStationAccess(stationId: string, userId: string, userRole: string): Promise<any> {
  if (userRole === 'admin') {
    const result = await pool.query('SELECT * FROM audio_stations WHERE id = $1', [stationId]);
    return result.rows[0];
  } else {
    const result = await pool.query('SELECT * FROM audio_stations WHERE id = $1 AND created_by = $2', [stationId, userId]);
    return result.rows[0];
  }
}

// Environment
const ICECAST_HOST = process.env.ICECAST_HOST || 'icecast';
const ICECAST_PORT = process.env.ICECAST_PORT || '8000';
const ICECAST_SOURCE_PASSWORD = process.env.ICECAST_SOURCE_PASSWORD || 'streaming_source_123';
const PUBLIC_DOMAIN = process.env.PUBLIC_DOMAIN || 'cmcred.net';
const ICECAST_ADMIN_PASSWORD = process.env.ICECAST_ADMIN_PASSWORD || 'streaming_admin_456';

// Function to kill an Icecast mount point
async function killIcecastMount(mountPoint: string): Promise<void> {
  try {
    const response = await fetch(
      `http://${ICECAST_HOST}:${ICECAST_PORT}/admin/killsource?mount=/${mountPoint}`,
      {
        method: 'GET',
        headers: {
          'Authorization': 'Basic ' + Buffer.from(`admin:${ICECAST_ADMIN_PASSWORD}`).toString('base64')
        }
      }
    );
    console.log('[Icecast] Kill mount response:', response.status, 'for mount:', mountPoint);
  } catch (error) {
    console.error('[Icecast] Error killing mount:', mountPoint, error);
  }
}

// Redis client
let redis: RedisClientType;

// PostgreSQL pool
const pool = new Pool({
  connectionString: process.env.POSTGRES_URL
});

// Storage configuration
const storage = multer.diskStorage({
  destination: '/storage/audio/library',
  filename: (req, file, cb) => {
    const uniqueName = `${uuidv4()}${path.extname(file.originalname)}`;
    cb(null, uniqueName);
  }
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/ogg', 'audio/aac', 'audio/flac'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid audio file type'));
    }
  },
  limits: { fileSize: 500 * 1024 * 1024 } // 500MB max
});

// Active Auto DJ processes (station_id -> ffmpeg process)
const autoDJProcesses: Map<string, ChildProcess> = new Map();

// Active live DJ connections (mount_point -> { stationId, djId })
const liveDJConnections: Map<string, { stationId: string; djId: string }> = new Map();

// Station listener counts
const listenerCounts: Map<string, number> = new Map();

// Current playing track per station
const currentTracks: Map<string, { trackId: string; startedAt: Date }> = new Map();

// Generate secure stream key
function generateStreamKey(): string {
  return crypto.randomBytes(16).toString('hex');
}

// Generate secure password
function generatePassword(): string {
  return crypto.randomBytes(12).toString('base64').replace(/[/+=]/g, '').substring(0, 16);
}

// Base port for audio streams (stations get 8001, 8002, 8003, etc.)
const BASE_STREAM_PORT = 8001;
const MAX_STREAM_PORT = 8100;

// Get next available port for a new station
async function getNextAvailablePort(): Promise<number> {
  const result = await pool.query(
    'SELECT stream_port FROM audio_stations WHERE stream_port IS NOT NULL ORDER BY stream_port'
  );

  const usedPorts = new Set(result.rows.map(r => r.stream_port));

  for (let port = BASE_STREAM_PORT; port <= MAX_STREAM_PORT; port++) {
    if (!usedPorts.has(port)) {
      return port;
    }
  }

  throw new Error('No available ports for new station');
}

// Generate Icecast config for a station
function generateIcecastConfig(station: { id: string; name: string; stream_port: number; source_password: string; mount_point: string }): string {
  return `<icecast>
    <limits>
        <clients>100</clients>
        <sources>5</sources>
        <threadpool>5</threadpool>
        <queue-size>524288</queue-size>
        <client-timeout>30</client-timeout>
        <header-timeout>15</header-timeout>
        <source-timeout>10</source-timeout>
        <burst-on-connect>1</burst-on-connect>
        <burst-size>65535</burst-size>
    </limits>
    <authentication>
        <source-password>${station.source_password}</source-password>
        <relay-password>relay_${station.source_password}</relay-password>
        <admin-user>admin</admin-user>
        <admin-password>admin_${station.source_password}</admin-password>
    </authentication>
    <hostname>${PUBLIC_DOMAIN}</hostname>
    <listen-socket>
        <port>8000</port>
    </listen-socket>
    <fileserve>1</fileserve>
    <paths>
        <basedir>/usr/share/icecast2</basedir>
        <logdir>/var/log/icecast2</logdir>
        <webroot>/usr/share/icecast2/web</webroot>
        <adminroot>/usr/share/icecast2/admin</adminroot>
        <alias source="/" dest="/status.xsl"/>
    </paths>
    <logging>
        <accesslog>access.log</accesslog>
        <errorlog>error.log</errorlog>
        <loglevel>2</loglevel>
        <logsize>10000</logsize>
    </logging>
    <security>
        <chroot>0</chroot>
    </security>
</icecast>`;
}

// Track running Icecast containers per station
const icecastContainers = new Map<string, string>(); // stationId -> containerId

// Start Icecast container for a station
async function startIcecastForStation(station: { id: string; name: string; stream_port: number; source_password: string; mount_point: string }): Promise<void> {
  const containerName = `icecast-station-${station.id.substring(0, 8)}`;

  // Check if container already exists
  const { exec } = require('child_process');
  const util = require('util');
  const execPromise = util.promisify(exec);

  try {
    // Stop existing container if any
    await execPromise(`docker stop ${containerName} 2>/dev/null || true`);
    await execPromise(`docker rm ${containerName} 2>/dev/null || true`);

    // Create config file
    const configPath = `/tmp/icecast-${station.id}.xml`;
    fs.writeFileSync(configPath, generateIcecastConfig(station));

    // Start new Icecast container with station-specific port and password
    const cmd = `docker run -d --name ${containerName} \\
      --network streaming-platform_streaming-network \\
      -p ${station.stream_port}:8000 \\
      -v ${configPath}:/etc/icecast2/icecast.xml:ro \\
      -e ICECAST_SOURCE_PASSWORD=${station.source_password} \\
      -e ICECAST_ADMIN_PASSWORD=admin_${station.source_password} \\
      moul/icecast`;

    await execPromise(cmd);
    icecastContainers.set(station.id, containerName);
    console.log(`[Icecast] Started container ${containerName} on port ${station.stream_port}`);
  } catch (error) {
    console.error(`[Icecast] Failed to start container for station ${station.id}:`, error);
  }
}

// Stop Icecast container for a station
async function stopIcecastForStation(stationId: string): Promise<void> {
  const containerName = icecastContainers.get(stationId) || `icecast-station-${stationId.substring(0, 8)}`;

  const { exec } = require('child_process');
  const util = require('util');
  const execPromise = util.promisify(exec);

  try {
    await execPromise(`docker stop ${containerName} 2>/dev/null || true`);
    await execPromise(`docker rm ${containerName} 2>/dev/null || true`);
    icecastContainers.delete(stationId);
    console.log(`[Icecast] Stopped container ${containerName}`);
  } catch (error) {
    console.error(`[Icecast] Failed to stop container for station ${stationId}:`, error);
  }
}

// Initialize database tables
async function initDatabase() {
  await pool.query(`
    -- Stations table with Auto DJ settings
    CREATE TABLE IF NOT EXISTS audio_stations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name VARCHAR(255) NOT NULL,
      description TEXT,
      genre VARCHAR(100),
      cover_image VARCHAR(500),
      mount_point VARCHAR(100) UNIQUE NOT NULL,
      stream_port INTEGER UNIQUE,
      bitrate INTEGER DEFAULT 128,
      is_active BOOLEAN DEFAULT true,
      auto_dj_enabled BOOLEAN DEFAULT true,
      auto_dj_playlist_id UUID,
      crossfade_duration INTEGER DEFAULT 3,
      created_by UUID,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- Mount points table (multiple per station for different qualities)
    CREATE TABLE IF NOT EXISTS station_mount_points (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      station_id UUID REFERENCES audio_stations(id) ON DELETE CASCADE,
      mount_point VARCHAR(100) UNIQUE NOT NULL,
      bitrate INTEGER DEFAULT 128,
      format VARCHAR(20) DEFAULT 'mp3',
      is_primary BOOLEAN DEFAULT false,
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- DJ/Presenter accounts with streaming credentials
    CREATE TABLE IF NOT EXISTS station_djs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      station_id UUID REFERENCES audio_stations(id) ON DELETE CASCADE,
      user_id UUID,
      dj_name VARCHAR(255) NOT NULL,
      stream_key VARCHAR(64) UNIQUE NOT NULL,
      stream_password VARCHAR(64) NOT NULL,
      can_stream BOOLEAN DEFAULT true,
      can_manage_playlist BOOLEAN DEFAULT false,
      is_active BOOLEAN DEFAULT true,
      last_connected TIMESTAMP,
      total_airtime INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- Audio tracks library
    CREATE TABLE IF NOT EXISTS audio_tracks (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      title VARCHAR(255) NOT NULL,
      artist VARCHAR(255),
      album VARCHAR(255),
      genre VARCHAR(100),
      duration INTEGER,
      file_path VARCHAR(500) NOT NULL,
      file_size BIGINT,
      bitrate INTEGER,
      sample_rate INTEGER,
      cover_image VARCHAR(500),
      play_count INTEGER DEFAULT 0,
      last_played TIMESTAMP,
      uploaded_by UUID,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- Station playlists
    CREATE TABLE IF NOT EXISTS station_playlists (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      station_id UUID REFERENCES audio_stations(id) ON DELETE CASCADE,
      name VARCHAR(255) NOT NULL,
      description TEXT,
      is_default BOOLEAN DEFAULT false,
      shuffle_enabled BOOLEAN DEFAULT false,
      repeat_mode VARCHAR(20) DEFAULT 'all',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- Playlist tracks with ordering
    CREATE TABLE IF NOT EXISTS playlist_tracks (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      playlist_id UUID REFERENCES station_playlists(id) ON DELETE CASCADE,
      track_id UUID REFERENCES audio_tracks(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(playlist_id, track_id)
    );

    -- Station schedule for DJ shows
    CREATE TABLE IF NOT EXISTS station_schedule (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      station_id UUID REFERENCES audio_stations(id) ON DELETE CASCADE,
      dj_id UUID REFERENCES station_djs(id) ON DELETE SET NULL,
      playlist_id UUID REFERENCES station_playlists(id) ON DELETE SET NULL,
      day_of_week INTEGER,
      start_time TIME NOT NULL,
      end_time TIME NOT NULL,
      show_name VARCHAR(255),
      description TEXT,
      is_live BOOLEAN DEFAULT false,
      auto_start BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- Live stream history/logs
    CREATE TABLE IF NOT EXISTS stream_history (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      station_id UUID REFERENCES audio_stations(id) ON DELETE CASCADE,
      dj_id UUID REFERENCES station_djs(id) ON DELETE SET NULL,
      started_at TIMESTAMP NOT NULL,
      ended_at TIMESTAMP,
      peak_listeners INTEGER DEFAULT 0,
      avg_listeners INTEGER DEFAULT 0,
      stream_type VARCHAR(20) DEFAULT 'auto_dj'
    );

    -- Analytics
    CREATE TABLE IF NOT EXISTS audio_analytics (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      station_id UUID REFERENCES audio_stations(id) ON DELETE CASCADE,
      track_id UUID REFERENCES audio_tracks(id) ON DELETE SET NULL,
      listener_count INTEGER DEFAULT 0,
      peak_listeners INTEGER DEFAULT 0,
      total_listen_time INTEGER DEFAULT 0,
      recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- Now playing info per station
    CREATE TABLE IF NOT EXISTS now_playing (
      station_id UUID PRIMARY KEY REFERENCES audio_stations(id) ON DELETE CASCADE,
      track_id UUID REFERENCES audio_tracks(id) ON DELETE SET NULL,
      dj_id UUID REFERENCES station_djs(id) ON DELETE SET NULL,
      started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      is_live BOOLEAN DEFAULT false,
      live_title VARCHAR(255),
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- Create indexes
    CREATE INDEX IF NOT EXISTS idx_audio_tracks_artist ON audio_tracks(artist);
    CREATE INDEX IF NOT EXISTS idx_audio_tracks_genre ON audio_tracks(genre);
    CREATE INDEX IF NOT EXISTS idx_station_schedule_station ON station_schedule(station_id);
    CREATE INDEX IF NOT EXISTS idx_audio_analytics_station ON audio_analytics(station_id);
    CREATE INDEX IF NOT EXISTS idx_station_djs_stream_key ON station_djs(stream_key);
    CREATE INDEX IF NOT EXISTS idx_station_mount_points_mount ON station_mount_points(mount_point);
  `);

  console.log('✅ Audio database tables initialized');
}

// ==================== STATIONS API ====================

// Get all stations - admins see all, users see their assigned stations
app.get('/api/audio/stations', authMiddleware, checkAudioAccess, async (req: AuthRequest, res) => {
  try {
    const isAdmin = req.user!.role === 'admin';

    let result;
    if (isAdmin) {
      result = await pool.query(
        `SELECT s.*,
                u.name as owner_name,
                u.email as owner_email,
                (SELECT COUNT(*) FROM station_djs d WHERE d.station_id = s.id AND d.is_active = true) as dj_count,
                (SELECT COUNT(*) FROM station_playlists p WHERE p.station_id = s.id) as playlist_count
         FROM audio_stations s
         LEFT JOIN users u ON s.created_by = u.id
         ORDER BY s.created_at DESC`
      );
    } else {
      result = await pool.query(
        `SELECT s.*,
                (SELECT COUNT(*) FROM station_djs d WHERE d.station_id = s.id AND d.is_active = true) as dj_count,
                (SELECT COUNT(*) FROM station_playlists p WHERE p.station_id = s.id) as playlist_count
         FROM audio_stations s
         WHERE s.created_by = $1
         ORDER BY s.created_at DESC`,
        [req.user!.id]
      );
    }

    const stations = result.rows.map(station => ({
      ...station,
      listeners: listenerCounts.get(station.id) || 0,
      is_streaming: autoDJProcesses.has(station.id) || [...liveDJConnections.values()].some(c => c.stationId === station.id)
    }));

    res.json(stations);
  } catch (error) {
    console.error('Error fetching stations:', error);
    res.status(500).json({ error: 'Failed to fetch stations' });
  }
});

// Create station - admins can create for any user, users create for themselves
app.post('/api/audio/stations', authMiddleware, checkAudioAccess, async (req: AuthRequest, res) => {
  try {
    const { name, description, genre, bitrate = 128, auto_dj_enabled = true, assigned_user_id } = req.body;
    const mountPoint = name.toLowerCase().replace(/[^a-z0-9]/g, '-').substring(0, 50);

    // Determine the owner: admins can assign to any user, others create for themselves
    let ownerId = req.user!.id;
    if (req.user!.role === 'admin' && assigned_user_id) {
      ownerId = assigned_user_id;
    }

    // Generate unique source password for this station
    const sourcePassword = 'cmc_' + crypto.randomBytes(6).toString('hex');

    // Get next available port for this station
    const streamPort = await getNextAvailablePort();

    // Create station with unique port
    const result = await pool.query(
      `INSERT INTO audio_stations (name, description, genre, mount_point, stream_port, bitrate, auto_dj_enabled, created_by, source_password)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [name, description, genre, mountPoint, streamPort, bitrate, auto_dj_enabled, ownerId, sourcePassword]
    );

    const station = result.rows[0];

    // Create primary mount point
    await pool.query(
      `INSERT INTO station_mount_points (station_id, mount_point, bitrate, is_primary)
       VALUES ($1, $2, $3, true)`,
      [station.id, mountPoint, bitrate]
    );

    // Create default playlist
    await pool.query(
      `INSERT INTO station_playlists (station_id, name, description, is_default)
       VALUES ($1, 'Default Playlist', 'Auto DJ default playlist', true)`,
      [station.id]
    );

    console.log(`[Station] Created "${name}" on port ${streamPort} with password ${sourcePassword}`);

    // Start Icecast container for this station
    await startIcecastForStation({
      id: station.id,
      name: station.name,
      stream_port: streamPort,
      source_password: sourcePassword,
      mount_point: mountPoint
    });

    res.json(station);
  } catch (error) {
    console.error('Error creating station:', error);
    res.status(500).json({ error: 'Failed to create station' });
  }
});

// Get station by ID - checks ownership
app.get('/api/audio/stations/:id', authMiddleware, checkAudioAccess, async (req: AuthRequest, res) => {
  try {
    const station = await checkStationAccess(req.params.id, req.user!.id, req.user!.role);

    if (!station) {
      return res.status(404).json({ error: 'Station not found' });
    }

    const result = await pool.query(
      `SELECT s.*,
              np.track_id as now_playing_track_id,
              np.is_live as now_playing_is_live,
              np.live_title,
              np.dj_id as current_dj_id,
              t.title as now_playing_title,
              t.artist as now_playing_artist,
              d.dj_name as current_dj_name
       FROM audio_stations s
       LEFT JOIN now_playing np ON s.id = np.station_id
       LEFT JOIN audio_tracks t ON np.track_id = t.id
       LEFT JOIN station_djs d ON np.dj_id = d.id
       WHERE s.id = $1`,
      [req.params.id]
    );

    const stationData = {
      ...result.rows[0],
      listeners: listenerCounts.get(result.rows[0].id) || 0,
      is_streaming: autoDJProcesses.has(result.rows[0].id) || [...liveDJConnections.values()].some(c => c.stationId === result.rows[0].id)
    };

    res.json(stationData);
  } catch (error) {
    console.error('Error fetching station:', error);
    res.status(500).json({ error: 'Failed to fetch station' });
  }
});

// Update station - checks ownership
app.put('/api/audio/stations/:id', authMiddleware, checkAudioAccess, async (req: AuthRequest, res) => {
  try {
    const station = await checkStationAccess(req.params.id, req.user!.id, req.user!.role);

    if (!station) {
      return res.status(404).json({ error: 'Station not found' });
    }

    const { name, description, genre, bitrate, is_active, auto_dj_enabled, auto_dj_playlist_id, crossfade_duration } = req.body;

    const result = await pool.query(
      `UPDATE audio_stations
       SET name = COALESCE($1, name),
           description = COALESCE($2, description),
           genre = COALESCE($3, genre),
           bitrate = COALESCE($4, bitrate),
           is_active = COALESCE($5, is_active),
           auto_dj_enabled = COALESCE($6, auto_dj_enabled),
           auto_dj_playlist_id = COALESCE($7, auto_dj_playlist_id),
           crossfade_duration = COALESCE($8, crossfade_duration),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $9
       RETURNING *`,
      [name, description, genre, bitrate, is_active, auto_dj_enabled, auto_dj_playlist_id, crossfade_duration, req.params.id]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating station:', error);
    res.status(500).json({ error: 'Failed to update station' });
  }
});

// Delete station - admins only
app.delete('/api/audio/stations/:id', authMiddleware, checkAudioAccess, async (req: AuthRequest, res) => {
  try {
    if (req.user!.role !== 'admin') {
      return res.status(403).json({ error: 'Only admins can delete stations' });
    }

    // Get mount point before deleting
    const stationResult = await pool.query("SELECT mount_point FROM audio_stations WHERE id = $1", [req.params.id]);
    const mountPoint = stationResult.rows[0]?.mount_point;

    // Stop Auto DJ
    stopAutoDJ(req.params.id);

    // Stop and remove Icecast container for this station
    await stopIcecastForStation(req.params.id);

    await pool.query('DELETE FROM audio_stations WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting station:', error);
    res.status(500).json({ error: 'Failed to delete station' });
  }
});

// ==================== MOUNT POINTS API ====================

// Get station mount points - checks ownership
app.get('/api/audio/stations/:stationId/mount-points', authMiddleware, checkAudioAccess, async (req: AuthRequest, res) => {
  try {
    const station = await checkStationAccess(req.params.stationId, req.user!.id, req.user!.role);
    if (!station) {
      return res.status(404).json({ error: 'Station not found' });
    }

    const result = await pool.query(
      `SELECT * FROM station_mount_points WHERE station_id = $1 ORDER BY is_primary DESC, bitrate DESC`,
      [req.params.stationId]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching mount points:', error);
    res.status(500).json({ error: 'Failed to fetch mount points' });
  }
});

// Create mount point - checks ownership
app.post('/api/audio/stations/:stationId/mount-points', authMiddleware, checkAudioAccess, async (req: AuthRequest, res) => {
  try {
    const station = await checkStationAccess(req.params.stationId, req.user!.id, req.user!.role);
    if (!station) {
      return res.status(404).json({ error: 'Station not found' });
    }

    const { mount_point, bitrate, format = 'mp3' } = req.body;

    const result = await pool.query(
      `INSERT INTO station_mount_points (station_id, mount_point, bitrate, format)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [req.params.stationId, mount_point, bitrate, format]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error creating mount point:', error);
    res.status(500).json({ error: 'Failed to create mount point' });
  }
});

// Delete mount point - checks ownership via station
app.delete('/api/audio/mount-points/:id', authMiddleware, checkAudioAccess, async (req: AuthRequest, res) => {
  try {
    // Get mount point and check station ownership
    const mpResult = await pool.query('SELECT station_id FROM station_mount_points WHERE id = $1', [req.params.id]);
    if (mpResult.rows.length === 0) {
      return res.status(404).json({ error: 'Mount point not found' });
    }

    const station = await checkStationAccess(mpResult.rows[0].station_id, req.user!.id, req.user!.role);
    if (!station) {
      return res.status(403).json({ error: 'Access denied' });
    }

    await pool.query('DELETE FROM station_mount_points WHERE id = $1 AND is_primary = false', [req.params.id]);
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting mount point:', error);
    res.status(500).json({ error: 'Failed to delete mount point' });
  }
});

// ==================== DJ MANAGEMENT API ====================

// Get station DJs - checks ownership
app.get('/api/audio/stations/:stationId/djs', authMiddleware, checkAudioAccess, async (req: AuthRequest, res) => {
  try {
    const station = await checkStationAccess(req.params.stationId, req.user!.id, req.user!.role);
    if (!station) {
      return res.status(404).json({ error: 'Station not found' });
    }

    const result = await pool.query(
      `SELECT id, station_id, user_id, dj_name, stream_key, can_stream, can_manage_playlist,
              is_active, last_connected, total_airtime, created_at
       FROM station_djs
       WHERE station_id = $1
       ORDER BY created_at DESC`,
      [req.params.stationId]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching DJs:', error);
    res.status(500).json({ error: 'Failed to fetch DJs' });
  }
});

// Create DJ account - checks ownership
app.post('/api/audio/stations/:stationId/djs', authMiddleware, checkAudioAccess, async (req: AuthRequest, res) => {
  try {
    const station = await checkStationAccess(req.params.stationId, req.user!.id, req.user!.role);
    if (!station) {
      return res.status(404).json({ error: 'Station not found' });
    }

    const { dj_name, user_id, can_stream = true, can_manage_playlist = false } = req.body;
    const streamKey = generateStreamKey();
    const streamPassword = generatePassword();

    const result = await pool.query(
      `INSERT INTO station_djs (station_id, user_id, dj_name, stream_key, stream_password, can_stream, can_manage_playlist)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [req.params.stationId, user_id, dj_name, streamKey, streamPassword, can_stream, can_manage_playlist]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error creating DJ:', error);
    res.status(500).json({ error: 'Failed to create DJ' });
  }
});

// Helper to check DJ access via station ownership
async function checkDJAccess(djId: string, userId: string, userRole: string): Promise<any> {
  const djResult = await pool.query('SELECT station_id FROM station_djs WHERE id = $1', [djId]);
  if (djResult.rows.length === 0) return null;
  return checkStationAccess(djResult.rows[0].station_id, userId, userRole);
}

// Get DJ credentials - checks ownership
app.get('/api/audio/djs/:djId/credentials', authMiddleware, checkAudioAccess, async (req: AuthRequest, res) => {
  try {
    const station = await checkDJAccess(req.params.djId, req.user!.id, req.user!.role);
    if (!station) {
      return res.status(404).json({ error: 'DJ not found or access denied' });
    }

    const result = await pool.query(
      `SELECT d.*, s.mount_point, s.name as station_name, s.source_password, s.stream_port
       FROM station_djs d
       JOIN audio_stations s ON d.station_id = s.id
       WHERE d.id = $1`,
      [req.params.djId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'DJ not found' });
    }

    const dj = result.rows[0];
    // Use the station-specific password
    const stationPassword = dj.source_password || ICECAST_SOURCE_PASSWORD;
    // Use station-specific port (each station gets unique port)
    const stationPort = dj.stream_port || 8000;

    // Return streaming credentials
    res.json({
      dj_name: dj.dj_name,
      station_name: dj.station_name,
      server: PUBLIC_DOMAIN,
      port: stationPort,
      mount_point: `/live`,
      username: 'source',
      password: stationPassword,
      stream_key: dj.stream_key,
      // Connection URLs for popular software
      connection_urls: {
        butt: `icecast://source:${stationPassword}@${PUBLIC_DOMAIN}:${stationPort}/live`,
        mixxx: `icecast://source:${stationPassword}@${PUBLIC_DOMAIN}:${stationPort}/live`,
        obs: `icecast://source:${stationPassword}@${PUBLIC_DOMAIN}:${stationPort}/live`
      }
    });
  } catch (error) {
    console.error('Error fetching DJ credentials:', error);
    res.status(500).json({ error: 'Failed to fetch credentials' });
  }
});

// Regenerate DJ credentials - checks ownership
app.post('/api/audio/djs/:djId/regenerate-credentials', authMiddleware, checkAudioAccess, async (req: AuthRequest, res) => {
  try {
    const station = await checkDJAccess(req.params.djId, req.user!.id, req.user!.role);
    if (!station) {
      return res.status(404).json({ error: 'DJ not found or access denied' });
    }

    const newStreamKey = generateStreamKey();
    const newPassword = generatePassword();

    const result = await pool.query(
      `UPDATE station_djs
       SET stream_key = $1, stream_password = $2
       WHERE id = $3
       RETURNING *`,
      [newStreamKey, newPassword, req.params.djId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'DJ not found' });
    }

    res.json({
      message: 'Credentials regenerated',
      stream_key: newStreamKey,
      stream_password: newPassword
    });
  } catch (error) {
    console.error('Error regenerating credentials:', error);
    res.status(500).json({ error: 'Failed to regenerate credentials' });
  }
});

// Update DJ - checks ownership
app.put('/api/audio/djs/:djId', authMiddleware, checkAudioAccess, async (req: AuthRequest, res) => {
  try {
    const station = await checkDJAccess(req.params.djId, req.user!.id, req.user!.role);
    if (!station) {
      return res.status(404).json({ error: 'DJ not found or access denied' });
    }

    const { dj_name, can_stream, can_manage_playlist, is_active } = req.body;

    const result = await pool.query(
      `UPDATE station_djs
       SET dj_name = COALESCE($1, dj_name),
           can_stream = COALESCE($2, can_stream),
           can_manage_playlist = COALESCE($3, can_manage_playlist),
           is_active = COALESCE($4, is_active)
       WHERE id = $5
       RETURNING *`,
      [dj_name, can_stream, can_manage_playlist, is_active, req.params.djId]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating DJ:', error);
    res.status(500).json({ error: 'Failed to update DJ' });
  }
});

// Delete DJ - checks ownership
app.delete('/api/audio/djs/:djId', authMiddleware, checkAudioAccess, async (req: AuthRequest, res) => {
  try {
    const station = await checkDJAccess(req.params.djId, req.user!.id, req.user!.role);
    if (!station) {
      return res.status(404).json({ error: 'DJ not found or access denied' });
    }

    await pool.query('DELETE FROM station_djs WHERE id = $1', [req.params.djId]);
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting DJ:', error);
    res.status(500).json({ error: 'Failed to delete DJ' });
  }
});

// ==================== AUDIO LIBRARY API ====================

// Get all tracks - auth required, shared library
app.get('/api/audio/tracks', authMiddleware, checkAudioAccess, async (req: AuthRequest, res) => {
  try {
    const { search, genre, artist, limit = 50, offset = 0 } = req.query;

    let queryStr = 'SELECT * FROM audio_tracks WHERE 1=1';
    const params: any[] = [];
    let paramIndex = 1;

    if (search) {
      queryStr += ` AND (title ILIKE $${paramIndex} OR artist ILIKE $${paramIndex} OR album ILIKE $${paramIndex})`;
      params.push(`%${search}%`);
      paramIndex++;
    }

    if (genre) {
      queryStr += ` AND genre = $${paramIndex}`;
      params.push(genre);
      paramIndex++;
    }

    if (artist) {
      queryStr += ` AND artist = $${paramIndex}`;
      params.push(artist);
      paramIndex++;
    }

    queryStr += ` ORDER BY created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(limit, offset);

    const result = await pool.query(queryStr, params);
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching tracks:', error);
    res.status(500).json({ error: 'Failed to fetch tracks' });
  }
});

// Upload audio track - auth required
app.post('/api/audio/tracks/upload', authMiddleware, checkAudioAccess, upload.single('audio'), async (req: AuthRequest, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No audio file provided' });
    }

    // Try to parse metadata, but don't fail if it errors
    let title = path.basename(req.file.originalname, path.extname(req.file.originalname));
    let artist = 'Unknown Artist';
    let album = 'Unknown Album';
    let genre: string | null = null;
    let duration = 0;
    let bitrate: number | null = null;
    let sampleRate: number | null = null;

    try {
      const metadata = await mm.parseFile(req.file.path);
      title = metadata.common.title || title;
      artist = metadata.common.artist || artist;
      album = metadata.common.album || album;
      genre = metadata.common.genre?.[0] || null;
      duration = Math.round(metadata.format.duration || 0);
      bitrate = metadata.format.bitrate ? Math.round(metadata.format.bitrate / 1000) : null;
      sampleRate = metadata.format.sampleRate || null;
    } catch (metadataError) {
      console.log('[Upload] Could not parse metadata, using defaults:', metadataError);
    }

    const result = await pool.query(
      `INSERT INTO audio_tracks (title, artist, album, genre, duration, file_path, file_size, bitrate, sample_rate)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [title, artist, album, genre, duration, req.file.path, req.file.size, bitrate, sampleRate]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error uploading track:', error);
    res.status(500).json({ error: 'Failed to upload track' });
  }
});

// Delete track - admins only
app.delete('/api/audio/tracks/:id', authMiddleware, checkAudioAccess, async (req: AuthRequest, res) => {
  try {
    if (req.user!.role !== 'admin') {
      return res.status(403).json({ error: 'Only admins can delete tracks' });
    }

    const result = await pool.query(
      'SELECT file_path FROM audio_tracks WHERE id = $1',
      [req.params.id]
    );

    if (result.rows.length > 0) {
      const filePath = result.rows[0].file_path;
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }

    await pool.query('DELETE FROM audio_tracks WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting track:', error);
    res.status(500).json({ error: 'Failed to delete track' });
  }
});

// Stream audio file (for preview) - auth required
app.get('/api/audio/stream/:trackId', authMiddleware, checkAudioAccess, async (req: AuthRequest, res) => {
  try {
    const result = await pool.query(
      'SELECT file_path FROM audio_tracks WHERE id = $1',
      [req.params.trackId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Track not found' });
    }

    const filePath = result.rows[0].file_path;
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Audio file not found' });
    }

    res.sendFile(filePath);
  } catch (error) {
    console.error('Error streaming track:', error);
    res.status(500).json({ error: 'Failed to stream track' });
  }
});

// ==================== PLAYLIST API ====================

// Helper to check playlist access via station ownership
async function checkPlaylistAccess(playlistId: string, userId: string, userRole: string): Promise<any> {
  const plResult = await pool.query('SELECT station_id FROM station_playlists WHERE id = $1', [playlistId]);
  if (plResult.rows.length === 0) return null;
  return checkStationAccess(plResult.rows[0].station_id, userId, userRole);
}

// Get station playlists - checks ownership
app.get('/api/audio/stations/:stationId/playlists', authMiddleware, checkAudioAccess, async (req: AuthRequest, res) => {
  try {
    const station = await checkStationAccess(req.params.stationId, req.user!.id, req.user!.role);
    if (!station) {
      return res.status(404).json({ error: 'Station not found' });
    }

    const result = await pool.query(
      `SELECT p.*,
              (SELECT COUNT(*) FROM playlist_tracks pt WHERE pt.playlist_id = p.id) as track_count,
              (SELECT SUM(t.duration) FROM playlist_tracks pt JOIN audio_tracks t ON pt.track_id = t.id WHERE pt.playlist_id = p.id) as total_duration
       FROM station_playlists p
       WHERE p.station_id = $1
       ORDER BY p.is_default DESC, p.created_at DESC`,
      [req.params.stationId]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching playlists:', error);
    res.status(500).json({ error: 'Failed to fetch playlists' });
  }
});

// Create playlist - checks ownership
app.post('/api/audio/stations/:stationId/playlists', authMiddleware, checkAudioAccess, async (req: AuthRequest, res) => {
  try {
    const station = await checkStationAccess(req.params.stationId, req.user!.id, req.user!.role);
    if (!station) {
      return res.status(404).json({ error: 'Station not found' });
    }

    const { name, description, is_default, shuffle_enabled, repeat_mode } = req.body;

    if (is_default) {
      await pool.query(
        'UPDATE station_playlists SET is_default = false WHERE station_id = $1',
        [req.params.stationId]
      );
    }

    const result = await pool.query(
      `INSERT INTO station_playlists (station_id, name, description, is_default, shuffle_enabled, repeat_mode)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [req.params.stationId, name, description, is_default || false, shuffle_enabled || false, repeat_mode || 'all']
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error creating playlist:', error);
    res.status(500).json({ error: 'Failed to create playlist' });
  }
});

// Get playlist tracks - checks ownership
app.get('/api/audio/playlists/:playlistId/tracks', authMiddleware, checkAudioAccess, async (req: AuthRequest, res) => {
  try {
    const station = await checkPlaylistAccess(req.params.playlistId, req.user!.id, req.user!.role);
    if (!station) {
      return res.status(404).json({ error: 'Playlist not found or access denied' });
    }

    const result = await pool.query(
      `SELECT t.*, pt.position, pt.id as playlist_track_id
       FROM playlist_tracks pt
       JOIN audio_tracks t ON pt.track_id = t.id
       WHERE pt.playlist_id = $1
       ORDER BY pt.position`,
      [req.params.playlistId]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching playlist tracks:', error);
    res.status(500).json({ error: 'Failed to fetch playlist tracks' });
  }
});

// Add track to playlist - checks ownership
app.post('/api/audio/playlists/:playlistId/tracks', authMiddleware, checkAudioAccess, async (req: AuthRequest, res) => {
  try {
    const station = await checkPlaylistAccess(req.params.playlistId, req.user!.id, req.user!.role);
    if (!station) {
      return res.status(404).json({ error: 'Playlist not found or access denied' });
    }

    const { track_id } = req.body;

    const posResult = await pool.query(
      'SELECT COALESCE(MAX(position), 0) + 1 as next_pos FROM playlist_tracks WHERE playlist_id = $1',
      [req.params.playlistId]
    );

    const result = await pool.query(
      `INSERT INTO playlist_tracks (playlist_id, track_id, position)
       VALUES ($1, $2, $3)
       ON CONFLICT (playlist_id, track_id) DO NOTHING
       RETURNING *`,
      [req.params.playlistId, track_id, posResult.rows[0].next_pos]
    );

    res.json(result.rows[0] || { message: 'Track already in playlist' });
  } catch (error) {
    console.error('Error adding track to playlist:', error);
    res.status(500).json({ error: 'Failed to add track to playlist' });
  }
});

// Remove track from playlist - checks ownership
app.delete('/api/audio/playlists/:playlistId/tracks/:trackId', authMiddleware, checkAudioAccess, async (req: AuthRequest, res) => {
  try {
    const station = await checkPlaylistAccess(req.params.playlistId, req.user!.id, req.user!.role);
    if (!station) {
      return res.status(404).json({ error: 'Playlist not found or access denied' });
    }

    await pool.query(
      'DELETE FROM playlist_tracks WHERE playlist_id = $1 AND track_id = $2',
      [req.params.playlistId, req.params.trackId]
    );
    res.json({ success: true });
  } catch (error) {
    console.error('Error removing track from playlist:', error);
    res.status(500).json({ error: 'Failed to remove track' });
  }
});

// Delete playlist - checks ownership
app.delete('/api/audio/playlists/:playlistId', authMiddleware, checkAudioAccess, async (req: AuthRequest, res) => {
  try {
    const station = await checkPlaylistAccess(req.params.playlistId, req.user!.id, req.user!.role);
    if (!station) {
      return res.status(404).json({ error: 'Playlist not found or access denied' });
    }

    // Check if this is the default playlist
    const playlistResult = await pool.query(
      'SELECT is_default FROM station_playlists WHERE id = $1',
      [req.params.playlistId]
    );

    if (playlistResult.rows.length > 0 && playlistResult.rows[0].is_default) {
      return res.status(400).json({ error: 'Cannot delete the default playlist' });
    }

    // Delete the playlist (cascade will delete playlist_tracks)
    await pool.query('DELETE FROM station_playlists WHERE id = $1', [req.params.playlistId]);

    res.json({ success: true, message: 'Playlist deleted' });
  } catch (error) {
    console.error('Error deleting playlist:', error);
    res.status(500).json({ error: 'Failed to delete playlist' });
  }
});

// Reorder playlist tracks - checks ownership
app.put('/api/audio/playlists/:playlistId/reorder', authMiddleware, checkAudioAccess, async (req: AuthRequest, res) => {
  try {
    const station = await checkPlaylistAccess(req.params.playlistId, req.user!.id, req.user!.role);
    if (!station) {
      return res.status(404).json({ error: 'Playlist not found or access denied' });
    }

    const { track_ids } = req.body; // Array of track IDs in new order

    for (let i = 0; i < track_ids.length; i++) {
      await pool.query(
        'UPDATE playlist_tracks SET position = $1 WHERE playlist_id = $2 AND track_id = $3',
        [i + 1, req.params.playlistId, track_ids[i]]
      );
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error reordering playlist:', error);
    res.status(500).json({ error: 'Failed to reorder playlist' });
  }
});

// ==================== SCHEDULE API ====================

// Helper to check schedule access via station ownership
async function checkScheduleAccess(scheduleId: string, userId: string, userRole: string): Promise<any> {
  const schResult = await pool.query('SELECT station_id FROM station_schedule WHERE id = $1', [scheduleId]);
  if (schResult.rows.length === 0) return null;
  return checkStationAccess(schResult.rows[0].station_id, userId, userRole);
}

// Get station schedule - checks ownership
app.get('/api/audio/stations/:stationId/schedule', authMiddleware, checkAudioAccess, async (req: AuthRequest, res) => {
  try {
    const station = await checkStationAccess(req.params.stationId, req.user!.id, req.user!.role);
    if (!station) {
      return res.status(404).json({ error: 'Station not found' });
    }

    const result = await pool.query(
      `SELECT s.*, p.name as playlist_name, d.dj_name
       FROM station_schedule s
       LEFT JOIN station_playlists p ON s.playlist_id = p.id
       LEFT JOIN station_djs d ON s.dj_id = d.id
       WHERE s.station_id = $1
       ORDER BY s.day_of_week, s.start_time`,
      [req.params.stationId]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching schedule:', error);
    res.status(500).json({ error: 'Failed to fetch schedule' });
  }
});

// Create schedule entry - checks ownership
app.post('/api/audio/stations/:stationId/schedule', authMiddleware, checkAudioAccess, async (req: AuthRequest, res) => {
  try {
    const station = await checkStationAccess(req.params.stationId, req.user!.id, req.user!.role);
    if (!station) {
      return res.status(404).json({ error: 'Station not found' });
    }

    const { dj_id, playlist_id, day_of_week, start_time, end_time, show_name, description, is_live, auto_start } = req.body;

    const result = await pool.query(
      `INSERT INTO station_schedule (station_id, dj_id, playlist_id, day_of_week, start_time, end_time, show_name, description, is_live, auto_start)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [req.params.stationId, dj_id, playlist_id, day_of_week, start_time, end_time, show_name, description, is_live || false, auto_start !== false]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error creating schedule:', error);
    res.status(500).json({ error: 'Failed to create schedule' });
  }
});

// Update schedule entry - checks ownership
app.put('/api/audio/schedule/:id', authMiddleware, checkAudioAccess, async (req: AuthRequest, res) => {
  try {
    const station = await checkScheduleAccess(req.params.id, req.user!.id, req.user!.role);
    if (!station) {
      return res.status(404).json({ error: 'Schedule not found or access denied' });
    }

    const { dj_id, playlist_id, day_of_week, start_time, end_time, show_name, description, is_live, auto_start } = req.body;

    const result = await pool.query(
      `UPDATE station_schedule
       SET dj_id = $1, playlist_id = $2, day_of_week = $3, start_time = $4, end_time = $5,
           show_name = $6, description = $7, is_live = $8, auto_start = $9
       WHERE id = $10
       RETURNING *`,
      [dj_id, playlist_id, day_of_week, start_time, end_time, show_name, description, is_live, auto_start, req.params.id]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating schedule:', error);
    res.status(500).json({ error: 'Failed to update schedule' });
  }
});

// Delete schedule entry - checks ownership
app.delete('/api/audio/schedule/:id', authMiddleware, checkAudioAccess, async (req: AuthRequest, res) => {
  try {
    const station = await checkScheduleAccess(req.params.id, req.user!.id, req.user!.role);
    if (!station) {
      return res.status(404).json({ error: 'Schedule not found or access denied' });
    }

    await pool.query('DELETE FROM station_schedule WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting schedule:', error);
    res.status(500).json({ error: 'Failed to delete schedule' });
  }
});

// ==================== AUTO DJ CONTROL ====================

// Start Auto DJ for a station
async function startAutoDJ(stationId: string) {
  // Check if already running
  if (autoDJProcesses.has(stationId)) {
    console.log(`[Auto DJ] Station ${stationId} already running`);
    return;
  }

  // Get station info
  const stationResult = await pool.query(
    'SELECT * FROM audio_stations WHERE id = $1',
    [stationId]
  );

  if (stationResult.rows.length === 0) {
    console.error(`[Auto DJ] Station ${stationId} not found`);
    return;
  }

  const station = stationResult.rows[0];

  if (!station.auto_dj_enabled) {
    console.log(`[Auto DJ] Auto DJ disabled for station ${station.name}`);
    return;
  }

  // Get playlist tracks
  const playlistId = station.auto_dj_playlist_id;
  let tracksQuery = `
    SELECT t.file_path, t.id, t.title, t.artist
    FROM playlist_tracks pt
    JOIN audio_tracks t ON pt.track_id = t.id
    JOIN station_playlists p ON pt.playlist_id = p.id
    WHERE p.station_id = $1
  `;

  if (playlistId) {
    tracksQuery += ' AND p.id = $2';
  } else {
    tracksQuery += ' AND p.is_default = true';
  }

  tracksQuery += ' ORDER BY pt.position';

  const tracksResult = playlistId
    ? await pool.query(tracksQuery, [stationId, playlistId])
    : await pool.query(tracksQuery, [stationId]);

  if (tracksResult.rows.length === 0) {
    console.log(`[Auto DJ] No tracks found for station ${station.name}`);
    return;
  }

  // Create playlist file for FFmpeg
  const playlistPath = `/storage/audio/playlists/${stationId}.txt`;
  const playlistContent = tracksResult.rows.map(r => `file '${r.file_path}'`).join('\n');

  // Ensure directory exists
  const playlistDir = path.dirname(playlistPath);
  if (!fs.existsSync(playlistDir)) {
    fs.mkdirSync(playlistDir, { recursive: true });
  }

  fs.writeFileSync(playlistPath, playlistContent);

  console.log(`[Auto DJ] Starting for station ${station.name} with ${tracksResult.rows.length} tracks`);

  // Start FFmpeg stream to Icecast
  const ffmpegArgs = [
    '-re',
    '-f', 'concat',
    '-safe', '0',
    '-stream_loop', '-1',
    '-i', playlistPath,
    '-acodec', 'libmp3lame',
    '-ab', `${station.bitrate}k`,
    '-ar', '44100',
    '-ac', '2',
    '-content_type', 'audio/mpeg',
    '-f', 'mp3',
    `icecast://source:${ICECAST_SOURCE_PASSWORD}@${ICECAST_HOST}:${ICECAST_PORT}/${station.mount_point}`
  ];

  const ffmpegProcess = spawn('ffmpeg', ffmpegArgs);

  ffmpegProcess.stderr.on('data', (data) => {
    const output = data.toString();
    // Log only important messages
    if (output.includes('Opening') || output.includes('Error') || output.includes('error')) {
      console.log(`[Auto DJ ${station.name}] ${output.trim()}`);
    }
  });

  ffmpegProcess.on('exit', (code) => {
    console.log(`[Auto DJ ${station.name}] Process exited with code ${code}`);
    autoDJProcesses.delete(stationId);

    // Update now playing
    pool.query(
      'DELETE FROM now_playing WHERE station_id = $1',
      [stationId]
    ).catch(console.error);

    // Log stream history
    pool.query(
      `INSERT INTO stream_history (station_id, started_at, ended_at, stream_type)
       VALUES ($1, NOW() - INTERVAL '1 hour', NOW(), 'auto_dj')`,
      [stationId]
    ).catch(console.error);

    // Restart if auto DJ is still enabled
    setTimeout(async () => {
      const checkResult = await pool.query(
        'SELECT auto_dj_enabled FROM audio_stations WHERE id = $1',
        [stationId]
      );
      if (checkResult.rows.length > 0 && checkResult.rows[0].auto_dj_enabled) {
        console.log(`[Auto DJ] Restarting for station ${station.name}`);
        startAutoDJ(stationId);
      }
    }, 5000);
  });

  autoDJProcesses.set(stationId, ffmpegProcess);

  // Update now playing
  if (tracksResult.rows.length > 0) {
    const firstTrack = tracksResult.rows[0];
    await pool.query(
      `INSERT INTO now_playing (station_id, track_id, is_live, updated_at)
       VALUES ($1, $2, false, NOW())
       ON CONFLICT (station_id) DO UPDATE SET track_id = $2, is_live = false, updated_at = NOW()`,
      [stationId, firstTrack.id]
    );
  }
}

// Stop Auto DJ for a station
function stopAutoDJ(stationId: string) {
  const process = autoDJProcesses.get(stationId);
  if (process) {
    console.log(`[Auto DJ] Stopping for station ${stationId}`);
    process.kill('SIGTERM');
    autoDJProcesses.delete(stationId);
  }
}

// API endpoints for Auto DJ control - checks ownership
app.post('/api/audio/stations/:id/start', authMiddleware, checkAudioAccess, async (req: AuthRequest, res) => {
  try {
    const station = await checkStationAccess(req.params.id, req.user!.id, req.user!.role);
    if (!station) {
      return res.status(404).json({ error: 'Station not found' });
    }

    await startAutoDJ(req.params.id);
    res.json({ message: 'Auto DJ started' });
  } catch (error) {
    console.error('Error starting Auto DJ:', error);
    res.status(500).json({ error: 'Failed to start Auto DJ' });
  }
});

app.post('/api/audio/stations/:id/stop', authMiddleware, checkAudioAccess, async (req: AuthRequest, res) => {
  try {
    const station = await checkStationAccess(req.params.id, req.user!.id, req.user!.role);
    if (!station) {
      return res.status(404).json({ error: 'Station not found' });
    }

    // Stop Auto DJ process
    stopAutoDJ(req.params.id);

    // Also kill the Icecast mount to stop any active stream
    const stationResult = await pool.query(
      'SELECT mount_point FROM audio_stations WHERE id = $1',
      [req.params.id]
    );

    if (stationResult.rows.length > 0 && stationResult.rows[0].mount_point) {
      await killIcecastMount(stationResult.rows[0].mount_point);
    }

    // Clear any live DJ connections for this station
    for (const [mount, connection] of liveDJConnections.entries()) {
      if (connection.stationId === req.params.id) {
        liveDJConnections.delete(mount);
      }
    }

    // Clear now playing
    await pool.query('DELETE FROM now_playing WHERE station_id = $1', [req.params.id]);

    res.json({ message: 'Station stopped', success: true });
  } catch (error) {
    console.error('Error stopping station:', error);
    res.status(500).json({ error: 'Failed to stop station' });
  }
});

// Get Auto DJ status - checks ownership
app.get('/api/audio/stations/:id/status', authMiddleware, checkAudioAccess, async (req: AuthRequest, res) => {
  try {
    const station = await checkStationAccess(req.params.id, req.user!.id, req.user!.role);
    if (!station) {
      return res.status(404).json({ error: 'Station not found' });
    }

    const isRunning = autoDJProcesses.has(req.params.id);
    const hasLiveDJ = [...liveDJConnections.values()].some(c => c.stationId === req.params.id);

    const nowPlayingResult = await pool.query(
      `SELECT np.*, t.title, t.artist, t.cover_image, d.dj_name
       FROM now_playing np
       LEFT JOIN audio_tracks t ON np.track_id = t.id
       LEFT JOIN station_djs d ON np.dj_id = d.id
       WHERE np.station_id = $1`,
      [req.params.id]
    );

    res.json({
      auto_dj_running: isRunning,
      live_dj_connected: hasLiveDJ,
      listeners: listenerCounts.get(req.params.id) || 0,
      now_playing: nowPlayingResult.rows[0] || null
    });
  } catch (error) {
    console.error('Error getting status:', error);
    res.status(500).json({ error: 'Failed to get status' });
  }
});

// ==================== LIVE DJ CONNECTION HANDLING ====================

// Validate DJ credentials (called by Icecast auth)
app.post('/api/audio/auth/dj', async (req, res) => {
  try {
    const { mount, user, pass } = req.body;

    // Check if this is a DJ connection
    const result = await pool.query(
      `SELECT d.*, s.id as station_id, s.auto_dj_enabled
       FROM station_djs d
       JOIN audio_stations s ON d.station_id = s.id
       WHERE s.mount_point = $1 AND d.stream_password = $2 AND d.is_active = true AND d.can_stream = true`,
      [mount.replace('/', ''), pass]
    );

    if (result.rows.length === 0) {
      // Check if it's the source password for Auto DJ
      if (pass === ICECAST_SOURCE_PASSWORD) {
        return res.status(200).send('OK');
      }
      return res.status(401).send('Unauthorized');
    }

    const dj = result.rows[0];

    // Stop Auto DJ when live DJ connects
    if (dj.auto_dj_enabled) {
      stopAutoDJ(dj.station_id);
    }

    // Track live connection
    liveDJConnections.set(mount, { stationId: dj.station_id, djId: dj.id });

    // Update DJ last connected
    await pool.query(
      'UPDATE station_djs SET last_connected = NOW() WHERE id = $1',
      [dj.id]
    );

    // Update now playing
    await pool.query(
      `INSERT INTO now_playing (station_id, dj_id, is_live, updated_at)
       VALUES ($1, $2, true, NOW())
       ON CONFLICT (station_id) DO UPDATE SET dj_id = $2, is_live = true, track_id = NULL, updated_at = NOW()`,
      [dj.station_id, dj.id]
    );

    res.status(200).send('OK');
  } catch (error) {
    console.error('Error authenticating DJ:', error);
    res.status(500).send('Error');
  }
});

// Handle DJ disconnect (called by Icecast)
app.post('/api/audio/auth/dj-disconnect', async (req, res) => {
  try {
    const { mount } = req.body;

    const connection = liveDJConnections.get(mount);
    if (connection) {
      liveDJConnections.delete(mount);

      // Clear now playing
      await pool.query(
        'DELETE FROM now_playing WHERE station_id = $1',
        [connection.stationId]
      );

      // Check if Auto DJ should restart
      const stationResult = await pool.query(
        'SELECT auto_dj_enabled FROM audio_stations WHERE id = $1',
        [connection.stationId]
      );

      if (stationResult.rows.length > 0 && stationResult.rows[0].auto_dj_enabled) {
        console.log(`[Live DJ] Disconnected, restarting Auto DJ for station ${connection.stationId}`);
        setTimeout(() => startAutoDJ(connection.stationId), 2000);
      }
    }

    res.status(200).send('OK');
  } catch (error) {
    console.error('Error handling DJ disconnect:', error);
    res.status(500).send('Error');
  }
});

// ==================== ANALYTICS API ====================

app.get('/api/audio/stations/:stationId/analytics', authMiddleware, checkAudioAccess, async (req: AuthRequest, res) => {
  try {
    const station = await checkStationAccess(req.params.stationId, req.user!.id, req.user!.role);
    if (!station) {
      return res.status(404).json({ error: 'Station not found' });
    }

    const { period = '7d' } = req.query;

    let interval = '7 days';
    if (period === '24h') interval = '24 hours';
    if (period === '30d') interval = '30 days';

    const result = await pool.query(
      `SELECT
        DATE_TRUNC('hour', recorded_at) as time,
        AVG(listener_count) as avg_listeners,
        MAX(peak_listeners) as peak_listeners,
        SUM(total_listen_time) as total_listen_time
       FROM audio_analytics
       WHERE station_id = $1 AND recorded_at > NOW() - INTERVAL '${interval}'
       GROUP BY DATE_TRUNC('hour', recorded_at)
       ORDER BY time`,
      [req.params.stationId]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching analytics:', error);
    res.status(500).json({ error: 'Failed to fetch analytics' });
  }
});

// Get stream URL - public endpoint for embeds
app.get('/api/audio/stations/:id/stream-url', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT mount_point, bitrate FROM audio_stations WHERE id = $1',
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Station not found' });
    }

    const station = result.rows[0];
    res.json({
      stream_url: `/audio/${station.mount_point}`,
      bitrate: station.bitrate
    });
  } catch (error) {
    console.error('Error getting stream URL:', error);
    res.status(500).json({ error: 'Failed to get stream URL' });
  }
});

// Get public station info for embeds (no auth required)
app.get('/api/audio/stations/:id/public', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT s.id, s.name, s.description, s.genre, s.cover_image, s.mount_point, s.bitrate, s.stream_port,
              np.is_live,
              t.title as now_playing_title, t.artist as now_playing_artist,
              d.dj_name as current_dj
       FROM audio_stations s
       LEFT JOIN now_playing np ON s.id = np.station_id
       LEFT JOIN audio_tracks t ON np.track_id = t.id
       LEFT JOIN station_djs d ON np.dj_id = d.id
       WHERE s.id = $1 AND s.is_active = true`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Station not found' });
    }

    const station = result.rows[0];
    res.json({
      ...station,
      stream_url: `/audio/${station.mount_point}`,
      listeners: listenerCounts.get(station.id) || 0
    });
  } catch (error) {
    console.error('Error getting public station info:', error);
    res.status(500).json({ error: 'Failed to get station info' });
  }
});

// ==================== ICECAST SOURCE AUTHENTICATION ====================
// This endpoint validates source connections against station passwords
// Icecast sends: action, server, port, client, mount, user, pass, ip, agent
app.post('/api/audio/icecast-auth', async (req, res) => {
  try {
    // Icecast sends form-urlencoded data
    const { user, pass, mount, action, ip } = req.body;

    console.log('[Icecast Auth] Request:', { action, user, mount, ip, hasPass: !!pass });

    // Mount point comes as /mountpoint, we need to strip the leading slash
    const mountPoint = mount?.replace(/^\//, '') || '';

    // Find the station by mount point
    const stationResult = await pool.query(
      'SELECT id, source_password FROM audio_stations WHERE mount_point = $1',
      [mountPoint]
    );

    if (stationResult.rows.length === 0) {
      console.log('[Icecast Auth] Station not found for mount:', mountPoint);
      // Icecast expects specific response headers
      res.set('icecast-auth-user', '0');
      res.status(200).send('');
      return;
    }

    const station = stationResult.rows[0];

    // Check station-specific password or global password
    if (pass === station.source_password || pass === ICECAST_SOURCE_PASSWORD) {
      console.log('[Icecast Auth] SUCCESS for mount:', mountPoint, 'password matched');
      // Icecast expects icecast-auth-user: 1 header for success
      res.set('icecast-auth-user', '1');
      res.status(200).send('');
      return;
    }

    console.log('[Icecast Auth] FAILED for mount:', mountPoint, 'password:', pass?.substring(0, 4) + '***');
    res.set('icecast-auth-user', '0');
    res.status(200).send('');
  } catch (error) {
    console.error('[Icecast Auth] Error:', error);
    res.set('icecast-auth-user', '0');
    res.status(200).send('');
  }
});

// ==================== MAIN ====================

async function main() {
  // Connect to Redis
  redis = createClient({
    url: process.env.REDIS_URL
  });

  await redis.connect();
  console.log('✅ Connected to Redis');

  // Test database connection
  await pool.query('SELECT NOW()');
  console.log('✅ Connected to PostgreSQL');

  // Initialize database tables
  await initDatabase();

  // Add source_password column if it doesn't exist
  await pool.query(`
    ALTER TABLE audio_stations ADD COLUMN IF NOT EXISTS source_password VARCHAR(64)
  `).catch(() => {});

  // Add stream_port column if it doesn't exist
  await pool.query(`
    ALTER TABLE audio_stations ADD COLUMN IF NOT EXISTS stream_port INTEGER UNIQUE
  `).catch(() => {});

  // Add dj_id column to station_schedule if it doesn't exist
  await pool.query(`
    ALTER TABLE station_schedule ADD COLUMN IF NOT EXISTS dj_id UUID REFERENCES station_djs(id) ON DELETE SET NULL
  `).catch(() => {});

  // Generate passwords for existing stations without one
  await pool.query(`
    UPDATE audio_stations SET source_password = CONCAT('cmc_', LEFT(MD5(RANDOM()::TEXT), 12))
    WHERE source_password IS NULL
  `).catch(() => {});

  // Assign ports to existing stations without one
  const stationsWithoutPort = await pool.query(
    'SELECT id FROM audio_stations WHERE stream_port IS NULL ORDER BY created_at'
  );
  for (const station of stationsWithoutPort.rows) {
    const nextPort = await getNextAvailablePort();
    await pool.query(
      'UPDATE audio_stations SET stream_port = $1 WHERE id = $2',
      [nextPort, station.id]
    );
    console.log(`[Migration] Assigned port ${nextPort} to station ${station.id}`);
  }

  // Start Icecast containers for all active stations
  const allStations = await pool.query(
    'SELECT id, name, stream_port, source_password, mount_point FROM audio_stations WHERE is_active = true AND stream_port IS NOT NULL'
  );
  console.log(`[Startup] Starting Icecast containers for ${allStations.rows.length} station(s)...`);
  for (const station of allStations.rows) {
    await startIcecastForStation(station);
  }

  // Start Auto DJ for all enabled stations
  const stationsResult = await pool.query(
    'SELECT id FROM audio_stations WHERE auto_dj_enabled = true AND is_active = true'
  );

  for (const station of stationsResult.rows) {
    setTimeout(() => startAutoDJ(station.id), 5000);
  }

  // Start server
  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () => {
    console.log(`🎵 Audio Streaming Service running on port ${PORT}`);
  });

  // Handle graceful shutdown
  process.on('SIGTERM', async () => {
    console.log('Shutting down...');

    // Stop all Auto DJ processes
    for (const [stationId] of autoDJProcesses) {
      stopAutoDJ(stationId);
    }

    // Note: We don't stop Icecast containers on shutdown - they persist
    // This allows streams to continue even if audio-streamer restarts

    await redis.quit();
    await pool.end();
    process.exit(0);
  });
}

main().catch(console.error);
