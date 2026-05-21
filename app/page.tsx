'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import styles from './page.module.css';
import { parseModelFile, voxelizeGeometryAsync, calibrateGapSizeRatio, measureVoxelOverlap } from '@/lib/voxelizer';

const VoxelViewer = dynamic(() => import('@/components/VoxelViewer'), { ssr: false });
const ModelPreview = dynamic(() => import('@/components/ModelPreview'), {
  ssr: false,
  loading: () => <div className={styles.previewLoading}>Loading…</div>,
});

type Theme = 'dark' | 'light';
type Stage = 'source' | 'model' | 'voxelize' | 'export';

const SNAP_DISTANCE = 120;

function useDraggableWithSnap(
  initial: { x: number; y: number },
  snapTarget?: { current: { ref: React.RefObject<HTMLDivElement>; pos: { x: number; y: number } } }
) {
  const [pos, setPos] = useState(initial);
  const [isSnapped, setIsSnapped] = useState(false);
  const [isNearSnapZone, setIsNearSnapZone] = useState(false);
  const [showSnapGlow, setShowSnapGlow] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const glowTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const r = useRef({
    dragging: false,
    ox: 0,
    oy: 0,
    x: initial.x,
    y: initial.y,
    snapped: false,
    nearSnapZone: false
  });

  const onDragStart = useCallback((e: React.MouseEvent) => {
    r.current.dragging = true;
    r.current.ox = e.clientX - r.current.x;
    r.current.oy = e.clientY - r.current.y;
    e.preventDefault();
  }, []);

  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (!r.current.dragging) return;

      const mouseX = e.clientX - r.current.ox;
      const mouseY = e.clientY - r.current.oy;

      if (snapTarget?.current && snapTarget.current.ref.current) {
        const targetPos = snapTarget.current.pos;
        const targetEl = snapTarget.current.ref.current;
        const targetRect = targetEl.getBoundingClientRect();
        const targetHeight = targetRect.height;

        const snapX = targetPos.x;
        const snapY = targetPos.y + targetHeight + 16;

        const dx = mouseX - snapX;
        const dy = mouseY - snapY;
        const distance = Math.sqrt(dx * dx + dy * dy);

        // Show preview when near snap zone (but not snapped yet)
        if (distance < SNAP_DISTANCE && !r.current.snapped) {
          r.current.nearSnapZone = true;
          setIsNearSnapZone(true);
          // Follow mouse, show preview
          r.current.x = mouseX;
          r.current.y = mouseY;
        } else {
          r.current.nearSnapZone = false;
          setIsNearSnapZone(false);
          r.current.x = mouseX;
          r.current.y = mouseY;
        }
      } else {
        r.current.x = mouseX;
        r.current.y = mouseY;
      }

      setPos({ x: r.current.x, y: r.current.y });
    };

    const up = (e: MouseEvent) => {
      // On mouseup, if near snap zone, snap it
      if (r.current.nearSnapZone && snapTarget?.current && snapTarget.current.ref.current) {
        const targetPos = snapTarget.current.pos;
        const targetEl = snapTarget.current.ref.current;
        const targetRect = targetEl.getBoundingClientRect();
        const targetHeight = targetRect.height;

        r.current.snapped = true;
        r.current.x = targetPos.x;
        r.current.y = targetPos.y + targetHeight + 16;
        setIsSnapped(true);
        setIsNearSnapZone(false);
        setShowSnapGlow(true);

        // Clear previous timeout if exists
        if (glowTimeoutRef.current) {
          clearTimeout(glowTimeoutRef.current);
        }

        // Fade out glow after 1.5 seconds
        glowTimeoutRef.current = setTimeout(() => {
          setShowSnapGlow(false);
        }, 1500);
      }
      r.current.dragging = false;
    };

    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      if (glowTimeoutRef.current) {
        clearTimeout(glowTimeoutRef.current);
      }
    };
  }, [snapTarget]);

  // When snapped, track target position changes
  useEffect(() => {
    if (!isSnapped || !snapTarget?.current) return;

    const interval = setInterval(() => {
      if (snapTarget.current?.ref.current && r.current.snapped) {
        const targetPos = snapTarget.current.pos;
        const targetEl = snapTarget.current.ref.current;
        const targetRect = targetEl.getBoundingClientRect();
        const targetHeight = targetRect.height;

        r.current.x = targetPos.x;
        r.current.y = targetPos.y + targetHeight + 16;
        setPos({ x: r.current.x, y: r.current.y });
      }
    }, 16);

    return () => clearInterval(interval);
  }, [isSnapped, snapTarget]);

  return { pos, onDragStart, ref, isSnapped, isNearSnapZone, showSnapGlow };
}

export default function Home() {
  const [theme, setTheme] = useState<Theme>('dark');
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const saved = (localStorage.getItem('theme') as Theme) || 'dark';
    setTheme(saved);
    setMounted(true);
  }, []);

  useEffect(() => {
    if (mounted) localStorage.setItem('theme', theme);
  }, [theme, mounted]);

  const [file, setFile] = useState<File | null>(null);
  const [parsedGeometry, setParsedGeometry] = useState<any>(null);
  const [meshInfo, setMeshInfo] = useState<{ meshCount?: number; vertexCount?: number }>({});
  const [voxels, setVoxels] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [parseLoading, setParseLoading] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [showVoxels, setShowVoxels] = useState(false);
  const [progress, setProgress] = useState(0);
  const [generateDone, setGenerateDone] = useState(false);

  const [targetBlocks, setTargetBlocks] = useState(250);
  const [overlapTarget, setOverlapTarget] = useState(15);
  const [measuredOverlap, setMeasuredOverlap] = useState<number | null>(null);
  const [surfaceVoxels, setSurfaceVoxels] = useState(true);
  const [interiorFill, setInteriorFill] = useState(true);
  const [curvedVoxels, setCurvedVoxels] = useState(true);
  const [gapSizeRatio, setGapSizeRatio] = useState(1.58);
  const [isHeavyModel, setIsHeavyModel] = useState(false);
  const targetBlocksTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const sourceCard = useDraggableWithSnap({ x: 24, y: 80 });
  const sourceCardRef = useRef({ ref: sourceCard.ref, pos: sourceCard.pos });

  useEffect(() => {
    sourceCardRef.current.pos = sourceCard.pos;
  }, [sourceCard.pos]);

  const paramCard = useDraggableWithSnap({ x: 340, y: 80 }, sourceCardRef);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0];
    if (!selected) return;
    setFile(selected);
    setError('');
    setVoxels([]);
    setShowVoxels(false);
    setParsedGeometry(null);
    setMeshInfo({});
    setParseLoading(true);
    setGenerateDone(false);
    setStatus('Parsing model…');
    try {
      const parsed = await parseModelFile(selected);

      // Detect if model is heavy (>100k vertices)
      const posAttr = parsed.geometry.getAttribute('position');
      const vertexCount = posAttr ? posAttr.count : 0;
      const heavy = vertexCount > 100000;
      setIsHeavyModel(heavy);

      // Store mesh information
      setMeshInfo({
        meshCount: parsed.meshCount,
        vertexCount: parsed.vertexCount
      });

      setParsedGeometry(parsed.geometry);
      setStatus(heavy ? '⚠️ Heavy model - auto-update disabled' : '');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to parse model');
      setStatus('');
    } finally {
      setParseLoading(false);
    }
  };

  // Auto-generate preview when target blocks or overlap target changes (if not heavy model)
  useEffect(() => {
    if (!parsedGeometry || isHeavyModel) return;

    // Clear previous timeout
    if (targetBlocksTimeoutRef.current) {
      clearTimeout(targetBlocksTimeoutRef.current);
    }

    // Debounce: wait 300ms after user stops adjusting
    targetBlocksTimeoutRef.current = setTimeout(() => {
      const generatePreview = async () => {
        setLoading(true);
        setError('');
        setStatus('Calibrating… (binary search in progress)');
        setProgress(5); // Show something is happening
        try {
          // Calibrate gapSizeRatio for optimal overlap
          const optimalRatio = await calibrateGapSizeRatio(
            parsedGeometry,
            targetBlocks,
            { surface: surfaceVoxels, interior: interiorFill, curvedVoxels },
            overlapTarget,
            (p) => setProgress(Math.max(5, Math.min(95, p)))
          );
          setGapSizeRatio(optimalRatio);

          // Generate with optimal ratio
          setStatus('Rendering preview…');
          setProgress(96);
          const result = await voxelizeGeometryAsync(
            parsedGeometry, targetBlocks,
            { surface: surfaceVoxels, interior: interiorFill, curvedVoxels, gapSizeRatio: optimalRatio }
          );
          let list = Array.isArray(result) ? result : [];
          // Auto-remove interior voxels, keep only surface
          list = list.filter(v => v.type !== 'interior');
          setVoxels(list);

          // Calculate actual measured overlap
          if (parsedGeometry && list.length > 0) {
            parsedGeometry.computeBoundingBox();
            const bbox = parsedGeometry.boundingBox!;
            const sizeX = bbox.max.x - bbox.min.x;
            const sizeY = bbox.max.y - bbox.min.y;
            const sizeZ = bbox.max.z - bbox.min.z;
            const maxDim = Math.max(sizeX, sizeY, sizeZ);
            const baseVoxelSize = maxDim / Math.cbrt(targetBlocks);
            const actualOverlap = measureVoxelOverlap(list, baseVoxelSize);
            setMeasuredOverlap(actualOverlap);
          }

          setStatus(`Preview: ${list.length} voxels (gap ratio: ${optimalRatio.toFixed(3)})`);
          setShowVoxels(true);
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Error voxelizing');
          setStatus('');
        } finally {
          setLoading(false);
          setProgress(0);
        }
      };
      generatePreview();
    }, 300);

    return () => {
      if (targetBlocksTimeoutRef.current) {
        clearTimeout(targetBlocksTimeoutRef.current);
      }
    };
  }, [targetBlocks, overlapTarget, parsedGeometry, isHeavyModel, surfaceVoxels, interiorFill, curvedVoxels]);

  const handlePreview = async () => {
    if (!parsedGeometry) return;
    setLoading(true);
    setError('');
    setStatus('Voxelizing (quick preview)…');
    try {
      const result = await voxelizeGeometryAsync(
        parsedGeometry, Math.min(targetBlocks, 1000),
        { surface: surfaceVoxels, interior: interiorFill, curvedVoxels, gapSizeRatio }
      );
      const list = Array.isArray(result) ? result : [];
      setVoxels(list);
      const mode = [];
      if (surfaceVoxels) mode.push('Surface');
      if (interiorFill) mode.push('Interior');
      setStatus(`Preview: ${list.length} voxels (${mode.join(' + ') || 'None'})`);
      setShowVoxels(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error voxelizing');
      setStatus('');
    } finally {
      setLoading(false);
    }
  };

  const handleGenerate = async () => {
    if (!parsedGeometry) return;
    setLoading(true);
    setError('');
    setProgress(0);
    setStatus('Calibrating gap size ratio…');
    try {
      // Step 1: Calibrate gapSizeRatio for optimal overlap
      const optimalRatio = await calibrateGapSizeRatio(
        parsedGeometry,
        targetBlocks,
        { surface: surfaceVoxels, interior: interiorFill, curvedVoxels },
        overlapTarget,
        (p) => setProgress(Math.max(0, Math.min(30, p)))
      );
      setGapSizeRatio(optimalRatio);

      // Step 2: Generate with optimal ratio
      setStatus('Generating voxels with optimized settings…');
      setProgress(30);
      const result = await voxelizeGeometryAsync(
        parsedGeometry, targetBlocks,
        { surface: surfaceVoxels, interior: interiorFill, curvedVoxels, gapSizeRatio: optimalRatio },
        (p) => setProgress(30 + Math.max(0, Math.min(70, p)))
      );
      let list = Array.isArray(result) ? result : [];
      // Auto-remove interior voxels, keep only surface
      list = list.filter(v => v.type !== 'interior');
      setVoxels(list);

      // Calculate actual measured overlap
      if (parsedGeometry && list.length > 0) {
        parsedGeometry.computeBoundingBox();
        const bbox = parsedGeometry.boundingBox!;
        const sizeX = bbox.max.x - bbox.min.x;
        const sizeY = bbox.max.y - bbox.min.y;
        const sizeZ = bbox.max.z - bbox.min.z;
        const maxDim = Math.max(sizeX, sizeY, sizeZ);
        const baseVoxelSize = maxDim / Math.cbrt(targetBlocks);
        const actualOverlap = measureVoxelOverlap(list, baseVoxelSize);
        setMeasuredOverlap(actualOverlap);
      }

      setStatus(`Generated: ${list.length.toLocaleString()} surface voxels (gap ratio: ${optimalRatio.toFixed(3)})`);
      setShowVoxels(true);
      setGenerateDone(true);
      setTimeout(() => setGenerateDone(false), 2200);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error voxelizing');
      setStatus('');
    } finally {
      setLoading(false);
      setProgress(0);
    }
  };


  const handleExport = () => {
    if (!voxels.length) return;

    const rgbToHex = (rgb: number[]): string => {
      const r = Math.round(Math.max(0, Math.min(1, rgb[0] || 0)) * 255);
      const g = Math.round(Math.max(0, Math.min(1, rgb[1] || 0)) * 255);
      const b = Math.round(Math.max(0, Math.min(1, rgb[2] || 0)) * 255);
      return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
    };

    const radToDeg = (rad: number): number => (rad * 180) / Math.PI;

    const voxelsByColor = new Map<string, any[]>();

    voxels.forEach((v, i) => {
      const color = rgbToHex(v.color || []);
      const formatted = {
        id: `voxel_${Date.now()}_${i}`,
        position: {
          x: v.position?.[0] ?? 0,
          y: v.position?.[1] ?? 0,
          z: v.position?.[2] ?? 0,
        },
        size: {
          w: v.size ?? 1,
          h: v.size ?? 1,
          l: v.size ?? 1,
        },
        type: v.type || 'surface',
        normal: v.normal || [0, 0, 0],
        curvature: v.curvature ?? 0,
        rotationX: radToDeg(v.rotation?.[0] ?? 0),
        rotationY: radToDeg(v.rotation?.[1] ?? 0),
        rotationZ: radToDeg(v.rotation?.[2] ?? 0),
      };

      if (!voxelsByColor.has(color)) {
        voxelsByColor.set(color, []);
      }
      voxelsByColor.get(color)!.push(formatted);
    });

    const colorGroups = Array.from(voxelsByColor.entries()).map(([color, voxels]) => ({
      color,
      count: voxels.length,
      voxels,
    }));

    const output = {
      version: '1.0',
      totalVoxels: voxels.length,
      colorCount: colorGroups.length,
      colors: colorGroups,
    };

    const blob = new Blob([JSON.stringify(output, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `voxels_${voxels.length}_blocks.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const canAct = !!parsedGeometry && !loading && !parseLoading;
  const busy = loading || parseLoading;
  const stage: Stage = voxels.length > 0 ? 'export' : parsedGeometry ? 'voxelize' : file ? 'model' : 'source';
  const crumbs: { id: Stage; label: string }[] = [
    { id: 'source', label: 'SOURCE' },
    { id: 'model', label: 'MODEL' },
    { id: 'voxelize', label: 'VOXELIZE' },
    { id: 'export', label: 'EXPORT' },
  ];

  return (
    <div className={styles.container} data-theme={theme}>

      {/* ── Full-screen 3D viewport ── */}
      <div className={styles.viewport}>
        {showVoxels && voxels.length > 0 ? (
          <VoxelViewer voxels={voxels} progress={progress} isLoading={loading} />
        ) : (
          <div className={styles.viewportEmpty}>
            <div className={styles.viewportIcon}>◇</div>
            <div className={styles.viewportTitle}>Voxel Viewport</div>
            <div className={styles.viewportHint}>Upload a model and press Generate to begin</div>
          </div>
        )}
      </div>

      {/* ── Top bar ── */}
      <header className={styles.topbar}>
        <div className={styles.brand}>
          Voxelizer
          <span className={styles.brandTag}>web</span>
        </div>
        <nav className={styles.crumbs}>
          {crumbs.map((c) => (
            <span key={c.id} className={`${styles.crumb} ${c.id === stage ? styles.crumbActive : ''}`}>
              {c.label}
            </span>
          ))}
        </nav>
        <div className={styles.spacer} />
        <Link href="/panel" className={styles.panelLink}>Panel Surface →</Link>
        <button
          onClick={() => setTheme(t => t === 'dark' ? 'light' : 'dark')}
          className={styles.themeToggle}
          title="Toggle theme"
        >
          {theme === 'dark' ? '☀️' : '🌙'}
        </button>
        <div className={styles.topStatus}>
          <span className={styles.statusPill}>
            <span className={`${styles.dot} ${busy ? styles.dotBusy : !parsedGeometry ? styles.dotIdle : ''}`} />
            {busy ? 'Working' : parsedGeometry ? 'Ready' : 'Idle'}
          </span>
          {voxels.length > 0 && (
            <span className={styles.statusPill}>{voxels.length.toLocaleString()} voxels</span>
          )}
        </div>
      </header>

      {/* ── Source Model card (always visible, draggable) ── */}
      <div
        ref={sourceCard.ref}
        className={styles.cardOuter}
        style={{ transform: `translate(${sourceCard.pos.x}px, ${sourceCard.pos.y}px)` }}
      >
        <div className={`${styles.floatCard} ${styles.glassAppear}`}>
          <div className={styles.cardHandle} onMouseDown={sourceCard.onDragStart}>
            <span className={styles.cardTitle}>Source Model</span>
            <span className={styles.dragDots}>⠿</span>
          </div>
          <div className={styles.cardBody}>
            <div className={styles.dropzone}>
              <div className={styles.dropzoneIcon}>↑</div>
              <div className={styles.dropzoneTitle}>Drop or click to upload</div>
              <div className={styles.dropzoneDesc}>Convert a 3D mesh into voxels</div>
              <div className={styles.dropzoneTypes}>
                <span>GLB</span><span>OBJ</span><span>STL</span><span>GLTF</span><span>FBX</span>
              </div>
              <input
                type="file"
                accept=".glb,.obj,.stl,.gltf,.fbx"
                onChange={handleFileChange}
                className={styles.fileInput}
              />
            </div>
            {file && (
              <>
                <div className={styles.fileName} title={file.name}>{file.name}</div>
                {meshInfo.meshCount !== undefined && (
                  <div style={{ fontSize: '12px', color: 'rgba(255, 255, 255, 0.6)', marginTop: '8px', display: 'flex', gap: '16px' }}>
                    <span>📦 Meshes: {meshInfo.meshCount}</span>
                    <span>🔷 Vertices: {meshInfo.vertexCount?.toLocaleString()}</span>
                  </div>
                )}
              </>
            )}
            {parseLoading && (
              <div className={styles.cardStatus}>
                <span className={styles.spinnerDots}><i /><i /><i /></span>
                Parsing model…
              </div>
            )}
            {error && <div className={styles.cardError}>{error}</div>}
          </div>
        </div>
      </div>

      {/* ── Parameters + Mesh Preview card (appears when model is loaded) ── */}
      {parsedGeometry && (
        <div
          ref={paramCard.ref}
          className={`${styles.cardOuter} ${paramCard.showSnapGlow ? styles.cardSnapped : ''} ${paramCard.isNearSnapZone ? styles.cardNearSnap : ''}`}
          style={{ transform: `translate(${paramCard.pos.x}px, ${paramCard.pos.y}px)` }}
        >
          <div className={`${styles.floatCard} ${styles.floatCardWide} ${styles.glassCondense}`}>
            <div className={styles.cardHandle} onMouseDown={paramCard.onDragStart}>
              <span className={styles.cardTitle}>Parameters</span>
              <span className={styles.dragDots}>⠿</span>
            </div>
            <div className={styles.cardBody}>

              {/* Mesh preview */}
              <div className={styles.previewWrap}>
                <ModelPreview geometry={parsedGeometry} />
              </div>

              {/* Parameters */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', fontSize: '13px', marginTop: '12px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <label style={{ whiteSpace: 'nowrap', marginRight: '8px' }}>Overlap Target:</label>
                  <input
                    type="range"
                    min="1"
                    max="30"
                    step="1"
                    value={overlapTarget}
                    onChange={(e) => setOverlapTarget(parseInt(e.target.value))}
                    style={{ flex: 1, marginRight: '8px' }}
                  />
                  <span style={{ minWidth: '40px', textAlign: 'right' }}>{overlapTarget}%</span>
                </div>
                <div style={{ fontSize: '12px', color: 'rgba(255, 255, 255, 0.5)', display: 'flex', justifyContent: 'space-between', gap: '8px' }}>
                  <span>Gap Ratio: {gapSizeRatio.toFixed(3)}</span>
                  <span>{isHeavyModel ? '⚠️ Heavy model - use Generate' : 'Auto-update: ON'}</span>
                </div>
                {measuredOverlap !== null && (
                  <div style={{ fontSize: '12px', color: 'rgba(100, 200, 255, 0.8)', marginTop: '4px' }}>
                    📊 Actual overlap: {measuredOverlap.toFixed(2)}% (target: {overlapTarget}%)
                  </div>
                )}
              </div>

              {/* Status / progress */}
              {status && !loading && (
                <div className={voxels.length > 0 ? styles.cardInfo : styles.cardStatus}>
                  {status}
                </div>
              )}
              {loading && progress > 0 && (
                <div className={styles.progressContainer}>
                  <div className={styles.progressBar}>
                    <div className={styles.progressFill} style={{ width: `${progress}%` }} />
                  </div>
                  <span className={styles.progressText}>{Math.round(progress)}%</span>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Bottom bar: HUD hints + Generate button ── */}
      <div className={styles.bottomBar}>
        {parsedGeometry && (
          <div className={styles.bottomSliderSection}>
            <label className={styles.sliderLabel}>Target blocks: <span className={styles.sliderValue}>{targetBlocks}</span></label>
            <div className={styles.sliderWide}>
              <div className={styles.slider} style={{ '--val': `${((targetBlocks - 10) / (2000 - 10)) * 100}%` } as any}>
                <div className={styles.sliderTrack} />
                <div className={styles.sliderFill} />
                <div
                  className={styles.sliderThumb}
                  onMouseDown={(e) => {
                    const slider = e.currentTarget.closest(`.${styles.slider}`);
                    const rect = slider!.getBoundingClientRect();
                    const handleMove = (move: MouseEvent) => {
                      const x = move.clientX - rect.left;
                      const percent = Math.max(0, Math.min(1, x / rect.width));
                      const newVal = Math.round(10 + percent * (2000 - 10));
                      setTargetBlocks(newVal);
                    };
                    const handleUp = () => {
                      document.removeEventListener('mousemove', handleMove);
                      document.removeEventListener('mouseup', handleUp);
                    };
                    document.addEventListener('mousemove', handleMove);
                    document.addEventListener('mouseup', handleUp);
                  }}
                />
              </div>
              <input
                type="number"
                min="10"
                value={targetBlocks}
                onChange={e => { const v = parseInt(e.target.value); if (!isNaN(v)) setTargetBlocks(Math.max(10, v)); }}
                className={styles.sliderInput}
              />
            </div>
          </div>
        )}

        <div className={styles.bottomControls}>
          <div className={styles.hudPill}>
            <span className={styles.kbd}>Drag</span>
            orbit
            <span className={styles.hudSep} />
            <span className={styles.kbd}>Scroll</span>
            zoom
          </div>

          {parsedGeometry && (
            <div className={styles.bottomButtons}>
              {voxels.length > 0 && (
                <button onClick={handleExport} className={`${styles.generateBtn} ${styles.secondaryBtn}`}>
                  Export JSON
                </button>
              )}
              <button
                onClick={handleGenerate}
                disabled={!canAct}
                className={`${styles.generateBtn} ${generateDone ? styles.generateDone : ''} ${loading ? styles.generateLoading : ''}`}
              >
                <span className={styles.generateBtnInner}>
                  {loading ? (
                    <><span className={styles.spinnerDots}><i /><i /><i /></span>&nbsp;Generating</>
                  ) : generateDone ? (
                    <>✓&nbsp;Done</>
                  ) : (
                    'Generate'
                  )}
                </span>
              </button>
            </div>
          )}

          <div className={styles.hudPill}>
            <b>Voxelizer</b>&nbsp;Spatial Glass
          </div>
        </div>
      </div>

    </div>
  );
}
