import { useState, useCallback, useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useDropzone } from 'react-dropzone';
import * as tus from 'tus-js-client';
import { vodApi } from '../services/api';
import { useAuthStore } from '../stores/authStore';
import {
  Upload,
  Film,
  Trash2,
  Play,
  Clock,
  HardDrive,
  Loader2,
  Edit2,
  Download,
  Pause,
  RotateCcw,
  X
} from 'lucide-react';

export default function VODLibrary() {
  const [showUpload, setShowUpload] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadSpeed, setUploadSpeed] = useState('');
  const [uploadTitle, setUploadTitle] = useState('');
  const [uploadDescription, setUploadDescription] = useState('');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [canUpload, setCanUpload] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadSuccess, setUploadSuccess] = useState(false);

  // Edit state
  const [editingFile, setEditingFile] = useState<any>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editDescription, setEditDescription] = useState("");

  const tusUploadRef = useRef<tus.Upload | null>(null);
  const lastProgressRef = useRef<{ time: number; bytes: number }>({ time: 0, bytes: 0 });

  const queryClient = useQueryClient();
  const { user, token } = useAuthStore();

  // Check if user can upload
  useEffect(() => {
    // Admins can always upload
    if (user?.role === 'admin') {
      setCanUpload(true);
      return;
    }

    // Check if user has vod_upload service permission
    const userServices = (user as any)?.services || [];
    if (userServices.includes('vod_upload')) {
      setCanUpload(true);
      return;
    }

    // Fallback: Check platform settings for allow_user_uploads (global setting)
    fetch('/api/settings/public')
      .then(res => res.json())
      .then(data => {
        // Handle both string 'true' and boolean true
        const allowUploads = data.settings?.allow_user_uploads === 'true' || data.settings?.allow_user_uploads === true;
        setCanUpload(allowUploads);
      })
      .catch(() => setCanUpload(false));
  }, [user]);

  const { data: vodData, isLoading } = useQuery({
    queryKey: ['vod'],
    queryFn: () => vodApi.list(),
    refetchInterval: 10000,
  });

  const startTusUpload = useCallback(() => {
    if (!selectedFile || !token) return;

    setIsUploading(true);
    setUploadError(null);
    setUploadProgress(0);
    setUploadSpeed('');
    lastProgressRef.current = { time: Date.now(), bytes: 0 };

    const upload = new tus.Upload(selectedFile, {
      endpoint: '/api/tus/',
      retryDelays: [0, 3000, 5000, 10000, 20000],
      chunkSize: 5 * 1024 * 1024, // 5MB chunks
      metadata: {
        filename: selectedFile.name,
        filetype: selectedFile.type,
        title: uploadTitle || selectedFile.name,
        description: uploadDescription || '',
      },
      headers: {
        'Authorization': `Bearer ${token}`,
      },
      onError: (error) => {
        console.error('Upload error:', error);
        setUploadError(error.message || 'Upload failed');
        setIsUploading(false);
      },
      onProgress: (bytesUploaded, bytesTotal) => {
        const percentage = Math.round((bytesUploaded / bytesTotal) * 100);
        setUploadProgress(percentage);

        // Calculate upload speed
        const now = Date.now();
        const timeDiff = (now - lastProgressRef.current.time) / 1000;
        if (timeDiff >= 1) {
          const bytesDiff = bytesUploaded - lastProgressRef.current.bytes;
          const speed = bytesDiff / timeDiff;
          setUploadSpeed(formatSpeed(speed));
          lastProgressRef.current = { time: now, bytes: bytesUploaded };
        }
      },
      onSuccess: () => {
        console.log('Upload complete!');
        setIsUploading(false);
        setShowUpload(false);
        setSelectedFile(null);
        setUploadTitle('');
        setUploadDescription('');
        setUploadProgress(0);
        setUploadSpeed('');
        tusUploadRef.current = null;
        setUploadSuccess(true);
        setTimeout(() => setUploadSuccess(false), 8000); // Hide after 8 seconds
        queryClient.invalidateQueries({ queryKey: ['vod'] });
      },
    });

    tusUploadRef.current = upload;

    // Check for previous uploads to resume
    upload.findPreviousUploads().then((previousUploads) => {
      if (previousUploads.length > 0) {
        // Resume from the last upload
        upload.resumeFromPreviousUpload(previousUploads[0]);
      }
      upload.start();
    });
  }, [selectedFile, token, uploadTitle, uploadDescription, queryClient]);

  const pauseUpload = () => {
    if (tusUploadRef.current) {
      tusUploadRef.current.abort();
      setIsPaused(true);
    }
  };

  const resumeUpload = () => {
    if (tusUploadRef.current) {
      tusUploadRef.current.start();
      setIsPaused(false);
    }
  };

  const cancelUpload = () => {
    if (tusUploadRef.current) {
      tusUploadRef.current.abort();
      tusUploadRef.current = null;
    }
    setIsUploading(false);
    setIsPaused(false);
    setUploadProgress(0);
    setUploadSpeed('');
    setUploadError(null);
  };

  const deleteMutation = useMutation({
    mutationFn: (id: string) => vodApi.delete(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['vod'] }),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, title, description }: { id: string; title: string; description: string }) =>
      vodApi.update(id, { title, description }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['vod'] });
      setEditingFile(null);
      setEditTitle("");
      setEditDescription("");
    },
  });

  const openEditModal = (file: any) => {
    setEditingFile(file);
    setEditTitle(file.title);
    setEditDescription(file.description || "");
  };

  const onDrop = useCallback((acceptedFiles: File[]) => {
    if (acceptedFiles.length > 0) {
      setSelectedFile(acceptedFiles[0]);
      setUploadTitle(acceptedFiles[0].name.replace(/\.[^/.]+$/, ''));
      setUploadError(null);
    }
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      'video/*': ['.mp4', '.mov', '.avi', '.mkv', '.webm', '.flv'],
    },
    maxFiles: 1,
  });

  const files = vodData?.data?.files || [];

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const formatSpeed = (bytesPerSecond: number) => {
    if (bytesPerSecond === 0) return '0 B/s';
    const k = 1024;
    const sizes = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
    const i = Math.floor(Math.log(bytesPerSecond) / Math.log(k));
    return parseFloat((bytesPerSecond / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  };

  const formatDuration = (seconds: number) => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return h > 0
      ? `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
      : `${m}:${s.toString().padStart(2, '0')}`;
  };

  const playVideo = (file: any) => {
    // Open VOD in embed player style
    const playerUrl = `/embed/${file.id}?type=vod&autoplay=true&muted=false`;
    window.open(playerUrl, "_blank", "width=1280,height=720");
  };

  const downloadVideo = async (file: any) => {
    try {
      // Get the auth token from localStorage
      const token = localStorage.getItem('token');
      if (!token) {
        alert('Please log in to download videos');
        return;
      }

      // First, get a temporary download token from the server
      const tokenResponse = await fetch(`/api/vod/${file.id}/download-token`, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      if (!tokenResponse.ok) {
        const error = await tokenResponse.json();
        throw new Error(error.error || 'Failed to prepare download');
      }

      const { downloadUrl } = await tokenResponse.json();

      // Open in new window for immediate browser download
      // This triggers native browser download without JavaScript memory handling
      window.open(downloadUrl, '_blank');
    } catch (error: any) {
      console.error('Download error:', error);
      alert(error.message || 'Failed to download video');
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-2xl font-bold">VOD Library</h1>
        {canUpload && (
          <button
            onClick={() => setShowUpload(true)}
            className="btn btn-primary flex items-center gap-2"
          >
            <Upload className="w-4 h-4" />
            Upload Video
          </button>
        )}
      </div>

      {/* Upload Success Banner */}
      {uploadSuccess && (
        <div className="mb-6 p-4 bg-green-500/20 border border-green-500/50 rounded-lg flex items-center gap-3">
          <div className="w-8 h-8 rounded-full bg-green-500/30 flex items-center justify-center">
            <Upload className="w-4 h-4 text-green-400" />
          </div>
          <div className="flex-1">
            <p className="font-medium text-green-400">Video uploaded successfully!</p>
            <p className="text-sm text-green-300/70">Your video is now processing. This may take a few minutes.</p>
          </div>
          <button
            onClick={() => setUploadSuccess(false)}
            className="text-green-400 hover:text-green-300"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
      )}

      {/* Edit Modal */}
      {editingFile && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="card w-full max-w-md m-4">
            <h2 className="text-xl font-semibold mb-4">Edit Video</h2>
            <div className="space-y-4">
              <div>
                <label className="label">Title</label>
                <input
                  type="text"
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  className="input"
                  placeholder="Enter video title"
                />
              </div>
              <div>
                <label className="label">Description (optional)</label>
                <textarea
                  value={editDescription}
                  onChange={(e) => setEditDescription(e.target.value)}
                  className="input"
                  rows={3}
                  placeholder="Enter video description"
                />
              </div>
            </div>
            <div className="flex justify-end gap-3 mt-6">
              <button
                onClick={() => setEditingFile(null)}
                className="btn btn-secondary"
              >
                Cancel
              </button>
              <button
                onClick={() => editTitle.trim() && updateMutation.mutate({ id: editingFile.id, title: editTitle.trim(), description: editDescription.trim() })}
                disabled={!editTitle.trim() || updateMutation.isPending}
                className="btn btn-primary"
              >
                {updateMutation.isPending ? "Saving..." : "Save Changes"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Upload Modal */}
      {showUpload && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="card w-full max-w-lg m-4">
            <h2 className="text-xl font-semibold mb-4">Upload Video</h2>

            {!selectedFile ? (
              <div
                {...getRootProps()}
                className={`border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors ${
                  isDragActive
                    ? 'border-primary-500 bg-primary-500/10'
                    : 'border-gray-600 hover:border-gray-500'
                }`}
              >
                <input {...getInputProps()} />
                <Upload className="w-12 h-12 mx-auto mb-4 text-gray-400" />
                <p className="text-gray-300 mb-2">
                  Drag & drop a video file here, or click to select
                </p>
                <p className="text-gray-500 text-sm">
                  Supported: MP4, MOV, AVI, MKV, WebM, FLV (up to 10GB)
                </p>
                <p className="text-green-500 text-sm mt-2">
                  Resumable uploads - can pause and resume!
                </p>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="p-4 bg-gray-700/50 rounded-lg flex items-center gap-4">
                  <Film className="w-8 h-8 text-primary-500" />
                  <div className="flex-1">
                    <p className="font-medium">{selectedFile.name}</p>
                    <p className="text-sm text-gray-400">
                      {formatBytes(selectedFile.size)}
                    </p>
                  </div>
                  {!isUploading && (
                    <button
                      onClick={() => setSelectedFile(null)}
                      className="text-gray-400 hover:text-white"
                    >
                      <Trash2 className="w-5 h-5" />
                    </button>
                  )}
                </div>

                <div>
                  <label className="label">Title</label>
                  <input
                    type="text"
                    value={uploadTitle}
                    onChange={(e) => setUploadTitle(e.target.value)}
                    className="input"
                    disabled={isUploading}
                  />
                </div>

                <div>
                  <label className="label">Description (optional)</label>
                  <textarea
                    value={uploadDescription}
                    onChange={(e) => setUploadDescription(e.target.value)}
                    className="input"
                    rows={3}
                    disabled={isUploading}
                  />
                </div>

                {uploadError && (
                  <div className="p-3 bg-red-500/20 border border-red-500/50 rounded-lg text-red-400 text-sm">
                    {uploadError}
                    <button
                      onClick={() => startTusUpload()}
                      className="ml-2 underline hover:no-underline"
                    >
                      Retry
                    </button>
                  </div>
                )}

                {isUploading && (
                  <div className="space-y-2">
                    <div className="flex justify-between text-sm">
                      <span className="flex items-center gap-2">
                        {isPaused ? (
                          <>
                            <Pause className="w-4 h-4 text-yellow-400" />
                            Paused
                          </>
                        ) : (
                          <>
                            <Loader2 className="w-4 h-4 animate-spin" />
                            Uploading...
                          </>
                        )}
                      </span>
                      <span>{uploadProgress}% {uploadSpeed && `(${uploadSpeed})`}</span>
                    </div>
                    <div className="h-3 bg-gray-700 rounded-full overflow-hidden">
                      <div
                        className={`h-full transition-all ${isPaused ? 'bg-yellow-500' : 'bg-primary-500'}`}
                        style={{ width: `${uploadProgress}%` }}
                      />
                    </div>
                    <div className="flex gap-2 justify-center mt-2">
                      {isPaused ? (
                        <button
                          onClick={resumeUpload}
                          className="btn btn-secondary flex items-center gap-2"
                        >
                          <RotateCcw className="w-4 h-4" />
                          Resume
                        </button>
                      ) : (
                        <button
                          onClick={pauseUpload}
                          className="btn btn-secondary flex items-center gap-2"
                        >
                          <Pause className="w-4 h-4" />
                          Pause
                        </button>
                      )}
                      <button
                        onClick={cancelUpload}
                        className="btn btn-secondary flex items-center gap-2 text-red-400"
                      >
                        <X className="w-4 h-4" />
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            <div className="flex justify-end gap-3 mt-6">
              <button
                onClick={() => {
                  if (isUploading) {
                    cancelUpload();
                  }
                  setShowUpload(false);
                  setSelectedFile(null);
                  setUploadError(null);
                }}
                className="btn btn-secondary"
                disabled={isUploading && !isPaused}
              >
                Cancel
              </button>
              {!isUploading && (
                <button
                  onClick={startTusUpload}
                  disabled={!selectedFile || !uploadTitle}
                  className="btn btn-primary"
                >
                  Upload
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* VOD Grid */}
      {isLoading ? (
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-500"></div>
        </div>
      ) : files.length === 0 ? (
        <div className="card text-center py-12">
          <Film className="w-12 h-12 text-gray-600 mx-auto mb-4" />
          <h3 className="text-lg font-medium mb-2">No videos yet</h3>
          <p className="text-gray-400 mb-4">
            {canUpload ? 'Upload your first video to get started' : 'No videos available'}
          </p>
          {canUpload && (
            <button onClick={() => setShowUpload(true)} className="btn btn-primary">
              Upload Video
            </button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {files.map((file: any) => (
            <div key={file.id} className="card p-0 overflow-hidden">
              {/* Thumbnail */}
              <div className="aspect-video bg-gray-900 relative">
                {file.thumbnail_url ? (
                  <img
                    src={file.thumbnail_url}
                    alt={file.title}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center">
                    <Film className="w-12 h-12 text-gray-700" />
                  </div>
                )}

                {/* Status Badge */}
                {file.status !== 'ready' && (
                  <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
                    {file.status === 'processing' || file.status === 'recording' ? (
                      <div className="flex items-center gap-2 text-yellow-400">
                        <Loader2 className="w-5 h-5 animate-spin" />
                        <span>{file.status === 'recording' ? 'Recording...' : 'Processing...'}</span>
                      </div>
                    ) : (
                      <span className="text-red-400">Failed</span>
                    )}
                  </div>
                )}

                {/* Duration */}
                {file.duration_seconds && (
                  <span className="absolute bottom-2 right-2 px-2 py-1 bg-black/80 rounded text-xs">
                    {formatDuration(file.duration_seconds)}
                  </span>
                )}
              </div>

              {/* Info */}
              <div className="p-4">
                <h3 className="font-medium mb-2 truncate">{file.title}</h3>
                <div className="flex items-center gap-4 text-sm text-gray-400">
                  {file.file_size_bytes && (
                    <span className="flex items-center gap-1">
                      <HardDrive className="w-4 h-4" />
                      {formatBytes(file.file_size_bytes)}
                    </span>
                  )}
                  <span className="flex items-center gap-1">
                    <Clock className="w-4 h-4" />
                    {new Date(file.created_at).toLocaleDateString()}
                  </span>
                </div>

                {/* Actions */}
                <div className="flex gap-2 mt-4">
                  {file.status === 'ready' && (
                    <>
                      <button
                        onClick={() => playVideo(file)}
                        className="btn btn-secondary flex-1 flex items-center justify-center gap-2"
                      >
                        <Play className="w-4 h-4" />
                        Play
                      </button>
                      <button
                        onClick={() => downloadVideo(file)}
                        className="p-2 text-gray-400 hover:text-green-400 hover:bg-green-500/10 rounded-lg"
                        title="Download video"
                      >
                        <Download className="w-5 h-5" />
                      </button>
                    </>
                  )}
                  <button
                    onClick={() => openEditModal(file)}
                    className="p-2 text-gray-400 hover:text-primary-400 hover:bg-primary-500/10 rounded-lg"
                    title="Edit title"
                  >
                    <Edit2 className="w-5 h-5" />
                  </button>
                  <button
                    onClick={() => {
                      if (confirm('Delete this video?')) {
                        deleteMutation.mutate(file.id);
                      }
                    }}
                    className="p-2 text-gray-400 hover:text-red-400 hover:bg-red-500/10 rounded-lg"
                  >
                    <Trash2 className="w-5 h-5" />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
