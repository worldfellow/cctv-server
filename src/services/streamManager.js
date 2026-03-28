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

        this.wsPort = 9999;
        this.CONNECTION_TIMEOUT = 30000;
        this.MAX_STREAMS = 25; // Safety limit for 2GB RAM
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

        // Update last accessed time to prevent idle cleanup
        if (this.cameras.has(cameraKey)) {
            this.cameras.get(cameraKey).lastAccessed = new Date();
            return this.wsPort;
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
                };
                this.rtspSources.set(sourceKey, source);

                const ffmpegArgs = [
                    '-rtsp_transport', 'tcp',
                    '-i', rtspUrl,
                    '-f', 'mpegts',
                    '-codec:v', 'mpeg1video',
                    '-preset', 'ultrafast', // Optimized for your 2-CPU VM
                    '-tune', 'zerolatency',
                    '-bf', '0',
                    '-threads', '2', // Lock to VM core count
                    '-an'
                ];

                if (quality === 'low') {
                    ffmpegArgs.push('-s', '320x240', '-r', '20', '-b:v', '600k', '-maxrate', '600k', '-bufsize', '1200k', '-q:v', '6');
                } else if (quality === 'ultra') {
                    ffmpegArgs.push('-s', '1920x1080', '-r', '25', '-b:v', '6000k', '-maxrate', '8000k', '-bufsize', '12000k');
                } else {
                    ffmpegArgs.push('-s', '1280x720', '-r', '20', '-b:v', '2000k', '-maxrate', '2500k', '-bufsize', '4000k');
                }

                ffmpegArgs.push('-');

                const ffmpeg = spawn(ffmpegPath, ffmpegArgs, { detached: false });
                source.ffmpeg = ffmpeg;

                ffmpeg.stdout.on('data', (data) => {
                    source.inputStreamStarted = true;
                    // Broadcast directly to all camera clients sharing this source
                    for (const camKey of source.cameras) {
                        const cameraClients = this.clients.get(camKey);
                        if (cameraClients && cameraClients.size > 0) {
                            cameraClients.forEach(client => {
                                if (client.readyState === WebSocket.OPEN) {
                                    client.send(data, { binary: true });
                                }
                            });
                        }
                    }
                });

                ffmpeg.stderr.on('data', (data) => {
                    if (!source.inputStreamStarted) {
                        const str = data.toString();
                        const sizeMatch = str.match(/(\d{2,5})x(\d{2,5})/);
                        if (sizeMatch) {
                            source.width = parseInt(sizeMatch[1], 10);
                            source.height = parseInt(sizeMatch[2], 10);
                        }
                    }
                });

                ffmpeg.on('exit', () => this.handleFFmpegExit(sourceKey));
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

    handleFFmpegExit(sourceKey) {
        const source = this.rtspSources.get(sourceKey);
        if (!source) return;

        console.log(`[StreamManager] FFmpeg exited for ${sourceKey}. Attempting recovery if clients active...`);

        // Check if any clients are still watching cameras on this source
        const hasClients = Array.from(source.cameras).some(camKey => {
            const clients = this.clients.get(camKey);
            return clients && clients.size > 0;
        });

        this.rtspSources.delete(sourceKey);

        if (hasClients) {
            setTimeout(() => {
                for (const camKey of source.cameras) {
                    const cam = this.cameras.get(camKey);
                    if (cam) {
                        this.cameras.delete(camKey);
                        const cameraId = camKey.split('_')[0];
                        const quality = camKey.split('_')[1];
                        this.startStream(cameraId, cam.rtspUrl, quality);
                    }
                }
            }, 2000);
        } else {
            this._killSource(sourceKey);
        }
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
