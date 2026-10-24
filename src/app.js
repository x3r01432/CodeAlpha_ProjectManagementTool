const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const { openDb } = require('./db');
const { hash, check, sign, verify, requireAuth, validCreds } = require('./auth');

const DEFAULT_COLUMNS = ['To Do', 'In Progress', 'Review', 'Done'];
const PRIORITIES = ['low', 'medium', 'high'];

function createApp({ dbFile } = {}) {
  const db = openDb(dbFile);
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server);
  app.use(express.json({ limit: '50kb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  const err = (status, message) => Object.assign(new Error(message), { status });
  const isMember = (pid, uid) => !!db.prepare('SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?').get(pid, uid);
  const member = (req, _res, next) => { if (!isMember(req.params.pid, req.user.id)) return next(err(403, 'Not a member of this project')); next(); };
  const taskOf = (id) => db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  const taskView = (id) => db.prepare('SELECT t.*, u.username assignee, (SELECT COUNT(*) FROM task_comments c WHERE c.task_id = t.id) comment_count FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id WHERE t.id = ?').get(id);
  const members = (pid) => db.prepare('SELECT u.id, u.username, m.role FROM project_members m JOIN users u ON u.id = m.user_id WHERE project_id = ? ORDER BY m.role DESC, u.username').all(pid);

  // ---------- realtime ----------
  const broadcast = (pid, type, payload, by) => io.to(`project:${pid}`).emit('board:event', { type, payload, by });
  function notify(userIds, pid, taskId, message, exclude) {
    const ins = db.prepare('INSERT INTO notifications (user_id, project_id, task_id, message) VALUES (?,?,?,?)');
    for (const uid of new Set(userIds)) {
      if (!uid || uid === exclude) continue;
      const r = ins.run(uid, pid, taskId, message);
      io.to(`user:${uid}`).emit('notification', db.prepare('SELECT * FROM notifications WHERE id = ?').get(r.lastInsertRowid));
    }
  }
  io.use((socket, next) => { try { socket.user = verify(socket.handshake.auth?.token); next(); } catch { next(new Error('unauthorized')); } });
  io.on('connection', (socket) => {
    socket.join(`user:${socket.user.id}`);
    socket.on('project:join', (pid, ack) => {
      for (const r of socket.rooms) if (r.startsWith('project:')) socket.leave(r);
      if (!isMember(pid, socket.user.id)) return ack?.({ ok: false });
      socket.join(`project:${pid}`);
      ack?.({ ok: true });
    });
  });

  // ---------- auth ----------
  app.post('/api/register', (req, res) => {
    const v = validCreds(req.body);
    if (v.error) return res.status(400).json({ error: v.error });
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(v.u)) return res.status(409).json({ error: 'Username taken' });
    const r = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(v.u, hash(v.p));
    const user = { id: Number(r.lastInsertRowid), username: v.u };
    res.status(201).json({ token: sign(user), user });
  });
  app.post('/api/login', (req, res) => {
    const row = db.prepare('SELECT * FROM users WHERE username = ?').get(String(req.body?.username || ''));
    if (!row || !check(String(req.body?.password || ''), row.password_hash)) return res.status(401).json({ error: 'Invalid username or password' });
    res.json({ token: sign(row), user: { id: row.id, username: row.username } });
  });

  // ---------- projects ----------
  app.get('/api/projects', requireAuth, (req, res) => {
    res.json(db.prepare(`SELECT p.*, (SELECT COUNT(*) FROM project_members WHERE project_id = p.id) member_count,
      (SELECT COUNT(*) FROM tasks WHERE project_id = p.id) task_count FROM projects p
      JOIN project_members m ON m.project_id = p.id WHERE m.user_id = ? ORDER BY p.id DESC`).all(req.user.id));
  });
  app.post('/api/projects', requireAuth, (req, res) => {
    const name = String(req.body?.name || '').trim();
    if (!name || name.length > 60) return res.status(400).json({ error: 'Project name must be 1-60 characters' });
    const pid = db.transaction(() => {
      const r = db.prepare('INSERT INTO projects (name, description, owner_id) VALUES (?,?,?)').run(name, String(req.body?.description || '').slice(0, 300), req.user.id);
      db.prepare("INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, 'owner')").run(r.lastInsertRowid, req.user.id);
      DEFAULT_COLUMNS.forEach((c, i) => db.prepare('INSERT INTO board_columns (project_id, name, position) VALUES (?,?,?)').run(r.lastInsertRowid, c, i));
      return r.lastInsertRowid;
    })();
    res.status(201).json(db.prepare('SELECT * FROM projects WHERE id = ?').get(pid));
  });
  app.get('/api/projects/:pid', requireAuth, member, (req, res) => {
    const p = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.pid);
    res.json({
      ...p,
      members: members(p.id),
      columns: db.prepare('SELECT * FROM board_columns WHERE project_id = ? ORDER BY position').all(p.id),
      tasks: db.prepare('SELECT t.*, u.username assignee, (SELECT COUNT(*) FROM task_comments c WHERE c.task_id = t.id) comment_count FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id WHERE t.project_id = ? ORDER BY position').all(p.id),
    });
  });
  app.post('/api/projects/:pid/members', requireAuth, member, (req, res) => {
    const u = db.prepare('SELECT id, username FROM users WHERE username = ?').get(String(req.body?.username || ''));
    if (!u) return res.status(404).json({ error: 'No user with that username' });
    if (isMember(req.params.pid, u.id)) return res.status(409).json({ error: 'Already a member' });
    db.prepare('INSERT INTO project_members (project_id, user_id) VALUES (?, ?)').run(req.params.pid, u.id);
    const p = db.prepare('SELECT name FROM projects WHERE id = ?').get(req.params.pid);
    notify([u.id], Number(req.params.pid), null, `${req.user.username} added you to project "${p.name}"`);
    broadcast(req.params.pid, 'members', members(req.params.pid), req.user.username);
    res.status(201).json(members(req.params.pid));
  });
  app.post('/api/projects/:pid/columns', requireAuth, member, (req, res) => {
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Column name required' });
    const pos = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 n FROM board_columns WHERE project_id = ?').get(req.params.pid).n;
    const r = db.prepare('INSERT INTO board_columns (project_id, name, position) VALUES (?,?,?)').run(req.params.pid, name.slice(0, 40), pos);
    const col = db.prepare('SELECT * FROM board_columns WHERE id = ?').get(r.lastInsertRowid);
    broadcast(req.params.pid, 'column:created', col, req.user.username);
    res.status(201).json(col);
  });

  // ---------- tasks ----------
  app.post('/api/projects/:pid/tasks', requireAuth, member, (req, res) => {
    const pid = Number(req.params.pid);
    const title = String(req.body?.title || '').trim();
    if (!title || title.length > 120) return res.status(400).json({ error: 'Task title must be 1-120 characters' });
    const col = db.prepare('SELECT * FROM board_columns WHERE id = ? AND project_id = ?').get(req.body?.column_id, pid)
      || db.prepare('SELECT * FROM board_columns WHERE project_id = ? ORDER BY position LIMIT 1').get(pid);
    const assignee = req.body?.assignee_id ? Number(req.body.assignee_id) : null;
    if (assignee && !isMember(pid, assignee)) return res.status(400).json({ error: 'Assignee must be a project member' });
    const priority = PRIORITIES.includes(req.body?.priority) ? req.body.priority : 'medium';
    const pos = db.prepare('SELECT COALESCE(MAX(position), 0) + 1 n FROM tasks WHERE column_id = ?').get(col.id).n;
    const r = db.prepare('INSERT INTO tasks (project_id, column_id, title, description, assignee_id, priority, due_date, position, created_by) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(pid, col.id, title, String(req.body?.description || '').slice(0, 2000), assignee, priority, req.body?.due_date || null, pos, req.user.id);
    const t = taskView(r.lastInsertRowid);
    broadcast(pid, 'task:created', t, req.user.username);
    if (assignee) notify([assignee], pid, t.id, `${req.user.username} assigned you "${t.title}"`, req.user.id);
    res.status(201).json(t);
  });
  app.patch('/api/tasks/:id', requireAuth, (req, res, next) => {
    const t = taskOf(req.params.id);
    if (!t) return next(err(404, 'Task not found'));
    if (!isMember(t.project_id, req.user.id)) return next(err(403, 'Not a member of this project'));
    const b = req.body || {};
    const upd = { ...t };
    if (b.title !== undefined) { upd.title = String(b.title).trim().slice(0, 120); if (!upd.title) return next(err(400, 'Title required')); }
    if (b.description !== undefined) upd.description = String(b.description).slice(0, 2000);
    if (b.priority !== undefined && PRIORITIES.includes(b.priority)) upd.priority = b.priority;
    if (b.due_date !== undefined) upd.due_date = b.due_date || null;
    if (b.assignee_id !== undefined) {
      upd.assignee_id = b.assignee_id ? Number(b.assignee_id) : null;
      if (upd.assignee_id && !isMember(t.project_id, upd.assignee_id)) return next(err(400, 'Assignee must be a project member'));
    }
    if (b.column_id !== undefined) {
      const col = db.prepare('SELECT * FROM board_columns WHERE id = ? AND project_id = ?').get(b.column_id, t.project_id);
      if (!col) return next(err(400, 'Invalid column'));
      upd.column_id = col.id;
      upd.position = typeof b.position === 'number' ? b.position : db.prepare('SELECT COALESCE(MAX(position), 0) + 1 n FROM tasks WHERE column_id = ?').get(col.id).n;
    }
    db.prepare('UPDATE tasks SET title=@title, description=@description, priority=@priority, due_date=@due_date, assignee_id=@assignee_id, column_id=@column_id, position=@position WHERE id=@id').run(upd);
    const v = taskView(t.id);
    broadcast(t.project_id, 'task:updated', v, req.user.username);
    if (upd.column_id !== t.column_id) {
      const col = db.prepare('SELECT name FROM board_columns WHERE id = ?').get(upd.column_id);
      notify([t.assignee_id, t.created_by], t.project_id, t.id, `${req.user.username} moved "${v.title}" to ${col.name}`, req.user.id);
    }
    if (upd.assignee_id && upd.assignee_id !== t.assignee_id) notify([upd.assignee_id], t.project_id, t.id, `${req.user.username} assigned you "${v.title}"`, req.user.id);
    res.json(v);
  });
  app.delete('/api/tasks/:id', requireAuth, (req, res, next) => {
    const t = taskOf(req.params.id);
    if (!t) return next(err(404, 'Task not found'));
    if (!isMember(t.project_id, req.user.id)) return next(err(403, 'Not a member of this project'));
    db.prepare('DELETE FROM tasks WHERE id = ?').run(t.id);
    broadcast(t.project_id, 'task:deleted', { id: t.id }, req.user.username);
    res.json({ ok: true });
  });

  // ---------- comments ----------
  app.get('/api/tasks/:id/comments', requireAuth, (req, res, next) => {
    const t = taskOf(req.params.id);
    if (!t || !isMember(t.project_id, req.user.id)) return next(err(404, 'Task not found'));
    res.json(db.prepare('SELECT c.*, u.username FROM task_comments c JOIN users u ON u.id = c.user_id WHERE task_id = ? ORDER BY c.id').all(t.id));
  });
  app.post('/api/tasks/:id/comments', requireAuth, (req, res, next) => {
    const t = taskOf(req.params.id);
    if (!t || !isMember(t.project_id, req.user.id)) return next(err(404, 'Task not found'));
    const content = String(req.body?.content || '').trim();
    if (!content || content.length > 1000) return next(err(400, 'Comment must be 1-1000 characters'));
    const r = db.prepare('INSERT INTO task_comments (task_id, user_id, content) VALUES (?,?,?)').run(t.id, req.user.id, content);
    const c = db.prepare('SELECT c.*, u.username FROM task_comments c JOIN users u ON u.id = c.user_id WHERE c.id = ?').get(r.lastInsertRowid);
    broadcast(t.project_id, 'comment:created', c, req.user.username);
    broadcast(t.project_id, 'task:updated', taskView(t.id), req.user.username);
    const others = db.prepare('SELECT DISTINCT user_id FROM task_comments WHERE task_id = ?').all(t.id).map((x) => x.user_id);
    notify([t.assignee_id, t.created_by, ...others], t.project_id, t.id, `${req.user.username} commented on "${t.title}"`, req.user.id);
    res.status(201).json(c);
  });

  // ---------- notifications ----------
  app.get('/api/notifications', requireAuth, (req, res) => res.json(db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 50').all(req.user.id)));
  app.post('/api/notifications/read', requireAuth, (req, res) => { db.prepare('UPDATE notifications SET read = 1 WHERE user_id = ?').run(req.user.id); res.json({ ok: true }); });

  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));
  // eslint-disable-next-line no-unused-vars
  app.use((e, _req, res, _next) => res.status(e.status || 500).json({ error: e.message }));
  app.locals.db = db;
  return { app, server, io };
}
module.exports = { createApp };
