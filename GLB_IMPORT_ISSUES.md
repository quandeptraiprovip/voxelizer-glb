# GLB Import Issues - Detailed Analysis

## Vấn đề chính khi mesh preview khác với Blender

### 1. **Transform Matrices không được áp dụng** ⚠️ CRITICAL

**Tình trạng hiện tại:**
```
Blender: Hiển thị model với tất cả transforms (position, rotation, scale) đã áp dụng
App: Chỉ extract geometry, bỏ qua tất cả node transforms
```

**Kết quả:**
- Model bị lệch vị trí (không có translation)
- Model bị xoay sai (không có rotation)
- Model bị scale sai (không có scale)

**Nguyên nhân:**
File GLB có structure:
```
Scene
├─ Node_0 (translation=[5, 0, 0], mesh=0)
├─ Node_1 (rotation=[45°], mesh=1)
└─ Node_2 (scale=[2, 2, 2], mesh=2)
```

Parser hiện tại chỉ extract `mesh=0,1,2` mà không apply transforms từ nodes.

**Cách Blender xử lý:**
1. Parse scene hierarchy
2. Accumulate transforms từ root → leaf nodes
3. Apply world transform lên mỗi mesh
4. Render geometry với transforms đã áp dụng

---

### 2. **Scene Hierarchy không được support** ⚠️ CRITICAL

**Tình trạng:**
```
Khi GLB có parent-child relationships như:
Node_0 (parent, matrix = [scale 2])
  └─ Node_1 (child, matrix = [translate 5])
      └─ Node_2 (child, mesh)
```

**Vấn đề:**
- Current parser: áp dụng chỉ `translate 5` từ Node_1
- Đúng: phải apply `scale 2 × translate 5` = world transform

**Công thức chính xác:**
```
world_transform = root_matrix × parent_matrix × node_matrix

Trong code:
for each node:
    accumulated = parent_accumulated × node_local
    apply(accumulated) to node's mesh
```

---

### 3. **Normal Vector Transform sai** ⚠️ IMPORTANT

**Vấn đề:**
Nếu apply full matrix lên normals, chúng sẽ bị scale và deform.

**Ví dụ:**
```
Node scale = [2, 2, 2]
Normal = [0, 1, 0]

Sai: [0, 1, 0] × [2, 2, 2] = [0, 2, 0] ← Không phải unit vector!
Đúng: [0, 1, 0] (normals không đổi, chỉ rotation được áp dụng)
```

**Quy tắc:**
- Positions: apply full matrix (translation + rotation + scale)
- Normals: apply inverse-transpose của (rotation + scale) matrix ONLY
- Formula: `normal_out = inv(transpose(mat3)) × normal_in`

---

### 4. **Indices Offset sai** ⚠️ INTERMEDIATE

**Vấn đề:**
Khi merge nhiều meshes, indices từ primitives khác nhau phải được offset.

**Ví dụ:**
```
Mesh 0: vertices [0-10], indices [0, 1, 2, ...]
Mesh 1: vertices [0-8],  indices [0, 1, 2, ...] ← NEED TO ADD OFFSET!

Merged:
vertices [0-18]
indices: [0, 1, 2, ... | 11, 12, 13, ...] ← indices từ Mesh 1 được offset +11
```

**Current code:**
✓ Đã handle đúng (lines 220-236 trong voxelizer.ts)

---

### 5. **Material Colors không consistent** ⚠️ MINOR

**Vấn đề:**
Blender show material colors, nhưng parser có priority order:
```
1. Try baseColorFactor (PBR)
2. Fallback to color property
3. Fallback to emissive
```

Không phải lúc nào cũng match với Blender display.

**Nếu không có colors:**
```
Current: Fallback to position-based gradient
Blender: Fallback to default material gray
```

---

### 6. **Multiple Primitives per Mesh** ⚠️ INTERMEDIATE

**Vấn đề:**
GLB spec cho phép 1 mesh có nhiều primitives (mỗi primitive = material khác).

```
Mesh_0:
  ├─ Primitive_0 (material=0, vertices=0-100)
  ├─ Primitive_1 (material=1, vertices=100-200)
  └─ Primitive_2 (material=2, vertices=200-300)
```

**Current code:**
✓ Đã handle (merges tất cả primitives)

---

### 7. **Orphaned Meshes** ⚠️ WARNING

**Vấn đề:**
Nếu mesh không được referenced bởi node nào:
```
Meshes: [mesh_0, mesh_1, mesh_2]
Nodes: [node_0→mesh_1, node_1→mesh_1]
        mesh_0 không dùng, mesh_2 không dùng
```

**Current code:**
✗ Vẫn include cả 3 meshes
**Should be:**
✓ Chỉ include mesh_1 hoặc warn user

---

## Debug Checklist

Khi mesh preview khác với Blender, kiểm tra:

- [ ] **Vị trí (Position)**
  - Blender: Model ở vị trí nào?
  - App: Model ở vị trí nào?
  - Check: Node có `translation` không?

- [ ] **Rotation**
  - Blender: Model xoay bao nhiêu độ?
  - App: Model xoay bao nhiêu độ?
  - Check: Node có `rotation` (quaternion) không?

- [ ] **Scale**
  - Blender: Model size bao nhiêu?
  - App: Model size bao nhiêu?
  - Check: Node có `scale` không? Có non-uniform scale không?

- [ ] **Hierarchy**
  - Blender: Model có nested objects không?
  - App: Parser có accumulate transforms không?
  - Check: Node có `children` không?

- [ ] **Multiple Meshes**
  - Blender: Có bao nhiêu objects?
  - App: Bao nhiêu meshes được merge?
  - Check: Geometry position/normal có offset sai không?

---

## Cách sử dụng GLB Debug Panel

1. Vào trang app
2. Scroll xuống tìm "🔍 GLB Debug Analyzer"
3. Upload GLB file
4. Xem report, tìm:
   - **Critical issues**: Stop, cần fix file
   - **Transforms**: Xem có translation/rotation/scale không
   - **Hierarchy**: Xem scene structure
   - **Orphaned meshes**: Xem mesh nào không dùng

---

## Code Changes Needed

### Priority 1 (Critical):
- [ ] Apply node transforms (translation, rotation, scale)
- [ ] Accumulate transforms từ parent hierarchy
- [ ] Transform normals bằng inverse-transpose

### Priority 2 (Important):
- [ ] Detect và warn orphaned meshes
- [ ] Improve material color fallback
- [ ] Handle non-uniform scales properly

### Priority 3 (Nice-to-have):
- [ ] Support animations
- [ ] Support texture loading
- [ ] Cache parsed geometry
