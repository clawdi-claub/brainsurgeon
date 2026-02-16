const API = '/api';
let sessions = [];
let currentAgent = 'all';

function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatDuration(mins) {
    if (!mins) return '—';
    if (mins < 1) return '<1m';
    if (mins < 60) return Math.round(mins) + 'm';
    return Math.round(mins / 60) + 'h ' + Math.round(mins % 60) + 'm';
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

async function loadAgents() {
    try {
        const r = await fetch(`${API}/agents`);
        const data = await r.json();
        const filter = document.getElementById('agentFilter');
        filter.innerHTML = '<button class="agent-btn active" data-agent="all">All</button>';
        data.agents.forEach(agent => {
            const btn = document.createElement('button');
            btn.className = 'agent-btn';
            btn.dataset.agent = agent;
            btn.textContent = agent.split('-')[0];
            btn.onclick = () => selectAgent(agent);
            filter.appendChild(btn);
        });
        filter.querySelector('[data-agent="all"]').onclick = () => selectAgent('all');
    } catch (e) {
        console.error('Failed to load agents', e);
    }
}

async function loadSessions() {
    try {
        const url = currentAgent === 'all' ? `${API}/sessions` : `${API}/sessions?agent=${currentAgent}`;
        const r = await fetch(url);
        const data = await r.json();
        sessions = data.sessions;
        renderSessions();
        updateStats(data);
    } catch (e) {
        document.getElementById('sessionGrid').innerHTML = '<div class="empty">Failed to load sessions</div>';
    }
}

function selectAgent(agent) {
    currentAgent = agent;
    document.querySelectorAll('.agent-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.agent === agent);
    });
    loadSessions();
}

function updateStats(data) {
    document.getElementById('statCount').textContent = data.sessions.length;
    document.getElementById('statSize').textContent = formatBytes(data.total_size);
    const totalMsgs = data.sessions.reduce((a, s) => a + s.messages, 0);
    const totalTools = data.sessions.reduce((a, s) => a + s.tool_calls, 0);
    document.getElementById('statMessages').textContent = totalMsgs;
    document.getElementById('statTools').textContent = totalTools;
}

function renderSessions() {
    const grid = document.getElementById('sessionGrid');
    if (sessions.length === 0) {
        grid.innerHTML = '<div class="empty">No sessions found</div>';
        return;
    }

    grid.innerHTML = sessions.map(s => `
        <div class="session-card">
            <div class="session-header">
                <div>
                    <div class="session-id">${s.id}</div>
                    <div class="session-label">${escapeHtml(s.label)}</div>
                </div>
                <span class="session-agent">${s.agent}</span>
            </div>
            <div class="session-stats">
                <div class="session-stat">
                    <div class="session-stat-value">${s.messages}</div>
                    <div class="session-stat-label">Messages</div>
                </div>
                <div class="session-stat">
                    <div class="session-stat-value">${s.tool_calls}</div>
                    <div class="session-stat-label">Tools</div>
                </div>
                <div class="session-stat">
                    <div class="session-stat-value">${formatBytes(s.size)}</div>
                    <div class="session-stat-label">Size</div>
                </div>
            </div>
            <div class="session-meta">
                <span>${formatDuration(s.duration_minutes)}</span>
                <span>${s.updated ? new Date(s.updated).toLocaleString() : '—'}</span>
            </div>
            <div class="session-actions">
                <button class="btn" onclick="viewSession('${s.agent}', '${s.id}')">View</button>
                <button class="btn" onclick="pruneSession('${s.agent}', '${s.id}')">Prune</button>
                <button class="btn btn-danger" onclick="deleteSession('${s.agent}', '${s.id}')">Delete</button>
            </div>
        </div>
    `).join('');
}

async function viewSession(agent, id) {
    document.getElementById('viewModal').classList.add('active');
    document.getElementById('modalTitle').textContent = 'Loading...';
    document.getElementById('modalId').textContent = id;
    document.getElementById('modalBody').innerHTML = '<div class="loading">Loading...</div>';

    try {
        const r = await fetch(`${API}/sessions/${agent}/${id}`);
        const data = await r.json();
        document.getElementById('modalTitle').textContent = data.label || id;
        document.getElementById('modalId').textContent = `${data.agent} • ${formatBytes(data.size)}`;

        document.getElementById('modalBody').innerHTML = data.entries.map((e, i) => `
            <div class="entry">
                <div class="entry-header">
                    <span>#${i} • ${e.role || 'unknown'}</span>
                    <span>${e.timestamp || ''}</span>
                </div>
                <div class="entry-content">${escapeHtml(JSON.stringify(e, null, 2))}</div>
            </div>
        `).join('');
    } catch (e) {
        document.getElementById('modalBody').innerHTML = '<div class="empty">Failed to load session</div>';
    }
}

async function pruneSession(agent, id) {
    if (!confirm('Prune old tool call output? Keeps last 3 calls.')) return;
    try {
        const r = await fetch(`${API}/sessions/${agent}/${id}/prune`, { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({keep_recent: 3}) });
        const data = await r.json();
        alert(`Pruned! Saved ${formatBytes(data.saved_bytes)}`);
        loadSessions();
    } catch (e) {
        alert('Prune failed');
    }
}

async function deleteSession(agent, id) {
    if (!confirm(`Delete session ${id}? This cannot be undone.`)) return;
    try {
        await fetch(`${API}/sessions/${agent}/${id}`, { method: 'DELETE' });
        loadSessions();
    } catch (e) {
        alert('Delete failed');
    }
}

function closeModal() {
    document.getElementById('viewModal').classList.remove('active');
}

document.getElementById('viewModal').onclick = (e) => {
    if (e.target.id === 'viewModal') closeModal();
};

loadAgents();
loadSessions();
