const { test, before, after } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { io: ioc } = require('socket.io-client');
const { createApp } = require('../src/app');

let app, server, io, url, pid, cols, taskId; const T = {}, U = {};
const as = (u) => ({ Authorization: `Bearer ${T[u]}` });
before(async () => {
  ({ app, server, io } = createApp({ dbFile: ':memory:' }));
  await new Promise((r) => server.listen(0, r));
  url = `http://localhost:${server.address().port}`;
  for (const u of ['steven', 'maria', 'outsider']) {
    const r = await request(app).post('/api/register').send({ username: u, password: 'password1' });
    T[u] = r.body.token; U[u] = r.body.user.id;
  }
});
after(() => { io.close(); server.close(); });

test('create project seeds default columns and owner membership', async () => {
  const r = await request(app).post('/api/projects').set(as('steven')).send({ name: 'Website Launch', description: 'Q4 launch' });
  assert.strictEqual(r.status, 201); pid = r.body.id;
  const p = await request(app).get(`/api/projects/${pid}`).set(as('steven'));
  cols = p.body.columns;
  assert.deepStrictEqual(cols.map((c) => c.name), ['To Do', 'In Progress', 'Review', 'Done']);
  assert.strictEqual(p.body.members[0].role, 'owner');
});
test('non-members are forbidden', async () => {
  assert.strictEqual((await request(app).get(`/api/projects/${pid}`).set(as('outsider'))).status, 403);
  assert.strictEqual((await request(app).get('/api/projects')).status, 401);
});
test('add member by username', async () => {
  assert.strictEqual((await request(app).post(`/api/projects/${pid}/members`).set(as('steven')).send({ username: 'nobody' })).status, 404);
  const r = await request(app).post(`/api/projects/${pid}/members`).set(as('steven')).send({ username: 'maria' });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.body.length, 2);
  assert.strictEqual((await request(app).get('/api/projects').set(as('maria'))).body.length, 1);
});
test('create task with assignee validation', async () => {
  assert.strictEqual((await request(app).post(`/api/projects/${pid}/tasks`).set(as('steven')).send({ title: 'x', assignee_id: U.outsider })).status, 400);
  const r = await request(app).post(`/api/projects/${pid}/tasks`).set(as('steven')).send({ title: 'Design homepage', column_id: cols[0].id, assignee_id: U.maria, priority: 'high' });
  assert.strictEqual(r.status, 201); taskId = r.body.id;
  assert.strictEqual(r.body.assignee, 'maria');
});
test('assignee receives a notification', async () => {
  const n = await request(app).get('/api/notifications').set(as('maria'));
  assert.ok(n.body.some((x) => x.message.includes('assigned you "Design homepage"')));
});
test('move task between columns via PATCH', async () => {
  const r = await request(app).patch(`/api/tasks/${taskId}`).set(as('maria')).send({ column_id: cols[1].id });
  assert.strictEqual(r.body.column_id, cols[1].id);
  assert.strictEqual((await request(app).patch(`/api/tasks/${taskId}`).set(as('maria')).send({ column_id: 99999 })).status, 400);
  assert.strictEqual((await request(app).patch(`/api/tasks/${taskId}`).set(as('outsider')).send({ title: 'hack' })).status, 403);
});
test('comments on tasks', async () => {
  assert.strictEqual((await request(app).post(`/api/tasks/${taskId}/comments`).set(as('maria')).send({ content: 'Mockups ready' })).status, 201);
  const c = await request(app).get(`/api/tasks/${taskId}/comments`).set(as('steven'));
  assert.strictEqual(c.body[0].content, 'Mockups ready');
  assert.strictEqual((await request(app).get(`/api/tasks/${taskId}/comments`).set(as('outsider'))).status, 404);
});
test('socket rejects missing token', async () => {
  const s = ioc(url, { auth: {}, reconnection: false });
  const e = await new Promise((r) => s.on('connect_error', r));
  assert.strictEqual(e.message, 'unauthorized'); s.close();
});
test('real-time: board events and notifications over Socket.IO', async () => {
  const s = ioc(url, { auth: { token: T.steven }, reconnection: false });
  await new Promise((r) => s.on('connect', r));
  assert.deepStrictEqual(await s.emitWithAck('project:join', pid), { ok: true });
  const gotEvent = new Promise((r) => s.on('board:event', (e) => e.type === 'task:updated' && r(e)));
  const gotNote = new Promise((r) => s.on('notification', r));
  await request(app).patch(`/api/tasks/${taskId}`).set(as('maria')).send({ column_id: cols[3].id });
  const ev = await gotEvent;
  assert.strictEqual(ev.by, 'maria');
  assert.strictEqual(ev.payload.column_id, cols[3].id);
  assert.match((await gotNote).message, /moved "Design homepage" to Done/);
  s.close();
});
test('outsider socket cannot join project room', async () => {
  const s = ioc(url, { auth: { token: T.outsider }, reconnection: false });
  await new Promise((r) => s.on('connect', r));
  assert.deepStrictEqual(await s.emitWithAck('project:join', pid), { ok: false });
  s.close();
});
test('delete task', async () => {
  assert.strictEqual((await request(app).delete(`/api/tasks/${taskId}`).set(as('steven'))).status, 200);
  assert.strictEqual((await request(app).delete(`/api/tasks/${taskId}`).set(as('steven'))).status, 404);
});
