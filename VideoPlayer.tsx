import { useEffect, useRef, useState, useCallback } from 'react';
import Hls from 'hls.js';
import {
  Play,
  Eye,
  Pause,
  Volume2,
  VolumeX,
  Maximize,
  Minimize,
  Settings,
  Loader2,
  Cast,
  Airplay,
} from 'lucide-react';

interface VideoPlayerProps {
  streamKey: string;
  hlsUrl?: string;
  mp4Url?: string;
  title?: string;
  autoPlay?: boolean;
  muted?: boolean;
  isEmbed?: boolean;
  isVod?: boolean;
  isLinear?: boolean; // Linear TV mode - hides seek bar
}

export default function VideoPlayer({
  streamKey,
  hlsUrl,
  mp4Url,
  title,
  autoPlay = false,
  muted = false,
  isEmbed = false,
  isVod = false,
  isLinear = false,
}: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const controlsTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const userSelectedQualityRef = useRef<number | null>(null); // Track user's manual quality selection

  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(muted);
  const [volume, setVolume] = useState(1);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const [isLoading, setIsLoading] = useState(true);
  const [currentTime, setCurrentTime] = useState('00:00:00');
  const [duration, setDuration] = useState('00:00:00');
  const [progress, setProgress] = useState(0);
  const [qualities, setQualities] = useState<{ height: number; index: number }[]>([]);
  const [currentQuality, setCurrentQuality] = useState(-1);
  const [displayQuality, setDisplayQuality] = useState(-1); // What to show on gear icon (user's selection)
  const [showQualityMenu, setShowQualityMenu] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewerCount, setViewerCount] = useState<number>(0);
  const [isLive, setIsLive] = useState(!isVod);
  const [hasStarted, setHasStarted] = useState(false);
  const [isCasting, setIsCasting] = useState(false);
  const [airPlayAvailable, setAirPlayAvailable] = useState(false);
  const [useTranscodedStream, setUseTranscodedStream] = useState<boolean | null>(null); // null = checking, true/false = checked
  const [streamCheckDone, setStreamCheckDone] = useState(false);

  const formatTime = (seconds: number): string => {
    if (!isFinite(seconds) || isNaN(seconds)) return '00:00:00';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  // Check for AirPlay availability
  useEffect(() => {
    const video = videoRef.current;
    if (video && 'webkitShowPlaybackTargetPicker' in video) {
      setAirPlayAvailable(true);
    }
  }, []);

  // Initialize Chromecast
  useEffect(() => {
    if (typeof window !== 'undefined' && !document.getElementById('cast-sdk')) {
      const script = document.createElement('script');
      script.id = 'cast-sdk';
      script.src = 'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1';
      script.async = true;
      document.head.appendChild(script);

      script.onload = () => {
        (window as any)['__onGCastApiAvailable'] = (isAvailable: boolean) => {
          if (isAvailable) {
            initializeCastApi();
          }
        };
      };
    }
  }, []);

  const initializeCastApi = () => {
    const cast = (window as any).cast;
    const chrome = (window as any).chrome;

    if (cast && chrome?.cast) {
      cast.framework.CastContext.getInstance().setOptions({
        receiverApplicationId: chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
        autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED
      });
    }
  };

  // Track VOD view
  useEffect(() => {
    if (isVod && streamKey) {
      // streamKey contains the VOD ID for VOD embeds
      fetch(`/api/vod/${streamKey}/view`, { method: 'POST' }).catch(() => {});
    }
  }, [isVod, streamKey]);

  // Viewer tracking and count polling for live streams
  useEffect(() => {
    if (isVod || !streamKey) return;
    
    // Generate a unique viewer ID for this session
    const viewerId = sessionStorage.getItem('viewerId') || Math.random().toString(36).substring(2, 15);
    sessionStorage.setItem('viewerId', viewerId);
    
    const fetchViewerCount = async () => {
      try {
        const res = await fetch(`/api/streams/public/${streamKey}/viewers`);
        const data = await res.json();
        setViewerCount(data.viewers || 0);
      } catch (err) {
        // Silently fail
      }
    };
    
    const sendHeartbeat = async () => {
      try {
        await fetch(`/api/streams/public/${streamKey}/heartbeat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ viewerId })
        });
      } catch (err) {
        // Silently fail
      }
    };
    
    // Fetch count and send heartbeat immediately
    fetchViewerCount();
    sendHeartbeat();
    
    // Poll viewer count every 10 seconds
    const countInterval = setInterval(fetchViewerCount, 10000);
    
    // Send heartbeat every 15 seconds to stay registered
    const heartbeatInterval = setInterval(sendHeartbeat, 15000);
    
    return () => {
      clearInterval(countInterval);
      clearInterval(heartbeatInterval);
    };
  }, [streamKey, isVod]);

  // Check for transcoded stream availability (only for live streams)
  useEffect(() => {
    if (isVod || hlsUrl) {
      setStreamCheckDone(true);
      setUseTranscodedStream(false);
      return;
    }

    // Set a fast timeout - don't wait too long for transcoded check
    const timeoutId = setTimeout(() => {
      if (!streamCheckDone) {
        console.log('Stream check timeout, using original stream');
        setUseTranscodedStream(false);
        setStreamCheckDone(true);
      }
    }, 2000);

    // Try to fetch the transcoded master playlist
    const transcodedUrl = `/live-hq/${streamKey}/master.m3u8`;
    fetch(transcodedUrl, { method: 'HEAD' })
      .then(res => {
        clearTimeout(timeoutId);
        setUseTranscodedStream(res.ok);
        setStreamCheckDone(true);
      })
      .catch(() => {
        clearTimeout(timeoutId);
        // Transcoded stream not available, use original
        setUseTranscodedStream(false);
        setStreamCheckDone(true);
      });
    
    return () => clearTimeout(timeoutId);
  }, [streamKey, isVod, hlsUrl]);

  // Initialize HLS player - wait until stream check is done
  useEffect(() => {
    if (!videoRef.current || !streamCheckDone) return;

    const video = videoRef.current;

    // If mp4Url is provided, use direct MP4 playback (no HLS needed)
    if (mp4Url) {
      console.log('Using direct MP4 playback:', mp4Url);
      video.src = mp4Url;
      video.load();
      setIsLoading(false);
      if (autoPlay) {
        video.play().catch(() => {});
      }
      return;
    }

    // Use transcoded stream if available, otherwise fall back to original
    const sourceUrl = hlsUrl || (useTranscodedStream ? `/live-hq/${streamKey}/master.m3u8` : `/live/${streamKey}.m3u8`);
    console.log('Using stream URL:', sourceUrl, 'Transcoded:', useTranscodedStream);

    // Preload the manifest as soon as possible
    const preloadLink = document.createElement('link');
    preloadLink.rel = 'preload';
    preloadLink.href = sourceUrl;
    preloadLink.as = 'fetch';
    preloadLink.crossOrigin = 'anonymous';
    document.head.appendChild(preloadLink);

    if (Hls.isSupported()) {
      // Detect mobile for aggressive optimization
      const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);

      const hlsConfig: Partial<Hls['config']> = {
        enableWorker: true,
        // Minimal initial buffer for instant start
        maxBufferLength: isMobile ? 10 : 30,
        maxMaxBufferLength: isMobile ? 30 : 60,
        maxBufferSize: isMobile ? 30 * 1000 * 1000 : 60 * 1000 * 1000, // 30MB mobile, 60MB desktop
        backBufferLength: isMobile ? 10 : 30,
        maxBufferHole: 0.5,
        // Start with lowest quality for instant playback
        startLevel: 0,
        // Lower bandwidth estimate for faster initial load
        abrEwmaDefaultEstimate: isMobile ? 300000 : 500000, // 300kbps mobile, 500kbps desktop
        abrEwmaFastLive: 3.0,
        abrEwmaSlowLive: 9.0,
        abrBandWidthFactor: 0.8, // Be conservative with bandwidth
        abrBandWidthUpFactor: 0.5, // Slower quality upgrade
        // Enable prefetching
        startFragPrefetch: true,
        testBandwidth: true,
        // Fast retry settings for mobile networks
        fragLoadingMaxRetry: 10,
        manifestLoadingMaxRetry: 10,
        levelLoadingMaxRetry: 6,
        fragLoadingRetryDelay: 300,
        manifestLoadingRetryDelay: 300,
        levelLoadingRetryDelay: 300,
        // Progressive loading for faster start
        progressive: true,
        // Lower initial fragment load time target
        fragLoadingTimeOut: isMobile ? 10000 : 20000,
        manifestLoadingTimeOut: isMobile ? 8000 : 10000,
        levelLoadingTimeOut: isMobile ? 8000 : 10000,
      };

      if (isVod) {
        hlsConfig.lowLatencyMode = false;
        hlsConfig.liveDurationInfinity = false;
        hlsConfig.startLevel = -1; // Auto for VOD
      } else {
        hlsConfig.lowLatencyMode = false;
        hlsConfig.liveSyncDurationCount = 2; // Reduced for faster sync
        hlsConfig.liveMaxLatencyDurationCount = 4;
        hlsConfig.liveDurationInfinity = true;
        hlsConfig.liveBackBufferLength = 30;
      }

      const hls = new Hls(hlsConfig as any);
      hlsRef.current = hls;

      hls.on(Hls.Events.MANIFEST_PARSED, (_, data) => {
        setIsLoading(false);
        setError(null);

        const levels = data.levels.map((level, index) => ({
          height: level.height,
          index,
        }));
        setQualities(levels);

        if (autoPlay) {
          video.muted = muted;
          video.play().then(() => {
            setHasStarted(true);
            setIsPlaying(true);
          }).catch(() => {
            video.muted = true;
            setIsMuted(true);
            video.play().then(() => {
              setHasStarted(true);
              setIsPlaying(true);
            }).catch(() => {
              setIsPlaying(false);
              setHasStarted(false);
            });
          });
        }
      });

      hls.on(Hls.Events.LEVEL_SWITCHED, (_, data) => {
        // Only update from LEVEL_SWITCHED if user hasn't manually selected a quality
        // or if the switched level matches what the user selected
        if (userSelectedQualityRef.current === null || userSelectedQualityRef.current === -1) {
          setCurrentQuality(data.level);
        }
      });

      let networkErrorCount = 0;
      const maxNetworkRetries = 10; // Increased for stream startup

      hls.on(Hls.Events.ERROR, (_, data) => {
        if (data.fatal) {
          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              networkErrorCount++;
              console.log('HLS network error, retry ' + networkErrorCount + '/' + maxNetworkRetries);
              if (networkErrorCount < maxNetworkRetries) {
                // Don't show error yet, just retry silently with increasing delay
                const retryDelay = Math.min(1000 * networkErrorCount, 5000);
                setIsLoading(true);
                setTimeout(() => {
                  hls.loadSource(sourceUrl);
                  hls.startLoad();
                }, retryDelay);
              } else {
                setError('Stream starting up... Please wait or refresh');
                setIsLoading(false);
              }
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              hls.recoverMediaError();
              break;
            default:
              // For other errors, also retry a few times before giving up
              networkErrorCount++;
              if (networkErrorCount < 3) {
                setTimeout(() => {
                  hls.loadSource(sourceUrl);
                  hls.startLoad();
                }, 2000);
              } else {
                setError('Video unavailable');
                hls.destroy();
              }
              break;
          }
        }
      });

      hls.on(Hls.Events.FRAG_LOADED, () => {
        // Clear any error when we successfully load fragments
        networkErrorCount = 0;
        setError(null);
        if (!isVod) {
          setIsLive(true);
        }
        setIsLoading(false);
      });

      hls.on(Hls.Events.MANIFEST_LOADED, () => {
        // Clear error when manifest loads successfully
        networkErrorCount = 0;
        setError(null);
      });

      hls.loadSource(sourceUrl);
      hls.attachMedia(video);

      return () => {
        hls.destroy();
        hlsRef.current = null;
      };
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = sourceUrl;
      video.addEventListener('loadedmetadata', () => {
        setIsLoading(false);
        setQualities([{ height: 1080, index: 0 }]);
        if (autoPlay) {
          video.muted = muted;
          video.play().then(() => {
            setHasStarted(true);
            setIsPlaying(true);
          }).catch(() => {
            video.muted = true;
            setIsMuted(true);
            video.play().catch(() => {
              setIsPlaying(false);
              setHasStarted(false);
            });
          });
        }
      });
    }
  }, [streamKey, hlsUrl, mp4Url, autoPlay, muted, isVod, useTranscodedStream, streamCheckDone]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const handlePlay = () => {
      setIsPlaying(true);
      setHasStarted(true);
    };
    const handlePause = () => setIsPlaying(false);
    const handleWaiting = () => setIsLoading(true);
    const handlePlaying = () => {
      setIsLoading(false);
      setHasStarted(true);
    };
    const handleTimeUpdate = () => {
      setCurrentTime(formatTime(video.currentTime));
      if (isVod && video.duration) {
        setProgress((video.currentTime / video.duration) * 100);
      }
    };
    const handleDurationChange = () => {
      if (isVod && video.duration) {
        setDuration(formatTime(video.duration));
      }
    };
    const handleLoadedMetadata = () => {
      if (isVod && video.duration) {
        setDuration(formatTime(video.duration));
      }
    };

    video.addEventListener('play', handlePlay);
    video.addEventListener('pause', handlePause);
    video.addEventListener('waiting', handleWaiting);
    video.addEventListener('playing', handlePlaying);
    video.addEventListener('timeupdate', handleTimeUpdate);
    video.addEventListener('durationchange', handleDurationChange);
    video.addEventListener('loadedmetadata', handleLoadedMetadata);

    return () => {
      video.removeEventListener('play', handlePlay);
      video.removeEventListener('pause', handlePause);
      video.removeEventListener('waiting', handleWaiting);
      video.removeEventListener('playing', handlePlaying);
      video.removeEventListener('timeupdate', handleTimeUpdate);
      video.removeEventListener('durationchange', handleDurationChange);
      video.removeEventListener('loadedmetadata', handleLoadedMetadata);
    };
  }, [isVod]);

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(
        !!(document.fullscreenElement ||
           (document as any).webkitFullscreenElement ||
           (document as any).msFullscreenElement)
      );
    };

    const video = videoRef.current;
    const handleVideoFullscreen = () => {
      setIsFullscreen(true);
    };
    const handleVideoExitFullscreen = () => {
      setIsFullscreen(false);
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
    document.addEventListener('MSFullscreenChange', handleFullscreenChange);

    if (video) {
      video.addEventListener('webkitbeginfullscreen', handleVideoFullscreen);
      video.addEventListener('webkitendfullscreen', handleVideoExitFullscreen);
    }

    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      document.removeEventListener('webkitfullscreenchange', handleFullscreenChange);
      document.removeEventListener('MSFullscreenChange', handleFullscreenChange);
      if (video) {
        video.removeEventListener('webkitbeginfullscreen', handleVideoFullscreen);
        video.removeEventListener('webkitendfullscreen', handleVideoExitFullscreen);
      }
    };
  }, []);

  const showControlsTemporarily = useCallback(() => {
    setShowControls(true);
    if (controlsTimeoutRef.current) {
      clearTimeout(controlsTimeoutRef.current);
    }
    controlsTimeoutRef.current = setTimeout(() => {
      if (isPlaying) {
        setShowControls(false);
        setShowQualityMenu(false);
      }
    }, 3000);
  }, [isPlaying]);

  const togglePlay = useCallback(() => {
    if (videoRef.current) {
      if (isPlaying) {
        videoRef.current.pause();
      } else {
        videoRef.current.play().then(() => {
          setHasStarted(true);
        }).catch(console.error);
      }
    }
  }, [isPlaying]);

  const toggleMute = () => {
    if (videoRef.current) {
      videoRef.current.muted = !isMuted;
      setIsMuted(!isMuted);
      if (isMuted) {
        setVolume(videoRef.current.volume || 1);
      }
    }
  };

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newVolume = parseFloat(e.target.value);
    if (videoRef.current) {
      videoRef.current.volume = newVolume;
      videoRef.current.muted = newVolume === 0;
      setVolume(newVolume);
      setIsMuted(newVolume === 0);
    }
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (videoRef.current && isVod) {
      const newTime = (parseFloat(e.target.value) / 100) * videoRef.current.duration;
      videoRef.current.currentTime = newTime;
      setProgress(parseFloat(e.target.value));
    }
  };

  const toggleFullscreen = () => {
    const video = videoRef.current as HTMLVideoElement & {
      webkitEnterFullscreen?: () => void;
      requestFullscreen?: () => Promise<void>;
    };
    const container = containerRef.current;

    if (!container || !video) return;

    if (!isFullscreen) {
      if (video.webkitEnterFullscreen) {
        video.webkitEnterFullscreen();
      } else if (video.requestFullscreen) {
        video.requestFullscreen().catch(() => {
          if (container.requestFullscreen) {
            container.requestFullscreen();
          } else if ((container as any).webkitRequestFullscreen) {
            (container as any).webkitRequestFullscreen();
          } else if ((container as any).msRequestFullscreen) {
            (container as any).msRequestFullscreen();
          }
        });
      } else if ((container as any).webkitRequestFullscreen) {
        (container as any).webkitRequestFullscreen();
      } else if ((container as any).msRequestFullscreen) {
        (container as any).msRequestFullscreen();
      }
    } else {
      if (document.exitFullscreen) {
        document.exitFullscreen();
      } else if ((document as any).webkitExitFullscreen) {
        (document as any).webkitExitFullscreen();
      } else if ((document as any).msExitFullscreen) {
        (document as any).msExitFullscreen();
      }
    }
  };

  const changeQuality = (levelIndex: number) => {
    if (hlsRef.current) {
      hlsRef.current.nextLevel = levelIndex;
      userSelectedQualityRef.current = levelIndex; // Track user's manual selection
      setCurrentQuality(levelIndex);
      setDisplayQuality(levelIndex); // Update what's shown on gear icon
    }
    setShowQualityMenu(false);
  };

  const jumpToLive = () => {
    if (videoRef.current && hlsRef.current) {
      videoRef.current.currentTime = videoRef.current.duration;
    }
  };

  const getQualityLabel = (height: number): string => {
    if (height >= 2160) return '4K';
    if (height >= 1440) return '1440p';
    if (height >= 1080) return '1080p';
    if (height >= 720) return '720p';
    if (height >= 480) return '480p';
    if (height >= 360) return '360p';
    return `${height}p`;
  };

  const handleBigPlayClick = useCallback(() => {
    if (videoRef.current) {
      videoRef.current.play().then(() => {
        setHasStarted(true);
        setIsPlaying(true);
      }).catch(console.error);
    }
  }, []);

  const handleCast = () => {
    const cast = (window as any).cast;
    if (cast?.framework) {
      const castContext = cast.framework.CastContext.getInstance();
      if (castContext.getCurrentSession()) {
        castContext.endCurrentSession(true);
        setIsCasting(false);
      } else {
        const sourceUrl = hlsUrl || (useTranscodedStream ? `/live-hq/${streamKey}/master.m3u8` : `/live/${streamKey}.m3u8`);
        castContext.requestSession().then(() => {
          setIsCasting(true);
          const session = castContext.getCurrentSession();
          const mediaInfo = new (window as any).chrome.cast.media.MediaInfo(
            `${window.location.origin}${sourceUrl}`,
            'application/x-mpegURL'
          );
          mediaInfo.metadata = new (window as any).chrome.cast.media.GenericMediaMetadata();
          mediaInfo.metadata.title = title || (isVod ? 'Video' : 'Live Stream');

          const request = new (window as any).chrome.cast.media.LoadRequest(mediaInfo);
          session.loadMedia(request);
        }).catch((err: any) => {
          console.log('Cast error:', err);
        });
      }
    } else {
      alert('Chromecast not available. Please use Chrome browser.');
    }
  };

  const handleAirPlay = () => {
    const video = videoRef.current;
    if (video && 'webkitShowPlaybackTargetPicker' in video) {
      (video as any).webkitShowPlaybackTargetPicker();
    }
  };

  return (
    <div
      ref={containerRef}
      className={`relative bg-black ${isEmbed ? 'w-full h-full' : 'aspect-video'} group`}
      onMouseMove={showControlsTemporarily}
      onMouseLeave={() => {
        if (isPlaying) {
          setShowControls(false);
          setShowQualityMenu(false);
        }
      }}
    >
      <video
        ref={videoRef}
        className="w-full h-full"
        playsInline
        webkit-playsinline="true"
        x5-playsinline="true"
        x5-video-player-type="h5"
        x5-video-player-fullscreen="true"
        preload="auto"
        onClick={togglePlay}
      />

      {isLoading && hasStarted && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/50">
          <Loader2 className="w-12 h-12 text-white animate-spin" />
        </div>
      )}

      {error && (
        <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-gray-900 via-gray-800 to-gray-900">
          <div className="text-center text-white p-8">
            {/* Offline/Signal Icon */}
            <div className="mb-6 relative">
              <div className="w-24 h-24 mx-auto rounded-full bg-gray-700/50 flex items-center justify-center">
                <svg className="w-12 h-12 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 10.5l4.72-4.72a.75.75 0 011.28.53v11.38a.75.75 0 01-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 002.25-2.25v-9a2.25 2.25 0 00-2.25-2.25h-9A2.25 2.25 0 002.25 7.5v9a2.25 2.25 0 002.25 2.25z" />
                </svg>
              </div>
              {/* Offline indicator */}
              <div className="absolute -bottom-1 left-1/2 -translate-x-1/2 bg-gray-600 px-3 py-1 rounded-full">
                <span className="text-xs font-medium text-gray-300 flex items-center gap-1">
                  <span className="w-2 h-2 bg-gray-400 rounded-full"></span>
                  OFFLINE
                </span>
              </div>
            </div>
            <h3 className="text-xl font-semibold mb-2">Stream Offline</h3>
            <p className="text-gray-400 mb-6 max-w-xs mx-auto">
              This stream is currently not available. Please check back later.
            </p>
            <button
              onClick={() => window.location.reload()}
              className="px-6 py-2.5 bg-red-600 rounded-lg hover:bg-red-700 transition-colors font-medium"
            >
              Refresh
            </button>
          </div>
        </div>
      )}

      {(!hasStarted || !isPlaying) && !isLoading && !error && (
        <div
          className="absolute inset-0 flex items-center justify-center cursor-pointer"
          onClick={handleBigPlayClick}
        >
          <div className="w-20 h-20 bg-red-600 rounded-full flex items-center justify-center hover:bg-red-700 transition-colors hover:scale-110">
            <Play className="w-10 h-10 text-white ml-1" fill="white" />
          </div>
        </div>
      )}

      <div
        className={`absolute inset-0 flex flex-col justify-end transition-opacity duration-300 ${
          showControls || !isPlaying ? 'opacity-100' : 'opacity-0'
        } pointer-events-none`}
      >
        <div className="absolute bottom-0 left-0 right-0 h-32 bg-gradient-to-t from-black/80 to-transparent" />

        {title && (
          <div className="absolute top-0 left-0 right-0 p-4 bg-gradient-to-b from-black/80 to-transparent">
            <h3 className="text-white font-semibold truncate">{title}</h3>
          </div>
        )}

        <div className="relative z-10 px-4 pb-4 pointer-events-auto">
          {/* Hide seek bar for Linear TV and live streams */}
          {isVod && !isLinear && (
            <div className="mb-2">
              <input
                type="range"
                min="0"
                max="100"
                step="0.1"
                value={progress}
                onChange={handleSeek}
                className="w-full h-1 bg-gray-600 rounded-lg appearance-none cursor-pointer accent-red-600"
                style={{
                  background: `linear-gradient(to right, #dc2626 0%, #dc2626 ${progress}%, #4b5563 ${progress}%, #4b5563 100%)`
                }}
              />
            </div>
          )}

          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              {!isVod && isLive && (
                <button
                  onClick={jumpToLive}
                  className="flex items-center gap-1 px-2 py-1 bg-red-600 text-white text-xs font-bold rounded hover:bg-red-700"
                >
                  <span className="w-2 h-2 bg-white rounded-full animate-pulse" />
                  LIVE
                </button>
              )}
              {!isVod && (
                <div className="flex items-center gap-1 text-white/80 text-sm">
                  <Eye className="w-4 h-4" />
                  <span>{viewerCount.toLocaleString()}</span>
                </div>
              )}
              <span className="text-white/80 text-sm">
                {isVod ? `${currentTime} / ${duration}` : currentTime}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={togglePlay}
              className="text-white hover:text-red-500 transition-colors"
              title={isPlaying ? 'Pause' : 'Play'}
            >
              {isPlaying ? (
                <Pause className="w-6 h-6" fill="currentColor" />
              ) : (
                <Play className="w-6 h-6" fill="currentColor" />
              )}
            </button>

            <div className="flex items-center gap-2 group/volume">
              <button
                onClick={toggleMute}
                className="text-white hover:text-red-500 transition-colors"
                title={isMuted ? 'Unmute' : 'Mute'}
              >
                {isMuted || volume === 0 ? (
                  <VolumeX className="w-6 h-6" />
                ) : (
                  <Volume2 className="w-6 h-6" />
                )}
              </button>
              <input
                type="range"
                min="0"
                max="1"
                step="0.1"
                value={isMuted ? 0 : volume}
                onChange={handleVolumeChange}
                className="w-0 group-hover/volume:w-20 transition-all duration-200 accent-red-600"
              />
            </div>

            <div className="flex-1" />

            <div className="relative">
              <button
                onClick={() => setShowQualityMenu(!showQualityMenu)}
                className="text-white hover:text-red-500 transition-colors flex items-center gap-1"
                title="Quality"
              >
                <Settings className="w-5 h-5" />
                <span className={`text-sm hidden sm:inline ${
                  displayQuality !== -1 && qualities.find(q => q.index === displayQuality)?.height >= 2160
                    ? 'text-red-500 font-semibold'
                    : ''
                }`}>
                  {displayQuality === -1
                    ? 'Auto'
                    : qualities.length > 0
                    ? getQualityLabel(qualities.find(q => q.index === displayQuality)?.height || 1080)
                    : 'HD'}
                </span>
              </button>

              {showQualityMenu && (
                <div className="absolute bottom-full right-0 mb-2 bg-gray-900/95 rounded-lg overflow-hidden min-w-[120px] shadow-lg">
                  <div className="px-3 py-2 text-xs text-gray-400 border-b border-gray-700">
                    Quality
                  </div>
                  <button
                    onClick={() => changeQuality(-1)}
                    className={`w-full px-4 py-2 text-left text-sm hover:bg-gray-700 flex items-center justify-between ${
                      displayQuality === -1 ? 'text-red-500' : 'text-white'
                    }`}
                  >
                    Auto
                    {displayQuality === -1 && <span className="text-xs">✓</span>}
                  </button>
                  {qualities.length > 0 ? (
                    [...qualities]
                      .sort((a, b) => b.height - a.height)
                      .map((q) => (
                        <button
                          key={q.index}
                          onClick={() => changeQuality(q.index)}
                          className={`w-full px-4 py-2 text-left text-sm hover:bg-gray-700 flex items-center justify-between ${
                            displayQuality === q.index ? 'text-red-500' : 'text-white'
                          }`}
                        >
                          {getQualityLabel(q.height)}
                          {displayQuality === q.index && <span className="text-xs">✓</span>}
                        </button>
                      ))
                  ) : (
                    <button
                      onClick={() => setShowQualityMenu(false)}
                      className="w-full px-4 py-2 text-left text-sm text-white hover:bg-gray-700"
                    >
                      1080p HD
                    </button>
                  )}
                </div>
              )}
            </div>

            <button
              onClick={handleCast}
              className={`text-white hover:text-red-500 transition-colors ${isCasting ? 'text-red-500' : ''}`}
              title="Cast to device"
            >
              <Cast className="w-5 h-5" />
            </button>

            {airPlayAvailable && (
              <button
                onClick={handleAirPlay}
                className="text-white hover:text-red-500 transition-colors"
                title="AirPlay"
              >
                <Airplay className="w-5 h-5" />
              </button>
            )}

            <button
              onClick={toggleFullscreen}
              className="text-white hover:text-red-500 transition-colors"
              title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
            >
              {isFullscreen ? (
                <Minimize className="w-6 h-6" />
              ) : (
                <Maximize className="w-6 h-6" />
              )}
            </button>
          </div>
        </div>
      </div>

      {isCasting && (
        <div className="absolute top-4 right-4 bg-black/80 px-3 py-1 rounded-full flex items-center gap-2">
          <Cast className="w-4 h-4 text-red-500" />
          <span className="text-white text-sm">Casting</span>
        </div>
      )}
    </div>
  );
}
