'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import styles from './page.module.css';
import { parseModelFile, voxelizeGeometryAsync } from '@/lib/voxelizer';

const VoxelViewer = dynamic(() => import('@/components/VoxelViewer'), { ssr: false });
const ModelPreview = dynamic(() => import('@/components/ModelPreview'), {
  ssr: false,
  loading: () => <div className={styles.previewLoading}>Loading…</div>,
});

type Theme = 'dark' | 'light';
type Stage = 'source' | 'model' | 'voxelize' | 'export';

function useDraggable(initial: { x: number; y: number }) {
  const [pos, setPos] = useState(initial);
  const r = useRef({ dragging: false, ox: 0, oy: 0, x: initial.x, y: initial.y });

  const onDragStart = useCallback((e: React.MouseEvent) => {
    r.current.dragging = true;
    r.current.ox = e.clientX - r.current.x;
    r.current.oy = e.clientY - r.current.y;
    e.preventDefault();
  }, []);

  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (!r.current.dragging) return;
      r.current.x = e.clientX - r.current.ox;
      r.current.y = e.clientY - r.current.oy;
      setPos({ x: r.current.x, y: r.current.y });
    };
    const up = () => { r.current.dragging = false; };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, []);

  return { pos, onDragStart };
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
  const [voxels, setVoxels] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [parseLoading, setParseLoading] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [showVoxels, setShowVoxels] = useState(false);
  const [progress, setProgress] = useState(0);
  const [generateDone, setGenerateDone] = useState(false);

  const [targetBlocks, setTargetBlocks] = useState(250);
  const [surfaceVoxels, setSurfaceVoxels] = useState(true);
  const [interiorFill, setInteriorFill] = useState(true);
  const [curvedVoxels, setCurvedVoxels] = useState(true);

  const sourceCard = useDraggable({ x: 24, y: 80 });
  const paramCard = useDraggable({ x: 340, y: 80 });

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0];
    if (!selected) return;
    setFile(selected);
    setError('');
    setVoxels([]);
    setShowVoxels(false);
    setParsedGeometry(null);
    setParseLoading(true);
    setGenerateDone(false);
    setStatus('Parsing model…');
    try {
      const parsed = await parseModelFile(selected);
      setParsedGeometry(parsed.geometry);
      setStatus('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to parse model');
      setStatus('');
    } finally {
      setParseLoading(false);
    }
  };

  const handlePreview = async () => {
    if (!parsedGeometry) return;
    setLoading(true);
    setError('');
    setStatus('Voxelizing (quick preview)…');
    try {
      const result = await voxelizeGeometryAsync(
        parsedGeometry, Math.min(targetBlocks, 1000),
        { surface: surfaceVoxels, interior: interiorFill, curvedVoxels }
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
    setStatus('Generating voxels…');
    try {
      const result = await voxelizeGeometryAsync(
        parsedGeometry, targetBlocks,
        { surface: surfaceVoxels, interior: interiorFill, curvedVoxels },
        (p) => setProgress(p)
      );
      let list = Array.isArray(result) ? result : [];
      // Auto-remove interior voxels, keep only surface
      list = list.filter(v => v.type !== 'interior');
      setVoxels(list);
      setStatus(`Generated: ${list.length.toLocaleString()} surface voxels`);
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
    const blob = new Blob([JSON.stringify(voxels, null, 2)], { type: 'application/json' });
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
            {file && <div className={styles.fileName} title={file.name}>{file.name}</div>}
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
          className={styles.cardOuter}
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

              {/* Numeric params */}
              <div className={styles.paramSection}>
                <div className={styles.paramRow}>
                  <label htmlFor="targetBlocks">Target blocks: {targetBlocks}</label>
                  <div className={styles.sliderContainer}>
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
                  </div>
                  <input
                    id="targetBlocks"
                    type="number"
                    min="10"
                    max="2000"
                    value={targetBlocks}
                    onChange={e => { const v = parseInt(e.target.value); if (!isNaN(v)) setTargetBlocks(Math.max(10, Math.min(2000, v))); }}
                  />
                </div>
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
  );
}
