require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const prisma = new PrismaClient();
const app = express();
app.use(cors());
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET || 'change_this_secret';
const PORT = process.env.PORT || 4000;

// Health
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Auth - login
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });
  const user = await prisma.user.findUnique({ where: { email }, include: { tenant: true }});
  if (!user) return res.status(401).json({ error: 'invalid credentials' });
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'invalid credentials' });
  const token = jwt.sign({ sub: user.id, role: user.role, tenant: user.tenant.slug }, JWT_SECRET, { expiresIn: '8h' });
  res.json({ token, user: { id: user.id, email: user.email, role: user.role, tenant: user.tenant.slug }});
});

// Middleware to protect routes
function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: 'missing authorization' });
  const parts = auth.split(' ');
  if (parts.length !== 2) return res.status(401).json({ error: 'invalid authorization header' });
  const token = parts[1];
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = { id: payload.sub, role: payload.role, tenant: payload.tenant };
    next();
  } catch (e) {
    return res.status(401).json({ error: 'invalid token' });
  }
}


app.get('/api/auth/me', authMiddleware, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      include: { tenant: true }
    });
    if (!user) return res.status(404).json({ error: 'User not found' });
    return res.json({
      id: user.id,
      email: user.email,
      role: user.role,
      tenant: user.tenant.slug
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'server error' });
    }
});

// Upgrade endpoint (admin only)
app.post('/api/tenants/:slug/upgrade', authMiddleware, async (req, res) => {
  const { slug } = req.params;
  if (req.user.role !== 'admin' || req.user.tenant !== slug) return res.status(403).json({ error: 'forbidden' });
  const tenant = await prisma.tenant.updateMany({ where: { slug }, data: { plan: 'pro' }});
  res.json({ success: true, slug });
});

// Notes CRUD
app.post('/api/notes', authMiddleware, async (req, res) => {
  const { title, content } = req.body;
  if (!title) return res.status(400).json({ error: 'title required' });
  // enforce free plan limit
  const tenant = await prisma.tenant.findUnique({ where: { slug: req.user.tenant }});
  if (!tenant) return res.status(400).json({ error: 'tenant not found' });
  if (tenant.plan === 'free') {
    const count = await prisma.note.count({ where: { tenantId: tenant.id }});
    if (count >= 3) return res.status(403).json({ error: 'Free plan limit reached' });
  }
  const user = await prisma.user.findUnique({ where: { id: req.user.id }});
  const note = await prisma.note.create({
    data: { title, content: content || '', tenantId: tenant.id, ownerId: user.id }
  });
  res.status(201).json(note);
});

app.get('/api/notes', authMiddleware, async (req, res) => {
  const tenant = await prisma.tenant.findUnique({ where: { slug: req.user.tenant }});
  const notes = await prisma.note.findMany({
    where: { tenantId: tenant.id },
    include: { owner: { select: { id: true, email: true } } },
    orderBy: { createdAt: 'desc' }
  });
  res.json(notes);
});

app.get('/api/notes/:id', authMiddleware, async (req, res) => {
  const { id } = req.params;
  const tenant = await prisma.tenant.findUnique({ where: { slug: req.user.tenant }});
  const note = await prisma.note.findFirst({ where: { id, tenantId: tenant.id }});
  if (!note) return res.status(404).json({ error: 'not found' });
  res.json(note);
});

app.put('/api/notes/:id', authMiddleware, async (req, res) => {
  const { id } = req.params;
  const { title, content } = req.body;
  const tenant = await prisma.tenant.findUnique({ where: { slug: req.user.tenant }});
  let note = await prisma.note.findFirst({ where: { id, tenantId: tenant.id }});
  if (!note) return res.status(404).json({ error: 'not found' });
  note = await prisma.note.update({ where: { id }, data: { title: title || note.title, content: content || note.content }});
  res.json(note);
});

app.delete('/api/notes/:id', authMiddleware, async (req, res) => {
  const { id } = req.params;
  const tenant = await prisma.tenant.findUnique({ where: { slug: req.user.tenant }});
  const note = await prisma.note.findFirst({ where: { id, tenantId: tenant.id }});
  if (!note) return res.status(404).json({ error: 'not found' });
  await prisma.note.delete({ where: { id }});
  res.status(204).send();
});

app.listen(PORT, () => {
  console.log('Server running on port', PORT);
});