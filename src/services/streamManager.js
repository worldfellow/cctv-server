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
        this.CONNECTION_TIMEOUT = 15000;
    }

    attach(server) {
        this.wsServer = new WebSocket.Server({ noServer: true });
        console.log(`[StreamManager] WebSocket multiplexer attached to server`);

        server.on('upgrade', (request, socket, head) => {
            const pathname = request.url.split('?')[0];
            if (pathname.includes('/stream/')) {
                this.wsServer.handleUpgrade(request, socket, head, (ws) => {
                    this.wsServer.emit('connection', ws, request);
                });
            }
        });

        this.wsServer.on('connection', (socket, req) => {
            // Robustly extract cameraKey from req.url (e.g., "/api/stream/123_low" -> "123_low")
            const cameraKey = req.url.split('?')[0].split('/stream/')[1]?.replace(/^\//, ''); 
            if (!cameraKey) {
                console.warn(`[StreamManager] Rejected connection - no cameraKey in URL: ${req.url}`);
                socket.close();
                return;
            }

            console.log(`[StreamManager] Client connecting: ${cameraKey}`);

            if (!this.clients.has(cameraKey)) {
                this.clients.set(cameraKey, new Set());
            }
            const cameraClients = this.clients.get(cameraKey);
            cameraClients.add(socket);

            // Fetch state for this specific camera
            const camera = this.cameras.get(cameraKey);
            if (!camera) {
                console.warn(`[StreamManager] Client connected for UNKNOWN camera key: ${cameraKey}`);
            }

            const sourceKey = camera ? camera.sourceKey : null;
            const source = sourceKey ? this.rtspSources.get(sourceKey) : null;

            if (source) {
                console.log(`[StreamManager] Streaming started for existing source: ${sourceKey.split('@')[1] || sourceKey}`);
            }

            const header = Buffer.alloc(8);
            header.write(STREAM_MAGIC_BYTES);
            header.writeUInt16BE(source ? source.width : DEFAULT_WIDTH, 4);
            header.writeUInt16BE(source ? source.height : DEFAULT_HEIGHT, 6);
            socket.send(header, { binary: true });

            socket.on('close', () => {
                cameraClients.delete(socket);
                console.log(`[StreamManager] Client disconnected: ${cameraKey}. Remaining clients for key: ${cameraClients.size}`);
            });
        });
    }


    /**
     * Starts a stream for a specific camera.
     * Shares the ffmpeg process if another camera already uses the same RTSP URL and quality.
     */
    startStream(cameraId, rtspUrl, quality = 'high') {
        const sourceKey = `${rtspUrl}_${quality}`;
        const cameraKey = `${cameraId}_${quality}`;

        // 1. If camera already has a stream, refresh it and return port
        if (this.cameras.has(cameraKey)) {
            const existing = this.cameras.get(cameraKey);
            existing.lastAccessed = new Date();
            console.log(`[StreamManager] Camera ${cameraId} (${quality}) already active. Refreshing session.`);
            return this.wsPort;
        }

        console.log(`[StreamManager] INITIALIZING camera ${cameraId} with quality ${quality}`);

        try {
            const cameraData = {
                rtspUrl: rtspUrl,
                sourceKey: sourceKey,
                lastAccessed: new Date(),
                checkTimeout: null
            };
            this.cameras.set(cameraKey, cameraData);

            // 3. Handle RTSP source sharing based on URL + Quality
            let source = this.rtspSources.get(sourceKey);

            if (source) {
                console.log(`[StreamManager] Source sharing: camera ${cameraId} (${quality}) joining existing ffmpeg for ${sourceKey.split('@')[1] || sourceKey}`);
                source.cameras.add(cameraKey);
            } else {
                console.log(`[StreamManager] Source init: new ffmpeg for ${sourceKey.split('@')[1] || sourceKey} (${quality})`);

                source = {
                    ffmpeg: null,
                    width: quality === 'low' ? 640 : 1920,
                    height: quality === 'low' ? 480 : 1080,
                    cameras: new Set([cameraKey]),
                    inputStreamStarted: false
                };
                this.rtspSources.set(sourceKey, source);

                // Optimization: Use separate args for high/low quality
                const ffmpegArgs = [
                    '-rtsp_transport', 'tcp',
                    '-i', rtspUrl,
                    '-f', 'mpegts',
                    '-codec:v', 'mpeg1video',
                    '-bf', '0', // Disable B-frames for lower latency
                    '-threads', 'auto' // Use auto threads for better performance
                ];

                ffmpegArgs.push('-an'); // Disable audio

                if (quality === 'low') {
                    // Optimized for dashboard cards: lower resolution but stable bitrate
                    ffmpegArgs.push(
                        '-s', '640x480',
                        '-r', '20',
                        '-b:v', '1000k',
                        '-maxrate', '1200k',
                        '-bufsize', '2000k',
                        '-q:v', '6'
                    );
                } else {
                    // HD quality for viewer
                    ffmpegArgs.push(
                        '-s', '1920x1080',
                        '-r', '25',
                        '-b:v', '4000k',
                        '-maxrate', '5000k',
                        '-bufsize', '8000k',
                        '-q:v', '3'
                    );
                }

                ffmpegArgs.push('-'); // Output to stdout

                const ffmpeg = spawn(ffmpegPath, ffmpegArgs, { detached: false });
                source.ffmpeg = ffmpeg;

                ffmpeg.stdout.on('data', (data) => {
                    const currentSource = this.rtspSources.get(sourceKey);
                    if (!currentSource) return;

                    if (!currentSource.inputStreamStarted) {
                        currentSource.inputStreamStarted = true;
                    }

                    // Broadcast to ALL associated WebSocket clients
                    for (const camKey of currentSource.cameras) {
                        const cameraClients = this.clients.get(camKey);
                        if (cameraClients && cameraClients.size > 0) {
                            // Clear timeout for first data
                            const cam = this.cameras.get(camKey);
                            if (cam && cam.checkTimeout) {
                                clearTimeout(cam.checkTimeout);
                                cam.checkTimeout = null;
                            }

                            cameraClients.forEach(client => {
                                if (client.readyState === WebSocket.OPEN) {
                                    client.send(data, { binary: true });
                                }
                            });
                        }
                    }
                });

                ffmpeg.stderr.on('data', (data) => {
                    const str = data.toString();

                    // Log everything until the stream starts so we can see connection errors
                    if (!source.inputStreamStarted) {
                        console.log(`[StreamManager][ffmpeg-log] ${str.trim()}`);

                        const sizeMatch = str.match(/(\d{2,5})x(\d{2,5})/);
                        if (sizeMatch) {
                            source.width = parseInt(sizeMatch[1], 10);
                            source.height = parseInt(sizeMatch[2], 10);
                            console.log(`[StreamManager] Detected dimensions: ${source.width}x${source.height} for source ${sourceKey}`);
                        }
                    }
                });

                ffmpeg.on('exit', (code) => {
                    console.log(`[StreamManager] ffmpeg exited (code ${code}) for source ${sourceKey}`);
                    this._killSource(sourceKey);
                });
            }


            // 5. Resilience: If no data arrives from ffmpeg for this specific camera launch
            cameraData.checkTimeout = setTimeout(() => {
                if (this.cameras.has(cameraKey)) {
                    const s = this.rtspSources.get(sourceKey);
                    if (!s || !s.inputStreamStarted) {
                        console.warn(`[StreamManager] No data for camera ${cameraId} (${quality}). Cleaning up.`);
                        this.stopStream(cameraKey);
                    }
                }
            }, this.CONNECTION_TIMEOUT);

            return this.wsPort;
        } catch (error) {
            console.error(`[StreamManager] startStream error:`, error);
            throw error;
        }
    }

    /**
     * Stop a camera stream. Kills ffmpeg if it was the last camera using it.
     */
    stopStream(cameraKey) {
        const cam = this.cameras.get(cameraKey);
        if (!cam) return;

        console.log(`[StreamManager] stopping camera key ${cameraKey}`);

        if (cam.checkTimeout) clearTimeout(cam.checkTimeout);

        // Disconnect all clients for this camera
        const cameraClients = this.clients.get(cameraKey);
        if (cameraClients) {
            cameraClients.forEach(socket => socket.close());
            this.clients.delete(cameraKey);
        }

        const sourceKey = cam.sourceKey;
        this.cameras.delete(cameraKey);

        const source = this.rtspSources.get(sourceKey);
        if (source) {
            source.cameras.delete(cameraKey);
            if (source.cameras.size === 0) {
                this._killSource(sourceKey);
            }
        }
    }

    _killSource(sourceKey) {
        const source = this.rtspSources.get(sourceKey);
        if (!source) return;

        console.log(`[StreamManager] killing source for ${sourceKey.split('@')[1] || sourceKey}`);
        if (source.ffmpeg) {
            try { source.ffmpeg.kill('SIGTERM'); } catch (e) { }
        }

        // Clean up any remaining cameras tied to this source
        for (const camKey of source.cameras) {
            const cam = this.cameras.get(camKey);
            if (cam) {
                if (cam.checkTimeout) clearTimeout(cam.checkTimeout);
                // Disconnect clients
                const cameraClients = this.clients.get(camKey);
                if (cameraClients) {
                    cameraClients.forEach(s => s.close());
                    this.clients.delete(camKey);
                }
                this.cameras.delete(camKey);
            }
        }

        this.rtspSources.delete(sourceKey);
    }

    stopAllStreams() {
        console.log(`[StreamManager] stopping all streams`);
        for (const url of Array.from(this.rtspSources.keys())) {
            this._killSource(url);
        }
    }

    cleanupIdleStreams(timeoutMs = 10 * 60 * 1000) {
        const now = new Date();
        for (const [camKey, cam] of this.cameras.entries()) {
            if (now - cam.lastAccessed > timeoutMs) {
                this.stopStream(camKey);
            }
        }
    }
}

const streamManager = new StreamManager();
setInterval(() => streamManager.cleanupIdleStreams(), 5 * 60 * 1000);

module.exports = streamManager;
