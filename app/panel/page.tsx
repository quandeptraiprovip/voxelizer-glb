'use client';

import { useState, useEffect } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import * as THREE from 'three';
import styles from '../page.module.css';
import pstyles from './panel.module.css';
import { parseModelFile } from '@/lib/voxelizer';
import { buildQuadMesh, QuadMeshData } from '@/lib/quad-mesher';
import type { PipelineStep } from '@/components/PanelViewer';

const PanelViewer = dynamic(() => import('@/components/PanelViewer'), {
  ssr: false,
  loading: () => (
    <div className={styles.placeholder}>
      <div className={styles.placeholderIcon}>⬡</div>
      <div className={styles.placeholderTitle}>Loading viewer…</div>
    </div>
  ),
});

type Theme = 'dark' | 'light';

const STEPS: { id: PipelineStep; label: string; short: string }[] = [
  { id:'triangles', label:'Triangle mesh',  short:'TRIANGLES' },
  { id:'quads',     label:'Quad mesh',       short:'QUADS'     },
  { id:'panels',    label:'3D panels',       short:'PANELS'    },
  { id:'animation', label:'Wave assembly',   short:'ANIMATE'   },
];

export default function PanelPage() {
  const [theme, setTheme] = useState<Theme>('dark');
  const [mounted, setMounted] = useState(false);
  useEffect(() => { const s=(localStorage.getItem('theme') as Theme)||'dark'; setTheme(s); setMounted(true); }, []);
  useEffect(() => { if(mounted) localStorage.setItem('theme',theme); }, [theme,mounted]);

  const [file, setFile]                   = useState<File|null>(null);
  const [srcGeo, setSrcGeo]               = useState<THREE.BufferGeometry|null>(null);
  const [quadData, setQuadData]           = useState<QuadMeshData|null>(null);
  const [step, setStep]                   = useState<PipelineStep>('triangles');
  const [parseLoading, setParseLoading]   = useState(false);
  const [building, setBuilding]           = useState(false);
  const [status, setStatus]               = useState('');
  const [error, setError]                 = useState('');
  const [maxTris, setMaxTris]             = useState(12000);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setFile(f); setError(''); setQuadData(null); setSrcGeo(null);
    setParseLoading(true); setStatus('Parsing model…');
    try {
      const parsed = await parseModelFile(f);
      setSrcGeo(parsed.geometry);

      // Auto-select maxTris based on triangle count
      const indexAttr = parsed.geometry.index;
      const posAttr = parsed.geometry.attributes.position;
      const totalTris = indexAttr
        ? Math.floor(indexAttr.count / 3)
        : Math.floor(posAttr.count / 3);

      // Strategy: aim for 10000-14000 triangles (good detail-to-performance balance)
      // but if model is smaller, use most of its triangles
      let suggested = Math.min(14000, Math.max(4000, totalTris));
      if (totalTris > 20000) suggested = 12000;
      else if (totalTris > 10000) suggested = Math.min(10000, totalTris);
      else if (totalTris > 3000) suggested = totalTris;

      setMaxTris(suggested);
      setStep('triangles');
      setStatus(`Model ready (${totalTris.toLocaleString()} tris, maxTris auto-set to ${suggested.toLocaleString()})`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to parse model');
      setStatus('');
    } finally { setParseLoading(false); }
  };

  const handleGenerate = async () => {
    if (!srcGeo) return;
    setBuilding(true); setError(''); setStatus('Building quad panels…');
    try {
      await new Promise(r => setTimeout(r, 30));
      const result = buildQuadMesh(srcGeo, maxTris);
      setQuadData(result);
      setStatus(
        `${result.stats.quadCount.toLocaleString()} quads, ` +
        `${result.stats.orphanCount.toLocaleString()} orphans — ` +
        `${Math.round(result.stats.quadCount/Math.max(1,result.stats.triCount/2)*100)}% coverage`,
      );
      setStep('quads');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error building panels');
      setStatus('');
    } finally { setBuilding(false); }
  };

  const busy = parseLoading || building;

  // Which steps are enabled
  const stepEnabled = (s: PipelineStep) => {
    if (s === 'triangles') return !!srcGeo;
    return !!quadData;
  };

  return (
    <div className={styles.container} data-theme={theme}>
      {/* TOP BAR */}
      <header className={styles.topbar}>
        <div className={styles.brand}>
          Panel<span className={styles.brandTag}>surface</span>
        </div>

        {/* Step breadcrumb */}
        <nav className={styles.crumbs}>
          {STEPS.map(s => (
            <button
              key={s.id}
              className={`${styles.crumb} ${s.id===step ? styles.crumbActive : ''} ${!stepEnabled(s.id)?pstyles.crumbDisabled:''}`}
              onClick={() => stepEnabled(s.id) && setStep(s.id)}
              disabled={!stepEnabled(s.id)}
              style={{ cursor: stepEnabled(s.id) ? 'pointer' : 'default', background:'none', border:'none' }}
            >
              {s.short}
            </button>
          ))}
        </nav>

        <div className={styles.spacer}/>
        <Link href="/" className={pstyles.navLink}>← Voxelizer</Link>

        <button onClick={()=>setTheme(t=>t==='dark'?'light':'dark')} className={styles.themeToggle}>
          {theme==='dark'?'☀️':'🌙'}
        </button>

        <div className={styles.topStatus}>
          <span className={styles.statusPill}>
            <span className={`${styles.dot} ${busy?styles.dotBusy:!srcGeo?styles.dotIdle:''}`}/>
            {busy?'Working':srcGeo?'Ready':'Idle'}
          </span>
          {quadData && <span className={styles.statusPill}>{quadData.stats.quadCount.toLocaleString()} quads</span>}
        </div>
      </header>

      <main className={styles.layout}>
        {/* SIDEBAR */}
        <aside className={styles.sidebar}>
          <div className={styles.sidebarHeader}>
            <div className={styles.sidebarTitle}>Panel Surface</div>
          </div>

          <div className={styles.sidebarScroll}>
            {/* Upload */}
            <section className={styles.section}>
              <div className={styles.sectionLabel}>Source Model</div>
              <div className={styles.dropzone}>
                <div className={styles.dropzoneIcon}>⬡</div>
                <div className={styles.dropzoneTitle}>Drop or click to upload</div>
                <div className={styles.dropzoneDesc}>Convert mesh surface into square panels</div>
                <div className={styles.dropzoneTypes}>
                  <span>GLB</span><span>OBJ</span><span>STL</span><span>GLTF</span>
                </div>
                <input type="file" accept=".glb,.obj,.stl,.gltf" onChange={handleFileChange} className={styles.fileInput}/>
              </div>
              {file && <div className={styles.fileName} title={file.name}>{file.name}</div>}
            </section>

            {/* Step info panel — changes based on active step */}
            <section className={styles.section}>
              <div className={styles.sectionLabel}>
                {STEPS.find(s=>s.id===step)?.label ?? 'Step'}
              </div>

              {step==='triangles' && (
                <div className={pstyles.stepInfo}>
                  <p className={pstyles.stepDesc}>Original triangle mesh loaded from the 3D file. Each triangle is shown as a flat face with edge lines.</p>
                  {srcGeo && (
                    <div className={pstyles.statRow}>
                      <span className={pstyles.statLabel}>Vertices</span>
                      <span className={pstyles.statVal}>{srcGeo.attributes.position?.count.toLocaleString()??'—'}</span>
                    </div>
                  )}
                  {quadData && (
                    <div className={pstyles.statRow}>
                      <span className={pstyles.statLabel}>Triangles</span>
                      <span className={pstyles.statVal}>{quadData.stats.triCount.toLocaleString()}</span>
                    </div>
                  )}
                </div>
              )}

              {step==='quads' && quadData && (
                <div className={pstyles.stepInfo}>
                  <p className={pstyles.stepDesc}>Adjacent coplanar triangle pairs merged into quads. <span style={{color:'#5599dd'}}>Blue</span> = quads, <span style={{color:'#e07030'}}>orange</span> = unpaired triangles.</p>
                  <div className={pstyles.statRow}><span className={pstyles.statLabel}>Quads</span><span className={pstyles.statVal} style={{color:'#88bbff'}}>{quadData.stats.quadCount.toLocaleString()}</span></div>
                  <div className={pstyles.statRow}><span className={pstyles.statLabel}>Orphans</span><span className={pstyles.statVal} style={{color:'#e09050'}}>{quadData.stats.orphanCount.toLocaleString()}</span></div>
                  <div className={pstyles.statRow}>
                    <span className={pstyles.statLabel}>Coverage</span>
                    <span className={pstyles.statVal} style={{color:'#88dd88'}}>
                      {Math.round(quadData.stats.quadCount*2/Math.max(1,quadData.stats.triCount)*100)}%
                    </span>
                  </div>
                  <div className={pstyles.statRow}><span className={pstyles.statLabel}>Passes</span><span className={pstyles.statVal}>3 (20°/40°/60°)</span></div>

                  <div className={pstyles.algorithmSection}>
                    <div className={pstyles.algorithmTitle}>QEM Triangle-to-Quad Algorithm</div>
                    <div className={pstyles.algorithmStep}>
                      <div className={pstyles.stepNum}>①</div>
                      <div>
                        <div className={pstyles.stepName}>Vertex Welding</div>
                        <div className={pstyles.stepDesc} style={{marginTop:'3px'}}>Deduplicate vertices by rounding positions (WELD=1e5) to detect shared edges in non-indexed geometries</div>
                      </div>
                    </div>
                    <div className={pstyles.algorithmStep}>
                      <div className={pstyles.stepNum}>②</div>
                      <div>
                        <div className={pstyles.stepName}>Edge Adjacency Map</div>
                        <div className={pstyles.stepDesc} style={{marginTop:'3px'}}>Build map from each edge (by welded indices) to adjacent triangle pairs</div>
                      </div>
                    </div>
                    <div className={pstyles.algorithmStep}>
                      <div className={pstyles.stepNum}>③</div>
                      <div>
                        <div className={pstyles.stepName}>Compute QEM Matrices</div>
                        <div className={pstyles.stepDesc} style={{marginTop:'3px'}}>For each vertex, accumulate 4×4 quadric matrices Q_v = Σ(p·pᵀ) from adjacent face planes</div>
                      </div>
                    </div>
                    <div className={pstyles.algorithmStep}>
                      <div className={pstyles.stepNum}>④</div>
                      <div>
                        <div className={pstyles.stepName}>Score Candidates</div>
                        <div className={pstyles.stepDesc} style={{marginTop:'3px'}}>For each adjacent tri pair: compute QEM error at quad centroid to measure planarity (lower = flatter)</div>
                      </div>
                    </div>
                    <div className={pstyles.algorithmStep}>
                      <div className={pstyles.stepNum}>⑤</div>
                      <div>
                        <div className={pstyles.stepName}>Greedy Matching</div>
                        <div className={pstyles.stepDesc} style={{marginTop:'3px'}}>Sort by cost (flattest first), then greedily pick non-overlapping pairs</div>
                      </div>
                    </div>
                    <div className={pstyles.algorithmStep}>
                      <div className={pstyles.stepNum}>⑥</div>
                      <div>
                        <div className={pstyles.stepName}>Vertex Ordering</div>
                        <div className={pstyles.stepDesc} style={{marginTop:'3px'}}>Sort 4 quad vertices CCW by angle around centroid to avoid hourglass/bowtie shapes</div>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {step==='panels' && quadData && (
                <div className={pstyles.stepInfo}>
                  <p className={pstyles.stepDesc}>Each quad extruded along its surface normal into a 3D panel. Colors are derived from normal direction.</p>
                  <div className={pstyles.statRow}><span className={pstyles.statLabel}>Panels</span><span className={pstyles.statVal}>{quadData.panels.length.toLocaleString()}</span></div>
                  <div className={pstyles.statRow}><span className={pstyles.statLabel}>Thickness</span><span className={pstyles.statVal}>10% of size</span></div>
                </div>
              )}

              {step==='animation' && quadData && (
                <div className={pstyles.stepInfo}>
                  <p className={pstyles.stepDesc}>Wave assembly: panels fly from a scattered exploded view into the final surface. Center panels land first — a ripple wave sweeps outward.</p>
                  <div className={pstyles.statRow}><span className={pstyles.statLabel}>Wave time</span><span className={pstyles.statVal}>2.4s</span></div>
                  <div className={pstyles.statRow}><span className={pstyles.statLabel}>Easing</span><span className={pstyles.statVal}>Spring overshoot</span></div>
                  <div className={pstyles.statRow}><span className={pstyles.statLabel}>Scatter</span><span className={pstyles.statVal}>3.2× radius</span></div>
                  <p className={pstyles.hint}>Use the Explode/Assemble buttons in the viewport to replay.</p>
                </div>
              )}
            </section>

            {/* Step navigation buttons */}
            <section className={styles.section}>
              <div className={styles.sectionLabel}>Pipeline Steps</div>
              <div className={pstyles.stepButtons}>
                {STEPS.map((s,idx) => (
                  <button
                    key={s.id}
                    className={`${pstyles.stepBtn} ${s.id===step?pstyles.stepBtnActive:''} ${!stepEnabled(s.id)?pstyles.stepBtnDisabled:''}`}
                    onClick={() => stepEnabled(s.id) && setStep(s.id)}
                    disabled={!stepEnabled(s.id)}
                  >
                    <span className={pstyles.stepBtnNum}>{idx+1}</span>
                    <span className={pstyles.stepBtnLabel}>{s.label}</span>
                  </button>
                ))}
              </div>
            </section>

            {/* Parameters */}
            <section className={styles.section}>
              <div className={styles.sectionLabel}>Parameters</div>
              <div className={styles.paramInput}>
                <label htmlFor="maxTris">Max triangles</label>
                <input id="maxTris" type="number" value={maxTris} min={500} max={60000} step={1000}
                  onChange={e=>{const v=parseInt(e.target.value);if(!isNaN(v))setMaxTris(v);}}/>
              </div>
              <p className={styles.hint}>Higher = more detail and more panels. 8000–16000 recommended.</p>
            </section>

            {/* Actions */}
            <section className={styles.section}>
              <div className={styles.sectionLabel}>Actions</div>
              <button onClick={handleGenerate} disabled={!srcGeo||busy}
                className={`${styles.btn} ${styles.btnPrimary}`}>
                {building?'Building…':'Generate Panels'}
              </button>
            </section>

            {/* Status */}
            {(status||error||parseLoading) && (
              <section className={styles.section}>
                {(status||parseLoading)&&<div className={`${styles.banner} ${styles.bannerStatus}`}>{parseLoading?'Parsing model…':status}</div>}
                {error&&<div className={`${styles.banner} ${styles.bannerError}`}>{error}</div>}
              </section>
            )}
          </div>
        </aside>

        {/* VIEWER */}
        <section className={styles.viewerPanel}>
          {srcGeo ? (
            <PanelViewer
              step={step}
              sourceGeometry={srcGeo}
              quadMeshData={quadData}
              isLoading={building}
              progress={0}
            />
          ) : (
            <div className={styles.placeholder}>
              <div className={styles.placeholderIcon}>⬡</div>
              <div className={styles.placeholderTitle}>Panel surface viewport</div>
              <div className={styles.placeholderDesc}>
                Upload a 3D model to visualize the pipeline:<br/>
                triangles → quads → panels → wave assembly.
              </div>
            </div>
          )}
        </section>
      </main>

      <div className={styles.hud}>
        <div className={styles.hudItem}><span className={styles.kbd}>Drag</span> orbit</div>
        <div className={styles.hudItem}><span className={styles.kbd}>Scroll</span> zoom</div>
        <div className={styles.hudItem}><b>Panel</b> Surface</div>
      </div>
    </div>
  );
}
