const net = require('net');

const PROBE_TIMEOUT_MS = parseInt(process.env.CONNECTIVITY_TIMEOUT_MS) || 4000;
const PROBE_CONCURRENCY = parseInt(process.env.CONNECTIVITY_CONCURRENCY) || 40;

const NETWORK_ERRORS = {
    ECONNREFUSED: 'Connection refused (RTSP port closed)',
    EHOSTUNREACH: 'Host unreachable',
    ENETUNREACH: 'Network unreachable',
    ETIMEDOUT: 'Connection timed out',
    ECONNRESET: 'Connection reset by camera'
};

/**
 * Send one RTSP request on a fresh TCP connection and read the response headers.
 * Resolves { code, headers } on an RTSP reply, or { failure: 'offline' | 'no_response', error }.
 */
const rtspRequest = (host, port, request, timeoutMs) => {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        let connected = false;
        let settled = false;
        let buffer = '';

        const finish = (result) => {
            if (settled) return;
            settled = true;
            socket.destroy();
            resolve(result);
        };

        socket.setTimeout(timeoutMs);

        socket.on('connect', () => {
            connected = true;
            socket.write(request);
        });

        socket.on('data', (chunk) => {
            buffer += chunk.toString('latin1');
            if (!/^RTSP\/\d\.\d/.test(buffer)) {
                if (buffer.length >= 8) finish({ failure: 'no_response', error: 'Port open but not an RTSP service' });
                return;
            }
            const headerEnd = buffer.indexOf('\r\n\r\n');
            if (headerEnd === -1) return;

            const lines = buffer.slice(0, headerEnd).split('\r\n');
            const code = parseInt(lines[0].split(' ')[1]);
            const headers = {};
            lines.slice(1).forEach(line => {
                const sep = line.indexOf(':');
                if (sep === -1) return;
                const name = line.slice(0, sep).trim().toLowerCase();
                (headers[name] = headers[name] || []).push(line.slice(sep + 1).trim());
            });
            finish({ code, headers });
        });

        socket.on('timeout', () => {
            finish(connected
                ? { failure: 'no_response', error: 'Port open but RTSP did not reply' }
                : { failure: 'offline', error: 'Connection timed out' });
        });

        socket.on('error', (err) => {
            finish({ failure: connected ? 'no_response' : 'offline', error: NETWORK_ERRORS[err.code] || err.message });
        });

        socket.on('close', () => {
            finish(connected
                ? { failure: 'no_response', error: 'Connection closed without RTSP reply' }
                : { failure: 'offline', error: 'Connection closed' });
        });

        socket.connect(port, host);
    });
};

const describeRequest = (uri) =>
    `DESCRIBE ${uri} RTSP/1.0\r\nCSeq: 1\r\nAccept: application/sdp\r\nUser-Agent: CCTV-HealthCheck\r\n\r\n`;

/**
 * Check a camera by sending a single RTSP DESCRIBE for its RTSP link. No login
 * handshake is attempted (no Authorization header, no retries), so the camera
 * never sees failed login attempts.
 *
 * Result status:
 *  - online       : camera answered the RTSP link with a proper RTSP response
 *  - stream_error : camera answered but reported the stream/link as not found
 *  - no_response  : TCP port open but no RTSP reply before timeout
 *  - offline      : connection refused / timed out / host unreachable
 */
const probeCamera = async ({ host, port, uri }, timeoutMs = PROBE_TIMEOUT_MS) => {
    const started = Date.now();
    const response = await rtspRequest(host, port, describeRequest(uri), timeoutMs);

    if (response.failure) {
        return {
            status: response.failure,
            latencyMs: response.failure === 'offline' ? null : Date.now() - started,
            rtspCode: null,
            error: response.error
        };
    }

    const notFound = response.code === 404 || response.code === 454;
    return {
        status: notFound ? 'stream_error' : 'online',
        latencyMs: Date.now() - started,
        rtspCode: response.code,
        error: notFound ? `Stream/channel not found (RTSP ${response.code})` : null
    };
};

/**
 * Probe many cameras with bounded concurrency. Cameras on the same host (NVR channels)
 * are checked one after another so the NVR isn't flooded with requests.
 * targets: [{ key, host, port, uri }] -> Map(key => result).
 * onResult(key, result) is called after each camera, for progress reporting.
 */
const probeMany = async (targets, onResult = () => { }) => {
    const results = new Map();
    const groups = [...targets.reduce((map, target) => {
        if (!map.has(target.host)) map.set(target.host, []);
        map.get(target.host).push(target);
        return map;
    }, new Map()).values()];
    let index = 0;

    const worker = async () => {
        while (index < groups.length) {
            const group = groups[index++];
            // If the endpoint itself is unreachable, other channels on it will be too; skip re-probing
            const unreachable = new Map();
            for (const target of group) {
                const endpoint = `${target.host}:${target.port}`;
                if (unreachable.has(endpoint)) {
                    results.set(target.key, unreachable.get(endpoint));
                    onResult(target.key, unreachable.get(endpoint));
                    continue;
                }
                const result = await probeCamera(target);
                if (result.status === 'offline' || result.status === 'no_response') unreachable.set(endpoint, result);
                results.set(target.key, result);
                onResult(target.key, result);
            }
        }
    };

    const workers = Array.from({ length: Math.min(PROBE_CONCURRENCY, groups.length) }, worker);
    await Promise.all(workers);
    return results;
};

module.exports = { probeCamera, probeMany };
