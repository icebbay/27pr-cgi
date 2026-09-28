const BUILD='202609282330';
import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {DRACOLoader} from 'three/addons/loaders/DRACOLoader.js';
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
const hemi=new THREE.HemisphereLight(0xe8f2ff,0x8b816c,2.2);scene.add(hemi);
const ambient=new THREE.AmbientLight(0xfff5de,.65);scene.add(ambient);
const sun=new THREE.DirectionalLight(0xfff6e3,2.1);sun.position.set(-8,16,2);scene.add(sun);scene.add(sun.target);
// Desktop gets real sun shadows (sunlight patches through the windows). The map is only redrawn
// when the time of day changes or something moves, not every frame.
if(!MOBILE){renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;renderer.shadowMap.autoUpdate=false;
 sun.castShadow=true;sun.shadow.mapSize.set(4096,4096);Object.assign(sun.shadow.camera,{left:-13,right:13,top:13,bottom:-13,near:1,far:70});
 sun.shadow.bias=-.0004;sun.shadow.normalBias=.03;}
const player=new THREE.Vector3(3.64,.02,-.75),lastSafe=player.clone();
let yaw=0,pitch=0,ready=false,started=false,thirdPerson=false,activeDoor=null,activePart=null,activeSwitch=null,activeLamp=null,night=false,walking=0,lastTime=performance.now(),lastRoom='',hintTimer=0;
const keys=new Set(),floorMeshes=[],doors=[],doorById=new Map(),parts=[],partById=new Map(),partNodes=new Map(),leafParts=[],lamps=[],lampById=new Map(),switches=[],switchById=new Map(),ray=new THREE.Raycaster(),up=new THREE.Vector3(0,1,0),down=new THREE.Vector3(0,-1,0),octree=new Octree();
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
const doorNames={DoorHinge_GF_002:'杂物间门',DoorHinge_GF_003:'玄关门',DoorHinge_FF_014:'主卫转换门',DoorHinge_FF_007:'中间书房门',PassageHinge_FF:'次卧门',DoorHinge_FF_006:'主卧门',DoorHinge_FF_Rear215:'后书房门',DoorHinge_GF_WC200:'楼下洗手间门',DoorHinge_FF_Room199:'次卧卫浴门',WC214_SlidingDoor_PROVISIONAL:'后房卫浴推拉门',SlidingLeaf_Dining:'餐厅推拉门',CLOSET_Bifold_Hinge1:'衣帽间折叠门',CLOSET_Bifold_Hinge2:'衣帽间折叠门',DuoClassic_GateHinge:'电梯入口门',V15_Left_Concealed_Hinge:'主厅吸音墙隐形门'};
// Movable product parts (exported from the product library's joints).
const productNames={G02:'餐边柜',G03:'折叠泡茶桌',G09:'真皮沙发',G13:'鞋柜',G17:'展示柜',G18:'展示柜',G20:'马桶',G21:'电视柜',G22:'电视柜',G24:'软水机',G27:'吧台椅',G33:'移动屏风',
 F02:'箱体床',F03:'床头柜',F04:'床头柜',F05:'升降梳妆台',F07:'床头柜',F08:'床头柜',F10:'半镜柜',F12:'台盆柜',F13:'智能马桶',F16:'智能马桶',F17:'台盆柜',F21a:'升降书桌',F21b:'升降书桌',
 F24:'人体工学椅',F25:'主卫一门两用门',F26:'鞋帽间门',F27:'衣帽间门',F28:'人体工学椅',F29:'梳妆台',F31:'旋转毛巾架'};
function jointName(id){
 const n=m=>+m+1;let r;
 if(r=id.match(/^(?:base_)?door_(\d)_open$/))return (id.startsWith('base')?'下柜门':'柜门')+n(r[1]);
 if(r=id.match(/^drawer_(\d)(?:_open)?$/))return '抽屉'+n(r[1]);
 if(r=id.match(/^panel_(\d)$/))return '面板'+n(r[1]);
 if(r=id.match(/^bar_(\d)$/))return '毛巾杆'+n(r[1]);
 if(r=id.match(/^seat_(\d)_out$/))return '座位'+n(r[1])+'伸展';
 if(r=id.match(/^back_(\d)_fold$/))return '靠背'+n(r[1]);
 if(r=id.match(/^glass_(\d)_slide$/))return '玻璃门'+n(r[1]);
 if(r=id.match(/^fold_(\d)$/))return '桌板'+n(r[1]);
 return {drawer:'抽屉',drawer_open:'抽屉',upper_drawer_open:'上抽屉',lower_drawer_open:'下抽屉',door_l_open:'左门',door_r_open:'右门',left_open:'左门',right_open:'右门',
  left_flap_open:'翻板',lid_open:'盖板',storage_door:'储物门',leaf:'门',mirror:'镜子角度',mirror_lift:'镜子升降',lift:'升降',platform_lift:'床板掀起',
  recline:'靠背后仰',headrest:'头枕',footrest:'搁脚',arm_l:'左扶手',arm_r:'右扶手',retract:'收放',seat_j:'座椅'}[id]||id;
}
function partVerb(p,on){
 if(/drawer/.test(p.joint))return on?'拉出':'推回';
 if(/door|leaf|flap|lid|open|glass/.test(p.joint))return on?'打开':'关闭';
 return on?'调整':'复位';
}
function labelPart(j){return j.product+' '+(productNames[j.product]||'')+' · '+(j.product==='F25'&&j.joint==='leaf'?'转换(关主门/关副门)':jointName(j.joint));}
function labelDoor(d){const v13={Lounge:'主厅外开法式门',Utility:'副厅外开法式门',KitchenSide:'早餐区外开法式门'}[(d.source.match(/^V13_(\w+?)_(?:Low|High)_Hinge$/)||[])[1]];if(v13)return v13;return doorNames[d.source]||(d.source.startsWith('Rear_door_glass')?'早餐区玻璃推拉门':d.source.includes('Front Entrance')?'入户门':d.source.includes('Garage Converted')?'副客厅外门':d.source.includes('French')?'花园双开门':'房门');}

async function load(){
 try{
  metadata=await (await fetch('./assets/house.json?v='+BUILD+'')).json();
  // v19: geometry is Draco-compressed; the decoder ships in vendor/, no network needed.
  const draco=new DRACOLoader().setDecoderPath('./vendor/addons/libs/draco/gltf/');
  const gltf=await new GLTFLoader().setDRACOLoader(draco).loadAsync('./assets/house'+(MOBILE?'-mobile':'')+'.glb?v='+BUILD,e=>setProgress(6+(e.total?e.loaded/e.total:0)*65,'正在布置家具与房间…'));
  draco.dispose();house=gltf.scene;scene.add(house);house.updateMatrixWorld(true);
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
  // Product parts: every joint carries sampled world-space deltas per rigid group of meshes.
  // Parts are placed by setting their matrix directly (delta at the current amount x rest pose).
  for(const j of metadata.joints||[]){
   const groups=[];
   for(const g of j.groups){
    const nodes=g.meshes.map(n=>house.getObjectByName(n)).filter(Boolean);if(!nodes.length)continue;
    groups.push({nodes,mats:g.m.map(a=>new THREE.Matrix4().fromArray(a))});
    for(const o of nodes){if(!partNodes.has(o))partNodes.set(o,{rest:o.matrix.clone(),joints:[]});partNodes.get(o).joints.push(j.id);}
   }
   if(!groups.length)continue;
   const meshes=[];groups.forEach(g=>g.nodes.forEach(o=>o.traverse(m=>{if(m.isMesh)meshes.push(m);})));
   const part={...j,groups,meshes,amount:j.rest,target:j.rest,label:labelPart(j)};
   meshes.forEach(m=>{(m.userData.parts||(m.userData.parts=[])).push(part);m.userData.interactivePart=true;});
   parts.push(part);partById.set(j.id,part);
  }
  for(const o of partNodes.keys())o.matrixAutoUpdate=false;
  // Product doors (F25/F26/F27) block the way like the house doors do.
  for(const p of parts)if(p.joint==='leaf'){p.localBoxes=p.meshes.map(m=>{m.geometry.computeBoundingBox();return {mesh:m,box:m.geometry.boundingBox.clone()};});leafParts.push(p);}
  applyParts();
  // Lamps: a realtime point light each (kept in the scene and dimmed to 0 when off, so switching
  // never recompiles shaders) plus a glow on the lamp's pale parts. Switches control their room.
  const lampMeshes=new Map();
  house.traverse(o=>{if(!o.isMesh)return;const id=dataOf(o).lampId;if(!id)return;if(!lampMeshes.has(id))lampMeshes.set(id,[]);lampMeshes.get(id).push(o);});
  for(const l of metadata.lamps||[]){
   const c=new THREE.Color().setRGB(...l.color);
   const light=null;
   const meshes=lampMeshes.get(l.id)||[];const glow=[];
   for(const m of meshes){m.userData.lamp=l.id;const mats=Array.isArray(m.material)?m.material:[m.material];
    const own=mats.map(x=>{const hsl={};x.color?.getHSL(hsl);if(!x.emissive||hsl.l<.45)return x;const y=x.clone();glow.push(y);return y;});
    m.material=Array.isArray(m.material)?own:own[0];}
   const lamp={...l,light,meshes,glow,on:false,power:l.outdoor?l.energy:Math.max(5,l.energy*.26)};
   lamps.push(lamp);lampById.set(l.id,lamp);
  }
  const swMeshes=new Map();
  house.traverse(o=>{if(!o.isMesh)return;const id=dataOf(o).switchId;if(!id)return;if(!swMeshes.has(id))swMeshes.set(id,[]);swMeshes.get(id).push(o);});
  for(const w of metadata.switches||[]){const meshes=swMeshes.get(w.id)||[];const sw={...w,meshes};meshes.forEach(m=>m.userData.switchId=w.id);switches.push(sw);switchById.set(w.id,sw);}
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
  house.traverse(o=>{if(o.isMesh&&!Array.isArray(o.material)&&!o.userData.interactiveDoor&&!o.userData.interactivePart&&!o.userData.lamp&&!o.userData.switchId){const k=o.material.uuid;if(!buckets.has(k))buckets.set(k,[]);buckets.get(k).push(o);}});
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
  if(!MOBILE)scene.traverse(o=>{if(o.isMesh){o.castShadow=true;o.receiveShadow=true;}});
  setTime(1,true);
  setProgress(96,'正在布置房间导航…');makePlaces();ready=true;gotoPlace('P18');
  setProgress(100,`${metadata.places.length} 个位置 · ${doors.length} 扇门 · ${parts.length} 个家具活动件`+(lamps.length?` · ${lamps.length} 盏灯`:''));$('#startBtn').disabled=false;$('#startBtn').textContent='开始漫游 →';
  window.walkthrough={ready:true,player,doors,parts,togglePart,lamps,switches,setNight,setTime,setLamp,pressSwitch,metadata,gotoPlace,toggleDoor,step:movePlayer,updateDoors,applyDoor,scene,camera,renderer,octree,floorAt,doorHit,resolveStatic,start, floorMeshes, setView:(y,p=0)=>{yaw=y;pitch=p;},stats:()=>({meshes:metadata.meshes,doors:doors.length,triangles,position:player.toArray(),calls:renderer.info.render.calls})};
 }catch(e){console.error(e);$('#loadStatus').textContent='加载未完成：'+e.message;$('#startBtn').textContent='刷新重试';$('#startBtn').disabled=false;$('#startBtn').onclick=()=>location.reload();}
}
function applyDoor(d,t){
 const ease=t*t*(3-2*t);
 d.group.position.copy(d.basePosition||d.group.position);d.group.quaternion.copy(d.baseQuaternion||d.group.quaternion);
 if(d.kind==='slide')d.group.position.add(new THREE.Vector3().fromArray(d.closed).lerp(new THREE.Vector3().fromArray(d.opened),ease));
 else d.group.rotateY(THREE.MathUtils.lerp(d.closed,d.opened,ease));
 d.group.updateMatrixWorld(true);
}
const _p0=new THREE.Vector3(),_p1=new THREE.Vector3(),_s0=new THREE.Vector3(),_s1=new THREE.Vector3(),_q0=new THREE.Quaternion(),_q1=new THREE.Quaternion(),_d=new THREE.Matrix4();
function sampleDelta(mats,t,out){
 const s=THREE.MathUtils.clamp(t,0,1)*(mats.length-1),k=Math.min(Math.floor(s),mats.length-2),f=s-k;
 mats[k].decompose(_p0,_q0,_s0);mats[k+1].decompose(_p1,_q1,_s1);
 return out.compose(_p0.lerp(_p1,f),_q0.slerp(_q1,f),_s0.lerp(_s1,f));
}
function applyParts(){
 for(const [o,info] of partNodes){
  const m=info.rest.clone();
  for(const id of info.joints){const p=partById.get(id);if(!p)continue;const g=p.groups.find(g=>g.nodes.includes(o));if(!g)continue;
   // Deltas are relative to the exported pose, which sits at p.rest on this joint's range.
   sampleDelta(g.mats,p.amount,_d);m.premultiply(_d);}
  o.matrix.copy(m);o.matrixWorldNeedsUpdate=true;
 }
}
const SKY_DAY=new THREE.Color('#cbd8d8'),SKY_NIGHT=new THREE.Color('#0c1220');
// Compass in this model: front door / bay window face WEST (Blender -Y), the rear garden is EAST,
// so Blender +X is south. In web coordinates that makes north = -X, east = -Z, south = +X, west = +Z.
// Sun angles are for the UK (about 54°N) around the equinox.
const TIMES=[
 {id:'morning',label:'早晨',az:95,el:14,color:0xffe0bd,sun:2.6,hemi:1.5,amb:.42,sky:'#dcd6cc',env:.28,exp:1.2,lamps:false},
 {id:'noon',label:'中午',az:180,el:36,color:0xfff7ec,sun:2.5,hemi:2.2,amb:.62,sky:'#cbd8d8',env:.35,exp:1.2,lamps:false},
 {id:'evening',label:'傍晚',az:262,el:9,color:0xffab66,sun:2.1,hemi:.8,amb:.22,sky:'#dcae86',env:.16,exp:1.25,lamps:true},
 {id:'night',label:'夜晚',az:170,el:32,color:0x9fb4ff,sun:.12,hemi:.08,amb:.1,sky:'#0c1220',env:.03,exp:1.35,lamps:true}];
let timeIndex=1;const HOUSE_CENTRE=new THREE.Vector3(0,1.5,-8);
function sunDirection(az,el){const a=THREE.MathUtils.degToRad(az),e=THREE.MathUtils.degToRad(el);
 const n=Math.cos(a)*Math.cos(e),east=Math.sin(a)*Math.cos(e);return new THREE.Vector3(-n,Math.sin(e),-east);}
// A small fixed pool of point lights follows the nearest lit lamps, so the per-pixel light count
// (and the shaders) never change while walking or switching; daytime has no pool at all.
const POOL=MOBILE?4:8;let pool=[],poolDirty=true,poolTick=0;const poolAt=new THREE.Vector3(1e9,0,0);
function ensurePool(on){if(on&&!pool.length){for(let i=0;i<POOL;i++){const p=new THREE.PointLight(0xffffff,0,9,2);scene.add(p);pool.push(p);}}
 if(!on&&pool.length){pool.forEach(p=>scene.remove(p));pool=[];}}
function updatePool(){if(!pool.length)return;const eye=player.clone().addScaledVector(up,1.4);
 // Point lights have no shadows and would shine through walls, so only lamps the eye can actually
 // see (same room, or through an open doorway) get a light; the rest just glow.
 const lit=[];for(const l of lamps){if(!l.on)continue;const p=new THREE.Vector3().fromArray(l.pos),d=eye.distanceTo(p);if(d>14)continue;
  const r=new THREE.Ray(eye.clone(),p.clone().sub(eye).normalize()),hit=octree.rayIntersect(r);
  if(hit&&hit.distance<d-.45)continue;lit.push({l,d});}
 lit.sort((a,b)=>a.d-b.d);
 pool.forEach((p,i)=>{const e=lit[i];if(!e||e.d>14){p.intensity=0;return;}p.position.fromArray(e.l.pos);p.color.setRGB(...e.l.color);p.intensity=e.l.power;p.distance=e.l.outdoor?7:9;});poolDirty=false;}
function setLamp(l,on){if(typeof l==='string')l=lampById.get(l);if(!l)return;l.on=on;poolDirty=true;
 for(const m of l.glow){m.emissive.setRGB(...l.color);m.emissiveIntensity=on?(night?1.6:.8):0;}}
function setTime(i,quiet){
 timeIndex=(i+TIMES.length)%TIMES.length;const t=TIMES[timeIndex];night=t.id==='night';
 ensurePool(t.lamps);scene.background=new THREE.Color(t.sky);hemi.intensity=t.hemi;ambient.intensity=t.amb;
 sun.intensity=t.sun;sun.color.set(t.color);scene.environmentIntensity=t.env;renderer.toneMappingExposure=t.exp;
 sun.target.position.copy(HOUSE_CENTRE);sun.position.copy(HOUSE_CENTRE).addScaledVector(sunDirection(t.az,t.el),35);
 sun.castShadow=!MOBILE&&t.sun>.5;renderer.shadowMap.needsUpdate=true;
 for(const l of lamps)setLamp(l,t.lamps);
 const b=$('#dayBtn');if(b)b.textContent=t.label;
 if(!quiet)toast(t.label+(t.id==='morning'?' · 太阳从东边后院照进来':t.id==='noon'?' · 太阳在南边':t.id==='evening'?' · 夕阳从西边前门方向照进来，灯已打开':' · 灯已打开，可用墙上开关逐间开关'));
}
function setNight(v){return setTime(v?3:1);}
function setNightLegacy(v){
 night=v;ensurePool(v);scene.background=v?SKY_NIGHT:SKY_DAY;hemi.intensity=v?.08:2.2;ambient.intensity=v?.1:.65;sun.intensity=v?.12:2.1;
 sun.color.set(v?0x9fb4ff:0xfff6e3);scene.environmentIntensity=v?.03:.35;renderer.toneMappingExposure=v?1.35:1.2;
 // Dusk: every lamp comes on; at daybreak they switch off. Switches still work in both.
 for(const l of lamps)setLamp(l,v);
 const b=$('#dayBtn');if(b)b.textContent=v?'白天':'夜晚';toast(v?'夜晚 · 灯已打开，可用墙上开关逐间开关':'白天');
}
function pressSwitch(w){if(typeof w==='string')w=switchById.get(w);if(!w)return;
 const ls=w.lamps.map(id=>lampById.get(id)).filter(Boolean);
 if(!ls.length){toast('这个开关还没有接灯（'+w.roomName+'）');return;}
 const on=!ls.some(l=>l.on);ls.forEach(l=>setLamp(l,on));toast((on?'开灯':'关灯')+' · '+w.roomName);}
function toggleLamp(l){setLamp(l,!l.on);toast((l.on?'开灯':'关灯')+' · '+(productNames[l.product]||l.roomName||'灯'));}
function togglePart(p){
 if(typeof p==='string')p=partById.get(p);if(!p)return;
 p.target=p.target>.5?0:1;toast(partVerb(p,p.target>.5)+' · '+p.label);
}
function updateParts(dt){
 let moved=false;
 for(const p of parts){if(Math.abs(p.amount-p.target)<.001)continue;p.amount=THREE.MathUtils.clamp(p.amount+Math.sign(p.target-p.amount)*dt*1.1,0,1);moved=true;}
 if(moved){applyParts();renderer.shadowMap.needsUpdate=true;}
}
function doorHit(pos,only=null){
 const list=only?[only]:doors.concat(leafParts);
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
  renderer.shadowMap.needsUpdate=true;const old=d.amount;d.amount=THREE.MathUtils.clamp(d.amount+Math.sign(d.target-d.amount)*dt*1.3,0,1);applyDoor(d,d.amount);
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
 activeDoor=null;activePart=null;activeSwitch=null;activeLamp=null;ray.setFromCamera(new THREE.Vector2(0,0),camera);ray.far=3;
 const objects=doors.flatMap(d=>d.meshes).concat(parts.flatMap(p=>p.meshes),switches.flatMap(w=>w.meshes),lamps.filter(l=>!l.switches.length).flatMap(l=>l.meshes));
 const hits=ray.intersectObjects(objects,false);const wall=octree.rayIntersect(ray.ray);
 if(hits[0]&&(!wall||wall.distance>hits[0].distance-.05)){const u=hits[0].object.userData;
  // A mesh moved by several joints (a chair seat under lift and recline) picks the most specific one.
  if(u.switchId)activeSwitch=switchById.get(u.switchId);else if(u.lamp&&!u.parts)activeLamp=lampById.get(u.lamp);else if(u.interactiveDoor)activeDoor=doorById.get(u.interactiveDoor);else if(u.parts)activePart=u.parts.reduce((a,b)=>b.meshes.length<a.meshes.length?b:a);}
 $('#doorHint').hidden=!(activeDoor||activePart||activeSwitch||activeLamp)||!started;
 if(activeSwitch){const ls=activeSwitch.lamps.map(id=>lampById.get(id)).filter(Boolean);$('#doorHint span').textContent=ls.length?((ls.some(l=>l.on)?'关灯':'开灯')+' · '+activeSwitch.roomName):'开关 · '+activeSwitch.roomName+'（未接灯）';}
 else if(activeLamp)$('#doorHint span').textContent=(activeLamp.on?'关灯':'开灯')+' · '+(productNames[activeLamp.product]||activeLamp.roomName);
 else if(activeDoor)$('#doorHint span').textContent=(activeDoor.target>.5?'关闭':'打开')+activeDoor.label;
 else if(activePart)$('#doorHint span').textContent=partVerb(activePart,activePart.target<=.5)+' '+activePart.label;
 if(++tick%10===0&&metadata){let closest=null,dist=Infinity;for(const p of metadata.places){const v=new THREE.Vector3().fromArray(p.position);v.y-=1.62;const d=v.distanceTo(player);if(d<dist){dist=d;closest=p;}}if(closest&&closest.name!==lastRoom){$('#room').textContent=closest.name;$('#level').textContent=closest.floor;lastRoom=closest.name;}}
}
function frame(now){requestAnimationFrame(frame);const dt=Math.min((now-lastTime)/1000,.04);lastTime=now;
 if(ready){updateDoors(dt);updateParts(dt);if(pool.length&&(poolDirty||++poolTick%12===0||player.distanceTo(poolAt)>.8)){poolAt.copy(player);updatePool();}
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
$('#startBtn').onclick=start;{const b=$('#dayBtn');if(b)b.onclick=()=>setTime(timeIndex+1);}$('#modeBtn').onclick=toggleMode;$('#resetBtn').onclick=()=>gotoPlace('P18');
$('#placesBtn').onclick=()=>{document.exitPointerLock?.();$('#places').hidden=!$('#places').hidden;keys.clear();};$('#closePlaces').onclick=()=>$('#places').hidden=true;
$('#helpBtn').onclick=()=>{document.exitPointerLock?.();$('#help').hidden=false;keys.clear();};$('#closeHelp').onclick=$('#helpContinue').onclick=()=>$('#help').hidden=true;
{const t=$('#buildTag');if(t)t.textContent='版本 '+BUILD;}
$('#doorHint').onclick=()=>activeSwitch?pressSwitch(activeSwitch):activeLamp?toggleLamp(activeLamp):activePart?togglePart(activePart):toggleDoor(activeDoor);$('#fullscreenBtn').onclick=()=>document.fullscreenElement?document.exitFullscreen():document.documentElement.requestFullscreen().catch(()=>{});
document.addEventListener('keydown',e=>{if(['KeyW','KeyA','KeyS','KeyD','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space'].includes(e.code))e.preventDefault();keys.add(e.code);if(e.repeat)return;if(e.code==='Escape'){document.exitPointerLock?.();keys.clear();drag=null;}if(e.code==='KeyE'&&started)activeSwitch?pressSwitch(activeSwitch):activeLamp?toggleLamp(activeLamp):activePart?togglePart(activePart):toggleDoor(activeDoor);if(e.code==='KeyN'&&metadata?.lamps?.length)setTime(timeIndex+1);if(e.code==='KeyV')toggleMode();});
document.addEventListener('keyup',e=>keys.delete(e.code));window.addEventListener('blur',()=>keys.clear());document.addEventListener('visibilitychange',()=>keys.clear());document.addEventListener('pointerlockchange',()=>keys.clear());
let drag=null;
canvas.addEventListener('pointerdown',e=>{if(!started)return;if((activeSwitch||activeLamp)&&e.pointerType!=='touch'){activeSwitch?pressSwitch(activeSwitch):toggleLamp(activeLamp);return;}if(activePart&&e.pointerType!=='touch'){togglePart(activePart);return;}if(activeDoor&&e.pointerType!=='touch'){toggleDoor(activeDoor);return;}drag={x:e.clientX,y:e.clientY};canvas.setPointerCapture(e.pointerId);});
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

