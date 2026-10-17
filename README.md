# BlockBuddy

Simple 3D block modeler for kids. Builds models for three.js games.

**Run:** double-click `index.html`. No server or install needed.
**Rebuild after editing `src/`:** `npm install` once, then `npm run build` (or `npm run dev` to watch).

## What it does
- **Shapes:** box, ball, can, cone, pyramid, ramp. Move / Turn / Size gizmos (snap to grid).
- **Points:** pick **Dots**, **Edges** or **Faces** and drag them with Move / Turn / Size (Shift-click picks more, Shift+drag draws a box that picks everything inside, even behind the shape; click right on a face in Faces mode). **Extrude** pushes picked faces out with side walls, or pulls a flap out of one edge. Keys: `1` `2` `3` modes, `M` `T` `S` gizmo, `E` extrude. Swap a part's shape type and keep its size.
- **Blender-style editing:** `G` move, `R` rotate, `S` scale (works on parts and on picked dots/edges/faces), then `X`/`Y`/`Z` to lock an axis or type a number. `Tab` toggles edit points, `A` / `Alt+A` / `Ctrl+I` pick all / none / flip, `Alt+click` picks an edge loop or face loop, ring buttons pick everything on a level, `I` inset, `X` delete faces, `Shift+D` copy, numpad views. Press `?` in the app for the full list.
- **🛠️ Advanced mode** (button at the top, remembered): Blender-style `G`/`R`/`S`, loop and ring select, inset, delete, **bevel**, **merge dots**, **extrude dots + fill** (build faces from loose dots), **face colors** (🖌️ Paint tool or pick faces then a swatch; saved in the game file as vertex colors), and **bone editing** (add, rename, re-parent, mirror, delete bones; build a skeleton on any model). Simple mode hides all of it.
- **Mirror:** "Make a mirror twin" copies a part across the pink line (x = 0). Twins stay linked: change one, the other follows (move, size, points, color, pattern, add-ons).
- **More dots:** "split the Height / Width / Depth" adds a new ring of dots across a shape (a loop cut). It cuts in the widest gap, so repeat to add more. Twins follow.
- **Stuck to:** any part can be stuck to another part or a bone ("Stick to something…", then click the target) or unstuck. It stays put and follows its new parent. A twin moves to the mirror of the new parent. Turn on "New shapes stick onto the one I picked" in Helpers to attach new shapes automatically.
- **Stick on:** add shapes as children of a part (hats, eyes, buttons). They follow the parent.
- **Color + patterns:** 16 colors plus any color, 11 patterns that take the part color, pattern size slider, own picture.
- **Buddies:** Person, Dog, Cat, Horse, Bird with bones and pose presets. Tree, House, Table starters.
- **Pose tab:** presets, plus drag rings on any bone. Orange dots are the bones.
- **Undo/redo**, autosave (browser storage), Save/Open `.blockbuddy.json`.

## 🎮 Play mode (physics sandbox)
Press **🎮 Play** at the top to drop your model into a playground. Everything lives under the **☰ Menu** button (`M`): Play as, Ride, Gear, Go to, Cars, Ride an animal, My models. **❓ Controls** (or `H`) shows and hides the controls box.

| | |
|---|---|
| `W A S D` + `Shift` | walk / run |
| `Space` | jump, press again in the air to double jump (birds flap to fly) |
| `C` / `X` | crouch (hold) / crawl (toggle). Low tunnels and beams make you duck by yourself |
| walk into the brown wall | climb (`W` `S` `A` `D`, `Space` to leap off), you pull yourself over the top |
| run + jump beside a wall | wall run. It runs steady for a distance, then slows and arcs down. `Space` wall-jumps off |
| run + jump at a wall | wall run up, same slow-down and arc (onto a climbing wall it grabs on at the top) |
| `E` / click | pick up / drop the crate or ball in front of you |
| click or `F` while holding | throw, hold longer to throw harder |
| `1` `2` `3` | spawn a box, a ball, or **your model as a throwable toy** |
| `R` / `T` | new playground / back to start |

### 🛹 Skateboard, scooter, roller skates
`V` (or the Ride buttons) swaps what you ride. Everyone can ride, even the horse.

| | |
|---|---|
| `W` push · `A` `D` steer · `S` brake | momentum matters: ramps slow you down uphill and speed you up downhill, holding `W` on a ramp "pumps" it |
| `Space` | ollie |
| `J` `K` `L` in the air | skateboard: kickflip, heelflip, shove-it. scooter: barspin, tailwhip, tabletop (hold). skates: front flip, back flip, spread eagle (hold) |
| `G` hold in the air | grab |
| hold `A`/`D` in the air | spin (land every half turn, you ride switch) |
| rails | land on a rail to grind, `Space` jumps off |

Tricks stack into a combo. Land clean to bank it (points × number of tricks); land crooked, mid-trick or sideways and you bail and lose the combo. The skate park has a halfpipe, rails, a kicker, a fun box and a ledge.

### ⚔️ Foam swords and dart guns, 🏙️ the city, 🚗 cars, 🐴 riding animals
- **Gear:** `Q` cycles foam sword, giant foam sword, dart pistol, foam blaster and mega shooter (or the Gear section). Click / `F` swings or shoots, `Z` reloads. Swing at crates, balloons and foam dummies, shoot balloons and bullseyes at the target range. Guns aim where the camera points (crosshair).
- **City:** a block city of climbable buildings (walk into any wall to climb, mantle onto the roof), alleys for wall running, sky bridges, launch pads, a plaza with stairs / rail / ledge / quarter pipe, and sedans on the streets.
- **Zones:** the Go to menu section (or `Y`) jumps to the start, skate park, city or target range. `T` goes home.
- **Driving:** walk up to a car, kart, truck or hovercraft and press `E`. `W`/`S` gas and reverse, `A`/`D` steer, `Space` brake (hop for the hovercraft), `Shift` boost, `U` flip upright, `E` get out. The **Cars** section spawns more.
- **Riding animals:** the **Ride an animal** section (Horse, Dog, Cat, My animal). You become the animal (it runs, jumps and climbs as it always does) with your old character sitting on its back. **Get off** hops down.
- **Add your own files:** **📂 Add my saved model…** (or drag a `.json` onto the picture) drops a saved BlockBuddy model into the playground. Small models are toys, huge ones are solid and climbable, and models marked below do their job.

### ⚙️ "What can it do?" (in the editor, left panel)
Mark a model as: **drives** (car), **hovers**, **rideable animal**, **shoots things** or **swingable**. It is saved in the file, so it works when loaded into Play. Pick a part and give it a job:

| model is | part jobs |
|---|---|
| car | Wheel, Front wheel (steers), Seat. "Find the wheels for me" marks round parts near the bottom. No wheels marked? It still drives. |
| hovercraft | Seat |
| rideable animal | Saddle. Needs the bones of the premade animals (the premade horse, dog and cat are already marked) |
| shooter | Muzzle (shots come out here), Grip (hand holds here). Shoots foam darts, bouncy balls or confetti, one at a time or hold to keep shooting |
| swingable | Grip (hand holds here). The long side becomes the blade |

Your marked model appears in Play automatically: shooters and swingables in the gear bar, cars under **My vehicle**, animals under **My animal**.

Legs are procedural IK, so feet land on stairs and ramps and every limb steps for itself. Hands reach for what you carry. The world scales to your model (a cat gets a small playground).
For **your own animals**, name the limb bones like the premade ones: `LeftHip` -> `LeftKnee` -> `LeftAnkle` (or `FrontLeftShoulder` -> `FrontLeftKnee`, also `Left/RightShoulder` -> `Elbow` -> `Wrist` for arms). Bones named `Hips`, `Spine`, `Neck`, `Head`, `Tail…` and `LeftWing`/`RightWing` get extra motion. A model with no limb bones slides around.
Physics is [cannon-es](https://github.com/pmndrs/cannon-es), bundled in.

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
- `src/editmesh.js` faces, edges, extrude, inset, bevel, merge, fill, loops
- `src/play.js` Play mode: world, character controller, IK walker
- `src/ride.js` skateboard, scooter, roller skate models and tricks
- `src/gear.js` foam swords, dart guns, darts
- `src/main.js` scene, gizmos, picking, UI, export

## Not built yet (ideas)
Per-face patterns, bevel with several segments, animation timeline, true skinned meshes, free-form skeleton building, mirror for parts on the center line.
