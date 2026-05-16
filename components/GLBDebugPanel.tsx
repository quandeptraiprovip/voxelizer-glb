'use client';

import { useState } from 'react';
import { analyzeGLB, formatAnalysisReport, type GLBAnalysis } from '@/lib/glb-analyzer';
import styles from './GLBDebugPanel.module.css';

export function GLBDebugPanel() {
  const [analysis, setAnalysis] = useState<GLBAnalysis | null>(null);
  const [report, setReport] = useState('');
  const [loading, setLoading] = useState(false);
  const [fileName, setFileName] = useState('');

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setFileName(file.name);
    setLoading(true);

    try {
      const analysis = await analyzeGLB(file);
      setAnalysis(analysis);
      const report = formatAnalysisReport(analysis);
      setReport(report);
    } catch (error) {
      setReport(`Error analyzing file: ${error}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <h2>🔍 GLB Debug Analyzer</h2>
        <p>Upload a GLB file to inspect its structure</p>
      </div>

      <div className={styles.uploadSection}>
        <input
          type="file"
          accept=".glb,.gltf"
          onChange={handleFileSelect}
          disabled={loading}
          className={styles.fileInput}
        />
        {fileName && <span className={styles.fileName}>{fileName}</span>}
      </div>

      {loading && <div className={styles.loading}>Analyzing...</div>}

      {report && (
        <div className={styles.reportContainer}>
          <div className={styles.reportText}>
            <pre>{report}</pre>
          </div>

          {analysis && (
            <div className={styles.details}>
              <section className={styles.section}>
                <h3>📊 Summary</h3>
                <div className={styles.grid}>
                  <div>
                    <strong>Meshes:</strong> {analysis.meshDetails.meshCount}
                  </div>
                  <div>
                    <strong>Primitives:</strong> {analysis.meshDetails.totalPrimitives}
                  </div>
                  <div>
                    <strong>Nodes:</strong> {analysis.nodeHierarchy.nodeCount}
                  </div>
                  <div>
                    <strong>Root Nodes:</strong> {analysis.nodeHierarchy.rootNodes.length}
                  </div>
                </div>
              </section>

              <section className={styles.section}>
                <h3>🚨 Issues</h3>
                {analysis.issues.critical.length === 0 &&
                  analysis.issues.warnings.length === 0 &&
                  analysis.issues.info.length === 0 ? (
                  <div className={styles.good}>✓ No issues detected</div>
                ) : (
                  <>
                    {analysis.issues.critical.length > 0 && (
                      <div>
                        <strong className={styles.critical}>Critical ({analysis.issues.critical.length}):</strong>
                        <ul>
                          {analysis.issues.critical.map((issue, i) => (
                            <li key={i}>{issue}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {analysis.issues.warnings.length > 0 && (
                      <div>
                        <strong className={styles.warning}>Warnings ({analysis.issues.warnings.length}):</strong>
                        <ul>
                          {analysis.issues.warnings.map((issue, i) => (
                            <li key={i}>{issue}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {analysis.issues.info.length > 0 && (
                      <details>
                        <summary className={styles.info}>Info ({analysis.issues.info.length})</summary>
                        <ul>
                          {analysis.issues.info.map((issue, i) => (
                            <li key={i}>{issue}</li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </>
                )}
              </section>

              <section className={styles.section}>
                <h3>🌳 Scene Hierarchy</h3>
                {analysis.nodeHierarchy.rootNodes.length > 0 ? (
                  <div className={styles.tree}>
                    {analysis.nodeHierarchy.rootNodes.map(rootIdx => (
                      <NodeTree
                        key={rootIdx}
                        nodeIdx={rootIdx}
                        details={analysis.nodeHierarchy.nodeDetails}
                      />
                    ))}
                  </div>
                ) : (
                  <p>No root nodes found</p>
                )}
              </section>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function NodeTree({
  nodeIdx,
  details,
}: {
  nodeIdx: number;
  details: any[];
}) {
  const node = details[nodeIdx];
  if (!node) return null;

  return (
    <div className={styles.treeNode}>
      <div className={styles.nodeLabel}>
        {node.hasMesh && '🔷 '}
        {node.name}
        {node.hasTransform && ' ✓'}
      </div>
      {node.children.length > 0 && (
        <div className={styles.children}>
          {node.children.map((childIdx: number) => (
            <NodeTree key={childIdx} nodeIdx={childIdx} details={details} />
          ))}
        </div>
      )}
    </div>
  );
}
