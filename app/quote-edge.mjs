import {paintPalette} from './quote-palette.mjs';
import {alignContour,presetUniforms,speed} from './quote-edge-preset.mjs';

// Use the pinned vanilla distribution shipped in the app, not a remote shader/CDN.
async function loadPaper(){
  const [{ShaderMount},{pulsingBorderFragmentShader},{getShaderNoiseTexture}]=await Promise.all([
    import('../node_modules/@paper-design/shaders/dist/shader-mount.js'),
    import('../node_modules/@paper-design/shaders/dist/shaders/pulsing-border.js'),
    import('../node_modules/@paper-design/shaders/dist/get-shader-noise-texture.js')
  ]);
  const noise=getShaderNoiseTexture();await noise.decode();
  return {ShaderMount,fragment:pulsingBorderFragmentShader,noise};
}
export function createQuoteEdge(host){
  alignContour(host);
  let ticket=0, mount=null, paper=null, failed=false, active=false;
  const reduced=matchMedia('(prefers-reduced-motion: reduce)');
  function motion(){mount?.setSpeed(active&&!reduced.matches ? speed : 0);}
  reduced.addEventListener('change',motion);
  function stop(){
    active=false;motion();host.removeAttribute('data-active');
  }
  function removeMount(){
    const old=mount;mount=null;
    old?.dispose();host.querySelector('canvas')?.remove();host.removeAttribute('data-paper-shader');
  }
  function loseContext(){failed=true;removeMount();} // keep the sampled CSS rim
  addEventListener('pagehide',()=>{
    ticket++;stop();removeMount();reduced.removeEventListener('change',motion);
  },{once:true});
  return {async select(card,job){
    const seq=++ticket;
    const current=()=>seq===ticket&&card.parentElement?.id==='boardCurrent';
    // Keep the live rim mounted while the next real photo is decoded. Clearing
    // data-active here produced a white frame on every quote change.
    let sampled=false;
    const img=card.querySelector('.board-vehicle-photo img');
    // The featured placeholder is a bundled asset, never a queue entry or an IPC request.
    const bundled=!job&&card.classList.contains('sample-quote')&&
      img?.src===new URL('./quote-samples/vios.jpg',document.baseURI).href;
    if(!img||(!bundled&&!job?.photo)){stop();return;}
    try {
      let source=img;
      if(!bundled&&/^https:\/\//i.test(job.photo)){
        const bytes=await window.desktop.getFeaturedPhoto(job.id);
        if(!current())return;
        if(!bytes){stop();return;}
        source=new Image();source.src=bytes;
      }else {
        if(!bundled&&!/^data:image\/(png|jpeg|webp|gif);base64,/i.test(job.photo)){stop();return;}
        // Sample the original paint, independent of the thumbnail's display-only srcset.
        source=new Image();source.src=img.src;
      }
      await source.decode();
      if(!current())return;
      if(!bundled&&!source.src.startsWith('data:image/')){stop();return;}
      if(source!==img&&!img.naturalWidth)img.src=source.src;
      const thumb=document.createElement('canvas');thumb.width=48;thumb.height=32;
      const ctx=thumb.getContext('2d',{willReadFrequently:true});
      ctx.drawImage(source,0,0,48,32);
      const colors=paintPalette(ctx.getImageData(0,0,48,32).data,48,32);
      if(!current())return;
      if(!colors){stop();return;}
      sampled=true;
      host.style.setProperty('--edge-body',colors[1]); // static, no-WebGL fallback only
      host.setAttribute('data-active','');active=true;
      if(failed)return;
      const {ShaderMount,fragment,noise}=await (paper??=loadPaper());
      if(!current())return;
      const uniforms=presetUniforms(colors);
      if(!mount){
        mount=new ShaderMount(host,fragment,{...uniforms,u_noiseTexture:noise},{alpha:true},0,0,1,640000);
        mount.canvasElement.addEventListener('webglcontextlost',loseContext,{once:true});
      }else mount.setUniforms({u_colors:uniforms.u_colors});
      motion();
    }catch {
      // A missing image stays neutral. A missing GPU retains the static tinted rim.
      if(current()){if(!sampled)stop();else{failed=true;removeMount();}}
    }
  }};
}
