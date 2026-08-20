const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cookieParser = require('cookie-parser');
const session = require('express-session');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: true,
    credentials: true
  }
});

const PORT = process.env.PORT || 3000;

// Tạo thư mục uploads nếu chưa tồn tại
const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Config Multer cho Upload Ảnh Bìa
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'cover-' + uniqueSuffix + path.extname(file.originalname));
  }
});
const upload = multer({ storage: storage });

// Middlewares
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser('kaisoul_secret_key'));

const sessionMiddleware = session({
  secret: 'kaisoul_secret_key',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: false, // Để true nếu chạy trên HTTPS
    maxAge: 24 * 60 * 60 * 1000
  }
});

app.use(sessionMiddleware);
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(uploadDir));

// Chia sẻ Session Middleware cho Socket.IO
io.use((socket, next) => {
  sessionMiddleware(socket.request, {}, next);
});

// Database Giả Lập Trong Bộ Nhớ (In-Memory Database)
const users = [
  {
    id: 'user_1',
    display_name: 'KaiSoul Admin 🐬',
    username: 'kaisoul_admin',
    email: 'admin@kaisoul.chat',
    password: 'Password123!',
    verified: true,
    avatar_url: 'https://api.dicebear.com/7.x/bottts/svg?seed=KaiAdmin',
    cover_url: 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe',
    bio: 'Chào mừng bạn đến với KAISOUL CHAT!',
    friend_count: 2
  },
  {
    id: 'user_2',
    display_name: 'Minh Anh 💖',
    username: 'minhanh_genz',
    email: 'minhanh@kaisoul.chat',
    password: 'Password123!',
    verified: true,
    avatar_url: 'https://api.dicebear.com/7.x/avataaars/svg?seed=MinhAnh',
    cover_url: 'https://images.unsplash.com/photo-1579546929518-9e396f3cc809',
    bio: 'Gen Z chính hiệu, thích chat xuyên đêm.',
    friend_count: 1
  },
  {
    id: 'user_3',
    display_name: 'Hoàng Nam 🚀',
    username: 'nam_cyber',
    email: 'nam@kaisoul.chat',
    password: 'Password123!',
    verified: true,
    avatar_url: 'https://api.dicebear.com/7.x/avataaars/svg?seed=HoangNam',
    cover_url: 'https://images.unsplash.com/photo-1550684848-fac1c5b4e853',
    bio: 'Coder by day, gamer by night.',
    friend_count: 1
  }
];

const otps = new Map(); // Store OTP: email -> { code, expiresAt, pendingUser }
const friendsMap = new Map([
  ['user_1', ['user_2', 'user_3']],
  ['user_2', ['user_1']],
  ['user_3', ['user_1']]
]);
const messages = []; // Lịch sử tin nhắn
const onlineUsers = new Map(); // userId -> Set(socketId)

// Middleware Kiểm Tra Đăng Nhập
const requireAuth = (req, res, next) => {
  if (req.session && req.session.userId) {
    const user = users.find(u => u.id === req.session.userId);
    if (user) {
      req.user = user;
      return next();
    }
  }
  return res.status(401).json({ success: false, message: 'Chưa đăng nhập' });
};

// ==========================================
// REST API ENDPOINTS
// ==========================================

// Cấu hình ứng dụng
app.get('/api/config', (req, res) => {
  res.json({
    googleClientId: process.env.GOOGLE_CLIENT_ID || 'MOCK_GOOGLE_CLIENT_ID.apps.googleusercontent.com'
  });
});

// AUTHENTICATION APIs
app.post('/api/auth/register', (req, res) => {
  const { displayName, email, password, confirmPassword } = req.body;

  if (!displayName || !email || !password || !confirmPassword) {
    return res.status(400).json({ success: false, message: 'Vui lòng nhập đầy đủ thông tin.' });
  }

  if (password !== confirmPassword) {
    return res.status(400).json({ success: false, message: 'Mật khẩu nhập lại không khớp.' });
  }

  if (users.find(u => u.email === email)) {
    return res.status(400).json({ success: false, message: 'Email đã tồn tại trên hệ thống.' });
  }

  const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = Date.now() + 10 * 60 * 1000; // Hạn 10 phút

  const newUser = {
    id: 'user_' + Date.now(),
    display_name: displayName,
    username: email.split('@')[0] + '_' + Math.floor(Math.random() * 1000),
    email,
    password,
    verified: false,
    avatar_url: `https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(displayName)}`,
    cover_url: '',
    bio: 'Thành viên mới của KAISOUL CHAT',
    friend_count: 0
  };

  otps.set(email, { code: otpCode, expiresAt, pendingUser: newUser });
  console.log(`[OTP REGISTER] Mã xác minh của ${email} là: ${otpCode}`);

  res.json({ success: true, message: 'Đăng ký thành công! Đã gửi mã OTP.' });
});

app.post('/api/auth/verify', (req, res) => {
  const { email, code } = req.body;
  const record = otps.get(email);

  if (!record) {
    return res.status(400).json({ success: false, message: 'Yêu cầu OTP không hợp lệ hoặc đã hết hạn.' });
  }

  if (Date.now() > record.expiresAt) {
    otps.delete(email);
    return res.status(400).json({ success: false, message: 'Mã OTP đã hết hạn.' });
  }

  if (record.code !== code) {
    return res.status(400).json({ success: false, message: 'Mã OTP không chính xác.' });
  }

  record.pendingUser.verified = true;
  users.push(record.pendingUser);
  otps.delete(email);

  req.session.userId = record.pendingUser.id;
  res.json({ success: true, message: 'Xác minh OTP thành công!', user: record.pendingUser });
});

app.post('/api/auth/resend-otp', (req, res) => {
  const { email } = req.body;
  const record = otps.get(email);

  if (!record) {
    return res.status(400).json({ success: false, message: 'Không tìm thấy yêu cầu xác minh.' });
  }

  const newOtp = Math.floor(100000 + Math.random() * 900000).toString();
  record.code = newOtp;
  record.expiresAt = Date.now() + 10 * 60 * 1000;
  otps.set(email, record);

  console.log(`[OTP RESEND] Mã OTP mới của ${email} là: ${newOtp}`);
  res.json({ success: true, message: 'Mã OTP mới đã được gửi lại.' });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  const user = users.find(u => u.email === email && u.password === password);

  if (!user) {
    return res.status(400).json({ success: false, message: 'Sai email hoặc mật khẩu.' });
  }

  if (!user.verified) {
    return res.json({ success: false, unverified: true, message: 'Tài khoản chưa được xác minh OTP.' });
  }

  req.session.userId = user.id;
  res.json({ success: true, user });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(err => {
    res.clearCookie('connect.sid');
    res.json({ success: true, message: 'Đăng xuất thành công' });
  });
});

app.get('/api/auth/me', (req, res) => {
  if (req.session && req.session.userId) {
    const user = users.find(u => u.id === req.session.userId);
    if (user) {
      return res.json({ success: true, user });
    }
  }
  res.status(401).json({ success: false, message: 'Chưa đăng nhập' });
});

app.post('/api/auth/google', (req, res) => {
  const { credential } = req.body;
  if (!credential) {
    return res.status(400).json({ success: false, message: 'Thiếu credential từ Google Login.' });
  }

  let user = users.find(u => u.email === 'google_user@kaisoul.chat');
  if (!user) {
    user = {
      id: 'google_' + Date.now(),
      display_name: 'Google Gen Z User',
      username: 'google_genz',
      email: 'google_user@kaisoul.chat',
      verified: true,
      avatar_url: 'https://api.dicebear.com/7.x/avataaars/svg?seed=GoogleUser',
      cover_url: '',
      bio: 'Đăng nhập từ Google Identity',
      friend_count: 0
    };
    users.push(user);
  }

  req.session.userId = user.id;
  res.json({ success: true, user });
});

app.post('/api/auth/facebook', (req, res) => {
  res.status(501).json({ success: false, message: 'Đăng nhập Facebook chưa được cấu hình trên server.' });
});

// USER APIs
app.get('/api/users/search', requireAuth, (req, res) => {
  const q = (req.query.q || '').toLowerCase();
  const results = users.filter(u => 
    u.id !== req.user.id &&
    (u.display_name.toLowerCase().includes(q) ||
     u.username.toLowerCase().includes(q) ||
     u.email.toLowerCase().includes(q))
  );
  res.json({ success: true, users: results });
});

app.get('/api/users/profile', requireAuth, (req, res) => {
  const userFriends = friendsMap.get(req.user.id) || [];
  req.user.friend_count = userFriends.length;
  res.json({ success: true, user: req.user });
});

app.post('/api/users/cover', requireAuth, upload.single('cover'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, message: 'Không có tệp ảnh nào được tải lên.' });
  }
  const coverUrl = `/uploads/${req.file.filename}`;
  req.user.cover_url = coverUrl;
  res.json({ success: true, cover_url: coverUrl });
});

app.post('/api/users/cover-url', requireAuth, (req, res) => {
  const { coverUrl } = req.body;
  if (!coverUrl) {
    return res.status(400).json({ success: false, message: 'Thiếu URL ảnh bìa.' });
  }
  req.user.cover_url = coverUrl;
  res.json({ success: true, cover_url: coverUrl });
});

// FRIENDS API
app.get('/api/friends', requireAuth, (req, res) => {
  const friendIds = friendsMap.get(req.user.id) || [];
  const friendList = users.filter(u => friendIds.includes(u.id));
  res.json({ success: true, friends: friendList });
});

// MESSAGES API
app.get('/api/messages/:friendId', requireAuth, (req, res) => {
  const friendId = req.params.friendId;
  const myId = req.user.id;

  const chatHistory = messages.filter(m => 
    (m.sender_id === myId && m.receiver_id === friendId) ||
    (m.sender_id === friendId && m.receiver_id === myId)
  );

  res.json({ success: true, messages: chatHistory });
});

// ==========================================
// REALTIME SOCKET.IO ENGINE
// ==========================================
io.on('connection', (socket) => {
  const sessionData = socket.request.session;
  const userId = sessionData ? sessionData.userId : null;

  if (userId) {
    if (!onlineUsers.has(userId)) {
      onlineUsers.set(userId, new Set());
    }
    onlineUsers.get(userId).add(socket.id);

    // Phát trạng thái Online cho toàn bộ người dùng
    io.emit('user_status', { userId, status: 'online' });
  }

  // Lắng nghe gửi tin nhắn Realtime
  socket.on('send_message', (data) => {
    if (!userId) return;

    const { receiverId, content } = data;
    if (!receiverId || !content) return;

    const newMsg = {
      id: 'msg_' + Date.now(),
      sender_id: userId,
      receiver_id: receiverId,
      content,
      created_at: new Date().toISOString()
    };

    messages.push(newMsg);

    // Xác nhận đã gửi tin nhắn về lại cho client gửi
    socket.emit('message_sent', newMsg);

    // Phát sự kiện nhận tin nhắn cho client người nhận nếu đang kết nối
    const receiverSockets = onlineUsers.get(receiverId);
    if (receiverSockets) {
      receiverSockets.forEach(sId => {
        io.to(sId).emit('receive_message', newMsg);
      });
    }
  });

  // Xử lý khi client ngắt kết nối
  socket.on('disconnect', () => {
    if (userId && onlineUsers.has(userId)) {
      const userSockets = onlineUsers.get(userId);
      userSockets.delete(socket.id);

      if (userSockets.size === 0) {
        onlineUsers.delete(userId);
        io.emit('user_status', { userId, status: 'offline' });
      }
    }
  });
});

// Khởi chạy server
server.listen(PORT, () => {
  console.log(`🐬 KAISOUL CHAT Server đang chạy thành công tại: http://localhost:${PORT}`);
});
