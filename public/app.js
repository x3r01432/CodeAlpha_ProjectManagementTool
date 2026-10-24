const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const session = () => JSON.parse(localStorage.getItem('tf_session') || 'null');
let socket = null, board = null, openTask = null;

async function api(path, opts = {}) {
  const s = session();
  const res = await fetch('/api' + path, { ...opts, headers: { 'Content-Type': 'application/json', ...(s ? { Authorization: 'Bearer ' + s.token } : {}) }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await res.json();
  if (res.status === 401) { localStorage.removeItem('tf_session'); route(); }
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}
function toast(m) { const t = document.createElement('div'); t.className = 'toast'; t.textContent = m; document.body.appendChild(t); setTimeout(() => t.remove(), 3500); }

// ---------- realtime + notifications ----------
function connect() {
  if (socket || !session()) return;
  socket = io({ auth: { token: session().token } });
  socket.on('connect', () => { $('#live').textContent = '● live'; if (board) socket.emit('project:join', board.id); });
  socket.on('disconnect', () => ($('#live').textContent = ''));
  socket.on('notification', (n) => { toast('🔔 ' + n.message); loadNotes(); });
  socket.on('board:event', onBoardEvent);
}
async function loadNotes() {
  const ns = await api('/notifications');
  const unread = ns.filter((n) => !n.read).length;
  $('#bn').hidden = !unread; $('#bn').textContent = unread;
  $('#notes').innerHTML = ns.map((n) => `<div class="${n.read ? '' : 'unread'}">${esc(n.message)}<br><span class="muted" style="font-size:12px">${esc(n.created_at)} UTC</span></div>`).join('') || '<div class="muted">No notifications yet</div>';
}
$('#bell').onclick = async () => { const n = $('#notes'); n.hidden = !n.hidden; if (!n.hidden) { await api('/notifications/read', { method: 'POST' }); setTimeout(loadNotes, 1500); } };

function onBoardEvent({ type, payload, by }) {
  if (!board) return;
  const me = session().user.username;
  if (type === 'task:created' || type === 'task:updated') {
    const i = board.tasks.findIndex((t) => t.id === payload.id);
    const prev = board.tasks[i];
    if (i >= 0) board.tasks[i] = payload; else board.tasks.push(payload);
    if (by !== me && type === 'task:created') toast(`✨ ${by} added "${payload.title}"`);
    if (by !== me && prev && prev.column_id !== payload.column_id) toast(`↔️ ${by} moved "${payload.title}"`);
  } else if (type === 'task:deleted') board.tasks = board.tasks.filter((t) => t.id !== payload.id);
  else if (type === 'column:created') board.columns.push(payload);
  else if (type === 'members') board.members = payload;
  else if (type === 'comment:created' && openTask === payload.task_id) loadComments(payload.task_id);
  drawBoard();
}

function header() {
  const s = session();
  $('#bell').hidden = !s;
  $('#who').innerHTML = s ? `<span class="chip">${esc(s.user.username.slice(0, 2))}</span> ${esc(s.user.username)} <a href="#" id="lo">Log out</a>` : '';
  if (s) { $('#lo').onclick = (e) => { e.preventDefault(); localStorage.removeItem('tf_session'); socket?.disconnect(); socket = null; route(); }; connect(); loadNotes(); }
}

const views = {
  async home() {
    board = null; $('#view').className = '';
    const ps = await api('/projects');
    $('#view').innerHTML = `<div class="row between"><h1>Your projects</h1></div><div class="grid">${ps.map((p) => `<a class="card" href="#/p/${p.id}" style="color:inherit;border-top:6px solid var(--accent)"><h3>${esc(p.name)}</h3><p class="muted">${esc(p.description) || '&nbsp;'}</p><span class="badge">👥 ${p.member_count} members</span> <span class="badge">🗂️ ${p.task_count} tasks</span></a>`).join('')}<div class="card"><h3>➕ New project</h3><input id="pn" placeholder="Project name"><input id="pd" placeholder="Description (optional)" style="margin-top:8px"><button class="btn" id="pc" style="margin-top:10px">Create project</button><p class="err" id="err"></p></div></div>`;
    $('#pc').onclick = async () => { try { const p = await api('/projects', { method: 'POST', body: { name: $('#pn').value, description: $('#pd').value } }); location.hash = '#/p/' + p.id; } catch (e) { $('#err').textContent = e.message; } };
  },
  async p(id) {
    board = await api('/projects/' + id);
    $('#view').className = 'wide';
    socket?.emit('project:join', board.id);
    drawBoard();
  },
  login() {
    board = null; $('#view').className = '';
    $('#view').innerHTML = `<div class="card auth"><div style="text-align:center;font-size:48px">📋</div><h2 id="t" style="text-align:center">Log in to TaskFlow</h2><label>Username</label><input id="u"><label>Password</label><input id="p" type="password"><p class="err" id="err"></p><button class="btn" id="go" style="width:100%">Log in</button><p class="muted" style="text-align:center">New here? <a href="#" id="sw">Create an account</a></p></div>`;
    let mode = 'login';
    $('#sw').onclick = (e) => { e.preventDefault(); mode = mode === 'login' ? 'register' : 'login'; $('#t').textContent = mode === 'login' ? 'Log in to TaskFlow' : 'Create your account'; $('#go').textContent = mode === 'login' ? 'Log in' : 'Sign up'; $('#sw').textContent = mode === 'login' ? 'Create an account' : 'Log in'; };
    const go = async () => { try { const s = await api('/' + mode, { method: 'POST', body: { username: $('#u').value, password: $('#p').value } }); localStorage.setItem('tf_session', JSON.stringify(s)); location.hash = '#/'; route(); } catch (e) { $('#err').textContent = e.message; } };
    $('#go').onclick = go; $('#p').onkeydown = (e) => e.key === 'Enter' && go();
  },
};

function drawBoard() {
  if (!board || !$('#view').classList.contains('wide')) return;
  const b = board;
  $('#view').innerHTML = `<div class="row between" style="margin-bottom:14px"><div><h1 style="margin:0">${esc(b.name)}</h1><span class="muted">${esc(b.description)}</span></div><div class="row"><div class="members">${b.members.map((m) => `<span class="chip" title="${esc(m.username)} (${m.role})">${esc(m.username.slice(0, 2))}</span>`).join('')}</div><input id="mu" placeholder="Invite by username" style="width:180px"><button class="btn ghost" id="ma">Add member</button></div></div>
  <div class="board">${b.columns.map((c) => {
    const ts = b.tasks.filter((t) => t.column_id === c.id).sort((x, y) => x.position - y.position);
    return `<div class="col"><h3>${esc(c.name)} <span class="muted">${ts.length}</span></h3><div class="list" data-col="${c.id}">${ts.map((t) => `<div class="task" draggable="true" data-id="${t.id}"><div>${esc(t.title)}</div><div class="meta"><span class="pri ${t.priority}">${t.priority}</span>${t.due_date ? `<span>📅 ${esc(t.due_date)}</span>` : ''}${t.comment_count ? `<span>💬 ${t.comment_count}</span>` : ''}<span style="margin-left:auto">${t.assignee ? `<span class="chip" title="${esc(t.assignee)}">${esc(t.assignee.slice(0, 2))}</span>` : ''}</span></div></div>`).join('')}</div><button class="addtask" data-add="${c.id}">+ Add a card</button></div>`;
  }).join('')}<div class="col" style="background:#ffffff66"><input id="cn" placeholder="+ Add another column"><button class="btn ghost" id="cb" style="margin-top:8px">Add column</button></div></div>`;
  $('#ma').onclick = async () => { try { await api(`/projects/${b.id}/members`, { method: 'POST', body: { username: $('#mu').value } }); toast('Member added'); } catch (e) { toast(e.message); } };
  $('#cb').onclick = async () => { if ($('#cn').value.trim()) await api(`/projects/${b.id}/columns`, { method: 'POST', body: { name: $('#cn').value } }); };
  document.querySelectorAll('[data-add]').forEach((btn) => (btn.onclick = () => {
    const title = prompt('Card title'); if (title?.trim()) api(`/projects/${b.id}/tasks`, { method: 'POST', body: { title, column_id: Number(btn.dataset.add) } });
  }));
  // drag & drop (HTML5)
  document.querySelectorAll('.task').forEach((el) => {
    el.ondragstart = (e) => { e.dataTransfer.setData('text/plain', el.dataset.id); el.classList.add('dragging'); };
    el.ondragend = () => el.classList.remove('dragging');
    el.onclick = () => showTask(Number(el.dataset.id));
  });
  document.querySelectorAll('.list').forEach((list) => {
    list.ondragover = (e) => { e.preventDefault(); list.classList.add('over'); };
    list.ondragleave = () => list.classList.remove('over');
    list.ondrop = async (e) => {
      e.preventDefault(); list.classList.remove('over');
      const id = Number(e.dataTransfer.getData('text/plain'));
      const cards = [...list.querySelectorAll('.task')].filter((c) => Number(c.dataset.id) !== id);
      const after = cards.find((c) => e.clientY < c.getBoundingClientRect().top + c.offsetHeight / 2);
      const pos = (el) => board.tasks.find((t) => t.id === Number(el.dataset.id)).position;
      let position;
      if (!cards.length) position = 1;
      else if (!after) position = pos(cards[cards.length - 1]) + 1;
      else { const i = cards.indexOf(after); position = i === 0 ? pos(after) / 2 : (pos(cards[i - 1]) + pos(after)) / 2; }
      const t = board.tasks.find((x) => x.id === id); t.column_id = Number(list.dataset.col); t.position = position; drawBoard();
      await api('/tasks/' + id, { method: 'PATCH', body: { column_id: Number(list.dataset.col), position } });
    };
  });
}
async function loadComments(id) {
  const cs = await api(`/tasks/${id}/comments`);
  const box = $('#cms'); if (!box) return;
  box.innerHTML = cs.map((c) => `<div class="card" style="padding:10px;margin-bottom:8px"><span class="chip">${esc(c.username.slice(0, 2))}</span> <b>${esc(c.username)}</b> <span class="muted" style="font-size:12px">${esc(c.created_at)} UTC</span><div style="margin-top:6px">${esc(c.content)}</div></div>`).join('') || '<p class="muted">No comments yet.</p>';
}
function showTask(id) {
  const t = board.tasks.find((x) => x.id === id); openTask = id;
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal"><div class="row between"><input id="tt" value="${esc(t.title)}" style="font-size:20px;font-weight:700;background:transparent;border-color:transparent"><button class="btn ghost" id="x">✕</button></div>
  <div class="row" style="margin-top:10px"><div style="flex:1"><label>Column</label><select id="tc">${board.columns.map((c) => `<option value="${c.id}" ${c.id === t.column_id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div><div style="flex:1"><label>Assignee</label><select id="ta"><option value="">Unassigned</option>${board.members.map((m) => `<option value="${m.id}" ${m.id === t.assignee_id ? 'selected' : ''}>${esc(m.username)}</option>`).join('')}</select></div><div style="flex:1"><label>Priority</label><select id="tp">${['low', 'medium', 'high'].map((p) => `<option ${p === t.priority ? 'selected' : ''}>${p}</option>`).join('')}</select></div><div style="flex:1"><label>Due date</label><input type="date" id="td" value="${esc(t.due_date || '')}"></div></div>
  <label>Description</label><textarea id="tdesc" rows="3">${esc(t.description)}</textarea>
  <div class="row between" style="margin-top:10px"><button class="btn" id="ts">Save changes</button><button class="btn danger" id="tdel">Delete card</button></div>
  <h3 style="margin-top:20px">💬 Comments</h3><div id="cms"></div><div class="row"><input id="cin" placeholder="Write a comment…"><button class="btn" id="cs">Send</button></div></div>`;
  document.body.appendChild(bg);
  const close = () => { bg.remove(); openTask = null; };
  $('#x', bg).onclick = close; bg.onclick = (e) => e.target === bg && close();
  $('#ts', bg).onclick = async () => { await api('/tasks/' + id, { method: 'PATCH', body: { title: $('#tt').value, column_id: Number($('#tc').value), assignee_id: $('#ta').value ? Number($('#ta').value) : null, priority: $('#tp').value, due_date: $('#td').value, description: $('#tdesc').value } }); close(); };
  $('#tdel', bg).onclick = async () => { if (confirm('Delete this card?')) { await api('/tasks/' + id, { method: 'DELETE' }); close(); } };
  const send = async () => { if (!$('#cin').value.trim()) return; await api(`/tasks/${id}/comments`, { method: 'POST', body: { content: $('#cin').value } }); $('#cin').value = ''; };
  $('#cs', bg).onclick = send; $('#cin', bg).onkeydown = (e) => e.key === 'Enter' && send();
  loadComments(id);
}
function route() {
  document.querySelector('.modal-bg')?.remove();
  header();
  if (!session()) return views.login();
  const [name, arg] = location.hash.slice(2).split('/');
  Promise.resolve().then(() => (name === 'p' ? views.p(arg) : views.home())).catch((e) => ($('#view').innerHTML = `<div class="card err">${esc(e.message)}</div>`));
}
window.onhashchange = route; route();
