// ============================================================
// Lab 4 - Secure Connect and Communication Platform
// Node.js + Express + JWT + bcrypt + dotenv + Socket.IO
// ============================================================

require("dotenv").config(); // .env file se variables load karta hai

const express = require("express");
const http = require("http");
const path = require("path");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const EventEmitter = require("events");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app); // Socket.IO ko http server chahiye
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "1h";

app.use(express.json());
app.use(express.static(path.join(__dirname, "public"))); // chat page

// ------------------------------------------------------------
// 1. In-memory "database" (arrays) - restart pe data reset ho jata hai
// ------------------------------------------------------------
const users = [];
const notes = [];
let nextUserId = 1;
let nextNoteId = 1;

// ------------------------------------------------------------
// 2. Event-driven features (EventEmitter)
// ------------------------------------------------------------
const appEvents = new EventEmitter();

appEvents.on("user:signup", (user) => {
  console.log(`[EVENT] user:signup -> ${user.username} (${user.role})`);
});
appEvents.on("user:login", (user) => {
  console.log(`[EVENT] user:login -> ${user.username}`);
});
appEvents.on("note:created", (note) => {
  console.log(`[EVENT] note:created -> "${note.title}" by user ${note.userId}`);
});
appEvents.on("note:deleted", (note) => {
  console.log(`[EVENT] note:deleted -> "${note.title}" by user ${note.userId}`);
});
appEvents.on("chat:message", (msg) => {
  console.log(`[EVENT] chat:message -> ${msg.username}: ${msg.text}`);
});

// ------------------------------------------------------------
// 3. Auth middleware (JWT verify) + Role check (RBAC)
// ------------------------------------------------------------
function authenticate(req, res, next) {
  const header = req.headers.authorization; // "Bearer <token>"
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ success: false, message: "Token missing" });
  }

  try {
    const token = header.split(" ")[1];
    req.user = jwt.verify(token, JWT_SECRET); // { id, username, role }
    next();
  } catch (err) {
    return res
      .status(401)
      .json({ success: false, message: "Invalid or expired token" });
  }
}

function authorizeRoles(...allowedRoles) {
  return (req, res, next) => {
    if (!allowedRoles.includes(req.user.role)) {
      return res
        .status(403)
        .json({ success: false, message: "Access denied: insufficient role" });
    }
    next();
  };
}

// ------------------------------------------------------------
// 4. Signup and Login
// ------------------------------------------------------------
app.post("/auth/signup", async (req, res, next) => {
  try {
    const { username, password, role } = req.body;

    if (!username || !password) {
      return res
        .status(400)
        .json({ success: false, message: "username and password required" });
    }
    if (password.length < 6) {
      return res
        .status(400)
        .json({ success: false, message: "password must be 6+ characters" });
    }
    if (users.find((u) => u.username === username)) {
      return res
        .status(409)
        .json({ success: false, message: "username already exists" });
    }

    const hashedPassword = await bcrypt.hash(password, 10); // 10 = salt rounds

    const user = {
      id: nextUserId++,
      username,
      password: hashedPassword,
      // Lab demo ke liye role body se le rahe hain (real app mein ye nahi karte)
      role: role === "admin" ? "admin" : "user",
    };
    users.push(user);

    appEvents.emit("user:signup", user);

    res.status(201).json({
      success: true,
      message: "Signup successful",
      user: { id: user.id, username: user.username, role: user.role },
    });
  } catch (err) {
    next(err);
  }
});

app.post("/auth/login", async (req, res, next) => {
  try {
    const { username, password } = req.body;

    const user = users.find((u) => u.username === username);
    // Same message dono case mein, taaki attacker ko hint na mile
    if (!user || !(await bcrypt.compare(password || "", user.password))) {
      return res
        .status(401)
        .json({ success: false, message: "Invalid username or password" });
    }

    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );

    appEvents.emit("user:login", user);

    res.json({ success: true, message: "Login successful", token });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------
// 5. Protected routes + RBAC
// ------------------------------------------------------------
app.get("/profile", authenticate, (req, res) => {
  res.json({ success: true, user: req.user });
});

app.get("/admin/users", authenticate, authorizeRoles("admin"), (req, res) => {
  const list = users.map((u) => ({
    id: u.id,
    username: u.username,
    role: u.role,
  }));
  res.json({ success: true, users: list });
});

// ------------------------------------------------------------
// 6. Secure Notes API (har user sirf apne notes dekh sakta hai)
// ------------------------------------------------------------
app.post("/notes", authenticate, (req, res) => {
  const { title, content } = req.body;
  if (!title || !content) {
    return res
      .status(400)
      .json({ success: false, message: "title and content required" });
  }

  const note = { id: nextNoteId++, userId: req.user.id, title, content };
  notes.push(note);

  appEvents.emit("note:created", note);
  res.status(201).json({ success: true, note });
});

app.get("/notes", authenticate, (req, res) => {
  const myNotes = notes.filter((n) => n.userId === req.user.id);
  res.json({ success: true, count: myNotes.length, notes: myNotes });
});

app.get("/notes/:id", authenticate, (req, res) => {
  const note = notes.find(
    (n) => n.id === parseInt(req.params.id) && n.userId === req.user.id
  );
  if (!note) {
    return res.status(404).json({ success: false, message: "Note not found" });
  }
  res.json({ success: true, note });
});

app.put("/notes/:id", authenticate, (req, res) => {
  const note = notes.find(
    (n) => n.id === parseInt(req.params.id) && n.userId === req.user.id
  );
  if (!note) {
    return res.status(404).json({ success: false, message: "Note not found" });
  }

  const { title, content } = req.body;
  if (title) note.title = title;
  if (content) note.content = content;

  res.json({ success: true, note });
});

app.delete("/notes/:id", authenticate, (req, res) => {
  const index = notes.findIndex(
    (n) => n.id === parseInt(req.params.id) && n.userId === req.user.id
  );
  if (index === -1) {
    return res.status(404).json({ success: false, message: "Note not found" });
  }

  const [deleted] = notes.splice(index, 1);
  appEvents.emit("note:deleted", deleted);

  res.json({ success: true, message: "Note deleted" });
});

// ------------------------------------------------------------
// 7. Real-time chat (Socket.IO) - JWT se secured
// ------------------------------------------------------------
io.use((socket, next) => {
  try {
    const token = socket.handshake.auth.token;
    socket.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    next(new Error("Authentication failed"));
  }
});

io.on("connection", (socket) => {
  const { username } = socket.user;
  console.log(`[SOCKET] ${username} connected`);

  io.emit("chat:system", `${username} joined the chat`);

  socket.on("chat:message", (text) => {
    if (!text || !text.trim()) return;

    const msg = {
      username,
      text: text.trim(),
      time: new Date().toLocaleTimeString(),
    };

    appEvents.emit("chat:message", msg); // event-driven log
    io.emit("chat:message", msg); // sabko bhejo
  });

  socket.on("disconnect", () => {
    console.log(`[SOCKET] ${username} disconnected`);
    io.emit("chat:system", `${username} left the chat`);
  });
});

// ------------------------------------------------------------
// 8. 404 + Error handlers (hamesha sabse last mein)
// ------------------------------------------------------------
app.use((req, res) => {
  res.status(404).json({ success: false, message: "Route not found" });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ success: false, message: err.message });
});

server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
