'use strict';
const assert=require('node:assert/strict'),test=require('node:test');
const {paintPalette}=require('../app/quote-palette.mjs');
const {presetUniforms}=require('../app/quote-edge-preset.mjs');
function sample(body,bg=[255,255,255,255],accent){
  const data=new Uint8ClampedArray(48*32*4);
  for(let y=0;y<32;y++)for(let x=0;x<48;x++){
    const inside=y>=12&&y<=20&&x>=9&&x<=38;
    data.set(inside?(accent&&x>28?accent:body):bg,(y*48+x)*4);
  }
  return paintPalette(data,48,32);
}
const ch=(hex,i)=>parseInt(hex.slice(1+2*i,3+2*i),16);
test('paint beats white studio backdrop and coloured roof-line clutter outside crop',()=>{
  const p=sample([135,20,40,255]),q=sample([18,56,151,255]);
  assert.ok(ch(p[1],0)>ch(p[1],2)*2);assert.ok(ch(q[1],2)>ch(q[1],0)*2);
});
test('secondary paint colour is retained when represented in the body region',()=>{
  const p=sample([149,28,33,255],undefined,[30,40,150,255]);
  assert.ok(ch(p[2],2)>ch(p[2],0));
});
test('white, black and silver choose a neutral palette; fully transparent has none',()=>{
  for(const v of [0,106,174,255]){
    const p=sample([v,v,v,255]);assert.ok(p.every(hex=>Math.abs(ch(hex,0)-ch(hex,2))<=6));
  }
  assert.equal(sample([90,22,33,0],[0,0,0,0]),null);
});
test('only the card adds two distinct, secondary colours without changing any paint stop',()=>{
  const bytes=color=>color.slice(0,3).map(v=>Math.round(255*v));
  const ref=presetUniforms(),[cyan,pink,coral]=ref.u_colors.map(bytes);
  assert.equal(ref.u_colorsCount,3);
  for(const [body,accents] of [['#143baa',[cyan,pink]],['#767676',[cyan,pink]],
    ['#04405a',[pink,coral]],['#9611a6',[cyan,coral]]]){
    const paint=['#162336',body,'#e2e4e7'],u=presetUniforms(paint);
    assert.equal(u.u_colorsCount,5);
    assert.deepEqual(u.u_colors.slice(0,3).map(bytes),paint.map(h=>[0,1,2].map(i=>ch(h,i))));
    assert.deepEqual(u.u_colors.slice(3).map(bytes),accents);
    assert.deepEqual(u.u_colors.map(c=>c[3]),[1,1,.8,.30,.22]);
  }
});
