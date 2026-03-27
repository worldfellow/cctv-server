const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const WebSocket = require('ws');
const cluster = require('cluster');

const STREAM_MAGIC_BYTES = 'jsmp';
const DEFAULT_WIDTH = 640;
const DEFAULT_HEIGHT = 480;


class StreamManager {
    constructor() {
        // Shared state (Primary only)
        this.cameras = new Map(); // cameraKey -> data
        this.rtspSources = new Map(); // sourceKey -> source
        this.workerSubscriptions = new Map(); // cameraKey -> Set<workerId>

        // Local state (Worker only)
        this.clients = new Map(); // cameraKey -> Set<WebSocket>

        this.wsPort = 9999;
        this.CONNECTION_TIMEOUT = 30000;
        this.MAX_STREAMS = 25; // Safety limit
    }

    /**
     * INITIALIZE PRIMARY: Setup orchestration and IPC listeners
     */
    initPrimary() {
        if (!cluster.isPrimary) return;

        console.log(`[StreamManager] Initializing Primary Orchestrator (PID: ${process.pid})`);

        cluster.on('message', (worker, msg) => {
            if (msg.type === 'START_STREAM') {
                const { cameraId, rtspUrl, quality } = msg.data;
                const cameraKey = `${cameraId}_${quality}`;
                
                if (!this.workerSubscriptions.has(cameraKey)) {
                    this.workerSubscriptions.set(cameraKey, new Set());
                }
                this.workerSubscriptions.get(cameraKey).add(worker.id);
                
                this.startStream(cameraId, rtspUrl, quality);
            }
            if (msg.type === 'STOP_STREAM') {
                const { cameraKey } = msg;
                const subs = this.workerSubscriptions.get(cameraKey);
                if (subs) {
                    subs.delete(worker.id);
                    if (subs.size === 0) {
                        this.workerSubscriptions.delete(cameraKey);
                        this.stopStream(cameraKey);
                    }
                }
            }
            if (msg.type === 'HEARTBEAT') {
                const { cameraKey } = msg;
                const cam = this.cameras.get(cameraKey);
                if (cam) cam.lastAccessed = new Date();
            }
        });

        // Cleanup if worker dies
        cluster.on('exit', (worker) => {
            for (const [cameraKey, subs] of this.workerSubscriptions.entries()) {
                if (subs.has(worker.id)) {
                    subs.delete(worker.id);
                    if (subs.size === 0) {
                        this.workerSubscriptions.delete(cameraKey);
                        this.stopStream(cameraKey);
                    }
                }
            }
        });
    }

    attach(server) {
        if (cluster.isPrimary) return;

        this.wsServer = new WebSocket.Server({ noServer: true });
        console.log(`[StreamManager] Worker ${process.pid} WebSocket multiplexer attached`);

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

            if (!this.clients.has(cameraKey)) {
                this.clients.set(cameraKey, new Set());
            }
            this.clients.get(cameraKey).add(socket);

            const header = Buffer.alloc(8);
            header.write(STREAM_MAGIC_BYTES);
            header.writeUInt16BE(DEFAULT_WIDTH, 4);
            header.writeUInt16BE(DEFAULT_HEIGHT, 6);
            socket.send(header, { binary: true });

            socket.on('close', () => {
                const cameraClients = this.clients.get(cameraKey);
                if (cameraClients) {
                    cameraClients.delete(socket);
                    if (cameraClients.size === 0) {
                        this.clients.delete(cameraKey);
                        if (this.heartbeatIntervals?.has(cameraKey)) {
                            clearInterval(this.heartbeatIntervals.get(cameraKey));
                            this.heartbeatIntervals.delete(cameraKey);
                        }
                        process.send({ type: 'STOP_STREAM', cameraKey });
                    }
                }
            });

            // Start heartbeat to keep Primary from evicting this stream
            if (!this.heartbeatIntervals) this.heartbeatIntervals = new Map();
            if (!this.heartbeatIntervals.has(cameraKey)) {
                const interval = setInterval(() => {
                    process.send({ type: 'HEARTBEAT', cameraKey });
                }, 30000); // Every 30s
                this.heartbeatIntervals.set(cameraKey, interval);
            }
        });

        process.on('message', (msg) => {
            if (msg.type === 'STREAM_DATA') {
                const { cameraKey, data } = msg;
                const cameraClients = this.clients.get(cameraKey);
                if (cameraClients) {
                    cameraClients.forEach(client => {
                        if (client.readyState === WebSocket.OPEN) {
                            client.send(data, { binary: true });
                        }
                    });
                }
            }
        });
    }

    /**
     * Start a stream.
     */
    startStream(cameraId, rtspUrl, quality = 'high') {
        const sourceKey = `${rtspUrl}_${quality}`;
        const cameraKey = `${cameraId}_${quality}`;

        if (cluster.isWorker) {
            process.send({ type: 'START_STREAM', data: { cameraId, rtspUrl, quality } });
            return this.wsPort;
        }

        if (this.cameras.has(cameraKey)) {
            this.cameras.get(cameraKey).lastAccessed = new Date();
            return this.wsPort;
        }

        console.log(`[StreamManager] INITIALIZING camera ${cameraId} with quality ${quality}`);

        // Enhanced Eviction: Only evict if truly needed, and prioritize those with 0 current worker subs
        if (this.rtspSources.size >= this.MAX_STREAMS && !this.rtspSources.has(sourceKey)) {
            console.warn(`[StreamManager] Max sources reached (${this.MAX_STREAMS}). Evaluating eviction...`);
            
            let targetKey = null;
            // First attempt: find any camera with 0 worker subscriptions
            for (const [key, subs] of this.workerSubscriptions.entries()) {
                if (subs.size === 0) {
                    targetKey = key;
                    break;
                }
            }

            // Second attempt: oldest accessed that doesn't belong to the current source
            if (!targetKey) {
                let oldestDate = new Date();
                for (const [key, cam] of this.cameras.entries()) {
                    if (cam.lastAccessed < oldestDate) {
                        oldestDate = cam.lastAccessed;
                        targetKey = key;
                    }
                }
            }

            if (targetKey) {
                console.log(`[StreamManager] Evicting stream ${targetKey} to make room.`);
                this.stopStream(targetKey);
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
                console.log(`[StreamManager] Primary: Spawning FFmpeg for ${sourceKey.split('@')[1] || sourceKey}`);
                source = {
                    ffmpeg: null,
                    width: quality === 'ultra' ? 1280 : (quality === 'low' ? 640 : 1280),
                    height: quality === 'ultra' ? 720 : (quality === 'low' ? 480 : 720),
                    cameras: new Set([cameraKey]),
                    inputStreamStarted: false,
                };
                this.rtspSources.set(sourceKey, source);


                const ffmpegArgs = [
                    '-rtsp_transport', 'tcp',
                    '-i', rtspUrl,
                    '-f', 'mpegts',
                    '-codec:v', 'mpeg1video',
                    '-bf', '0',
                    '-threads', 'auto',
                    '-an'
                ];

                if (quality === 'low') {
                    // Optimized for 20+ dashboard cards: Ultra-lightweight
                    ffmpegArgs.push(
                        '-s', '320x240',
                        '-r', '20',
                        '-b:v', '600k',
                        '-maxrate', '600k',
                        '-bufsize', '1200k',
                        '-q:v', '6'
                    );
                } else if (quality === 'ultra') {
                    // Ultra High quality for clear image (1080p)
                    ffmpegArgs.push(
                        '-s', '1280x720',
                        '-r', '20',
                        '-b:v', '4000k',
                        '-maxrate', '5000k',
                        '-bufsize', '8000k',
                    );
                } else {
                    ffmpegArgs.push('-s', '1280x720', '-r', '20', '-b:v', '2000k', '-maxrate', '2500k', '-bufsize', '4000k');
                }

                ffmpegArgs.push('-');

                const ffmpeg = spawn(ffmpegPath, ffmpegArgs, { detached: false });
                source.ffmpeg = ffmpeg;

                ffmpeg.stdout.on('data', (data) => {
                    source.inputStreamStarted = true;
                    // Optimized: Only send to workers that actually have clients for these cameras
                    for (const camKey of source.cameras) {
                        const subs = this.workerSubscriptions.get(camKey);
                        if (subs) {
                            for (const workerId of subs) {
                                const worker = cluster.workers[workerId];
                                if (worker && worker.isConnected()) {
                                    worker.send({ type: 'STREAM_DATA', cameraKey: camKey, data });
                                }
                            }
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

                ffmpeg.on('exit', (code) => {
                    console.log(`[StreamManager] FFmpeg exited (code ${code}) for ${sourceKey.split('@')[1] || sourceKey}`);
                    
                    // AUTO-RECOVERY: If workers are still subscribed, attempt restart after 2 seconds
                    const hasActiveSubscribers = Array.from(source.cameras).some(camKey => {
                        const subs = this.workerSubscriptions.get(camKey);
                        return subs && subs.size > 0;
                    });

                    this.rtspSources.delete(sourceKey);

                    if (hasActiveSubscribers) {
                        console.log(`[StreamManager] Recovering crashed stream for ${sourceKey}...`);
                        setTimeout(() => {
                           for (const camKey of source.cameras) {
                               const cam = this.cameras.get(camKey);
                               if (cam) {
                                   this.cameras.delete(camKey); // Clear entry to allow re-init
                                   const cameraId = camKey.split('_')[0];
                                   const quality = camKey.split('_')[1];
                                   this.startStream(cameraId, cam.rtspUrl, quality);
                               }
                           }
                        }, 2000);
                    } else {
                        this._killSource(sourceKey);
                    }
                });
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

    stopStream(cameraKey) {
        if (cluster.isWorker) {
            process.send({ type: 'STOP_STREAM', cameraKey });
            return;
        }

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
        }

        this.rtspSources.delete(sourceKey);
    }

    stopAllStreams() {
        if (cluster.isPrimary) {
            for (const url of Array.from(this.rtspSources.keys())) {
                this._killSource(url);
            }
        }
    }

    cleanupIdleStreams(timeoutMs = 60 * 60 * 1000) { // Increased to 1 hour since heartbeat handles it better
        if (!cluster.isPrimary) return;
        const now = new Date();
        for (const [camKey, cam] of this.cameras.entries()) {
            const subs = this.workerSubscriptions.get(camKey);
            // Only cleanup if it's both old AND has no active workers
            if (now - cam.lastAccessed > timeoutMs && (!subs || subs.size === 0)) {
                this.stopStream(camKey);
            }
        }
    }
}

const streamManager = new StreamManager();
if (cluster.isPrimary) {
    setInterval(() => streamManager.cleanupIdleStreams(), 5 * 60 * 1000);
}

module.exports = streamManager;

