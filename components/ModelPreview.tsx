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

        geometry.computeBoundingBox();
        const bbox = geometry.boundingBox!;
        const boundingMin: [number, number, number] = [bbox.min.x, bbox.min.y, bbox.min.z];
        const boundingMax: [number, number, number] = [bbox.max.x, bbox.max.y, bbox.max.z];

        const colorAttr = geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
        const existingColors = colorAttr
          ? (new Float32Array(colorAttr.array as ArrayLike<number>))
          : null;

        const posArray = new Float32Array(pos.array as ArrayLike<number>);
        const colors = await buildPreviewVertexColorsAsync(
          posArray,
          boundingMin,
          boundingMax,
          existingColors
        );

        if (!isMounted || !m) return;

        renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        renderer.setSize(w, h);
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        renderer.setClearColor(0x000000, 0);
        m.appendChild(renderer.domElement);

        const scene = new THREE.Scene();

        const geo = geometry.clone();
        geo.computeBoundingBox();
        const center = new THREE.Vector3();
        geo.boundingBox!.getCenter(center);
        geo.translate(-center.x, -center.y, -center.z);

        geo.computeBoundingBox();
        const size = new THREE.Vector3();
        geo.boundingBox!.getSize(size);
        const maxDim = Math.max(size.x, size.y, size.z);
        if (maxDim > 0) {
          const s = 2 / maxDim;
          geo.scale(s, s, s);
        }

        if (!geo.getAttribute('normal')) geo.computeVertexNormals();

        geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

        const material = new THREE.MeshPhongMaterial({
          side: THREE.DoubleSide,
          vertexColors: true,
          shininess: 100,
          specular: 0x333333,
          emissive: 0x0a0a0a,
          color: 0xcccccc,
        });

        const mesh = new THREE.Mesh(geo, material);
        scene.add(mesh);

        const wfMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.03 });
        scene.add(new THREE.LineSegments(new THREE.WireframeGeometry(geo), wfMat));

        scene.add(new THREE.AmbientLight(0xffffff, 0.35));

        const dl1 = new THREE.DirectionalLight(0xffffff, 1.1);
        dl1.position.set(5, 6, 5);
        scene.add(dl1);

        const dl2 = new THREE.DirectionalLight(0xff6b9d, 0.6);
        dl2.position.set(-4, 3, -5);
        scene.add(dl2);

        const dl3 = new THREE.DirectionalLight(0x00d4ff, 0.5);
        dl3.position.set(3, -4, 4);
        scene.add(dl3);

        const camera = new THREE.PerspectiveCamera(40, w / h, 0.01, 100);
        const radius = 3.5;
        let angle = 0;

        const animate = () => {
          animId = requestAnimationFrame(animate);
          angle += 0.008;
          camera.position.set(Math.sin(angle) * radius, 1.3, Math.cos(angle) * radius);
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
