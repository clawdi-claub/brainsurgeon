const API = '/api';
let sessions = [];
let currentAgent = 'all';
let currentStatusFilter = 'all';
let currentTypeFilter = 'all';

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
    document.getElementById('viewModal').classList.remove('active');
}

// Load agents
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
        const r = await fetch(url);
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
        const r = await fetch(`${API}/trash`);
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
        const r = await fetch(`${API}/sessions/${agent}/${id}/prune`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
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
        const r = await fetch(`${API}/sessions/${agent}/${id}/summary`);
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
        await fetch(`${API}/sessions/${agent}/${id}`, { method: 'DELETE' });
        loadSessions();
    } catch (e) {
        alert('Delete failed');
    }
}

function toggleMetadata() {
    const content = document.getElementById('metadataContent');
    const toggle = document.querySelector('.metadata-toggle');
    const isExpanded = content.style.display !== 'none';
    content.style.display = isExpanded ? 'none' : 'block';
    toggle.classList.toggle('expanded', !isExpanded);
}

// View mode state for each entry
const entryViewModes = {};

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

function renderSessionBody(data) {
    // Store entries for editing
    window._currentEntries = data.entries;

    // Group tool calls with results
    const groupedEntries = groupToolCalls(data.entries);
    
    // Check for parent/child relationships
    const childEntries = data.entries.filter(e => e.parentId);
    const parentToChildren = {};
    childEntries.forEach(child => {
        if (!parentToChildren[child.parentId]) parentToChildren[child.parentId] = [];
        parentToChildren[child.parentId].push(child);
    });
    
    document.getElementById('modalBody2').innerHTML = groupedEntries.map((group, idx) => {
        const entryIndex = group.index || idx;
        
        if (group.type === 'tool_pair') {
            // Tool call + result pair grouped together
            return `
            <div class="entry-group tool-pair-group">
                <div class="group-label">🔧 → 📥</div>
                ${renderEntryWithToggle(group.call, entryIndex, data.agent, data.id)}
                ${renderEntryWithToggle(group.result, group.resultIndex || entryIndex + 500, data.agent, data.id)}
            </div>
            `;
        } else {
            // Check if this entry has children
            const entryId = group.entry.id || group.entry.sessionId;
            const children = parentToChildren[entryId] || [];
            
            if (children.length > 0) {
                // Show parent with children indented below
                return `
                <div class="entry-group parent-group">
                    <div class="parent-entry">
                        ${renderEntryWithToggle(group.entry, entryIndex, data.agent, data.id)}
                    </div>
                    <div class="children-container">
                        ${children.map((child, ci) => {
                            const childIdx = data.entries.indexOf(child);
                            return `<div class="child-entry">${renderEntryWithToggle(child, childIdx >= 0 ? childIdx : entryIndex + 1000 + ci, data.agent, data.id)}</div>`;
                        }).join('')}
                    </div>
                </div>
                `;
            }
            
            // Regular entry with toggle
            return renderEntryWithToggle(group.entry, entryIndex, data.agent, data.id);
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

// View session - DEFAULT to view now
async function viewSession(agent, id) {
    document.getElementById('viewModal').classList.add('active');
    document.getElementById('modalTitle2').textContent = 'Loading...';
    document.getElementById('modalId').textContent = id;
    document.getElementById('modalModels').textContent = '';
    document.getElementById('modalBody2').innerHTML = '<div class="loading">Loading...</div>';

    try {
        const r = await fetch(`${API}/sessions/${agent}/${id}`);
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

        // Update models used
        const models = new Set();
        data.entries?.forEach(e => {
            if (e.type === 'custom' && e.customType === 'model-snapshot') {
                const modelId = e.data?.modelId || e.data?.model;
                if (modelId) models.add(modelId);
            } else if (e.type === 'message') {
                const msg = e.message || {};
                if (msg.model) models.add(msg.model);
            }
        });
        const modelList = Array.from(models);
        if (modelList.length > 0) {
            document.getElementById('detailModels').innerHTML = modelList.map(m =>
                `<span class="session-model" style="font-family: monospace; font-size: 0.8rem;">${escapeHtml(m)}</span>`
            ).join(' ');
        } else {
            document.getElementById('detailModels').innerHTML = '<span style="color: var(--text-tertiary)">—</span>';
        }

        // Show models in header too
        if (modelList.length > 0) {
            document.getElementById('modalModels').innerHTML = modelList.slice(0, 3).map(m =>
                `<span class="session-model">${escapeHtml(m.split('/').pop().substring(0, 20))}</span>`
            ).join(' ');
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
        document.getElementById('metaChannel').textContent = data.channel || '—';
        document.getElementById('metaStarted').textContent = data.created ? new Date(data.created).toLocaleString() : '—';
        document.getElementById('metaLastInteraction').textContent = data.updated ? new Date(data.updated).toLocaleString() : '—';
        document.getElementById('metaTokens').textContent = data.tokens || '—';
        document.getElementById('metaSkills').textContent = data.resolvedSkills?.join(', ') || '—';
        document.getElementById('metaSystemPrompt').textContent = data.systemPromptReport || '—';
        document.getElementById('metaHistory').textContent = data.history ? JSON.stringify(data.history) : '—';

        // Render body based on current view mode
        renderSessionBody(data);
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
                
                if (next.type === 'tool_result') {
                    if (next.id === toolId || next.call_id === toolId) {
                        result = next;
                        resultIndex = j;
                        break;
                    }
                } else if (next.type === 'message') {
                    const msg = next.message || {};
                    if (msg.role === 'toolResult') {
                        // Check if content references the tool id
                        const content = msg.content;
                        if (typeof content === 'string' && content.includes(toolId)) {
                            result = next;
                            resultIndex = j;
                            break;
                        }
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
        const r = await fetch(`${API}/sessions/${agent}/${sessionId}/entries/${index}`, {
            method: 'PUT',
            headers: {'Content-Type': 'application/json'},
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
        
        await fetch(`${API}/sessions/${agent}/${sessionId}/entries/${index}`, {
            method: 'PUT',
            headers: {'Content-Type': 'application/json'},
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

// Initial load
loadAgents();
loadSessions();
