#!/usr/bin/env node
/* ============================================================================
   FLAGSTER — GLB VIEWER

   Loads any .glb through the vendored Three.js and the real GLTFLoader, in
   headless Chromium, and writes four views of it plus the numbers that say
   whether it is right: bone count, skinned-mesh count, world bounding box, and
   the clips it carries with their durations.

     node tools/glb-view.mjs model.glb out-dir ["Clip Name"]

   It exists because a converted asset can be wrong in ways no amount of reading
   the file will show. Every bug in fbx-to-glb.mjs was found here: a skeleton
   whose inverse binds did not match its rest pose tore the mesh into shards; a
   dropped parent node laid the character face-down along Z; inverse binds built
   from the wrong matrix rendered him at one hundredth life size and the numbers
   above said so before the picture did.

   posesheet.mjs is the equivalent for a clip on the GAME's own rig. This one
   takes any GLB, which is what an import pipeline needs.

   Needs Playwright and the swiftshader Chromium. A dev tool; nothing in
   flagster/ imports it.
   ============================================================================ */
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
import { chromium } from 'playwright';
const ROOT='/home/user/alixpham.github.io';
const GLB=process.argv[2], OUT=process.argv[3], CLIP=process.argv[4]||null;
const CHROME=fs.globSync('/opt/pw-browsers/chromium*/chrome-linux/chrome').sort().pop();
const MIME={'.html':'text/html','.js':'text/javascript','.glb':'model/gltf-binary','.png':'image/png'};
const server=http.createServer((req,res)=>{
  if(req.url.startsWith('/model.glb')){const b=fs.readFileSync(GLB);res.writeHead(200,{'Content-Type':'model/gltf-binary'});res.end(b);return;}
  let f=path.join(ROOT,decodeURIComponent(req.url.split('?')[0]));
  if(f.endsWith('/'))f+='index.html';
  fs.readFile(f,(e,b)=>{if(e){res.writeHead(404);res.end();return;}
    res.writeHead(200,{'Content-Type':MIME[path.extname(f)]||'application/octet-stream'});res.end(b);});
});
await new Promise(r=>server.listen(0,r));
const base=`http://127.0.0.1:${server.address().port}/`;
const page=`<!doctype html><meta charset=utf-8><style>body{margin:0}</style>
<script type="importmap">{"imports":{"three":"/flagster/lib/three/three.module.js","three/addons/":"/flagster/lib/three/jsm/"}}</script>
<script type="module">
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
const W=520,H=760;
const renderer=new THREE.WebGLRenderer({antialias:true,preserveDrawingBuffer:true});
renderer.setSize(W,H);renderer.setPixelRatio(2);
renderer.outputColorSpace=THREE.SRGBColorSpace;
renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.05;
document.body.appendChild(renderer.domElement);
const scene=new THREE.Scene();scene.background=new THREE.Color(0x20242b);
scene.add(new THREE.DirectionalLight(0xfff4e6,3.1).translateX(1.4).translateY(2.4).translateZ(2.4));
const k=new THREE.DirectionalLight(0xfff4e6,3.1);k.position.set(1.4,2.4,2.4);
const f=new THREE.DirectionalLight(0xcfe0ff,1.2);f.position.set(-2.2,1.0,1.2);
const r=new THREE.DirectionalLight(0xffffff,2.2);r.position.set(-0.8,1.8,-2.4);
scene.add(k,f,r,new THREE.HemisphereLight(0xbfd4ff,0x4a4238,0.9));
scene.add(new THREE.GridHelper(8,16,0x55606e,0x39414c));
window.__shots=[];window.__info=null;
new GLTFLoader().load('/model.glb',(g)=>{
  scene.add(g.scene);
  const box=new THREE.Box3().setFromObject(g.scene);
  let bones=0,skinned=0;
  g.scene.traverse(o=>{if(o.isBone)bones++;if(o.isSkinnedMesh)skinned++;});
  window.__info={min:box.min.toArray(),max:box.max.toArray(),bones,skinned,
    clips:g.animations.map(a=>a.name+' ('+a.duration.toFixed(2)+'s)')};
  const CLIP=${JSON.stringify(CLIP)};
  if(CLIP&&g.animations.length){
    const mixer=new THREE.AnimationMixer(g.scene);
    const clip=g.animations.find(a=>a.name===CLIP)||g.animations[0];
    const act=mixer.clipAction(clip);act.play();
    mixer.setTime(clip.duration*0.35);
  }
  const c=new THREE.Vector3(0,(box.max.y+box.min.y)/2,0);
  const dist=Math.max(2.4,(box.max.y-box.min.y)*1.6);
  for(const deg of [0,35,90,180]){
    const rad=deg*Math.PI/180;
    const cam=new THREE.PerspectiveCamera(32,W/H,0.05,60);
    cam.position.set(c.x+Math.sin(rad)*dist,c.y*1.15,c.z+Math.cos(rad)*dist);
    cam.lookAt(c);renderer.render(scene,cam);
    window.__shots.push(renderer.domElement.toDataURL('image/png'));
  }
  window.__done=true;
},undefined,(e)=>{window.__err=String(e&&e.message||e);window.__done=true;});
</script>`;
fs.writeFileSync(path.join(ROOT,'.glbview.html'),page);
const browser=await chromium.launch({executablePath:CHROME,headless:true,
  args:['--use-gl=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--no-sandbox','--disable-dev-shm-usage']});
const pg=await(await browser.newContext({viewport:{width:560,height:800}})).newPage();
const errs=[];pg.on('console',m=>{if(m.type()==='error')errs.push(m.text())});pg.on('pageerror',e=>errs.push(e.message));
await pg.goto(base+'.glbview.html',{waitUntil:'load'});
await pg.waitForFunction(()=>window.__done,null,{timeout:60000});
const info=await pg.evaluate(()=>({i:window.__info,e:window.__err,s:window.__shots}));
if(info.e) console.log('LOAD ERROR:',info.e);
else {
  console.log('  bones', info.i.bones, ' skinnedMeshes', info.i.skinned);
  console.log('  world bounds y', info.i.min[1].toFixed(3),'..',info.i.max[1].toFixed(3),
              ' height', (info.i.max[1]-info.i.min[1]).toFixed(3),'m');
  console.log('  clips:', info.i.clips.join(', '));
  fs.mkdirSync(OUT,{recursive:true});
  info.s.forEach((d,i)=>fs.writeFileSync(path.join(OUT,'view'+i+'.png'),Buffer.from(d.split(',')[1],'base64')));
  console.log('  wrote', info.s.length, 'views to', OUT);
}
if(errs.length) console.log('  console errors:', errs.slice(0,3));
fs.unlinkSync(path.join(ROOT,'.glbview.html'));
await browser.close();server.close();
