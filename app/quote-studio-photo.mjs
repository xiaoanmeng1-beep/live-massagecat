// A display-only cutout for plain white catalog backdrops. Flood from outside
// rather than keying out every white pixel (windscreens, plates and paint).
// Real scenes, ambiguous edges and placeholders keep their original image.
export function studioCutout(source){
  const ratio=Math.min(1,440/source.naturalWidth,260/source.naturalHeight);
  const w=Math.round(source.naturalWidth*ratio),h=Math.round(source.naturalHeight*ratio);
  if(w<16||h<16)return;
  const canvas=document.createElement('canvas');canvas.width=w;canvas.height=h;
  const ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.drawImage(source,0,0,w,h);
  const pixels=ctx.getImageData(0,0,w,h),p=pixels.data,n=w*h;
  const white=i=>p[i+3]<12 || Math.min(p[i],p[i+1],p[i+2])>=238;
  let samples=0,matches=0;
  for(let x=0;x<w;x+=3){samples+=2;matches+=white(x*4)+white(((h-1)*w+x)*4);}
  for(let y=0;y<h;y+=3){samples+=2;matches+=white(y*w*4)+white((y*w+w-1)*4);}
  if(matches<samples*.90)return;
  const seen=new Uint8Array(n),queue=new Uint32Array(n);
  let start=0,end=0;
  function add(k){if(!seen[k]&&white(k*4)){seen[k]=1;queue[end++]=k;}}
  for(let x=0;x<w;x++){add(x);add((h-1)*w+x);}
  for(let y=0;y<h;y++){add(y*w);add(y*w+w-1);}
  while(start<end){
    const k=queue[start++],x=k%w;p[k*4+3]=0;
    if(x)add(k-1);if(x<w-1)add(k+1);if(k>=w)add(k-w);if(k<n-w)add(k+w);
  }
  if(end<n*.12||end>n*.94)return;
  // JPEG edge pixels are already blended with white. Undo that matte in
  // the narrow boundary band so a dark card doesn't reveal a dotted fringe.
  for(let y=1;y<h-1;y++)for(let x=1;x<w-1;x++){
    const k=y*w+x,j=k*4;
    if(seen[k] || !(seen[k-1]||seen[k+1]||seen[k-w]||seen[k+w]||
        seen[k-w-1]||seen[k-w+1]||seen[k+w-1]||seen[k+w+1]))continue;
    const alpha=Math.min(1,(255-Math.min(p[j],p[j+1],p[j+2]))/176);
    for(let c=0;c<3;c++)p[j+c]=(p[j+c]-255*(1-alpha))/Math.max(.01,alpha);
    p[j+3]*=alpha;
  }
  let x0=w,x1=-1,y0=h,y1=-1;
  for(let k=0;k<n;k++)if(p[k*4+3]>16){
    const x=k%w,y=Math.floor(k/w);x0=Math.min(x0,x);x1=Math.max(x1,x);y0=Math.min(y0,y);y1=Math.max(y1,y);
  }
  if(x1-x0<w*.28 || y1-y0<h*.18)return;
  ctx.putImageData(pixels,0,0);
  const crop=document.createElement('canvas');crop.width=x1-x0+1;crop.height=y1-y0+1;
  crop.getContext('2d').drawImage(canvas,x0,y0,crop.width,crop.height,0,0,crop.width,crop.height);
  return crop;
}
