// A silent, valid PCM WAV for playback tests. Never uses an operator's recording.
const fs=require('node:fs'),path=require('node:path');
module.exports=function wav(dir,name='测试录音',seconds=3.2){
  const rate=8000,n=Math.round(rate*seconds)*2,b=Buffer.alloc(44+n);
  b.write('RIFF',0);b.writeUInt32LE(36+n,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);
  b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(rate,24);b.writeUInt32LE(rate*2,28);
  b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(n,40);
  const file=path.join(dir,name+'.wav');fs.writeFileSync(file,b);return file;
};
