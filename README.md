# 🎲 Voxelizer Web

Convert 3D models (GLB/OBJ/STL) to voxelated 3D models with interactive visualization.

## 🚀 Quick Start

### 1️⃣ **Setup Python Backend**

```bash
# Install Python dependencies
pip install -r requirements.txt

# Start Flask API server (runs on port 5000)
python backend_api.py
```

Server will be running at: `http://localhost:5000`

### 2️⃣ **Setup Next.js Frontend**

```bash
# Install Node dependencies
npm install

# Start development server (runs on port 3000)
npm run dev
```

Frontend will be available at: `http://localhost:3000`

---

## 📖 Usage

1. **Open** the web app at `http://localhost:3000`
2. **Upload** a 3D model (`.glb`, `.obj`, `.stl`, or `.gltf`)
3. **Adjust parameters**:
   - **Target Blocks**: Number of voxels (100-20000)
   - **Block Size**: Size multiplier (0.5-3.0)
   - **Gap Ratio**: Space between voxels (0-0.5)
4. **Generate**:
   - Click **Quick Preview** for fast preview (500 blocks)
   - Click **Generate** for full voxelization with custom parameters
5. **View** the 3D result (interactive, rotatable, zoomable)
6. **Export** as JSON for use in other projects

---

## 🏗️ Architecture

### Backend (Python Flask)
- **Port**: 5000
- **Endpoints**:
  - `GET /api/health` - Health check
  - `POST /api/voxelize-preview` - Quick preview (500 blocks)
  - `POST /api/voxelize` - Full voxelization with custom parameters

### Frontend (Next.js 14)
- **Port**: 3000
- **Features**:
  - Drag-and-drop file upload
  - Parameter sliders
  - Real-time status updates
  - Interactive 3D visualization (Plotly)
  - JSON export

---

## 📊 Algorithm Details

The voxelizer uses a **6-directional raycast** algorithm:

1. **Ray Padding**: Mesh-aware padding (50% of diagonal + 2×step)
2. **Grid Generation**: Uniform sampling in 6 orthogonal directions (±X, ±Y, ±Z)
3. **Raycast**: Multiple hit detection for hollow/complex surfaces
4. **Deduplication**: Grid-based deduplication to remove duplicates
5. **Normal Averaging**: Multi-directional normal averaging for curved surfaces
6. **Output**: Position, normal, color, and size per voxel

---

## 🎨 Customization

### Adjust Default Parameters
Edit `app/page.tsx`:
```typescript
const [targetBlocks, setTargetBlocks] = useState(2000); // Change default
const [blockSize, setBlockSize] = useState(1.0);
const [gapRatio, setGapRatio] = useState(0.12);
```

### Change API URL
Edit `app/page.tsx`:
```typescript
const response = await fetch('http://localhost:5000/api/voxelize', {
  // Change to your backend URL
});
```

---

## 🐛 Troubleshooting

### Backend connection refused
- Check if Flask server is running on port 5000
- Verify CORS is enabled in `backend_api.py`
- Check firewall settings

### Visualization not showing
- Check browser console for errors
- Ensure Plotly.js is installed (`npm install`)
- Try refreshing the page

### Large files take too long
- Use "Quick Preview" first
- Reduce target blocks
- Increase block size

---

## 📦 Project Structure

```
voxelizer-web/
├── app/
│   ├── page.tsx              # Main page
│   ├── page.module.css       # Styles
│   ├── layout.tsx            # Root layout
│   └── globals.css           # Global styles
├── components/
│   └── VoxelViewer.tsx       # 3D visualization
├── backend_api.py            # Flask API server
├── package.json              # Node dependencies
├── requirements.txt          # Python dependencies
├── tsconfig.json             # TypeScript config
├── next.config.js            # Next.js config
└── README.md                 # This file
```

---

## 📝 API Response Format

```json
{
  "success": true,
  "status": "Created 1234 blocks in 2.34s",
  "voxel_count": 1234,
  "voxels": [
    {
      "position": [-0.5, -0.5, 0.0],
      "normal": [-0.707, -0.707, 0.0],
      "color": [0.8, 0.8, 0.8],
      "size": 0.12,
      "z_height": 1.0
    },
    ...
  ]
}
```

---

## 🎯 Future Improvements

- [ ] Real-time voxel preview while adjusting parameters
- [ ] Multiple model support
- [ ] Batch processing
- [ ] Material/texture support
- [ ] WebGL visualization (instead of Plotly)
- [ ] Download as 3D model (GLB/OBJ)
- [ ] Progress bar for large voxelizations

---

## 📄 License

MIT

---

## 🤝 Contributing

Contributions welcome! Feel free to open issues or submit PRs.

---

**Happy Voxelizing! 🎲✨**
