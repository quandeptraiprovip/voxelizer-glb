'use client';

import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import styles from './VoxelViewer.module.css';

interface Voxel {
  position: number[];
  normal?: number[];
  color: number[];
  size: number;
  z_height?: number;
  rotation?: [number, number, number];
  quaternion?: [number, number, number, number];
  curvature?: number;
}

interface VoxelViewerProps {
  voxels?: Voxel[];
  progress?: number;
  isLoading?: boolean;
}

function computeModelBounds(voxels: Voxel[]): { min: THREE.Vector3; max: THREE.Vector3; center: THREE.Vector3 } {
  if (voxels.length === 0) {
    return {
      min: new THREE.Vector3(-1, -1, -1),
      max: new THREE.Vector3(1, 1, 1),
      center: new THREE.Vector3(0, 0, 0),
    };
  }

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  voxels.forEach((v) => {
    const [x, y, z] = v.position;
    const half = (v.size || 1) / 2;

    minX = Math.min(minX, x - half);
    minY = Math.min(minY, y - half);
    minZ = Math.min(minZ, z - half);
    maxX = Math.max(maxX, x + half);
    maxY = Math.max(maxY, y + half);
    maxZ = Math.max(maxZ, z + half);
  });

  const min = new THREE.Vector3(minX, minY, minZ);
  const max = new THREE.Vector3(maxX, maxY, maxZ);
  const center = new THREE.Vector3(
    (minX + maxX) / 2,
    (minY + maxY) / 2,
    (minZ + maxZ) / 2
  );

  return { min, max, center };
}

export default function VoxelViewer({ voxels = [], progress = 0, isLoading = false }: VoxelViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const meshRef = useRef<THREE.InstancedMesh | null>(null);
  const edgeLinesRef = useRef<THREE.LineSegments | null>(null);
  const controlsRef = useRef<any>(null);
  const [voxelCount, setVoxelCount] = useState(0);

  useEffect(() => {
    if (!containerRef.current) return;

    const container = containerRef.current;
    const width = container.clientWidth;
    const height = container.clientHeight;

    // Scene
    const scene = new THREE.Scene();
    scene.background = null;
    sceneRef.current = scene;

    // Camera
    const camera = new THREE.PerspectiveCamera(75, width / height, 0.1, 10000);
    camera.position.set(0, 0, 0);
    cameraRef.current = camera;

    // Renderer
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    container.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    // Lighting
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.7);
    scene.add(ambientLight);

    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.9);
    // Fixed world-space light position (front-left-top)
    directionalLight.position.set(30, 40, 30);
    directionalLight.target.position.set(0, 0, 0); // Point at world origin
    directionalLight.castShadow = true;
    directionalLight.shadow.mapSize.width = 2048;
    directionalLight.shadow.mapSize.height = 2048;
    directionalLight.shadow.camera.far = 500;
    directionalLight.shadow.camera.left = -200;
    directionalLight.shadow.camera.right = 200;
    directionalLight.shadow.camera.top = 200;
    directionalLight.shadow.camera.bottom = -200;
    scene.add(directionalLight);
    scene.add(directionalLight.target);

    // Simple orbit controls
    const controls = {
      isDragging: false,
      previousMousePosition: { x: 0, y: 0 },
      rotation: { x: 0.4, y: 0.6 },
      zoom: 1,
      distance: 4,
    };

    const onMouseDown = (e: MouseEvent) => {
      controls.isDragging = true;
      controls.previousMousePosition = { x: e.clientX, y: e.clientY };
    };

    const onMouseMove = (e: MouseEvent) => {
      if (!controls.isDragging || !cameraRef.current) return;

      const dx = e.clientX - controls.previousMousePosition.x;
      const dy = e.clientY - controls.previousMousePosition.y;

      controls.rotation.y += dx * 0.005;
      controls.rotation.x += dy * 0.005;
      controls.rotation.x = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, controls.rotation.x));

      controls.previousMousePosition = { x: e.clientX, y: e.clientY };
    };

    const onMouseUp = () => {
      controls.isDragging = false;
    };

    const onWheel = (e: WheelEvent) => {
      if (!cameraRef.current) return;
      e.preventDefault();
      controls.zoom *= 1 + e.deltaY * 0.001;
      controls.zoom = Math.max(0.1, Math.min(10, controls.zoom));
    };

    renderer.domElement.addEventListener('mousedown', onMouseDown);
    renderer.domElement.addEventListener('mousemove', onMouseMove);
    renderer.domElement.addEventListener('mouseup', onMouseUp);
    renderer.domElement.addEventListener('wheel', onWheel, { passive: false });
    controlsRef.current = controls;

    // Handle resize
    const handleResize = () => {
      const newWidth = container.clientWidth;
      const newHeight = container.clientHeight;
      if (newWidth > 0 && newHeight > 0) {
        camera.aspect = newWidth / newHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(newWidth, newHeight);
      }
    };

    window.addEventListener('resize', handleResize);

    // Animation loop
    let animationId: number;
    const animate = () => {
      animationId = requestAnimationFrame(animate);

      // Update camera position based on controls
      if (meshRef.current && cameraRef.current) {
        const bounds = computeModelBounds(voxels);
        const size = bounds.max.clone().sub(bounds.min);
        const maxDim = Math.max(size.x, size.y, size.z);
        const distance = maxDim * 1.5 * controlsRef.current.zoom;

        cameraRef.current.position.x = bounds.center.x + distance * Math.sin(controlsRef.current.rotation.y) * Math.cos(controlsRef.current.rotation.x);
        cameraRef.current.position.y = bounds.center.y + distance * Math.sin(controlsRef.current.rotation.x);
        cameraRef.current.position.z = bounds.center.z + distance * Math.cos(controlsRef.current.rotation.y) * Math.cos(controlsRef.current.rotation.x);
        cameraRef.current.lookAt(bounds.center.x, bounds.center.y, bounds.center.z);

        // Update directional light's shadow camera to follow object center
        const lightRef = sceneRef.current?.children.find((child) => child instanceof THREE.DirectionalLight) as THREE.DirectionalLight | undefined;
        if (lightRef) {
          lightRef.target.position.set(bounds.center.x, bounds.center.y, bounds.center.z);
          lightRef.target.updateMatrixWorld();
        }
      }

      renderer.render(scene, camera);
    };
    animate();

    return () => {
      window.removeEventListener('resize', handleResize);
      renderer.domElement.removeEventListener('mousedown', onMouseDown);
      renderer.domElement.removeEventListener('mousemove', onMouseMove);
      renderer.domElement.removeEventListener('mouseup', onMouseUp);
      renderer.domElement.removeEventListener('wheel', onWheel);
      cancelAnimationFrame(animationId);
      container.removeChild(renderer.domElement);
      renderer.dispose();
    };
  }, []);

  // Update voxels
  useEffect(() => {
    if (!sceneRef.current || !cameraRef.current) return;

    setVoxelCount(voxels.length);

    // Remove old mesh and edges
    if (meshRef.current) {
      sceneRef.current.remove(meshRef.current);
      meshRef.current.geometry.dispose();
      (meshRef.current.material as THREE.Material).dispose();
    }
    if (edgeLinesRef.current) {
      sceneRef.current.remove(edgeLinesRef.current);
      edgeLinesRef.current.geometry.dispose();
      (edgeLinesRef.current.material as THREE.Material).dispose();
      edgeLinesRef.current = null;
    }

    if (voxels.length === 0) return;

    // Compute bounds
    const bounds = computeModelBounds(voxels);
    const size = bounds.max.clone().sub(bounds.min);
    const maxDim = Math.max(size.x, size.y, size.z);

    // Create geometry for a unit cube
    const geometry = new THREE.BoxGeometry(1, 1, 1);

    // Create material with vertex colors
    const material = new THREE.MeshPhongMaterial({
      side: THREE.FrontSide,
      flatShading: true,
      shininess: 16,
    });

    // Create instanced mesh
    const instancedMesh = new THREE.InstancedMesh(geometry, material, voxels.length);
    instancedMesh.castShadow = true;
    instancedMesh.receiveShadow = true;

    // Set positions, rotations, scales, and colors
    const matrix = new THREE.Matrix4();
    const color = new THREE.Color();

    voxels.forEach((voxel, i) => {
      const [px, py, pz] = voxel.position ?? [0, 0, 0];
      const size = (Number.isFinite(voxel.size) ? voxel.size : 1) || 1;
      const [r, g, b] = voxel.color ?? [0.55, 0.55, 0.6];

      matrix.identity();
      matrix.setPosition(px, py, pz);

      if (voxel.quaternion) {
        const [x, y, z, w] = voxel.quaternion;
        const quat = new THREE.Quaternion(x, y, z, w);
        matrix.makeRotationFromQuaternion(quat);
        matrix.setPosition(px, py, pz);
      }

      matrix.scale(new THREE.Vector3(size, size, size));

      instancedMesh.setMatrixAt(i, matrix);

      const ch = (v: number) => {
        const u = Number(v);
        if (!Number.isFinite(u)) return 0.5;
        return Math.max(0, Math.min(1, u));
      };
      color.setRGB(ch(r), ch(g), ch(b));
      instancedMesh.setColorAt(i, color);
    });

    instancedMesh.instanceMatrix.needsUpdate = true;
    if (instancedMesh.instanceColor) {
      instancedMesh.instanceColor.needsUpdate = true;
    }

    sceneRef.current.add(instancedMesh);
    meshRef.current = instancedMesh;

    // Build merged edge lines (12 edges × 2 endpoints per voxel)
    // Unit cube edge template: each pair of vertices is one edge
    const EDGE_TMPL = new Float32Array([
      // Bottom face
      -0.5,-0.5,-0.5,  0.5,-0.5,-0.5,
       0.5,-0.5,-0.5,  0.5,-0.5, 0.5,
       0.5,-0.5, 0.5, -0.5,-0.5, 0.5,
      -0.5,-0.5, 0.5, -0.5,-0.5,-0.5,
      // Top face
      -0.5, 0.5,-0.5,  0.5, 0.5,-0.5,
       0.5, 0.5,-0.5,  0.5, 0.5, 0.5,
       0.5, 0.5, 0.5, -0.5, 0.5, 0.5,
      -0.5, 0.5, 0.5, -0.5, 0.5,-0.5,
      // Vertical edges
      -0.5,-0.5,-0.5, -0.5, 0.5,-0.5,
       0.5,-0.5,-0.5,  0.5, 0.5,-0.5,
       0.5,-0.5, 0.5,  0.5, 0.5, 0.5,
      -0.5,-0.5, 0.5, -0.5, 0.5, 0.5,
    ]); // 24 verts × 3 = 72 floats
    const VERTS_PER_VOXEL = 24;
    const allEdgeVerts = new Float32Array(voxels.length * VERTS_PER_VOXEL * 3);

    const ePos = new THREE.Vector3();
    const eQuat = new THREE.Quaternion();
    const eScale = new THREE.Vector3();
    const eMat = new THREE.Matrix4();
    const eVec = new THREE.Vector3();

    voxels.forEach((voxel, i) => {
      const [px, py, pz] = voxel.position ?? [0, 0, 0];
      const s = (Number.isFinite(voxel.size) ? voxel.size : 1) || 1;
      ePos.set(px, py, pz);
      if (voxel.quaternion) {
        const [qx, qy, qz, qw] = voxel.quaternion;
        eQuat.set(qx, qy, qz, qw);
      } else {
        eQuat.identity();
      }
      eScale.set(s, s, s);
      eMat.compose(ePos, eQuat, eScale);

      const base = i * VERTS_PER_VOXEL * 3;
      for (let j = 0; j < VERTS_PER_VOXEL; j++) {
        eVec.set(EDGE_TMPL[j * 3], EDGE_TMPL[j * 3 + 1], EDGE_TMPL[j * 3 + 2]);
        eVec.applyMatrix4(eMat);
        allEdgeVerts[base + j * 3]     = eVec.x;
        allEdgeVerts[base + j * 3 + 1] = eVec.y;
        allEdgeVerts[base + j * 3 + 2] = eVec.z;
      }
    });

    const edgeGeo = new THREE.BufferGeometry();
    edgeGeo.setAttribute('position', new THREE.BufferAttribute(allEdgeVerts, 3));
    const edgeMat = new THREE.LineBasicMaterial({
      color: 0x000000,
      transparent: true,
      opacity: 0.25,
      depthTest: true,
    });
    const edgeLines = new THREE.LineSegments(edgeGeo, edgeMat);
    sceneRef.current.add(edgeLines);
    edgeLinesRef.current = edgeLines;

    // Update camera far plane based on model size
    cameraRef.current.far = maxDim * 10;
    cameraRef.current.updateProjectionMatrix();
  }, [voxels]);

  return (
    <div className={styles.container} ref={containerRef}>
      <div className={styles.info}>
        <div className={styles.infoLabel}>{voxelCount.toLocaleString()} voxels</div>
      </div>

      {isLoading && (
        <div className={`${styles.overlay} ${styles.overlayActive}`}>
          <div className={styles.progressHub}>
            <div className={styles.spinnerRing}>
              <div className={styles.spinner} />
            </div>
            <div className={styles.progressLabel}>
              <span className={styles.progressValue}>{Math.round(progress)}%</span>
              <span className={styles.progressText}>Generating voxels…</span>
            </div>
          </div>

          <div className={styles.bottomBar}>
            <div className={styles.barFill} style={{ width: `${progress}%` }} />
            <div className={styles.barGlow} style={{ left: `${Math.max(0, progress - 5)}%` }} />
          </div>
        </div>
      )}
    </div>
  );
}
