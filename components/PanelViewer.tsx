'use client';

import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { QuadMeshData, Panel } from '@/lib/quad-mesher';
import styles from './PanelViewer.module.css';

export type PipelineStep = 'triangles' | 'quads' | 'panels' | 'animation';

interface Props {
  step: PipelineStep;
  sourceGeometry?: THREE.BufferGeometry | null;
  quadMeshData?: QuadMeshData | null;
  isLoading?: boolean;
  progress?: number;
}

const THICKNESS = 0.10;
const WAVE_SECONDS = 2.4;
const FLY_SECONDS = 0.65;
const SCATTER_MULT = 3.2;

function easeOutBack(x: number) {
  const c1 = 1.35, c3 = c1+1;
  return 1 + c3*(x-1)**3 + c1*(x-1)**2;
}
function clamp01(x: number) { return Math.max(0, Math.min(1, x)); }

interface Anim {
  phase: 'assembled'|'assembling'|'exploded'|'exploding';
  startTime: number;
  scatter: Float32Array;
  delays: Float32Array;
  maxDelay: number;
}

function centroid(panels: Panel[]) {
  let cx=0,cy=0,cz=0;
  for(const p of panels){cx+=p.center[0];cy+=p.center[1];cz+=p.center[2];}
  const n=panels.length||1;
  let r=0;
  for(const p of panels){
    const dx=p.center[0]-cx/n,dy=p.center[1]-cy/n,dz=p.center[2]-cz/n;
    r=Math.max(r,Math.sqrt(dx*dx+dy*dy+dz*dz));
  }
  return {cx:cx/n,cy:cy/n,cz:cz/n,r:r||1};
}

// ─── Build Three.js objects for each step ────────────────────────────────────

function buildTrianglesScene(
  geo: THREE.BufferGeometry,
  add: (o: THREE.Object3D) => void,
) {
  const cloned = geo.clone();
  cloned.computeVertexNormals();

  const mesh = new THREE.Mesh(
    cloned,
    new THREE.MeshPhongMaterial({ color:0x5599dd, flatShading:true, side:THREE.DoubleSide, transparent:true, opacity:0.88 }),
  );
  mesh.castShadow = true;
  add(mesh);

  const wire = new THREE.LineSegments(
    new THREE.WireframeGeometry(cloned),
    new THREE.LineBasicMaterial({ color:0x9bbcde, transparent:true, opacity:0.35 }),
  );
  add(wire);
}

type QuadViewMode = 'wireframe' | 'solid';

function buildQuadsScene(
  data: QuadMeshData,
  add: (o: THREE.Object3D) => void,
  viewMode: QuadViewMode,
) {
  const { quads, orphans } = data;
  const wire = viewMode === 'wireframe';

  if (quads.length > 0) {
    // ── Filled faces (always — in wireframe mode pushed back so edges win depth) ──
    const qPos: number[] = [], qCol: number[] = [];
    for (const q of quads) {
      const [v0,v1,v2,v3] = q.v;
      const cr=(q.normal[0]+1)*0.3+0.25, cg=(q.normal[1]+1)*0.2+0.35, cb=(q.normal[2]+1)*0.3+0.30;
      const push3 = (v:[number,number,number])=>{ qPos.push(...v); qCol.push(cr,cg,cb); };
      push3(v0); push3(v1); push3(v2);
      push3(v0); push3(v2); push3(v3);
    }
    const fillGeo = new THREE.BufferGeometry();
    fillGeo.setAttribute('position', new THREE.Float32BufferAttribute(qPos, 3));
    fillGeo.setAttribute('color',    new THREE.Float32BufferAttribute(qCol, 3));
    fillGeo.computeVertexNormals();
    const fillMat = new THREE.MeshPhongMaterial({
      vertexColors: true, side: THREE.DoubleSide, shininess: wire ? 5 : 20,
      polygonOffset: wire, polygonOffsetFactor: wire ? 4 : 0, polygonOffsetUnits: wire ? 4 : 0,
    });
    const m = new THREE.Mesh(fillGeo, fillMat);
    m.castShadow = true;
    add(m);

    // ── Quad edges ────────────────────────────────────────────────────────────
    const wPos: number[] = [];
    for (const q of quads) {
      const [v0,v1,v2,v3] = q.v;
      wPos.push(...v0,...v1, ...v1,...v2, ...v2,...v3, ...v3,...v0);
    }
    const wGeo = new THREE.BufferGeometry();
    wGeo.setAttribute('position', new THREE.Float32BufferAttribute(wPos, 3));
    add(new THREE.LineSegments(wGeo, new THREE.LineBasicMaterial(
      wire
        ? { color: 0x00ccff }
        : { color: 0xffffff, transparent: true, opacity: 0.35 },
    )));

    // ── Vertex dots (wireframe mode only) ────────────────────────────────────
    if (wire) {
      const vPos: number[] = [];
      for (const q of quads) for (const v of q.v) vPos.push(...v);
      const vGeo = new THREE.BufferGeometry();
      vGeo.setAttribute('position', new THREE.Float32BufferAttribute(vPos, 3));
      add(new THREE.Points(vGeo, new THREE.PointsMaterial({ color: 0xffffff, size: 4, sizeAttenuation: false })));
    }
  }

  // ── Orphan triangles ──────────────────────────────────────────────────────
  if (orphans.length > 0) {
    // Filled faces — always shown (polygon-offset in wireframe mode)
    const oPos: number[] = [];
    for (const o of orphans) { const [v0,v1,v2]=o.v; oPos.push(...v0,...v1,...v2); }
    const oGeo = new THREE.BufferGeometry();
    oGeo.setAttribute('position', new THREE.Float32BufferAttribute(oPos, 3));
    oGeo.computeVertexNormals();
    const oMat = new THREE.MeshPhongMaterial({
      color: 0xe07030, side: THREE.DoubleSide, flatShading: true,
      transparent: true, opacity: wire ? 0.5 : 0.65,
      polygonOffset: wire, polygonOffsetFactor: wire ? 4 : 0, polygonOffsetUnits: wire ? 4 : 0,
    });
    add(new THREE.Mesh(oGeo, oMat));

    const oWire: number[] = [];
    for (const o of orphans) { const [v0,v1,v2]=o.v; oWire.push(...v0,...v1, ...v1,...v2, ...v2,...v0); }
    const owGeo = new THREE.BufferGeometry();
    owGeo.setAttribute('position', new THREE.Float32BufferAttribute(oWire, 3));
    add(new THREE.LineSegments(owGeo, new THREE.LineBasicMaterial(
      wire
        ? { color: 0xff7700 }
        : { color: 0xffaa55, transparent: true, opacity: 0.70 },
    )));

    if (wire) {
      const ovPos: number[] = [];
      for (const o of orphans) for (const v of o.v) ovPos.push(...v);
      const ovGeo = new THREE.BufferGeometry();
      ovGeo.setAttribute('position', new THREE.Float32BufferAttribute(ovPos, 3));
      add(new THREE.Points(ovGeo, new THREE.PointsMaterial({ color: 0xff9955, size: 3, sizeAttenuation: false })));
    }
  }
}

function buildPanelsScene(panels: Panel[], add: (o: THREE.Object3D) => void): THREE.InstancedMesh | null {
  if (panels.length === 0) return null;
  const geo = new THREE.BoxGeometry(1,1,1);
  const mat = new THREE.MeshPhongMaterial({ side:THREE.FrontSide, shininess:40 });
  const mesh = new THREE.InstancedMesh(geo, mat, panels.length);
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), P = new THREE.Vector3(), S = new THREE.Vector3(), C = new THREE.Color();
  for (let i=0; i<panels.length; i++) {
    const p = panels[i];
    Q.set(p.quaternion[0],p.quaternion[1],p.quaternion[2],p.quaternion[3]);
    P.set(p.center[0],p.center[1],p.center[2]);
    S.set(p.size, p.size, p.size*THICKNESS);
    M.compose(P,Q,S);
    mesh.setMatrixAt(i, M);
    C.setRGB(p.color[0],p.color[1],p.color[2]);
    mesh.setColorAt(i, C);
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  add(mesh);
  return mesh;
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function PanelViewer({ step, sourceGeometry, quadMeshData, isLoading=false, progress=0 }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef     = useRef<THREE.Scene|null>(null);
  const rendererRef  = useRef<THREE.WebGLRenderer|null>(null);
  const cameraRef    = useRef<THREE.PerspectiveCamera|null>(null);
  const objectsRef   = useRef<THREE.Object3D[]>([]);   // disposable scene objects
  const animMeshRef  = useRef<THREE.InstancedMesh|null>(null);
  const animRef      = useRef<Anim|null>(null);
  const panelsRef    = useRef<Panel[]>([]);
  const controlsRef  = useRef({ drag:false, prev:{x:0,y:0}, rot:{x:0.35,y:0.5}, zoom:1.0 });

  const [animPhase, setAnimPhase]       = useState<Anim['phase']>('assembled');
  const [quadViewMode, setQuadViewMode] = useState<QuadViewMode>('wireframe');

  // ── Three.js setup (once) ─────────────────────────────────────────────────
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const scene = new THREE.Scene();
    scene.background = null;
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(60, el.clientWidth/el.clientHeight, 0.01, 10000);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias:true, alpha:true, powerPreference:'high-performance' });
    renderer.setSize(el.clientWidth, el.clientHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    el.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    // Lights
    scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const key = new THREE.DirectionalLight(0xffffff, 1.05);
    key.position.set(30,50,25); key.castShadow=true; key.shadow.mapSize.set(1024,1024);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0x6688ff, 0.4);
    fill.position.set(-25,10,-30); scene.add(fill);
    const back = new THREE.DirectionalLight(0xffcc88, 0.3);
    back.position.set(0,-20,-40); scene.add(back);

    // Mouse controls
    const ctrl = controlsRef.current;
    const onDown = (e:MouseEvent) => { ctrl.drag=true; ctrl.prev={x:e.clientX,y:e.clientY}; };
    const onMove = (e:MouseEvent) => {
      if (!ctrl.drag) return;
      ctrl.rot.y += (e.clientX-ctrl.prev.x)*0.005;
      ctrl.rot.x  = Math.max(-Math.PI/2, Math.min(Math.PI/2, ctrl.rot.x+(e.clientY-ctrl.prev.y)*0.005));
      ctrl.prev = {x:e.clientX,y:e.clientY};
    };
    const onUp = () => { ctrl.drag=false; };
    const onWheel = (e:WheelEvent) => { e.preventDefault(); ctrl.zoom=Math.max(0.08,Math.min(12,ctrl.zoom*(1+e.deltaY*0.001))); };
    renderer.domElement.addEventListener('mousedown',onDown);
    renderer.domElement.addEventListener('mousemove',onMove);
    renderer.domElement.addEventListener('mouseup',onUp);
    renderer.domElement.addEventListener('wheel',onWheel,{passive:false});

    const onResize = () => {
      const w=el.clientWidth,h=el.clientHeight;
      if(w>0&&h>0){camera.aspect=w/h;camera.updateProjectionMatrix();renderer.setSize(w,h);}
    };
    window.addEventListener('resize',onResize);

    // Render loop
    const M=new THREE.Matrix4(),Q=new THREE.Quaternion(),P=new THREE.Vector3(),S=new THREE.Vector3();
    let raf=0;
    const loop = (ts:number) => {
      raf=requestAnimationFrame(loop);

      const anim = animRef.current;
      const mesh = animMeshRef.current;
      const panels = panelsRef.current;

      // Animate assembly/explosion
      if (anim && mesh && panels.length>0 && (anim.phase==='assembling'||anim.phase==='exploding')) {
        const elapsed=(ts-anim.startTime)/1000;
        for(let i=0;i<panels.length;i++){
          const pnl=panels[i];
          const t=clamp01((elapsed-anim.delays[i])/FLY_SECONDS);
          const et=easeOutBack(t);
          const [fx,fy,fz]=pnl.center;
          const sx=anim.scatter[i*3],sy=anim.scatter[i*3+1],sz=anim.scatter[i*3+2];
          let px:number,py:number,pz:number;
          if(anim.phase==='assembling'){
            px=sx+(fx-sx)*et; py=sy+(fy-sy)*et; pz=sz+(fz-sz)*et;
          } else {
            px=fx+(sx-fx)*et; py=fy+(sy-fy)*et; pz=fz+(sz-fz)*et;
          }
          Q.set(pnl.quaternion[0],pnl.quaternion[1],pnl.quaternion[2],pnl.quaternion[3]);
          P.set(px,py,pz); S.set(pnl.size,pnl.size,pnl.size*THICKNESS);
          M.compose(P,Q,S);
          mesh.setMatrixAt(i,M);
        }
        mesh.instanceMatrix.needsUpdate=true;
        if(elapsed>=anim.maxDelay+FLY_SECONDS){
          const next=anim.phase==='assembling'?'assembled':'exploded';
          anim.phase=next;
          setAnimPhase(next);
        }
      }

      // Camera orbit — bounding box from all geometry-bearing objects
      if(objectsRef.current.length>0){
        const box=new THREE.Box3();
        for(const o of objectsRef.current){
          if(o instanceof THREE.Mesh||o instanceof THREE.InstancedMesh||
             o instanceof THREE.LineSegments||o instanceof THREE.Points) box.expandByObject(o);
        }
        if(!box.isEmpty()){
          const c=new THREE.Vector3(); box.getCenter(c);
          const r=box.getSize(new THREE.Vector3()).length()*0.5||1;
          const d=r*2.8*ctrl.zoom;
          const rx=ctrl.rot.x,ry=ctrl.rot.y;
          camera.position.set(
            c.x+d*Math.sin(ry)*Math.cos(rx),
            c.y+d*Math.sin(rx),
            c.z+d*Math.cos(ry)*Math.cos(rx),
          );
          camera.lookAt(c.x,c.y,c.z);
          camera.far=r*30; camera.updateProjectionMatrix();
        }
      }

      renderer.render(scene,camera);
    };
    raf=requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize',onResize);
      renderer.domElement.removeEventListener('mousedown',onDown);
      renderer.domElement.removeEventListener('mousemove',onMove);
      renderer.domElement.removeEventListener('mouseup',onUp);
      renderer.domElement.removeEventListener('wheel',onWheel);
      if(el.contains(renderer.domElement)) el.removeChild(renderer.domElement);
      renderer.dispose();
    };
  }, []);

  // ── Rebuild scene when step / data changes ────────────────────────────────
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;

    // Dispose previous objects
    for (const o of objectsRef.current) {
      scene.remove(o);
      if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments || o instanceof THREE.InstancedMesh) {
        o.geometry.dispose();
        const m = (o as THREE.Mesh).material;
        if (Array.isArray(m)) m.forEach(x=>x.dispose()); else (m as THREE.Material).dispose();
      }
    }
    objectsRef.current = [];
    animMeshRef.current = null;
    animRef.current = null;
    panelsRef.current = [];

    const add = (o: THREE.Object3D) => { scene.add(o); objectsRef.current.push(o); };

    if (step === 'triangles' && sourceGeometry) {
      buildTrianglesScene(sourceGeometry, add);

    } else if (step === 'quads' && quadMeshData) {
      buildQuadsScene(quadMeshData, add, quadViewMode);

    } else if (step === 'panels' && quadMeshData) {
      buildPanelsScene(quadMeshData.panels, add);

    } else if (step === 'animation' && quadMeshData) {
      const panels = quadMeshData.panels;
      panelsRef.current = panels;

      const mesh = buildPanelsScene(panels, add);
      if (!mesh) return;
      animMeshRef.current = mesh;

      // Compute scatter positions and wave delays
      const { cx, cy, cz, r } = centroid(panels);
      const sr = r * SCATTER_MULT;
      const maxDist = Math.max(...panels.map(p=>p.distFromCenter), 1);
      const scatter = new Float32Array(panels.length*3);
      const delays  = new Float32Array(panels.length);

      for (let i=0; i<panels.length; i++) {
        const p=panels[i];
        let dx=p.center[0]-cx, dy=p.center[1]-cy, dz=p.center[2]-cz;
        const dl=Math.sqrt(dx*dx+dy*dy+dz*dz)||1;
        dx/=dl; dy/=dl; dz/=dl;
        scatter[i*3]=cx+dx*sr; scatter[i*3+1]=cy+dy*sr; scatter[i*3+2]=cz+dz*sr;
        delays[i]=(p.distFromCenter/maxDist)*WAVE_SECONDS;
      }

      // Place panels at scatter positions immediately
      const M=new THREE.Matrix4(),Q=new THREE.Quaternion(),P=new THREE.Vector3(),S=new THREE.Vector3();
      for(let i=0;i<panels.length;i++){
        const p=panels[i];
        Q.set(p.quaternion[0],p.quaternion[1],p.quaternion[2],p.quaternion[3]);
        P.set(scatter[i*3],scatter[i*3+1],scatter[i*3+2]);
        S.set(p.size,p.size,p.size*THICKNESS);
        M.compose(P,Q,S);
        mesh.setMatrixAt(i,M);
      }
      mesh.instanceMatrix.needsUpdate=true;

      const anim: Anim = { phase:'exploded', startTime:0, scatter, delays, maxDelay:WAVE_SECONDS };
      animRef.current = anim;
      setAnimPhase('exploded');

      // Auto-start assembly after a short pause
      const tid = setTimeout(() => {
        if (animRef.current===anim) {
          anim.phase='assembling'; anim.startTime=performance.now();
          setAnimPhase('assembling');
        }
      }, 350);
      return () => clearTimeout(tid);
    }
  }, [step, sourceGeometry, quadMeshData, quadViewMode]);

  const triggerExplode = () => {
    const a=animRef.current;
    if(!a||a.phase==='exploded'||a.phase==='exploding') return;
    a.phase='exploding'; a.startTime=performance.now(); setAnimPhase('exploding');
  };
  const triggerAssemble = () => {
    const a=animRef.current;
    if(!a||a.phase==='assembled'||a.phase==='assembling') return;
    a.phase='assembling'; a.startTime=performance.now(); setAnimPhase('assembling');
  };

  const showAnimControls = step === 'animation' && animRef.current != null;
  const showQuadControls = step === 'quads' && !!quadMeshData;

  return (
    <div className={styles.container} ref={containerRef}>
      {showQuadControls && (
        <div className={styles.hud}>
          <span className={styles.count}>
            {quadMeshData!.stats.quadCount.toLocaleString()} quads
            {quadMeshData!.stats.orphanCount > 0 && (
              <span className={styles.orphanBadge}> · {quadMeshData!.stats.orphanCount} orphans</span>
            )}
          </span>
          <div className={styles.controls}>
            <button
              className={`${styles.btn} ${quadViewMode==='wireframe' ? styles.btnActive : ''}`}
              onClick={() => setQuadViewMode('wireframe')}
            >
              Wireframe
            </button>
            <button
              className={`${styles.btn} ${quadViewMode==='solid' ? styles.btnPrimary : ''}`}
              onClick={() => setQuadViewMode('solid')}
            >
              Solid
            </button>
          </div>
          <span className={styles.status}>
            {quadViewMode === 'wireframe' ? 'Edges · vertices' : 'Filled faces'}
          </span>
        </div>
      )}
      {showAnimControls && (
        <div className={styles.hud}>
          <span className={styles.count}>
            {(quadMeshData?.panels.length??0).toLocaleString()} panels
          </span>
          <div className={styles.controls}>
            <button className={`${styles.btn} ${animPhase==='assembled'?styles.btnActive:''}`}
              onClick={triggerExplode} disabled={animPhase!=='assembled'}>
              Explode
            </button>
            <button className={`${styles.btn} ${animPhase==='exploded'?styles.btnPrimary:''}`}
              onClick={triggerAssemble} disabled={animPhase!=='exploded'}>
              Assemble
            </button>
          </div>
          <span className={styles.status}>
            {animPhase==='assembling'?'Assembling…':animPhase==='exploding'?'Exploding…':animPhase==='assembled'?'Assembled':'Exploded'}
          </span>
        </div>
      )}

      {isLoading && (
        <div className={styles.overlay}>
          <div className={styles.spinner}/>
          <div className={styles.progressLabel}>
            <span className={styles.progressValue}>{Math.round(progress)}%</span>
            <span>Building panels…</span>
          </div>
          <div className={styles.progressBar}>
            <div className={styles.progressFill} style={{width:`${progress}%`}}/>
          </div>
        </div>
      )}
    </div>
  );
}
