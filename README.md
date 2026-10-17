# BlockBuddy

Simple 3D block modeler for kids. Builds models for three.js games.

**Run:** double-click `index.html`. No server or install needed.
**Rebuild after editing `src/`:** `npm install` once, then `npm run build` (or `npm run dev` to watch).

## What it does
- **Shapes:** box, ball, can, cone, pyramid, ramp. Move / Turn / Size gizmos (snap to grid).
- **Points:** pick **Dots**, **Edges** or **Faces** and drag them with Move / Turn / Size (Shift-click picks more, Shift+drag draws a box that picks everything inside, even behind the shape; click right on a face in Faces mode). **Extrude** pushes picked faces out with side walls, or pulls a flap out of one edge. Keys: `1` `2` `3` modes, `M` `T` `S` gizmo, `E` extrude. Swap a part's shape type and keep its size.
- **Mirror:** "Make a mirror twin" copies a part across the pink line (x = 0). Twins stay linked: change one, the other follows (move, size, points, color, pattern, add-ons).
- **More dots:** "split the Height / Width / Depth" adds a new ring of dots across a shape (a loop cut). It cuts in the widest gap, so repeat to add more. Twins follow.
- **Stuck to:** any part can be stuck to another part or a bone ("Stick to something…", then click the target) or unstuck. It stays put and follows its new parent. A twin moves to the mirror of the new parent. Turn on "New shapes stick onto the one I picked" in Helpers to attach new shapes automatically.
- **Stick on:** add shapes as children of a part (hats, eyes, buttons). They follow the parent.
- **Color + patterns:** 16 colors plus any color, 11 patterns that take the part color, pattern size slider, own picture.
- **Buddies:** Person, Dog, Bird with bones and pose presets. Tree, House, Table starters.
- **Pose tab:** presets, plus drag rings on any bone. Orange dots are the bones.
- **Undo/redo**, autosave (browser storage), Save/Open `.blockbuddy.json`.

## Export for three.js
"Export for game" writes a `.glb`. The rig is a node hierarchy: bones are plain nodes
(`Hips`, `Spine`, `LeftShoulder`, `RightKnee`, ...) with the shapes parented under them.
Spaces in names become `_`. Characters face +Z, Y is up, 1 unit = 1 meter. "Left" is the +X side.

```js
const gltf = await new GLTFLoader().loadAsync('person.glb');
gltf.scene.getObjectByName('LeftShoulder').rotation.z = Math.PI / 2; // raise left arm
```

It is **not** a SkinnedMesh. Each shape moves rigidly with its bone, which suits blocky art.
Animate by rotating bones by name, or build an AnimationClip with tracks like `LeftShoulder.quaternion`.

## Code map
- `src/geom.js` shapes, flat-shaded geometry, box-projected UVs, mirror and point-group helpers
- `src/textures.js` pattern canvases and materials
- `src/nodes.js` joints and parts, twins/mirroring, save/load
- `src/rigs.js` buddy and starter builders, pose presets
- `src/main.js` scene, gizmos, picking, UI, export

## Not built yet (ideas)
Extruding dots, deleting faces, inset, animation timeline, true skinned meshes, free-form skeleton building, mirror for parts on the center line.
