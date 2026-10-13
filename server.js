const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const multer = require("multer");
const bcrypt = require("bcryptjs");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const allowedOrigins = new Set([
  "https://gametikavision.netlify.app",
  "http://localhost:8888",
  "http://127.0.0.1:8888"
]);
const io = new Server(server, {
  cors: { origin: [...allowedOrigins], methods: ["GET", "POST"], credentials: false }
});
const PORT = Number(process.env.PORT || 3000);
const SECRET = process.env.AUTH_SECRET || process.env.SESSION_SECRET;
if (!SECRET || SECRET.length < 32) {
  console.warn("WARNUNG: Setze in Render AUTH_SECRET auf einen zufälligen Wert mit mindestens 32 Zeichen.");
}
const TOKEN_SECRET = SECRET || crypto.randomBytes(48).toString("hex");
const DATA_DIR = path.join(__dirname, "data");
const MEDIA_DIR = path.join(__dirname, "public", "media");
const AVATAR_DIR = path.join(__dirname, "public", "avatars");
for (const dir of [DATA_DIR, MEDIA_DIR, AVATAR_DIR]) fs.mkdirSync(dir, { recursive: true });
const DB_FILE = path.join(DATA_DIR, "database.json");
if (!fs.existsSync(DB_FILE)) {
  fs.writeFileSync(DB_FILE, JSON.stringify({ users: [], videos: [], follows: [], friends: [], messages: [], publicMessages: [], comments: [] }, null, 2));
}
function db() {
  try {
    const d = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
    for (const key of ["users", "videos", "follows", "friends", "messages", "publicMessages", "comments"]) if (!Array.isArray(d[key])) d[key] = [];
    return d;
  } catch {
    return { users: [], videos: [], follows: [], friends: [], messages: [], publicMessages: [], comments: [] };
  }
}
function save(d) {
  const tmp = DB_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(d, null, 2));
  fs.renameSync(tmp, DB_FILE);
}
const clean = (v, max = 500) => String(v ?? "").replace(/[<>]/g, "").trim().slice(0, max);
const publicUser = u => ({
  id: u.id, username: u.username, displayName: u.displayName,
  bio: u.bio || "", avatar: u.avatar || "", role: u.role || "member",
  createdAt: u.createdAt
});
function signToken(userId) {
  const payload = Buffer.from(JSON.stringify({ sub: userId, exp: Date.now() + 7 * 24 * 60 * 60 * 1000 })).toString("base64url");
  const sig = crypto.createHmac("sha256", TOKEN_SECRET).update(payload).digest("base64url");
  return payload + "." + sig;
}
function verifyToken(token) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const expected = crypto.createHmac("sha256", TOKEN_SECRET).update(parts[0]).digest();
  let actual;
  try { actual = Buffer.from(parts[1], "base64url"); } catch { return null; }
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    return payload.exp > Date.now() ? payload.sub : null;
  } catch { return null; }
}
function auth(req, res, next) {
  const header = req.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const id = verifyToken(token);
  const u = id ? db().users.find(x => x.id === id && !x.disabled) : null;
  if (!u) return res.status(401).json({ error: "Bitte anmelden oder erneut anmelden." });
  req.user = u;
  next();
}
function admin(req, res, next) {
  return auth(req, res, () => req.user.role === "admin" ? next() : res.status(403).json({ error: "Nur Administratoren dürfen das." }));
}
function sendError(err, req, res, next) {
  if (res.headersSent) return next(err);
  console.error(err);
  const status = err.status || (err.code === "LIMIT_FILE_SIZE" ? 413 : 500);
  res.status(status).json({ error: status === 413 ? "Die Datei ist zu groß." : (err.message || "Serverfehler.") });
}
app.disable("x-powered-by");
app.use((req, res, next) => {
  const origin = req.get("origin");
  if (origin && allowedOrigins.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (_req, res) => res.json({ service: "GAMETIKA API", status: "ok", health: "/health" }));
app.get("/health", (_req, res) => res.json({ status: "ok", service: "GAMETIKA API", time: new Date().toISOString() }));

const mediaExt = new Set([".mp4", ".webm", ".mov"]);
function storageTo(dir) {
  return multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, dir),
    filename: (_req, file, cb) => cb(null, crypto.randomBytes(18).toString("hex") + path.extname(file.originalname).toLowerCase())
  });
}
const upload = multer({
  storage: storageTo(MEDIA_DIR), limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => mediaExt.has(path.extname(file.originalname).toLowerCase()) ? cb(null, true) : cb(Object.assign(new Error("Nur MP4, WebM und MOV sind erlaubt."), { status: 400 }))
});
const avatarUpload = multer({
  storage: storageTo(AVATAR_DIR), limits: { fileSize: 3 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => ["image/jpeg", "image/png", "image/webp"].includes(file.mimetype) ? cb(null, true) : cb(Object.assign(new Error("Profilbild muss JPG, PNG oder WebP sein."), { status: 400 }))
});
const time = () => new Date().toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
const id = () => crypto.randomUUID();
function publicVideo(v, viewer = null, d = db()) {
  return { id: v.id, title: v.title, description: v.description, url: v.url, ownerId: v.ownerId, ownerName: v.ownerName, createdAt: v.createdAt, likes: (v.likedBy || []).length, liked: !!viewer && (v.likedBy || []).includes(viewer), commentCount: d.comments.filter(c => c.videoId === v.id).length };
}
function friendship(d, a, b) { return d.friends.find(f => (f.a === a && f.b === b) || (f.a === b && f.b === a)); }

app.get("/api/me", auth, (req, res) => {
  const d = db();
  res.json({ user: { ...publicUser(req.user), followersCount: d.follows.filter(f => f.to === req.user.id).length, followingCount: d.follows.filter(f => f.from === req.user.id).length } });
});
app.post("/api/register", async (req, res, next) => {
  try {
    const username = clean(req.body.username, 24).toLowerCase();
    const displayName = clean(req.body.displayName, 40);
    const password = String(req.body.password || "");
    if (!/^[a-z0-9_]{3,24}$/.test(username)) return res.status(400).json({ error: "Benutzername: 3–24 Zeichen, nur Kleinbuchstaben, Zahlen und _." });
    if (displayName.length < 2) return res.status(400).json({ error: "Bitte einen Anzeigenamen mit mindestens 2 Zeichen eingeben." });
    if (password.length < 8 || password.length > 200) return res.status(400).json({ error: "Das Passwort muss mindestens 8 Zeichen lang sein." });
    const d = db();
    if (d.users.some(u => u.username === username)) return res.status(409).json({ error: "Dieser Benutzername ist bereits vergeben." });
    const u = { id: id(), username, displayName, passwordHash: await bcrypt.hash(password, 12), bio: "", avatar: "", role: "member", disabled: false, createdAt: new Date().toISOString() };
    d.users.push(u); save(d);
    res.status(201).json({ user: publicUser(u), token: signToken(u.id) });
  } catch (e) { next(e); }
});
app.post("/api/login", async (req, res, next) => {
  try {
    const username = clean(req.body.username, 24).toLowerCase();
    const password = String(req.body.password || "");
    const u = db().users.find(x => x.username === username);
    if (!u || !await bcrypt.compare(password, u.passwordHash)) return res.status(401).json({ error: "Benutzername oder Passwort falsch." });
    if (u.disabled) return res.status(403).json({ error: "Dieses Konto ist gesperrt." });
    res.json({ user: publicUser(u), token: signToken(u.id) });
  } catch (e) { next(e); }
});
app.post("/api/logout", (_req, res) => res.json({ ok: true }));
app.patch("/api/profile", auth, (req, res) => {
  const d = db(), u = d.users.find(x => x.id === req.user.id);
  u.displayName = clean(req.body.displayName, 40) || u.displayName;
  u.bio = clean(req.body.bio, 300);
  save(d); res.json({ user: publicUser(u) });
});
app.post("/api/profile/avatar", auth, (req, res, next) => avatarUpload.single("avatar")(req, res, err => {
  if (err) return next(err);
  if (!req.file) return res.status(400).json({ error: "Bitte ein Bild auswählen." });
  const d = db(), u = d.users.find(x => x.id === req.user.id);
  u.avatar = "/avatars/" + req.file.filename; save(d); res.json({ user: publicUser(u) });
}));
app.get("/api/members", auth, (req, res) => {
  const d = db();
  res.json({ members: d.users.filter(u => u.id !== req.user.id && !u.disabled).map(u => ({
    ...publicUser(u), isFollowing: d.follows.some(f => f.from === req.user.id && f.to === u.id),
    followersCount: d.follows.filter(f => f.to === u.id).length
  })) });
});
app.post("/api/follow/:id", auth, (req, res) => {
  const targetId = req.params.id, d = db();
  if (targetId === req.user.id) return res.status(400).json({ error: "Du kannst dir nicht selbst folgen." });
  if (!d.users.some(u => u.id === targetId && !u.disabled)) return res.status(404).json({ error: "Mitglied nicht gefunden." });
  const idx = d.follows.findIndex(f => f.from === req.user.id && f.to === targetId);
  if (idx >= 0) { d.follows.splice(idx, 1); save(d); return res.json({ following: false }); }
  d.follows.push({ from: req.user.id, to: targetId, createdAt: new Date().toISOString() }); save(d);
  res.json({ following: true });
});
app.post("/api/friends/request", auth, (req, res) => {
  const targetId = String(req.body.userId || ""), d = db();
  if (!targetId || targetId === req.user.id || !d.users.some(u => u.id === targetId && !u.disabled)) return res.status(400).json({ error: "Mitglied nicht gefunden." });
  const f = friendship(d, req.user.id, targetId);
  if (f) {
    if (f.status === "pending" && f.from !== req.user.id) { f.status = "accepted"; save(d); return res.json({ ok: true, status: "accepted" }); }
    return res.status(409).json({ error: "Freundschaftsanfrage existiert bereits." });
  }
  d.friends.push({ a: req.user.id, b: targetId, from: req.user.id, status: "pending", createdAt: new Date().toISOString() }); save(d); res.json({ ok: true, status: "pending" });
});
app.post("/api/friends/accept", auth, (req, res) => {
  const d = db(), f = friendship(d, req.user.id, String(req.body.userId || ""));
  if (!f || f.status !== "pending" || f.from === req.user.id) return res.status(400).json({ error: "Keine offene Anfrage von diesem Mitglied." });
  f.status = "accepted"; save(d); res.json({ ok: true });
});
app.get("/api/friends", auth, (req, res) => {
  const d = db(), ids = d.friends.filter(f => f.status === "accepted" && (f.a === req.user.id || f.b === req.user.id)).map(f => f.a === req.user.id ? f.b : f.a);
  res.json({ friends: d.users.filter(u => ids.includes(u.id) && !u.disabled).map(publicUser) });
});
app.get("/api/videos", (req, res) => {
  const d = db();
  res.json({ videos: d.videos.filter(v => !v.deleted).slice().reverse().map(v => publicVideo(v, null, d)) });
});
app.post("/api/videos", auth, (req, res, next) => upload.single("file")(req, res, err => {
  if (err) return next(err);
  if (!req.file) return res.status(400).json({ error: "Bitte eine Videodatei auswählen." });
  const title = clean(req.body.title, 100);
  if (!title) { fs.unlink(req.file.path, () => {}); return res.status(400).json({ error: "Bitte einen Titel eingeben." }); }
  const d = db(), v = { id: id(), title, description: clean(req.body.description, 500), storedName: req.file.filename, url: "/media/" + req.file.filename, ownerId: req.user.id, ownerName: req.user.displayName, likedBy: [], createdAt: new Date().toISOString() };
  d.videos.push(v); save(d); res.status(201).json({ video: publicVideo(v, req.user.id, d) });
}));
app.post("/api/videos/:id/like", auth, (req, res) => {
  const d = db(), v = d.videos.find(x => x.id === req.params.id && !x.deleted);
  if (!v) return res.status(404).json({ error: "Video nicht gefunden." });
  v.likedBy = v.likedBy || [];
  const idx = v.likedBy.indexOf(req.user.id);
  if (idx >= 0) v.likedBy.splice(idx, 1); else v.likedBy.push(req.user.id);
  save(d); res.json({ liked: idx < 0, likes: v.likedBy.length });
});
app.get("/api/videos/:id/comments", (req, res) => {
  const d = db();
  if (!d.videos.some(v => v.id === req.params.id && !v.deleted)) return res.status(404).json({ error: "Video nicht gefunden." });
  res.json({ comments: d.comments.filter(c => c.videoId === req.params.id).slice(-100) });
});
app.post("/api/videos/:id/comments", auth, (req, res) => {
  const d = db(), v = d.videos.find(x => x.id === req.params.id && !x.deleted), text = clean(req.body.text, 500);
  if (!v) return res.status(404).json({ error: "Video nicht gefunden." });
  if (!text) return res.status(400).json({ error: "Kommentar ist leer." });
  const comment = { id: id(), videoId: v.id, userId: req.user.id, displayName: req.user.displayName, text, time: time(), createdAt: new Date().toISOString() };
  d.comments.push(comment); save(d); res.status(201).json({ comment });
});
app.get("/api/chat/public", auth, (_req, res) => res.json({ messages: db().publicMessages.slice(-100) }));
app.get("/api/messages/:id", auth, (req, res) => {
  const target = req.params.id, d = db();
  if (!d.users.some(u => u.id === target)) return res.status(404).json({ error: "Mitglied nicht gefunden." });
  res.json({ messages: d.messages.filter(m => (m.fromId === req.user.id && m.toId === target) || (m.fromId === target && m.toId === req.user.id)).slice(-200) });
});
app.post("/api/messages/:id", auth, (req, res) => {
  const target = req.params.id, d = db(), recipient = d.users.find(u => u.id === target && !u.disabled), text = clean(req.body.text, 1000);
  if (!recipient || target === req.user.id) return res.status(400).json({ error: "Empfänger nicht gefunden." });
  if (!text) return res.status(400).json({ error: "Nachricht ist leer." });
  const message = { id: id(), fromId: req.user.id, fromName: req.user.displayName, toId: target, text, time: time(), createdAt: new Date().toISOString() };
  d.messages.push(message); save(d); io.to("user:" + target).emit("private message", message); io.to("user:" + req.user.id).emit("private message", message); res.status(201).json({ message });
});
app.get("/api/admin", admin, (_req, res) => {
  const d = db(); res.json({ users: d.users.map(u => ({ ...publicUser(u), disabled: !!u.disabled })), videos: d.videos.filter(v => !v.deleted).map(v => publicVideo(v, null, d)) });
});
app.delete("/api/admin/users/:id", admin, (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: "Du kannst dein eigenes Admin-Konto nicht sperren." });
  const d = db(), u = d.users.find(x => x.id === req.params.id);
  if (!u) return res.status(404).json({ error: "Mitglied nicht gefunden." });
  u.disabled = true; save(d); res.json({ ok: true });
});
app.delete("/api/admin/videos/:id", admin, (req, res) => {
  const d = db(), v = d.videos.find(x => x.id === req.params.id);
  if (!v) return res.status(404).json({ error: "Video nicht gefunden." });
  v.deleted = true; save(d); if (v.storedName) fs.unlink(path.join(MEDIA_DIR, v.storedName), () => {}); res.json({ ok: true });
});

io.use((socket, next) => {
  const token = socket.handshake.auth && socket.handshake.auth.token;
  const userId = verifyToken(token);
  const u = userId ? db().users.find(x => x.id === userId && !x.disabled) : null;
  if (!u) return next(new Error("Nicht angemeldet"));
  socket.user = u; next();
});
io.on("connection", socket => {
  socket.join("user:" + socket.user.id);
  socket.on("public message", raw => {
    const d = db(), text = clean(raw && raw.text, 1000);
    if (!text) return;
    const message = { id: id(), fromId: socket.user.id, fromName: socket.user.displayName, text, time: time(), createdAt: new Date().toISOString() };
    d.publicMessages.push(message); d.publicMessages = d.publicMessages.slice(-100); save(d); io.emit("public message", message);
  });
});
app.use(sendError);
async function bootstrapAdmin() {
  const username = clean(process.env.ADMIN_USERNAME || "admin", 24).toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  if (!password) { console.warn("ADMIN_PASSWORD nicht gesetzt; Admin-Konto wird nicht erstellt."); return; }
  if (password.length < 12) { console.warn("ADMIN_PASSWORD muss mindestens 12 Zeichen lang sein; Admin-Konto wird nicht erstellt."); return; }
  const d = db();
  if (d.users.some(u => u.username === username)) return;
  d.users.push({ id: id(), username, displayName: "Administrator", passwordHash: await bcrypt.hash(password, 12), bio: "", avatar: "", role: "admin", disabled: false, createdAt: new Date().toISOString() });
  save(d); console.log("Admin-Konto angelegt.");
}
bootstrapAdmin().then(() => server.listen(PORT, "0.0.0.0", () => console.log("GAMETIKA API läuft auf Port " + PORT)));
