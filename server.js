// server.js — Криста 9
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');

ffmpeg.setFfmpegPath(ffmpegStatic);

// ========== ПАПКИ ==========
['public/avatars', 'public/music'].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const io = new Server(server);

// ========== RATE LIMITER ==========
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Слишком много запросов'
});
app.use('/api/', limiter);
app.use('/upload/', limiter);

// ========== MULTER для музыки ==========
const musicStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'public/music'),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + ext);   // пока с оригинальным расширением, потом заменим на .ogg
  }
});
const uploadMusic = multer({
  storage: musicStorage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB
  fileFilter: (req, file, cb) => {
    const allowed = /\.(mp3|acc|aac|wav|flac)$/i;
    if (allowed.test(path.extname(file.originalname))) {
      cb(null, true);
    } else {
      cb(new Error('Только MP3, ACC, AAC, WAV, FLAC'));
    }
  }
});

// ========== МОДЕЛИ ==========
const userSchema = new mongoose.Schema({
  uin: { type: String, unique: true },
  nick: String,
  passwordHash: String,
  token: String,
  lastSeen: Date,
  contacts: [String]   // UIN контактов
});
const User = mongoose.model('User', userSchema);

const roomSchema = new mongoose.Schema({
  id: { type: String, unique: true },
  name: String,
  adminOnly: { type: Boolean, default: false },  // true = писать может только создатель
  creator: String,
  admins: [String],
  participants: [String],
  messages: [{
    _id: { type: mongoose.Schema.Types.ObjectId, auto: true },
    createdAt: { type: Date, default: Date.now },
    time: String,
    user: String,
    userId: String,
    text: String
  }]
});
const Room = mongoose.model('Room', roomSchema);

const musicSchema = new mongoose.Schema({
  id: { type: String, unique: true },
  title: String,
  userId: String,
  url: String,
  duration: Number,   // в секундах
  uploadedAt: { type: Date, default: Date.now }
});
const Music = mongoose.model('Music', musicSchema);

// ========== ГЕНЕРАЦИЯ ID ==========
function generateNanoId(length = 8) {
  const chars = '0123456789abcdefghijklmnopqrstuvwxyz';
  let result = '';
  for (let i = 0; i < length; i++) result += chars[crypto.randomInt(chars.length)];
  return result;
}

async function generateUniqueUIN() {
  let uin;
  let exists = true;
  while (exists) {
    const digits = [];
    while (digits.length < 6) {
      const d = crypto.randomInt(10).toString();
      if (!digits.includes(d)) digits.push(d);
    }
    uin = digits.join('');
    exists = await User.exists({ uin });
  }
  return uin;
}

function getCurrentTime() {
  const d = new Date();
  return d.getHours().toString().padStart(2,'0') + ':' + d.getMinutes().toString().padStart(2,'0');
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function isUserOnline(userId) {
  return [...io.sockets.sockets.values()].some(s => s.userId === userId);
}

// ========== ЗАГРУЗКА И КОНВЕРТАЦИЯ МУЗЫКИ ==========
app.post('/upload/music', uploadMusic.single('music'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });
    const tempPath = req.file.path;
    const originalName = req.body.title || path.basename(req.file.originalname, path.extname(req.file.originalname));
    const userId = req.body.userId;

    // Генерируем новое имя для .ogg
    const oggFilename = Date.now() + '-' + Math.round(Math.random() * 1E9) + '.ogg';
    const oggPath = path.join('public/music', oggFilename);

    // Конвертация в OGG
    await new Promise((resolve, reject) => {
      ffmpeg(tempPath)
        .audioCodec('libvorbis')
        .audioBitrate('128k')
        .output(oggPath)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    // Получение длительности
    const duration = await new Promise((resolve, reject) => {
      ffmpeg.ffprobe(oggPath, (err, metadata) => {
        if (err) return reject(err);
        resolve(metadata.format.duration || 0);
      });
    });

    // Удаляем временный файл
    fs.unlinkSync(tempPath);

    const id = generateNanoId(10);
    const url = '/music/' + oggFilename;
    await Music.create({ id, title: originalName, userId, url, duration });

    res.json({ id, title: originalName, url, duration });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка конвертации' });
  }
});

// Список треков с сортировкой по дате загрузки
app.get('/api/music', async (req, res) => {
  const tracks = await Music.find().sort({ uploadedAt: -1 }).limit(100).lean();
  res.json(tracks.map(t => ({
    ...t,
    uploadedAt: t.uploadedAt,
    durationFormatted: formatDuration(t.duration)
  })));
});

function formatDuration(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m.toString().padStart(2,'0')}:${s.toString().padStart(2,'0')}`;
}

// ========== SOCKET.IO ==========
io.on('connection', (socket) => {
  console.log('+ соединение:', socket.id);

  socket.on('register', async (data) => {
    try {
      const { password, nick } = data;
      if (!password || password.length < 4) return socket.emit('authError', 'Пароль от 4 символов');
      if (!nick || nick.trim().length === 0) return socket.emit('authError', 'Никнейм обязателен');
      const uin = await generateUniqueUIN();
      const hash = await bcrypt.hash(password, 10);
      const token = generateToken();
      const user = await User.create({
        uin,
        nick: nick.trim(),
        passwordHash: hash,
        token,
        lastSeen: new Date()
      });
      socket.userId = uin;
      socket.emit('authSuccess', { uin: user.uin, nick: user.nick, token: user.token });
    } catch (e) {
      socket.emit('authError', 'Ошибка регистрации');
    }
  });

  socket.on('login', async (data) => {
    try {
      const { login, password } = data;
      const user = await User.findOne({ uin: login });
      if (!user) return socket.emit('authError', 'Неверный UIN или пароль');
      const valid = await bcrypt.compare(password, user.passwordHash);
      if (!valid) return socket.emit('authError', 'Неверный UIN или пароль');
      user.token = generateToken();
      user.lastSeen = new Date();
      await user.save();
      socket.userId = user.uin;
      socket.emit('authSuccess', { uin: user.uin, nick: user.nick, token: user.token });
    } catch (e) {
      socket.emit('authError', 'Ошибка входа');
    }
  });

  socket.on('loginByToken', async (token) => {
    const user = await User.findOne({ token });
    if (!user) return socket.emit('tokenLoginResult', { success: false });
    user.lastSeen = new Date();
    await user.save();
    socket.userId = user.uin;
    socket.emit('tokenLoginResult', { success: true, profile: { uin: user.uin, nick: user.nick, token: user.token } });
  });

  socket.on('updateProfile', async (data) => {
    const userId = socket.userId;
    if (!userId) return;
    const updates = {};
    if (data.nick) updates.nick = data.nick.trim();
    const user = await User.findOneAndUpdate({ uin: userId }, updates, { new: true });
    socket.emit('profileUpdated', { uin: user.uin, nick: user.nick });
  });

  socket.on('createRoom', async (data) => {
    try {
      const { name, adminOnly } = data;
      const userId = socket.userId;
      if (!name) return;
      const roomId = generateNanoId(7);
      const room = await Room.create({
        id: roomId,
        name,
        adminOnly: adminOnly || false,
        creator: userId,
        admins: [userId],
        participants: [userId],
        messages: []
      });
      socket.emit('roomCreated', { roomId, name, adminOnly });
    } catch (e) {
      socket.emit('systemMessage', { text: 'Ошибка создания комнаты' });
    }
  });

  socket.on('deleteRoom', async (roomId) => {
    const userId = socket.userId;
    const room = await Room.findOne({ id: roomId });
    if (!room || room.creator !== userId) return;
    io.to(roomId).emit('roomDeleted', roomId);
    const sockets = await io.in(roomId).fetchSockets();
    for (const sock of sockets) sock.leave(roomId);
    await Room.deleteOne({ id: roomId });
  });

  socket.on('joinRoom', async (roomId) => {
    const room = await Room.findOne({ id: roomId });
    if (!room) return;
    const userId = socket.userId;
    if (!room.participants.includes(userId)) {
      room.participants.push(userId);
      await room.save();
    }
    socket.join(roomId);

    const participantsInfo = await Promise.all(room.participants.map(async uin => {
      const u = await User.findOne({ uin });
      return {
        uin,
        nick: u?.nick || 'Unknown',
        online: isUserOnline(uin)
      };
    }));

    socket.emit('roomInfo', {
      roomId,
      name: room.name,
      adminOnly: room.adminOnly,
      creator: room.creator,
      participants: participantsInfo,
      messages: room.messages.slice(-100)
    });

    const me = await User.findOne({ uin: userId });
    socket.to(roomId).emit('userJoined', {
      uin: userId,
      nick: me?.nick || 'Unknown'
    });
  });

  socket.on('leaveRoom', async (roomId) => {
    const userId = socket.userId;
    const room = await Room.findOne({ id: roomId });
    if (!room) return;
    room.participants = room.participants.filter(id => id !== userId);
    await room.save();
    socket.leave(roomId);
    io.to(roomId).emit('userLeft', userId);
  });

  socket.on('globalSearch', async ({ query }) => {
    if (!query) return;
    let results = [];
    const roomById = await Room.findOne({ id: query }).lean();
    if (roomById) results.push({ type: 'room', id: roomById.id, name: roomById.name });
    const userByUin = await User.findOne({ uin: query }).lean();
    if (userByUin) results.push({ type: 'user', uin: userByUin.uin, nick: userByUin.nick });
    if (!userByUin) {
      const usersByNick = await User.find({ nick: { $regex: query, $options: 'i' } }).limit(5).lean();
      usersByNick.forEach(u => results.push({ type: 'user', uin: u.uin, nick: u.nick }));
    }
    if (!roomById) {
      const roomsByName = await Room.find({ name: { $regex: query, $options: 'i' } }).limit(5).lean();
      roomsByName.forEach(r => results.push({ type: 'room', id: r.id, name: r.name }));
    }
    socket.emit('searchResults', results.slice(0, 10));
  });

  socket.on('startPrivateChat', async (targetUin) => {
    const userId = socket.userId;
    const target = await User.findOne({ uin: targetUin });
    if (!target) return;
    await User.findOneAndUpdate({ uin: userId }, { $addToSet: { contacts: targetUin } });
    await User.findOneAndUpdate({ uin: targetUin }, { $addToSet: { contacts: userId } });
    const ids = [userId, targetUin].sort();
    const roomId = 'private_' + ids[0] + '_' + ids[1];
    let room = await Room.findOne({ id: roomId });
    if (!room) {
      room = await Room.create({
        id: roomId,
        name: `${target.nick}`,
        adminOnly: false,
        creator: 'system',
        participants: [userId, targetUin],
        messages: []
      });
    }
    socket.join(roomId);
    socket.emit('privateRoomReady', { roomId, targetNick: target.nick });
    const messages = room.messages.slice(-100);
    socket.emit('roomInfo', {
      roomId,
      name: room.name,
      adminOnly: false,
      participants: [
        { uin: userId, nick: (await User.findOne({ uin: userId }))?.nick || 'Вы' },
        { uin: targetUin, nick: target.nick, online: isUserOnline(targetUin) }
      ],
      messages
    });
  });

  socket.on('getMainList', async () => {
    const userId = socket.userId;
    const user = await User.findOne({ uin: userId });
    if (!user) return;
    const contacts = await Promise.all(user.contacts.map(async cid => {
      const p = await User.findOne({ uin: cid });
      return {
        id: cid,
        nick: p?.nick || 'Unknown',
        online: isUserOnline(cid),
        lastSeen: p?.lastSeen
      };
    }));
    const rooms = await Room.find({
      participants: userId,
      id: { $not: /^private_/ }
    }).lean();
    const roomList = rooms.map(r => ({
      id: r.id,
      name: r.name,
      adminOnly: r.adminOnly,
      creator: r.creator
    }));
    socket.emit('mainList', { contacts, rooms: roomList });
  });

  socket.on('chatMessage', async (data) => {
    const { roomId, text } = data;
    const userId = socket.userId;
    if (!userId || !text) return;
    const user = await User.findOne({ uin: userId });
    const room = await Room.findOne({ id: roomId });
    if (!user || !room) return;
    if (room.adminOnly && room.creator !== userId) return;
    const msg = {
      createdAt: new Date(),
      time: getCurrentTime(),
      user: user.nick,
      userId,
      text
    };
    room.messages.push(msg);
    await room.save();
    io.to(roomId).emit('newMessage', room.messages[room.messages.length - 1].toObject());
  });

  socket.on('disconnect', async () => {
    if (socket.userId) {
      await User.findOneAndUpdate({ uin: socket.userId }, { lastSeen: new Date() });
    }
  });
});

// ========== ЗАПУСК ==========
const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/krista9';
mongoose.connect(MONGO_URI)
  .then(() => {
    console.log('MongoDB подключена');
    server.listen(PORT, () => console.log(`Криста 9 на порту ${PORT}`));
  })
  .catch(err => {
    console.error('Ошибка MongoDB:', err);
    process.exit(1);
  });
