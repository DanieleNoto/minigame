import React, { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { Canvas, useFrame } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import { Physics, RigidBody } from '@react-three/rapier';

const ROTATE_TORQUE = 6;
const GAME_DURATION = 30;
const COLLECTIBLE_SCALE = 0.35;
const MAX_JUMPS = 2;
const CAMERA_DISTANCE = 8;
const CAMERA_HEIGHT = 3;
const CAMERA_FOLLOW_RATE = 24;
const MOUSE_SENSITIVITY = 0.0025;
const MAX_LOOK_PITCH = 1.2;
const UP = new THREE.Vector3(0, 1, 0);

const GROUND_TOP_Y = -1;
const GROUND_SIZE = 40;

const GOLDEN_ANGLE = 2.399963229728653;

function spiralXZ(index, count, radius, phase = 0) {
  const angle = index * GOLDEN_ANGLE + phase;
  const r = radius * Math.sqrt((index + 0.5) / count);
  return [Math.cos(angle) * r, Math.sin(angle) * r];
}

const OBSTACLE_COUNT = 18;
const OBSTACLE_RADIUS = 16;
const OBSTACLE_TYPES = ['box', 'cylinder', 'box', 'sphere', 'cylinder', 'box', 'box', 'cylinder'];
const OBSTACLE_COLORS = [
  '#ff5252', '#448aff', '#69f0ae', '#ffd740', '#e040fb', '#40c4ff',
  '#ff8a65', '#7c4dff', '#26c6da', '#d4e157', '#ff4081', '#8bc34a',
];

const OBSTACLES = Array.from({ length: OBSTACLE_COUNT }, (_, i) => {
  const [x, z] = spiralXZ(i, OBSTACLE_COUNT, OBSTACLE_RADIUS);
  const type = OBSTACLE_TYPES[i % OBSTACLE_TYPES.length];
  const color = OBSTACLE_COLORS[i % OBSTACLE_COLORS.length];
  if (type === 'cylinder') {
    return { x, z, type, radius: 0.6 + (i % 4) * 0.18, height: 0.8 + (i % 5) * 0.35, color };
  }
  if (type === 'sphere') {
    return { x, z, type, radius: 0.7 + (i % 3) * 0.2, color };
  }
  return {
    x,
    z,
    type,
    size: [1 + (i % 3) * 0.2, 0.6 + (i % 6) * 0.35, 1 + ((i + 1) % 3) * 0.2],
    color,
  };
});

function obstacleCenterY(obs) {
  if (obs.type === 'cylinder') return GROUND_TOP_Y + obs.height / 2;
  if (obs.type === 'sphere') return GROUND_TOP_Y + obs.radius;
  return GROUND_TOP_Y + obs.size[1] / 2;
}

function obstacleTopY(obs) {
  if (obs.type === 'cylinder') return GROUND_TOP_Y + obs.height;
  if (obs.type === 'sphere') return GROUND_TOP_Y + obs.radius * 2;
  return GROUND_TOP_Y + obs.size[1];
}

const FLAT_TOP_OBSTACLES = OBSTACLES.filter((o) => o.type !== 'sphere');
const PLATFORM_MONKEY_COUNT = Math.min(8, FLAT_TOP_OBSTACLES.length);
const TOTAL_COLLECTIBLES = 26;
const COLLECTIBLE_SPIRAL_RADIUS = 17;

function useKeyboard() {
  const keys = useRef({});

  useEffect(() => {
    const handleKeyDown = (e) => {
      keys.current[e.code] = true;
    };
    const handleKeyUp = (e) => {
      keys.current[e.code] = false;
    };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, []);

  return keys;
}

function buildToonGradient() {
  const steps = [64, 128, 200, 255];
  const data = new Uint8Array(steps.length * 4);
  steps.forEach((v, i) => {
    data[i * 4 + 0] = v;
    data[i * 4 + 1] = v;
    data[i * 4 + 2] = v;
    data[i * 4 + 3] = 255;
  });
  const texture = new THREE.DataTexture(data, steps.length, 1, THREE.RGBAFormat);
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.needsUpdate = true;
  return texture;
}

function useToonMaterial(sourceMaterial, gradientMap) {
  return useMemo(() => {
    const color = sourceMaterial?.color ? sourceMaterial.color.clone() : new THREE.Color('white');
    return new THREE.MeshToonMaterial({ color, gradientMap });
  }, [sourceMaterial, gradientMap]);
}

let sharedAudioContext = null;

function getAudioContext() {
  if (!sharedAudioContext) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    sharedAudioContext = new AudioContextClass();
  }
  return sharedAudioContext;
}

function playCollectSound() {
  const ctx = getAudioContext();
  if (ctx.state === 'suspended') ctx.resume();

  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(600, ctx.currentTime);
  osc.frequency.exponentialRampToValueAtTime(1400, ctx.currentTime + 0.12);
  gain.gain.setValueAtTime(0.25, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.2);
  osc.connect(gain).connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + 0.2);
}

function playStartSound() {
  const ctx = getAudioContext();
  if (ctx.state === 'suspended') ctx.resume();

  const notes = [260, 390];
  notes.forEach((freq, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const startAt = ctx.currentTime + i * 0.09;
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(freq, startAt);
    gain.gain.setValueAtTime(0.2, startAt);
    gain.gain.exponentialRampToValueAtTime(0.001, startAt + 0.25);
    osc.connect(gain).connect(ctx.destination);
    osc.start(startAt);
    osc.stop(startAt + 0.25);
  });
}

function ControllableCube({ geometry, position, rigidBodyRef }) {
  const rigidBody = rigidBodyRef;
  const keys = useKeyboard();
  const jumpsUsed = useRef(0);
  const speed = 4;
  const jumpSpeed = 6;
  const playerMaterial = useMemo(() => new THREE.MeshStandardMaterial({ color: 'white' }), []);
  const forwardVec = useRef(new THREE.Vector3());
  const rightVec = useRef(new THREE.Vector3());
  const moveVec = useRef(new THREE.Vector3());

  useEffect(() => {
    const handleJump = (e) => {
      if (e.code !== 'Space') return;
      e.preventDefault();
      if (jumpsUsed.current < MAX_JUMPS && rigidBody.current) {
        const vel = rigidBody.current.linvel();
        rigidBody.current.setLinvel({ x: vel.x, y: jumpSpeed, z: vel.z }, true);
        jumpsUsed.current += 1;
      }
    };
    window.addEventListener('keydown', handleJump);
    return () => window.removeEventListener('keydown', handleJump);
  }, []);

  useFrame((state, delta) => {
    if (!rigidBody.current) return;

    let forwardInput = 0;
    if (keys.current.KeyW) forwardInput += 1;
    if (keys.current.KeyS) forwardInput -= 1;
    let rightInput = 0;
    if (keys.current.KeyD) rightInput += 1;
    if (keys.current.KeyA) rightInput -= 1;

    const currentVel = rigidBody.current.linvel();
    if (forwardInput !== 0 || rightInput !== 0) {
      state.camera.getWorldDirection(forwardVec.current);
      forwardVec.current.y = 0;
      forwardVec.current.normalize();
      rightVec.current.crossVectors(forwardVec.current, UP).normalize();

      moveVec.current
        .set(0, 0, 0)
        .addScaledVector(forwardVec.current, forwardInput)
        .addScaledVector(rightVec.current, rightInput)
        .normalize()
        .multiplyScalar(speed);

      rigidBody.current.setLinvel(
        { x: moveVec.current.x, y: currentVel.y, z: moveVec.current.z },
        true
      );
    } else {
      rigidBody.current.setLinvel({ x: 0, y: currentVel.y, z: 0 }, true);
    }

    let yaw = 0;
    if (keys.current.ArrowLeft) yaw += 1;
    if (keys.current.ArrowRight) yaw -= 1;
    let pitch = 0;
    if (keys.current.ArrowUp) pitch += 1;
    if (keys.current.ArrowDown) pitch -= 1;

    if (yaw !== 0 || pitch !== 0) {
      rigidBody.current.applyTorqueImpulse(
        { x: pitch * ROTATE_TORQUE * delta, y: yaw * ROTATE_TORQUE * delta, z: 0 },
        true
      );
    }
  });

  return (
    <RigidBody
      ref={rigidBody}
      position={position}
      colliders="hull"
      restitution={0}
      friction={0.8}
      angularDamping={0.6}
      userData={{ isPlayer: true }}
      onCollisionEnter={(event) => {
        if (event.other?.rigidBodyObject?.userData?.isGround) {
          jumpsUsed.current = 0;
        }
      }}
    >
      <mesh geometry={geometry} material={playerMaterial} castShadow receiveShadow />
    </RigidBody>
  );
}

const AI_SPEED = 3.3;
const AI_JUMP_SPEED = 6;

function AICube({ geometry, position, collectibleRefs }) {
  const rigidBody = useRef();
  const jumpsUsed = useRef(0);
  const aiMaterial = useMemo(() => new THREE.MeshStandardMaterial({ color: 'black' }), []);
  const moveVec = useRef(new THREE.Vector3());

  useFrame(() => {
    if (!rigidBody.current) return;

    const myPos = rigidBody.current.translation();
    let nearest = null;
    let nearestDistSq = Infinity;
    for (const ref of collectibleRefs.current) {
      if (!ref) continue;
      const t = ref.translation();
      const dx = t.x - myPos.x;
      const dz = t.z - myPos.z;
      const d = dx * dx + dz * dz;
      if (d < nearestDistSq) {
        nearestDistSq = d;
        nearest = t;
      }
    }

    const currentVel = rigidBody.current.linvel();
    if (nearest) {
      const dx = nearest.x - myPos.x;
      const dz = nearest.z - myPos.z;
      const dist = Math.hypot(dx, dz);
      if (dist > 0.3) {
        moveVec.current.set(dx / dist, 0, dz / dist).multiplyScalar(AI_SPEED);
        rigidBody.current.setLinvel(
          { x: moveVec.current.x, y: currentVel.y, z: moveVec.current.z },
          true
        );
      } else {
        rigidBody.current.setLinvel({ x: 0, y: currentVel.y, z: 0 }, true);
      }

      if (nearest.y - myPos.y > 0.6 && dist < 3 && jumpsUsed.current < MAX_JUMPS) {
        rigidBody.current.setLinvel({ x: currentVel.x, y: AI_JUMP_SPEED, z: currentVel.z }, true);
        jumpsUsed.current += 1;
      }
    } else {
      rigidBody.current.setLinvel({ x: 0, y: currentVel.y, z: 0 }, true);
    }
  });

  return (
    <RigidBody
      ref={rigidBody}
      position={position}
      colliders="hull"
      restitution={0}
      friction={0.8}
      angularDamping={0.6}
      userData={{ isAI: true }}
      onCollisionEnter={(event) => {
        if (event.other?.rigidBodyObject?.userData?.isGround) {
          jumpsUsed.current = 0;
        }
      }}
    >
      <mesh geometry={geometry} material={aiMaterial} castShadow receiveShadow />
    </RigidBody>
  );
}

const COLLECT_ANIM_DURATION = 0.4;

function CollectPopEffect({ geometry, material, position, scale }) {
  const meshRef = useRef();
  const startTime = useRef(null);
  const [done, setDone] = useState(false);

  useFrame((state) => {
    if (!meshRef.current) return;
    if (startTime.current === null) startTime.current = state.clock.elapsedTime;

    const t = Math.min((state.clock.elapsedTime - startTime.current) / COLLECT_ANIM_DURATION, 1);
    const grow = Math.sin(t * Math.PI) * 1.4;
    meshRef.current.scale.set(scale[0] * grow, scale[1] * grow, scale[2] * grow);
    meshRef.current.position.y = position[1] + t * 1.5;
    meshRef.current.rotation.y = t * Math.PI * 4;

    if (t >= 1) setDone(true);
  });

  if (done) return null;

  return (
    <mesh
      ref={meshRef}
      geometry={geometry}
      material={material}
      position={position}
      castShadow
    />
  );
}

function CollectibleCube({ geometry, material, gradientMap, position, rotation, scale, onCollect, bodyRefCallback }) {
  const [phase, setPhase] = useState('idle');
  const [popAt, setPopAt] = useState(null);
  const bodyRef = useRef();
  const toonMaterial = useToonMaterial(material, gradientMap);

  const setBodyRef = (el) => {
    bodyRef.current = el;
    if (bodyRefCallback) bodyRefCallback(el);
  };

  if (phase === 'collecting') {
    return (
      <CollectPopEffect geometry={geometry} material={toonMaterial} position={popAt} scale={scale} />
    );
  }

  return (
    <RigidBody
      ref={setBodyRef}
      position={position}
      rotation={rotation}
      scale={scale}
      colliders="hull"
      restitution={0.3}
      friction={0.8}
      onCollisionEnter={(event) => {
        const otherData = event.other?.rigidBodyObject?.userData;
        if (otherData?.isPlayer || otherData?.isAI) {
          const t = bodyRef.current.translation();
          setPopAt([t.x, t.y, t.z]);
          setPhase('collecting');
          if (bodyRefCallback) bodyRefCallback(null);
          playCollectSound();
          onCollect(otherData.isAI ? 'ai' : 'player');
        }
      }}
    >
      <mesh geometry={geometry} material={toonMaterial} castShadow receiveShadow />
    </RigidBody>
  );
}

function Ground() {
  return (
    <RigidBody type="fixed" colliders="trimesh" userData={{ isGround: true }}>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, GROUND_TOP_Y, 0]} receiveShadow>
        <planeGeometry args={[GROUND_SIZE, GROUND_SIZE]} />
        <meshStandardMaterial color="#dcdcdc" />
      </mesh>
    </RigidBody>
  );
}

function Obstacle({ x, z, type, size, radius, height, color }) {
  const y = obstacleCenterY({ type, size, radius, height });
  return (
    <RigidBody type="fixed" colliders="hull" position={[x, y, z]} userData={{ isGround: true }}>
      <mesh castShadow receiveShadow>
        {type === 'cylinder' && <cylinderGeometry args={[radius, radius, height, 10]} />}
        {type === 'sphere' && <sphereGeometry args={[radius, 10, 8]} />}
        {type === 'box' && <boxGeometry args={size} />}
        <meshStandardMaterial color={color} flatShading />
      </mesh>
    </RigidBody>
  );
}

const SCENE_GLB_URL = `${process.env.PUBLIC_URL}/scene.glb`;

function BlenderPhysicsScene({ onTotal, onCollect, playerRigidBodyRef }) {
  const { nodes } = useGLTF(SCENE_GLB_URL);
  const gradientMap = useMemo(() => buildToonGradient(), []);
  const fallingNames = useMemo(
    () => Object.keys(nodes).filter((name) => name.startsWith('Cubo_')),
    [nodes]
  );
  const collectibleSlots = useMemo(
    () =>
      fallingNames.length
        ? Array.from({ length: TOTAL_COLLECTIBLES }, (_, i) => fallingNames[i % fallingNames.length])
        : [],
    [fallingNames]
  );
  const collectibleRefs = useRef([]);

  useEffect(() => {
    onTotal(collectibleSlots.length);
  }, [collectibleSlots.length, onTotal]);

  return (
    <>
      <ControllableCube
        geometry={nodes.Cube.geometry}
        position={[0, 3, 0]}
        rigidBodyRef={playerRigidBodyRef}
      />
      <AICube geometry={nodes.Cube.geometry} position={[4, 3, 4]} collectibleRefs={collectibleRefs} />
      {collectibleSlots.map((name, i) => {
        const node = nodes[name];
        let position;
        if (i < PLATFORM_MONKEY_COUNT) {
          const obs = FLAT_TOP_OBSTACLES[i];
          position = [obs.x, obstacleTopY(obs) + 3, obs.z];
        } else {
          const [x, z] = spiralXZ(i, collectibleSlots.length, COLLECTIBLE_SPIRAL_RADIUS, Math.PI / 3);
          position = [x, 4 + (i % 5) * 0.6, z];
        }
        return (
          <CollectibleCube
            key={`${name}-${i}`}
            geometry={node.geometry}
            material={node.material}
            gradientMap={gradientMap}
            position={position}
            rotation={[node.rotation.x, node.rotation.y, node.rotation.z]}
            scale={node.scale.toArray().map((s) => s * COLLECTIBLE_SCALE)}
            onCollect={onCollect}
            bodyRefCallback={(el) => {
              collectibleRefs.current[i] = el;
            }}
          />
        );
      })}
      {OBSTACLES.map((obs, i) => (
        <Obstacle key={i} {...obs} />
      ))}
      <Ground />
    </>
  );
}

useGLTF.preload(SCENE_GLB_URL);

function usePointerLook(onLockChange) {
  const yaw = useRef(0);
  const pitch = useRef(0);
  const locked = useRef(false);

  useEffect(() => {
    const canvasEl = document.querySelector('canvas');

    const handleLockChange = () => {
      locked.current = document.pointerLockElement === canvasEl;
      onLockChange(locked.current);
    };

    const handleMouseMove = (e) => {
      if (!locked.current) return;
      yaw.current -= e.movementX * MOUSE_SENSITIVITY;
      pitch.current += e.movementY * MOUSE_SENSITIVITY;
      pitch.current = Math.max(-MAX_LOOK_PITCH, Math.min(MAX_LOOK_PITCH, pitch.current));
    };

    document.addEventListener('pointerlockchange', handleLockChange);
    document.addEventListener('mousemove', handleMouseMove);
    return () => {
      document.removeEventListener('pointerlockchange', handleLockChange);
      document.removeEventListener('mousemove', handleMouseMove);
    };
  }, [onLockChange]);

  return { yaw, pitch };
}

function CameraRig({ playerRigidBodyRef, onLockChange }) {
  const { yaw, pitch } = usePointerLook(onLockChange);
  const targetVec = useRef(new THREE.Vector3());
  const desiredCamPos = useRef(new THREE.Vector3());
  const lookAtVec = useRef(new THREE.Vector3());

  useFrame(({ camera }, delta) => {
    if (!playerRigidBodyRef.current) return;

    const t = playerRigidBodyRef.current.translation();
    targetVec.current.set(t.x, t.y, t.z);

    const horizontalDist = CAMERA_DISTANCE * Math.cos(pitch.current);
    desiredCamPos.current.set(
      targetVec.current.x + Math.sin(yaw.current) * horizontalDist,
      targetVec.current.y + CAMERA_HEIGHT + CAMERA_DISTANCE * Math.sin(pitch.current),
      targetVec.current.z + Math.cos(yaw.current) * horizontalDist
    );

    const followStrength = 1 - Math.exp(-CAMERA_FOLLOW_RATE * delta);
    camera.position.lerp(desiredCamPos.current, followStrength);
    lookAtVec.current.set(targetVec.current.x, targetVec.current.y + 0.5, targetVec.current.z);
    camera.lookAt(lookAtVec.current);
  });

  return null;
}

const hudStyle = {
  position: 'absolute',
  top: 16,
  left: 16,
  zIndex: 10,
  display: 'flex',
  gap: 12,
  padding: '10px 16px',
  borderRadius: 10,
  background: 'rgba(0,0,0,0.5)',
  color: 'white',
  fontFamily: 'sans-serif',
  fontSize: 18,
  fontWeight: 600,
  pointerEvents: 'none',
};

const endOverlayStyle = {
  position: 'absolute',
  inset: 0,
  zIndex: 20,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 16,
  background: 'rgba(0,0,0,0.6)',
  color: 'white',
  fontFamily: 'sans-serif',
};

const restartButtonStyle = {
  fontSize: 18,
  padding: '10px 28px',
  borderRadius: 8,
  border: 'none',
  cursor: 'pointer',
  background: '#f5a623',
  color: '#1a1a1a',
  fontWeight: 700,
};

const lockOverlayStyle = {
  position: 'absolute',
  inset: 0,
  zIndex: 15,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 8,
  background: 'rgba(0,0,0,0.35)',
  color: 'white',
  fontFamily: 'sans-serif',
  cursor: 'pointer',
};

const instructionsListStyle = {
  listStyle: 'none',
  padding: 0,
  margin: '12px 0 0',
  fontSize: 15,
  lineHeight: 1.8,
  textAlign: 'left',
};

function decideOutcome(collected, aiCollected) {
  if (collected > aiCollected) return 'won';
  if (aiCollected > collected) return 'lost';
  return 'draw';
}

export default function Scene() {
  const [total, setTotal] = useState(0);
  const [collected, setCollected] = useState(0);
  const [aiCollected, setAiCollected] = useState(0);
  const [timeLeft, setTimeLeft] = useState(GAME_DURATION);
  const [status, setStatus] = useState('playing');
  const [resetKey, setResetKey] = useState(0);
  const [pointerLocked, setPointerLocked] = useState(false);
  const playerRigidBodyRef = useRef();

  const requestPointerLock = () => {
    getAudioContext().resume();
    playStartSound();
    document.querySelector('canvas')?.requestPointerLock();
  };

  const handleCollect = (collector) => {
    if (collector === 'ai') {
      setAiCollected((c) => c + 1);
    } else {
      setCollected((c) => c + 1);
    }
  };

  useEffect(() => {
    if (total > 0 && collected + aiCollected >= total && status === 'playing') {
      setStatus(decideOutcome(collected, aiCollected));
    }
  }, [collected, aiCollected, total, status]);

  useEffect(() => {
    if (status !== 'playing') return undefined;
    if (timeLeft <= 0) {
      setStatus(decideOutcome(collected, aiCollected));
      return undefined;
    }
    const id = setTimeout(() => setTimeLeft((t) => t - 1), 1000);
    return () => clearTimeout(id);
  }, [status, timeLeft, collected, aiCollected]);

  const handleRestart = () => {
    setResetKey((k) => k + 1);
    setCollected(0);
    setAiCollected(0);
    setTimeLeft(GAME_DURATION);
    setStatus('playing');
  };

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <div style={hudStyle}>
        <span>⏱ {timeLeft}s</span>
        <span>🧍 Tu: {collected}</span>
        <span>🤖 AI: {aiCollected}</span>
        <span>🐵 {collected + aiCollected}/{total}</span>
      </div>
      {status !== 'playing' && (
        <div style={endOverlayStyle}>
          <div style={{ fontSize: 36, fontWeight: 700 }}>
            {status === 'won' && '🎉 Hai vinto!'}
            {status === 'lost' && '🤖 Ha vinto l\'AI!'}
            {status === 'draw' && '🤝 Pareggio!'}
          </div>
          <div style={{ fontSize: 18, opacity: 0.85 }}>
            Tu {collected} — AI {aiCollected} (totale {collected + aiCollected}/{total})
          </div>
          <button onClick={handleRestart} style={restartButtonStyle}>
            Rigioca
          </button>
        </div>
      )}
      {status === 'playing' && !pointerLocked && (
        <div style={lockOverlayStyle} onClick={requestPointerLock}>
          <div style={{ fontSize: 24, fontWeight: 700 }}>🖱 Clicca per iniziare</div>
          <ul style={instructionsListStyle}>
            <li>🎯 Raccogli più scimmiette dell'AI prima che scada il tempo</li>
            <li>⌨️ WASD — muoviti (rispetto alla camera)</li>
            <li>🖱️ Mouse — guardati intorno</li>
            <li>␣ Spazio — salta (doppio salto disponibile)</li>
            <li>◀▶▲▼ Frecce — ruota su te stesso</li>
            <li>ESC — esci dal mouse look</li>
          </ul>
        </div>
      )}
      <Canvas shadows camera={{ position: [4, 3, 8], fov: 50 }}>
        <color attach="background" args={['#ffffff']} />
        <ambientLight intensity={0.4} />
        <directionalLight
          position={[5, 10, 5]}
          intensity={1}
          castShadow
          shadow-mapSize-width={2048}
          shadow-mapSize-height={2048}
          shadow-camera-left={-22}
          shadow-camera-right={22}
          shadow-camera-top={22}
          shadow-camera-bottom={-22}
          shadow-camera-far={60}
        />
        <Suspense fallback={null}>
          <Physics gravity={[0, -9.81, 0]} paused={status !== 'playing'}>
            <BlenderPhysicsScene
              key={resetKey}
              onTotal={setTotal}
              onCollect={handleCollect}
              playerRigidBodyRef={playerRigidBodyRef}
            />
          </Physics>
          <CameraRig playerRigidBodyRef={playerRigidBodyRef} onLockChange={setPointerLocked} />
        </Suspense>
      </Canvas>
    </div>
  );
}
