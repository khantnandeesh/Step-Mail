import { useEffect, useRef, useState, useCallback } from 'react';

const WS_URL = (() => {
    const apiUrl = import.meta.env.VITE_API_URL || '';
    // Strip path from API URL to get origin, then add /ws
    const url = new URL(apiUrl || 'http://localhost');
    url.pathname = '/ws';
    url.protocol = url.protocol.replace('http', 'ws');
    return url.toString().replace(/\/$/, '');
})();

export function useAdminWebSocket(adminPassword) {
    const [ws, setWs] = useState(null);
    const [connected, setConnected] = useState(false);
    const reconnectTimer = useRef(null);
    const wsRef = useRef(null);

    useEffect(() => {
        if (!adminPassword) return;

        let cancelled = false;

        function connect() {
            if (cancelled) return;
            const socket = new WebSocket(`${WS_URL}?token=${encodeURIComponent(adminPassword)}`);
            wsRef.current = socket;

            socket.onopen = () => {
                if (!cancelled) {
                    setWs(socket);
                    setConnected(true);
                }
            };

            socket.onclose = () => {
                if (!cancelled) {
                    setConnected(false);
                    setWs(null);
                    // Reconnect after 3 seconds
                    reconnectTimer.current = setTimeout(connect, 3000);
                }
            };

            socket.onerror = () => {
                socket.close();
            };
        }

        connect();

        return () => {
            cancelled = true;
            if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
            if (wsRef.current) wsRef.current.close();
            setWs(null);
            setConnected(false);
        };
    }, [adminPassword]);

    return { ws, connected };
}

export function useAdminData(adminPassword) {
    const { ws, connected } = useAdminWebSocket(adminPassword);
    const [stats, setStats] = useState(null);
    const [cpuHistory, setCpuHistory] = useState([]);
    const [rateLimits, setRateLimits] = useState([]);
    const callbacksRef = useRef({});

    // Register data handlers
    const onData = useCallback((type, handler) => {
        callbacksRef.current[type] = handler;
    }, []);

    useEffect(() => {
        if (!ws) return;

        ws.onmessage = (event) => {
            try {
                const msg = JSON.parse(event.data);
                const handler = callbacksRef.current[msg.type];
                if (handler) {
                    handler(msg.data);
                }
            } catch (e) {
                console.error('WS parse error:', e);
            }
        };
    }, [ws, onData]);

    // Set up default handlers
    useEffect(() => {
        onData('stats', setStats);
        onData('cpu-history', setCpuHistory);
        onData('rate-limits', (data) => setRateLimits(data.limits || []));
    }, [onData]);

    return { ws, connected, stats, cpuHistory, rateLimits };
}

export function useUserWebSocket(email) {
    const [ws, setWs] = useState(null);
    const [connected, setConnected] = useState(false);
    const [newEmails, setNewEmails] = useState([]);
    const reconnectTimer = useRef(null);
    const wsRef = useRef(null);

    useEffect(() => {
        if (!email) return;

        let cancelled = false;

        function connect() {
            if (cancelled) return;
            const socket = new WebSocket(`${WS_URL}?email=${encodeURIComponent(email)}`);
            wsRef.current = socket;

            socket.onopen = () => {
                if (!cancelled) {
                    setWs(socket);
                    setConnected(true);
                }
            };

            socket.onclose = () => {
                if (!cancelled) {
                    setConnected(false);
                    setWs(null);
                    reconnectTimer.current = setTimeout(connect, 3000);
                }
            };

            socket.onerror = () => {
                socket.close();
            };

            socket.onmessage = (event) => {
                try {
                    const msg = JSON.parse(event.data);
                    if (msg.type === 'new-email') {
                        setNewEmails(prev => [...prev, msg.data]);
                    }
                } catch (e) {
                    console.error('WS parse error:', e);
                }
            };
        }

        connect();

        return () => {
            cancelled = true;
            if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
            if (wsRef.current) wsRef.current.close();
            setWs(null);
            setConnected(false);
            setNewEmails([]);
        };
    }, [email]);

    return { ws, connected, newEmails };
}
