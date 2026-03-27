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
        this.CONNECTION_TIMEOUT = 15000;
        this.MAX_STREAMS = 20; // Hard limit for server stability
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
                console.log(`[StreamManager] Primary: Worker ${worker.id} requesting stream ${cameraKey}`);

                if (!this.workerSubscriptions.has(cameraKey)) {
                    this.workerSubscriptions.set(cameraKey, new Set());
                }
                this.workerSubscriptions.get(cameraKey).add(worker.id);

                this.startStream(cameraId, rtspUrl, quality);
            }
            if (msg.type === 'STOP_STREAM') {
                const { cameraKey } = msg;
                console.log(`[StreamManager] Primary: Worker ${worker.id} stopping stream ${cameraKey}`);
                const subs = this.workerSubscriptions.get(cameraKey);
                if (subs) {
                    subs.delete(worker.id);
                    if (subs.size === 0) {
                        this.workerSubscriptions.delete(cameraKey);
                        this.stopStream(cameraKey);
                    }
                }
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

    /**
     * ATTACH TO SERVER (Worker): Handle WebSocket connections and IPC data
     */
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
                        process.send({ type: 'STOP_STREAM', cameraKey });
                    }
                }
            });
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

        // Enforcement: Limit concurrent streams
        if (this.rtspSources.size >= this.MAX_STREAMS && !this.rtspSources.has(sourceKey)) {
            console.log(`[StreamManager] Max sources reached (${this.MAX_STREAMS}). Evicting least active source...`);

            let sourceToEvict = null;
            let oldestOverallActivity = new Date();

            for (const [sKey, source] of this.rtspSources.entries()) {
                // Find the newest activity for THIS source's cameras
                let newestForSource = new Date(0);
                for (const cKey of source.cameras) {
                    const cam = this.cameras.get(cKey);
                    if (cam && cam.lastAccessed > newestForSource) newestForSource = cam.lastAccessed;
                }

                // We want to find the source whose "newest activity" is the oldest among all sources
                if (newestForSource < oldestOverallActivity) {
                    oldestOverallActivity = newestForSource;
                    sourceToEvict = sKey;
                }
            }

            if (sourceToEvict) {
                console.log(`[StreamManager] Evicting source: ${sourceToEvict.split('@')[1] || sourceToEvict}`);
                this._killSource(sourceToEvict);
            }
        }

        try {
            const cameraData = { rtspUrl, sourceKey, lastAccessed: new Date(), checkTimeout: null };
            this.cameras.set(cameraKey, cameraData);

            let source = this.rtspSources.get(sourceKey);
            if (source) {
                source.cameras.add(cameraKey);
            } else {
                console.log(`[StreamManager] Primary: Spawning FFmpeg for ${sourceKey.split('@')[1] || sourceKey}`);
                source = {
                    ffmpeg: null,
                    width: quality === 'ultra' ? 1600 : (quality === 'low' ? 640 : 1280),
                    height: quality === 'ultra' ? 900 : (quality === 'low' ? 480 : 720),
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
                    ffmpegArgs.push('-s', '320x240', '-r', '25', '-b:v', '1000k', '-maxrate', '1000k', '-bufsize', '2000k', '-q:v', '4');
                } else if (quality === 'ultra') {
                    ffmpegArgs.push('-s', '1280x720', '-r', '20', '-b:v', '4000k', '-maxrate', '5000k', '-bufsize', '8000k');
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

                ffmpeg.on('exit', () => this._killSource(sourceKey));
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

    cleanupIdleStreams(timeoutMs = 10 * 60 * 1000) {
        if (!cluster.isPrimary) return;
        const now = new Date();
        for (const [camKey, cam] of this.cameras.entries()) {
            if (now - cam.lastAccessed > timeoutMs) {
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

