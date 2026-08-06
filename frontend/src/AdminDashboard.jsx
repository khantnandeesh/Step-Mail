import { useState, useEffect, useCallback, useRef } from 'react';
import { Link } from 'react-router-dom';
import { PieChart, Pie, Cell, ResponsiveContainer } from 'recharts';
import './App.css';
import { useAdminData } from './useWebSocket';

const API_URL = import.meta.env.VITE_API_URL || '';

const getCpuColor = (percentage) => {
    if (percentage < 50) return '#22c55e';
    if (percentage < 80) return '#eab308';
    return '#ef4444';
};

const getStatusText = (percentage) => {
    if (percentage < 50) return 'Normal';
    if (percentage < 80) return 'Moderate';
    return 'High';
};

function AdminDashboard() {
    const [isAuthenticated, setIsAuthenticated] = useState(false);
    const [password, setPassword] = useState('');
    const [authError, setAuthError] = useState('');
    const [authLoading, setAuthLoading] = useState(false);

    const [stats, setStats] = useState(null);
    const [cpuHistory, setCpuHistory] = useState([]);
    const [logs, setLogs] = useState([]);
    const [handles, setHandles] = useState([]);
    const [activeTab, setActiveTab] = useState('overview'); // 'overview', 'handles', 'logs'
    const [loading, setLoading] = useState(false);
    const [cursor, setCursor] = useState('0');
    const [hasMore, setHasMore] = useState(true);
    const [searchQuery, setSearchQuery] = useState('');
    const [logFilter, setLogFilter] = useState('');

    // Service status
    const [serviceStatus, setServiceStatus] = useState('on');

    // Rate limits per IP
    const [userRateLimits, setUserRateLimits] = useState([]);
    const [rlSearch, setRlSearch] = useState('');
    const [rlTick, setRlTick] = useState(0); // forces re-render every second for countdown
    const rlFetchTime = useRef(0); // timestamp when rate limits were last fetched

    // Rate limit config
    const [rateLimitConfig, setRateLimitConfig] = useState(null);
    const [rlDefaults, setRlDefaults] = useState(null);

    const observerRef = useRef(null);
    const loadMoreRef = useRef(null);

    // WebSocket for real-time admin data
    const { ws: adminWs, connected: wsConnected, stats: wsStats, cpuHistory: wsCpuHistory, rateLimits: wsRateLimits } = useAdminData(isAuthenticated ? password : null);

    // Merge WebSocket data with local state
    useEffect(() => {
        if (wsStats) setStats(wsStats);
    }, [wsStats]);

    useEffect(() => {
        if (wsCpuHistory.length > 0) setCpuHistory(wsCpuHistory);
    }, [wsCpuHistory]);

    useEffect(() => {
        if (wsRateLimits.length > 0) {
            setUserRateLimits(wsRateLimits);
            rlFetchTime.current = Date.now();
        }
    }, [wsRateLimits]);

    // Check if already authenticated (session storage)
    useEffect(() => {
        const savedPassword = sessionStorage.getItem('adminPassword');
        if (savedPassword) {
            setPassword(savedPassword);
            setIsAuthenticated(true);
        }
    }, []);

    // Login handler
    const handleLogin = async (e) => {
        e.preventDefault();
        setAuthLoading(true);
        setAuthError('');

        try {
            const res = await fetch(`${API_URL}/api/admin/auth`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password })
            });

            const data = await res.json();

            if (data.success) {
                setIsAuthenticated(true);
                sessionStorage.setItem('adminPassword', password);
            } else {
                setAuthError('Invalid password');
            }
        } catch (error) {
            setAuthError('Connection error');
        }

        setAuthLoading(false);
    };

    // Fetch stats
    const fetchStats = useCallback(async () => {
        if (!isAuthenticated) return;

        try {
            const res = await fetch(`${API_URL}/api/admin/stats`, {
                headers: { 'X-Admin-Password': password }
            });
            const data = await res.json();
            if (data.success) {
                setStats(data);
            }
        } catch (error) {
            console.error('Failed to fetch stats:', error);
        }
    }, [isAuthenticated, password]);

    // Fetch CPU history with polling every 2 seconds
    const fetchCpuHistory = useCallback(async () => {
        if (!isAuthenticated) return;

        try {
            const res = await fetch(`${API_URL}/api/admin/cpu-history`, {
                headers: { 'X-Admin-Password': password }
            });
            const data = await res.json();
            if (data.success) {
                setCpuHistory(data.history);
            }
        } catch (error) {
            console.error('Failed to fetch CPU history:', error);
        }
    }, [isAuthenticated, password]);

    // CPU history is now received via WebSocket, no polling needed

    // Fetch logs
    const fetchLogs = useCallback(async () => {
        if (!isAuthenticated) return;

        try {
            const url = logFilter
                ? `${API_URL}/api/admin/logs?limit=200&type=${logFilter}`
                : `${API_URL}/api/admin/logs?limit=200`;
            const res = await fetch(url, {
                headers: { 'X-Admin-Password': password }
            });
            const data = await res.json();
            if (data.success) {
                setLogs(data.logs);
            }
        } catch (error) {
            console.error('Failed to fetch logs:', error);
        }
    }, [isAuthenticated, password, logFilter]);

    // Fetch handles
    const fetchHandles = useCallback(async (cursorVal = '0', append = false) => {
        if (!isAuthenticated) return;

        setLoading(true);
        try {
            const res = await fetch(`${API_URL}/api/admin/handles?cursor=${cursorVal}&limit=100`, {
                headers: { 'X-Admin-Password': password }
            });
            const data = await res.json();

            if (data.success) {
                if (append) {
                    setHandles(prev => [...prev, ...data.handles]);
                } else {
                    setHandles(data.handles);
                }
                setCursor(data.cursor);
                setHasMore(data.hasMore);
            }
        } catch (error) {
            console.error('Failed to fetch handles:', error);
        }
        setLoading(false);
    }, [isAuthenticated, password]);

    // Delete handle
    const deleteHandle = async (email) => {
        if (!confirm(`Delete ${email}?`)) return;

        try {
            const res = await fetch(`${API_URL}/api/admin/handle/${encodeURIComponent(email)}`, {
                method: 'DELETE',
                headers: { 'X-Admin-Password': password }
            });
            const data = await res.json();

            if (data.success) {
                setHandles(prev => prev.filter(h => h.email !== email));
                fetchStats();
            }
        } catch (error) {
            console.error('Failed to delete handle:', error);
        }
    };

    // Fetch service status
    const fetchServiceStatus = useCallback(async () => {
        try {
            const res = await fetch(`${API_URL}/api/admin/service-status`, {
                headers: { 'X-Admin-Password': password }
            });
            const data = await res.json();
            if (data.success) setServiceStatus(data.status);
        } catch (e) {
            console.error('Failed to fetch service status:', e);
        }
    }, [password]);

    // Fetch user rate limits
    const fetchUserRateLimits = useCallback(async () => {
        try {
            const res = await fetch(`${API_URL}/api/admin/rate-limits`, {
                headers: { 'X-Admin-Password': password }
            });
            const data = await res.json();
            if (data.success) {
                setUserRateLimits(data.limits);
                rlFetchTime.current = Date.now();
            }
        } catch (e) {
            console.error('Failed to fetch user rate limits:', e);
        }
    }, [password]);

    // Reset rate limits for an IP
    const resetRateLimit = async (ip) => {
        try {
            const res = await fetch(`${API_URL}/api/admin/rate-limits/${encodeURIComponent(ip)}/reset`, {
                method: 'POST',
                headers: { 'X-Admin-Password': password }
            });
            const data = await res.json();
            if (data.success) fetchUserRateLimits();
        } catch (e) {
            console.error('Failed to reset rate limits:', e);
        }
    };

    // Fetch rate limit config
    const fetchRateLimitConfig = useCallback(async () => {
        try {
            const res = await fetch(`${API_URL}/api/admin/ratelimit-config`, {
                headers: { 'X-Admin-Password': password }
            });
            const data = await res.json();
            if (data.success) {
                setRateLimitConfig(data.current);
                setRlDefaults(data.defaults);
            }
        } catch (e) {
            console.error('Failed to fetch rate limit config:', e);
        }
    }, [password]);

    // Update rate limit config
    const updateRateLimitConfig = async (name, field, value) => {
        const current = rateLimitConfig[name] || { ...rlDefaults[name] };
        const newConfig = {
            general: rateLimitConfig.general || { ...rlDefaults.general },
            create: rateLimitConfig.create || { ...rlDefaults.create },
            send: rateLimitConfig.send || { ...rlDefaults.send },
        };
        newConfig[name] = { ...newConfig[name], [field]: value };
        try {
            const res = await fetch(`${API_URL}/api/admin/ratelimit-config`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', 'X-Admin-Password': password },
                body: JSON.stringify(newConfig)
            });
            const data = await res.json();
            if (data.success) setRateLimitConfig(data.config);
        } catch (e) {
            console.error('Failed to update rate limit config:', e);
        }
    };

    const resetRateLimitToDefault = async (name) => {
        const newConfig = {
            general: name === 'general' ? { ...rlDefaults.general } : (rateLimitConfig.general || { ...rlDefaults.general }),
            create: name === 'create' ? { ...rlDefaults.create } : (rateLimitConfig.create || { ...rlDefaults.create }),
            send: name === 'send' ? { ...rlDefaults.send } : (rateLimitConfig.send || { ...rlDefaults.send }),
        };
        try {
            const res = await fetch(`${API_URL}/api/admin/ratelimit-config`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', 'X-Admin-Password': password },
                body: JSON.stringify(newConfig)
            });
            const data = await res.json();
            if (data.success) setRateLimitConfig(data.config);
        } catch (e) {
            console.error('Failed to reset rate limit:', e);
        }
    };

    // Load data on auth
    useEffect(() => {
        if (isAuthenticated) {
            fetchStats();
            fetchLogs();
            fetchHandles('0', false);
            fetchServiceStatus();
            fetchRateLimitConfig();
        }
    }, [isAuthenticated, fetchStats, fetchLogs, fetchHandles, fetchServiceStatus, fetchRateLimitConfig]);

    // Refresh logs when filter changes
    useEffect(() => {
        if (isAuthenticated) {
            fetchLogs();
        }
    }, [logFilter, fetchLogs]);

    // Tick every second for rate limit countdown display
    useEffect(() => {
        if (activeTab !== 'ratelimits') return;
        const timer = setInterval(() => setRlTick(t => t + 1), 1000);
        return () => clearInterval(timer);
    }, [activeTab]);

    // Infinite scroll for handles
    useEffect(() => {
        if (activeTab !== 'handles') return;

        if (observerRef.current) observerRef.current.disconnect();

        observerRef.current = new IntersectionObserver(
            entries => {
                if (entries[0].isIntersecting && hasMore && !loading) {
                    fetchHandles(cursor, true);
                }
            },
            { threshold: 0.1 }
        );

        if (loadMoreRef.current) {
            observerRef.current.observe(loadMoreRef.current);
        }

        return () => {
            if (observerRef.current) observerRef.current.disconnect();
        };
    }, [cursor, hasMore, loading, activeTab, fetchHandles]);

    // Filter handles
    const filteredHandles = handles.filter(h =>
        h.handle.toLowerCase().includes(searchQuery.toLowerCase()) ||
        h.email.toLowerCase().includes(searchQuery.toLowerCase())
    );

    // Format helpers
    const formatUptime = (seconds) => {
        const days = Math.floor(seconds / 86400);
        const hours = Math.floor((seconds % 86400) / 3600);
        const mins = Math.floor((seconds % 3600) / 60);
        return `${days}d ${hours}h ${mins}m`;
    };

    const formatTtl = (ttl) => {
        if (ttl === null) return '∞ Forever';
        if (ttl <= 0) return 'Expired';
        if (ttl < 60) return `${ttl}s`;
        if (ttl < 3600) return `${Math.floor(ttl / 60)}m`;
        if (ttl < 86400) return `${Math.floor(ttl / 3600)}h`;
        return `${Math.floor(ttl / 86400)}d`;
    };

    const formatNumber = (num) => num?.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",") || '0';

    const timeAgo = (dateStr) => {
        const seconds = Math.floor((new Date() - new Date(dateStr)) / 1000);
        if (seconds < 60) return 'just now';
        if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
        if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
        return `${Math.floor(seconds / 86400)}d ago`;
    };

    const getLogTypeColor = (type) => {
        switch (type) {
            case 'error': return '#ff4444';
            case 'email_received': return '#00d4ff';
            case 'email_sent': return '#4CAF50';
            case 'spam_blocked': return '#ff9800';
            case 'rate_limited': return '#e91e63';
            default: return '#888';
        }
    };

    // Compute live countdown for rate limit resets
    const getLiveResetsIn = (resetsIn) => {
        if (resetsIn <= 0) return '-';
        const elapsed = Math.floor((Date.now() - rlFetchTime.current) / 1000);
        const remaining = Math.max(0, resetsIn - elapsed);
        if (remaining <= 0) return 'Expired';
        return `${Math.floor(remaining / 60)}m ${remaining % 60}s`;
    };

    // Render CPU gauge
    const renderCpuGauge = () => {
        const currentCpu = cpuHistory.length > 0 ? cpuHistory[cpuHistory.length - 1].percentage : 0;
        const cpuColor = getCpuColor(currentCpu);
        const statusText = getStatusText(currentCpu);
        
        const data = [
            { name: 'used', value: currentCpu },
            { name: 'free', value: 100 - currentCpu }
        ];

        const timestamp = cpuHistory.length > 0 
            ? new Date(cpuHistory[cpuHistory.length - 1].timestamp).toLocaleTimeString() 
            : 'N/A';

        return (
            <div className="cpu-gauge-container">
                <div className="cpu-gauge">
                    <ResponsiveContainer width="100%" height={180}>
                        <PieChart>
                            <Pie
                                data={data}
                                cx="50%"
                                cy="70%"
                                startAngle={180}
                                endAngle={0}
                                innerRadius={60}
                                outerRadius={80}
                                paddingAngle={0}
                                dataKey="value"
                            >
                                <Cell fill={cpuColor} />
                                <Cell fill="#e5e7eb" />
                            </Pie>
                        </PieChart>
                    </ResponsiveContainer>
                    <div className="cpu-gauge-value">
                        <span className="cpu-percentage" style={{ color: cpuColor }}>
                            {currentCpu.toFixed(1)}%
                        </span>
                        <span className="cpu-label">CPU Usage</span>
                    </div>
                </div>
                <div className="cpu-info-grid">
                    <div className="cpu-info-item">
                        <span className="info-label">Status</span>
                        <span className="info-value" style={{ color: cpuColor }}>{statusText}</span>
                    </div>
                    <div className="cpu-info-item">
                        <span className="info-label">Cores</span>
                        <span className="info-value">{stats?.system?.cpu?.cores || 'N/A'}</span>
                    </div>
                    <div className="cpu-info-item">
                        <span className="info-label">Load Avg</span>
                        <span className="info-value">{stats?.system?.cpu?.loadAvg || 'N/A'}</span>
                    </div>
                    <div className="cpu-info-item">
                        <span className="info-label">Last Update</span>
                        <span className="info-value">{timestamp}</span>
                    </div>
                </div>
                <div className="cpu-legend">
                    <div className="legend-item">
                        <span className="legend-color" style={{ background: '#22c55e' }}></span>
                        <span>0-50% Normal</span>
                    </div>
                    <div className="legend-item">
                        <span className="legend-color" style={{ background: '#eab308' }}></span>
                        <span>50-80% Moderate</span>
                    </div>
                    <div className="legend-item">
                        <span className="legend-color" style={{ background: '#ef4444' }}></span>
                        <span>80-100% High</span>
                    </div>
                </div>
            </div>
        );
    };

    // Login screen
    if (!isAuthenticated) {
        return (
            <div className="app admin-login">
                <div className="login-container">
                    <div className="login-card">
                        <div className="login-header">
                            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                            </svg>
                            <h1>Admin Dashboard</h1>
                            <p>Enter password to continue</p>
                        </div>

                        <form onSubmit={handleLogin}>
                            <input
                                type="password"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                placeholder="Admin password"
                                autoFocus
                            />
                            {authError && <div className="auth-error">{authError}</div>}
                            <button type="submit" disabled={authLoading}>
                                {authLoading ? 'Verifying...' : 'Login'}
                            </button>
                        </form>

                        <Link to="/" className="back-link">← Back to StepMail</Link>
                    </div>
                </div>
            </div>
        );
    }

    // Dashboard
    return (
        <div className="app admin-dashboard">
            {/* Header */}
            <header className="admin-header">
                <Link to="/" className="back-btn">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M19 12H5M12 19l-7-7 7-7" />
                    </svg>
                    Back
                </Link>
                <h1>Admin Dashboard</h1>
                <button
                    className="logout-btn"
                    onClick={() => {
                        sessionStorage.removeItem('adminPassword');
                        setIsAuthenticated(false);
                        setPassword('');
                    }}
                >
                    Logout
                </button>
            </header>

            {/* Tabs */}
            <div className="admin-tabs">
                <button
                    className={activeTab === 'overview' ? 'active' : ''}
                    onClick={() => setActiveTab('overview')}
                >
                    Overview
                </button>
                <button
                    className={activeTab === 'handles' ? 'active' : ''}
                    onClick={() => setActiveTab('handles')}
                >
                    Handles ({formatNumber(stats?.handles?.total)})
                </button>
                <button
                    className={activeTab === 'logs' ? 'active' : ''}
                    onClick={() => setActiveTab('logs')}
                >
                    Logs
                </button>
                <button
                    className={activeTab === 'ratelimits' ? 'active' : ''}
                    onClick={() => setActiveTab('ratelimits')}
                >
                    Rate Limits
                </button>
                <button
                    className={activeTab === 'rateconfig' ? 'active' : ''}
                    onClick={() => setActiveTab('rateconfig')}
                >
                    Rate Config
                </button>
            </div>

            {/* Content */}
            <div className="admin-content">
                {activeTab === 'overview' && stats && (
                    <div className="overview-grid">
                        {/* Service Status Toggle */}
                        <div className="stat-card">
                            <h3>Service Status</h3>
                            <div className="service-toggle-row">
                                <label className="toggle-switch">
                                    <input
                                        type="checkbox"
                                        checked={serviceStatus === 'on'}
                                        onChange={async (e) => {
                                            const newStatus = e.target.checked ? 'on' : 'off';
                                            try {
                                                const res = await fetch(`${API_URL}/api/admin/service-status`, {
                                                    method: 'PUT',
                                                    headers: { 'Content-Type': 'application/json', 'X-Admin-Password': password },
                                                    body: JSON.stringify({ status: newStatus })
                                                });
                                                const data = await res.json();
                                                if (data.success) setServiceStatus(newStatus);
                                            } catch (e) {
                                                console.error('Failed to update service status:', e);
                                            }
                                        }}
                                    />
                                    <span className="toggle-slider"></span>
                                </label>
                                <span className={`status-badge ${serviceStatus === 'on' ? 'status-on' : 'status-off'}`}>
                                    {serviceStatus === 'on' ? 'Online' : 'Offline'}
                                </span>
                            </div>
                        </div>

                        {/* System Stats */}
                        <div className="stat-card large">
                            <h3>System</h3>
                            {renderCpuGauge()}
                            <div className="stat-row">
                                <span>Memory</span>
                                <span className="stat-value">{stats.system?.memory?.used ?? 0}GB / {stats.system?.memory?.total ?? 0}GB</span>
                            </div>
                            <div className="progress-bar">
                                <div style={{ width: `${stats.system?.memory?.percentage ?? 0}%` }}></div>
                            </div>
                            <div className="stat-row">
                                <span>Uptime</span>
                                <span className="stat-value">{formatUptime(stats.system?.uptime ?? 0)}</span>
                            </div>
                            <div className="stat-row">
                                <span>Node Uptime</span>
                                <span className="stat-value">{formatUptime(stats.system?.nodeUptime ?? 0)}</span>
                            </div>
                        </div>

                        {/* Handles Stats */}
                        <div className="stat-card">
                            <h3>Email Handles</h3>
                            <div className="big-number">{formatNumber(stats.handles?.total ?? 0)}</div>
                            <div className="stat-breakdown">
                                <span>Permanent: {formatNumber(stats.handles?.permanent ?? 0)}</span>
                                <span>Expiring: {formatNumber(stats.handles?.expiring ?? 0)}</span>
                            </div>
                        </div>

                        {/* Redis Stats */}
                        <div className="stat-card">
                            <h3>Redis</h3>
                            <div className="stat-row">
                                <span>Memory</span>
                                <span className="stat-value">{stats.redis?.memory ?? "N/A"}</span>
                            </div>
                            <div className="stat-row">
                                <span>Clients</span>
                                <span className="stat-value">{stats.redis?.clients ?? 0}</span>
                            </div>
                            <div className="stat-row">
                                <span>Total Connections</span>
                                <span className="stat-value">{formatNumber(stats.redis?.totalConnections ?? 0)}</span>
                            </div>
                        </div>

                        {/* Rate Limiting */}
                        <div className="stat-card">
                            <h3>Rate Limiting</h3>
                            <div className="stat-row">
                                <span>Active Keys</span>
                                <span className="stat-value">{stats.rateLimiting?.activeKeys ?? 0}</span>
                            </div>
                        </div>

                        {/* Config */}
                        <div className="stat-card">
                            <h3>Configuration</h3>
                            <div className="stat-row">
                                <span>Domain</span>
                                <span className="stat-value">{stats.config?.emailDomain ?? "N/A"}</span>
                            </div>
                            <div className="stat-row">
                                <span>Default TTL</span>
                                <span className="stat-value">{stats.config?.defaultTTL ?? 600}s</span>
                            </div>
                            <div className="stat-row">
                                <span>Spam Threshold</span>
                                <span className="stat-value">{stats.config?.spamThreshold ?? 5}</span>
                            </div>
                        </div>
                    </div>
                )}

                {activeTab === 'handles' && (
                    <div className="handles-section">
                        <div className="search-bar">
                            <input
                                type="text"
                                placeholder="Search handles..."
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                            />
                        </div>

                        <div className="handles-table">
                            <div className="table-header">
                                <span>Email</span>
                                <span>TTL</span>
                                <span>Inbox</span>
                                <span>Forward</span>
                                <span>Created</span>
                                <span>Actions</span>
                            </div>

                            {loading && handles.length === 0 ? (
                                <div className="loading-state">Loading...</div>
                            ) : (
                                filteredHandles.map((handle, index) => (
                                    <div key={`${handle.email}-${index}`} className="table-row">
                                        <span className="email-cell">{handle.email}</span>
                                        <span className={handle.isPermanent ? 'permanent' : ''}>
                                            {formatTtl(handle.ttl)}
                                        </span>
                                        <span>{handle.inboxCount}</span>
                                        <span>{handle.forwardTo || '-'}</span>
                                        <span>{timeAgo(handle.createdAt)}</span>
                                        <span>
                                            <button
                                                className="delete-btn"
                                                onClick={() => deleteHandle(handle.email)}
                                            >
                                                Delete
                                            </button>
                                        </span>
                                    </div>
                                ))
                            )}
                        </div>

                        {hasMore && (
                            <div ref={loadMoreRef} className="load-more">
                                {loading && <span>Loading more...</span>}
                            </div>
                        )}
                    </div>
                )}

                {activeTab === 'logs' && (
                    <div className="logs-section">
                        <div className="logs-filter">
                            <select value={logFilter} onChange={(e) => setLogFilter(e.target.value)}>
                                <option value="">All Logs</option>
                                <option value="info">Info</option>
                                <option value="error">Errors</option>
                                <option value="email_received">Emails Received</option>
                                <option value="email_sent">Emails Sent</option>
                                <option value="spam_blocked">Spam Blocked</option>
                                <option value="rate_limited">Rate Limited</option>
                            </select>
                            <button onClick={fetchLogs}>Refresh</button>
                        </div>

                        <div className="logs-container">
                            {logs.length === 0 ? (
                                <div className="empty-logs">No logs found</div>
                            ) : (
                                logs.map((log, index) => (
                                    <div key={index} className="log-entry">
                                        <span className="log-time">{new Date(log.timestamp).toLocaleTimeString()}</span>
                                        <span
                                            className="log-type"
                                            style={{ color: getLogTypeColor(log.type) }}
                                        >
                                            [{log.type}]
                                        </span>
                                        <span className="log-message">{log.message}</span>
                                        {Object.keys(log.details).length > 0 && (
                                            <span className="log-details">
                                                {JSON.stringify(log.details)}
                                            </span>
                                        )}
                                    </div>
                                ))
                            )}
                        </div>
                    </div>
                )}

                {activeTab === 'ratelimits' && (
                    <div className="ratelimits-section">
                        <div className="rl-section-header">
                            <h3>Rate Limits by IP</h3>
                            <input
                                type="text"
                                placeholder="Search IP..."
                                value={rlSearch}
                                onChange={(e) => setRlSearch(e.target.value)}
                                className="rl-search"
                            />
                        </div>

                        <div className="rl-table">
                            <div className="rl-table-header">
                                <span>IP Address</span>
                                <span>General</span>
                                <span>Create</span>
                                <span>Send</span>
                                <span>Resets In</span>
                                <span>Actions</span>
                            </div>

                            {userRateLimits.length === 0 ? (
                                <div className="empty-rl">No active rate limit data</div>
                            ) : (
                                userRateLimits
                                    .filter(u => u.ip.includes(rlSearch))
                                    .map((u, i) => (
                                        <div key={`${u.ip}-${rlTick}-${i}`} className="rl-table-row">
                                            <span className="rl-ip">{u.ip}</span>
                                            <span className={`rl-cell ${u.general.used >= u.general.max ? 'rl-warn' : ''}`}>
                                                {u.general.used}/{u.general.max}
                                            </span>
                                            <span className={`rl-cell ${u.create.used >= u.create.max ? 'rl-warn' : ''}`}>
                                                {u.create.used}/{u.create.max}
                                            </span>
                                            <span className={`rl-cell ${u.send.used >= u.send.max ? 'rl-warn' : ''}`}>
                                                {u.send.used}/{u.send.max}
                                            </span>
                                            <span className="rl-resets">
                                                {getLiveResetsIn(u.general.resetsIn)}
                                            </span>
                                            <span>
                                                <button
                                                    className="rl-reset-btn"
                                                    onClick={() => resetRateLimit(u.ip)}
                                                >
                                                    Reset
                                                </button>
                                            </span>
                                        </div>
                                    ))
                            )}
                        </div>
                    </div>
                )}

                {activeTab === 'rateconfig' && rateLimitConfig && rlDefaults && (
                    <div className="rateconfig-section">
                        <h3>Global Rate Limit Configuration</h3>
                        <p className="rl-config-desc">Adjust rate limits for all users. Changes take effect immediately.</p>

                        {['general', 'create', 'send'].map((name) => {
                            const current = rateLimitConfig[name] || rlDefaults[name];
                            const def = rlDefaults[name];
                            const isDefault = current.max === def.max && current.window === def.window;
                            const labels = { general: 'General Requests', create: 'Handle Creation', send: 'Email Sending' };
                            const windowLabels = { general: '60s window', create: '1 hour window', send: '1 hour window' };

                            return (
                                <div key={name} className="rl-config-card">
                                    <div className="rl-config-header">
                                        <span className="rl-name">{labels[name]}</span>
                                        {!isDefault && <span className="rl-modified-badge">Modified</span>}
                                    </div>

                                    <div className="rl-slider-row">
                                        <label>Max Requests</label>
                                        <div className="rl-input-group">
                                            <input
                                                type="range"
                                                min={Math.max(1, Math.floor(def.max * 0.1))}
                                                max={def.max * 5}
                                                step={Math.max(1, Math.floor(def.max * 0.05))}
                                                value={current.max}
                                                onChange={(e) => updateRateLimitConfig(name, 'max', parseInt(e.target.value, 10))}
                                            />
                                            <span className="rl-value">{current.max}</span>
                                        </div>
                                    </div>

                                    <div className="rl-slider-row">
                                        <label>Window (seconds)</label>
                                        <div className="rl-input-group">
                                            <input
                                                type="range"
                                                min={10}
                                                max={7200}
                                                step={10}
                                                value={current.window}
                                                onChange={(e) => updateRateLimitConfig(name, 'window', parseInt(e.target.value, 10))}
                                            />
                                            <span className="rl-value">{current.window}s</span>
                                        </div>
                                    </div>

                                    <div className="rl-default-hint">
                                        Default: {def.max} req / {def.window}s
                                        {!isDefault && (
                                            <button className="rl-reset-default-btn" onClick={() => resetRateLimitToDefault(name)}>
                                                Reset to default
                                            </button>
                                        )}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>
        </div>
    );
}

export default AdminDashboard;
