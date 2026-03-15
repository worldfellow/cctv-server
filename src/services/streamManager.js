const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const WebSocket = require('ws');

const STREAM_MAGIC_BYTES = 'jsmp';
const DEFAULT_WIDTH = 640;
const DEFAULT_HEIGHT = 480;

class StreamManager {
    constructor() {
        // Map<cameraId, { port, wsServer, rtspUrl, lastAccessed, checkTimeout }>
        this.cameras = new Map();

        // Map<rtspUrl, { ffmpeg, width, height, cameras: Set<string>, inputSztreamStarted: boolean }>
        this.rtspSources = new Map();

        this.basePort = 9999;
        this.CONNECTION_TIMEOUT = 15000; // 15 seconds to receive the first packet from ffmpeg
    }

    _getNextAvailablePort() {
        let currentPort = this.basePort;
        const usedPorts = Array.from(this.cameras.values()).map(s => s.port);
        while (usedPorts.includes(currentPort)) {
            currentPort++;
        }
        return currentPort;
    }

    /**
     * Starts a stream for a specific camera.
     * Shares the ffmpeg process if another camera already uses the same RTSP URL and quality.
     */
    startStream(cameraId, rtspUrl, quality = 'high') {
        const sourceKey = `${rtspUrl}_${quality}`;

        // 1. If camera already has a stream, refresh it and return port
        if (this.cameras.has(cameraId)) {
            const existing = this.cameras.get(cameraId);
            existing.lastAccessed = new Date();
            // If quality changed, we might need to handle it, but for now we keep existing
            return existing.port;
        }

        const wsPort = this._getNextAvailablePort();
        console.log(`[StreamManager] starting camera ${cameraId} on port ${wsPort} with quality ${quality}`);

        try {
            // 2. Create dedicated WebSocket server for this camera view
            const wsServer = new WebSocket.Server({ port: wsPort });

            const cameraData = {
                port: wsPort,
                wsServer: wsServer,
                rtspUrl: rtspUrl,
                sourceKey: sourceKey,
                lastAccessed: new Date(),
                checkTimeout: null
            };
            this.cameras.set(cameraId, cameraData);

            // 3. Handle RTSP source sharing based on URL + Quality
            let source = this.rtspSources.get(sourceKey);

            if (source) {
                console.log(`[StreamManager] Source sharing: camera ${cameraId} joining existing ffmpeg for ${sourceKey.split('@')[1] || sourceKey}`);
                source.cameras.add(cameraId);
            } else {
                console.log(`[StreamManager] Source init: new ffmpeg for ${sourceKey.split('@')[1] || sourceKey}`);

                source = {
                    ffmpeg: null,
                    width: quality === 'low' ? 640 : DEFAULT_WIDTH,
                    height: quality === 'low' ? 360 : DEFAULT_HEIGHT,
                    cameras: new Set([cameraId]),
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

                if (quality === 'low') {
                    // Low quality: lower resolution, frame rate and higher quantization
                    ffmpegArgs.push(
                        '-s', '640x360',
                        '-r', '15',
                        '-q:v', '15'
                    );
                } else {
                    // High quality: Full HD resolution and better clarity
                    ffmpegArgs.push(
                        '-s', '1920x1080',
                        '-r', '25',
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

                    // Broadcast to ALL WebSocket servers derived from this source
                    for (const camId of currentSource.cameras) {
                        const cam = this.cameras.get(camId);
                        if (cam && cam.wsServer) {
                            // Clear timeout for any camera waiting for first data
                            if (cam.checkTimeout) {
                                clearTimeout(cam.checkTimeout);
                                cam.checkTimeout = null;
                            }

                            cam.wsServer.clients.forEach(client => {
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

            // 4. WebSocket connection logic
            wsServer.on('connection', (socket) => {
                const currentSource = this.rtspSources.get(sourceKey);
                const header = Buffer.alloc(8);
                header.write(STREAM_MAGIC_BYTES);
                header.writeUInt16BE(currentSource ? currentSource.width : DEFAULT_WIDTH, 4);
                header.writeUInt16BE(currentSource ? currentSource.height : DEFAULT_HEIGHT, 6);
                socket.send(header, { binary: true });
            });

            // 5. Resilience: If no data arrives from ffmpeg for this specific camera launch
            cameraData.checkTimeout = setTimeout(() => {
                if (this.cameras.has(cameraId)) {
                    const cam = this.cameras.get(cameraId);
                    const s = this.rtspSources.get(sourceKey);
                    if (!s || !s.inputStreamStarted) {
                        console.warn(`[StreamManager] No data for camera ${cameraId} on port ${wsPort}. Closing camera stream.`);
                        this.stopStream(cameraId);
                    }
                }
            }, this.CONNECTION_TIMEOUT);

            return wsPort;
        } catch (error) {
            console.error(`[StreamManager] startStream error:`, error);
            throw error;
        }
    }

    /**
     * Stop a camera stream. Kills ffmpeg if it was the last camera using it.
     */
    stopStream(cameraId) {
        const cam = this.cameras.get(cameraId);
        if (!cam) return;

        console.log(`[StreamManager] stopping camera ${cameraId} on port ${cam.port}`);

        if (cam.checkTimeout) clearTimeout(cam.checkTimeout);
        try { cam.wsServer.close(); } catch (e) { }

        const sourceKey = cam.sourceKey;
        this.cameras.delete(cameraId);

        const source = this.rtspSources.get(sourceKey);
        if (source) {
            source.cameras.delete(cameraId);
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
        for (const camId of source.cameras) {
            const cam = this.cameras.get(camId);
            if (cam) {
                if (cam.checkTimeout) clearTimeout(cam.checkTimeout);
                try { cam.wsServer.close(); } catch (e) { }
                this.cameras.delete(camId);
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
        for (const [cameraId, cam] of this.cameras.entries()) {
            if (now - cam.lastAccessed > timeoutMs) {
                this.stopStream(cameraId);
            }
        }
    }
}

const streamManager = new StreamManager();
setInterval(() => streamManager.cleanupIdleStreams(), 5 * 60 * 1000);

module.exports = streamManager;
