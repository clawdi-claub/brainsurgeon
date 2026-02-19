const API = '/api';
let sessions = [];
let currentAgent = 'all';
let currentStatusFilter = 'all';
let currentTypeFilter = 'all';

// API Key configuration (set via localStorage or input field)
function getApiKey() {
    return localStorage.getItem('brainsurgeon_api_key') || '';
}

function setApiKey(key) {
    if (key) {
        localStorage.setItem('brainsurgeon_api_key', key);
    } else {
        localStorage.removeItem('brainsurgeon_api_key');
    }
}

// Helper to make authenticated API requests
function apiRequest(url, options = {}) {
    const headers = {
        'Content-Type': 'application/json',
        ...options.headers
    };
    const apiKey = getApiKey();
    if (apiKey) {
        headers['X-API-Key'] = apiKey;
    }
    return fetch(url, {
        ...options,
        headers
    });
}

// Format helpers
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

// Custom Modal Dialog
function showCustomModal(title, bodyHtml, footerHtml) {
    document.getElementById('modalTitle').textContent = title;
    document.getElementById('modalBody').innerHTML = bodyHtml;
    document.getElementById('modalFooter').innerHTML = footerHtml;
    document.getElementById('customModal').classList.add('active');
}

function closeCustomModal() {
    document.getElementById('customModal').classList.remove('active');
}

function closeViewModal() {
    stopAutoRefresh();
    document.getElementById('viewModal').classList.remove('active');
}

// Load agents
// Restart OpenClaw dialog
function showRestartDialog() {
    const bodyHtml = `
        <div style="padding: 12px 0;">
            <p>This will restart the OpenClaw gateway process.</p>
            <p style="color: var(--accent-orange); margin-top: 8px;">⚠️ All active sessions will be interrupted and agents will reconnect.</p>
            <dialog-option style="margin-top: 16px; display: flex; align-items: center; gap: 12px;">
                <label style="color: var(--text-secondary); font-size: 0.85rem;">Delay before restart (ms): </label>
                <input type="number" id="restartDelay" value="5000" min="1000" max="60000" step="1000" 
                    style="width: 100px; padding: 6px 10px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg-card); color: var(--text-primary); text-align: center;">
            </dialog-option>
        </div>
    `;
    
    const footerHtml = `
        <button class="btn" onclick="closeCustomModal()">Cancel</button>
        <button class="btn btn-danger" onclick="confirmRestart()">Restart OpenClaw</button>
    `;
    
    showCustomModal('Restart OpenClaw Gateway', bodyHtml, footerHtml);
}

async function confirmRestart() {
    const delay = parseInt(document.getElementById('restartDelay').value) || 5000;
    closeCustomModal();
    
    // Show restarting modal
    const bodyHtml = `
        <div style="text-align: center; padding: 20px;">
            <div class="loading" style="display: inline-block; width: 32px; height: 32px;"></div>
            <p style="margin-top: 12px; color: var(--accent-cyan);">Restarting OpenClaw in ${delay}ms...</p>
        </div>
    `;
    showCustomModal('Restarting...', bodyHtml, '');
    
    try {
        const r = await apiRequest(`${API}/restart`, {
            method: 'POST',
            body: JSON.stringify({delay_ms: delay, note: "Restart triggered from BrainSurgeon"})
        });
        
        if (r.ok) {
            const data = await r.json();
            // Update modal to show success - it will auto-close after a delay
            const successHtml = `
                <div style="text-align: center; padding: 20px;">
                    <div style="font-size: 2rem;">✅</div>
                    <p style="margin-top: 12px; color: var(--accent-green);">Restart initiated successfully!</p>
                    <p style="margin-top: 8px; color: var(--text-secondary); font-size: 0.85rem;">Gateway will restart in ${data.delay_ms}ms.</p>
                </div>
            `;
            document.getElementById('modalBody').innerHTML = successHtml;
            document.getElementById('modalFooter').innerHTML = `<button class="btn" onclick="closeCustomModal()">OK</button>
            `;
            
            // Auto-close after a few seconds
            setTimeout(closeCustomModal, 3000);
        } else {
            throw new Error('Restart failed');
        }
    } catch (e) {
        const errorHtml = `
            <div style="text-align: center; padding: 20px;">
                <div style="font-size: 2rem;">❌</div>
                <p style="margin-top: 12px; color: var(--accent-red);">Restart failed</p>
                <p style="margin-top: 8px; color: var(--text-secondary); font-size: 0.85rem;">${e.message}</p>
            </div>
        `;
        document.getElementById('modalBody').innerHTML = errorHtml;
        document.getElementById('modalFooter').innerHTML = `<button class="btn" onclick="closeCustomModal()">Close</button>
        `;
    }
}

async function loadAgents() {
    try {
        const r = await apiRequest(`${API}/agents`);
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
        
        // Update type filter with agents
        updateTypeFilter(data.agents);
    } catch (e) {
        console.error('Failed to load agents', e);
    }
}

function updateTypeFilter(agents) {
    const typeFilter = document.getElementById('typeFilter');
    typeFilter.innerHTML = '<option value="all">All Types</option>';
    agents.forEach(agent => {
        const opt = document.createElement('option');
        opt.value = agent;
        opt.textContent = agent;
        typeFilter.appendChild(opt);
    });
}

// Load sessions
async function loadSessions() {
    try {
        const url = currentAgent === 'all' ? `${API}/sessions` : `${API}/sessions?agent=${currentAgent}`;
        const r = await apiRequest(url);
        const data = await r.json();
        sessions = data.sessions;
        renderSessions();
        updateStats(data);
        loadTrashCount();
    } catch (e) {
        document.getElementById('sessionGrid').innerHTML = '<div class="empty">Failed to load sessions</div>';
    }
}

async function loadTrashCount() {
    try {
        const r = await apiRequest(`${API}/trash`);
        const data = await r.json();
        document.getElementById('statTrash').textContent = data.sessions.length;
    } catch (e) {
        document.getElementById('statTrash').textContent = '0';
    }
}

// Filter handlers
function selectAgent(agent) {
    currentAgent = agent;
    document.querySelectorAll('.agent-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.agent === agent);
    });
    loadSessions();
}

function applyFilters() {
    currentStatusFilter = document.getElementById('statusFilter').value;
    currentTypeFilter = document.getElementById('typeFilter').value;
    renderSessions();
}

function getFilteredSessions() {
    return sessions.filter(s => {
        if (currentStatusFilter !== 'all' && s.status !== currentStatusFilter) return false;
        if (currentTypeFilter !== 'all' && s.agent !== currentTypeFilter) return false;
        return true;
    });
}

function updateStats(data) {
    document.getElementById('statCount').textContent = data.sessions.length;
    document.getElementById('statSize').textContent = formatBytes(data.total_size);
    const totalMsgs = data.sessions.reduce((a, s) => a + s.messages, 0);
    const totalTools = data.sessions.reduce((a, s) => a + s.tool_calls, 0);
    document.getElementById('statMessages').textContent = totalMsgs;
    document.getElementById('statTools').textContent = totalTools;
}

// Render sessions
function renderSessions() {
    const grid = document.getElementById('sessionGrid');
    const filtered = getFilteredSessions();
    
    if (filtered.length === 0) {
        grid.innerHTML = '<div class="empty">No sessions found</div>';
        return;
    }

    grid.innerHTML = filtered.map(s => {
        const isStale = s.is_stale || s.status === 'stale';
        const staleBadge = isStale ? '<span class="stale-badge">STALE</span>' : '';
        const modelBadge = s.model ? `<span class="session-model">${escapeHtml(s.model)}</span>` : '';
        
        // Flow indication: parent>child relationships
        const parentBadge = s.parentId ? '<span class="flow-badge" title="Child of another session">↩️</span>' : '';
        const childCount = s.children?.length || 0;
        const childBadge = childCount > 0 ? `<span class="flow-badge" title="${childCount} child session(s)">↪️ ${childCount}</span>` : '';
        const flowBadges = parentBadge || childBadge ? `<div class="session-flow">${parentBadge}${childBadge}</div>` : '';
        
        return `
        <div class="session-card ${isStale ? 'stale' : ''}" onclick="viewSession('${s.agent}', '${s.id}')">
            ${staleBadge}
            ${flowBadges}
            <div class="session-header">
                <div>
                    <div class="session-id">${s.id}</div>
                    <div class="session-label">${escapeHtml(s.label)}</div>
                </div>
                <span class="session-agent">${s.agent}</span>
            </div>
            <div class="session-model-row">
                ${modelBadge}
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
                <span class="status-${s.status}">${s.updated ? new Date(s.updated).toLocaleString() : '—'}</span>
            </div>
            <div class="session-actions" onclick="event.stopPropagation()">
                <button class="btn" onclick="viewSession('${s.agent}', '${s.id}')">View</button>
                <button class="btn" onclick="showPruneDialog('${s.agent}', '${s.id}')">Prune</button>
                <button class="btn btn-danger" onclick="showDeleteDialog('${s.agent}', '${s.id}', '${escapeHtml(s.label)}')">Delete</button>
            </div>
        </div>
    `}).join('');
}

// Show prune dialog with custom modal
function showPruneDialog(agent, id) {
    const bodyHtml = `
        <div class="modal-checkbox-group">
            <input type="checkbox" id="keepToolCalls" class="modal-checkbox" checked>
            <label for="keepToolCalls" class="modal-label">Keep tool calls</label>
            <input type="number" id="keepCount" class="modal-input" value="3" min="0" max="100">
            <span class="modal-label">recent calls</span>
        </div>
        <div class="modal-checkbox-group">
            <input type="checkbox" id="lightPrune" class="modal-checkbox">
            <label for="lightPrune" class="modal-label">Light prune (summarize long responses)</label>
        </div>
    `;
    
    const footerHtml = `
        <button class="btn" onclick="closeCustomModal()">Cancel</button>
        <button class="btn" onclick="confirmPrune('${agent}', '${id}')">Prune</button>
    `;
    
    showCustomModal('Prune Session', bodyHtml, footerHtml);
}

async function confirmPrune(agent, id) {
    const keepToolCalls = document.getElementById('keepToolCalls').checked;
    const keepCount = parseInt(document.getElementById('keepCount').value) || 3;
    const lightPrune = document.getElementById('lightPrune').checked;
    
    // Determine keep_recent value
    // -1 = light prune, 0 = remove all, >0 = keep that many
    let keepRecent = keepCount;
    if (lightPrune) keepRecent = -1;
    else if (!keepToolCalls) keepRecent = 0;
    
    closeCustomModal();
    
    try {
        const r = await apiRequest(`${API}/sessions/${agent}/${id}/prune`, {
            method: 'POST',
            body: JSON.stringify({keep_recent: keepRecent})
        });
        const data = await r.json();
        
        // Show result
        const bodyHtml = `<p>Pruned ${data.entries_pruned} entries.</p>
            <p>Saved ${formatBytes(data.saved_bytes)} (${formatBytes(data.original_size)} → ${formatBytes(data.new_size)})</p>
            <p>Mode: ${data.mode}</p>`;
        const footerHtml = `<button class="btn" onclick="closeCustomModal()">OK</button>`;
        showCustomModal('Prune Complete', bodyHtml, footerHtml);
        
        loadSessions();
    } catch (e) {
        alert('Prune failed');
    }
}

// Show delete dialog with custom modal
async function showDeleteDialog(agent, id, label) {
    // Show loading modal first
    const loadingHtml = `
        <div style="text-align: center; padding: 20px;">
            <div class="loading" style="display: inline-block;"></div>
            <p style="margin-top: 12px;">Generating session summary...</p>
        </div>
    `;
    showCustomModal('Delete Session', loadingHtml, '');
    
    // Fetch summary
    let summaryData = null;
    try {
        const r = await apiRequest(`${API}/sessions/${agent}/${id}/summary`);
        if (r.ok) {
            summaryData = await r.json();
        }
    } catch (e) {
        console.error('Failed to generate summary', e);
    }
    
    // Build summary HTML
    let summaryHtml = '';
    if (summaryData && summaryData.summary) {
        const s = summaryData.summary;
        const hasContent = s.key_actions?.length > 0 || s.user_requests?.length > 0 || 
                          s.thinking_insights?.length > 0 || s.tools_used?.length > 0 || 
                          s.models_used?.length > 0;
        
        if (hasContent) {
            summaryHtml = `
                <div class="summary-box" style="
                    background: var(--bg-secondary);
                    border: 1px solid var(--border-color);
                    border-radius: 8px;
                    padding: 16px;
                    margin: 12px 0;
                    font-size: 0.9rem;
                    max-height: 400px;
                    overflow-y: auto;
                ">
                    <h4 style="margin: 0 0 12px 0; color: var(--accent-cyan);">📋 Session Summary</h4>
                    
                    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 8px; margin-bottom: 12px;">
                        <div style="text-align: center; padding: 8px; background: var(--bg-tertiary); border-radius: 4px;">
                            <div style="font-size: 1.2rem; font-weight: 600;">${s.meaningful_messages || s.message_count || 0}</div>
                            <div style="font-size: 0.75rem; color: var(--text-secondary);">Messages</div>
                        </div>
                        <div style="text-align: center; padding: 8px; background: var(--bg-tertiary); border-radius: 4px;">
                            <div style="font-size: 1.2rem; font-weight: 600;">${s.tool_calls || 0}</div>
                            <div style="font-size: 0.75rem; color: var(--text-secondary);">Tool Calls</div>
                        </div>
                        <div style="text-align: center; padding: 8px; background: var(--bg-tertiary); border-radius: 4px;">
                            <div style="font-size: 1.2rem; font-weight: 600;">${s.duration_estimate ? s.duration_estimate + 'm' : '—'}</div>
                            <div style="font-size: 0.75rem; color: var(--text-secondary);">Duration</div>
                        </div>
                    </div>
                    
                    ${s.user_requests?.length ? `
                        <div style="margin-bottom: 10px;">
                            <strong style="color: var(--accent-blue);">💬 User Requests:</strong>
                            <ul style="margin: 4px 0; padding-left: 16px; color: var(--text-secondary);">
                                ${s.user_requests.map(a => `<li>${escapeHtml(a)}</li>`).join('')}
                            </ul>
                        </div>
                    ` : ''}
                    
                    ${s.key_actions?.length ? `
                        <div style="margin-bottom: 10px;">
                            <strong style="color: var(--accent-green);">✓ Key Actions:</strong>
                            <ul style="margin: 4px 0; padding-left: 16px; color: var(--text-secondary);">
                                ${s.key_actions.map(a => `<li>${escapeHtml(a)}</li>`).join('')}
                            </ul>
                        </div>
                    ` : ''}
                    
                    ${s.thinking_insights?.length ? `
                        <div style="margin-bottom: 10px;">
                            <strong style="color: var(--accent-purple);">🧠 Insights:</strong>
                            <ul style="margin: 4px 0; padding-left: 16px; color: var(--text-secondary);">
                                ${s.thinking_insights.map(t => `<li>${escapeHtml(t)}</li>`).join('')}
                            </ul>
                        </div>
                    ` : ''}
                    
                    ${s.tools_used?.length ? `
                        <div style="margin-bottom: 10px;">
                            <strong style="color: var(--accent-yellow);">🔧 Tools:</strong>
                            <span style="color: var(--text-secondary); font-size: 0.85rem;">${s.tools_used.slice(0, 5).join(', ')}${s.tools_used.length > 5 ? ' +' + (s.tools_used.length - 5) + ' more' : ''}</span>
                        </div>
                    ` : ''}
                    
                    ${s.models_used?.length ? `
                        <div style="margin-bottom: 10px;">
                            <strong style="color: var(--accent-cyan);">🤖 Models:</strong>
                            <span style="color: var(--text-secondary); font-size: 0.85rem;">${s.models_used.join(', ')}</span>
                        </div>
                    ` : ''}
                    
                    ${s.errors?.length ? `
                        <div style="margin-bottom: 10px;">
                            <strong style="color: var(--accent-red);">⚠ Errors:</strong>
                            <ul style="margin: 4px 0; padding-left: 16px; color: var(--accent-orange); font-size: 0.85rem;">
                                ${s.errors.map(e => `<li>${escapeHtml(e)}</li>`).join('')}
                            </ul>
                        </div>
                    ` : ''}
                    
                    ${s.has_git_commits ? '<div style="color: var(--accent-green);">✓ Git commits made</div>' : ''}
                    ${s.files_created?.length ? `<div style="color: var(--accent-cyan); font-size: 0.85rem;">📝 Files: ${s.files_created.slice(0, 3).join(', ')}</div>` : ''}
                </div>
            `;
        } else {
            summaryHtml = `<p style="color: var(--text-secondary);">No meaningful content found (session may contain mostly automated/heartbeat messages).</p>`;
        }
    }
    
    const bodyHtml = `
        <p>Delete session <strong>${escapeHtml(label)}</strong>?</p>
        ${summaryHtml}
        <p style="margin-top: 12px; color: var(--text-secondary)">This will move the session to trash. It will be automatically purged after 14 days.</p>
        <p style="margin-top: 8px; color: var(--accent-orange)">Child sessions will also be deleted.</p>
    `;
    
    const footerHtml = `
        <button class="btn" onclick="closeCustomModal()">Cancel</button>
        <button class="btn btn-danger" onclick="confirmDelete('${agent}', '${id}')">Delete</button>
    `;
    
    showCustomModal('Delete Session', bodyHtml, footerHtml);
}

async function confirmDelete(agent, id) {
    closeCustomModal();

    try {
        await apiRequest(`${API}/sessions/${agent}/${id}`, { method: 'DELETE' });
        loadSessions();
    } catch (e) {
        alert('Delete failed');
    }
}

function toggleMetadata() {
    const content = document.getElementById('metadataContent');
    const toggle = document.querySelector('.metadata-toggle');
    const isExpanded = content.classList.contains('expanded');
    content.classList.toggle('expanded', !isExpanded);
    content.style.display = isExpanded ? 'none' : 'block';
    toggle.classList.toggle('expanded', !isExpanded);
}

function isMobile() {
    return window.innerWidth <= 768;
}

function copySessionId() {
    const fullId = window._currentSessionId;
    if (!fullId) return;
    
    navigator.clipboard.writeText(fullId).then(() => {
        const btn = document.getElementById('modalIdCopyBtn');
        if (btn) {
            btn.classList.add('copied');
            btn.innerHTML = '<span class="material-icons-round">check</span>';
            setTimeout(() => {
                btn.classList.remove('copied');
                btn.innerHTML = '<span class="material-icons-round">content_copy</span>';
            }, 1500);
        }
    }).catch(err => {
        // Fallback for older browsers
        const textarea = document.createElement('textarea');
        textarea.value = fullId;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        try {
            document.execCommand('copy');
            const btn = document.getElementById('modalIdCopyBtn');
            if (btn) {
                btn.classList.add('copied');
                btn.innerHTML = '<span class="material-icons-round">check</span>';
                setTimeout(() => {
                    btn.classList.remove('copied');
                    btn.innerHTML = '<span class="material-icons-round">content_copy</span>';
                }, 1500);
            }
        } catch (e) {
            console.error('Copy failed:', e);
        }
        document.body.removeChild(textarea);
    });
}

// View mode state for each entry
const entryViewModes = {};

// Entry filter and sort state
let currentEntryTypeFilter = 'all';
let currentEntrySortOrder = 'newest';
let currentSessionData = null;
let autoRefreshInterval = null;
let isUserAtTop = true;

function toggleEntryView(entryIndex) {
    const currentMode = entryViewModes[entryIndex] || 'normal';
    const newMode = currentMode === 'normal' ? 'raw' : 'normal';
    entryViewModes[entryIndex] = newMode;
    
    const btnNormal = document.getElementById(`btn-normal-${entryIndex}`);
    const btnRaw = document.getElementById(`btn-raw-${entryIndex}`);
    const contentNormal = document.getElementById(`content-normal-${entryIndex}`);
    const contentRaw = document.getElementById(`content-raw-${entryIndex}`);
    
    if (btnNormal && btnRaw) {
        btnNormal.classList.toggle('active', newMode === 'normal');
        btnRaw.classList.toggle('active', newMode === 'raw');
    }
    
    if (contentNormal && contentRaw) {
        contentNormal.style.display = newMode === 'normal' ? 'block' : 'none';
        contentRaw.style.display = newMode === 'raw' ? 'block' : 'none';
    }
}

function setEntryViewMode(entryIndex, mode) {
    entryViewModes[entryIndex] = mode;
    
    const btnNormal = document.getElementById(`btn-normal-${entryIndex}`);
    const btnRaw = document.getElementById(`btn-raw-${entryIndex}`);
    const contentNormal = document.getElementById(`content-normal-${entryIndex}`);
    const contentRaw = document.getElementById(`content-raw-${entryIndex}`);
    
    if (btnNormal && btnRaw) {
        btnNormal.classList.toggle('active', mode === 'normal');
        btnRaw.classList.toggle('active', mode === 'raw');
    }
    
    if (contentNormal && contentRaw) {
        contentNormal.style.display = mode === 'normal' ? 'block' : 'none';
        contentRaw.style.display = mode === 'raw' ? 'block' : 'none';
    }
}

function formatJsonHtml(obj, indent = 0) {
    const spaces = '  '.repeat(indent);
    if (obj === null) return '<span class="json-null">null</span>';
    if (typeof obj === 'boolean') return `<span class="json-boolean">${obj}</span>`;
    if (typeof obj === 'number') return `<span class="json-number">${obj}</span>`;
    if (typeof obj === 'string') return `<span class="json-string">"${escapeHtml(obj)}"</span>`;
    
    if (Array.isArray(obj)) {
        if (obj.length === 0) return '[]';
        const items = obj.map(item => spaces + '  ' + formatJsonHtml(item, indent + 1)).join(',\n');
        return `[\n${items}\n${spaces}]`;
    }
    
    if (typeof obj === 'object') {
        const keys = Object.keys(obj);
        if (keys.length === 0) return '{}';
        const items = keys.map(key => {
            const val = formatJsonHtml(obj[key], indent + 1);
            return `${spaces}  <span class="json-key">"${escapeHtml(key)}"</span>: ${val}`;
        }).join(',\n');
        return `{\n${items}\n${spaces}}`;
    }
    
    return String(obj);
}

function renderEntryContentNormal(entry) {
    if (entry._pruned) {
        return '<span style="color: var(--accent-yellow)">[pruned]</span>';
    }
    
    try {
        // For message entries
        if (entry.type === 'message') {
            const msg = entry.message || {};
            let content = msg.content;
            let html = '';
            
            // Role badge
            if (msg.role) {
                const roleClass = msg.role === 'user' ? 'role-user' : msg.role === 'assistant' ? 'role-assistant' : 'role-system';
                html += `<div class="message-role ${roleClass}">${escapeHtml(msg.role)}</div>`;
            }
            
            // Handle content
            if (typeof content === 'string') {
                html += `<div class="content-text">${escapeHtml(content).replace(/\n/g, '<br>')}</div>`;
            } else if (Array.isArray(content)) {
                content.forEach(item => {
                    if (item.type === 'text') {
                        const text = item.text || '';
                        html += `<div class="content-text">${escapeHtml(text).replace(/\n/g, '<br>')}</div>`;
                    } else if (item.type === 'thinking') {
                        const thinking = item.thinking || '';
                        html += `<details class="thinking-block"><summary>🧠 Thinking</summary><div class="thinking-content">${escapeHtml(thinking).replace(/\n/g, '<br>')}</div></details>`;
                    } else if (item.type === 'toolCall') {
                        const name = item.name || item.function?.name || 'unknown';
                        const args = item.arguments || item.function?.arguments || '{}';
                        const argsObj = typeof args === 'string' ? JSON.parse(args) : args;
                        html += renderKeyValueList({ 'Tool': name, 'Arguments': argsObj }, 0);
                    } else if (item.type === 'toolResult') {
                        const text = item.text || '';
                        html += `<details class="tool-result-block"><summary>📥 Tool Result</summary><div class="tool-result-content">${escapeHtml(text).replace(/\n/g, '<br>')}</div></details>`;
                    } else {
                        html += renderKeyValueList(item, 0);
                    }
                });
            } else if (typeof content === 'object' && content !== null) {
                html += renderKeyValueList(content, 0);
            }
            
            // Render other message properties
            const otherProps = {};
            for (const [key, val] of Object.entries(msg)) {
                if (key !== 'role' && key !== 'content') {
                    otherProps[key] = val;
                }
            }
            if (Object.keys(otherProps).length > 0) {
                html += renderKeyValueList(otherProps, 0, true);
            }
            
            return html;
        }
        
        // For tool entries
        if (entry.type === 'tool' || entry.type === 'toolCall') {
            const name = entry.name || entry.function?.name || 'unknown';
            const args = entry.arguments || entry.function?.arguments || '{}';
            const argsObj = typeof args === 'string' ? JSON.parse(args) : args;
            return renderKeyValueList({ 'Tool': name, 'Arguments': argsObj }, 0);
        }
        
        // For tool_result entries
        if (entry.type === 'tool_result' || entry.type === 'toolResult') {
            const content = entry.content;
            if (Array.isArray(content)) {
                let html = '';
                content.forEach(item => {
                    if (item.type === 'text') {
                        html += `<div class="content-text">${escapeHtml(item.text || '').replace(/\n/g, '<br>')}</div>`;
                    } else {
                        html += renderKeyValueList(item, 0);
                    }
                });
                return html;
            } else if (typeof content === 'string') {
                return `<div class="content-text">${escapeHtml(content).replace(/\n/g, '<br>')}</div>`;
            } else if (typeof content === 'object' && content !== null) {
                return renderKeyValueList(content, 0);
            }
        }
        
        // For system/custom entries - render as key/value list
        return renderKeyValueList(entry, 0);
    } catch (e) {
        return escapeHtml(String(entry));
    }
}

function renderKeyValueList(obj, depth = 0, isNested = false) {
    if (obj === null) return '<span class="kv-null">null</span>';
    if (typeof obj === 'boolean') return `<span class="kv-boolean">${obj}</span>`;
    if (typeof obj === 'number') return `<span class="kv-number">${obj}</span>`;
    if (typeof obj === 'string') {
        // Check if it's multiline
        if (obj.includes('\n')) {
            return `<div class="kv-multiline">${escapeHtml(obj).replace(/\n/g, '<br>')}</div>`;
        }
        return `<span class="kv-string">${escapeHtml(obj)}</span>`;
    }
    
    if (Array.isArray(obj)) {
        if (obj.length === 0) return '<span class="kv-empty">[]</span>';
        const items = obj.map((item, i) => {
            const rendered = renderKeyValueList(item, depth + 1, true);
            if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
                return `<div class="kv-array-item">${rendered}</div>`;
            }
            return `<div class="kv-array-item"><span class="kv-index">${i}:</span> ${rendered}</div>`;
        }).join('');
        return `<div class="kv-array" style="margin-left: ${depth * 12}px">${items}</div>`;
    }
    
    if (typeof obj === 'object') {
        const keys = Object.keys(obj);
        if (keys.length === 0) return '<span class="kv-empty">{}</span>';
        
        const items = keys.map(key => {
            const val = obj[key];
            const rendered = renderKeyValueList(val, depth + 1, true);
            return `<div class="kv-item"><span class="kv-key">${escapeHtml(key)}:</span> ${rendered}</div>`;
        }).join('');
        
        const className = isNested ? 'kv-nested' : 'kv-root';
        return `<div class="${className}" style="margin-left: ${depth * 12}px">${items}</div>`;
    }
    
    return escapeHtml(String(obj));
}

function renderEntryContentRaw(entry) {
    const jsonStr = JSON.stringify(entry, null, 2);
    return `<pre class="raw-json-view">${formatJsonHtml(entry)}</pre>`;
}

function applyEntryTypeFilter() {
    currentEntryTypeFilter = document.getElementById('entryTypeFilter').value;
    if (currentSessionData) {
        renderSessionBody(currentSessionData);
    }
}

function applyEntrySortOrder() {
    currentEntrySortOrder = document.getElementById('entrySortOrder').value;
    if (currentSessionData) {
        renderSessionBody(currentSessionData);
    }
}

function filterEntriesByType(entries) {
    if (currentEntryTypeFilter === 'all') return entries;
    
    return entries.filter(e => {
        const type = e.type || '';
        if (currentEntryTypeFilter === 'message') return type === 'message';
        if (currentEntryTypeFilter === 'tool') return type === 'tool' || type === 'toolCall';
        if (currentEntryTypeFilter === 'tool_result') return type === 'tool_result' || type === 'toolResult';
        if (currentEntryTypeFilter === 'thinking') return type === 'thinking_level_change' || (type === 'message' && e.message?.content?.some(c => c.type === 'thinking'));
        if (currentEntryTypeFilter === 'custom') return type === 'custom';
        return true;
    });
}

function sortEntries(entries) {
    if (currentEntrySortOrder === 'oldest') {
        return [...entries]; // Already in oldest-first order
    }
    // Newest first - reverse the array
    return [...entries].reverse();
}

function getEntryType(entry) {
    const type = entry.type || '';
    if (type === 'message') {
        const msg = entry.message || {};
        const role = msg.role || '';
        const content = msg.content;
        
        // Check if this message contains tool calls
        if (msg.tool_calls && msg.tool_calls.length > 0) {
            return 'tool';
        }
        // Check for toolCall in content array (OpenClaw format)
        if (Array.isArray(content) && content.some(c => c && c.type === 'toolCall')) {
            return 'tool';
        }
        // Check if this is a tool result message
        if (role === 'toolResult') {
            return 'tool_result';
        }
        // Check for tool result in content array
        if (Array.isArray(content) && content.some(c => c && c.type === 'toolResult')) {
            return 'tool_result';
        }
        // Check if this message contains thinking
        if (Array.isArray(content) && content.some(c => c && c.type === 'thinking')) {
            return 'thinking';
        }
        return 'message';
    }
    if (type === 'tool' || type === 'toolCall') return 'tool';
    if (type === 'tool_result' || type === 'toolResult') return 'tool_result';
    if (type === 'thinking_level_change') return 'thinking';
    if (type === 'custom') return 'custom';
    return type;
}

function filterGroupByType(group) {
    if (currentEntryTypeFilter === 'all') return true;

    if (group.type === 'tool_pair') {
        // Tool pair contains both tool call and result
        if (currentEntryTypeFilter === 'tool') return true;
        if (currentEntryTypeFilter === 'tool_result') return true;
        return false;
    }

    const entry = group.entry;
    const entryType = getEntryType(entry);

    if (currentEntryTypeFilter === 'message') {
        // Show only pure messages (not tool calls/results/thinking)
        return entryType === 'message';
    }
    if (currentEntryTypeFilter === 'tool') {
        return entryType === 'tool';
    }
    if (currentEntryTypeFilter === 'tool_result') {
        return entryType === 'tool_result';
    }
    if (currentEntryTypeFilter === 'thinking') {
        return entryType === 'thinking' ||
            (entry.type === 'thinking_level_change') ||
            (entry.type === 'message' && entry.message?.content?.some(c => c.type === 'thinking'));
    }
    if (currentEntryTypeFilter === 'custom') {
        return entryType === 'custom';
    }
    return true;
}

function renderSessionBody(data) {
    // Store entries for editing (keep original indices)
    window._currentEntries = data.entries;
    currentSessionData = data;

    // Group tool calls with results (on ORIGINAL entries in chronological order)
    let groupedEntries = groupToolCalls(data.entries);
    
    // Apply type filter to groups
    if (currentEntryTypeFilter !== 'all') {
        groupedEntries = groupedEntries.filter(filterGroupByType);
    }
    
    // Sort groups (newest first or oldest first)
    if (currentEntrySortOrder === 'newest') {
        groupedEntries = [...groupedEntries].reverse();
    }
    
    // Build entry ID to index map for parent/child linking
    const entryIdToIndex = {};
    data.entries.forEach((entry, idx) => {
        if (entry.id) {
            entryIdToIndex[entry.id] = idx;
        }
    });
    
    // Find which entries are children of other entries (for visual indentation)
    // Note: We don't skip them - we just indent them visually under their parent
    const entryParentIndices = {};
    data.entries.forEach((entry, idx) => {
        if (entry.parentId && entryIdToIndex[entry.parentId] !== undefined) {
            entryParentIndices[idx] = entryIdToIndex[entry.parentId];
        }
    });
    
    document.getElementById('modalBody2').innerHTML = groupedEntries.map((group) => {
        let entryIndex, entry;
        
        if (group.type === 'tool_pair') {
            entryIndex = group.callIndex;
            entry = group.call;
        } else {
            entryIndex = group.index;
            entry = group.entry;
        }
        
        // Check if this entry should be indented (has a parent entry)
        const parentIndex = entryParentIndices[entryIndex];
        const indentLevel = parentIndex !== undefined ? 1 : 0;
        
        const indentStyle = indentLevel > 0 ? 'margin-left: 24px; border-left: 2px dashed var(--accent-purple); padding-left: 12px;' : '';
        
        if (group.type === 'tool_pair') {
            // Tool call + result pair grouped together
            return `
            <div class="entry-group tool-pair-group" style="${indentStyle}">
                <div class="group-label">🔧 → 📥</div>
                ${renderEntryWithToggle(group.call, group.callIndex, data.agent, data.id)}
                ${renderEntryWithToggle(group.result, group.resultIndex, data.agent, data.id)}
            </div>
            `;
        } else {
            // Regular entry with optional indentation
            return `<div style="${indentStyle}">${renderEntryWithToggle(group.entry, entryIndex, data.agent, data.id)}</div>`;
        }
    }).join('');
}

function renderEntryWithToggle(entry, index, agent, sessionId) {
    const typeLabel = getEntryTypeLabel(entry);
    const timestamp = entry.timestamp || '';
    
    return `
    <div class="entry ${entry._pruned ? 'pruned' : ''}" data-entry-index="${index}">
        <div class="entry-header">
            <span class="entry-type">${typeLabel}</span>
            <div class="entry-header-right">
                <span class="entry-timestamp">${timestamp}</span>
                <div class="entry-view-toggle">
                    <button class="toggle-btn active" id="btn-normal-${index}" onclick="setEntryViewMode(${index}, 'normal')">normal</button>
                    <button class="toggle-btn" id="btn-raw-${index}" onclick="setEntryViewMode(${index}, 'raw')">raw</button>
                </div>
            </div>
        </div>
        <div class="entry-content-wrapper">
            <div id="content-normal-${index}" class="entry-content-normal">
                ${renderEntryContentNormal(entry)}
            </div>
            <div id="content-raw-${index}" class="entry-content-raw" style="display: none;">
                ${renderEntryContentRaw(entry)}
            </div>
        </div>
        <div class="entry-actions" onclick="event.stopPropagation()">
            <button class="btn btn-small" onclick="editEntry('${agent}', '${sessionId}', ${index})">Edit</button>
            <button class="btn btn-small btn-danger" onclick="deleteEntry('${agent}', '${sessionId}', ${index})">Delete</button>
        </div>
    </div>
    `;
}

// Current view session for auto-refresh
let currentViewSession = { agent: null, id: null };

// Track scroll position
function setupScrollTracking() {
    const modalBody = document.getElementById('modalBody2');
    if (!modalBody) return;
    
    modalBody.addEventListener('scroll', () => {
        isUserAtTop = modalBody.scrollTop < 50;
    });
}

// Auto-refresh session view
function startAutoRefresh(agent, id) {
    stopAutoRefresh(); // Clear any existing interval
    currentViewSession = { agent, id };
    
    const indicator = document.getElementById('autoRefreshIndicator');
    if (indicator) indicator.style.display = 'flex';
    
    autoRefreshInterval = setInterval(async () => {
        if (!document.getElementById('viewModal').classList.contains('active')) {
            stopAutoRefresh();
            return;
        }
        
        try {
            const r = await apiRequest(`${API}/sessions/${agent}/${id}`);
            if (!r.ok) return;
            const data = await r.json();
            
            // Only update if there are new entries
            if (currentSessionData && data.entries.length > currentSessionData.entries.length) {
                const modalBody = document.getElementById('modalBody2');
                const wasAtTop = isUserAtTop;
                const scrollHeight = modalBody.scrollHeight;
                
                // Update the data but keep filter/sort settings
                currentSessionData = data;
                renderSessionBody(data);
                
                // Restore scroll position unless user was at top
                if (!wasAtTop) {
                    modalBody.scrollTop = modalBody.scrollHeight - scrollHeight;
                }
            }
        } catch (e) {
            // Silent fail on auto-refresh
        }
    }, 10000); // 10 seconds
}

function stopAutoRefresh() {
    if (autoRefreshInterval) {
        clearInterval(autoRefreshInterval);
        autoRefreshInterval = null;
    }
    const indicator = document.getElementById('autoRefreshIndicator');
    if (indicator) indicator.style.display = 'none';
}

// View session - DEFAULT to view now
async function viewSession(agent, id) {
    stopAutoRefresh();
    currentViewSession = { agent, id };
    
    // Store full ID for clipboard copy
    window._currentSessionId = id;
    
    document.getElementById('viewModal').classList.add('active');
    document.getElementById('modalTitle2').textContent = 'Loading...';
    
    // Set truncated session ID with ellipsis
    const truncatedId = id.length > 20 ? id.substring(0, 8) + '...' + id.substring(id.length - 4) : id;
    document.getElementById('modalId').textContent = truncatedId;
    document.getElementById('modalId').title = id; // Full ID on hover
    document.getElementById('modalModels').textContent = '';
    document.getElementById('modalBody2').innerHTML = '<div class="loading">Loading...</div>';
    
    // Auto-collapse metadata on mobile to save space
    if (isMobile()) {
        const content = document.getElementById('metadataContent');
        const toggle = document.querySelector('.metadata-toggle');
        if (content) content.style.display = 'none';
        if (toggle) toggle.classList.remove('expanded');
    }
    
    // Setup scroll tracking
    setTimeout(setupScrollTracking, 100);

    try {
        const r = await apiRequest(`${API}/sessions/${agent}/${id}`);
        const data = await r.json();

        // Update header
        document.getElementById('modalTitle2').textContent = data.label || id;
        document.getElementById('modalId').textContent = id;

        // Update details panel
        document.getElementById('detailAgent').textContent = data.agent || agent;
        document.getElementById('detailSize').textContent = formatBytes(data.size);
        document.getElementById('detailMessages').textContent = data.messages || 0;
        document.getElementById('detailTools').textContent = data.tool_calls || 0;
        document.getElementById('detailDuration').textContent = formatDuration(data.duration_minutes);
        document.getElementById('detailCreated').textContent = data.created ? new Date(data.created).toLocaleString() : '—';
        document.getElementById('detailUpdated').textContent = data.updated ? new Date(data.updated).toLocaleString() : '—';
        document.getElementById('detailStatus').textContent = data.is_stale ? '⭐ Stale' : '🟢 Active';
        document.getElementById('detailStatus').className = 'detail-value ' + (data.is_stale ? 'status-stale' : 'status-active');

        // Update models used - only active model is green
        const models = [];
        const modelSet = new Set();
        data.entries?.forEach(e => {
            if (e.type === 'custom' && e.customType === 'model-snapshot') {
                const modelId = e.data?.modelId || e.data?.model;
                if (modelId && !modelSet.has(modelId)) {
                    modelSet.add(modelId);
                    models.push(modelId);
                }
            } else if (e.type === 'message') {
                const msg = e.message || {};
                if (msg.model && !modelSet.has(msg.model)) {
                    modelSet.add(msg.model);
                    models.push(msg.model);
                }
            }
        });
        
        // Show models in header - only active is green
        if (models.length > 0) {
            const activeModel = models[models.length - 1];
            document.getElementById('modalModels').innerHTML = models.slice(-3).map((m, idx) => {
                const isActive = idx === models.length - 1 || (models.length > 3 && idx === 2);
                const className = isActive ? 'session-model' : 'session-model inactive';
                const displayModel = m.split('/').pop().substring(0, 20);
                return `<span class="${className}">${escapeHtml(displayModel)}</span>`;
            }).join(' ');
        }

        // Parent/child relationships
        const parentRow = document.getElementById('detailParentRow');
        const parentEl = document.getElementById('detailParent');
        if (data.parentId) {
            parentRow.style.display = 'flex';
            parentEl.innerHTML = `<a href="#" onclick="viewSession('${agent}', '${data.parentId}'); return false;">${data.parentId.substring(0, 8)}</a>`;
        } else {
            parentRow.style.display = 'none';
        }

        const childrenRow = document.getElementById('detailChildrenRow');
        const childrenEl = document.getElementById('detailChildren');
        if (data.children && data.children.length > 0) {
            childrenRow.style.display = 'flex';
            childrenEl.innerHTML = data.children.map(child =>
                `<a href="#" onclick="viewSession('${agent}', '${child.sessionId}'); return false;">${child.sessionId.substring(0, 8)}</a>`
            ).join(', ');
        } else {
            childrenRow.style.display = 'none';
        }

        // Store entries for editing
        window._currentEntries = data.entries;

        // Update metadata section
        document.getElementById('metaSessionId').textContent = data.id;
        const channelEl = document.getElementById('metaChannel');
        if (channelEl) channelEl.textContent = data.channel || '—';
        
        document.getElementById('metaStarted').textContent = data.created ? new Date(data.created).toLocaleString() : '—';
        document.getElementById('metaLastInteraction').textContent = data.updated ? new Date(data.updated).toLocaleString() : '—';
        
        const tokensEl = document.getElementById('metaTokens');
        if (tokensEl) tokensEl.textContent = data.tokens ? data.tokens.toLocaleString() : '—';
        
        const contextTokensEl = document.getElementById('metaContextTokens');
        if (contextTokensEl) contextTokensEl.textContent = data.contextTokens ? data.contextTokens.toLocaleString() : '—';
        
        // Show resolved skills as tags
        const skillsEl = document.getElementById('metaSkills');
        if (skillsEl) {
            if (data.resolvedSkills && data.resolvedSkills.length > 0) {
                skillsEl.innerHTML = data.resolvedSkills.map(s => `<span class="skill-tag">${escapeHtml(s)}</span>`).join(' ');
            } else {
                skillsEl.textContent = '—';
            }
        }
        
        // System prompt report as formatted JSON
        const sysPromptEl = document.getElementById('metaSystemPrompt');
        if (sysPromptEl) {
            if (data.systemPromptReport) {
                sysPromptEl.textContent = typeof data.systemPromptReport === 'string' 
                    ? data.systemPromptReport 
                    : JSON.stringify(data.systemPromptReport, null, 2);
            } else {
                sysPromptEl.textContent = '—';
            }
        }
        
        const historyEl = document.getElementById('metaHistory');
        if (historyEl) historyEl.textContent = data.history ? JSON.stringify(data.history, null, 2) : '—';

        // Render body based on current view mode
        renderSessionBody(data);
        
        // Start auto-refresh for active sessions
        if (!data.is_stale) {
            startAutoRefresh(agent, id);
        }
    } catch (e) {
        document.getElementById('modalBody2').innerHTML = '<div class="empty">Failed to load session</div>';
    }
}

function groupToolCalls(entries) {
    const grouped = [];
    let i = 0;
    
    while (i < entries.length) {
        const entry = entries[i];
        
        // Check if this is a tool call
        let isToolCall = false;
        let toolId = null;
        
        if (entry.type === 'tool') {
            isToolCall = true;
            toolId = entry.id || entry.call_id;
        } else if (entry.type === 'message') {
            const msg = entry.message || {};
            if (msg.tool_calls && msg.tool_calls.length > 0) {
                isToolCall = true;
                toolId = msg.tool_calls[0].id;
            }
        }
        
        if (isToolCall) {
            // Look for the corresponding result
            let result = null;
            let resultIndex = -1;

            for (let j = i + 1; j < entries.length; j++) {
                const next = entries[j];

                // Check for standalone tool_result entries
                if (next.type === 'tool_result') {
                    if (next.id === toolId || next.call_id === toolId) {
                        result = next;
                        resultIndex = j;
                        break;
                    }
                }
                // Check for tool results embedded in messages
                else if (next.type === 'message') {
                    const msg = next.message || {};
                    if (msg.role === 'toolResult') {
                        result = next;
                        resultIndex = j;
                        break;
                    }
                }
            }

            if (result) {
                grouped.push({ type: 'tool_pair', call: entry, result: result, callIndex: i, resultIndex: resultIndex });
                i = resultIndex + 1;
            } else {
                grouped.push({ type: 'single', entry: entry, index: i });
                i++;
            }
        } else {
            grouped.push({ type: 'single', entry: entry, index: i });
            i++;
        }
    }
    
    return grouped;
}

function getEntryTypeLabel(entry) {
    if (entry.type === 'message') {
        const role = entry.message?.role || 'unknown';
        const icons = { user: '👤', assistant: '🤖', system: '⚙️', toolResult: '📥' };
        return (icons[role] || '❓') + ' ' + role;
    }
    if (entry.type === 'tool') return '🔧 Tool Call';
    if (entry.type === 'tool_result') return '📥 Tool Result';
    if (entry.type === 'session') return '📋 Session';
    if (entry.type === 'thinking_level_change') return '🧠 Thinking';
    if (entry.type === 'custom') return '⚡ ' + (entry.customType || 'Custom');
    return '❓ ' + (entry.type || 'unknown');
}

function formatEntryContent(entry) {
    if (entry._pruned) {
        return '<span style="color: var(--accent-yellow)">[pruned]</span>';
    }
    
    try {
        // For message entries
        if (entry.type === 'message') {
            const msg = entry.message || {};
            let content = msg.content;
            
            if (typeof content === 'string') {
                return escapeHtml(content);
            } else if (Array.isArray(content)) {
                // Handle content array (tool calls, etc.)
                return escapeHtml(JSON.stringify(content, null, 2));
            }
            return escapeHtml(JSON.stringify(content, null, 2));
        }
        
        // For tool/tool_result entries
        return escapeHtml(JSON.stringify(entry, null, 2));
    } catch (e) {
        return escapeHtml(String(entry));
    }
}

// Edit entry
function editEntry(agent, sessionId, index) {
    const entry = getEntryAtIndex(index);
    if (!entry) return;
    
    const bodyHtml = `
        <textarea id="editEntryContent" class="modal-input" style="width: 100%; height: 300px; font-family: monospace;">${escapeHtml(JSON.stringify(entry, null, 2))}</textarea>
    `;
    
    const footerHtml = `
        <button class="btn" onclick="closeCustomModal()">Cancel</button>
        <button class="btn" onclick="saveEntry('${agent}', '${sessionId}', ${index})">Save</button>
    `;
    
    showCustomModal(`Edit Entry #${index}`, bodyHtml, footerHtml);
}

function getEntryAtIndex(index) {
    // We need to fetch the session again or keep it in memory
    // For simplicity, we'll use the current modal data
    const entries = window._currentEntries;
    return entries ? entries[index] : null;
}

async function saveEntry(agent, sessionId, index) {
    const content = document.getElementById('editEntryContent').value;

    try {
        const entry = JSON.parse(content);
        const r = await apiRequest(`${API}/sessions/${agent}/${sessionId}/entries/${index}`, {
            method: 'PUT',
            body: JSON.stringify({ index: index, entry: entry })
        });

        if (r.ok) {
            closeCustomModal();
            viewSession(agent, sessionId); // Refresh
        } else {
            alert('Failed to save entry');
        }
    } catch (e) {
        alert('Invalid JSON');
    }
}

// Delete single entry
async function deleteEntry(agent, sessionId, index) {
    if (!confirm(`Delete entry #${index}?`)) return;

    // For now, we'll just truncate the content
    // Full delete would require re-writing the file
    try {
        const entry = getEntryAtIndex(index);
        entry._deleted = true;
        entry.content = '[deleted]';

        await apiRequest(`${API}/sessions/${agent}/${sessionId}/entries/${index}`, {
            method: 'PUT',
            body: JSON.stringify({ index: index, entry: entry })
        });

        viewSession(agent, sessionId);
    } catch (e) {
        alert('Failed to delete entry');
    }
}

// Modal click-outside to close
document.getElementById('customModal').onclick = (e) => {
    if (e.target.id === 'customModal') closeCustomModal();
};

document.getElementById('viewModal').onclick = (e) => {
    if (e.target.id === 'viewModal') closeViewModal();
};

// Filter event listeners
document.getElementById('statusFilter').addEventListener('change', applyFilters);
document.getElementById('typeFilter').addEventListener('change', applyFilters);

// Trash view functions
function openTrashView() {
    document.getElementById('trashModal').classList.add('active');
    loadTrashSessions();
}

function closeTrashModal() {
    document.getElementById('trashModal').classList.remove('active');
}

async function loadTrashSessions() {
    const body = document.getElementById('trashBody');
    body.innerHTML = '<div class="loading">Loading trashed sessions...</div>';

    try {
        const r = await apiRequest(`${API}/trash`);
        const data = await r.json();
        
        if (!data.sessions || data.sessions.length === 0) {
            body.innerHTML = '<div class="empty">Trash is empty</div>';
            return;
        }
        
        body.innerHTML = `
            <div class="trash-list">
                ${data.sessions.map(s => {
                    const trashedAt = s.trashed_at ? new Date(s.trashed_at).toLocaleString() : '—';
                    const expiresAt = s.expires_at ? new Date(s.expires_at).toLocaleDateString() : '—';
                    return `
                    <div class="trash-item">
                        <div class="trash-info">
                            <div class="trash-session-id">${s.original_session_id}</div>
                            <div class="trash-agent">${s.original_agent}</div>
                            <div class="trash-meta">
                                <span>Trashed: ${trashedAt}</span>
                                <span class="trash-expires">Expires: ${expiresAt}</span>
                            </div>
                        </div>
                        <div class="trash-actions">
                            <button class="btn" onclick="restoreSession('${s.original_agent}', '${s.original_session_id}')">♻️ Restore</button>
                            <button class="btn btn-danger" onclick="permanentDeleteSession('${s.original_agent}', '${s.original_session_id}')">🗑️ Delete</button>
                        </div>
                    </div>
                    `;
                }).join('')}
            </div>
        `;
    } catch (e) {
        body.innerHTML = '<div class="empty">Failed to load trash</div>';
    }
}

async function restoreSession(agent, sessionId) {
    if (!confirm(`Restore session ${sessionId}?`)) return;

    try {
        const r = await apiRequest(`${API}/trash/${agent}/${sessionId}/restore`, { method: 'POST' });
        if (r.ok) {
            loadTrashSessions();
            loadSessions();
        } else {
            alert('Restore failed');
        }
    } catch (e) {
        alert('Restore failed');
    }
}

async function permanentDeleteSession(agent, sessionId) {
    if (!confirm(`Permanently delete session ${sessionId}? This cannot be undone.`)) return;

    try {
        const r = await apiRequest(`${API}/trash/${agent}/${sessionId}`, { method: 'DELETE' });
        if (r.ok) {
            loadTrashSessions();
            loadTrashCount();
        } else {
            alert('Delete failed');
        }
    } catch (e) {
        alert('Delete failed');
    }
}

document.getElementById('trashModal').onclick = (e) => {
    if (e.target.id === 'trashModal') closeTrashModal();
};

// Initial load
loadAgents();
loadSessions();

// Show API key required banner if loading fails
function showApiKeyBanner(show) {
    const banner = document.getElementById('apiKeyBanner');
    if (banner) {
        banner.style.display = show ? 'flex' : 'none';
    }
}

// Check if API requires authentication
async function checkApiAuth() {
    try {
        const r = await apiRequest(`${API}/agents`);
        if (r.status === 403) {
            showApiKeyBanner(true);
            // Clear the grid - banner shows the message
            document.getElementById('sessionGrid').innerHTML = '';
            return false;
        } else if (r.ok) {
            showApiKeyBanner(false);
            return true;
        }
    } catch (e) {
        console.log('Auth check failed:', e);
    }
    return null;
}

// API Key input handling
document.addEventListener('DOMContentLoaded', () => {
    const apiKeyInput = document.getElementById('apiKeyInput');
    if (apiKeyInput) {
        // Load saved API key
        apiKeyInput.value = getApiKey();
        
        // Check if auth is required on initial load
        checkApiAuth();
        
        // Handle Enter key - save and refresh
        apiKeyInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                const key = e.target.value.trim();
                setApiKey(key);
                if (key) {
                    showApiKeyBanner(false);
                    location.reload(); // Refresh page to reload data with new key
                }
            }
        });
        
        // Handle blur (lose focus) - save and refresh if key changed
        apiKeyInput.addEventListener('blur', (e) => {
            const newKey = e.target.value.trim();
            const oldKey = getApiKey();
            if (newKey !== oldKey) {
                setApiKey(newKey);
                if (newKey) {
                    showApiKeyBanner(false);
                    location.reload(); // Refresh page to reload data with new key
                } else {
                    // Key cleared - check if auth is still required
                    checkApiAuth();
                }
            }
        });
    }
});
