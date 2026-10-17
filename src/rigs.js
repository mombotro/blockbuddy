import { makeJoint as J, makePart as P, mirrorSubtree as M } from './nodes.js';

// Buddies face +Z, up is +Y. "Left" is the +X side (the character's own left).
// Pose entries are [x, y, z] degrees applied on top of the joint's rest rotation.
// Rotation hints: +x tips things backward (knee bend), -x swings legs/arms forward,
// +z on a Left joint lifts the arm out to the side (use -z on the Right side).

const SKIN = '#fcd5b0';

function person(model) {
  const shirt = '#3b82f6';
  const pants = '#92400e';
  const hips = J('Hips', model, [0, 0.95, 0]);
  const spine = J('Spine', hips, [0, 1.1, 0]);
  const neck = J('Neck', spine, [0, 1.48, 0]);
  const head = J('Head', neck, [0, 1.56, 0]);

  P('box', hips, [0, 0.97, 0], [0.34, 0.2, 0.2], { color: pants, name: 'Pelvis' });
  P('box', spine, [0, 1.28, 0], [0.38, 0.42, 0.22], { color: shirt, name: 'Torso' });
  const h = P('box', head, [0, 1.72, 0], [0.3, 0.3, 0.3], { color: SKIN, name: 'Head' });
  M(P('ball', h, [0.075, 1.74, 0.155], [0.05, 0.05, 0.05], { color: '#111827', name: 'LeftEye' }), h);
  P('box', h, [0, 1.65, 0.15], [0.08, 0.03, 0.02], { color: '#be185d', name: 'Mouth' });

  const sh = J('LeftShoulder', spine, [0.23, 1.45, 0]);
  const el = J('LeftElbow', sh, [0.23, 1.2, 0]);
  const wr = J('LeftWrist', el, [0.23, 0.95, 0]);
  P('box', sh, [0.23, 1.325, 0], [0.12, 0.28, 0.12], { color: shirt, name: 'LeftUpperArm' });
  P('box', el, [0.23, 1.075, 0], [0.1, 0.26, 0.1], { color: SKIN, name: 'LeftForearm' });
  P('box', wr, [0.23, 0.9, 0], [0.1, 0.1, 0.1], { color: SKIN, name: 'LeftHand' });
  M(sh, spine);

  const hp = J('LeftHip', hips, [0.1, 0.92, 0]);
  const kn = J('LeftKnee', hp, [0.1, 0.5, 0]);
  const an = J('LeftAnkle', kn, [0.1, 0.08, 0]);
  P('box', hp, [0.1, 0.72, 0], [0.16, 0.44, 0.16], { color: pants, name: 'LeftThigh' });
  P('box', kn, [0.1, 0.3, 0], [0.13, 0.42, 0.13], { color: pants, name: 'LeftShin' });
  P('box', an, [0.1, 0.04, 0.05], [0.14, 0.08, 0.26], { color: '#1f2937', name: 'LeftFoot' });
  M(hp, hips);
}

const personPoses = [
  { name: 'Stand', icon: '🧍', rot: {} },
  {
    name: 'Wave',
    icon: '👋',
    rot: { RightShoulder: [0, 0, -150], RightElbow: [0, 0, -35] },
  },
  {
    name: 'Hooray',
    icon: '🙌',
    rot: { LeftShoulder: [0, 0, 160], RightShoulder: [0, 0, -160] },
  },
  {
    name: 'T-pose',
    icon: '🤸',
    rot: { LeftShoulder: [0, 0, 90], RightShoulder: [0, 0, -90] },
  },
  {
    name: 'Walk',
    icon: '🚶',
    rot: {
      LeftHip: [-28, 0, 0],
      RightHip: [28, 0, 0],
      RightKnee: [30, 0, 0],
      LeftShoulder: [25, 0, 0],
      RightShoulder: [-25, 0, 0],
      RightElbow: [-25, 0, 0],
      LeftElbow: [-10, 0, 0],
    },
  },
  {
    name: 'Run',
    icon: '🏃',
    rot: {
      Spine: [14, 0, 0],
      LeftHip: [-55, 0, 0],
      LeftKnee: [20, 0, 0],
      RightHip: [35, 0, 0],
      RightKnee: [85, 0, 0],
      LeftShoulder: [50, 0, 0],
      LeftElbow: [-85, 0, 0],
      RightShoulder: [-55, 0, 0],
      RightElbow: [-85, 0, 0],
    },
  },
  {
    name: 'Sit',
    icon: '🪑',
    drop: -0.45,
    rot: { LeftHip: [-90, 0, 0], RightHip: [-90, 0, 0], LeftKnee: [90, 0, 0], RightKnee: [90, 0, 0] },
  },
  {
    name: 'Kick',
    icon: '⚽',
    rot: {
      RightHip: [-75, 0, 0],
      RightKnee: [10, 0, 0],
      LeftShoulder: [0, 0, 50],
      RightShoulder: [0, 0, -50],
      Spine: [-6, 0, 0],
    },
  },
];

function dog(model) {
  const fur = '#c08a4f';
  const dark = '#7c4a21';
  const hips = J('Hips', model, [0, 0.5, -0.15]);
  const spine = J('Spine', hips, [0, 0.52, 0.1]);
  const neck = J('Neck', spine, [0, 0.58, 0.28]);
  const head = J('Head', neck, [0, 0.68, 0.4]);
  const tail = J('Tail', hips, [0, 0.58, -0.36]);

  P('box', hips, [0, 0.5, -0.2], [0.26, 0.26, 0.3], { color: fur, name: 'Rump' });
  P('box', spine, [0, 0.52, 0.12], [0.28, 0.28, 0.34], { color: fur, name: 'Chest' });
  P('box', neck, [0, 0.62, 0.32], [0.14, 0.22, 0.14], { color: fur, name: 'Neck' });
  const h = P('box', head, [0, 0.74, 0.43], [0.2, 0.2, 0.22], { color: fur, name: 'Head' });
  P('box', h, [0, 0.7, 0.58], [0.11, 0.09, 0.12], { color: '#e8c9a0', name: 'Snout' });
  P('box', h, [0, 0.725, 0.65], [0.05, 0.04, 0.03], { color: '#111827', name: 'Nose' });
  M(P('ball', h, [0.05, 0.78, 0.53], [0.035, 0.035, 0.035], { color: '#111827', name: 'LeftEye' }), h);
  M(P('box', h, [0.11, 0.78, 0.4], [0.05, 0.16, 0.1], { color: dark, name: 'LeftEar' }), h);
  P('box', tail, [0, 0.62, -0.46], [0.06, 0.06, 0.26], { color: fur, name: 'Tail' });

  // front leg
  const fs = J('FrontLeftShoulder', spine, [0.1, 0.42, 0.25]);
  const fk = J('FrontLeftKnee', fs, [0.1, 0.24, 0.25]);
  P('box', fs, [0.1, 0.33, 0.25], [0.09, 0.2, 0.09], { color: fur, name: 'FrontLeftUpperLeg' });
  const fl = P('box', fk, [0.1, 0.12, 0.25], [0.08, 0.24, 0.08], { color: fur, name: 'FrontLeftLowerLeg' });
  P('box', fl, [0.1, 0.03, 0.28], [0.1, 0.06, 0.14], { color: dark, name: 'FrontLeftPaw' });
  M(fs, spine);
  // back leg
  const bh = J('BackLeftHip', hips, [0.1, 0.42, -0.27]);
  const bk = J('BackLeftKnee', bh, [0.1, 0.25, -0.3]);
  P('box', bh, [0.1, 0.34, -0.28], [0.1, 0.22, 0.14], { color: fur, name: 'BackLeftUpperLeg' });
  const bl = P('box', bk, [0.1, 0.12, -0.3], [0.08, 0.24, 0.08], { color: fur, name: 'BackLeftLowerLeg' });
  P('box', bl, [0.1, 0.03, -0.27], [0.1, 0.06, 0.14], { color: dark, name: 'BackLeftPaw' });
  M(bh, hips);
}

const dogPoses = [
  { name: 'Stand', icon: '🐕', rot: {} },
  {
    name: 'Sit',
    icon: '🐶',
    drop: -0.14,
    rot: {
      Hips: [-38, 0, 0],
      BackLeftHip: [-55, 0, 0],
      BackRightHip: [-55, 0, 0],
      BackLeftKnee: [95, 0, 0],
      BackRightKnee: [95, 0, 0],
      Neck: [10, 0, 0],
    },
  },
  {
    name: 'Walk',
    icon: '🦮',
    rot: {
      FrontLeftShoulder: [-25, 0, 0],
      FrontRightShoulder: [25, 0, 0],
      BackLeftHip: [25, 0, 0],
      BackRightHip: [-25, 0, 0],
      FrontRightKnee: [20, 0, 0],
      BackLeftKnee: [20, 0, 0],
    },
  },
  {
    name: 'Run',
    icon: '💨',
    rot: {
      Spine: [-8, 0, 0],
      FrontLeftShoulder: [-50, 0, 0],
      FrontRightShoulder: [-45, 0, 0],
      BackLeftHip: [45, 0, 0],
      BackRightHip: [40, 0, 0],
      BackLeftKnee: [50, 0, 0],
      BackRightKnee: [50, 0, 0],
      Tail: [-30, 0, 0],
    },
  },
  {
    name: 'Lie down',
    icon: '😴',
    drop: -0.2,
    rot: {
      FrontLeftShoulder: [-80, 0, 0],
      FrontRightShoulder: [-80, 0, 0],
      FrontLeftKnee: [10, 0, 0],
      FrontRightKnee: [10, 0, 0],
      BackLeftHip: [-80, 0, 0],
      BackRightHip: [-80, 0, 0],
      BackLeftKnee: [120, 0, 0],
      BackRightKnee: [120, 0, 0],
      Neck: [20, 0, 0],
    },
  },
  {
    name: 'Sniff',
    icon: '👃',
    rot: { Neck: [40, 0, 0], Head: [15, 0, 0], Spine: [8, 0, 0], Tail: [0, 28, 0] },
  },
];

function bird(model) {
  const body = '#3b82f6';
  const wing = '#1d4ed8';
  const orange = '#f59e0b';
  const hips = J('Hips', model, [0, 0.34, 0]);
  const head = J('Head', hips, [0, 0.5, 0.14]);
  const tail = J('Tail', hips, [0, 0.4, -0.17]);
  P('ball', hips, [0, 0.38, 0], [0.28, 0.26, 0.4], { color: body, name: 'Body' });
  const h = P('ball', head, [0, 0.56, 0.2], [0.17, 0.17, 0.17], { color: body, name: 'Head' });
  P('cone', h, [0, 0.55, 0.3], [0.06, 0.1, 0.06], { color: orange, rot: [90, 0, 0], name: 'Beak' });
  M(P('ball', h, [0.05, 0.59, 0.27], [0.035, 0.035, 0.035], { color: '#111827', name: 'LeftEye' }), h);
  P('box', tail, [0, 0.4, -0.3], [0.12, 0.03, 0.2], { color: wing, name: 'Tail' });

  const w = J('LeftWing', hips, [0.12, 0.42, 0]);
  P('box', w, [0.25, 0.42, 0], [0.26, 0.025, 0.22], { color: wing, name: 'LeftWing' });
  M(w, hips);
  const lg = J('LeftLeg', hips, [0.06, 0.24, 0]);
  const l = P('cylinder', lg, [0.06, 0.13, 0], [0.02, 0.22, 0.02], { color: orange, name: 'LeftLegBone' });
  P('box', l, [0.06, 0.01, 0.03], [0.06, 0.02, 0.1], { color: orange, name: 'LeftFoot' });
  M(lg, hips);
}

const birdPoses = [
  { name: 'Wings out', icon: '🦅', rot: {} },
  {
    name: 'Perch',
    icon: '🐦',
    rot: { LeftWing: [0, 0, -80], RightWing: [0, 0, 80] },
  },
  { name: 'Fly up', icon: '🕊️', rot: { LeftWing: [0, 0, 40], RightWing: [0, 0, -40] } },
  { name: 'Fly down', icon: '🪽', rot: { LeftWing: [0, 0, -35], RightWing: [0, 0, 35] } },
  {
    name: 'Peck',
    icon: '🌾',
    rot: { Hips: [35, 0, 0], Head: [20, 0, 0], LeftWing: [0, 0, -80], RightWing: [0, 0, 80] },
  },
  {
    name: 'Sing',
    icon: '🎵',
    rot: { Hips: [-20, 0, 0], Head: [-20, 0, 0], LeftWing: [0, 0, -80], RightWing: [0, 0, 80] },
  },
];

function cat(model) {
  const fur = '#f59e0b';
  const dark = '#b45309';
  const cream = '#fde68a';
  const pink = '#f9a8d4';
  const hips = J('Hips', model, [0, 0.3, -0.1]);
  const spine = J('Spine', hips, [0, 0.31, 0.08]);
  const neck = J('Neck', spine, [0, 0.36, 0.2]);
  const head = J('Head', neck, [0, 0.42, 0.26]);
  const tail = J('Tail', hips, [0, 0.33, -0.22]);
  const tip = J('TailTip', tail, [0, 0.4, -0.4]);

  P('box', hips, [0, 0.3, -0.12], [0.17, 0.17, 0.24], { color: fur, pattern: 'stripes', name: 'Rump' });
  P('box', spine, [0, 0.31, 0.1], [0.18, 0.18, 0.2], { color: fur, pattern: 'stripes', name: 'Chest' });
  P('box', neck, [0, 0.37, 0.21], [0.1, 0.12, 0.08], { color: fur, name: 'Neck' });
  const h = P('box', head, [0, 0.43, 0.29], [0.15, 0.13, 0.12], { color: fur, name: 'Head' });
  P('box', h, [0, 0.405, 0.36], [0.06, 0.045, 0.04], { color: cream, name: 'Muzzle' });
  P('box', h, [0, 0.425, 0.383], [0.025, 0.02, 0.01], { color: pink, name: 'Nose' });
  M(P('ball', h, [0.04, 0.45, 0.35], [0.03, 0.03, 0.03], { color: '#22c55e', name: 'LeftEye' }), h);
  M(P('pyramid', h, [0.05, 0.51, 0.27], [0.05, 0.06, 0.04], { color: fur, name: 'LeftEar' }), h);
  M(P('box', h, [0.1, 0.41, 0.34], [0.08, 0.005, 0.005], { color: '#f3f4f6', name: 'LeftWhisker1', rot: [0, 0, 8] }), h);
  M(P('box', h, [0.1, 0.395, 0.34], [0.08, 0.005, 0.005], { color: '#f3f4f6', name: 'LeftWhisker2', rot: [0, 0, -8] }), h);
  P('box', tail, [0, 0.365, -0.31], [0.04, 0.04, 0.2], { color: fur, pattern: 'stripes', name: 'Tail', rot: [25, 0, 0] });
  P('box', tip, [0, 0.45, -0.46], [0.04, 0.04, 0.16], { color: dark, name: 'TailTip', rot: [60, 0, 0] });

  const fs = J('FrontLeftShoulder', spine, [0.06, 0.24, 0.1]);
  const fk = J('FrontLeftKnee', fs, [0.06, 0.13, 0.1]);
  P('box', fs, [0.06, 0.185, 0.1], [0.05, 0.12, 0.06], { color: fur, name: 'FrontLeftUpperLeg' });
  const fl = P('box', fk, [0.06, 0.07, 0.1], [0.04, 0.14, 0.05], { color: fur, name: 'FrontLeftLowerLeg' });
  P('box', fl, [0.06, 0.02, 0.115], [0.05, 0.04, 0.075], { color: cream, name: 'FrontLeftPaw' });
  M(fs, spine);
  const bh = J('BackLeftHip', hips, [0.07, 0.26, -0.2]);
  const bk = J('BackLeftKnee', bh, [0.07, 0.14, -0.22]);
  P('box', bh, [0.07, 0.2, -0.2], [0.06, 0.13, 0.1], { color: fur, name: 'BackLeftUpperLeg' });
  const bl = P('box', bk, [0.07, 0.07, -0.22], [0.04, 0.14, 0.05], { color: fur, name: 'BackLeftLowerLeg' });
  P('box', bl, [0.07, 0.02, -0.205], [0.05, 0.04, 0.075], { color: cream, name: 'BackLeftPaw' });
  M(bh, hips);
}

const catPoses = [
  { name: 'Stand', icon: '🐈', rot: {} },
  {
    name: 'Sit',
    icon: '😺',
    drop: -0.08,
    rot: {
      Hips: [-40, 0, 0],
      BackLeftHip: [-50, 0, 0],
      BackRightHip: [-50, 0, 0],
      BackLeftKnee: [100, 0, 0],
      BackRightKnee: [100, 0, 0],
      Neck: [12, 0, 0],
    },
  },
  {
    name: 'Walk',
    icon: '🐾',
    rot: {
      FrontLeftShoulder: [-25, 0, 0],
      FrontRightShoulder: [25, 0, 0],
      BackLeftHip: [25, 0, 0],
      BackRightHip: [-25, 0, 0],
      FrontRightKnee: [25, 0, 0],
      BackLeftKnee: [25, 0, 0],
    },
  },
  {
    name: 'Pounce',
    icon: '💥',
    drop: -0.04,
    rot: {
      Spine: [-12, 0, 0],
      FrontLeftShoulder: [-60, 0, 0],
      FrontRightShoulder: [-60, 0, 0],
      BackLeftHip: [50, 0, 0],
      BackRightHip: [50, 0, 0],
      BackLeftKnee: [55, 0, 0],
      BackRightKnee: [55, 0, 0],
      Tail: [-20, 0, 0],
    },
  },
  {
    name: 'Loaf',
    icon: '🍞',
    drop: -0.15,
    rot: {
      FrontLeftShoulder: [-70, 0, 0],
      FrontRightShoulder: [-70, 0, 0],
      FrontLeftKnee: [140, 0, 0],
      FrontRightKnee: [140, 0, 0],
      BackLeftHip: [-70, 0, 0],
      BackRightHip: [-70, 0, 0],
      BackLeftKnee: [140, 0, 0],
      BackRightKnee: [140, 0, 0],
      Tail: [0, 35, 0],
    },
  },
  {
    name: 'Stretch',
    icon: '🙆',
    drop: -0.06,
    rot: {
      Spine: [22, 0, 0],
      Neck: [-20, 0, 0],
      FrontLeftShoulder: [-75, 0, 0],
      FrontRightShoulder: [-75, 0, 0],
      FrontLeftKnee: [-15, 0, 0],
      FrontRightKnee: [-15, 0, 0],
      Hips: [-8, 0, 0],
      Tail: [-30, 0, 0],
    },
  },
  { name: 'Tail swish', icon: '〰️', rot: { Tail: [0, 30, 0], TailTip: [0, 40, 0], Head: [0, 15, 0] } },
];

function horse(model) {
  const coat = '#8b5a2b';
  const dark = '#2b1a0e';
  const hoof = '#374151';
  const hips = J('Hips', model, [0, 1.0, -0.4]);
  const spine = J('Spine', hips, [0, 1.05, 0.1]);
  const neck = J('Neck', spine, [0, 1.2, 0.5]);
  const head = J('Head', neck, [0, 1.6, 0.78]);
  const tail = J('Tail', hips, [0, 1.1, -0.68]);

  P('box', hips, [0, 1.0, -0.38], [0.5, 0.52, 0.55], { color: coat, name: 'Rump' });
  P('box', spine, [0, 1.0, 0.13], [0.52, 0.55, 0.55], { color: coat, name: 'Chest' });
  P('box', neck, [0, 1.4, 0.65], [0.22, 0.6, 0.26], { color: coat, name: 'Neck', rot: [30, 0, 0] });
  P('box', neck, [0, 1.46, 0.53], [0.06, 0.55, 0.12], { color: dark, name: 'Mane', rot: [30, 0, 0] });
  const h = P('box', head, [0, 1.62, 0.95], [0.2, 0.26, 0.46], { color: coat, name: 'Head', rot: [35, 0, 0] });
  P('box', h, [0, 1.53, 1.12], [0.14, 0.14, 0.14], { color: '#d6b48a', name: 'Muzzle', rot: [35, 0, 0] });
  M(P('ball', h, [0.1, 1.66, 0.97], [0.04, 0.04, 0.04], { color: '#111827', name: 'LeftEye' }), h);
  M(P('pyramid', h, [0.06, 1.85, 0.9], [0.06, 0.14, 0.06], { color: coat, name: 'LeftEar' }), h);
  P('box', tail, [0, 0.98, -0.74], [0.08, 0.5, 0.1], { color: dark, name: 'Tail', rot: [-12, 0, 0] });

  const fs = J('FrontLeftShoulder', spine, [0.17, 0.82, 0.32]);
  const fk = J('FrontLeftKnee', fs, [0.17, 0.5, 0.32]);
  const ff = J('FrontLeftFetlock', fk, [0.17, 0.14, 0.32]);
  P('box', fs, [0.17, 0.66, 0.32], [0.15, 0.36, 0.17], { color: coat, name: 'FrontLeftUpperLeg' });
  P('box', fk, [0.17, 0.32, 0.32], [0.09, 0.36, 0.1], { color: coat, name: 'FrontLeftLowerLeg' });
  P('box', ff, [0.17, 0.05, 0.325], [0.13, 0.1, 0.15], { color: hoof, name: 'FrontLeftHoof' });
  M(fs, spine);
  const bh = J('BackLeftHip', hips, [0.17, 0.85, -0.5]);
  const bk = J('BackLeftKnee', bh, [0.17, 0.5, -0.52]);
  const bf = J('BackLeftFetlock', bk, [0.17, 0.14, -0.52]);
  P('box', bh, [0.17, 0.68, -0.5], [0.17, 0.4, 0.22], { color: coat, name: 'BackLeftUpperLeg' });
  P('box', bk, [0.17, 0.32, -0.52], [0.09, 0.36, 0.1], { color: coat, name: 'BackLeftLowerLeg' });
  P('box', bf, [0.17, 0.05, -0.515], [0.13, 0.1, 0.15], { color: hoof, name: 'BackLeftHoof' });
  M(bh, hips);
}

const horsePoses = [
  { name: 'Stand', icon: '🐴', rot: {} },
  {
    name: 'Walk',
    icon: '🚶',
    rot: {
      FrontLeftShoulder: [-20, 0, 0],
      FrontRightShoulder: [15, 0, 0],
      FrontLeftKnee: [10, 0, 0],
      FrontRightKnee: [25, 0, 0],
      BackLeftHip: [15, 0, 0],
      BackRightHip: [-20, 0, 0],
      BackLeftKnee: [25, 0, 0],
      BackRightKnee: [10, 0, 0],
    },
  },
  {
    name: 'Trot',
    icon: '🏇',
    rot: {
      FrontLeftShoulder: [-35, 0, 0],
      FrontLeftKnee: [10, 0, 0],
      FrontRightShoulder: [20, 0, 0],
      FrontRightKnee: [70, 0, 0],
      FrontRightFetlock: [30, 0, 0],
      BackRightHip: [-30, 0, 0],
      BackRightKnee: [10, 0, 0],
      BackLeftHip: [20, 0, 0],
      BackLeftKnee: [70, 0, 0],
      BackLeftFetlock: [30, 0, 0],
      Tail: [-12, 0, 0],
    },
  },
  {
    name: 'Gallop',
    icon: '💨',
    rot: {
      Spine: [-6, 0, 0],
      Neck: [-12, 0, 0],
      FrontLeftShoulder: [-55, 0, 0],
      FrontLeftKnee: [10, 0, 0],
      FrontRightShoulder: [-42, 0, 0],
      FrontRightKnee: [40, 0, 0],
      BackLeftHip: [45, 0, 0],
      BackLeftKnee: [45, 0, 0],
      BackLeftFetlock: [30, 0, 0],
      BackRightHip: [38, 0, 0],
      BackRightKnee: [50, 0, 0],
      BackRightFetlock: [30, 0, 0],
      Tail: [-25, 0, 0],
    },
  },
  {
    name: 'Rear up',
    icon: '🦄',
    rot: {
      Hips: [-35, 0, 0],
      BackLeftHip: [35, 0, 0],
      BackRightHip: [35, 0, 0],
      FrontLeftShoulder: [-55, 0, 0],
      FrontRightShoulder: [-55, 0, 0],
      FrontLeftKnee: [95, 0, 0],
      FrontRightKnee: [95, 0, 0],
      Neck: [10, 0, 0],
    },
  },
  {
    name: 'Graze',
    icon: '🌾',
    rot: { Neck: [55, 0, 0], Head: [15, 0, 0], FrontLeftShoulder: [-18, 0, 0], FrontLeftKnee: [10, 0, 0], Tail: [0, 22, 0] },
  },
];

function tree(model) {
  P('cylinder', model, [0, 0.4, 0], [0.22, 0.8, 0.22], { color: '#92400e', pattern: 'planks', name: 'Trunk' });
  P('cone', model, [0, 1.15, 0], [1.0, 0.9, 1.0], { color: '#22c55e', pattern: 'fuzz', name: 'Leaves 1' });
  P('cone', model, [0, 1.6, 0], [0.75, 0.8, 0.75], { color: '#16a34a', pattern: 'fuzz', name: 'Leaves 2' });
}

function house(model) {
  P('box', model, [0, 0.4, 0], [1.3, 0.8, 1.0], { color: '#fde68a', pattern: 'bricks', name: 'Walls' });
  P('pyramid', model, [0, 1.05, 0], [1.6, 0.55, 1.3], { color: '#dc2626', pattern: 'stripes', name: 'Roof' });
  P('box', model, [0, 0.23, 0.51], [0.24, 0.46, 0.03], { color: '#92400e', pattern: 'planks', name: 'Door' });
  M(P('box', model, [0.4, 0.5, 0.51], [0.2, 0.2, 0.03], { color: '#7dd3fc', name: 'LeftWindow' }), model);
}

function table(model) {
  P('box', model, [0, 0.75, 0], [1.0, 0.06, 0.6], { color: '#b45309', pattern: 'planks', name: 'Table top' });
  const a = P('box', model, [0.43, 0.36, 0.23], [0.07, 0.72, 0.07], { color: '#92400e', name: 'LeftFrontLeg' });
  M(a, model);
  const b = P('box', model, [0.43, 0.36, -0.23], [0.07, 0.72, 0.07], { color: '#92400e', name: 'LeftBackLeg' });
  M(b, model);
}

// id -> { label, icon, build, rig (has bones), poses }
export const STARTERS = {
  person: { label: 'Person', icon: '🧑', build: person, rig: 'person', poses: personPoses },
  dog: { label: 'Dog', icon: '🐶', build: dog, rig: 'dog', poses: dogPoses },
  cat: { label: 'Cat', icon: '🐱', build: cat, rig: 'cat', poses: catPoses },
  horse: { label: 'Horse', icon: '🐴', build: horse, rig: 'horse', poses: horsePoses },
  bird: { label: 'Bird', icon: '🐦', build: bird, rig: 'bird', poses: birdPoses },
  tree: { label: 'Tree', icon: '🌲', build: tree, rig: null },
  house: { label: 'House', icon: '🏠', build: house, rig: null },
  table: { label: 'Table', icon: '🪑', build: table, rig: null },
};

export const posesFor = (rig) => (rig && STARTERS[rig] ? STARTERS[rig].poses : []);
