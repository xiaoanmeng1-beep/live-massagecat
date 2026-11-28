"""Private line-delimited IPC. One Metal context, one loaded checkpoint at a time."""
import sqlite3, miniaudio
import base64, gc, io, json, os, queue, sys, threading, time, wave
from pathlib import Path
root=Path(sys.argv[1]).resolve()
sys.path.insert(0,str(root))
os.environ.update(HF_HOME=str(root/'hf-cache'),HF_HUB_OFFLINE='1',TOKENIZERS_PARALLELISM='false',HF_HUB_DISABLE_TELEMETRY='1')
protocol=sys.stdout
sys.stdout=sys.stderr
def send(**msg):
    print(json.dumps(msg,separators=(',',':')),file=protocol,flush=True)
commands=queue.Queue()
cancelled=set(); outstanding=set(); lock=threading.Lock()
def read():
    for line in sys.stdin:
        msg=json.loads(line)
        with lock:
            if msg.get('cancel'):
                if msg['cancel'] in outstanding:cancelled.add(msg['cancel'])
            else:
                outstanding.add(msg['id']);commands.put(msg)
    os._exit(0)
threading.Thread(target=read,daemon=True).start()
import numpy as np
import mlx.core as mx
from mlx_audio.tts.utils import load_model
from mlx_audio.tts.models.qwen3_tts import qwen3_tts
from speech_cleanup import clean_speech,trim_quiet_tail
class Cancelled(Exception):pass
def check():
    if req['id'] in cancelled: raise Cancelled()
class Meter:
    def __init__(self,**kwargs): self.n=0; self.last=0
    def update(self,n):
        check(); self.n+=n
        if time.monotonic()-self.last>.22:
            send(id=req['id'],stage='generating',tokens=self.n);self.last=time.monotonic()
    def close(self):pass
qwen3_tts.tqdm=Meter
model=None; loaded=None; warmed=False
def reference(req,rate):
    uri=Path(req['refDb']).resolve().as_uri()+'?mode=ro'
    con=sqlite3.connect(uri,uri=True)
    try:row=con.execute('SELECT wav FROM voice_source WHERE slot=1 AND id=?',(req['refId'],)).fetchone()
    finally:con.close()
    if row is None:raise ValueError('参考录音已更换，请使用当前声音来源')
    decoded=miniaudio.decode(row[0],output_format=miniaudio.SampleFormat.FLOAT32,nchannels=1,sample_rate=rate)
    return mx.array(np.asarray(decoded.samples,dtype=np.float32))

def run(req):
    global model,loaded,warmed
    check()
    if loaded!=req['engine']:
        send(id=req['id'],stage='loading')
        model=None;loaded=None;warmed=False;gc.collect();mx.clear_cache()
        model=load_model(str(root/('model-base' if req['engine']=='base' else 'model')))
        loaded=req['engine']
    check()
    if req.get('warm') and warmed:return {}
    mx.random.seed(req.get('seed',42)); text='你好。' if req.get('warm') else req['text']
    send(id=req['id'],stage='preparing')
    limit=min(2048,max(60,int(12.5*(4+len(text)*.65))))
    opts=dict(text=text,max_tokens=limit)
    if loaded=='base':
        if model.speaker_encoder is None:raise ValueError('Base 音色编码器未就绪')
        cache=getattr(model,'_icl_cache',None)
        if cache and len(cache)>4:cache.clear()
        results=model.generate(**opts,ref_audio=reference(req,model.sample_rate),ref_text=req.get('refText') or None,lang_code='Chinese')
    else:results=model.generate_voice_design(**opts,instruct=req['style'],language='Chinese')
    chunks=[]
    for result in results:
        check();arr=np.asarray(result.audio);rate=result.sample_rate
        if len(arr)/rate >= (limit-1)/12.5:raise ValueError('这句异常拖长，已丢弃。请核对参考原话，或留空重试。')
        chunks.append(arr)
    check();warmed=True
    if req.get('warm'):return {}
    send(id=req['id'],stage='finishing');x=np.concatenate(chunks).reshape(-1)
    if not np.isfinite(x).all() or np.max(abs(x))<.0001:raise ValueError('声音异常或无声')
    if req.get('clean',True):x=clean_speech(x,rate)
    x=trim_quiet_tail(x,rate);check()
    buf=io.BytesIO()
    with wave.open(buf,'wb') as w:
        w.setparams((1,2,rate,0,'NONE',''));w.writeframes(np.rint(np.clip(x,-1,1)*32767).astype('<i2').tobytes())
    return dict(wav=base64.b64encode(buf.getvalue()).decode('ascii'))
while True:
    req=commands.get()
    try:reply=dict(done=True,**run(req))
    except Cancelled:reply=dict(cancelled=True)
    except Exception as e:reply=dict(error=str(e)[:350])
    with lock:
        outstanding.discard(req['id']);cancelled.discard(req['id'])
    send(id=req['id'],**reply);del reply
