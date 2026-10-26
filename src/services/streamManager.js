const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const WebSocket = require('ws');

const STREAM_MAGIC_BYTES = 'jsmp';
const DEFAULT_WIDTH = 640;
const DEFAULT_HEIGHT = 480;

class StreamManager {
    constructor() {
        // Map<cameraKey, { rtspUrl, lastAccessed, checkTimeout }>
        this.cameras = new Map();

        // Map<rtspUrl_quality, { ffmpeg, width, height, cameraKeys: Set<string>, inputStreamStarted: boolean }>
        this.rtspSources = new Map();

        // Map<cameraKey, Set<WebSocket>> clients
        this.clients = new Map();

        // Map<sourceKey, number> consecutive FFmpeg restarts, for backoff
        this.retryCounts = new Map();

        this.wsPort = 9999;
        this.CONNECTION_TIMEOUT = 30000;
        this.MAX_STREAMS = 25; // Safety limit for 2GB RAM
        // A viewer whose socket has more than this queued is too slow: drop data for it instead of
        // buffering, so its delay can't keep growing and it doesn't eat server memory
        this.MAX_CLIENT_BUFFER = 1024 * 1024;
        // Gap between FFmpeg spawns so opening a page of cameras doesn't spike the CPU all at once
        this.SPAWN_GAP_MS = 200;
        this.VIEWER_GRACE_MS = 30000;
        this.nextSpawnAt = 0;
    }

    attach(server) {
        this.wsServer = new WebSocket.Server({ noServer: true });
        console.log(`[StreamManager] WebSocket multiplexer attached to server (Single Process)`);

        server.on('upgrade', (request, socket, head) => {
            const pathname = request.url.split('?')[0];
            if (pathname.includes('/stream/')) {
                this.wsServer.handleUpgrade(request, socket, head, (ws) => {
                    this.wsServer.emit('connection', ws, request);
                });
            }
        });

        this.wsServer.on('connection', (socket, req) => {
            const cameraKey = req.url.split('?')[0].split('/stream/')[1]?.replace(/^\//, '');
            if (!cameraKey) {
                socket.close();
                return;
            }

            console.log(`[StreamManager] Client connecting: ${cameraKey}`);
            if (socket._socket) socket._socket.setNoDelay(true);

            if (!this.clients.has(cameraKey)) {
                this.clients.set(cameraKey, new Set());
            }
            const cameraClients = this.clients.get(cameraKey);
            cameraClients.add(socket);

            // Send JSMpeg header
            const header = Buffer.alloc(8);
            header.write(STREAM_MAGIC_BYTES);
            header.writeUInt16BE(DEFAULT_WIDTH, 4);
            header.writeUInt16BE(DEFAULT_HEIGHT, 6);
            socket.send(header, { binary: true });

            socket.on('close', () => {
                cameraClients.delete(socket);
                console.log(`[StreamManager] Client disconnected: ${cameraKey}. Active clients: ${cameraClients.size}`);
                if (cameraClients.size === 0) {
                    this.clients.delete(cameraKey);
                    // HD/Ultra encoding is CPU-heavy: stop it soon after the last viewer leaves
                    // (e.g. after switching quality) so it doesn't slow down the stream being watched
                    if (!cameraKey.endsWith('_low')) {
                        setTimeout(() => {
                            const current = this.clients.get(cameraKey);
                            const cam = this.cameras.get(cameraKey);
                            // Skip if someone requested this stream again in the meantime
                            const recentlyRequested = cam && Date.now() - cam.lastAccessed < this.VIEWER_GRACE_MS;
                            if ((!current || current.size === 0) && !recentlyRequested) this.stopStream(cameraKey);
                        }, this.VIEWER_GRACE_MS);
                    }
                }
            });
        });
    }

    /**
     * Start a stream.
     */
    startStream(cameraId, rtspUrl, quality = 'high') {
        const sourceKey = `${rtspUrl}_${quality}`;
        const cameraKey = `${cameraId}_${quality}`;

        if (!rtspUrl) {
            console.warn(`[StreamManager] No RTSP link for camera ${cameraId}, stream not started`);
            return null;
        }

        // Update last accessed time to prevent idle cleanup
        const existing = this.cameras.get(cameraKey);
        if (existing) {
            if (existing.sourceKey === sourceKey && this.rtspSources.has(sourceKey)) {
                existing.lastAccessed = new Date();
                return this.wsPort;
            }
            // Stale entry (source gone or RTSP link changed): start fresh
            this.stopStream(cameraKey);
        }

        console.log(`[StreamManager] INITIALIZING camera ${cameraId} with quality ${quality}`);

        // Eviction Logic for 2-CPU / 2GB RAM environment
        if (this.rtspSources.size >= this.MAX_STREAMS && !this.rtspSources.has(sourceKey)) {
            let oldestKey = null;
            let oldestDate = new Date();
            
            // Prioritize evicting streams with NO current clients
            for (const [key, cam] of this.cameras.entries()) {
                const clients = this.clients.get(key);
                if (!clients || clients.size === 0) {
                   if (cam.lastAccessed < oldestDate) {
                        oldestDate = cam.lastAccessed;
                        oldestKey = key;
                   }
                }
            }

            if (oldestKey) {
                console.warn(`[StreamManager] Max streams reached. Evicting idle stream: ${oldestKey}`);
                this.stopStream(oldestKey);
            }
        }

        try {
            const cameraData = {
                rtspUrl: rtspUrl,
                sourceKey: sourceKey,
                lastAccessed: new Date(),
                checkTimeout: null
            };
            this.cameras.set(cameraKey, cameraData);

            let source = this.rtspSources.get(sourceKey);
            if (source) {
                source.cameras.add(cameraKey);
            } else {
                console.log(`[StreamManager] Spawning new FFmpeg for ${sourceKey.split('@')[1] || sourceKey}`);
                source = {
                    ffmpeg: null,
                    width: quality === 'ultra' ? 1920 : (quality === 'low' ? 640 : 1280),
                    height: quality === 'ultra' ? 1080 : (quality === 'low' ? 480 : 720),
                    cameras: new Set([cameraKey]),
                    inputStreamStarted: false,
                    // About 3-5 seconds of video at this quality's bitrate
                    maxClientBuffer: quality === 'ultra' ? 6 * 1024 * 1024 : (quality === 'low' ? this.MAX_CLIENT_BUFFER : 3 * 1024 * 1024),
                };
                this.rtspSources.set(sourceKey, source);

                const ffmpegArgs = [
                    '-loglevel', 'error',
                    '-rtsp_transport', 'tcp',
                    '-timeout', '10000000', // Give up on a camera that stops answering (10s, in microseconds)
                    // Low-latency input: don't buffer, probe the stream for 1s instead of the default 5s
                    '-fflags', 'nobuffer',
                    '-flags', 'low_delay',
                    '-probesize', '1000000',
                    '-analyzeduration', '1000000',
                    '-i', rtspUrl,
                    '-f', 'mpegts',
                    '-codec:v', 'mpeg1video',
                    '-bf', '0',
                    '-threads', quality === 'low' ? '1' : '2', // Small dashboard streams don't need both cores
                    '-flush_packets', '1',
                    '-an'
                ];

                if (quality === 'low') {
                    ffmpegArgs.push('-s', '320x240', '-r', '20', '-b:v', '600k', '-maxrate', '600k', '-bufsize', '1200k', '-q:v', '6');
                } else {
                    // MPEG-1 needs about twice the bitrate of H.264 for a clean picture.
                    // Scale by height keeping the camera's aspect ratio, never upscaling a smaller source.
                    // 25fps (20 isn't a valid MPEG-1 rate), one keyframe per second for quick recovery.
                    const [height, bitrate, maxrate, bufsize] = quality === 'ultra'
                        ? [1080, '9000k', '11000k', '18000k']
                        : [720, '4500k', '5500k', '9000k'];
                    ffmpegArgs.push(
                        '-vf', `scale=-2:min(${height}\\,ih)`,
                        '-r', '25', '-g', '25',
                        '-b:v', bitrate, '-maxrate', maxrate, '-bufsize', bufsize
                    );
                }

                ffmpegArgs.push('-');

                // Spawn in the background, spaced out, so the HTTP request returns immediately
                const now = Date.now();
                const delay = Math.max(0, this.nextSpawnAt - now);
                this.nextSpawnAt = now + delay + this.SPAWN_GAP_MS;
                setTimeout(() => {
                    // The stream may have been stopped while waiting its turn
                    if (this.rtspSources.get(sourceKey) !== source) return;
                    this._spawnFFmpeg(sourceKey, source, ffmpegArgs);
                }, delay);
            }

            cameraData.checkTimeout = setTimeout(() => {
                const s = this.rtspSources.get(sourceKey);
                if (!s || !s.inputStreamStarted) this.stopStream(cameraKey);
            }, this.CONNECTION_TIMEOUT);

            return this.wsPort;
        } catch (error) {
            console.error(`[StreamManager] startStream error:`, error);
            throw error;
        }
    }

    _spawnFFmpeg(sourceKey, source, ffmpegArgs) {
        const ffmpeg = spawn(ffmpegPath, ffmpegArgs, { detached: false });
        source.ffmpeg = ffmpeg;

        ffmpeg.stdout.on('data', (data) => {
            if (!source.inputStreamStarted) {
                source.inputStreamStarted = true;
                this.retryCounts.delete(sourceKey);
            }
            // Broadcast directly to all camera clients sharing this source
            for (const camKey of source.cameras) {
                const cameraClients = this.clients.get(camKey);
                if (cameraClients && cameraClients.size > 0) {
                    cameraClients.forEach(client => {
                        // Skip slow viewers until their socket drains, so one slow viewer doesn't build up lag
                        if (client.readyState === WebSocket.OPEN && client.bufferedAmount < source.maxClientBuffer) {
                            client.send(data, { binary: true });
                        }
                    });
                }
            }
        });

        ffmpeg.stderr.on('data', (data) => {
            if (!source.inputStreamStarted) {
                console.warn(`[StreamManager] FFmpeg ${sourceKey.split('@')[1] || sourceKey}: ${data.toString().trim()}`);
            }
        });

        ffmpeg.on('error', (err) => console.error(`[StreamManager] FFmpeg spawn error:`, err.message));
        ffmpeg.on('exit', () => this.handleFFmpegExit(sourceKey, source));
    }

    handleFFmpegExit(sourceKey, exitedSource) {
        const source = this.rtspSources.get(sourceKey);
        // Ignore exits of a process that was already replaced or killed
        if (!source || source !== exitedSource) return;

        console.log(`[StreamManager] FFmpeg exited for ${sourceKey.split('@')[1] || sourceKey}. Attempting recovery if clients active...`);

        // Check if any clients are still watching cameras on this source
        const hasClients = Array.from(source.cameras).some(camKey => {
            const clients = this.clients.get(camKey);
            return clients && clients.size > 0;
        });

        if (!hasClients) {
            this.retryCounts.delete(sourceKey);
            this._killSource(sourceKey);
            return;
        }

        // Keep viewers connected; drop the dead source and retry with backoff (2s, 4s, 8s ... max 30s)
        const retries = this.retryCounts.get(sourceKey) || 0;
        this.retryCounts.set(sourceKey, retries + 1);
        const delay = Math.min(30000, 2000 * Math.pow(2, retries));

        this.rtspSources.delete(sourceKey);
        const toRestart = [];
        for (const camKey of source.cameras) {
            const cam = this.cameras.get(camKey);
            if (cam) {
                if (cam.checkTimeout) clearTimeout(cam.checkTimeout);
                this.cameras.delete(camKey);
                toRestart.push({ camKey, rtspUrl: cam.rtspUrl });
            }
        }

        setTimeout(() => {
            for (const { camKey, rtspUrl } of toRestart) {
                const clients = this.clients.get(camKey);
                if (!clients || clients.size === 0) continue;
                const sep = camKey.lastIndexOf('_');
                this.startStream(camKey.slice(0, sep), rtspUrl, camKey.slice(sep + 1));
            }
        }, delay);
    }

    stopStream(cameraKey) {
        const cam = this.cameras.get(cameraKey);
        if (!cam) return;

        if (cam.checkTimeout) clearTimeout(cam.checkTimeout);

        const sourceKey = cam.sourceKey;
        this.cameras.delete(cameraKey);

        const source = this.rtspSources.get(sourceKey);
        if (source) {
            source.cameras.delete(cameraKey);
            if (source.cameras.size === 0) this._killSource(sourceKey);
        }
    }

    restartStream(cameraId, rtspUrl, quality = 'high') {
        const cameraKey = `${cameraId}_${quality}`;
        console.log(`[StreamManager] RESTARTING stream for ${cameraKey}`);
        
        // Stop the existing stream for this camera key
        this.stopStream(cameraKey);
        
        // Wait a small bit and start it again
        return new Promise((resolve) => {
            setTimeout(() => {
                const wsPort = this.startStream(cameraId, rtspUrl, quality);
                resolve(wsPort);
            }, 1000);
        });
    }

    _killSource(sourceKey) {
        const source = this.rtspSources.get(sourceKey);
        if (!source) return;

        if (source.ffmpeg) {
            try { source.ffmpeg.kill('SIGTERM'); } catch (e) { }
        }

        for (const camKey of source.cameras) {
            const cam = this.cameras.get(camKey);
            if (cam && cam.checkTimeout) clearTimeout(cam.checkTimeout);
            this.cameras.delete(camKey);
            const clients = this.clients.get(camKey);
            if (clients) {
                clients.forEach(c => c.close());
                this.clients.delete(camKey);
            }
        }

        this.rtspSources.delete(sourceKey);
    }

    cleanupIdleStreams(timeoutMs = 15 * 60 * 1000) {
        const now = new Date();
        for (const [camKey, cam] of this.cameras.entries()) {
            const clients = this.clients.get(camKey);
            if (now - cam.lastAccessed > timeoutMs && (!clients || clients.size === 0)) {
                this.stopStream(camKey);
            }
        }
    }
}

const streamManager = new StreamManager();
setInterval(() => streamManager.cleanupIdleStreams(), 5 * 60 * 1000);

module.exports = streamManager;
