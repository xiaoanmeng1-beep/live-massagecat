'use strict';

const { makeParser } = require('./live-parser');
const HOLD_MS = 7000;
const MAX_HISTORY = 1 + 4; // One featured completed quote and four earlier cards.
const BLOCKING = new Set(['AUTH_REQUIRED','NO_ACCOUNT','RATE_LIMITED','CAPTCHA_REQUIRED']);

function viewerQuoteKey(job) {
  if (!job?.room || (!job.userId && (!job.name || job.name==='直播观众'))) return null;
  const {modelId,registration,mileage,provinceId,cityId}=job.input||{};
  if ([modelId,registration,mileage,provinceId,cityId].some(v=>v==null || v==='')) return null;
  return JSON.stringify([String(job.room),job.userId?'id':'name',String(job.userId||job.name),
    String(modelId),String(registration),Number(mileage),String(provinceId),String(cityId)]);
}

function pauseUntilChanged(ms, signal) {
  return new Promise(resolve => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once:true });
    if (signal.aborted) finish();
  });
}

class QuoteBoard {
  constructor({ quote, change = () => {}, log = () => {}, pause = pauseUntilChanged, holdMs = HOLD_MS, now = Date.now }) {
    Object.assign(this,{quote,change,log,pause,holdMs,now});
    this.seen = new Set();
    this.pending = [];
    this.current = null;
    this.history = [];
    this.rev = 0;
    this.busy = false;
    this.blocked = null;
    this.lastCompletedAt = null;
    this.waitController = null;
  }

  snapshot() {
    return { rev:this.rev, pending:this.pending.slice(), current:this.current, blocked:this.blocked, history:this.history.slice() };
  }

  publish() {
    this.rev++;
    this.change(this.snapshot());
  }

  add(job) {
    return this.admit(job).ok;
  }

  admit(job) {
    if (!job) return {ok:false,code:'NO_JOB',reason:'没有报价任务'};
    const key = job.eventId || job.id;
    if (key != null) {
      if (this.seen.has(key)) return {ok:false,ignored:true,code:'DUPLICATE_EVENT',reason:'重复的直播消息，已跳过'};
      this.seen.add(key);
      if (this.seen.size > 4096) this.seen.delete(this.seen.values().next().value);
    }
    const request=viewerQuoteKey(job);
    if(request && [this.current,...this.pending,...this.history].some(other=>viewerQuoteKey(other)===request))
      return {ok:false,ignored:true,code:'REPEAT_VIEWER_QUOTE',reason:'同一观众的相同报价已在队列或最近报价中'};
    this.pending.push(job);
    this.publish();
    if (!this.busy && !this.blocked) void this.drain();
    return {ok:true};
  }

  resume() {
    if (this.busy || !this.blocked) return;
    this.blocked = null;
    this.publish();
    if (this.pending.length) void this.drain();
  }

  setHoldMs(ms) {
    if (!Number.isInteger(ms) || ms < 0 || ms > 3600000) throw Error('报价间隔无效');
    this.holdMs = ms;
    this.waitController?.abort();
  }

  async waitForNext() {
    while (this.lastCompletedAt !== null) {
      const remaining = this.lastCompletedAt + this.holdMs - this.now();
      if (remaining <= 0) return;
      const controller = new AbortController();
      this.waitController = controller;
      try { await this.pause(remaining, controller.signal); }
      finally { if (this.waitController === controller) this.waitController = null; }
      // Only a setting change recalculates the deadline. Injected test pauses may
      // complete without advancing a wall clock, just like a completed timer.
      if (!controller.signal.aborted) return;
    }
  }

  setQueuedAvatar({room,id,eventId,avatar}) {
    let url;
    try {url=new URL(avatar);}catch{return false;}
    if(url.protocol!=='https:' || !/(^|\.)(douyinpic\.com|douyinstatic\.com|byteimg\.com)$/.test(url.hostname) || url.username || url.password)return false;
    const job=[this.current,...this.pending,...this.history].find(j=>j && j.id===id && j.room===room && j.eventId===eventId);
    if(!job || job.avatar)return false;
    job.avatar=url.href;this.publish();return true;
  }

  async drain() {
    this.busy = true;
    try {
      while (this.pending.length) {
        await this.waitForNext();
        const job = this.pending.shift();
        this.current = job;
        this.publish();
        try {
          const result = await this.quote(job.input);
          if (BLOCKING.has(result?.code)) {
            this.blocked = result.code;
            this.current = null;
            this.pending.unshift(job);
            this.log(job.id, result.code);
            this.publish();
            break;
          }
          const price = result?.prices?.good;
          if (!result?.ok || result.historicalFallback || !Number.isFinite(price?.low)
            || !Number.isFinite(price?.high) || price.low <= 0 || price.high < price.low) {
            throw Error(result?.code || '无有效报价');
          }
          this.history.unshift({...job, car:result.providerModel?.name || job.car, low:price.low, high:price.high, photo:result.vehicle?.imageData || result.vehicle?.imageUrl || 'car-silhouette.svg'});
          if (this.history.length > MAX_HISTORY) this.history.length = MAX_HISTORY;
          this.current = null;
          this.publish();
        } catch (e) {
          this.log(job.id,e.message);
          this.current = null;
          this.publish();
        } finally {
          // Successful cache hits, failed responses, thrown errors and timeouts
          // all share the same completion-to-next-start interval.
          this.lastCompletedAt = this.now();
        }
      }
    } finally {
      this.busy = false;
    }
  }
}
function attemptLiveMatch(parse,board,event,onAdmitted) {
  let result;
  try { result=parse(event); }
  catch(error) { return {ok:false,code:'PARSE_ERROR',reason:'解析异常：'+error.message}; }
  if(!result.ok)return result;
  const admission=board.admit(result.job);
  if(!admission.ok)return admission;
  onAdmitted?.(event);
  return {ok:true};
}
module.exports = { makeParser, QuoteBoard, attemptLiveMatch };
