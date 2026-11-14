import 'dotenv/config';
import express, { type Request, type Response } from 'express';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import mongoose, { Schema, type Document } from 'mongoose';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { Server, type Socket } from 'socket.io';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const IS_PROD = process.env.NODE_ENV === 'production';
const PORT = IS_PROD ? Number(process.env.PORT) || 3000 : 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'ball_vs_ball_jwt_secret_key_2026';
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/ball-vs-ball';
const BCRYPT_SALT_ROUNDS = 10;

// ============================================================================
// DATABASE SCHEMA (MongoDB + Mongoose)
// ============================================================================
export interface IUser extends Document {
  username: string;
  passwordHash?: string;
  coins: number;
  isGuest: boolean;
  unlockedBalls: string[];
}

const UserSchema = new Schema<IUser>(
  {
    username: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    passwordHash: {
      type: String,
      required: false,
    },
    coins: {
      type: Number,
      default: 0,
    },
    isGuest: {
      type: Boolean,
      default: false,
    },
    unlockedBalls: {
      type: [String],
      default: [],
    },
  },
  {
    timestamps: true,
  }
);

export const User =
  (mongoose.models.User as mongoose.Model<IUser>) ||
  mongoose.model<IUser>('User', UserSchema);

interface StoredUserRecord {
  _id: string;
  username: string;
  passwordHash?: string;
  coins: number;
  isGuest: boolean;
  unlockedBalls: string[];
}

const FALLBACK_DB_PATH = path.join(__dirname, '.data', 'users.json');
const fallbackUsersById = new Map<string, StoredUserRecord>();

function loadFallbackStore(): void {
  try {
    if (fs.existsSync(FALLBACK_DB_PATH)) {
      const raw = fs.readFileSync(FALLBACK_DB_PATH, 'utf-8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item && typeof item._id === 'string' && typeof item.username === 'string') {
            fallbackUsersById.set(item._id, {
              _id: item._id,
              username: item.username,
              passwordHash: item.passwordHash,
              coins: typeof item.coins === 'number' ? item.coins : 0,
              isGuest: Boolean(item.isGuest),
              unlockedBalls: Array.isArray(item.unlockedBalls) ? item.unlockedBalls : [],
            });
          }
        }
      }
    }
  } catch (err) {
    console.warn('[Database] Fallback store load warning:', err);
  }
}

function saveFallbackStore(): void {
  try {
    const dir = path.dirname(FALLBACK_DB_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(
      FALLBACK_DB_PATH,
      JSON.stringify(Array.from(fallbackUsersById.values()), null, 2),
      'utf-8'
    );
  } catch (err) {
    console.warn('[Database] Fallback store save warning:', err);
  }
}

loadFallbackStore();

function isMongoConnected(): boolean {
  return mongoose.connection.readyState === 1;
}

async function connectDatabase(): Promise<void> {
  try {
    await mongoose.connect(MONGODB_URI, {
      serverSelectionTimeoutMS: 2500,
    });
    console.log('[Database] Connected to MongoDB via mongoose');
  } catch (err) {
    console.warn(
      '[Database] MongoDB instance not reachable at MONGODB_URI; using Mongoose schema validation with local persistent store fallback.'
    );
  }
}

async function findUserByUsername(username: string): Promise<StoredUserRecord | null> {
  const normalized = username.trim();
  if (isMongoConnected()) {
    const doc = await User.findOne({ username: normalized }).lean();
    if (!doc) return null;
    return {
      _id: String(doc._id),
      username: doc.username,
      passwordHash: doc.passwordHash,
      coins: doc.coins ?? 0,
      isGuest: Boolean(doc.isGuest),
      unlockedBalls: Array.isArray(doc.unlockedBalls) ? doc.unlockedBalls : [],
    };
  }
  const lower = normalized.toLowerCase();
  for (const user of fallbackUsersById.values()) {
    if (user.username.toLowerCase() === lower) {
      return { ...user };
    }
  }
  return null;
}

async function findUserById(userId: string): Promise<StoredUserRecord | null> {
  if (!userId) return null;
  if (isMongoConnected() && mongoose.Types.ObjectId.isValid(userId)) {
    const doc = await User.findById(userId).lean();
    if (!doc) return null;
    return {
      _id: String(doc._id),
      username: doc.username,
      passwordHash: doc.passwordHash,
      coins: doc.coins ?? 0,
      isGuest: Boolean(doc.isGuest),
      unlockedBalls: Array.isArray(doc.unlockedBalls) ? doc.unlockedBalls : [],
    };
  }
  const found = fallbackUsersById.get(userId);
  return found ? { ...found } : null;
}

async function createUserRecord(data: {
  username: string;
  passwordHash?: string;
  coins?: number;
  isGuest: boolean;
  unlockedBalls?: string[];
}): Promise<StoredUserRecord> {
  // Always instantiate and validate against the Mongoose User model
  const mongooseDoc = new User({
    username: data.username.trim(),
    passwordHash: data.passwordHash,
    coins: typeof data.coins === 'number' ? data.coins : 0,
    isGuest: Boolean(data.isGuest),
    unlockedBalls: Array.isArray(data.unlockedBalls) ? data.unlockedBalls : [],
  });
  const validationError = mongooseDoc.validateSync();
  if (validationError) {
    throw validationError;
  }

  if (isMongoConnected()) {
    const saved = await mongooseDoc.save();
    return {
      _id: String(saved._id),
      username: saved.username,
      passwordHash: saved.passwordHash,
      coins: saved.coins ?? 0,
      isGuest: Boolean(saved.isGuest),
      unlockedBalls: Array.isArray(saved.unlockedBalls) ? saved.unlockedBalls : [],
    };
  }

  const record: StoredUserRecord = {
    _id: String(mongooseDoc._id),
    username: mongooseDoc.username,
    passwordHash: mongooseDoc.passwordHash,
    coins: mongooseDoc.coins ?? 0,
    isGuest: Boolean(mongooseDoc.isGuest),
    unlockedBalls: Array.isArray(mongooseDoc.unlockedBalls) ? [...mongooseDoc.unlockedBalls] : [],
  };
  fallbackUsersById.set(record._id, record);
  saveFallbackStore();
  return record;
}

async function updateUserRecord(
  userId: string,
  updates: Partial<Omit<StoredUserRecord, '_id'>>
): Promise<StoredUserRecord | null> {
  if (isMongoConnected() && mongoose.Types.ObjectId.isValid(userId)) {
    const updated = await User.findByIdAndUpdate(
      userId,
      { $set: updates },
      { new: true, runValidators: true }
    ).lean();
    if (!updated) return null;
    return {
      _id: String(updated._id),
      username: updated.username,
      passwordHash: updated.passwordHash,
      coins: updated.coins ?? 0,
      isGuest: Boolean(updated.isGuest),
      unlockedBalls: Array.isArray(updated.unlockedBalls) ? updated.unlockedBalls : [],
    };
  }

  const existing = fallbackUsersById.get(userId);
  if (!existing) return null;
  const merged: StoredUserRecord = {
    ...existing,
    ...updates,
    _id: existing._id,
  };
  fallbackUsersById.set(userId, merged);
  saveFallbackStore();
  return merged;
}

async function incrementUserCoins(
  userId: string | undefined,
  delta: number
): Promise<StoredUserRecord | null> {
  if (!userId || !Number.isFinite(delta)) return null;
  if (isMongoConnected() && mongoose.Types.ObjectId.isValid(userId)) {
    const current = await User.findById(userId);
    if (!current) return null;
    current.coins = Math.max(0, Math.floor((current.coins ?? 0) + delta));
    const saved = await current.save();
    return {
      _id: String(saved._id),
      username: saved.username,
      passwordHash: saved.passwordHash,
      coins: saved.coins ?? 0,
      isGuest: Boolean(saved.isGuest),
      unlockedBalls: Array.isArray(saved.unlockedBalls) ? saved.unlockedBalls : [],
    };
  }

  const existing = fallbackUsersById.get(userId);
  if (!existing) return null;
  const updated: StoredUserRecord = {
    ...existing,
    coins: Math.max(0, Math.floor(existing.coins + delta)),
  };
  fallbackUsersById.set(userId, updated);
  saveFallbackStore();
  return updated;
}

async function purchaseCharacterInDb(
  userId: string | undefined,
  characterId: string,
  cost: number
): Promise<{ ok: boolean; user?: StoredUserRecord; error?: string; alreadyUnlocked?: boolean }> {
  if (!userId) {
    return { ok: false, error: 'Unauthorized user.' };
  }
  const cleanCharId = characterId.trim();
  if (!cleanCharId) {
    return { ok: false, error: 'Invalid character ID.' };
  }
  const normalizedCost = Math.max(0, Math.floor(cost));

  if (isMongoConnected() && mongoose.Types.ObjectId.isValid(userId)) {
    const userDoc = await User.findById(userId);
    if (!userDoc) {
      return { ok: false, error: 'User not found.' };
    }
    if (userDoc.unlockedBalls.includes(cleanCharId)) {
      return {
        ok: true,
        alreadyUnlocked: true,
        user: {
          _id: String(userDoc._id),
          username: userDoc.username,
          passwordHash: userDoc.passwordHash,
          coins: userDoc.coins ?? 0,
          isGuest: Boolean(userDoc.isGuest),
          unlockedBalls: [...userDoc.unlockedBalls],
        },
      };
    }
    if ((userDoc.coins ?? 0) < normalizedCost) {
      return { ok: false, error: 'Insufficient coins.' };
    }
    userDoc.coins = (userDoc.coins ?? 0) - normalizedCost;
    userDoc.unlockedBalls.push(cleanCharId);
    const saved = await userDoc.save();
    return {
      ok: true,
      user: {
        _id: String(saved._id),
        username: saved.username,
        passwordHash: saved.passwordHash,
        coins: saved.coins ?? 0,
        isGuest: Boolean(saved.isGuest),
        unlockedBalls: [...saved.unlockedBalls],
      },
    };
  }

  const existing = fallbackUsersById.get(userId);
  if (!existing) {
    return { ok: false, error: 'User not found.' };
  }
  if (existing.unlockedBalls.includes(cleanCharId)) {
    return { ok: true, alreadyUnlocked: true, user: { ...existing } };
  }
  if (existing.coins < normalizedCost) {
    return { ok: false, error: 'Insufficient coins.' };
  }
  const updated: StoredUserRecord = {
    ...existing,
    coins: existing.coins - normalizedCost,
    unlockedBalls: [...existing.unlockedBalls, cleanCharId],
  };
  fallbackUsersById.set(userId, updated);
  saveFallbackStore();
  return { ok: true, user: updated };
}

function signUserJwt(user: { _id: string; username: string; isGuest?: boolean }): string {
  return jwt.sign(
    {
      _id: user._id,
      id: user._id,
      username: user.username,
      isGuest: Boolean(user.isGuest),
    },
    JWT_SECRET,
    { expiresIn: '30d' }
  );
}

function extractUserFromRequest(req: Request): { _id: string; username: string } | null {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7).trim();
  if (!token) return null;
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as { _id?: string; id?: string; username?: string };
    const id = decoded._id || decoded.id;
    if (!id || !decoded.username) return null;
    return { _id: String(id), username: String(decoded.username) };
  } catch {
    return null;
  }
}

function serializePublicUser(user: StoredUserRecord) {
  return {
    _id: user._id,
    username: user.username,
    coins: user.coins,
    isGuest: user.isGuest,
    unlockedBalls: user.unlockedBalls,
  };
}

// Canvas & Arena bounds used for authoritative state sanity clamping
const CANVAS_W = 1280;
const CANVAS_H = 720;
const ARENA_SIZE = 620;
const WALL_THICKNESS = 20;
const ARENA_INNER_LEFT = (CANVAS_W - ARENA_SIZE) / 2 + WALL_THICKNESS;
const ARENA_INNER_RIGHT = (CANVAS_W + ARENA_SIZE) / 2 - WALL_THICKNESS;
const ARENA_INNER_TOP = (CANVAS_H - ARENA_SIZE) / 2 + WALL_THICKNESS;
const ARENA_INNER_BOTTOM = (CANVAS_H + ARENA_SIZE) / 2 - WALL_THICKNESS;

const CHARACTER_UNLOCK_COST = 100;
const DRAFT_REROLL_COST = 25;

interface AuthenticatedSocket extends Socket {
  userId?: string;
  username?: string;
}

interface PlayerStatePayload {
  x: number;
  y: number;
  vx: number;
  vy: number;
  health: number;
  hitbox: number;
  parryActive?: boolean;
  dodgeActive?: boolean;
  isDead?: boolean;
  abilityProgress?: number;
  abilityRemaining?: number;
  abilityActive?: boolean;
  abilityStatusText?: string;
  seq?: number;
  timestamp?: number;
}

interface RoomPlayer {
  socket: AuthenticatedSocket;
  userId?: string;
  role: 'Player 1' | 'Player 2';
  side: 'left' | 'right';
  name: string;
  ballType: string;
  launchLocked: boolean;
  launchAngle: number;
  state: PlayerStatePayload | null;
  readyForRematch: boolean;
}

interface MatchRoom {
  roomId: string;
  player1: RoomPlayer;
  player2: RoomPlayer;
  arena: string;
  startingHealth: number;
  roundNumber: number;
  roundStarted: boolean;
  roundRewardsProcessed: boolean;
  roundLossProcessed: boolean;
  createdAt: number;
  hearts: {
    p1: number;
    p2: number;
  };
  drafts: {
    p1: string | null;
    p2: string | null;
  };
}

interface SocketMetadata {
  name: string;
  ballType: string;
  arena: string;
  startingHealth: number;
}

const app = express();
app.use(express.json());

// ============================================================================
// AUTH & GUEST API ROUTES (/api/auth/register, /api/auth/login, /api/auth/guest)
// ============================================================================

// POST /api/auth/register: Hash password with bcrypt, create User (or upgrade linked Guest), return JWT
app.post('/api/auth/register', async (req: Request, res: Response) => {
  try {
    const rawUsername = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
    const rawPassword = typeof req.body?.password === 'string' ? req.body.password : '';

    if (!rawUsername || rawUsername.length < 2 || rawUsername.length > 20) {
      res.status(400).json({ error: 'Username must be between 2 and 20 characters.' });
      return;
    }
    if (!rawPassword || rawPassword.length < 4) {
      res.status(400).json({ error: 'Password must be at least 4 characters.' });
      return;
    }

    const existingUser = await findUserByUsername(rawUsername);
    const currentAuth = extractUserFromRequest(req);

    // If username belongs to someone other than the currently authenticated guest
    if (existingUser && (!currentAuth || existingUser._id !== currentAuth._id)) {
      res.status(409).json({ error: 'Username is already taken.' });
      return;
    }

    const passwordHash = await bcrypt.hash(rawPassword, BCRYPT_SALT_ROUNDS);

    // Seamless Guest -> Full Account upgrade if a guest JWT is provided
    if (currentAuth) {
      const currentRecord = await findUserById(currentAuth._id);
      if (currentRecord && currentRecord.isGuest) {
        const upgraded = await updateUserRecord(currentRecord._id, {
          username: rawUsername,
          passwordHash,
          isGuest: false,
        });
        if (upgraded) {
          const token = signUserJwt(upgraded);
          res.status(200).json({
            token,
            user: serializePublicUser(upgraded),
          });
          return;
        }
      }
    }

    const newUser = await createUserRecord({
      username: rawUsername,
      passwordHash,
      coins: 0,
      isGuest: false,
      unlockedBalls: [],
    });

    const token = signUserJwt(newUser);
    res.status(201).json({
      token,
      user: serializePublicUser(newUser),
    });
  } catch (err: any) {
    console.error('[Auth] /api/auth/register error:', err);
    if (err?.code === 11000) {
      res.status(409).json({ error: 'Username is already taken.' });
      return;
    }
    res.status(500).json({ error: 'Failed to register user.' });
  }
});

// POST /api/auth/login: Authenticate username & password using bcrypt, return JWT
app.post('/api/auth/login', async (req: Request, res: Response) => {
  try {
    const rawUsername = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
    const rawPassword = typeof req.body?.password === 'string' ? req.body.password : '';

    if (!rawUsername || !rawPassword) {
      res.status(400).json({ error: 'Username and password are required.' });
      return;
    }

    const user = await findUserByUsername(rawUsername);
    if (!user || !user.passwordHash) {
      res.status(401).json({ error: 'Invalid username or password.' });
      return;
    }

    const isPasswordValid = await bcrypt.compare(rawPassword, user.passwordHash);
    if (!isPasswordValid) {
      res.status(401).json({ error: 'Invalid username or password.' });
      return;
    }

    const token = signUserJwt(user);
    res.status(200).json({
      token,
      user: serializePublicUser(user),
    });
  } catch (err) {
    console.error('[Auth] /api/auth/login error:', err);
    res.status(500).json({ error: 'Failed to log in.' });
  }
});

// POST (and GET) /api/auth/guest: Generate random 'Guest_XXXX' username, create DB entry with isGuest: true, return JWT
const handleGuestAuth = async (_req: Request, res: Response) => {
  try {
    let guestUsername = '';
    for (let attempt = 0; attempt < 12; attempt++) {
      const randomDigits = Math.floor(1000 + Math.random() * 9000);
      const candidate = `Guest_${randomDigits}`;
      const existing = await findUserByUsername(candidate);
      if (!existing) {
        guestUsername = candidate;
        break;
      }
    }
    if (!guestUsername) {
      guestUsername = `Guest_${Date.now().toString().slice(-4)}`;
    }

    const guestUser = await createUserRecord({
      username: guestUsername,
      coins: 0,
      isGuest: true,
      unlockedBalls: [],
    });

    const token = signUserJwt(guestUser);
    res.status(201).json({
      token,
      user: serializePublicUser(guestUser),
    });
  } catch (err) {
    console.error('[Auth] /api/auth/guest error:', err);
    res.status(500).json({ error: 'Failed to create guest session.' });
  }
};

app.post('/api/auth/guest', handleGuestAuth);
app.get('/api/auth/guest', handleGuestAuth);

// POST /api/auth/link: Upgrade an existing Guest account into a permanent registered account while preserving coins & unlockedBalls
app.post('/api/auth/link', async (req: Request, res: Response) => {
  try {
    const authUser = extractUserFromRequest(req);
    if (!authUser) {
      res.status(401).json({ error: 'Authentication required to link account.' });
      return;
    }

    const rawUsername = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
    const rawPassword = typeof req.body?.password === 'string' ? req.body.password : '';

    if (!rawUsername || rawUsername.length < 2 || rawUsername.length > 20) {
      res.status(400).json({ error: 'Username must be between 2 and 20 characters.' });
      return;
    }
    if (!rawPassword || rawPassword.length < 4) {
      res.status(400).json({ error: 'Password must be at least 4 characters.' });
      return;
    }

    const existingWithUsername = await findUserByUsername(rawUsername);
    if (existingWithUsername && existingWithUsername._id !== authUser._id) {
      res.status(409).json({ error: 'Username is already taken.' });
      return;
    }

    const passwordHash = await bcrypt.hash(rawPassword, BCRYPT_SALT_ROUNDS);
    const updated = await updateUserRecord(authUser._id, {
      username: rawUsername,
      passwordHash,
      isGuest: false,
    });

    if (!updated) {
      res.status(404).json({ error: 'Guest user not found.' });
      return;
    }

    const token = signUserJwt(updated);
    res.status(200).json({
      token,
      user: serializePublicUser(updated),
    });
  } catch (err) {
    console.error('[Auth] /api/auth/link error:', err);
    res.status(500).json({ error: 'Failed to link guest account.' });
  }
});

// GET /api/auth/me: Fetch current user profile from JWT
app.get('/api/auth/me', async (req: Request, res: Response) => {
  try {
    const authUser = extractUserFromRequest(req);
    if (!authUser) {
      res.status(401).json({ error: 'Invalid or missing token.' });
      return;
    }
    const user = await findUserById(authUser._id);
    if (!user) {
      res.status(404).json({ error: 'User not found.' });
      return;
    }
    res.status(200).json({
      user: serializePublicUser(user),
    });
  } catch (err) {
    console.error('[Auth] /api/auth/me error:', err);
    res.status(500).json({ error: 'Failed to fetch user profile.' });
  }
});

// POST /api/auth/progress: Persist username updates (server handles coin math and purchases)
app.post('/api/auth/progress', async (req: Request, res: Response) => {
  try {
    const authUser = extractUserFromRequest(req);
    if (!authUser) {
      res.status(401).json({ error: 'Authentication required.' });
      return;
    }
    const current = await findUserById(authUser._id);
    if (!current) {
      res.status(404).json({ error: 'User not found.' });
      return;
    }

    const updates: Partial<Omit<StoredUserRecord, '_id'>> = {};
    if (typeof req.body?.username === 'string' && req.body.username.trim()) {
      const candidate = req.body.username.trim().slice(0, 20);
      const conflict = await findUserByUsername(candidate);
      if (!conflict || conflict._id === current._id) {
        updates.username = candidate;
      }
    }

    const updated =
      Object.keys(updates).length > 0
        ? await updateUserRecord(current._id, updates)
        : current;
    if (!updated) {
      res.status(404).json({ error: 'User not found.' });
      return;
    }

    const token = signUserJwt(updated);
    res.status(200).json({
      token,
      user: serializePublicUser(updated),
    });
  } catch (err) {
    console.error('[Auth] /api/auth/progress error:', err);
    res.status(500).json({ error: 'Failed to save progress.' });
  }
});

const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
  transports: ['websocket', 'polling'],
});

const waitingQueue: AuthenticatedSocket[] = [];
const rooms = new Map<string, MatchRoom>() as Map<string, MatchRoom> & Record<string, MatchRoom>;
const customRooms = new Map<string, { password?: string; players: Set<string> }>();
const socketToRoom = new Map<string, string>();
const socketMeta = new Map<string, SocketMetadata>();
const userSockets = new Map<string, Set<AuthenticatedSocket>>();

function registerUserSocket(userId: string, socket: AuthenticatedSocket): void {
  if (!userId) return;
  let set = userSockets.get(userId);
  if (!set) {
    set = new Set();
    userSockets.set(userId, set);
  }
  set.add(socket);
}

function unregisterUserSocket(userId: string | undefined, socket: AuthenticatedSocket): void {
  if (!userId) return;
  const set = userSockets.get(userId);
  if (!set) return;
  set.delete(socket);
  if (set.size === 0) {
    userSockets.delete(userId);
  }
}

function emitWalletUpdatedToUser(
  userId: string | undefined,
  fallbackSocket: AuthenticatedSocket | undefined,
  payload: {
    coins: number;
    unlockedBalls: string[];
    delta?: number;
    reason?: string;
    purchasedCharacterId?: string;
  }
): void {
  const emittedSocketIds = new Set<string>();
  const numericBalance = Number(payload.coins) || 0;
  if (userId) {
    const activeSet = userSockets.get(userId);
    if (activeSet) {
      for (const s of activeSet) {
        if (s.connected) {
          s.emit('wallet_updated', numericBalance);
          if (Array.isArray(payload.unlockedBalls)) {
            s.emit('unlocked_balls_updated', payload.unlockedBalls);
          }
          emittedSocketIds.add(s.id);
        }
      }
    }
  }
  if (fallbackSocket && fallbackSocket.connected && !emittedSocketIds.has(fallbackSocket.id)) {
    fallbackSocket.emit('wallet_updated', numericBalance);
    if (Array.isArray(payload.unlockedBalls)) {
      fallbackSocket.emit('unlocked_balls_updated', payload.unlockedBalls);
    }
  }
}

// ============================================================================
// SOCKET JWT MIDDLEWARE (io.use)
// Intercepts every Socket.io connection, verifies incoming JWT, attaches userId
// to socket, and disconnects invalid tokens.
// ============================================================================
io.use((socket: AuthenticatedSocket, next) => {
  const authHeader = socket.handshake.headers?.authorization;
  const rawToken =
    (typeof socket.handshake.auth?.token === 'string' && socket.handshake.auth.token) ||
    (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
      ? authHeader.slice(7)
      : '') ||
    (typeof socket.handshake.query?.token === 'string' && socket.handshake.query.token) ||
    '';

  const token = rawToken.trim();
  if (!token) {
    socket.disconnect(true);
    return next(new Error('Authentication error: Missing JWT token'));
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as {
      _id?: string;
      id?: string;
      username?: string;
    };
    const verifiedUserId = decoded._id || decoded.id;
    if (!verifiedUserId) {
      socket.disconnect(true);
      return next(new Error('Authentication error: Invalid JWT payload'));
    }

    socket.userId = String(verifiedUserId);
    if (decoded.username) {
      socket.username = String(decoded.username);
    }
    return next();
  } catch {
    socket.disconnect(true);
    return next(new Error('Authentication error: Invalid or expired JWT token'));
  }
});

// ============================================================================
// SERVER-SIDE MATCH REWARDS (+50 Coins for Winner, +10 Coins for Loser)
// ============================================================================
async function processServerMatchRewards(
  room: MatchRoom,
  winnerRole: 'Player 1' | 'Player 2',
  reason: 'ko' | 'forfeit'
): Promise<void> {
  if (room.roundRewardsProcessed) return;
  room.roundRewardsProcessed = true;

  const winnerPlayer = winnerRole === 'Player 1' ? room.player1 : room.player2;
  const loserPlayer = winnerRole === 'Player 1' ? room.player2 : room.player1;

  const winnerUserId = winnerPlayer.userId || winnerPlayer.socket.userId;
  const loserUserId = loserPlayer.userId || loserPlayer.socket.userId;

  try {
    if (winnerUserId) {
      const updatedWinner = await incrementUserCoins(winnerUserId, 50);
      if (updatedWinner) {
        emitWalletUpdatedToUser(winnerUserId, winnerPlayer.socket, {
          coins: updatedWinner.coins,
          unlockedBalls: updatedWinner.unlockedBalls,
          delta: 50,
          reason,
        });
      }
    }

    if (loserUserId) {
      const updatedLoser = await incrementUserCoins(loserUserId, 10);
      if (updatedLoser) {
        emitWalletUpdatedToUser(loserUserId, loserPlayer.socket, {
          coins: updatedLoser.coins,
          unlockedBalls: updatedLoser.unlockedBalls,
          delta: 10,
          reason,
        });
      }
    }
  } catch (err) {
    console.error('[Match Rewards] Failed to update coins in database:', err);
  }
}

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

function generateUniqueRoomId(): string {
  let roomId = '';
  do {
    const code = Math.floor(1000 + Math.random() * 9000);
    roomId = `match_${code}`;
  } while (rooms.has(roomId) || customRooms.has(roomId));
  return roomId;
}

function removeFromQueue(socketId: string): void {
  for (let i = waitingQueue.length - 1; i >= 0; i--) {
    if (waitingQueue[i].id === socketId || !waitingQueue[i].connected) {
      waitingQueue.splice(i, 1);
    }
  }
}

function createAndRegisterMatchRoom(
  roomId: string,
  s1: AuthenticatedSocket,
  s2: AuthenticatedSocket
): MatchRoom {
  const m1 = socketMeta.get(s1.id) || {
    name: s1.username || 'Player 1',
    ballType: 'quadblade',
    arena: 'Default',
    startingHealth: 100,
  };
  const m2 = socketMeta.get(s2.id) || {
    name: s2.username || 'Player 2',
    ballType: 'blackhole',
    arena: 'Default',
    startingHealth: 100,
  };

  const arena = m1.arena || 'Default';
  const startingHealth = clamp(Number(m1.startingHealth) || 100, 50, 200);

  const room: MatchRoom = {
    roomId,
    player1: {
      socket: s1,
      userId: s1.userId,
      role: 'Player 1',
      side: 'left',
      name: m1.name || 'Player 1',
      ballType: m1.ballType || 'quadblade',
      launchLocked: false,
      launchAngle: 0,
      state: null,
      readyForRematch: false,
    },
    player2: {
      socket: s2,
      userId: s2.userId,
      role: 'Player 2',
      side: 'right',
      name: m2.name || 'Player 2',
      ballType: m2.ballType || 'blackhole',
      launchLocked: false,
      launchAngle: Math.PI,
      state: null,
      readyForRematch: false,
    },
    arena,
    startingHealth,
    roundNumber: 1,
    roundStarted: false,
    roundRewardsProcessed: false,
    roundLossProcessed: false,
    createdAt: Date.now(),
    hearts: { p1: 3, p2: 3 },
    drafts: { p1: null, p2: null },
  };

  rooms.set(roomId, room);
  rooms[roomId] = room;
  rooms[roomId].hearts = { p1: 3, p2: 3 };
  rooms[roomId].drafts = { p1: null, p2: null };
  socketToRoom.set(s1.id, roomId);
  socketToRoom.set(s2.id, roomId);

  s1.join(roomId);
  s2.join(roomId);

  return room;
}

function tryPairPlayers(): void {
  // Purge any disconnected sockets first
  for (let i = waitingQueue.length - 1; i >= 0; i--) {
    if (!waitingQueue[i].connected) {
      waitingQueue.splice(i, 1);
    }
  }

  while (waitingQueue.length >= 2) {
    const s1 = waitingQueue.shift();
    const s2 = waitingQueue.shift();
    if (!s1 || !s2 || !s1.connected || !s2.connected) {
      if (s1 && s1.connected) waitingQueue.unshift(s1);
      if (s2 && s2.connected) waitingQueue.unshift(s2);
      break;
    }

    const roomId = generateUniqueRoomId();
    const room = createAndRegisterMatchRoom(roomId, s1, s2);
    rooms[roomId].hearts = { p1: 3, p2: 3 };
    rooms[roomId].drafts = { p1: null, p2: null };

    const sharedInfo = {
      room: roomId,
      roomId,
      arena: room.arena,
      startingHealth: room.startingHealth,
      hearts: { ...room.hearts },
      p1Username: room.player1.name,
      p2Username: room.player2.name,
      p1Info: {
        name: room.player1.name,
        username: room.player1.name,
        ballType: room.player1.ballType,
      },
      p2Info: {
        name: room.player2.name,
        username: room.player2.name,
        ballType: room.player2.ballType,
      },
    };

    s1.emit('match_found', {
      ...sharedInfo,
      role: 'Player 1',
      playerRole: 'p1',
      side: 'left',
      playerNumber: 1,
    });

    s2.emit('match_found', {
      ...sharedInfo,
      role: 'Player 2',
      playerRole: 'p2',
      side: 'right',
      playerNumber: 2,
    });

    console.log(
      `[Matchmaking] Paired ${s1.id} (${room.player1.name}) & ${s2.id} (${room.player2.name}) in ${roomId}`
    );
  }
}

io.on('connection', (socket: AuthenticatedSocket) => {
  const auth = (socket.handshake.auth || {}) as Partial<SocketMetadata> & {
    username?: string;
    customLobby?: boolean;
    walletOnly?: boolean;
  };
  const rawAuthName =
    typeof auth.username === 'string' && auth.username.trim()
      ? auth.username.trim()
      : typeof auth.name === 'string' && auth.name.trim()
      ? auth.name.trim()
      : socket.username || 'Fighter';

  if (socket.userId) {
    registerUserSocket(socket.userId, socket);
    void findUserById(socket.userId).then((record) => {
      if (record && socket.connected) {
        socket.emit('wallet_updated', Number(record.coins) || 0);
        if (Array.isArray(record.unlockedBalls)) {
          socket.emit('unlocked_balls_updated', record.unlockedBalls);
        }
      }
    });
  }

  socketMeta.set(socket.id, {
    name: rawAuthName.slice(0, 12),
    ballType: typeof auth.ballType === 'string' && auth.ballType.trim() ? auth.ballType.trim() : 'quadblade',
    arena: typeof auth.arena === 'string' && auth.arena.trim() ? auth.arena.trim() : 'Default',
    startingHealth: clamp(Number(auth.startingHealth) || 100, 50, 200),
  });

  console.log(`[Socket] Connected: ${socket.id} (userId=${socket.userId || 'unknown'})`);

  // Put newly connected user in the random 'waiting' queue unless connecting for customLobby or walletOnly
  if (!auth.customLobby && !auth.walletOnly) {
    if (!socketToRoom.has(socket.id) && !waitingQueue.some((s) => s.id === socket.id)) {
      waitingQueue.push(socket);
    }

    if (waitingQueue.length < 2) {
      socket.emit('waiting_for_opponent', {
        status: 'waiting',
        queuePosition: waitingQueue.findIndex((s) => s.id === socket.id) + 1,
      });
    } else {
      tryPairPlayers();
    }
  }

  // Secure Character Purchase Listener:
  // Checks DB for sufficient coins, subtracts cost, pushes characterId to unlockedBalls, saves DB, and emits wallet_updated
  socket.on(
    'purchase_character',
    async (
      payload: { characterId?: string; ballId?: string; cost?: number } | string,
      ack?: (res: { ok: boolean; coins?: number; unlockedBalls?: string[]; error?: string }) => void
    ) => {
      const characterId =
        typeof payload === 'string'
          ? payload
          : typeof payload?.characterId === 'string'
          ? payload.characterId
          : typeof payload?.ballId === 'string'
          ? payload.ballId
          : '';
      const rawCost =
        typeof payload === 'object' && payload !== null && typeof payload.cost === 'number'
          ? payload.cost
          : CHARACTER_UNLOCK_COST;
      const cost = clamp(Math.floor(rawCost), 25, 5000);

      const result = await purchaseCharacterInDb(socket.userId, characterId, cost);
      if (!result.ok || !result.user) {
        socket.emit('purchase_error', {
          characterId,
          error: result.error || 'Insufficient coins to purchase character.',
        });
        if (typeof ack === 'function') {
          ack({ ok: false, error: result.error || 'Insufficient coins.' });
        }
        return;
      }

      emitWalletUpdatedToUser(socket.userId, socket, {
        coins: result.user.coins,
        unlockedBalls: result.user.unlockedBalls,
        delta: result.alreadyUnlocked ? 0 : -cost,
        reason: 'purchase_character',
        purchasedCharacterId: characterId,
      });

      if (typeof ack === 'function') {
        ack({
          ok: true,
          coins: result.user.coins,
          unlockedBalls: result.user.unlockedBalls,
        });
      }
    }
  );

  // Server-authoritative Draft Re-roll (25 Coins)
  socket.on(
    'reroll_draft',
    async (
      _payload?: unknown,
      ack?: (res: { ok: boolean; coins?: number; unlockedBalls?: string[]; error?: string }) => void
    ) => {
      if (!socket.userId) {
        if (typeof ack === 'function') ack({ ok: false, error: 'Unauthorized' });
        return;
      }
      const user = await findUserById(socket.userId);
      if (!user || user.coins < DRAFT_REROLL_COST) {
        socket.emit('purchase_error', {
          error: 'Not enough coins to re-roll (25 Coins required).',
        });
        if (typeof ack === 'function') {
          ack({ ok: false, error: 'Insufficient coins' });
        }
        return;
      }

      const updated = await incrementUserCoins(socket.userId, -DRAFT_REROLL_COST);
      if (!updated) {
        if (typeof ack === 'function') ack({ ok: false, error: 'Update failed' });
        return;
      }

      emitWalletUpdatedToUser(socket.userId, socket, {
        coins: updated.coins,
        unlockedBalls: updated.unlockedBalls,
        delta: -DRAFT_REROLL_COST,
        reason: 'reroll_draft',
      });

      if (typeof ack === 'function') {
        ack({
          ok: true,
          coins: updated.coins,
          unlockedBalls: updated.unlockedBalls,
        });
      }
    }
  );

  // Create Custom Lobby Event: private / password-protected custom room creation
  socket.on(
    'create_custom_lobby',
    ({
      roomId,
      password,
      name,
      username,
      ballType,
      arena,
      startingHealth,
    }: {
      roomId?: string;
      password?: string;
      name?: string;
      username?: string;
      ballType?: string;
      arena?: string;
      startingHealth?: number;
    } = {}) => {
      const normalizedRoomId = typeof roomId === 'string' ? roomId.trim() : '';
      if (!normalizedRoomId || customRooms.has(normalizedRoomId) || rooms.has(normalizedRoomId)) {
        socket.emit('lobby_error', 'Room name taken');
        return;
      }

      // Update socket metadata if provided with the lobby creation payload
      const existing = socketMeta.get(socket.id) || {
        name: 'Player 1',
        ballType: 'quadblade',
        arena: 'Default',
        startingHealth: 100,
      };
      const resolvedName =
        typeof username === 'string' && username.trim()
          ? username.trim().slice(0, 12)
          : typeof name === 'string' && name.trim()
          ? name.trim().slice(0, 12)
          : existing.name;
      socketMeta.set(socket.id, {
        name: resolvedName,
        ballType: typeof ballType === 'string' && ballType.trim() ? ballType.trim() : existing.ballType,
        arena: typeof arena === 'string' && arena.trim() ? arena.trim() : existing.arena,
        startingHealth: clamp(Number(startingHealth) || existing.startingHealth, 50, 200),
      });

      // Remove from random matchmaking queue if present
      removeFromQueue(socket.id);

      const players = new Set<string>([socket.id]);
      customRooms.set(normalizedRoomId, {
        password: typeof password === 'string' && password.length > 0 ? password : password,
        players,
      });

      socket.join(normalizedRoomId);
      socket.emit('lobby_created', { roomId: normalizedRoomId });
      console.log(`[Custom Lobby] Created room "${normalizedRoomId}" by ${socket.id}`);
    }
  );

  // Join Custom Lobby Event: validate room existence, password, and capacity, then pair as 'p1' and 'p2'
  socket.on(
    'join_custom_lobby',
    ({
      roomId,
      password,
      name,
      username,
      ballType,
    }: {
      roomId?: string;
      password?: string;
      name?: string;
      username?: string;
      ballType?: string;
    } = {}) => {
      const normalizedRoomId = typeof roomId === 'string' ? roomId.trim() : '';
      const customRoom = customRooms.get(normalizedRoomId);

      if (!customRoom) {
        socket.emit('lobby_error', 'Room not found');
        return;
      }

      const expectedPassword = customRoom.password ?? '';
      const providedPassword = password ?? '';
      if (expectedPassword !== providedPassword) {
        socket.emit('lobby_error', 'Incorrect password');
        return;
      }

      if (customRoom.players.size >= 2) {
        socket.emit('lobby_error', 'Room is full');
        return;
      }

      // Update joining player's metadata if provided
      const existing = socketMeta.get(socket.id) || {
        name: 'Player 2',
        ballType: 'blackhole',
        arena: 'Default',
        startingHealth: 100,
      };
      const resolvedJoinName =
        typeof username === 'string' && username.trim()
          ? username.trim().slice(0, 12)
          : typeof name === 'string' && name.trim()
          ? name.trim().slice(0, 12)
          : existing.name;
      socketMeta.set(socket.id, {
        ...existing,
        name: resolvedJoinName,
        ballType: typeof ballType === 'string' && ballType.trim() ? ballType.trim() : existing.ballType,
      });

      // Remove from random matchmaking queue if present
      removeFromQueue(socket.id);

      const existingPlayerIds = Array.from(customRoom.players);
      const p1SocketId = existingPlayerIds[0];
      const p1Socket = p1SocketId
        ? (io.sockets.sockets.get(p1SocketId) as AuthenticatedSocket | undefined)
        : undefined;

      customRoom.players.add(socket.id);
      socket.join(normalizedRoomId);

      if (p1Socket && p1Socket.connected) {
        removeFromQueue(p1Socket.id);
        const matchRoom = createAndRegisterMatchRoom(normalizedRoomId, p1Socket, socket);
        rooms[normalizedRoomId].hearts = { p1: 3, p2: 3 };
        rooms[normalizedRoomId].drafts = { p1: null, p2: null };

        const sharedInfo = {
          room: normalizedRoomId,
          roomId: normalizedRoomId,
          arena: matchRoom.arena,
          startingHealth: matchRoom.startingHealth,
          hearts: { ...matchRoom.hearts },
          p1Username: matchRoom.player1.name,
          p2Username: matchRoom.player2.name,
          p1Info: {
            name: matchRoom.player1.name,
            username: matchRoom.player1.name,
            ballType: matchRoom.player1.ballType,
          },
          p2Info: {
            name: matchRoom.player2.name,
            username: matchRoom.player2.name,
            ballType: matchRoom.player2.ballType,
          },
        };

        p1Socket.emit('match_found', {
          ...sharedInfo,
          role: 'p1',
          playerRole: 'p1',
          side: 'left',
          playerNumber: 1,
        });

        socket.emit('match_found', {
          ...sharedInfo,
          role: 'p2',
          playerRole: 'p2',
          side: 'right',
          playerNumber: 2,
        });

        console.log(
          `[Custom Lobby] Matched p1=${p1Socket.id} & p2=${socket.id} in custom room "${normalizedRoomId}"`
        );
      }
    }
  );

  // Synchronized Draft Phase: Listen for player's locked character selection
  socket.on(
    'lock_draft',
    ({
      roomId,
      playerSide,
      ballId,
      name,
      username,
      arena,
      startingHealth,
    }: {
      roomId?: string;
      playerSide?: string;
      ballId?: string;
      name?: string;
      username?: string;
      arena?: string;
      startingHealth?: number;
    } = {}) => {
      const targetRoomId =
        typeof roomId === 'string' && roomId.trim()
          ? roomId.trim()
          : socketToRoom.get(socket.id) || '';
      if (!targetRoomId) return;

      const room = rooms.get(targetRoomId) || rooms[targetRoomId];
      if (!room) return;

      if (!room.drafts) {
        room.drafts = { p1: null, p2: null };
      }

      const selectedBall = typeof ballId === 'string' && ballId.trim() ? ballId.trim() : null;
      if (!selectedBall) return;

      const normalizedSide = typeof playerSide === 'string' ? playerSide.trim().toLowerCase() : '';
      const isP1 =
        normalizedSide === 'p1' ||
        normalizedSide === 'left' ||
        normalizedSide === 'player 1' ||
        (normalizedSide !== 'p2' &&
          normalizedSide !== 'right' &&
          normalizedSide !== 'player 2' &&
          room.player1.socket.id === socket.id);

      const resolvedDraftName =
        typeof username === 'string' && username.trim()
          ? username.trim().slice(0, 12)
          : typeof name === 'string' && name.trim()
          ? name.trim().slice(0, 12)
          : '';

      if (isP1) {
        room.drafts.p1 = selectedBall;
        room.player1.ballType = selectedBall;
        if (resolvedDraftName) {
          room.player1.name = resolvedDraftName;
        }
        if (typeof arena === 'string' && arena.trim()) {
          room.arena = arena.trim();
        }
        if (Number.isFinite(Number(startingHealth))) {
          room.startingHealth = clamp(Number(startingHealth) || 100, 50, 200);
        }
      } else {
        room.drafts.p2 = selectedBall;
        room.player2.ballType = selectedBall;
        if (resolvedDraftName) {
          room.player2.name = resolvedDraftName;
        }
      }

      socket.to(targetRoomId).emit('opponent_draft_locked', {
        roomId: targetRoomId,
        playerSide: isP1 ? 'p1' : 'p2',
        ballId: selectedBall,
      });

      // Start Game Execution: Check if both p1 and p2 have non-null draft selections
      if (room.drafts.p1 !== null && room.drafts.p2 !== null) {
        const p1Character = room.drafts.p1;
        const p2Character = room.drafts.p2;

        room.player1.ballType = p1Character;
        room.player2.ballType = p2Character;
        room.player1.launchLocked = false;
        room.player2.launchLocked = false;
        room.roundStarted = false;
        room.roundLossProcessed = false;

        io.to(targetRoomId).emit('enter_launch_phase', {
          p1Character,
          p2Character,
          room: targetRoomId,
          roomId: targetRoomId,
          arena: room.arena,
          startingHealth: room.startingHealth,
          hearts: { ...room.hearts },
          roundNumber: room.roundNumber,
          p1Username: room.player1.name,
          p2Username: room.player2.name,
          p1Info: {
            name: room.player1.name,
            username: room.player1.name,
            ballType: p1Character,
          },
          p2Info: {
            name: room.player2.name,
            username: room.player2.name,
            ballType: p2Character,
          },
        });

        // Cleanup: Clear the draft state for the room once the match officially starts
        room.drafts = { p1: null, p2: null };
      }
    }
  );

  // ============================================================================
  // MULTI-ROUND 3-HEART SYSTEM: round_lost -> start_new_draft OR match_over
  // ============================================================================
  socket.on(
    'round_lost',
    async ({
      roomId,
      loserSide,
    }: {
      roomId?: string;
      loserSide?: 'p1' | 'p2' | string;
    } = {}) => {
      const targetRoomId =
        typeof roomId === 'string' && roomId.trim()
          ? roomId.trim()
          : socketToRoom.get(socket.id) || '';
      if (!targetRoomId) return;

      const room = rooms.get(targetRoomId) || rooms[targetRoomId];
      if (!room) return;

      if (!room.hearts) {
        room.hearts = { p1: 3, p2: 3 };
      }

      if (room.roundLossProcessed) return;
      room.roundLossProcessed = true;

      const normalizedSide =
        typeof loserSide === 'string' ? loserSide.trim().toLowerCase() : '';
      const resolvedLoserSide: 'p1' | 'p2' =
        normalizedSide === 'p1' ||
        normalizedSide === 'left' ||
        normalizedSide === 'player 1'
          ? 'p1'
          : normalizedSide === 'p2' ||
            normalizedSide === 'right' ||
            normalizedSide === 'player 2'
          ? 'p2'
          : room.player1.socket.id === socket.id
          ? 'p1'
          : 'p2';
      const resolvedWinnerSide: 'p1' | 'p2' =
        resolvedLoserSide === 'p1' ? 'p2' : 'p1';

      // Subtract 1 heart from loserSide
      room.hearts[resolvedLoserSide] = Math.max(
        0,
        (room.hearts[resolvedLoserSide] ?? 3) - 1
      );

      // The Loop Decision: check remaining hearts
      if (room.hearts[resolvedLoserSide] > 0) {
        // Reset room's draft state and wait for both players to lock in new balls again
        room.drafts = { p1: null, p2: null };
        room.player1.launchLocked = false;
        room.player2.launchLocked = false;
        room.player1.state = null;
        room.player2.state = null;
        room.roundStarted = false;
        room.roundNumber += 1;

        io.to(targetRoomId).emit('start_new_draft', {
          roomId: targetRoomId,
          room: targetRoomId,
          hearts: { ...room.hearts },
          loserSide: resolvedLoserSide,
          winnerSide: resolvedWinnerSide,
          roundNumber: room.roundNumber,
        });
      } else {
        const winnerRole: 'Player 1' | 'Player 2' =
          resolvedWinnerSide === 'p1' ? 'Player 1' : 'Player 2';

        io.to(targetRoomId).emit('match_over', {
          roomId: targetRoomId,
          room: targetRoomId,
          hearts: { ...room.hearts },
          loserSide: resolvedLoserSide,
          winnerSide: resolvedWinnerSide,
          winnerRole,
          winnerUsername:
            winnerRole === 'Player 1' ? room.player1.name : room.player2.name,
        });

        // Process database coin rewards (+50 to winner, +10 to loser) and emit wallet_updated
        await processServerMatchRewards(room, winnerRole, 'ko');
      }
    }
  );

  // Optional metadata update while waiting in queue
  socket.on('join_match', (payload: Partial<SocketMetadata>) => {
    const existing = socketMeta.get(socket.id) || {
      name: 'Fighter',
      ballType: 'quadblade',
      arena: 'Default',
      startingHealth: 100,
    };
    socketMeta.set(socket.id, {
      name: typeof payload?.name === 'string' && payload.name.trim() ? payload.name.trim().slice(0, 18) : existing.name,
      ballType: typeof payload?.ballType === 'string' && payload.ballType.trim() ? payload.ballType.trim() : existing.ballType,
      arena: typeof payload?.arena === 'string' && payload.arena.trim() ? payload.arena.trim() : existing.arena,
      startingHealth: clamp(Number(payload?.startingHealth) || existing.startingHealth, 50, 200),
    });

    if (!socketToRoom.has(socket.id) && !waitingQueue.some((s) => s.id === socket.id)) {
      waitingQueue.push(socket);
      tryPairPlayers();
    }
  });

  // Sync fighter selection when players proceed to the Draft Screen from a Custom Lobby
  socket.on('update_fighter', (payload: Partial<SocketMetadata>) => {
    const roomId = socketToRoom.get(socket.id);
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;

    const isP1 = room.player1.socket.id === socket.id;
    const targetPlayer = isP1
      ? room.player1
      : room.player2.socket.id === socket.id
      ? room.player2
      : null;
    if (!targetPlayer) return;

    if (typeof payload?.name === 'string' && payload.name.trim()) {
      targetPlayer.name = payload.name.trim().slice(0, 18);
    }
    if (typeof payload?.ballType === 'string' && payload.ballType.trim()) {
      targetPlayer.ballType = payload.ballType.trim();
    }
    if (isP1 && typeof payload?.arena === 'string' && payload.arena.trim()) {
      room.arena = payload.arena.trim();
    }
    if (isP1 && Number.isFinite(Number(payload?.startingHealth))) {
      room.startingHealth = clamp(Number(payload?.startingHealth) || 100, 50, 200);
    }

    io.to(roomId).emit('fighter_updated', {
      room: roomId,
      arena: room.arena,
      startingHealth: room.startingHealth,
      p1Info: {
        name: room.player1.name,
        ballType: room.player1.ballType,
      },
      p2Info: {
        name: room.player2.name,
        ballType: room.player2.ballType,
      },
    });
  });

  // Listen for launch_lock from both clients containing their chosen launchAngle
  socket.on('launch_lock', (payload: { angle?: number; launchAngle?: number } | number) => {
    const roomId = socketToRoom.get(socket.id);
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;

    const rawAngle =
      typeof payload === 'number'
        ? payload
        : typeof payload?.angle === 'number'
        ? payload.angle
        : typeof payload?.launchAngle === 'number'
        ? payload.launchAngle
        : 0;
    const launchAngle = Number.isFinite(rawAngle) ? rawAngle : 0;

    const currentPlayer =
      room.player1.socket.id === socket.id
        ? room.player1
        : room.player2.socket.id === socket.id
        ? room.player2
        : null;
    if (!currentPlayer) return;

    currentPlayer.launchAngle = launchAngle;
    currentPlayer.launchLocked = true;

    socket.to(roomId).emit('opponent_launch_locked', {
      role: currentPlayer.role,
      angle: launchAngle,
    });

    if (room.player1.launchLocked && room.player2.launchLocked && !room.roundStarted) {
      room.roundStarted = true;
      room.roundLossProcessed = false;
      io.to(roomId).emit('start_round', {
        room: roomId,
        roundNumber: room.roundNumber,
        hearts: { ...room.hearts },
        p1Angle: room.player1.launchAngle,
        p2Angle: room.player2.launchAngle,
        serverTime: Date.now(),
      });
    }
  });

  // Authoritative state receiver: validate & broadcast player_state to the opponent via opponent_state
  socket.on('player_state', (data: Partial<PlayerStatePayload> & { room?: string }) => {
    const roomId = socketToRoom.get(socket.id);
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;

    const currentPlayer =
      room.player1.socket.id === socket.id
        ? room.player1
        : room.player2.socket.id === socket.id
        ? room.player2
        : null;
    if (!currentPlayer) return;

    const hitbox = Number.isFinite(Number(data?.hitbox))
      ? clamp(Number(data?.hitbox), 16, 140)
      : 50;

    const sanitized: PlayerStatePayload = {
      x: Number.isFinite(Number(data?.x))
        ? clamp(Number(data?.x), ARENA_INNER_LEFT - 10, ARENA_INNER_RIGHT + 10)
        : currentPlayer.state?.x ?? (currentPlayer.side === 'left' ? 460 : 820),
      y: Number.isFinite(Number(data?.y))
        ? clamp(Number(data?.y), ARENA_INNER_TOP - 10, ARENA_INNER_BOTTOM + 10)
        : currentPlayer.state?.y ?? 360,
      vx: Number.isFinite(Number(data?.vx)) ? clamp(Number(data?.vx), -85, 85) : 0,
      vy: Number.isFinite(Number(data?.vy)) ? clamp(Number(data?.vy), -85, 85) : 0,
      health: Number.isFinite(Number(data?.health))
        ? clamp(Number(data?.health), 0, room.startingHealth * 2)
        : currentPlayer.state?.health ?? room.startingHealth,
      hitbox,
      parryActive: Boolean(data?.parryActive),
      dodgeActive: Boolean(data?.dodgeActive),
      isDead: Boolean(data?.isDead) || (Number(data?.health) <= 0),
      abilityProgress: Number.isFinite(Number(data?.abilityProgress))
        ? clamp(Number(data?.abilityProgress), 0, 1)
        : undefined,
      abilityRemaining: Number.isFinite(Number(data?.abilityRemaining))
        ? clamp(Number(data?.abilityRemaining), 0, 30)
        : undefined,
      abilityActive: typeof data?.abilityActive === 'boolean' ? data.abilityActive : undefined,
      abilityStatusText:
        typeof data?.abilityStatusText === 'string'
          ? data.abilityStatusText.slice(0, 12)
          : undefined,
      seq: typeof data?.seq === 'number' ? data.seq : undefined,
      timestamp: Date.now(),
    };

    currentPlayer.state = sanitized;
    socket.to(roomId).emit('opponent_state', sanitized);
  });

  // Explicit KO report fallback (e.g., for instant-execution finishers or offline/bot round completions)
  socket.on('report_match_result', async (payload: { winnerRole?: 'Player 1' | 'Player 2'; didWin?: boolean }) => {
    const roomId = socketToRoom.get(socket.id);
    if (roomId) {
      const room = rooms.get(roomId);
      if (room && !room.roundRewardsProcessed) {
        const resolvedWinnerRole: 'Player 1' | 'Player 2' =
          payload?.winnerRole === 'Player 1' || payload?.winnerRole === 'Player 2'
            ? payload.winnerRole
            : room.player1.socket.id === socket.id
            ? payload?.didWin === false
              ? 'Player 2'
              : 'Player 1'
            : payload?.didWin === false
            ? 'Player 1'
            : 'Player 2';
        await processServerMatchRewards(room, resolvedWinnerRole, 'ko');
      }
      return;
    }

    // Single-player / Bot mode reward processed authoritatively on the server
    if (socket.userId && typeof payload?.didWin === 'boolean') {
      const delta = payload.didWin ? 50 : 10;
      const updated = await incrementUserCoins(socket.userId, delta);
      if (updated) {
        emitWalletUpdatedToUser(socket.userId, socket, {
          coins: updated.coins,
          unlockedBalls: updated.unlockedBalls,
          delta,
          reason: 'ko',
        });
      }
    }
  });

  // Synchronized rematch support
  socket.on('request_rematch', () => {
    const roomId = socketToRoom.get(socket.id);
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;

    const currentPlayer =
      room.player1.socket.id === socket.id
        ? room.player1
        : room.player2.socket.id === socket.id
        ? room.player2
        : null;
    if (!currentPlayer) return;

    currentPlayer.readyForRematch = true;
    socket.to(roomId).emit('opponent_rematch_ready', { role: currentPlayer.role });

    if (room.player1.readyForRematch && room.player2.readyForRematch) {
      room.player1.readyForRematch = false;
      room.player2.readyForRematch = false;
      room.player1.launchLocked = false;
      room.player2.launchLocked = false;
      room.player1.state = null;
      room.player2.state = null;
      room.roundStarted = false;
      room.roundRewardsProcessed = false;
      room.roundNumber += 1;

      io.to(roomId).emit('rematch_started', {
        room: roomId,
        roundNumber: room.roundNumber,
      });
    }
  });

  // Relay safe chat, tactical pings & quick emotes within the same room
  socket.on('chat_message', (payload: { text?: string }) => {
    const roomId = socketToRoom.get(socket.id);
    if (!roomId) return;
    const text = typeof payload?.text === 'string' ? payload.text.trim().slice(0, 80) : '';
    if (!text) return;
    socket.to(roomId).emit('opponent_chat', { text });
  });

  socket.on('tactical_ping', (payload: { x?: number; y?: number; sector?: string; color?: string }) => {
    const roomId = socketToRoom.get(socket.id);
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;
    const sender =
      room.player1.socket.id === socket.id
        ? room.player1
        : room.player2.socket.id === socket.id
        ? room.player2
        : null;
    if (!sender) return;

    const x = Number.isFinite(Number(payload?.x))
      ? clamp(Number(payload?.x), ARENA_INNER_LEFT + 20, ARENA_INNER_RIGHT - 20)
      : CANVAS_W / 2;
    const y = Number.isFinite(Number(payload?.y))
      ? clamp(Number(payload?.y), ARENA_INNER_TOP + 20, ARENA_INNER_BOTTOM - 20)
      : CANVAS_H / 2;
    const sector = typeof payload?.sector === 'string' ? payload.sector.slice(0, 24) : 'ARENA';
    const color = typeof payload?.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(payload.color)
      ? payload.color
      : '#38bdf8';

    socket.to(roomId).emit('opponent_ping', {
      x,
      y,
      sector,
      color,
      senderName: sender.name,
      senderRole: sender.role,
    });
  });

  socket.on('player_emote', (payload: { emoteId?: string }) => {
    const roomId = socketToRoom.get(socket.id);
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;
    const sender =
      room.player1.socket.id === socket.id
        ? room.player1
        : room.player2.socket.id === socket.id
        ? room.player2
        : null;
    if (!sender) return;

    const emoteId = typeof payload?.emoteId === 'string' ? payload.emoteId.slice(0, 24) : 'gg';
    socket.to(roomId).emit('opponent_emote', {
      emoteId,
      senderName: sender.name,
      senderRole: sender.role,
    });
  });

  socket.on('ping_check', (clientTimestamp: number, ack?: (serverTime: number) => void) => {
    if (typeof ack === 'function') {
      ack(Date.now());
    } else {
      socket.emit('pong_check', clientTimestamp);
    }
  });

  socket.on('disconnect', () => {
    console.log(`[Socket] Disconnected: ${socket.id}`);
    removeFromQueue(socket.id);
    socketMeta.delete(socket.id);
    unregisterUserSocket(socket.userId, socket);

    // Cleanup customRooms if the disconnected socket was in any custom lobby
    for (const [customRoomId, customRoom] of customRooms.entries()) {
      if (customRoom.players.has(socket.id)) {
        customRoom.players.delete(socket.id);
        if (customRoom.players.size === 0) {
          customRooms.delete(customRoomId);
          console.log(`[Custom Lobby] Deleted empty custom room "${customRoomId}"`);
        }
      }
    }

    const roomId = socketToRoom.get(socket.id);
    if (roomId) {
      const room = rooms.get(roomId);
      socketToRoom.delete(socket.id);
      if (room) {
        // Server-Side Match Rewards on Disconnect Forfeit (+50 Winner, +10 Loser)
        if (!room.roundRewardsProcessed) {
          const winnerRole: 'Player 1' | 'Player 2' =
            room.player1.socket.id === socket.id ? 'Player 2' : 'Player 1';
          void processServerMatchRewards(room, winnerRole, 'forfeit');
        }

        socket.to(roomId).emit('opponent_disconnected', { room: roomId });
        const otherSocket =
          room.player1.socket.id === socket.id ? room.player2.socket : room.player1.socket;
        socketToRoom.delete(otherSocket.id);
        otherSocket.leave(roomId);
        rooms.delete(roomId);
        delete rooms[roomId];
      }
    }
  });
});

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    waitingQueue: waitingQueue.length,
    activeRooms: rooms.size,
    customRooms: customRooms.size,
  });
});

async function startServer() {
  await connectDatabase();

  if (!IS_PROD) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.join(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`[Ball VS Ball Server] Listening on http://0.0.0.0:${PORT} (${IS_PROD ? 'prod' : 'dev'})`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
