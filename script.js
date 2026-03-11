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
}

// 2. INITIALIZATION: Runs when the page is ready
document.addEventListener('DOMContentLoaded', () => {
    // Check authentication status first
    checkAuthStatus();
    
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
    const ws = new WebSocket(`ws://${window.location.host}`);

    ws.onopen = () => {
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
        // Optionally reconnect after a delay
        setTimeout(() => {
            window.location.reload(); // Simple reconnect by reloading
        }, 5000);
    };

    ws.onerror = (error) => {
        console.error('WebSocket error:', error);
    };

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

// 3. ANALYSIS LOGIC: Sends data to your Node.js server
async function processAnalysis(file) {
    const logs = document.getElementById('analysis-logs');
    const verdictBox = document.getElementById('verdict-container');

    // Reset UI for new scan
    logs.innerHTML = `<p>> [INIT] Target: ${file.name}</p>`;
    logs.innerHTML += `<p>> [CONN] Establishing link to Sentinel-X Core...</p>`;
    verdictBox.classList.add('hidden');

    try {
        const fileHash = "sh256_" + Math.random().toString(36).substring(7);
        
        // Perform static analysis (VirusTotal)
        logs.innerHTML += `<p>> [STATIC] Running signature-based analysis...</p>`;
        const staticResponse = await fetch('/analyze', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                fileName: file.name,
                hash: fileHash
            })
        });

        if (!staticResponse.ok) throw new Error('Server error');
        const staticResult = await staticResponse.json();

        // Perform dynamic analysis (Behavior Detection)
        logs.innerHTML += `<p>> [DYNAMIC] Analyzing runtime behaviors...</p>`;
        const behaviorResponse = await fetch('/analyze-behavior', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                fileName: file.name,
                hash: fileHash
            })
        });

        if (!behaviorResponse.ok) throw new Error('Behavior analysis failed');
        const behaviorResult = await behaviorResponse.json();

        // Simulate processing delay for "cool" effect
        setTimeout(() => {
            logs.innerHTML += `<p>> [RECV] Static Analysis Score: ${staticResult.score}</p>`;
            logs.innerHTML += `<p>> [RECV] Behavior Analysis Score: ${behaviorResult.behavior_score}</p>`;
            logs.innerHTML += `<p>> [BEHAVIORS] Detected ${behaviorResult.behaviors.length} suspicious behaviors</p>`;
            
            behaviorResult.behaviors.forEach(b => {
                const levelColor = b.severity === 'CRITICAL' ? 'red' : b.severity === 'HIGH' ? 'orange' : 'yellow';
                logs.innerHTML += `<p style="color:${levelColor}">> [${b.severity}] ${b.description}</p>`;
            });
            
            displayFinalVerdict(staticResult, behaviorResult);
        }, 1000);

    } catch (error) {
        logs.innerHTML += `<p style="color:red">> [ERR] Backend connection failed. Ensure 'node server.js' is running.</p>`;
    }
}

// 4. UI OUTPUT: Displays the malware verdict
function displayFinalVerdict(staticResult, behaviorResult) {
    const box = document.getElementById('verdict-container');
    box.classList.remove('hidden');
    
    // Combine both analysis results
    const combinedScore = Math.max(staticResult.score, behaviorResult.behavior_score);
    const hasCriticalBehaviors = behaviorResult.behaviors.some(b => b.severity === 'CRITICAL');
    
    let finalStatus = staticResult.status;
    if (hasCriticalBehaviors) finalStatus = 'MALICIOUS';
    if (combinedScore > 70) finalStatus = 'DANGEROUS';
    
    // Set color based on threat level
    let color = "#3fb950"; // Green for Clean
    if (finalStatus === "MALICIOUS" || hasCriticalBehaviors) color = "#f85149"; // Red
    else if (finalStatus === "DANGEROUS" || finalStatus === "SUSPICIOUS") color = "#d29922"; // Yellow
    
    box.style.borderTop = `4px solid ${color}`;
    
    let behaviorHTML = '<h4>Detected Behaviors:</h4><ul style="font-size: 0.85em">';
    behaviorResult.behaviors.slice(0, 5).forEach(b => {
        const severityColor = b.severity === 'CRITICAL' ? '#f85149' : b.severity === 'HIGH' ? '#d29922' : '#58a6ff';
        behaviorHTML += `<li style="color: ${severityColor}"><strong>[${b.severity}]</strong> ${b.description}</li>`;
    });
    behaviorHTML += '</ul>';
    
    box.innerHTML = `
        <h3>Verdict: ${finalStatus}</h3>
        <p><strong>Static Score:</strong> ${staticResult.score}/100 | <strong>Behavior Score:</strong> ${behaviorResult.behavior_score}/100</p>
        ${behaviorHTML}
        <p style="font-size: 0.9em; margin-top: 10px;">Timestamp: ${new Date(behaviorResult.timestamp).toLocaleTimeString()}</p>
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

