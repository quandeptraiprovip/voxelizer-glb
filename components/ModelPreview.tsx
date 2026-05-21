'use client';

import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { buildPreviewVertexColorsAsync } from '@/lib/preview-colors';

interface ModelPreviewProps {
  geometry: THREE.BufferGeometry;
  width?: number;
  height?: number;
}

export default function ModelPreview({ geometry, width = 300, height = 160 }: ModelPreviewProps) {
  const mountRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const m = mountRef.current;
    if (!m || !geometry) return;

    let isMounted = true;
    let renderer: THREE.WebGLRenderer | null = null;
    let animId: number | null = null;

    async function initPreview() {
      try {
        if (!m) return;
        const w = m.clientWidth || width;
        const h = m.clientHeight || height;

        const pos = geometry.getAttribute('position') as THREE.BufferAttribute;
        if (!pos) {
          console.error('Geometry missing position attribute');
          return;
        }

        const colorAttr = geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
        const existingColors = colorAttr
          ? (new Float32Array(colorAttr.array as ArrayLike<number>))
          : null;

        if (existingColors && existingColors.length > 0) {
          const sample = [
            [existingColors[0], existingColors[1], existingColors[2]],
            [existingColors[3], existingColors[4], existingColors[5]],
            [existingColors[Math.min(6, existingColors.length - 3)], existingColors[Math.min(7, existingColors.length - 2)], existingColors[Math.min(8, existingColors.length - 1)]],
          ];

          // Don't use Math.min(...array) with 776k+ elements - causes stack overflow
          // Use loop instead for large arrays
          let minColor = existingColors[0];
          let maxColor = existingColors[0];
          for (let i = 1; i < existingColors.length; i++) {
            if (existingColors[i] < minColor) minColor = existingColors[i];
            if (existingColors[i] > maxColor) maxColor = existingColors[i];
          }

          const allWhite = existingColors.every((v) => Math.abs(v - 1) < 0.01);
          const allZero = existingColors.every((v) => Math.abs(v) < 0.01);

          console.log('[ModelPreview] ✓ Geometry HAS vertex colors:', `${pos.count} vertices`);
          console.log('[ModelPreview] Color range:', minColor.toFixed(2), '-', maxColor.toFixed(2));
          console.log('[ModelPreview] Sample colors:', sample.map(rgb => ({r: rgb[0].toFixed(2), g: rgb[1].toFixed(2), b: rgb[2].toFixed(2)})));
          console.log('[ModelPreview] All white?', allWhite, '| All black?', allZero);
        } else {
          console.log('[ModelPreview] ✗ Geometry has NO vertex colors');
        }

        if (!isMounted || !m) return;

        renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        renderer.setSize(w, h);
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        renderer.setClearColor(0x000000, 0);
        m.appendChild(renderer.domElement);

        const scene = new THREE.Scene();

        const geo = geometry;

        const useVertexColorsFlag = existingColors ? true : false;
        console.log('[ModelPreview] Creating material with vertexColors:', useVertexColorsFlag);

        const material = new THREE.MeshPhongMaterial({
          side: THREE.DoubleSide,
          vertexColors: useVertexColorsFlag,
          shininess: 30,  // Reduced for more color visibility
          specular: 0x1a1a1a,  // Reduced specular highlight
          emissive: 0x0a0a0a,
          color: 0xffffff,
        });

        console.log('[ModelPreview] Material config:', {
          vertexColors: material.vertexColors,
          color: material.color.getHexString(),
          emissive: material.emissive.getHexString(),
        });

        const mesh = new THREE.Mesh(geo, material);

        // Center geometry and calculate bounds
        geo.computeBoundingBox();
        const bbox = geo.boundingBox;
        if (bbox) {
          const center = bbox.getCenter(new THREE.Vector3());
          const size = bbox.getSize(new THREE.Vector3());
          const maxDim = Math.max(size.x, size.y, size.z);

          // Center the geometry at origin
          geo.translate(-center.x, -center.y, -center.z);

          // Store the camera distance needed to view the object
          const cameraDistance = maxDim / (2 * Math.tan((40 * Math.PI) / (2 * 180)));
          mesh.userData.cameraDistance = Math.max(cameraDistance * 1.2, 2);
        }

        scene.add(mesh);
        console.log('[ModelPreview] ✓ Mesh added to scene');

        const wfMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.03 });
        scene.add(new THREE.LineSegments(new THREE.WireframeGeometry(geo), wfMat));

        // Increased ambient light to make colors more visible
        scene.add(new THREE.AmbientLight(0xffffff, 0.6));

        const dl1 = new THREE.DirectionalLight(0xffffff, 1.2);
        dl1.position.set(5, 6, 5);
        scene.add(dl1);

        const dl2 = new THREE.DirectionalLight(0xff6b9d, 0.4);
        dl2.position.set(-4, 3, -5);
        scene.add(dl2);

        const dl3 = new THREE.DirectionalLight(0x00d4ff, 0.3);
        dl3.position.set(3, -4, 4);
        scene.add(dl3);

        const radius = mesh.userData.cameraDistance || 3.5;
        const camera = new THREE.PerspectiveCamera(40, w / h, 0.01, radius * 10);
        let angle = 0;

        const animate = () => {
          animId = requestAnimationFrame(animate);
          angle += 0.008;
          camera.position.set(Math.sin(angle) * radius, radius * 0.4, Math.cos(angle) * radius);
          camera.lookAt(0, 0, 0);
          renderer!.render(scene, camera);
        };
        animate();
      } catch (err) {
        console.error('Failed to process geometry:', err);
      }
    }

    initPreview();

    return () => {
      isMounted = false;
      if (animId !== null) cancelAnimationFrame(animId);
      if (renderer) {
        renderer.dispose();
        const mountEl = mountRef.current;
        if (mountEl && mountEl.contains(renderer.domElement)) {
          mountEl.removeChild(renderer.domElement);
        }
      }
    };
  }, [geometry, width, height]);

  return (
    <div
      ref={mountRef}
      style={{ width: '100%', height: `${height}px`, overflow: 'hidden', background: 'transparent' }}
    />
  );
}
