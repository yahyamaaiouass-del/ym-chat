const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const multer = require("multer");
const fs = require("fs");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
  pingTimeout: 60000,
  pingInterval: 25000,
});

const uploadDir = path.join(__dirname, "public", "uploads");
try { if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true }); } catch(e) {}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, Date.now() + "-" + Math.random().toString(36).slice(2, 8) + ext);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|webp|mp4|webm|ogg|mp3|pdf/;
    const ext = allowed.test(path.extname(file.originalname).toLowerCase());
    const mime = allowed.test(file.mimetype.split("/").pop());
    cb(null, ext || mime);
  },
});

app.use(express.static(path.join(__dirname, "public"), { etag: false, lastModified: false }));
app.use((req, res, next) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  res.set("Surrogate-Control", "no-store");
  next();
});

app.post("/upload", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file" });
  res.json({
    url: "/uploads/" + req.file.filename,
    type: req.file.mimetype,
    name: req.file.originalname,
    size: req.file.size,
  });
});

const rooms = {};
const roomMessages = {};
let msgCounter = 0;

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  socket.on("join-room", (room, username) => {
    if (!room || !username) return;
    socket.join(room);
    socket.room = room;
    socket.username = username;
    socket.userId = socket.id;
    if (!rooms[room]) rooms[room] = {};
    rooms[room][username] = { id: socket.id, username };
    if (!roomMessages[room]) roomMessages[room] = [];
    socket.to(room).emit("user-joined", username);
    io.to(room).emit("room-users", Object.values(rooms[room]).map(u => u.username));
  });

  socket.on("chat-message", (data) => {
    if (!data.room || !data.username || !data.message) return;
    const msgId = "msg-" + (++msgCounter) + "-" + Date.now();
    const msgData = {
      id: msgId,
      username: data.username,
      message: data.message,
      type: data.type || "text",
      fileUrl: data.fileUrl || null,
      fileName: data.fileName || null,
      fileSize: data.fileSize || null,
      replyTo: data.replyTo || null,
      replyText: data.replyText || null,
      time: new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: true }),
      status: "delivered",
    };
    roomMessages[data.room].push(msgData);
    if (roomMessages[data.room].length > 200) roomMessages[data.room].shift();
    io.to(data.room).emit("chat-message", msgData);

    setTimeout(() => {
      io.to(data.room).emit("message-status", { id: msgId, status: "read" });
    }, 1500);
  });

  socket.on("delete-message", (data) => {
    if (!data.room || !data.id) return;
    if (roomMessages[data.room]) {
      roomMessages[data.room] = roomMessages[data.room].filter(m => m.id !== data.id);
    }
    io.to(data.room).emit("message-deleted", { id: data.id });
  });

  socket.on("reaction", (data) => {
    if (!data.room || !data.id || !data.emoji) return;
    io.to(data.room).emit("reaction", {
      id: data.id,
      emoji: data.emoji,
      username: data.username,
    });
  });

  socket.on("typing", (data) => {
    if (data && data.room) socket.to(data.room).emit("typing", data.username);
  });

  socket.on("stop-typing", (data) => {
    if (data && data.room) socket.to(data.room).emit("stop-typing");
  });

  socket.on("disconnect", () => {
    if (socket.room && socket.username) {
      if (rooms[socket.room]) {
        delete rooms[socket.room][socket.username];
        const remaining = Object.values(rooms[socket.room]).map(u => u.username);
        if (remaining.length === 0) { delete rooms[socket.room]; delete roomMessages[socket.room]; }
        else io.to(socket.room).emit("room-users", remaining);
      }
      socket.to(socket.room).emit("user-left", socket.username);
    }
  });
});

const PORT = process.env.PORT || 3000;

if (require.main === module) {
  server.listen(PORT, "0.0.0.0", () => console.log(`Server running on http://0.0.0.0:${PORT}`));
}

module.exports = app;
