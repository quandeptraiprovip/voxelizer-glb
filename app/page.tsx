'use client';

import { useState, useEffect } from 'react';
import dynamic from 'next/dynamic';
import styles from './page.module.css';
import { parseModelFile, voxelizeGeometryAsync } from '@/lib/voxelizer';
import { GLBDebugPanel } from '@/components/GLBDebugPanel';

const VoxelViewer = dynamic(() => import('@/components/VoxelViewer'), {
  ssr: false,
  loading: () => (
    <div className={styles.placeholder}>
      <div className={styles.placeholderIcon}>◇</div>
      <div className={styles.placeholderTitle}>Loading 3D viewer…</div>
    </div>
  ),
});

const ModelPreview = dynamic(() => import('@/components/ModelPreview'), {
  ssr: false,
  loading: () => <div className={styles.previewLoading}>Loading preview…</div>,
});

type Stage = 'source' | 'model' | 'voxelize' | 'export';
type Theme = 'dark' | 'light';

export default function Home() {
  const [theme, setTheme] = useState<Theme>('dark');
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    // Load saved theme from localStorage
    const saved = (localStorage.getItem('theme') as Theme) || 'dark';
    setTheme(saved);
    setMounted(true);
  }, []);

  useEffect(() => {
    if (mounted) {
      localStorage.setItem('theme', theme);
    }
  }, [theme, mounted]);

  const toggleTheme = () => {
    setTheme(theme === 'dark' ? 'light' : 'dark');
  };

  const [file, setFile] = useState<File | null>(null);
  const [parsedGeometry, setParsedGeometry] = useState<any>(null);
  const [voxels, setVoxels] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [parseLoading, setParseLoading] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [showVoxels, setShowVoxels] = useState(false);
  const [progress, setProgress] = useState(0);

  const [targetBlocks, setTargetBlocks] = useState(250);
  const [blockSize, setBlockSize] = useState(1.0);
  const [gapRatio, setGapRatio] = useState(0.02);

  const [surfaceVoxels, setSurfaceVoxels] = useState(true);
  const [interiorFill, setInteriorFill] = useState(true);
  const [curvedVoxels, setCurvedVoxels] = useState(true);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0];
    if (!selected) return;

    setFile(selected);
    setError('');
    setVoxels([]);
    setShowVoxels(false);
    setParsedGeometry(null);
    setParseLoading(true);
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
      const result = await voxelizeGeometryAsync(parsedGeometry, Math.min(targetBlocks, 1000), blockSize, gapRatio, {
        surface: surfaceVoxels,
        interior: interiorFill,
        curvedVoxels,
      });
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
      const result = await voxelizeGeometryAsync(parsedGeometry, targetBlocks, blockSize, gapRatio, {
        surface: surfaceVoxels,
        interior: interiorFill,
        curvedVoxels,
      }, (p) => {
        setProgress(p);
      });
      const list = Array.isArray(result) ? result : [];
      setVoxels(list);
      const mode = [];
      if (surfaceVoxels) mode.push('Surface');
      if (interiorFill) mode.push('Interior');
      setStatus(`Generated: ${list.length} voxels (${mode.join(' + ') || 'None'})`);
      setShowVoxels(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error voxelizing');
      setStatus('');
    } finally {
      setLoading(false);
      setProgress(0);
    }
  };

  const handleRemoveInterior = () => {
    if (!voxels.length) return;
    const surfaceOnly = voxels.filter(v => v.type !== 'interior');
    setVoxels(surfaceOnly);
    const removed = voxels.length - surfaceOnly.length;
    setStatus(`Removed ${removed} interior voxels. Kept ${surfaceOnly.length} surface voxels.`);
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

  const canVoxelize = !!parsedGeometry && !loading && !parseLoading;
  const busy = loading || parseLoading;

  const stage: Stage = voxels.length > 0
    ? 'export'
    : parsedGeometry
      ? 'voxelize'
      : file
        ? 'model'
        : 'source';

  const crumbs: { id: Stage; label: string }[] = [
    { id: 'source', label: 'SOURCE' },
    { id: 'model', label: 'MODEL' },
    { id: 'voxelize', label: 'VOXELIZE' },
    { id: 'export', label: 'EXPORT' },
  ];

  return (
    <div className={styles.container} data-theme={theme}>
      {/* ===== TOP BAR ===== */}
      <header className={styles.topbar}>
        <div className={styles.brand}>
          Voxelizer
          <span className={styles.brandTag}>web</span>
        </div>

        <nav className={styles.crumbs}>
          {crumbs.map((c) => (
            <span
              key={c.id}
              className={`${styles.crumb} ${c.id === stage ? styles.crumbActive : ''}`}
            >
              {c.label}
            </span>
          ))}
        </nav>

        <div className={styles.spacer} />

        <button
          onClick={toggleTheme}
          className={styles.themeToggle}
          title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
        >
          {theme === 'dark' ? '☀️' : '🌙'}
        </button>

        <div className={styles.topStatus}>
          <span className={styles.statusPill}>
            <span className={`${styles.dot} ${busy ? styles.dotBusy : !parsedGeometry ? styles.dotIdle : ''}`} />
            {busy ? 'Working' : parsedGeometry ? 'Ready' : 'Idle'}
          </span>
          {voxels.length > 0 && (
            <span className={styles.statusPill}>
              {voxels.length.toLocaleString()} voxels
            </span>
          )}
        </div>
      </header>

      {/* ===== MAIN LAYOUT ===== */}
      <main className={styles.layout}>
        {/* Sidebar */}
        <aside className={styles.sidebar}>
          <div className={styles.sidebarHeader}>
            <div className={styles.sidebarTitle}>Controls</div>
          </div>

          <div className={styles.sidebarScroll}>
            {/* Upload */}
            <section className={styles.section}>
              <div className={styles.sectionLabel}>Source Model</div>
              <div className={styles.dropzone}>
                <div className={styles.dropzoneIcon}>↑</div>
                <div className={styles.dropzoneTitle}>Drop or click to upload</div>
                <div className={styles.dropzoneDesc}>
                  Convert a 3D mesh into voxels
                </div>
                <div className={styles.dropzoneTypes}>
                  <span>GLB</span>
                  <span>OBJ</span>
                  <span>STL</span>
                  <span>GLTF</span>
                </div>
                <input
                  type="file"
                  accept=".glb,.obj,.stl,.gltf"
                  onChange={handleFileChange}
                  className={styles.fileInput}
                />
              </div>
              {file && <div className={styles.fileName} title={file.name}>{file.name}</div>}
            </section>

            {/* Preview */}
            {parsedGeometry && (
              <section className={styles.section}>
                <div className={styles.sectionLabel}>Mesh Preview</div>
                <div className={styles.previewWrap}>
                  <ModelPreview geometry={parsedGeometry} />
                </div>
              </section>
            )}

            {/* Parameters */}
            <section className={styles.section}>
              <div className={styles.sectionLabel}>Parameters</div>

              <div className={styles.slider}>
                <div className={styles.sliderHead}>
                  <span className={styles.sliderName}>Target blocks</span>
                  <span className={styles.sliderValue}>{targetBlocks.toLocaleString()}</span>
                </div>
                <input
                  type="range"
                  min="20"
                  max="500"
                  step="10"
                  value={targetBlocks}
                  onChange={(e) => setTargetBlocks(parseInt(e.target.value))}
                />
              </div>

              <div className={styles.slider}>
                <div className={styles.sliderHead}>
                  <span className={styles.sliderName}>Block size</span>
                  <span className={styles.sliderValue}>{blockSize.toFixed(2)}</span>
                </div>
                <input
                  type="range"
                  min="0.5"
                  max="3.0"
                  step="0.1"
                  value={blockSize}
                  onChange={(e) => setBlockSize(parseFloat(e.target.value))}
                />
              </div>

              <div className={styles.slider}>
                <div className={styles.sliderHead}>
                  <span className={styles.sliderName}>Gap ratio</span>
                  <span className={styles.sliderValue}>{gapRatio.toFixed(2)}</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="0.5"
                  step="0.05"
                  value={gapRatio}
                  onChange={(e) => setGapRatio(parseFloat(e.target.value))}
                />
              </div>
            </section>

            {/* Mode */}
            <section className={styles.section}>
              <div className={styles.sectionLabel}>Voxelization Mode</div>
              <div className={styles.checkbox}>
                <input
                  type="checkbox"
                  id="surface"
                  checked={surfaceVoxels}
                  onChange={(e) => setSurfaceVoxels(e.target.checked)}
                />
                <label htmlFor="surface">Surface voxelization</label>
              </div>
              <div className={styles.checkbox}>
                <input
                  type="checkbox"
                  id="interior"
                  checked={interiorFill}
                  onChange={(e) => setInteriorFill(e.target.checked)}
                />
                <label htmlFor="interior">Interior fill (solid volume)</label>
              </div>
              {!interiorFill && (
                <p className={styles.hint}>
                  Surface shell only — no volume fill. Regenerate after changing this option.
                </p>
              )}
              <div className={styles.checkbox}>
                <input
                  type="checkbox"
                  id="curved"
                  checked={curvedVoxels}
                  onChange={(e) => setCurvedVoxels(e.target.checked)}
                />
                <label htmlFor="curved">Curved surface voxels (rotation)</label>
              </div>
            </section>

            {/* Actions */}
            <section className={styles.section}>
              <div className={styles.sectionLabel}>Actions</div>
              <div className={styles.buttonGroup}>
                <button onClick={handlePreview} disabled={!canVoxelize} className={styles.btn}>
                  {loading ? 'Working…' : 'Quick Preview'}
                </button>
                <button
                  onClick={handleGenerate}
                  disabled={!canVoxelize}
                  className={`${styles.btn} ${styles.btnPrimary}`}
                >
                  {loading ? 'Working…' : 'Generate'}
                </button>
              </div>

              {voxels.length > 0 && (
                <>
                  <button onClick={handleRemoveInterior} className={styles.btnExport} title="Remove all interior voxels, keep only surface">
                    Remove Interior
                  </button>
                  <button onClick={handleExport} className={styles.btnExport}>
                    Export JSON
                  </button>
                </>
              )}
            </section>

            {/* Status banners */}
            {(status || parseLoading || error || voxels.length > 0) && (
              <section className={styles.section}>
                {(status || parseLoading) && (
                  <div className={`${styles.banner} ${styles.bannerStatus}`}>
                    {parseLoading ? 'Parsing model…' : status}
                  </div>
                )}
                {error && (
                  <div className={`${styles.banner} ${styles.bannerError}`}>{error}</div>
                )}
                {voxels.length > 0 && !error && (
                  <div className={`${styles.banner} ${styles.bannerInfo}`}>
                    {voxels.length.toLocaleString()} voxels created
                  </div>
                )}
                {loading && progress > 0 && (
                  <div className={styles.progressContainer}>
                    <div className={styles.progressBar}>
                      <div
                        className={styles.progressFill}
                        style={{ width: `${progress}%` }}
                      />
                    </div>
                    <div className={styles.progressText}>{Math.round(progress)}%</div>
                  </div>
                )}
              </section>
            )}
          </div>
        </aside>

        {/* Viewer */}
        <section className={styles.viewerPanel}>
          {showVoxels && voxels.length > 0 ? (
            <VoxelViewer voxels={voxels} progress={progress} isLoading={loading} />
          ) : (
            <div className={styles.placeholder}>
              <div className={styles.placeholderIcon}>◇</div>
              <div className={styles.placeholderTitle}>Voxel viewport</div>
              <div className={styles.placeholderDesc}>
                Upload a model, tune parameters, and press Generate to render the voxelized output here.
              </div>
            </div>
          )}
        </section>
      </main>

      {/* ===== HUD ===== */}
      <div className={styles.hud}>
        <div className={styles.hudItem}>
          <span className={styles.kbd}>Drag</span> orbit
        </div>
        <div className={styles.hudItem}>
          <span className={styles.kbd}>Scroll</span> zoom
        </div>
        <div className={styles.hudItem}>
          <b>Voxelizer</b> Spatial Glass
        </div>
      </div>

      {/* ===== DEBUG PANEL ===== */}
      <div className={styles.debugPanelContainer}>
        <details className={styles.debugDetails}>
          <summary className={styles.debugSummary}>🔍 GLB Debug Analyzer</summary>
          <div className={styles.debugContent}>
            <GLBDebugPanel />
          </div>
        </details>
      </div>
    </div>
  );
}
