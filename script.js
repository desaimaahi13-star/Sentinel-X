// ============================================
// LOGIN & AUTHENTICATION LOGIC
// ============================================
async function handleLogin(event) {
    event.preventDefault();
    
    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;
    const errorDiv = document.getElementById('login-error');
    
    // Clear previous error
    errorDiv.textContent = '';
    
    try {
        const response = await fetch('/login', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ username, password })
        });
        
        const data = await response.json();
        
        if (response.ok && data.success) {
            // Store token and username in sessionStorage
            sessionStorage.setItem('authToken', data.token);
            sessionStorage.setItem('username', username);
            
            // Show dashboard, hide login
            showDashboard();
        } else {
            errorDiv.textContent = data.message || 'Invalid credentials';
        }
    } catch (error) {
        console.error('Login error:', error);
        errorDiv.textContent = 'Connection error. Please try again.';
    }
}

function handleLogout() {
    // Clear session
    sessionStorage.removeItem('authToken');
    sessionStorage.removeItem('username');
    
    // Reset form
    document.getElementById('login-form').reset();
    
    // Show login, hide dashboard
    showLoginPage();
}

function showDashboard() {
    const loginPage = document.getElementById('login-page');
    const dashboardContainer = document.getElementById('dashboard-container');
    
    loginPage.classList.remove('active');
    loginPage.classList.add('hidden');
    dashboardContainer.classList.remove('hidden');
    
    // Update user info
    const username = sessionStorage.getItem('username');
    const userInfo = document.getElementById('user-info');
    if (userInfo && username) {
        userInfo.textContent = username;
    }
    
    // Initialize globe after dashboard is visible
    setTimeout(() => {
        startGlobe();
    }, 100);

    // Load recent uploads (from this device + others) if widget exists
    try { loadRecentUploads(); } catch {}
    try { loadRecentAnalyses(); } catch {}
}

async function handleRegister(event) {
    event.preventDefault();

    const username = document.getElementById('reg-username')?.value || '';
    const password = document.getElementById('reg-password')?.value || '';
    const password2 = document.getElementById('reg-password2')?.value || '';
    const errorDiv = document.getElementById('register-error');
    if (errorDiv) errorDiv.textContent = '';

    if (password !== password2) {
        if (errorDiv) errorDiv.textContent = 'Passwords do not match';
        return;
    }

    try {
        const response = await fetch('/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });

        const data = await response.json().catch(() => ({}));
        if (response.ok && data.success) {
            // Switch back to login and prefill username
            const loginForm = document.getElementById('login-form');
            const registerForm = document.getElementById('register-form');
            const showLogin = document.getElementById('show-login');
            const showRegister = document.getElementById('show-register');
            if (registerForm) registerForm.classList.add('hidden');
            if (loginForm) loginForm.classList.remove('hidden');
            if (showLogin) showLogin.classList.add('hidden');
            if (showRegister) showRegister.classList.remove('hidden');

            const u = document.getElementById('username');
            if (u) u.value = username;
            const p = document.getElementById('password');
            if (p) p.value = '';
            const loginErr = document.getElementById('login-error');
            if (loginErr) loginErr.textContent = 'Account created. Please sign in.';
        } else {
            if (errorDiv) errorDiv.textContent = data.message || 'Failed to create account';
        }
    } catch (err) {
        console.error('Register error:', err);
        if (errorDiv) errorDiv.textContent = 'Connection error. Please try again.';
    }
}

function showLoginPage() {
    const loginPage = document.getElementById('login-page');
    const dashboardContainer = document.getElementById('dashboard-container');
    
    loginPage.classList.remove('hidden');
    loginPage.classList.add('active');
    dashboardContainer.classList.add('hidden');
}

// Check if user is already logged in on page load
function checkAuthStatus() {
    const token = sessionStorage.getItem('authToken');
    const username = sessionStorage.getItem('username');
    
    if (token && username) {
        showDashboard();
    } else {
        showLoginPage();
    }
}

// ============================================
// 1. NAVIGATION LOGIC: Fixed to handle 'event' correctly in all browsers
function switchTab(tabId, event) {
    // Hide all pages
    const pages = document.querySelectorAll('.page');
    pages.forEach(p => p.classList.remove('active'));

    // Remove active status from all buttons
    const buttons = document.querySelectorAll('.nav-btn');
    buttons.forEach(b => b.classList.remove('active'));

    // Show the page the user clicked on
    const targetPage = document.getElementById(tabId);
    if (targetPage) {
        targetPage.classList.add('active');
    }

    // Highlight the clicked button
    if (event && event.currentTarget) {
        event.currentTarget.classList.add('active');
    }

    if (tabId === 'lab') {
        try { loadRecentUploads(); } catch {}
    }
}

// 2. INITIALIZATION: Runs when the page is ready
document.addEventListener('DOMContentLoaded', () => {
    // Check authentication status first
    checkAuthStatus();

    // Register UI toggles
    const showRegister = document.getElementById('show-register');
    const showLogin = document.getElementById('show-login');
    const loginForm = document.getElementById('login-form');
    const registerForm = document.getElementById('register-form');
    if (showRegister && showLogin && loginForm && registerForm) {
        showRegister.addEventListener('click', (e) => {
            e.preventDefault();
            loginForm.classList.add('hidden');
            registerForm.classList.remove('hidden');
            showRegister.classList.add('hidden');
            showLogin.classList.remove('hidden');
        });
        showLogin.addEventListener('click', (e) => {
            e.preventDefault();
            registerForm.classList.add('hidden');
            loginForm.classList.remove('hidden');
            showLogin.classList.add('hidden');
            showRegister.classList.remove('hidden');
        });
    }
    
    // Connect the file input to the analysis logic
    const fileInput = document.getElementById('fileInput');
    const selectFileBtn = document.getElementById('selectFileBtn');
    
    if (fileInput) {
        fileInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (file) {
                processAnalysis(file);
            }
        });
    }
    
    // Connect the select button to file input
    if (selectFileBtn) {
        selectFileBtn.addEventListener('click', () => {
            fileInput.click();
        });
    }

    // Start UI components
    updateIndiaTime();
    setInterval(updateIndiaTime, 1000);
    // startGlobe() will be called after login when dashboard is visible
    
    // Node Health metrics polling
    const metricsIntervalInput = document.getElementById('metrics-interval');
    const saveConfigBtn = document.getElementById('save-config');
    const configMsg = document.getElementById('config-msg');

    let metricsInterval = Number(metricsIntervalInput ? metricsIntervalInput.value : 5) || 5;
    let metricsTimer = null;

    // WebSocket connection for real-time updates
    // Important: do NOT hard-reload the page on disconnect; many environments block WS and that creates a reload loop.
    // Also guard against `file://` or empty hosts (opening index.html directly), where `new WebSocket()` can throw.
    const canUseWebSocket =
        (window.location.protocol === 'http:' || window.location.protocol === 'https:') &&
        typeof window.location.host === 'string' &&
        window.location.host.length > 0;

    let ws = null;
    let wsReconnectTimer = null;
    let wsReconnectAttempts = 0;

    function scheduleWsReconnect() {
        if (!canUseWebSocket) return;
        if (wsReconnectTimer) return;

        const delayMs = Math.min(30000, 1000 * Math.pow(2, wsReconnectAttempts));
        wsReconnectAttempts += 1;

        wsReconnectTimer = setTimeout(() => {
            wsReconnectTimer = null;
            connectWebSocket();
        }, delayMs);
    }

    function connectWebSocket() {
        if (!canUseWebSocket) return;

        const wsProtocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
        const wsUrl = `${wsProtocol}://${window.location.host}`;

        try {
            ws = new WebSocket(wsUrl);
        } catch (err) {
            console.error('WebSocket init failed:', err);
            scheduleWsReconnect();
            return;
        }

        ws.onopen = () => {
            wsReconnectAttempts = 0;
            console.log('Connected to real-time updates');
        };

        ws.onmessage = (event) => {
            try {
                const message = JSON.parse(event.data);
                handleRealtimeUpdate(message);
            } catch (err) {
                console.error('Failed to parse WebSocket message:', err);
            }
        };

        ws.onclose = () => {
            console.log('Disconnected from real-time updates');
            scheduleWsReconnect();
        };

        ws.onerror = (error) => {
            console.error('WebSocket error:', error);
        };
    }

    connectWebSocket();

    // Handle real-time updates from WebSocket
    function handleRealtimeUpdate(message) {
        const { type, data } = message;
        
        switch (type) {
            case 'metrics':
                updateMetricsUI(data);
                break;
            case 'stats':
                updateStatsUI(data);
                break;
            case 'analysis':
                try { loadRecentAnalyses(); } catch {}
                break;
            default:
                console.log('Unknown message type:', type);
        }
    }

    // Load server-side config and populate fields
    async function loadConfigToUI() {
        try {
            const resp = await fetch('/config');
            if (!resp.ok) return;
            const data = await resp.json();
            const cfg = data.config || {};
            if (metricsIntervalInput) metricsIntervalInput.value = cfg.metricsInterval || metricsInterval;
            const vtInput = document.getElementById('vt-api-key');
            if (vtInput) vtInput.value = cfg.virusTotalApiKey || '';
        } catch (err) {
            // ignore
        }
    }
    loadConfigToUI();

    // Update metrics UI with real-time data
    function updateMetricsUI(data) {
        const nodeStatus = document.getElementById('node-status');
        const nodeUptime = document.getElementById('node-uptime');
        const nodeCount = document.getElementById('node-count');

        if (nodeStatus) nodeStatus.innerText = `${data.cluster.healthy}/${data.cluster.activeNodes} healthy`;
        if (nodeUptime) nodeUptime.innerText = `${data.cluster.avgUptimeDays} days`;
        if (nodeCount) nodeCount.innerText = `${data.cluster.activeNodes}`;
    }

    // Update stats UI with real-time data
    function updateStatsUI(data) {
        // Update charts with new data
        loadAndRenderCharts(data);
    }

    // Legacy function for initial load (now uses WebSocket for updates)
    async function fetchMetrics() {
        try {
            const resp = await fetch('/metrics');
            if (!resp.ok) throw new Error('metrics fetch failed');
            const data = await resp.json();
            updateMetricsUI(data);
        } catch (err) {
            // Keep UI stable but show dashes on failure
            const nodeStatus = document.getElementById('node-status');
            const nodeUptime = document.getElementById('node-uptime');
            const nodeCount = document.getElementById('node-count');
            if (nodeStatus) nodeStatus.innerText = '--';
            if (nodeUptime) nodeUptime.innerText = '--';
            if (nodeCount) nodeCount.innerText = '--';
        }
    }

    function startMetricsPolling() {
        // Fetch initial data, then rely on WebSocket for real-time updates
        fetchMetrics();
        // Remove polling since we now use WebSockets
        if (metricsTimer) {
            clearInterval(metricsTimer);
            metricsTimer = null;
        }
    }

    // wire save config button to update polling interval
    if (saveConfigBtn && metricsIntervalInput) {
        saveConfigBtn.addEventListener('click', () => {
            const val = Number(metricsIntervalInput.value);
            if (!isNaN(val) && val >= 1) {
                const vtInput = document.getElementById('vt-api-key');
                const payload = { metricsInterval: val, virusTotalApiKey: vtInput ? vtInput.value : '' };
                fetch('/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
                    .then(r => r.json())
                    .then(() => {
                        metricsInterval = val;
                        startMetricsPolling();
                        if (configMsg) {
                            configMsg.innerText = `Saved. Poll interval: ${metricsInterval}s`;
                            setTimeout(() => { configMsg.innerText = ''; }, 3000);
                        }
                    }).catch(() => {
                        if (configMsg) {
                            configMsg.innerText = `Save failed`;
                            setTimeout(() => { configMsg.innerText = ''; }, 3000);
                        }
                    });
            } else {
                if (configMsg) {
                    configMsg.innerText = 'Invalid interval';
                    setTimeout(() => { configMsg.innerText = ''; }, 3000);
                }
            }
        });
    }

    // Start polling by default
    startMetricsPolling();

    // --- Load and render stats charts ---
    async function loadAndRenderCharts(statsData = null) {
        try {
            let stats = statsData;
            
            if (!stats) {
                const resp = await fetch('/stats');
                
                if (resp.ok) {
                    stats = await resp.json();
                } else {
                    // Fallback to mock data if /stats is unavailable
                    stats = {
                        statuses: { 'CLEAN': 3, 'UNKNOWN': 2, 'SUSPICIOUS': 1 },
                        severities: { 'LOW': 5, 'MEDIUM': 3, 'HIGH': 2, 'CRITICAL': 1 }
                    };
                }
            }

            // Analysis Status Chart (Pie)
            const statsCanvas = document.getElementById('stats-chart');
            if (statsCanvas && stats.statuses) {
                // Destroy existing chart if any
                if (window.statsChartInstance) window.statsChartInstance.destroy();
                
                const statusLabels = Object.keys(stats.statuses);
                const statusData = Object.values(stats.statuses);
                const statusColors = {
                    'MALICIOUS': '#f85149',
                    'SUSPICIOUS': '#d29922',
                    'CLEAN': '#3fb950',
                    'UNKNOWN': '#6e7681'
                };
                
                window.statsChartInstance = new Chart(statsCanvas, {
                    type: 'pie',
                    data: {
                        labels: statusLabels,
                        datasets: [{
                            data: statusData,
                            backgroundColor: statusLabels.map(s => statusColors[s] || '#58a6ff')
                        }]
                    },
                    options: {
                        responsive: true,
                        maintainAspectRatio: true,
                        plugins: {
                            legend: { position: 'bottom', labels: { color: '#c9d1d9' } }
                        }
                    }
                });
            }

            // Severity Distribution Chart (Bar)
            const severityCanvas = document.getElementById('severity-chart');
            if (severityCanvas && stats.severities) {
                // Destroy existing chart if any
                if (window.severityChartInstance) window.severityChartInstance.destroy();
                
                const severityLabels = Object.keys(stats.severities).sort();
                const severityData = severityLabels.map(s => stats.severities[s]);
                const severityColors = {
                    'CRITICAL': '#f85149',
                    'HIGH': '#d29922',
                    'MEDIUM': '#d2a8ff',
                    'LOW': '#79c0ff'
                };

                window.severityChartInstance = new Chart(severityCanvas, {
                    type: 'bar',
                    data: {
                        labels: severityLabels,
                        datasets: [{
                            label: 'Detections',
                            data: severityData,
                            backgroundColor: severityLabels.map(s => severityColors[s] || '#58a6ff'),
                            borderRadius: 4
                        }]
                    },
                    options: {
                        indexAxis: 'y',
                        responsive: true,
                        maintainAspectRatio: true,
                        plugins: {
                            legend: { display: false }
                        },
                        scales: {
                            x: { ticks: { color: '#8b949e' }, grid: { color: '#30363d' } },
                            y: { ticks: { color: '#8b949e' } }
                        }
                    }
                });
            }
        } catch (err) {
            console.error('Chart loading error:', err);
            // silently fail chart loading
        }
    }

    // Render charts on load and whenever switching to config tab
    loadAndRenderCharts();
    
    // Hook to config button to refresh charts
    let configBtnFound = false;
    document.querySelectorAll('.nav-btn').forEach(btn => {
        if (btn.textContent && btn.textContent.includes('Configuration')) {
            configBtnFound = true;
            btn.addEventListener('click', () => {
                setTimeout(loadAndRenderCharts, 500);
            });
        }
    });
});

async function loadRecentUploads() {
    const tbody = document.getElementById('uploads-tbody');
    if (!tbody) return;

    const deviceIdKey = 'sentinelx_device_id';
    const deviceId = localStorage.getItem(deviceIdKey) || '';

    try {
        const res = await fetch('/api/uploads?limit=20');
        if (!res.ok) throw new Error('failed');
        const json = await res.json();
        const uploads = Array.isArray(json.uploads) ? json.uploads : [];

        tbody.innerHTML = '';
        if (!uploads.length) {
            tbody.innerHTML = '<tr><td colspan="4">No uploads yet</td></tr>';
            return;
        }

        uploads.forEach(u => {
            const tr = document.createElement('tr');
            const fileTd = document.createElement('td');
            fileTd.textContent = u.original_name || '-';

            const shaTd = document.createElement('td');
            shaTd.textContent = (u.sha256 || '').slice(0, 16) + (u.sha256 ? '…' : '');

            const devTd = document.createElement('td');
            const dev = u.device_id || '-';
            devTd.textContent = dev === deviceId ? `${dev} (this)` : dev;

            const timeTd = document.createElement('td');
            timeTd.textContent = u.created_at ? new Date(u.created_at).toLocaleString() : '-';

            tr.append(fileTd, shaTd, devTd, timeTd);
            tbody.appendChild(tr);
        });
    } catch {
        tbody.innerHTML = '<tr><td colspan="4">Failed to load uploads</td></tr>';
    }
}

async function loadRecentAnalyses() {
    const tbody = document.getElementById('recent-analyses-body');
    if (!tbody) return;

    try {
        const resp = await fetch('/api/analyses?limit=15');
        if (!resp.ok) throw new Error('failed');
        const data = await resp.json();
        const items = Array.isArray(data.analyses) ? data.analyses : [];

        tbody.innerHTML = '';
        if (!items.length) {
            tbody.innerHTML = '<tr><td colspan="6">No analyses yet</td></tr>';
            return;
        }

        items.slice(0, 15).forEach((a) => {
            const tr = document.createElement('tr');

            const fileTd = document.createElement('td');
            fileTd.textContent = a.fileName || '-';

            const kindTd = document.createElement('td');
            kindTd.textContent = a.analysis_kind || '-';

            const statusTd = document.createElement('td');
            statusTd.textContent = a.status || '-';

            const scoreTd = document.createElement('td');
            scoreTd.textContent = typeof a.score === 'number' ? String(a.score) : (a.score ?? '-');

            const userTd = document.createElement('td');
            userTd.textContent = a.username || '-';

            const timeTd = document.createElement('td');
            timeTd.textContent = a.timestamp ? new Date(a.timestamp).toLocaleString() : '-';

            tr.append(fileTd, kindTd, statusTd, scoreTd, userTd, timeTd);
            tbody.appendChild(tr);
        });
    } catch {
        tbody.innerHTML = '<tr><td colspan="6">Failed to load analyses</td></tr>';
    }
}

// 3. ANALYSIS LOGIC: Sends data to your Node.js server
function appendLog(logsEl, level, label, message) {
    if (!logsEl) return;

    const row = document.createElement('div');
    row.className = `log-row log-${level}`;

    const prefix = document.createElement('span');
    prefix.className = 'log-prefix';
    prefix.textContent = `[${label}]`;

    const msg = document.createElement('span');
    msg.className = 'log-message';
    msg.textContent = message;

    row.append(prefix, msg);
    logsEl.appendChild(row);
    logsEl.scrollTop = logsEl.scrollHeight;
}

async function processAnalysis(file) {
    const logs = document.getElementById('analysis-logs');
    const verdictBox = document.getElementById('verdict-container');

    if (!logs || !verdictBox) return;

    // Reset UI for new scan
    logs.textContent = '';
    appendLog(logs, 'info', 'INIT', `Target: ${file.name}`);
    appendLog(logs, 'info', 'CONN', 'Establishing link to Sentinel-X Core...');
    verdictBox.classList.add('hidden');

    try {
        // Stable device id (so uploads can be grouped by device)
        const deviceIdKey = 'sentinelx_device_id';
        let deviceId = localStorage.getItem(deviceIdKey);
        if (!deviceId) {
            deviceId = 'dev_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
            localStorage.setItem(deviceIdKey, deviceId);
        }

        // Upload file to backend so it shows up in "uploaded_files" DB across devices
        appendLog(logs, 'info', 'UPLOAD', 'Sending sample to backend storage...');
        let fileHash = null;
        try {
            const fd = new FormData();
            fd.append('file', file);
            const uploadRes = await fetch('/api/upload', {
                method: 'POST',
                headers: { 'X-Device-Id': deviceId },
                body: fd
            });
            if (uploadRes.ok) {
                const uploadJson = await uploadRes.json();
                fileHash = uploadJson.sha256 || null;
                appendLog(logs, 'ok', 'UPLOAD', `Stored. sha256=${String(fileHash || '').slice(0, 12)}...`);
                loadRecentUploads();
            } else {
                let msg = `Upload failed (HTTP ${uploadRes.status}).`;
                try {
                    const txt = await uploadRes.text();
                    if (txt) msg += ` ${txt.slice(0, 160)}`;
                } catch {}
                appendLog(logs, 'warn', 'UPLOAD', `${msg} Continuing with analysis.`);
            }
        } catch {
            appendLog(logs, 'warn', 'UPLOAD', 'Upload failed (continuing with analysis).');
        }
        if (!fileHash) fileHash = "sha256_" + Math.random().toString(36).substring(7);
         
        const usernameHeader = sessionStorage.getItem('username') || '';
        const clientHeaders = {
            'X-Device-Id': deviceId,
            'X-Username': usernameHeader
        };

        // Perform static analysis (VirusTotal)
        appendLog(logs, 'info', 'STATIC', 'Running signature-based analysis...');
        const staticResponse = await fetch('/analyze', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...clientHeaders },
            body: JSON.stringify({
                fileName: file.name,
                hash: fileHash
            })
        });

        if (!staticResponse.ok) throw new Error('Server error');
        const staticResult = await staticResponse.json();

        // Perform dynamic analysis (Behavior Detection)
        appendLog(logs, 'info', 'DYNAMIC', 'Analyzing runtime behaviors...');
        const behaviorResponse = await fetch('/analyze-behavior', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...clientHeaders },
            body: JSON.stringify({
                fileName: file.name,
                hash: fileHash
            })
        });

        if (!behaviorResponse.ok) throw new Error('Behavior analysis failed');
        const behaviorResult = await behaviorResponse.json();

        // Simulate processing delay for "cool" effect
        setTimeout(() => {
            appendLog(logs, 'ok', 'RECV', `Static analysis: ${staticResult.score}/100 (${staticResult.status || 'UNKNOWN'})`);
            appendLog(logs, 'ok', 'RECV', `Behavior analysis: ${behaviorResult.behavior_score}/100 (${behaviorResult.threat_level || 'N/A'})`);
            appendLog(logs, behaviorResult.behaviors.length ? 'warn' : 'ok', 'BEHAVIORS', `Detected ${behaviorResult.behaviors.length} suspicious behaviors`);
            
            behaviorResult.behaviors.forEach(b => {
                const level = b.severity === 'CRITICAL' ? 'err' : b.severity === 'HIGH' ? 'warn' : 'info';
                appendLog(logs, level, b.severity, b.description);
            });
            
            displayFinalVerdict(staticResult, behaviorResult);
        }, 1000);

    } catch (error) {
        appendLog(logs, 'err', 'ERR', "Backend connection failed. Ensure 'node server.js' is running.");
    }
}

// 4. UI OUTPUT: Displays the malware verdict
function displayFinalVerdict(staticResult, behaviorResult) {
    const box = document.getElementById('verdict-container');
    if (!box) return;
    box.classList.remove('hidden');
    
    // Combine both analysis results
    const combinedScore = Math.max(staticResult.score, behaviorResult.behavior_score);
    const hasCriticalBehaviors = behaviorResult.behaviors.some(b => b.severity === 'CRITICAL');
    
    let finalStatus = staticResult.status;
    if (hasCriticalBehaviors) finalStatus = 'MALICIOUS';
    if (combinedScore > 70) finalStatus = 'DANGEROUS';
    
    // Set verdict style
    box.classList.remove('verdict-clean', 'verdict-suspicious', 'verdict-malicious');
    const normalized = String(finalStatus || '').toUpperCase();
    const verdictClass =
        normalized === 'MALICIOUS' || normalized === 'DANGEROUS' ? 'verdict-malicious' :
        normalized === 'SUSPICIOUS' ? 'verdict-suspicious' :
        'verdict-clean';
    box.classList.add('verdict-box', verdictClass);

    const topBehaviors = (behaviorResult.behaviors || []).slice(0, 6);
    const behaviorItems = topBehaviors.map(b => {
        const sev = String(b.severity || 'MEDIUM').toUpperCase();
        const sevClass = sev === 'CRITICAL' ? 'sev-critical' : sev === 'HIGH' ? 'sev-high' : 'sev-medium';
        return `<li class="${sevClass}"><strong>[${sev}]</strong> ${String(b.description || '')}</li>`;
    }).join('');

    const staticReason = staticResult.reasoning ? `<div class="verdict-meta">Static: ${String(staticResult.reasoning)}</div>` : '';
    
    box.innerHTML = `
        <div class="verdict-header">
            <h3 class="verdict-title">Analysis Verdict</h3>
            <span class="verdict-pill">${String(finalStatus || 'UNKNOWN')}</span>
        </div>
        <p class="verdict-meta"><strong>Static</strong>: ${staticResult.score}/100 (${String(staticResult.status || 'UNKNOWN')}) • <strong>Behavior</strong>: ${behaviorResult.behavior_score}/100 (${String(behaviorResult.threat_level || 'N/A')})</p>
        ${staticReason}
        <div class="verdict-meta">Top behaviors:</div>
        <ul class="verdict-list">${behaviorItems || '<li class=\"sev-medium\"><strong>[NONE]</strong> No suspicious behaviors detected.</li>'}</ul>
        <p class="verdict-meta">Timestamp: ${new Date(behaviorResult.timestamp).toLocaleTimeString()}</p>
    `;
}

// 5. CLOCK: Live India Standard Time (IST)
function updateIndiaTime() {
    const clockElement = document.getElementById('clock');
    if (clockElement) {
        const now = new Date();
        const istTime = now.toLocaleString("en-US", {
            timeZone: "Asia/Kolkata",
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false
        });
        clockElement.innerText = `${istTime} IST`;
    }
}

// --- Threat Origin Map (canvas) ---
function startGlobe() {
    const canvas = document.getElementById('globe-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    // Robust resize that handles high-DPI screens
    function resize() {
        const dpr = window.devicePixelRatio || 1;
        const rect = canvas.getBoundingClientRect();
        canvas.width = rect.width * dpr;
        canvas.height = rect.height * dpr;
        ctx.scale(dpr, dpr);
    }

    const origins = [
        {label:'RU', lat:55.75, lon:37.6},
        {label:'CN', lat:39.9, lon:116.4},
        {label:'US', lat:37.1, lon:-95.7},
        {label:'BR', lat:-14.2, lon:-51.9},
        {label:'IN', lat:20.6, lon:78.9},
        {label:'NG', lat:9.1, lon:8.7}
    ];

    let ticks = 0;

    function project(lat, lon, w, h) {
        // Center-aligned projection for a circular globe
        const x = (lon + 180) * (w / 360);
        const y = (90 - lat) * (h / 180);
        return {x, y};
    }

    function draw() {
        const rect = canvas.getBoundingClientRect();
        const w = rect.width;
        const h = rect.height;
        if (w === 0 || h === 0) { requestAnimationFrame(draw); return; } // Wait if tab is hidden

        ctx.clearRect(0, 0, w, h);

        // 1. Draw Globe Silhouette
        const cx = w / 2;
        const cy = h / 2;
        const r = Math.min(w, h) * 0.45;  // Larger radius for full display

        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fillStyle = '#051018'; // Deep space background
        ctx.fill();
        
        // Draw globe border
        ctx.strokeStyle = 'rgba(88, 166, 255, 0.6)';
        ctx.lineWidth = 2;
        ctx.stroke();
        
        ctx.clip(); // Ensure dots only show on the globe

        // 2. Draw Subtle Land Grids
        ctx.strokeStyle = 'rgba(88, 166, 255, 0.1)';
        ctx.lineWidth = 0.5;
        for(let i=0; i<w; i+=20) {
            ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, h); ctx.stroke();
        }

        // 3. Draw Pulsing Threat Dots
        origins.forEach((o, i) => {
            const p = project(o.lat, o.lon, w, h);
            const pulse = 0.5 + 0.5 * Math.sin((ticks + i * 15) / 12);
            
            ctx.beginPath();
            ctx.fillStyle = `rgba(248, 81, 73, ${0.3 + pulse * 0.7})`;
            ctx.arc(p.x, p.y, 3 + pulse * 4, 0, Math.PI * 2);
            ctx.fill();
            
            // Core of the dot
            ctx.beginPath();
            ctx.fillStyle = '#ffffff';
            ctx.arc(p.x, p.y, 1.5, 0, Math.PI * 2);
            ctx.fill();
        });

        // 4. Scanning Line (slower speed)
        const scanY = ((ticks % 500) / 500) * h;
        ctx.fillStyle = 'rgba(88, 166, 255, 0.15)';
        ctx.fillRect(0, scanY, w, 2);

        ctx.restore(); // Clear the clip for the next frame
        ticks++;
        requestAnimationFrame(draw);
    }

    window.addEventListener('resize', resize);
    resize();
    draw();
}

