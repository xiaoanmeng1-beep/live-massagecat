// Work on a thumbnail, not the full source. Crop out the studio surround and
// weight broad paint colours higher than white backgrounds, glass and tyres.
export function paintPalette(rgba, width, height) {
  const bins=Array.from({length:18},()=>({weight:0,count:0,sum:[0,0,0]}));
  let count=0,midtones=0,gray=0;
  for(let y=Math.floor(height*.29);y<height*.76;y++){
    for(let x=Math.floor(width*.14);x<width*.86;x++){
      const i=4*(y*width+x);
      if(rgba[i+3]<170)continue;
      count++;
      const r=rgba[i],g=rgba[i+1],b=rgba[i+2];
      const hi=Math.max(r,g,b),lo=Math.min(r,g,b),d=hi-lo;
      if(hi<26||lo>237)continue;
      midtones++;gray+=(r+g+b)/3;
      if(d<22 || d/hi<.19)continue;
      const hue=hi===r?(g-b)/d:hi===g?2+(b-r)/d:4+(r-g)/d;
      const bin=bins[(Math.round(hue*3)+18)%18];
      const w=(.4+d/hi)*(1-.65*Math.abs(x/width-.5))*(1-.5*Math.abs(y/height-.52));
      bin.weight+=w;bin.count++;[r,g,b].forEach((v,j)=>{bin.sum[j]+=w*v;});
    }
  }
  if(!count)return null;
  const hex=rgb=>'#'+rgb.map(v=>Math.min(255,Math.round(v)).toString(16).padStart(2,'0')).join('');
  const mix=(a,b,t)=>a.map((v,i)=>v*(1-t)+b[i]*t);
  const mean=bin=>bin.sum.map(v=>v/bin.weight);
  const ranked=bins.sort((a,b)=>b.weight-a.weight);
  const top=ranked[0];
  if(top.count<Math.max(3,midtones*.07,count*.035)){
    // A silver/white/black vehicle is a real palette, not a reason to invent a hue.
    const v=midtones ? Math.round(75+gray/midtones*.46) : 166;
    return [hex([v*.48,v*.49,v*.5]),hex([v,v+2,v+4]),'#e1e4e6'];
  }
  const body=mean(top);
  const runner=ranked.find(bin=>bin!==top&&bin.weight>top.weight*.25 &&
    Math.hypot(...mean(bin).map((v,i)=>v-body[i]))>60);
  const peak=Math.max(...body);
  const bright=body.map(v=>v*Math.max(1,185/peak));
  return [hex(mix(body,[18,18,18],.34)),hex(bright),
    hex(mix(runner?mean(runner):bright,[255,249,244],runner ? .25 : .55))];
}
