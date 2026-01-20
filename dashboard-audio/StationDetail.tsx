import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  Radio,
  ArrowLeft,
  Play,
  Pause,
  Users,
  Music,
  ListMusic,
  Calendar,
  Settings,
  Plus,
  GripVertical,
  Copy,
  ExternalLink,
  Mic,
  Key,
  RefreshCw,
  Trash2,
  Eye,
  EyeOff,
} from 'lucide-react';
import api from '../services/api';

interface Station {
  id: string;
  name: string;
  description: string;
  genre: string;
  mount_point: string;
  bitrate: number;
  is_active: boolean;
  is_streaming: boolean;
  listeners: number;
  cover_image: string;
  auto_dj_enabled: boolean;
  now_playing_title?: string;
  now_playing_artist?: string;
  now_playing_is_live?: boolean;
  current_dj_name?: string;
}

interface Playlist {
  id: string;
  name: string;
  description: string;
  is_default: boolean;
  track_count: number;
  total_duration: number;
}

interface Track {
  id: string;
  title: string;
  artist: string;
  album?: string;
  genre?: string;
  duration: number;
  position?: number;
  file_path?: string;
  bitrate?: number;
}

interface DJ {
  id: string;
  dj_name: string;
  stream_key: string;
  stream_password?: string;
  can_stream: boolean;
  can_manage_playlist: boolean;
  is_active: boolean;
  last_connected: string | null;
  total_airtime: number;
}

interface DJCredentials {
  dj_name: string;
  station_name: string;
  server: string;
  port: number;
  mount_point: string;
  username: string;
  password: string;
  stream_key: string;
  connection_urls: {
    butt: string;
    mixxx: string;
    obs: string;
  };
}

interface ScheduleEntry {
  id: string;
  dj_id: string | null;
  playlist_id: string;
  playlist_name: string;
  dj_name: string;
  day_of_week: number | null;
  start_time: string;
  end_time: string;
  show_name: string;
  is_live: boolean;
}

interface MountPoint {
  id: string;
  mount_point: string;
  bitrate: number;
  format: string;
  is_primary: boolean;
  is_active: boolean;
}

export default function StationDetail() {
  const { id } = useParams<{ id: string }>();
  const [station, setStation] = useState<Station | null>(null);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [schedule, setSchedule] = useState<ScheduleEntry[]>([]);
  const [djs, setDJs] = useState<DJ[]>([]);
  const [mountPoints, setMountPoints] = useState<MountPoint[]>([]);
  const [selectedPlaylist, setSelectedPlaylist] = useState<string | null>(null);
  const [playlistTracks, setPlaylistTracks] = useState<Track[]>([]);
  const [availableTracks, setAvailableTracks] = useState<Track[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'playlists' | 'djs' | 'schedule' | 'settings'>('playlists');
  const [showCreatePlaylistModal, setShowCreatePlaylistModal] = useState(false);
  const [showAddTrackModal, setShowAddTrackModal] = useState(false);
  const [showScheduleModal, setShowScheduleModal] = useState(false);
  const [showCreateDJModal, setShowCreateDJModal] = useState(false);
  const [showCredentialsModal, setShowCredentialsModal] = useState(false);
  const [showMountPointModal, setShowMountPointModal] = useState(false);
  const [selectedDJCredentials, setSelectedDJCredentials] = useState<DJCredentials | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [newPlaylist, setNewPlaylist] = useState({ name: '', description: '', is_default: false });
  const [newDJ, setNewDJ] = useState({ dj_name: '', can_stream: true, can_manage_playlist: false });
  const [newMountPoint, setNewMountPoint] = useState({ mount_point: '', bitrate: 128, format: 'mp3' });
  const [newSchedule, setNewSchedule] = useState({
    dj_id: null as string | null,
    playlist_id: '',
    day_of_week: null as number | null,
    start_time: '00:00',
    end_time: '23:59',
    show_name: '',
    is_live: false,
  });

  useEffect(() => {
    if (id) {
      fetchStation();
      fetchPlaylists();
      fetchSchedule();
      fetchAvailableTracks();
      fetchDJs();
      fetchMountPoints();
    }
  }, [id]);

  useEffect(() => {
    if (selectedPlaylist) {
      fetchPlaylistTracks(selectedPlaylist);
    }
  }, [selectedPlaylist]);

  const fetchStation = async () => {
    try {
      const response = await api.get(`/audio/stations/${id}`);
      setStation(response.data);
    } catch (error) {
      console.error('Error fetching station:', error);
    } finally {
      setLoading(false);
    }
  };

  const fetchPlaylists = async () => {
    try {
      const response = await api.get(`/audio/stations/${id}/playlists`);
      setPlaylists(response.data);
      if (response.data.length > 0 && !selectedPlaylist) {
        setSelectedPlaylist(response.data[0].id);
      }
    } catch (error) {
      console.error('Error fetching playlists:', error);
    }
  };

  const fetchSchedule = async () => {
    try {
      const response = await api.get(`/audio/stations/${id}/schedule`);
      setSchedule(response.data);
    } catch (error) {
      console.error('Error fetching schedule:', error);
    }
  };

  const fetchDJs = async () => {
    try {
      const response = await api.get(`/audio/stations/${id}/djs`);
      setDJs(response.data);
    } catch (error) {
      console.error('Error fetching DJs:', error);
    }
  };

  const fetchMountPoints = async () => {
    try {
      const response = await api.get(`/audio/stations/${id}/mount-points`);
      setMountPoints(response.data);
    } catch (error) {
      console.error('Error fetching mount points:', error);
    }
  };

  const fetchPlaylistTracks = async (playlistId: string) => {
    try {
      const response = await api.get(`/audio/playlists/${playlistId}/tracks`);
      setPlaylistTracks(response.data);
    } catch (error) {
      console.error('Error fetching playlist tracks:', error);
    }
  };

  const fetchAvailableTracks = async () => {
    try {
      const response = await api.get('/audio/tracks');
      setAvailableTracks(response.data);
    } catch (error) {
      console.error('Error fetching tracks:', error);
    }
  };

  const toggleStation = async () => {
    if (!station) return;
    try {
      if (station.is_streaming) {
        await api.post(`/audio/stations/${station.id}/stop`);
      } else {
        await api.post(`/audio/stations/${station.id}/start`);
      }
      setTimeout(fetchStation, 1000);
    } catch (error) {
      console.error('Error toggling station:', error);
    }
  };

  const createPlaylist = async () => {
    try {
      await api.post(`/audio/stations/${id}/playlists`, newPlaylist);
      setShowCreatePlaylistModal(false);
      setNewPlaylist({ name: '', description: '', is_default: false });
      fetchPlaylists();
    } catch (error) {
      console.error('Error creating playlist:', error);
    }
  };

  const deletePlaylist = async (playlistId: string) => {
    if (!confirm('Are you sure you want to delete this playlist?')) return;
    try {
      await api.delete(`/audio/playlists/${playlistId}`);
      if (selectedPlaylist === playlistId) {
        setSelectedPlaylist(null);
        setPlaylistTracks([]);
      }
      fetchPlaylists();
    } catch (error: any) {
      console.error('Error deleting playlist:', error);
      alert(error.response?.data?.error || 'Failed to delete playlist');
    }
  };

  const addTrackToPlaylist = async (trackId: string) => {
    if (!selectedPlaylist) return;
    try {
      await api.post(`/audio/playlists/${selectedPlaylist}/tracks`, { track_id: trackId });
      fetchPlaylistTracks(selectedPlaylist);
      fetchPlaylists(); // Refresh track counts
      setShowAddTrackModal(false);
    } catch (error) {
      console.error('Error adding track:', error);
    }
  };

  const removeTrackFromPlaylist = async (trackId: string) => {
    if (!selectedPlaylist) return;
    if (!confirm('Remove this track from the playlist?')) return;
    try {
      await api.delete(`/audio/playlists/${selectedPlaylist}/tracks/${trackId}`);
      fetchPlaylistTracks(selectedPlaylist);
      fetchPlaylists(); // Refresh track counts
    } catch (error) {
      console.error('Error removing track:', error);
    }
  };

  const createDJ = async () => {
    try {
      await api.post(`/audio/stations/${id}/djs`, newDJ);
      setShowCreateDJModal(false);
      setNewDJ({ dj_name: '', can_stream: true, can_manage_playlist: false });
      fetchDJs();
    } catch (error) {
      console.error('Error creating DJ:', error);
    }
  };

  const deleteDJ = async (djId: string) => {
    if (!confirm('Are you sure you want to delete this DJ?')) return;
    try {
      await api.delete(`/audio/djs/${djId}`);
      fetchDJs();
    } catch (error) {
      console.error('Error deleting DJ:', error);
    }
  };

  const viewDJCredentials = async (djId: string) => {
    try {
      const response = await api.get(`/audio/djs/${djId}/credentials`);
      setSelectedDJCredentials(response.data);
      setShowCredentialsModal(true);
    } catch (error) {
      console.error('Error fetching credentials:', error);
    }
  };

  const regenerateCredentials = async (djId: string) => {
    if (!confirm('Are you sure? This will invalidate the current credentials.')) return;
    try {
      const response = await api.post(`/audio/djs/${djId}/regenerate-credentials`);
      if (selectedDJCredentials) {
        setSelectedDJCredentials({
          ...selectedDJCredentials,
          stream_key: response.data.stream_key,
          password: response.data.stream_password,
        });
      }
      fetchDJs();
    } catch (error) {
      console.error('Error regenerating credentials:', error);
    }
  };

  const createMountPoint = async () => {
    try {
      await api.post(`/audio/stations/${id}/mount-points`, newMountPoint);
      setShowMountPointModal(false);
      setNewMountPoint({ mount_point: '', bitrate: 128, format: 'mp3' });
      fetchMountPoints();
    } catch (error) {
      console.error('Error creating mount point:', error);
    }
  };

  const deleteMountPoint = async (mpId: string) => {
    if (!confirm('Are you sure you want to delete this mount point?')) return;
    try {
      await api.delete(`/audio/mount-points/${mpId}`);
      fetchMountPoints();
    } catch (error) {
      console.error('Error deleting mount point:', error);
    }
  };

  const createScheduleEntry = async () => {
    try {
      await api.post(`/audio/stations/${id}/schedule`, newSchedule);
      setShowScheduleModal(false);
      setNewSchedule({
        dj_id: null,
        playlist_id: '',
        day_of_week: null,
        start_time: '00:00',
        end_time: '23:59',
        show_name: '',
        is_live: false,
      });
      fetchSchedule();
    } catch (error) {
      console.error('Error creating schedule:', error);
    }
  };

  const formatDuration = (seconds: number) => {
    if (!seconds) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const formatTotalDuration = (seconds: number) => {
    if (!seconds) return '0 min';
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    if (hours > 0) return `${hours}h ${mins}m`;
    return `${mins} min`;
  };

  const getDayName = (day: number | null) => {
    if (day === null) return 'Daily';
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    return days[day];
  };

  const copyEmbedCode = () => {
    const embedCode = `<iframe src="${window.location.origin}/audio-embed/${id}" width="100%" height="200" frameborder="0"></iframe>`;
    navigator.clipboard.writeText(embedCode);
    alert('Embed code copied to clipboard!');
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
  };

  if (loading || !station) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-red-500"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Link
          to="/radio"
          className="p-2 bg-gray-800 hover:bg-gray-700 rounded-lg transition-colors"
        >
          <ArrowLeft className="w-5 h-5 text-white" />
        </Link>
        <div className="flex-1">
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <Radio className="w-7 h-7 text-red-500" />
            {station.name}
          </h1>
          <p className="text-gray-400">{station.genre}</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 text-gray-400">
            <Users className="w-5 h-5" />
            <span>{station.listeners} listeners</span>
          </div>
          <button
            onClick={toggleStation}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-colors ${
              station.is_streaming
                ? 'bg-red-600 hover:bg-red-700 text-white'
                : 'bg-green-600 hover:bg-green-700 text-white'
            }`}
          >
            {station.is_streaming ? (
              <>
                <Pause className="w-5 h-5" />
                Stop Auto DJ
              </>
            ) : (
              <>
                <Play className="w-5 h-5" />
                Start Auto DJ
              </>
            )}
          </button>
        </div>
      </div>

      {/* Now Playing */}
      {station.is_streaming && (
        <div className="bg-gradient-to-r from-red-900/30 to-gray-800 rounded-lg p-4 border border-red-500/30">
          <div className="flex items-center gap-4">
            <div className="w-3 h-3 bg-red-500 rounded-full animate-pulse"></div>
            <div>
              <p className="text-sm text-gray-400">Now Playing</p>
              <p className="text-white font-medium">
                {station.now_playing_is_live
                  ? `LIVE: ${station.current_dj_name || 'Live DJ'}`
                  : station.now_playing_title
                    ? `${station.now_playing_artist} - ${station.now_playing_title}`
                    : 'Auto DJ Running'
                }
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Stream Info */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-gray-800 rounded-lg p-4">
          <p className="text-gray-400 text-sm mb-1">Stream URL</p>
          <div className="flex items-center gap-2">
            <code className="text-white text-sm bg-gray-900 px-2 py-1 rounded flex-1 truncate">
              /audio/{station.mount_point}
            </code>
            <button
              onClick={() => copyToClipboard(`${window.location.origin}/audio/${station.mount_point}`)}
              className="p-1 hover:bg-gray-700 rounded transition-colors"
              title="Copy URL"
            >
              <Copy className="w-4 h-4 text-gray-400" />
            </button>
          </div>
        </div>
        <div className="bg-gray-800 rounded-lg p-4">
          <p className="text-gray-400 text-sm mb-1">Audio Quality</p>
          <p className="text-white font-medium">{station.bitrate} kbps</p>
        </div>
        <div className="bg-gray-800 rounded-lg p-4">
          <p className="text-gray-400 text-sm mb-1">Auto DJ</p>
          <p className={`font-medium ${station.auto_dj_enabled ? 'text-green-400' : 'text-gray-400'}`}>
            {station.auto_dj_enabled ? 'Enabled' : 'Disabled'}
          </p>
        </div>
        <div className="bg-gray-800 rounded-lg p-4">
          <p className="text-gray-400 text-sm mb-1">Embed Player</p>
          <button
            onClick={copyEmbedCode}
            className="flex items-center gap-2 text-red-500 hover:text-red-400 transition-colors"
          >
            <ExternalLink className="w-4 h-4" />
            Copy Embed Code
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="border-b border-gray-700">
        <div className="flex gap-4">
          <button
            onClick={() => setActiveTab('playlists')}
            className={`px-4 py-2 border-b-2 transition-colors ${
              activeTab === 'playlists'
                ? 'border-red-500 text-white'
                : 'border-transparent text-gray-400 hover:text-white'
            }`}
          >
            <div className="flex items-center gap-2">
              <ListMusic className="w-5 h-5" />
              Playlists
            </div>
          </button>
          <button
            onClick={() => setActiveTab('djs')}
            className={`px-4 py-2 border-b-2 transition-colors ${
              activeTab === 'djs'
                ? 'border-red-500 text-white'
                : 'border-transparent text-gray-400 hover:text-white'
            }`}
          >
            <div className="flex items-center gap-2">
              <Mic className="w-5 h-5" />
              DJs ({djs.length})
            </div>
          </button>
          <button
            onClick={() => setActiveTab('schedule')}
            className={`px-4 py-2 border-b-2 transition-colors ${
              activeTab === 'schedule'
                ? 'border-red-500 text-white'
                : 'border-transparent text-gray-400 hover:text-white'
            }`}
          >
            <div className="flex items-center gap-2">
              <Calendar className="w-5 h-5" />
              Schedule
            </div>
          </button>
          <button
            onClick={() => setActiveTab('settings')}
            className={`px-4 py-2 border-b-2 transition-colors ${
              activeTab === 'settings'
                ? 'border-red-500 text-white'
                : 'border-transparent text-gray-400 hover:text-white'
            }`}
          >
            <div className="flex items-center gap-2">
              <Settings className="w-5 h-5" />
              Settings
            </div>
          </button>
        </div>
      </div>

      {/* Playlists Tab */}
      {activeTab === 'playlists' && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="bg-gray-800 rounded-lg p-4">
            <div className="flex justify-between items-center mb-4">
              <h3 className="font-semibold text-white">Playlists</h3>
              <button
                onClick={() => setShowCreatePlaylistModal(true)}
                className="p-1 hover:bg-gray-700 rounded transition-colors"
              >
                <Plus className="w-5 h-5 text-gray-400" />
              </button>
            </div>
            <div className="space-y-2">
              {playlists.map((playlist) => (
                <div
                  key={playlist.id}
                  className={`p-3 rounded-lg transition-colors ${
                    selectedPlaylist === playlist.id
                      ? 'bg-red-600 text-white'
                      : 'bg-gray-700 hover:bg-gray-600 text-white'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <button
                      onClick={() => setSelectedPlaylist(playlist.id)}
                      className="flex-1 text-left"
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-medium">{playlist.name}</span>
                        {playlist.is_default && (
                          <span className="text-xs bg-green-500/20 text-green-400 px-2 py-0.5 rounded">
                            Default
                          </span>
                        )}
                      </div>
                      <p className="text-sm opacity-70 mt-1">
                        {playlist.track_count} tracks • {formatTotalDuration(playlist.total_duration)}
                      </p>
                    </button>
                    {!playlist.is_default && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          deletePlaylist(playlist.id);
                        }}
                        className="ml-2 p-1 hover:bg-gray-800 rounded transition-colors"
                        title="Delete Playlist"
                      >
                        <Trash2 className="w-4 h-4 text-red-400" />
                      </button>
                    )}
                  </div>
                </div>
              ))}
              {playlists.length === 0 && (
                <p className="text-gray-400 text-sm text-center py-4">No playlists yet</p>
              )}
            </div>
          </div>

          <div className="lg:col-span-2 bg-gray-800 rounded-lg p-4">
            <div className="flex justify-between items-center mb-4">
              <h3 className="font-semibold text-white">
                {playlists.find(p => p.id === selectedPlaylist)?.name || 'Select a Playlist'}
              </h3>
              {selectedPlaylist && (
                <button
                  onClick={() => setShowAddTrackModal(true)}
                  className="flex items-center gap-2 px-3 py-1 bg-red-600 hover:bg-red-700 text-white rounded-lg text-sm transition-colors"
                >
                  <Plus className="w-4 h-4" />
                  Add Track
                </button>
              )}
            </div>
            <div className="space-y-2 max-h-[400px] overflow-auto">
              {playlistTracks.map((track, index) => (
                <div
                  key={track.id}
                  className="flex items-center gap-3 p-3 bg-gray-700 rounded-lg"
                >
                  <GripVertical className="w-4 h-4 text-gray-500 cursor-grab" />
                  <span className="w-6 text-gray-500 text-sm">{index + 1}</span>
                  <div className="flex-1">
                    <p className="text-white">{track.title}</p>
                    <p className="text-sm text-gray-400">{track.artist}</p>
                  </div>
                  <span className="text-gray-400 text-sm">{formatDuration(track.duration)}</span>
                  <button
                    onClick={() => removeTrackFromPlaylist(track.id)}
                    className="p-1 hover:bg-gray-600 rounded transition-colors"
                    title="Remove from playlist"
                  >
                    <Trash2 className="w-4 h-4 text-red-400" />
                  </button>
                </div>
              ))}
              {playlistTracks.length === 0 && selectedPlaylist && (
                <p className="text-gray-400 text-sm text-center py-8">No tracks in this playlist</p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* DJs Tab */}
      {activeTab === 'djs' && (
        <div className="space-y-4">
          <div className="flex justify-between items-center">
            <h3 className="font-semibold text-white text-lg">DJ Accounts & Streaming Credentials</h3>
            <button
              onClick={() => setShowCreateDJModal(true)}
              className="flex items-center gap-2 px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg transition-colors"
            >
              <Plus className="w-5 h-5" />
              Add DJ
            </button>
          </div>

          <div className="bg-gray-800 rounded-lg overflow-hidden">
            <table className="w-full">
              <thead className="bg-gray-700">
                <tr>
                  <th className="px-4 py-3 text-left text-sm font-medium text-gray-300">DJ Name</th>
                  <th className="px-4 py-3 text-left text-sm font-medium text-gray-300">Stream Key</th>
                  <th className="px-4 py-3 text-left text-sm font-medium text-gray-300">Permissions</th>
                  <th className="px-4 py-3 text-left text-sm font-medium text-gray-300">Last Connected</th>
                  <th className="px-4 py-3 text-left text-sm font-medium text-gray-300">Status</th>
                  <th className="px-4 py-3 text-right text-sm font-medium text-gray-300">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-700">
                {djs.map((dj) => (
                  <tr key={dj.id} className="hover:bg-gray-700/50">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <Mic className="w-5 h-5 text-red-500" />
                        <span className="text-white font-medium">{dj.dj_name}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <code className="text-sm text-gray-400 bg-gray-900 px-2 py-1 rounded">
                        {dj.stream_key.substring(0, 8)}...
                      </code>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex gap-2">
                        {dj.can_stream && (
                          <span className="text-xs bg-green-500/20 text-green-400 px-2 py-0.5 rounded">
                            Stream
                          </span>
                        )}
                        {dj.can_manage_playlist && (
                          <span className="text-xs bg-blue-500/20 text-blue-400 px-2 py-0.5 rounded">
                            Playlist
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-gray-400 text-sm">
                      {dj.last_connected
                        ? new Date(dj.last_connected).toLocaleDateString()
                        : 'Never'
                      }
                    </td>
                    <td className="px-4 py-3">
                      <span className={`text-xs px-2 py-0.5 rounded ${
                        dj.is_active
                          ? 'bg-green-500/20 text-green-400'
                          : 'bg-gray-500/20 text-gray-400'
                      }`}>
                        {dj.is_active ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-2">
                        <button
                          onClick={() => viewDJCredentials(dj.id)}
                          className="p-1 hover:bg-gray-600 rounded transition-colors"
                          title="View Credentials"
                        >
                          <Key className="w-4 h-4 text-gray-400" />
                        </button>
                        <button
                          onClick={() => deleteDJ(dj.id)}
                          className="p-1 hover:bg-gray-600 rounded transition-colors"
                          title="Delete DJ"
                        >
                          <Trash2 className="w-4 h-4 text-red-400" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {djs.length === 0 && (
              <div className="text-center py-8 text-gray-400">
                No DJs configured yet. Add a DJ to generate streaming credentials.
              </div>
            )}
          </div>

          {/* Mount Points Section */}
          <div className="mt-8">
            <div className="flex justify-between items-center mb-4">
              <h3 className="font-semibold text-white text-lg">Mount Points</h3>
              <button
                onClick={() => setShowMountPointModal(true)}
                className="flex items-center gap-2 px-3 py-1 bg-gray-700 hover:bg-gray-600 text-white rounded-lg text-sm transition-colors"
              >
                <Plus className="w-4 h-4" />
                Add Mount Point
              </button>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {mountPoints.map((mp) => (
                <div key={mp.id} className="bg-gray-800 rounded-lg p-4">
                  <div className="flex justify-between items-start">
                    <div>
                      <code className="text-white font-medium">/{mp.mount_point}</code>
                      {mp.is_primary && (
                        <span className="ml-2 text-xs bg-red-500/20 text-red-400 px-2 py-0.5 rounded">
                          Primary
                        </span>
                      )}
                    </div>
                    {!mp.is_primary && (
                      <button
                        onClick={() => deleteMountPoint(mp.id)}
                        className="p-1 hover:bg-gray-700 rounded"
                      >
                        <Trash2 className="w-4 h-4 text-gray-400" />
                      </button>
                    )}
                  </div>
                  <div className="mt-2 text-sm text-gray-400">
                    {mp.bitrate} kbps • {mp.format.toUpperCase()}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Schedule Tab */}
      {activeTab === 'schedule' && (
        <div className="bg-gray-800 rounded-lg p-4">
          <div className="flex justify-between items-center mb-4">
            <h3 className="font-semibold text-white">Programming Schedule</h3>
            <button
              onClick={() => setShowScheduleModal(true)}
              className="flex items-center gap-2 px-3 py-1 bg-red-600 hover:bg-red-700 text-white rounded-lg text-sm transition-colors"
            >
              <Plus className="w-4 h-4" />
              Add Schedule
            </button>
          </div>
          <div className="space-y-2">
            {schedule.map((entry) => (
              <div
                key={entry.id}
                className="flex items-center gap-4 p-4 bg-gray-700 rounded-lg"
              >
                <div className="w-24">
                  <span className={`px-2 py-1 rounded text-xs ${
                    entry.is_live ? 'bg-red-500 text-white' : 'bg-gray-600 text-gray-300'
                  }`}>
                    {entry.is_live ? 'LIVE' : 'AUTO'}
                  </span>
                </div>
                <div className="flex-1">
                  <p className="text-white font-medium">{entry.show_name || 'Automated Playlist'}</p>
                  {entry.dj_name && <p className="text-sm text-gray-400">DJ: {entry.dj_name}</p>}
                  {entry.playlist_name && <p className="text-sm text-gray-400">Playlist: {entry.playlist_name}</p>}
                </div>
                <div className="text-right">
                  <p className="text-white">{getDayName(entry.day_of_week)}</p>
                  <p className="text-sm text-gray-400">{entry.start_time} - {entry.end_time}</p>
                </div>
              </div>
            ))}
            {schedule.length === 0 && (
              <p className="text-gray-400 text-sm text-center py-8">No schedule entries yet</p>
            )}
          </div>
        </div>
      )}

      {/* Settings Tab */}
      {activeTab === 'settings' && (
        <div className="bg-gray-800 rounded-lg p-6 max-w-2xl">
          <h3 className="font-semibold text-white mb-4">Station Settings</h3>
          <div className="space-y-4">
            <div>
              <label className="block text-sm text-gray-400 mb-1">Station Name</label>
              <input
                type="text"
                defaultValue={station.name}
                className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white focus:outline-none focus:border-red-500"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1">Description</label>
              <textarea
                defaultValue={station.description}
                rows={3}
                className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white focus:outline-none focus:border-red-500"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1">Genre</label>
              <input
                type="text"
                defaultValue={station.genre}
                className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white focus:outline-none focus:border-red-500"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1">Audio Quality</label>
              <select
                defaultValue={station.bitrate}
                className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white focus:outline-none focus:border-red-500"
              >
                <option value={128}>128 kbps (Standard)</option>
                <option value={192}>192 kbps (High)</option>
                <option value={256}>256 kbps (Very High)</option>
                <option value={320}>320 kbps (Premium)</option>
              </select>
            </div>
            <div className="pt-4 border-t border-gray-700">
              <label className="flex items-center gap-3 text-white">
                <input
                  type="checkbox"
                  defaultChecked={station.auto_dj_enabled}
                  className="rounded bg-gray-700 border-gray-600 text-red-500 focus:ring-red-500"
                />
                Enable Auto DJ (plays playlist when no live DJ is connected)
              </label>
            </div>
            <button className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg transition-colors">
              Save Changes
            </button>
          </div>
        </div>
      )}

      {/* Create Playlist Modal */}
      {showCreatePlaylistModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-gray-800 rounded-lg p-6 w-full max-w-md">
            <h2 className="text-xl font-bold text-white mb-4">Create Playlist</h2>
            <div className="space-y-4">
              <div>
                <label className="block text-sm text-gray-400 mb-1">Playlist Name</label>
                <input
                  type="text"
                  value={newPlaylist.name}
                  onChange={(e) => setNewPlaylist({ ...newPlaylist, name: e.target.value })}
                  className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white focus:outline-none focus:border-red-500"
                />
              </div>
              <div>
                <label className="block text-sm text-gray-400 mb-1">Description</label>
                <textarea
                  value={newPlaylist.description}
                  onChange={(e) => setNewPlaylist({ ...newPlaylist, description: e.target.value })}
                  className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white focus:outline-none focus:border-red-500"
                  rows={2}
                />
              </div>
              <label className="flex items-center gap-2 text-white">
                <input
                  type="checkbox"
                  checked={newPlaylist.is_default}
                  onChange={(e) => setNewPlaylist({ ...newPlaylist, is_default: e.target.checked })}
                  className="rounded bg-gray-700 border-gray-600"
                />
                Set as default playlist for Auto DJ
              </label>
            </div>
            <div className="flex gap-3 mt-6">
              <button
                onClick={() => setShowCreatePlaylistModal(false)}
                className="flex-1 px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={createPlaylist}
                disabled={!newPlaylist.name}
                className="flex-1 px-4 py-2 bg-red-600 hover:bg-red-700 disabled:bg-gray-600 text-white rounded-lg transition-colors"
              >
                Create
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Create DJ Modal */}
      {showCreateDJModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-gray-800 rounded-lg p-6 w-full max-w-md">
            <h2 className="text-xl font-bold text-white mb-4">Add DJ Account</h2>
            <div className="space-y-4">
              <div>
                <label className="block text-sm text-gray-400 mb-1">DJ Name</label>
                <input
                  type="text"
                  value={newDJ.dj_name}
                  onChange={(e) => setNewDJ({ ...newDJ, dj_name: e.target.value })}
                  placeholder="DJ Awesome"
                  className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white focus:outline-none focus:border-red-500"
                />
              </div>
              <div className="space-y-2">
                <label className="block text-sm text-gray-400">Permissions</label>
                <label className="flex items-center gap-2 text-white">
                  <input
                    type="checkbox"
                    checked={newDJ.can_stream}
                    onChange={(e) => setNewDJ({ ...newDJ, can_stream: e.target.checked })}
                    className="rounded bg-gray-700 border-gray-600"
                  />
                  Can stream live
                </label>
                <label className="flex items-center gap-2 text-white">
                  <input
                    type="checkbox"
                    checked={newDJ.can_manage_playlist}
                    onChange={(e) => setNewDJ({ ...newDJ, can_manage_playlist: e.target.checked })}
                    className="rounded bg-gray-700 border-gray-600"
                  />
                  Can manage playlists
                </label>
              </div>
              <p className="text-sm text-gray-400">
                Streaming credentials will be automatically generated for this DJ.
              </p>
            </div>
            <div className="flex gap-3 mt-6">
              <button
                onClick={() => setShowCreateDJModal(false)}
                className="flex-1 px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={createDJ}
                disabled={!newDJ.dj_name}
                className="flex-1 px-4 py-2 bg-red-600 hover:bg-red-700 disabled:bg-gray-600 text-white rounded-lg transition-colors"
              >
                Create DJ
              </button>
            </div>
          </div>
        </div>
      )}

      {/* DJ Credentials Modal */}
      {showCredentialsModal && selectedDJCredentials && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-gray-800 rounded-lg p-6 w-full max-w-lg">
            <h2 className="text-xl font-bold text-white mb-4">
              Streaming Credentials - {selectedDJCredentials.dj_name}
            </h2>
            <div className="space-y-4">
              <div className="bg-gray-900 rounded-lg p-4 space-y-3">
                <div className="flex justify-between items-center">
                  <span className="text-gray-400">Server:</span>
                  <div className="flex items-center gap-2">
                    <code className="text-white">{selectedDJCredentials.server}</code>
                    <button onClick={() => copyToClipboard(selectedDJCredentials.server)} className="p-1 hover:bg-gray-700 rounded">
                      <Copy className="w-4 h-4 text-gray-400" />
                    </button>
                  </div>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-gray-400">Port:</span>
                  <code className="text-white">{selectedDJCredentials.port}</code>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-gray-400">Mount Point:</span>
                  <div className="flex items-center gap-2">
                    <code className="text-white">{selectedDJCredentials.mount_point}</code>
                    <button onClick={() => copyToClipboard(selectedDJCredentials.mount_point)} className="p-1 hover:bg-gray-700 rounded">
                      <Copy className="w-4 h-4 text-gray-400" />
                    </button>
                  </div>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-gray-400">Username:</span>
                  <code className="text-white">{selectedDJCredentials.username}</code>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-gray-400">Password:</span>
                  <div className="flex items-center gap-2">
                    <code className="text-white">
                      {showPassword ? selectedDJCredentials.password : '••••••••••••'}
                    </code>
                    <button onClick={() => setShowPassword(!showPassword)} className="p-1 hover:bg-gray-700 rounded">
                      {showPassword ? <EyeOff className="w-4 h-4 text-gray-400" /> : <Eye className="w-4 h-4 text-gray-400" />}
                    </button>
                    <button onClick={() => copyToClipboard(selectedDJCredentials.password)} className="p-1 hover:bg-gray-700 rounded">
                      <Copy className="w-4 h-4 text-gray-400" />
                    </button>
                  </div>
                </div>
              </div>

              <div className="bg-gray-700 rounded-lg p-4">
                <p className="text-sm text-gray-400 mb-2">Quick Connection URL (for BUTT, Mixxx, etc.):</p>
                <div className="flex items-center gap-2">
                  <code className="text-white text-sm bg-gray-900 px-2 py-1 rounded flex-1 truncate">
                    {selectedDJCredentials.connection_urls.butt}
                  </code>
                  <button
                    onClick={() => copyToClipboard(selectedDJCredentials.connection_urls.butt)}
                    className="p-1 hover:bg-gray-600 rounded"
                  >
                    <Copy className="w-4 h-4 text-gray-400" />
                  </button>
                </div>
              </div>

              <button
                onClick={() => {
                  const djId = djs.find(d => d.stream_key === selectedDJCredentials.stream_key)?.id;
                  if (djId) regenerateCredentials(djId);
                }}
                className="flex items-center gap-2 text-yellow-400 hover:text-yellow-300 text-sm"
              >
                <RefreshCw className="w-4 h-4" />
                Regenerate Credentials
              </button>
            </div>
            <button
              onClick={() => {
                setShowCredentialsModal(false);
                setShowPassword(false);
              }}
              className="w-full mt-6 px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded-lg transition-colors"
            >
              Close
            </button>
          </div>
        </div>
      )}

      {/* Mount Point Modal */}
      {showMountPointModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-gray-800 rounded-lg p-6 w-full max-w-md">
            <h2 className="text-xl font-bold text-white mb-4">Add Mount Point</h2>
            <div className="space-y-4">
              <div>
                <label className="block text-sm text-gray-400 mb-1">Mount Point Name</label>
                <div className="flex items-center">
                  <span className="text-gray-400 mr-1">/</span>
                  <input
                    type="text"
                    value={newMountPoint.mount_point}
                    onChange={(e) => setNewMountPoint({ ...newMountPoint, mount_point: e.target.value.replace(/[^a-z0-9-]/g, '') })}
                    placeholder="station-hq"
                    className="flex-1 px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white focus:outline-none focus:border-red-500"
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm text-gray-400 mb-1">Bitrate</label>
                <select
                  value={newMountPoint.bitrate}
                  onChange={(e) => setNewMountPoint({ ...newMountPoint, bitrate: parseInt(e.target.value) })}
                  className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white focus:outline-none focus:border-red-500"
                >
                  <option value={64}>64 kbps</option>
                  <option value={128}>128 kbps</option>
                  <option value={192}>192 kbps</option>
                  <option value={256}>256 kbps</option>
                  <option value={320}>320 kbps</option>
                </select>
              </div>
              <div>
                <label className="block text-sm text-gray-400 mb-1">Format</label>
                <select
                  value={newMountPoint.format}
                  onChange={(e) => setNewMountPoint({ ...newMountPoint, format: e.target.value })}
                  className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white focus:outline-none focus:border-red-500"
                >
                  <option value="mp3">MP3</option>
                  <option value="aac">AAC</option>
                  <option value="ogg">OGG Vorbis</option>
                </select>
              </div>
            </div>
            <div className="flex gap-3 mt-6">
              <button
                onClick={() => setShowMountPointModal(false)}
                className="flex-1 px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={createMountPoint}
                disabled={!newMountPoint.mount_point}
                className="flex-1 px-4 py-2 bg-red-600 hover:bg-red-700 disabled:bg-gray-600 text-white rounded-lg transition-colors"
              >
                Create
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add Track Modal */}
      {showAddTrackModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[100]" onClick={(e) => e.target === e.currentTarget && setShowAddTrackModal(false)}>
          <div className="bg-gray-800 rounded-lg p-6 w-full max-w-lg max-h-[80vh] flex flex-col mx-4" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-xl font-bold text-white mb-4">Add Track to Playlist</h2>
            <div className="flex-1 overflow-y-auto space-y-2 min-h-0">
              {availableTracks.length === 0 ? (
                <div className="text-center py-8">
                  <Music className="w-12 h-12 text-gray-500 mx-auto mb-3" />
                  <p className="text-gray-400">No tracks available in the library.</p>
                  <p className="text-gray-500 text-sm mt-1">Upload audio files first to add them to playlists.</p>
                  <Link
                    to="/audio-library"
                    className="inline-block mt-4 px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg transition-colors"
                  >
                    Go to Audio Library
                  </Link>
                </div>
              ) : (
                availableTracks.map((track) => (
                  <button
                    key={track.id}
                    type="button"
                    onClick={() => addTrackToPlaylist(track.id)}
                    className="w-full flex items-center gap-3 p-3 bg-gray-700 hover:bg-gray-600 rounded-lg transition-colors cursor-pointer text-left"
                  >
                    <Music className="w-5 h-5 text-gray-400 flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-white truncate">{track.title}</p>
                      <p className="text-sm text-gray-400 truncate">{track.artist || 'Unknown Artist'}</p>
                    </div>
                    <span className="text-gray-400 text-sm flex-shrink-0">{formatDuration(track.duration)}</span>
                  </button>
                ))
              )}
            </div>
            <button
              type="button"
              onClick={() => setShowAddTrackModal(false)}
              className="mt-4 px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded-lg transition-colors"
            >
              Close
            </button>
          </div>
        </div>
      )}

      {/* Schedule Modal */}
      {showScheduleModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-gray-800 rounded-lg p-6 w-full max-w-md">
            <h2 className="text-xl font-bold text-white mb-4">Add Schedule Entry</h2>
            <div className="space-y-4">
              <div>
                <label className="block text-sm text-gray-400 mb-1">Day</label>
                <select
                  value={newSchedule.day_of_week ?? ''}
                  onChange={(e) => setNewSchedule({ ...newSchedule, day_of_week: e.target.value === '' ? null : parseInt(e.target.value) })}
                  className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white focus:outline-none focus:border-red-500"
                >
                  <option value="">Daily</option>
                  <option value={0}>Sunday</option>
                  <option value={1}>Monday</option>
                  <option value={2}>Tuesday</option>
                  <option value={3}>Wednesday</option>
                  <option value={4}>Thursday</option>
                  <option value={5}>Friday</option>
                  <option value={6}>Saturday</option>
                </select>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm text-gray-400 mb-1">Start Time</label>
                  <input
                    type="time"
                    value={newSchedule.start_time}
                    onChange={(e) => setNewSchedule({ ...newSchedule, start_time: e.target.value })}
                    className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white focus:outline-none focus:border-red-500"
                  />
                </div>
                <div>
                  <label className="block text-sm text-gray-400 mb-1">End Time</label>
                  <input
                    type="time"
                    value={newSchedule.end_time}
                    onChange={(e) => setNewSchedule({ ...newSchedule, end_time: e.target.value })}
                    className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white focus:outline-none focus:border-red-500"
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm text-gray-400 mb-1">DJ (optional)</label>
                <select
                  value={newSchedule.dj_id || ''}
                  onChange={(e) => setNewSchedule({ ...newSchedule, dj_id: e.target.value || null })}
                  className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white focus:outline-none focus:border-red-500"
                >
                  <option value="">Auto DJ</option>
                  {djs.map((dj) => (
                    <option key={dj.id} value={dj.id}>{dj.dj_name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm text-gray-400 mb-1">Playlist</label>
                <select
                  value={newSchedule.playlist_id}
                  onChange={(e) => setNewSchedule({ ...newSchedule, playlist_id: e.target.value })}
                  className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white focus:outline-none focus:border-red-500"
                >
                  <option value="">Select playlist...</option>
                  {playlists.map((playlist) => (
                    <option key={playlist.id} value={playlist.id}>{playlist.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm text-gray-400 mb-1">Show Name (optional)</label>
                <input
                  type="text"
                  value={newSchedule.show_name}
                  onChange={(e) => setNewSchedule({ ...newSchedule, show_name: e.target.value })}
                  className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white focus:outline-none focus:border-red-500"
                  placeholder="Morning Show"
                />
              </div>
              <label className="flex items-center gap-2 text-white">
                <input
                  type="checkbox"
                  checked={newSchedule.is_live}
                  onChange={(e) => setNewSchedule({ ...newSchedule, is_live: e.target.checked })}
                  className="rounded bg-gray-700 border-gray-600"
                />
                Live DJ slot (DJ can connect and take over)
              </label>
            </div>
            <div className="flex gap-3 mt-6">
              <button
                onClick={() => setShowScheduleModal(false)}
                className="flex-1 px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={createScheduleEntry}
                className="flex-1 px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg transition-colors"
              >
                Add
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
