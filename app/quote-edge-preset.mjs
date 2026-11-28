// The share hash, NOT the unrelated server-rendered example below the demo.
export const shareURL='https://shaders.paper.design/pulsing-border#colors=0dc1fd,d915ef,ff3f2ecc&colorBack=000000&roundness=0.25&thickness=0.1&softness=0.75&aspectRatio=auto&intensity=0.2&bloom=0.25&spots=4&spotSize=0.5&pulse=0.25&smoke=0.3&smokeSize=0.6&speed=1&scale=0.6&rotation=0&offsetX=0&offsetY=0&marginLeft=0&marginRight=0&marginTop=0&marginBottom=0';
const hash=new URLSearchParams(new URL(shareURL).hash.slice(1));
const numeric=name=>{
  const value=hash.get(name);
  if(value===null||value.trim()===''||!Number.isFinite(Number(value)))throw Error('Invalid Paper parameter: '+name);
  return Number(value);
};
const named=Object.fromEntries([...hash.keys()].filter(k=>!['colors','colorBack','aspectRatio','speed'].includes(k)).map(k=>['u_'+k,numeric(k)]));
export const speed=numeric('speed');
const channels=value=>{
  const hex=value.replace(/^#/,'');
  if(!/^(?:[0-9a-f]{6}|[0-9a-f]{8})$/i.test(hex))throw Error('Invalid Paper color');
  return [0,2,4,6].map(i=>i===6&&hex.length===6?1:parseInt(hex.slice(i,i+2),16)/255);
};
const original=hash.get('colors').split(',').map(channels);
// Use Paper's last two colour slots for accents; leave all three paint stops intact.
function accentStops([r,g,b]){
  const hue=([r,g,b])=>Math.atan2(Math.sqrt(3)*(g-b),2*r-g-b);
  const body=hue([r,g,b]),neutral=Math.max(r,g,b)-Math.min(r,g,b)<.09;
  // Prefer the reference cyan and magenta. If either repeats the paint hue,
  // use the reference coral instead, including for darker shades of that paint.
  return original.filter(color=>neutral||Math.cos(hue(color)-body)<Math.cos(Math.PI/8))
    .slice(0,2).map((c,i)=>[...c.slice(0,3),i===0?.30:.22]);
}
export function presetUniforms(paint=null){
  const colors=original.map((rgba,i)=>paint?[...channels(paint[i]).slice(0,3),rgba[3]]:[...rgba]);
  if(paint)colors.push(...accentStops(colors[1]));
  return {...named,u_fit:1,u_originX:.5,u_originY:.5,u_worldWidth:0,u_worldHeight:0,
    u_aspectRatio:hash.get('aspectRatio')==='auto'?0:1,
    u_colors:colors,u_colorsCount:colors.length,u_colorBack:paint?[0,0,0,0]:channels(hash.get('colorBack'))};
}

// In the shared demo the contour occupies only part of the canvas. Crop that
// viewport to the quote rectangle; do not "fix" scale, margins or offset in GLSL.
export function alignContour(host){
  const {u_scale:s,u_marginLeft:l,u_marginRight:r,u_marginTop:t,u_marginBottom:b,u_offsetX:x,u_offsetY:y}=named;
  const w=s*(1-l-r),h=s*(1-t-b);
  const left=.5+x+s*(l-.5),top=.5+y+s*(t-.5);
  for(const [key,n] of Object.entries({w:1/w,h:1/h,x:-left/w,y:-top/h}))
    host.style.setProperty('--preset-'+key,n*100+'%');
}
