const BUILD='202609241625';
import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {Octree} from 'three/addons/math/Octree.js';
import {Capsule} from 'three/addons/math/Capsule.js';
import {RoomEnvironment} from 'three/addons/environments/RoomEnvironment.js';
import {mergeGeometries} from 'three/addons/utils/BufferGeometryUtils.js';
import {EffectComposer} from 'three/addons/postprocessing/EffectComposer.js';
import {SSAOPass} from 'three/addons/postprocessing/SSAOPass.js';
import {OutputPass} from 'three/addons/postprocessing/OutputPass.js';
import {RenderPass} from 'three/addons/postprocessing/RenderPass.js';

const $=s=>document.querySelector(s),canvas=$('#view');
// Phones report a wide but short viewport in landscape, so size is checked on both axes.
const MOBILE=matchMedia('(pointer:coarse)').matches||Math.min(innerWidth,innerHeight)<520;
// Multisampling costs another full-size buffer, which phones cannot spare.
const renderer=new THREE.WebGLRenderer({canvas,antialias:!MOBILE,powerPreference:'high-performance'});
renderer.setPixelRatio(Math.min(devicePixelRatio,MOBILE?1:1.5));renderer.setSize(innerWidth,innerHeight);
renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.2;
const scene=new THREE.Scene();scene.background=new THREE.Color('#cbd8d8');
const camera=new THREE.PerspectiveCamera(72,innerWidth/innerHeight,.055,100);
camera.rotation.order='YXZ';
// Ambient occlusion needs several full-size buffers plus a depth texture. Phone GPUs run
// out of memory on that, so they render straight to the canvas instead.
let composer=null;
if(!MOBILE){
 composer=new EffectComposer(renderer);
 const ao=new SSAOPass(scene,camera,innerWidth,innerHeight,16);ao.kernelRadius=.28;ao.minDistance=.001;ao.maxDistance=.16;
 composer.addPass(new RenderPass(scene,camera));composer.addPass(ao);composer.addPass(new OutputPass());
}
const pmrem=new THREE.PMREMGenerator(renderer);const env=new RoomEnvironment();
scene.environment=pmrem.fromScene(env,.04).texture;scene.environmentIntensity=.35;env.dispose();pmrem.dispose();
scene.add(new THREE.HemisphereLight(0xe8f2ff,0x8b816c,2.2));
scene.add(new THREE.AmbientLight(0xfff5de,.65));
const sun=new THREE.DirectionalLight(0xfff6e3,2.1);sun.position.set(-8,16,2);scene.add(sun);
const player=new THREE.Vector3(3.64,.02,-.75),lastSafe=player.clone();
let yaw=0,pitch=0,ready=false,started=false,thirdPerson=false,activeDoor=null,walking=0,lastTime=performance.now(),lastRoom='',hintTimer=0;
const keys=new Set(),floorMeshes=[],doors=[],doorById=new Map(),ray=new THREE.Raycaster(),up=new THREE.Vector3(0,1,0),down=new THREE.Vector3(0,-1,0),octree=new Octree();
// A nine-level octree over 270k collision triangles is what makes iOS run out of memory,
// so phones get a shallower tree with bigger leaves.
octree.maxLevel=MOBILE?5:9;octree.trianglesPerLeaf=MOBILE?96:24;
let house,metadata;
const capsule=new Capsule(new THREE.Vector3(),new THREE.Vector3(),.18);
const avatar=new THREE.Group();scene.add(avatar);
const suit=new THREE.MeshStandardMaterial({color:0x375b55,roughness:.85}),skin=new THREE.MeshStandardMaterial({color:0xc7a58d,roughness:.8}),trousers=new THREE.MeshStandardMaterial({color:0x334348});
function bodyPart(geo,mat,pos){const o=new THREE.Mesh(geo,mat);o.position.set(...pos);avatar.add(o);return o;}
bodyPart(new THREE.CapsuleGeometry(.17,.38,5,10),suit,[0,1.12,0]);bodyPart(new THREE.SphereGeometry(.115,12,10),skin,[0,1.63,0]);
const legs=[-.105,.105].map(x=>bodyPart(new THREE.CapsuleGeometry(.072,.56,4,8),trousers,[x,.39,0]));
const arms=[-.24,.24].map(x=>bodyPart(new THREE.CapsuleGeometry(.055,.45,4,8),suit,[x,1.08,0]));avatar.visible=false;
function toast(t){$('#toast').textContent=t;$('#toast').classList.add('show');clearTimeout(hintTimer);hintTimer=setTimeout(()=>$('#toast').classList.remove('show'),2600);}
function dataOf(o){while(o){if(o.userData.sourceName)return o.userData;o=o.parent;}return {};}
function setProgress(n,t){$('#progressBar').style.width=n+'%';$('#loadStatus').textContent=t;}
const doorNames={DoorHinge_GF_002:'杂物间门',DoorHinge_GF_003:'玄关门',DoorHinge_FF_014:'主卫转换门',DoorHinge_FF_007:'中间书房门',PassageHinge_FF:'次卧门',DoorHinge_FF_006:'主卧门',DoorHinge_FF_Rear215:'后书房门',DoorHinge_GF_WC200:'楼下洗手间门',DoorHinge_FF_Room199:'次卧卫浴门',WC214_SlidingDoor_PROVISIONAL:'后房卫浴推拉门',SlidingLeaf_Dining:'餐厅推拉门',CLOSET_Bifold_Hinge1:'衣帽间折叠门',CLOSET_Bifold_Hinge2:'衣帽间折叠门',DuoClassic_GateHinge:'电梯入口门'};
function labelDoor(d){return doorNames[d.source]||(d.source.startsWith('Rear_door_glass')?'早餐区玻璃推拉门':d.source.includes('Front Entrance')?'入户门':d.source.includes('Garage Converted')?'副客厅外门':d.source.includes('French')?'花园双开门':'房门');}

async function load(){
 try{
  metadata=await (await fetch('./assets/house.json?v='+BUILD+'')).json();
  const gltf=await new GLTFLoader().loadAsync('./assets/house'+(MOBILE?'-mobile':'')+'.glb?v='+BUILD,e=>setProgress(6+(e.total?e.loaded/e.total:0)*65,'正在布置家具与房间…'));
  house=gltf.scene;scene.add(house);house.updateMatrixWorld(true);
  setProgress(75,'正在连接门和通道…');await new Promise(r=>setTimeout(r,30));
  // Imported door meshes are in world coordinates. Attach them to explicit hinges.
  for(const d of metadata.doors){
   const old=house.getObjectByName(d.id);if(!old)continue;
   const group=new THREE.Group();group.name='interactive_'+d.id;group.position.fromArray(d.pivot);scene.add(group);group.updateMatrixWorld(true);
   const meshes=[];old.traverse(o=>{if(o.isMesh)meshes.push(o);});
   if(!meshes.length){scene.remove(group);continue;}
   meshes.forEach(o=>group.attach(o));
   // A door hung on the other jamb is also handed the other way: mirror the leaf about its
   // own centre line so the handle and any asymmetric hardware sit on the free edge.
   if(typeof d.mirrorX==='number'){
    const flip=new THREE.Group();flip.name='mirror_'+d.id;
    flip.position.x=2*(d.mirrorX-d.pivot[0]);flip.scale.x=-1;
    group.add(flip);meshes.forEach(o=>flip.add(o));
   }
   const door={...d,group,meshes,amount:d.initial,target:d.initial,label:labelDoor(d),blockedAt:0};
   meshes.forEach(o=>o.userData.interactiveDoor=d.id);
   doors.push(door);doorById.set(d.id,door);
  }
  // Bifold panels have independent hinges but share one action.
  for(const d of doors){if(d.parent){doorById.get(d.parent).group.attach(d.group);}}
  for(const d of doors){d.basePosition=d.group.position.clone();d.baseQuaternion=d.group.quaternion.clone();d.localBoxes=d.meshes.map(m=>{m.geometry.computeBoundingBox();return {mesh:m,box:m.geometry.boundingBox.clone()};});applyDoor(d,d.amount);}
  house.updateMatrixWorld(true);scene.updateMatrixWorld(true);
  // Geometry can be shared between meshes, so count users before anything is freed.
  const geomUsers=new Map();scene.traverse(o=>{if(o.isMesh)geomUsers.set(o.geometry,(geomUsers.get(o.geometry)||0)+1);});
  setProgress(78,'正在建立碰撞体…');await new Promise(r=>setTimeout(r,20));
  const colGroup=new THREE.Group(),colMat=new THREE.MeshBasicMaterial({side:THREE.DoubleSide});let triangles=0;
  house.traverse(o=>{
   if(!o.isMesh)return;
   const info=dataOf(o);
   const mats=Array.isArray(o.material)?o.material:[o.material];
   for(const m of mats){if(m.map)m.map.anisotropy=Math.min(8,renderer.capabilities.getMaxAnisotropy());}
   if(info.walkSurface)floorMeshes.push(o);
   if(!info.solid)return;
   // Highly detailed ornaments use compact collision hulls; walls keep exact openings.
   const tri=(o.geometry.index?.count||o.geometry.attributes.position.count)/3;
   let clone;
   if(tri>(MOBILE?120:1800)&&!/wall|slab|floor|stair|step|landing/i.test(info.sourceName||'')){
    const b=new THREE.Box3().setFromObject(o),size=b.getSize(new THREE.Vector3());
    clone=new THREE.Mesh(new THREE.BoxGeometry(size.x,size.y,size.z),colMat);clone.position.copy(b.getCenter(new THREE.Vector3()));clone.userData.proxy=true;
   }else{clone=new THREE.Mesh(o.geometry,colMat);clone.matrix.copy(o.matrixWorld);clone.matrixAutoUpdate=false;}
   colGroup.add(clone);triangles+=clone.geometry===o.geometry?tri:12;
  });
  octree.fromGraphNode(colGroup);
  // The octree copied the triangles it needs, and nothing reads the collider group again.
  for(const o of colGroup.children)if(o.userData.proxy)o.geometry.dispose();
  colGroup.clear();colMat.dispose();
  setProgress(88,'正在合并材质…');await new Promise(r=>setTimeout(r,20));
  // Merge fixed meshes by material after building collision data to keep rendering responsive.
  const buckets=new Map(),remove=[];
  house.traverse(o=>{if(o.isMesh&&!Array.isArray(o.material)&&!o.userData.interactiveDoor){const k=o.material.uuid;if(!buckets.has(k))buckets.set(k,[]);buckets.get(k).push(o);}});
  for(const list of buckets.values()){
   if(list.length<3)continue;
   const gs=list.map(o=>{let g=o.geometry.index?o.geometry.toNonIndexed():o.geometry.clone();g.applyMatrix4(o.matrixWorld);for(const a of Object.keys(g.attributes))if(!['position','normal','uv'].includes(a))g.deleteAttribute(a);if(!g.attributes.uv)g.setAttribute('uv',new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count*2),2));return g;});
   try{const g=mergeGeometries(gs);if(g){const mesh=new THREE.Mesh(g,list[0].material);scene.add(mesh);list.forEach(o=>{o.visible=false;remove.push(o);});}}catch(e){console.warn('Merge skipped',e.message);}gs.forEach(g=>g.dispose());
  }
  // The originals are duplicated inside the merged meshes now. Their geometry stays alive for
  // floor picking and collision, but they leave the graph so they stop being traversed.
  const keepGeom=new Set(floorMeshes.map(o=>o.geometry)),mergedUse=new Map();
  for(const o of remove){o.parent&&o.parent.remove(o);mergedUse.set(o.geometry,(mergedUse.get(o.geometry)||0)+1);}
  for(const [g,n] of mergedUse)if(!keepGeom.has(g)&&n>=(geomUsers.get(g)||0))g.dispose();
  setProgress(96,'正在布置房间导航…');makePlaces();ready=true;gotoPlace('P18');
  setProgress(100,`${metadata.places.length} 个位置 · ${doors.length} 扇可开合门`);$('#startBtn').disabled=false;$('#startBtn').textContent='开始漫游 →';
  window.walkthrough={ready:true,player,doors,metadata,gotoPlace,toggleDoor,step:movePlayer,updateDoors,applyDoor,scene,camera,renderer,octree,floorAt,doorHit,resolveStatic,start, floorMeshes, setView:(y,p=0)=>{yaw=y;pitch=p;},stats:()=>({meshes:metadata.meshes,doors:doors.length,triangles,position:player.toArray(),calls:renderer.info.render.calls})};
 }catch(e){console.error(e);$('#loadStatus').textContent='加载未完成：'+e.message;$('#startBtn').textContent='刷新重试';$('#startBtn').disabled=false;$('#startBtn').onclick=()=>location.reload();}
}
function applyDoor(d,t){
 const ease=t*t*(3-2*t);
 d.group.position.copy(d.basePosition||d.group.position);d.group.quaternion.copy(d.baseQuaternion||d.group.quaternion);
 if(d.kind==='slide')d.group.position.add(new THREE.Vector3().fromArray(d.closed).lerp(new THREE.Vector3().fromArray(d.opened),ease));
 else d.group.rotateY(THREE.MathUtils.lerp(d.closed,d.opened,ease));
 d.group.updateMatrixWorld(true);
}
function doorHit(pos,only=null){
 const list=only?[only]:doors;
 for(const d of list)for(const {mesh,box} of d.localBoxes){
  const inv=mesh.matrixWorld.clone().invert();
  for(const h of [.5,1.1,1.5]){
   const p=pos.clone().addScaledVector(up,h).applyMatrix4(inv);
   const scale=mesh.getWorldScale(new THREE.Vector3());
   const b=box.clone().expandByVector(new THREE.Vector3(.18/Math.abs(scale.x),.18/Math.abs(scale.y),.18/Math.abs(scale.z)));
   if(b.containsPoint(p))return d;
  }
 }
 return null;
}
function toggleDoor(d){
 if(typeof d==='string')d=doorById.get(d);if(!d)return;
 const target=d.target>.5?0:1;
 for(const x of doors)if(x===d||(d.control&&x.control===d.control))x.target=target;
 toast((target?'打开':'关闭')+' · '+d.label);
}
function updateDoors(dt){
 for(const d of doors){if(Math.abs(d.amount-d.target)<.001)continue;
  const old=d.amount;d.amount=THREE.MathUtils.clamp(d.amount+Math.sign(d.target-d.amount)*dt*1.3,0,1);applyDoor(d,d.amount);
  if(started&&doorHit(player,d)){d.amount=old;applyDoor(d,old);d.target=old;if(performance.now()-d.blockedAt>2000){toast('请退开一点，让门有空间转动');d.blockedAt=performance.now();}}
 }
}
function floorAt(pos,limit=.29){
 // A foot has area: straddle small floor seams at door thresholds, never bridge a stairwell.
 for(const [dx,dz] of [[0,0],[.12,0],[-.12,0],[0,.12],[0,-.12]]){
  ray.set(new THREE.Vector3(pos.x+dx,pos.y+limit,pos.z+dz),down);ray.far=limit+.65;
  const hits=ray.intersectObjects(floorMeshes,false);
  const ground=hits.find(h=>h.face&&h.face.normal.clone().transformDirection(h.object.matrixWorld).y>.5)?.point.y;
  if(ground!==undefined)return ground;
 }
 return null;
}
function resolveStatic(pos){
 capsule.start.set(pos.x,pos.y+.43,pos.z);capsule.end.set(pos.x,pos.y+1.48,pos.z);
 let correction=new THREE.Vector3();
 for(let i=0;i<3;i++){const hit=octree.capsuleIntersect(capsule);if(!hit)break;const v=hit.normal.clone().multiplyScalar(hit.depth+.0001);capsule.translate(v);correction.add(v);}
 return pos.clone().add(correction);
}
function movePlayer(dx,dz){
 const original=player.clone();
 for(const offset of [[dx,0],[0,dz]]){
  if(!offset[0]&&!offset[1])continue;
  let p=player.clone().add(new THREE.Vector3(offset[0],0,offset[1]));
  const ground=floorAt(p);
  if(ground===null||ground<player.y-.45||ground>player.y+.29)continue;
  p.y=ground+.008;
  p=resolveStatic(p);
  if(doorHit(p))continue;
  if(p.distanceTo(player)>.5)continue;
  const finalGround=floorAt(p,.18);if(finalGround===null)continue;
  p.y=finalGround+.008;player.copy(p);
 }
 if(player.distanceTo(original)>.001)lastSafe.copy(player);
 return player.distanceTo(original);
}
function safeSpawn(place){
 const base=new THREE.Vector3().fromArray(place.position);base.y-=1.62;
 let best=null;
 for(const radius of [0,.15,.3,.5,.75,1.1]){
  for(let i=0;i<(radius?16:1);i++){
   const p=base.clone().add(new THREE.Vector3(Math.cos(i*Math.PI/8)*radius,0,Math.sin(i*Math.PI/8)*radius));
   const floor=floorAt(p,1.0);if(floor===null||Math.abs(floor-base.y)>1)continue;p.y=floor+.008;
   const resolved=resolveStatic(p);if(resolved.distanceTo(p)<.025&&!doorHit(p))return p;
   if(!best)best=p;
  }
 }
 return best||base;
}
function gotoPlace(id){
 const p=metadata.places.find(x=>x.id===id);if(!p)return;
 player.copy(safeSpawn(p));lastSafe.copy(player);yaw=id==='P18'?0:Math.PI*.7;pitch=0;
 $('#room').textContent=p.name;$('#level').textContent=p.floor;lastRoom=p.name;
 $('#places').hidden=true;keys.clear();updateCamera(1);return player.toArray();
}
function makePlaces(){for(const floor of ['楼下','楼上']){const h=document.createElement('h3');h.textContent=floor;$('#roomList').append(h);for(const p of metadata.places.filter(x=>x.floor===floor)){const b=document.createElement('button');b.textContent=p.name+' ↗';b.onclick=()=>{gotoPlace(p.id);toast('已来到'+p.name);};$('#roomList').append(b);}}}
function updateCamera(dt){
 camera.rotation.set(pitch,yaw,0);const eye=player.clone().addScaledVector(up,1.62);
 if(thirdPerson){
  const offset=new THREE.Vector3(0,.32,1.55).applyAxisAngle(up,yaw),target=eye.clone().add(offset);
  ray.set(eye,offset.clone().normalize());ray.far=offset.length();
  const hit=octree.rayIntersect(ray.ray),doorDistance=ray.intersectObjects(doors.flatMap(d=>d.meshes),false)[0]?.distance??Infinity;
  const distance=Math.min(hit?.distance??Infinity,doorDistance);
  if(distance<ray.far)target.copy(eye).addScaledVector(offset.normalize(),Math.max(.08,distance-.15));
  camera.position.copy(target);camera.lookAt(eye.clone().add(new THREE.Vector3(0,-.4+Math.sin(pitch)*3,-3).applyAxisAngle(up,yaw)));avatar.visible=camera.position.distanceTo(eye)>.5;
 }else{camera.position.copy(eye);avatar.visible=false;}
 avatar.position.copy(player);avatar.rotation.y=yaw;
 legs.forEach((x,i)=>x.rotation.x=Math.sin(walking+(i?Math.PI:0))*.35*(keys.size?1:0));arms.forEach((x,i)=>x.rotation.x=-Math.sin(walking+(i?Math.PI:0))*.3*(keys.size?1:0));
}
let tick=0;
function interactions(){
 activeDoor=null;ray.setFromCamera(new THREE.Vector2(0,0),camera);ray.far=3;
 const objects=doors.flatMap(d=>d.meshes);
 const hits=ray.intersectObjects(objects,false);const wall=octree.rayIntersect(ray.ray);
 if(hits[0]&&(!wall||wall.distance>hits[0].distance-.05))activeDoor=doorById.get(hits[0].object.userData.interactiveDoor);
 $('#doorHint').hidden=!activeDoor||!started;
 if(activeDoor)$('#doorHint span').textContent=(activeDoor.target>.5?'关闭':'打开')+activeDoor.label;
 if(++tick%10===0&&metadata){let closest=null,dist=Infinity;for(const p of metadata.places){const v=new THREE.Vector3().fromArray(p.position);v.y-=1.62;const d=v.distanceTo(player);if(d<dist){dist=d;closest=p;}}if(closest&&closest.name!==lastRoom){$('#room').textContent=closest.name;$('#level').textContent=closest.floor;lastRoom=closest.name;}}
}
function frame(now){requestAnimationFrame(frame);const dt=Math.min((now-lastTime)/1000,.04);lastTime=now;
 if(ready){updateDoors(dt);
  if(started&&$('#help').hidden&&$('#places').hidden){
   let f=(keys.has('KeyW')||keys.has('ArrowUp')?1:0)-(keys.has('KeyS')||keys.has('ArrowDown')?1:0),r=(keys.has('KeyD')||keys.has('ArrowRight')?1:0)-(keys.has('KeyA')||keys.has('ArrowLeft')?1:0);
   if(f||r){const v=new THREE.Vector3(r,0,-f).normalize().applyAxisAngle(up,yaw).multiplyScalar(dt*(keys.has('ShiftLeft')?2.5:1.45));const n=Math.ceil(v.length()/.035);for(let i=0;i<n;i++)walking+=movePlayer(v.x/n,v.z/n)*7;}
  }updateCamera(dt);if(started&&tick%2===0)interactions();else tick++;
 }if(composer)composer.render();else renderer.render(scene,camera);
}
canvas.addEventListener('webglcontextlost',e=>{e.preventDefault();
 const s=$('#loadStatus');if(s)s.textContent='显卡上下文丢失，请刷新页面。';
 toast('显示中断，请刷新页面');},false);
function start(){if(!ready)return;started=true;document.body.classList.add('started');$('#welcome').hidden=true;if(!matchMedia('(pointer:coarse)').matches)canvas.requestPointerLock?.()?.catch?.(()=>toast('拖动画面也可以环顾'));}
function toggleMode(){thirdPerson=!thirdPerson;$('#modeBtn').textContent=thirdPerson?'第一人称':'跟随人物';}
$('#startBtn').onclick=start;$('#modeBtn').onclick=toggleMode;$('#resetBtn').onclick=()=>gotoPlace('P18');
$('#placesBtn').onclick=()=>{document.exitPointerLock?.();$('#places').hidden=!$('#places').hidden;keys.clear();};$('#closePlaces').onclick=()=>$('#places').hidden=true;
$('#helpBtn').onclick=()=>{document.exitPointerLock?.();$('#help').hidden=false;keys.clear();};$('#closeHelp').onclick=$('#helpContinue').onclick=()=>$('#help').hidden=true;
$('#doorHint').onclick=()=>toggleDoor(activeDoor);$('#fullscreenBtn').onclick=()=>document.fullscreenElement?document.exitFullscreen():document.documentElement.requestFullscreen().catch(()=>{});
document.addEventListener('keydown',e=>{if(['KeyW','KeyA','KeyS','KeyD','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space'].includes(e.code))e.preventDefault();keys.add(e.code);if(e.repeat)return;if(e.code==='Escape'){document.exitPointerLock?.();keys.clear();drag=null;}if(e.code==='KeyE'&&started)toggleDoor(activeDoor);if(e.code==='KeyV')toggleMode();});
document.addEventListener('keyup',e=>keys.delete(e.code));window.addEventListener('blur',()=>keys.clear());document.addEventListener('visibilitychange',()=>keys.clear());document.addEventListener('pointerlockchange',()=>keys.clear());
let drag=null;
canvas.addEventListener('pointerdown',e=>{if(!started)return;if(activeDoor&&e.pointerType!=='touch'){toggleDoor(activeDoor);return;}drag={x:e.clientX,y:e.clientY};canvas.setPointerCapture(e.pointerId);});
canvas.addEventListener('pointerup',e=>{if(drag&&Math.abs(e.clientX-drag.x)+Math.abs(e.clientY-drag.y)<5&&e.pointerType==='mouse')canvas.requestPointerLock?.()?.catch?.(()=>{});drag=null;});
document.addEventListener('pointermove',e=>{if(!started)return;let dx=0,dy=0;if(document.pointerLockElement===canvas){dx=e.movementX;dy=e.movementY;}else if(drag&&e.target===canvas){dx=e.clientX-drag.x;dy=e.clientY-drag.y;drag={x:e.clientX,y:e.clientY};}yaw-=dx*.0025;pitch=THREE.MathUtils.clamp(pitch-dy*.0025,-1.25,1.25);});
document.querySelectorAll('[data-key]').forEach(b=>{b.onpointerdown=e=>{e.preventDefault();b.setPointerCapture(e.pointerId);keys.add(b.dataset.key);};b.onpointerup=b.onpointercancel=()=>keys.delete(b.dataset.key);});
// A phone held upright squeezes the horizontal view down to about 37 degrees at the
// fixed 72 degree vertical angle, so widen the vertical angle on tall screens only.
function frameCamera(){const aspect=innerWidth/innerHeight;
 camera.fov=aspect>=1.2?72:THREE.MathUtils.clamp(2*THREE.MathUtils.radToDeg(Math.atan(Math.tan(THREE.MathUtils.degToRad(36))*1.2/aspect)),72,88);
 camera.aspect=aspect;camera.updateProjectionMatrix();}
frameCamera();
window.addEventListener('resize',()=>{frameCamera();renderer.setSize(innerWidth,innerHeight);if(composer)composer.setSize(innerWidth,innerHeight);});
window.addEventListener('orientationchange',()=>setTimeout(()=>{frameCamera();renderer.setSize(innerWidth,innerHeight);if(composer)composer.setSize(innerWidth,innerHeight);},250));
load();requestAnimationFrame(frame);

