'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function normalizeRoom(room) {
  const raw = String(room || '').trim();
  if (/^\d{5,25}$/.test(raw)) return raw;
  const candidate = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(candidate);
    if (url.hostname !== 'live.douyin.com') return '';
    return url.pathname.match(/^\/(\d{5,25})(?:\/|$)/)?.[1] || '';
  } catch {
    return '';
  }
}

function unpackedPath(file) {
  const marker = `${path.sep}app.asar${path.sep}`;
  return file.includes(marker) ? file.replace(marker, `${path.sep}app.asar.unpacked${path.sep}`) : file;
}

class DouyinBridgeProcess {
  constructor({ dataDirectory, port = 8765, onOutput = () => {}, onStatus = () => {}, onQueuedAvatar = () => {} } = {}) {
    this.dataDirectory = dataDirectory;
    this.port = port;
    this.onOutput = onOutput;
    this.onStatus = onStatus;
    this.onQueuedAvatar = onQueuedAvatar;
    this.child = null;
    this.state = 'idle';
    this.lastError = '';
    this.ready = false;
    this.capture = null;
    this.readyWaiters = new Set();
  }

  get roomFile() {
    return path.join(this.dataDirectory, '.bridge-room');
  }

  get scriptPath() {
    return unpackedPath(path.join(__dirname, 'douyin-bridge-service.mjs'));
  }

  readRoom() {
    const fromEnv = normalizeRoom(process.env.DOUYIN_ROOM_ID);
    if (fromEnv) return fromEnv;
    try { return normalizeRoom(fs.readFileSync(this.roomFile, 'utf8')); } catch { return ''; }
  }

  writeRoom(room) {
    fs.mkdirSync(this.dataDirectory, { recursive: true });
    fs.writeFileSync(this.roomFile, `${room}\n`);
  }

  snapshot() {
    return {
      state: this.state,
      room: this.readRoom(),
      port: this.port,
      pid: this.child?.pid || 0,
      capture: this.capture,
      lastError: this.lastError
    };
  }

  start(room = this.readRoom()) {
    const normalizedRoom = normalizeRoom(room);
    if (!normalizedRoom) {
      this.state = 'waiting-room';
      this.lastError = '还没有设置抖音直播间号';
      this.onStatus(this.snapshot());
      return this.snapshot();
    }
    this.writeRoom(normalizedRoom);
    if (this.child && !this.child.killed) return this.snapshot();

    this.lastError = '';
    this.ready = false;
    this.capture = null;
    this.state = 'starting';
    this.onStatus(this.snapshot());
    const child = spawn(process.execPath, [this.scriptPath, normalizedRoom, String(this.port)], {
      cwd: this.dataDirectory,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        DOUYIN_BRIDGE_DATA_DIR: this.dataDirectory
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    });
    this.child = child;
    child.on('message', msg => {
      if (child===this.child && this.state!=='stopping' && msg?.type==='capture-status'
        && ['opening','waiting-chat','listening'].includes(msg.phase) && normalizeRoom(msg.room)) {
        this.capture={room:msg.room,phase:msg.phase};
        this.onStatus(this.snapshot());
      }
      if(child===this.child && this.ready && msg?.type==='queued-avatar-result') this.onQueuedAvatar(msg);
    });
    this.attachOutput(child.stdout, 'stdout');
    this.attachOutput(child.stderr, 'stderr');
    child.once('error', error => {
      this.lastError = error.message;
      this.state = 'error';
      this.rejectReadyWaiters(error);
      this.onStatus(this.snapshot());
    });
    child.once('exit', (code, signal) => {
      if(child!==this.child)return;
      this.capture=null;
      if (this.child === child) this.child = null;
      const wasReady = this.ready;
      this.ready = false;
      if (this.state === 'stopping') {
        this.state = 'stopped';
        this.rejectReadyWaiters(new Error('抖音评论桥已停止'));
        this.onStatus(this.snapshot());
      } else {
        this.state = code === 0 ? 'stopped' : 'error';
        if (code !== 0 && !this.lastError) this.lastError = `桥接进程退出：code=${code}, signal=${signal || ''}`;
        if (!wasReady && !this.lastError) this.lastError = '桥接进程已退出，尚未就绪';
        this.rejectReadyWaiters(new Error(this.lastError));
        this.onStatus(this.snapshot());
      }
    });
    return this.snapshot();
  }

  requestQueuedAvatar({room,eventId,id}) {
    if(!this.ready || !this.child?.connected || !eventId)return;
    try { this.child.send({type:'queued-avatar',room,eventId,id},()=>{}); } catch {}
  }

  waitUntilReady(timeoutMs = 15000) {
    if (this.ready) return Promise.resolve(this.snapshot());
    if (!this.child || ['error', 'stopped', 'idle'].includes(this.state)) {
      return Promise.reject(new Error(this.lastError || '抖音评论桥进程尚未启动'));
    }
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        this.readyWaiters.delete(waiter);
        reject(new Error(`等待本地评论桥就绪超时（${Math.round(timeoutMs / 1000)} 秒）`));
      }, timeoutMs);
      this.readyWaiters.add(waiter);
    });
  }

  markReady(line) {
    const match = String(line).match(/数据桥服务\s+ws:\/\/127\.0\.0\.1:(\d+)/);
    if (!match || this.ready || this.state === 'stopping') return;
    this.port = Number(match[1]) || this.port;
    this.ready = true;
    this.state = 'running';
    this.lastError = '';
    for (const waiter of this.readyWaiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(this.snapshot());
    }
    this.readyWaiters.clear();
    this.onStatus(this.snapshot());
  }

  rejectReadyWaiters(error) {
    for (const waiter of this.readyWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.readyWaiters.clear();
  }

  attachOutput(stream, channel) {
    if (!stream) return;
    let buffer = '';
    stream.on('data', chunk => {
      buffer += String(chunk);
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      lines.filter(Boolean).forEach(line => {
        if (channel === 'stderr') this.lastError = line;
        this.onOutput(line, channel);
        if (channel === 'stdout') this.markReady(line);
      });
    });
    stream.on('end', () => {
      if (buffer) {
        if (channel === 'stderr') this.lastError = buffer;
        this.onOutput(buffer, channel);
        if (channel === 'stdout') this.markReady(buffer);
      }
    });
  }

  stop() {
    const child = this.child;
    this.capture=null;
    if (!child) {
      this.ready = false;
      this.state = 'stopped';
      this.onStatus(this.snapshot());
      return this.snapshot();
    }
    this.state = 'stopping';
    this.ready = false;
    this.rejectReadyWaiters(new Error('抖音评论桥已停止'));
    this.onStatus(this.snapshot());
    try { child.kill('SIGTERM'); } catch {}
    return this.snapshot();
  }
}

// A remembered room is configuration only. Each app launch starts with no
// connection intent, even when a valid room has already been saved.
class DouyinBridgeSession {
  constructor(process, client) {
    this.process = process;
    this.client = client;
    this.active = false;
    this.generation = 0;
  }

  snapshot() {
    const process = this.process.snapshot();
    const connection = this.client.snapshot();
    return {
      ...connection,
      ...(this.active ? {} : {state:'closed', connected:false, lastError:''}),
      room: connection.room || process.room || '',
      process
    };
  }

  async connect(room) {
    const request = ++this.generation;
    this.active = true;
    this.process.start(room);
    this.client.setRoom(room);
    try { await this.process.waitUntilReady(); }
    catch(error) {
      if (request === this.generation) throw error;
      return this.snapshot();
    }
    if (request === this.generation && this.active) this.client.connect();
    return this.snapshot();
  }

  disconnect() {
    ++this.generation;
    this.active = false;
    this.client.close();
    this.process.stop();
    return this.snapshot();
  }
}

module.exports = { DouyinBridgeProcess, DouyinBridgeSession, normalizeRoom };
