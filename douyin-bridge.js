'use strict';

const DEFAULT_BRIDGE_URL = 'ws://127.0.0.1:8765';

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return '';
}

function normalizeBridgeEvent(payload) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const type = firstString(source.type).toLowerCase() || 'comment';
  const text = firstString(
    source.text,
    source.commentText,
    source.comment,
    source.content,
    source.message,
    source.msg,
    source.rawText,
    type === 'comment' ? source.raw : ''
  );

  return {
    type,
    eventId: firstString(source.eventId, source.messageId, source.msgId),
    name: firstString(source.name, source.nickname, source.userName, source.user_name) || '直播观众',
    userId: firstString(source.userId, source.user_id, source.uid, source.openId, source.open_id),
    room: firstString(source.room, source.roomId, source.room_id),
    text,
    receivedAt: Date.now(),
    payload: source
  };
}

class DouyinBridgeClient {
  constructor({
    url = process.env.DOUYIN_BRIDGE_URL || DEFAULT_BRIDGE_URL,
    reconnectMs = 3000,
    onEvent = () => {},
    onComment = () => {},
    onStatus = () => {}
  } = {}) {
    this.url = url;
    this.reconnectMs = reconnectMs;
    this.onEvent = onEvent;
    this.onComment = onComment;
    this.onStatus = onStatus;
    this.socket = null;
    this.reconnectTimer = null;
    this.closed = false;
    this.connected = false;
    this.state = 'idle';
    this.room = '';
    this.lastMessageAt = 0;
    this.lastError = '';
  }

  snapshot() {
    return {
      url: this.url,
      state: this.state,
      connected: this.connected,
      room: this.room,
      lastMessageAt: this.lastMessageAt,
      lastError: this.lastError
    };
  }

  reportStatus(state, extra = {}) {
    this.state = state;
    this.connected = state === 'connected';
    if (extra.error) this.lastError = String(extra.error);
    this.onStatus({ ...this.snapshot(), ...extra });
  }

  connect() {
    this.closed = false;
    if (this.socket || this.reconnectTimer) return this.snapshot();

    const WebSocketCtor = globalThis.WebSocket;
    if (typeof WebSocketCtor !== 'function') {
      this.reportStatus('error', { error: '当前 Electron 运行时没有 WebSocket' });
      this.scheduleReconnect();
      return this.snapshot();
    }

    this.reportStatus('connecting');
    let socket;
    try {
      socket = new WebSocketCtor(this.url);
    } catch (error) {
      this.reportStatus('error', { error: error.message });
      this.scheduleReconnect();
      return this.snapshot();
    }
    this.socket = socket;

    socket.addEventListener('open', () => {
      if (socket !== this.socket) return;
      this.lastError = '';
      this.reportStatus('connected');
      this.sendRoom();
    });

    socket.addEventListener('message', async (event) => {
      if (socket !== this.socket) return;
      try {
        let data = event.data;
        if (typeof data !== 'string' && data && typeof data.text === 'function') data = await data.text();
        const parsed = typeof data === 'string' ? JSON.parse(data) : data;
        const normalized = normalizeBridgeEvent(parsed);
        this.lastMessageAt = normalized.receivedAt;
        if (normalized.room) this.room = normalized.room;
        this.onEvent(normalized);
        if (normalized.type === 'comment') this.onComment(normalized);
      } catch (error) {
        this.reportStatus('error', { error: `消息解析失败：${error.message}` });
      }
    });

    socket.addEventListener('error', (event) => {
      if (socket !== this.socket) return;
      const message = event?.message || 'WebSocket 连接错误';
      this.socket = null;
      this.reportStatus('error', { error: message });
      try { socket.close(); } catch {}
      this.scheduleReconnect();
    });

    socket.addEventListener('close', () => {
      if (socket !== this.socket) return;
      this.socket = null;
      this.reportStatus(this.closed ? 'closed' : 'disconnected');
      this.scheduleReconnect();
    });
    return this.snapshot();
  }

  scheduleReconnect() {
    if (this.closed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectMs);
  }

  sendRoom() {
    if (!this.room || !this.socket || this.socket.readyState !== 1) return;
    try {
      this.socket.send(JSON.stringify({ type: 'set-room', room: this.room }));
    } catch (error) {
      this.reportStatus('error', { error: `发送直播间失败：${error.message}` });
    }
  }

  setRoom(room) {
    this.room = firstString(room);
    this.sendRoom();
    return this.snapshot();
  }

  close() {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      try { socket.close(); } catch {}
    }
    this.reportStatus('closed');
  }
}

module.exports = { DEFAULT_BRIDGE_URL, DouyinBridgeClient, normalizeBridgeEvent };
