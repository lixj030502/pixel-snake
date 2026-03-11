/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Trophy, Play, RotateCcw, Pause, ChevronUp, ChevronDown, ChevronLeft, ChevronRight, Cloud, House, Palette } from 'lucide-react';
import { signInAnonymously, onAuthStateChanged } from 'firebase/auth';
import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore';
import { auth, db } from './firebase';

const GRID_SIZE = 30;
const CELL_SIZE = 20;
const CANVAS_SIZE = GRID_SIZE * CELL_SIZE;
const INITIAL_SPEED = 250;
const MIN_SPEED = 60;
const SPEED_DECREMENT = 2;

// 道具系统常量
const SPECIAL_ITEM_LIFETIME = 12000; // 道具在地图上存在 12 秒
const SPECIAL_SPAWN_INTERVAL = 15000; // 每 15 秒尝试刷出一个道具
const EFFECT_DURATION = 9000;         // 持续性效果持续 9 秒
const MAX_SPECIAL_ITEMS = 2;          // 地图上最多同时存在 2 个道具
const COMBO_WINDOW = 8000;            // 8 秒内吃到下一个果子可维持连击

// 连击倍率：1连击=×1，2-3=×2，4-6=×3，7+=×4
const getComboMultiplier = (count: number): number => {
  if (count < 2) return 1;
  if (count < 4) return 2;
  if (count < 7) return 3;
  return 4;
};

type Point = { x: number; y: number };

// 皮肤配置
type SnakeSkin = 'classic' | 'ocean' | 'lava' | 'royal' | 'ghost' | 'gold';
const SKIN_CONFIG: Record<SnakeSkin, { label: string; head: string; body: string }> = {
  classic: { label: 'Classic', head: '#22c55e', body: '#4ade80' },
  ocean:   { label: 'Ocean',   head: '#0ea5e9', body: '#38bdf8' },
  lava:    { label: 'Lava',    head: '#ef4444', body: '#f87171' },
  royal:   { label: 'Royal',   head: '#a855f7', body: '#c084fc' },
  ghost:   { label: 'Ghost',   head: '#e2e8f0', body: '#f8fafc' },
  gold:    { label: 'Gold',    head: '#ca8a04', body: '#facc15' },
};

// 水果配置
type FruitType = 'apple' | 'banana' | 'grape' | 'orange' | 'strawberry' | 'cherry';
const FRUIT_CONFIG: Record<FruitType, { label: string; emoji: string }> = {
  apple:      { label: '苹果', emoji: '🍎' },
  banana:     { label: '香蕉', emoji: '🍌' },
  grape:      { label: '葡萄', emoji: '🍇' },
  orange:     { label: '橘子', emoji: '🍊' },
  strawberry: { label: '草莓', emoji: '🍓' },
  cherry:     { label: '樱桃', emoji: '🍒' },
};

// 道具类型
type SpecialItemType = 'speed' | 'slow' | 'shrink' | 'diamond' | 'poison';

type SpecialItem = {
  pos: Point;
  type: SpecialItemType;
  expiresAt: number; // 道具消失的时间戳
};

type ActiveEffect = {
  type: 'speed' | 'slow' | 'diamond';
  expiresAt: number;
};

// 道具配置：emoji、背景色、说明
const ITEM_CONFIG: Record<SpecialItemType, { emoji: string; bg: string; border: string; label: string; desc: string }> = {
  speed:   { emoji: '⚡', bg: '#713f12', border: '#facc15', label: '加速',   desc: '移动速度翻倍！' },
  slow:    { emoji: '🐢', bg: '#1e3a5f', border: '#60a5fa', label: '减速',   desc: '移动速度减半' },
  shrink:  { emoji: '✂️', bg: '#3b0764', border: '#c084fc', label: '缩身',   desc: '身体缩短 1/3' },
  diamond: { emoji: '💎', bg: '#083344', border: '#22d3ee', label: '3倍分',  desc: '得分变为 3 倍！' },
  poison:  { emoji: '💀', bg: '#1c1c1c', border: '#6b7280', label: '剧毒',   desc: '碰到即死！' },
};

// 加权随机池（speed/slow/diamond 各3，shrink/poison 各1）
const ITEM_POOL: SpecialItemType[] = [
  'speed', 'speed', 'speed',
  'slow', 'slow', 'slow',
  'diamond', 'diamond', 'diamond',
  'shrink',
  'poison',
];

const INITIAL_SNAKE: Point[] = [
  { x: 15, y: 15 },
  { x: 15, y: 16 },
  { x: 15, y: 17 },
];
const INITIAL_DIRECTION: Point = { x: 0, y: -1 };

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [gameOver, setGameOver] = useState(false);
  const [score, setScore] = useState(0);
  const [highScores, setHighScores] = useState<number[]>([0, 0, 0, 0, 0]);
  const [isPaused, setIsPaused] = useState(false);
  const [hasStarted, setHasStarted] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);
  const [isCloudSyncing, setIsCloudSyncing] = useState(false);
  const [activeEffect, setActiveEffect] = useState<ActiveEffect | null>(null);
  const [effectTimeLeft, setEffectTimeLeft] = useState(0);
  const [lastEatenItem, setLastEatenItem] = useState<SpecialItemType | null>(null);
  const lastEatenTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [combo, setCombo] = useState(0);
  const comboRef = useRef(0);
  const comboExpiresRef = useRef(0);

  // 皮肤与水果设置
  const [showSettings, setShowSettings] = useState(false);
  const [selectedSkin, setSelectedSkin] = useState<SnakeSkin>('classic');
  const [selectedFruit, setSelectedFruit] = useState<FruitType>('apple');
  const selectedSkinRef = useRef<SnakeSkin>('classic');
  const selectedFruitRef = useRef<FruitType>('apple');

  // 从 localStorage 读取设置
  useEffect(() => {
    const skin = localStorage.getItem('snakeSkin') as SnakeSkin | null;
    const fruit = localStorage.getItem('snakeFruit') as FruitType | null;
    if (skin && skin in SKIN_CONFIG)   { selectedSkinRef.current = skin;   setSelectedSkin(skin); }
    if (fruit && fruit in FRUIT_CONFIG) { selectedFruitRef.current = fruit; setSelectedFruit(fruit); }
  }, []);

  const updateSkin = (skin: SnakeSkin) => {
    selectedSkinRef.current = skin;
    setSelectedSkin(skin);
    localStorage.setItem('snakeSkin', skin);
  };
  const updateFruit = (fruit: FruitType) => {
    selectedFruitRef.current = fruit;
    setSelectedFruit(fruit);
    localStorage.setItem('snakeFruit', fruit);
  };
  const openSettings = () => {
    setShowSettings(true);
    if (hasStarted && !gameOver) setIsPaused(true);
  };

  // Initialize Firebase Auth
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      if (user) {
        setUserId(user.uid);
        try {
          setIsCloudSyncing(true);
          const docRef = doc(db, 'userScores', user.uid);
          const docSnap = await getDoc(docRef);
          if (docSnap.exists()) {
            const data = docSnap.data();
            if (data.highScores && Array.isArray(data.highScores)) {
              const scores = data.highScores.slice(0, 5);
              while (scores.length < 5) scores.push(0);
              setHighScores(scores);
            }
          } else {
            const saved = localStorage.getItem('snakeHighScores');
            let localScores = [0, 0, 0, 0, 0];
            if (saved) {
              try {
                const parsed = JSON.parse(saved);
                if (Array.isArray(parsed) && parsed.length > 0) {
                  localScores = parsed.slice(0, 5);
                  while (localScores.length < 5) localScores.push(0);
                }
              } catch (e) {}
            } else {
              const oldSaved = localStorage.getItem('snakeHighScore');
              if (oldSaved) localScores[0] = parseInt(oldSaved, 10);
            }
            setHighScores(localScores);
            await setDoc(docRef, { highScores: localScores, updatedAt: serverTimestamp() });
          }
        } catch (error) {
          console.error('Error fetching scores:', error);
        } finally {
          setIsCloudSyncing(false);
        }
      } else {
        signInAnonymously(auth).catch(console.error);
      }
    });
    return () => unsubscribe();
  }, []);

  const snakeRef = useRef<Point[]>([...INITIAL_SNAKE]);
  const directionRef = useRef<Point>({ ...INITIAL_DIRECTION });
  const nextDirectionRef = useRef<Point>({ ...INITIAL_DIRECTION });
  const foodRef = useRef<Point>({ x: 5, y: 5 });
  const lastMoveTimeRef = useRef<number>(0);
  const requestRef = useRef<number>(0);
  const speedRef = useRef<number>(INITIAL_SPEED);

  // 道具相关 refs
  const specialItemsRef = useRef<SpecialItem[]>([]);
  const activeEffectRef = useRef<ActiveEffect | null>(null);
  const lastSpecialSpawnRef = useRef<number>(0);
  const lastSpawnedTypeRef = useRef<SpecialItemType | null>(null);

  const generateFood = useCallback((snake: Point[]): Point => {
    let newFood: Point;
    while (true) {
      newFood = {
        x: Math.floor(Math.random() * GRID_SIZE),
        y: Math.floor(Math.random() * GRID_SIZE),
      };
      // eslint-disable-next-line no-loop-func
      if (!snake.some((s) => s.x === newFood.x && s.y === newFood.y)) break;
    }
    return newFood;
  }, []);

  // 为道具生成不重叠的位置
  const generateSpecialItemPos = useCallback((snake: Point[], items: SpecialItem[]): Point | null => {
    const occupied = [
      ...snake,
      foodRef.current,
      ...items.map((i) => i.pos),
    ];
    const available: Point[] = [];
    for (let x = 0; x < GRID_SIZE; x++) {
      for (let y = 0; y < GRID_SIZE; y++) {
        if (!occupied.some((p) => p.x === x && p.y === y)) {
          available.push({ x, y });
        }
      }
    }
    if (available.length === 0) return null;
    return available[Math.floor(Math.random() * available.length)];
  }, []);

  const handleGameOver = useCallback(() => {
    setGameOver(true);
    setHasStarted(false);
    setHighScores((prev) => {
      const newScores = [...prev, score].sort((a, b) => b - a).slice(0, 5);
      localStorage.setItem('snakeHighScores', JSON.stringify(newScores));
      if (userId) {
        setIsCloudSyncing(true);
        setDoc(doc(db, 'userScores', userId), {
          highScores: newScores,
          updatedAt: serverTimestamp(),
        }).catch(console.error).finally(() => setIsCloudSyncing(false));
      }
      return newScores;
    });
  }, [score, userId]);

  const resetGame = useCallback(() => {
    snakeRef.current = [...INITIAL_SNAKE];
    directionRef.current = { ...INITIAL_DIRECTION };
    nextDirectionRef.current = { ...INITIAL_DIRECTION };
    foodRef.current = generateFood(INITIAL_SNAKE);
    speedRef.current = INITIAL_SPEED;
    specialItemsRef.current = [];
    activeEffectRef.current = null;
    // 第一个道具在开始 8 秒后刷出
    lastSpecialSpawnRef.current = performance.now() - SPECIAL_SPAWN_INTERVAL + 8000;
    lastSpawnedTypeRef.current = null;
    setScore(0);
    setGameOver(false);
    setHasStarted(true);
    setIsPaused(false);
    setActiveEffect(null);
    setEffectTimeLeft(0);
    setLastEatenItem(null);
    setCombo(0);
    comboRef.current = 0;
    comboExpiresRef.current = 0;
    lastMoveTimeRef.current = performance.now();
  }, [generateFood]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // 清空
    ctx.fillStyle = '#020617';
    ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

    // 网格
    ctx.strokeStyle = '#0f172a';
    ctx.lineWidth = 1;
    for (let i = 0; i <= CANVAS_SIZE; i += CELL_SIZE) {
      ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, CANVAS_SIZE); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(CANVAS_SIZE, i); ctx.stroke();
    }

    // 食物（水果 emoji）
    const fx = foodRef.current.x * CELL_SIZE;
    const fy = foodRef.current.y * CELL_SIZE;
    ctx.font = `${CELL_SIZE - 1}px serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(FRUIT_CONFIG[selectedFruitRef.current].emoji, fx + CELL_SIZE / 2, fy + CELL_SIZE / 2 + 1);

    // 特殊道具
    const now = performance.now();
    specialItemsRef.current.forEach((item) => {
      const { pos, type, expiresAt } = item;
      const timeLeft = expiresAt - now;
      // 最后 2 秒闪烁
      if (timeLeft < 2000 && Math.floor(now / 250) % 2 === 0) return;

      const cfg = ITEM_CONFIG[type];
      const ix = pos.x * CELL_SIZE;
      const iy = pos.y * CELL_SIZE;

      // 背景
      ctx.fillStyle = cfg.bg;
      ctx.fillRect(ix + 1, iy + 1, CELL_SIZE - 2, CELL_SIZE - 2);

      // 边框
      ctx.strokeStyle = cfg.border;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(ix + 1.5, iy + 1.5, CELL_SIZE - 3, CELL_SIZE - 3);

      // emoji
      ctx.font = '11px serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(cfg.emoji, ix + CELL_SIZE / 2, iy + CELL_SIZE / 2 + 1);
    });

    // 蛇
    snakeRef.current.forEach((segment, index) => {
      const isHead = index === 0;
      const x = segment.x * CELL_SIZE;
      const y = segment.y * CELL_SIZE;

      // 蛇身颜色：优先显示效果色，否则使用皮肤色
      const skin = SKIN_CONFIG[selectedSkinRef.current];
      const effect = activeEffectRef.current;
      const effectActive = effect && effect.expiresAt > now;
      if (isHead) {
        ctx.fillStyle = effectActive && effect.type === 'speed'   ? '#fbbf24' :
                        effectActive && effect.type === 'slow'    ? '#60a5fa' :
                        effectActive && effect.type === 'diamond' ? '#22d3ee' :
                        skin.head;
      } else {
        ctx.fillStyle = effectActive && effect.type === 'speed'   ? '#f59e0b' :
                        effectActive && effect.type === 'slow'    ? '#3b82f6' :
                        effectActive && effect.type === 'diamond' ? '#06b6d4' :
                        skin.body;
      }
      ctx.fillRect(x + 1, y + 1, CELL_SIZE - 2, CELL_SIZE - 2);

      // 蛇头眼睛
      if (isHead) {
        ctx.fillStyle = '#000000';
        const dir = directionRef.current;
        const eyeSize = 4;
        if (dir.x === 1) {
          ctx.fillRect(x + CELL_SIZE - 6, y + 4, eyeSize, eyeSize);
          ctx.fillRect(x + CELL_SIZE - 6, y + CELL_SIZE - 8, eyeSize, eyeSize);
        } else if (dir.x === -1) {
          ctx.fillRect(x + 2, y + 4, eyeSize, eyeSize);
          ctx.fillRect(x + 2, y + CELL_SIZE - 8, eyeSize, eyeSize);
        } else if (dir.y === 1) {
          ctx.fillRect(x + 4, y + CELL_SIZE - 6, eyeSize, eyeSize);
          ctx.fillRect(x + CELL_SIZE - 8, y + CELL_SIZE - 6, eyeSize, eyeSize);
        } else {
          ctx.fillRect(x + 4, y + 2, eyeSize, eyeSize);
          ctx.fillRect(x + CELL_SIZE - 8, y + 2, eyeSize, eyeSize);
        }
      }
    });
  }, []);

  const update = useCallback((time: number) => {
    if (gameOver || isPaused || !hasStarted) {
      draw();
      requestRef.current = requestAnimationFrame(update);
      return;
    }

    const now = performance.now();

    // 清理过期道具
    specialItemsRef.current = specialItemsRef.current.filter((item) => item.expiresAt > now);

    // 连击超时重置
    if (comboRef.current > 0 && comboExpiresRef.current <= now) {
      comboRef.current = 0;
      setCombo(0);
    }

    // 清理过期效果
    if (activeEffectRef.current && activeEffectRef.current.expiresAt <= now) {
      activeEffectRef.current = null;
      setActiveEffect(null);
      setEffectTimeLeft(0);
    } else if (activeEffectRef.current) {
      setEffectTimeLeft(Math.ceil((activeEffectRef.current.expiresAt - now) / 1000));
    }

    // 尝试刷新道具
    if (
      now - lastSpecialSpawnRef.current >= SPECIAL_SPAWN_INTERVAL &&
      specialItemsRef.current.length < MAX_SPECIAL_ITEMS
    ) {
      const pos = generateSpecialItemPos(snakeRef.current, specialItemsRef.current);
      if (pos) {
        // 根据当前速度动态调整减速道具的权重：
        // 速度 >= 200ms（慢）→ 不刷减速；150~200ms → 权重 2；< 150ms（快）→ 权重 5
        const spd = speedRef.current;
        const slowWeight = spd >= 200 ? 0 : spd >= 150 ? 2 : 5;
        const dynamicPool: SpecialItemType[] = [
          'speed', 'speed', 'speed',
          'diamond', 'diamond', 'diamond',
          'shrink',
          'poison',
          ...Array(slowWeight).fill('slow') as SpecialItemType[],
        ];
        const pool = (lastSpawnedTypeRef.current
          ? dynamicPool.filter((t) => t !== lastSpawnedTypeRef.current)
          : dynamicPool);
        const type = pool[Math.floor(Math.random() * pool.length)];
        lastSpawnedTypeRef.current = type;
        specialItemsRef.current = [
          ...specialItemsRef.current,
          { pos, type, expiresAt: now + SPECIAL_ITEM_LIFETIME },
        ];
      }
      lastSpecialSpawnRef.current = now;
    }

    // 计算实际速度（受效果影响）
    const effect = activeEffectRef.current;
    let effectiveSpeed = speedRef.current;
    if (effect && effect.expiresAt > now) {
      if (effect.type === 'speed') effectiveSpeed = Math.max(MIN_SPEED, Math.floor(speedRef.current * 0.5));
      if (effect.type === 'slow')  effectiveSpeed = Math.min(600, Math.floor(speedRef.current * 2));
    }

    if (time - lastMoveTimeRef.current >= effectiveSpeed) {
      const snake = [...snakeRef.current];
      const direction = nextDirectionRef.current;
      directionRef.current = direction;

      const head = { ...snake[0] };
      head.x += direction.x;
      head.y += direction.y;

      // 碰墙
      if (head.x < 0 || head.x >= GRID_SIZE || head.y < 0 || head.y >= GRID_SIZE) {
        handleGameOver();
        return;
      }
      // 碰自身
      if (snake.some((seg) => seg.x === head.x && seg.y === head.y)) {
        handleGameOver();
        return;
      }

      snake.unshift(head);

      // 检测是否吃到道具
      const hitIdx = specialItemsRef.current.findIndex(
        (item) => item.pos.x === head.x && item.pos.y === head.y
      );
      if (hitIdx !== -1) {
        const hit = specialItemsRef.current[hitIdx];
        specialItemsRef.current = specialItemsRef.current.filter((_, i) => i !== hitIdx);

        // 显示提示
        setLastEatenItem(hit.type);
        if (lastEatenTimerRef.current) clearTimeout(lastEatenTimerRef.current);
        lastEatenTimerRef.current = setTimeout(() => setLastEatenItem(null), 1800);

        switch (hit.type) {
          case 'speed': {
            const e: ActiveEffect = { type: 'speed', expiresAt: now + EFFECT_DURATION };
            activeEffectRef.current = e;
            setActiveEffect(e);
            break;
          }
          case 'slow': {
            const e: ActiveEffect = { type: 'slow', expiresAt: now + EFFECT_DURATION };
            activeEffectRef.current = e;
            setActiveEffect(e);
            break;
          }
          case 'diamond': {
            const e: ActiveEffect = { type: 'diamond', expiresAt: now + EFFECT_DURATION };
            activeEffectRef.current = e;
            setActiveEffect(e);
            break;
          }
          case 'shrink': {
            // 缩短到当前长度的 2/3，最少保留 3 节
            const newLen = Math.max(3, Math.floor(snake.length * 2 / 3));
            snake.splice(newLen);
            break;
          }
          case 'poison': {
            handleGameOver();
            return;
          }
        }
      }

      // 检测是否吃到普通食物
      if (head.x === foodRef.current.x && head.y === foodRef.current.y) {
        // 更新连击
        comboRef.current += 1;
        comboExpiresRef.current = now + COMBO_WINDOW;
        const currentCombo = comboRef.current;
        setCombo(currentCombo);

        setScore((s) => {
          const diamondMult = activeEffectRef.current?.type === 'diamond' &&
            activeEffectRef.current.expiresAt > performance.now() ? 3 : 1;
          const comboMult = getComboMultiplier(currentCombo);
          const gain = 10 * diamondMult * comboMult;
          const newScore = s + gain;
          if (Math.floor(newScore / 50) > Math.floor(s / 50)) {
            speedRef.current = Math.max(MIN_SPEED, speedRef.current - SPEED_DECREMENT * 5);
          }
          return newScore;
        });
        foodRef.current = generateFood(snake);
      } else {
        snake.pop();
      }

      snakeRef.current = snake;
      lastMoveTimeRef.current = time;
    }

    draw();
    requestRef.current = requestAnimationFrame(update);
  }, [gameOver, isPaused, hasStarted, draw, handleGameOver, generateFood, generateSpecialItemPos]);

  useEffect(() => {
    foodRef.current = generateFood(INITIAL_SNAKE);
    requestRef.current = requestAnimationFrame(update);
    return () => cancelAnimationFrame(requestRef.current);
  }, [update, generateFood]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'w', 'a', 's', 'd', ' '].includes(e.key)) {
        e.preventDefault();
      }
      if (gameOver) {
        if (e.key === 'Enter' || e.key === ' ') resetGame();
        return;
      }
      const { x, y } = directionRef.current;
      switch (e.key) {
        case 'ArrowUp': case 'w': case 'W':
          if (!hasStarted) setHasStarted(true);
          if (y !== 1) nextDirectionRef.current = { x: 0, y: -1 };
          break;
        case 'ArrowDown': case 's': case 'S':
          if (!hasStarted) setHasStarted(true);
          if (y !== -1) nextDirectionRef.current = { x: 0, y: 1 };
          break;
        case 'ArrowLeft': case 'a': case 'A':
          if (!hasStarted) setHasStarted(true);
          if (x !== 1) nextDirectionRef.current = { x: -1, y: 0 };
          break;
        case 'ArrowRight': case 'd': case 'D':
          if (!hasStarted) setHasStarted(true);
          if (x !== -1) nextDirectionRef.current = { x: 1, y: 0 };
          break;
        case ' ':
          if (hasStarted) setIsPaused((p) => !p);
          else setHasStarted(true);
          break;
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [hasStarted, gameOver, resetGame]);

  const handleDirectionClick = (dx: number, dy: number) => {
    if (gameOver) return;
    if (!hasStarted) setHasStarted(true);
    if (isPaused) setIsPaused(false);
    const { x, y } = directionRef.current;
    if (dx !== 0 && x !== -dx) nextDirectionRef.current = { x: dx, y: dy };
    if (dy !== 0 && y !== -dy) nextDirectionRef.current = { x: dx, y: dy };
  };

  const touchStartRef = useRef<{ x: number; y: number } | null>(null);

  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (!touchStartRef.current || gameOver) return;
    const dx = e.changedTouches[0].clientX - touchStartRef.current.x;
    const dy = e.changedTouches[0].clientY - touchStartRef.current.y;
    if (Math.abs(dx) < 30 && Math.abs(dy) < 30) return;
    if (!hasStarted) setHasStarted(true);
    if (isPaused) setIsPaused(false);
    const { x, y } = directionRef.current;
    if (Math.abs(dx) > Math.abs(dy)) {
      if (dx > 0 && x !== -1) nextDirectionRef.current = { x: 1, y: 0 };
      else if (dx < 0 && x !== 1) nextDirectionRef.current = { x: -1, y: 0 };
    } else {
      if (dy > 0 && y !== -1) nextDirectionRef.current = { x: 0, y: 1 };
      else if (dy < 0 && y !== 1) nextDirectionRef.current = { x: 0, y: -1 };
    }
    touchStartRef.current = null;
  };

  // 效果颜色映射
  const effectColor: Record<string, string> = {
    speed: 'text-yellow-400',
    slow: 'text-blue-400',
    diamond: 'text-cyan-400',
  };
  const effectBarColor: Record<string, string> = {
    speed: '#facc15',
    slow: '#60a5fa',
    diamond: '#22d3ee',
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-4 font-pixel bg-slate-900 text-slate-100 selection:bg-green-500/30">

      {/* 顶部信息栏 */}
      <div className="w-full max-w-[608px] mb-3 flex justify-between items-end">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <h1 className="text-3xl text-green-400 drop-shadow-[0_0_8px_rgba(74,222,128,0.5)]">SNAKE</h1>
            <button
              onClick={openSettings}
              className="flex items-center gap-1.5 text-slate-400 hover:text-slate-100 transition-colors cursor-pointer"
            >
              <Palette size={15} />
              <span className="text-xs">个性化</span>
            </button>
          </div>
          <div className="flex items-center gap-3">
            <div className="text-sm text-slate-400">SCORE: <span className="text-white">{score.toString().padStart(4, '0')}</span></div>
            {combo >= 2 && (
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] text-orange-400 animate-pulse">COMBO</span>
                <span className="text-sm text-orange-300">{combo}</span>
                <span className="text-[10px] text-yellow-500">×{getComboMultiplier(combo)}</span>
              </div>
            )}
          </div>
        </div>
        <div className="text-right">
          <div className="flex items-center justify-end gap-2 text-yellow-400 text-sm mb-2">
            {isCloudSyncing ? <Cloud size={16} className="animate-pulse text-blue-400" /> : <Trophy size={16} />}
            <span>HI-SCORE</span>
          </div>
          <div className="text-base">{highScores[0].toString().padStart(4, '0')}</div>
        </div>
      </div>

      {/* 效果状态栏 */}
      <div className="w-full max-w-[608px] mb-2 h-6 flex items-center">
        {activeEffect ? (
          <div className="flex items-center gap-2 w-full">
            <span className="text-xs">{ITEM_CONFIG[activeEffect.type].emoji}</span>
            <span className={`text-xs ${effectColor[activeEffect.type]}`}>
              {ITEM_CONFIG[activeEffect.type].label}
            </span>
            <div className="flex-1 h-1.5 bg-slate-700 rounded-full overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-1000"
                style={{
                  width: `${(effectTimeLeft / (EFFECT_DURATION / 1000)) * 100}%`,
                  backgroundColor: effectBarColor[activeEffect.type],
                }}
              />
            </div>
            <span className="text-xs text-slate-400">{effectTimeLeft}s</span>
          </div>
        ) : null}
      </div>

      {/* 游戏画布区域 */}
      <div
        className="relative bg-slate-950 p-2 rounded-xl shadow-[0_0_30px_rgba(0,0,0,0.5)] border border-slate-800"
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
      >
        <canvas
          ref={canvasRef}
          width={CANVAS_SIZE}
          height={CANVAS_SIZE}
          className="bg-slate-950 rounded-lg block"
          style={{ imageRendering: 'pixelated', width: '100%', maxWidth: '600px', aspectRatio: '1/1' }}
        />

        {/* 吃到道具时的提示 */}
        {lastEatenItem && (
          <div className="absolute top-4 left-1/2 -translate-x-1/2 pointer-events-none animate-bounce">
            <div
              className="px-3 py-1 rounded-full text-xs font-bold flex items-center gap-1 shadow-lg"
              style={{ backgroundColor: ITEM_CONFIG[lastEatenItem].bg, border: `1px solid ${ITEM_CONFIG[lastEatenItem].border}`, color: ITEM_CONFIG[lastEatenItem].border }}
            >
              <span>{ITEM_CONFIG[lastEatenItem].emoji}</span>
              <span>{ITEM_CONFIG[lastEatenItem].desc}</span>
            </div>
          </div>
        )}

        {/* 开始界面 */}
        {!hasStarted && !gameOver && (
          <div className="absolute inset-0 flex flex-col items-center justify-between bg-black/70 rounded-xl backdrop-blur-sm pt-8 pb-12">
            {/* 排行榜 + 道具图例并排 */}
            <div className="flex gap-4 px-6 w-full justify-center">
              {/* 排行榜 */}
              <div className="flex-1 max-w-[220px] bg-slate-900/80 px-6 py-6 rounded-lg border border-slate-700 shadow-xl flex flex-col">
                <div className="text-yellow-400 text-sm mb-5 text-center flex items-center justify-center gap-2">
                  <Trophy size={16} /> TOP 5 <Trophy size={16} />
                </div>
                <div className="flex flex-col justify-between flex-1">
                  {highScores.map((s, i) => (
                    <div key={i} className={`flex justify-between text-base ${i === 0 ? 'text-yellow-400' : 'text-slate-300'}`}>
                      <span className="text-slate-500">#{i + 1}</span>
                      <span>{s.toString().padStart(4, '0')}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* 道具图例 */}
              <div className="flex-1 max-w-[260px] bg-slate-900/80 px-6 py-6 rounded-lg border border-slate-700 flex flex-col">
                <div className="text-slate-400 text-sm mb-5 text-center">— 特殊道具 —</div>
                <div className="flex flex-col justify-between flex-1">
                  {(Object.entries(ITEM_CONFIG) as [SpecialItemType, typeof ITEM_CONFIG[SpecialItemType]][]).map(([type, cfg]) => (
                    <div key={type} className="flex items-center gap-3">
                      <span className="text-xl leading-none">{cfg.emoji}</span>
                      <span className="text-sm font-bold w-12 shrink-0" style={{ color: cfg.border }}>{cfg.label}</span>
                      <span className="text-xs text-slate-400">{cfg.desc}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <button
              onClick={() => setHasStarted(true)}
              className="group flex flex-col items-center gap-3 hover:scale-110 transition-transform cursor-pointer"
            >
              <div className="drop-shadow-[0_0_12px_rgba(34,197,94,0.5)] group-hover:drop-shadow-[0_0_24px_rgba(34,197,94,0.8)] transition-all">
                {/* 像素风蛇头，朝右，顶视角 */}
                <svg
                  width="104" height="80" viewBox="0 0 13 10"
                  className="snake-head-svg"
                  style={{ imageRendering: 'pixelated', shapeRendering: 'crispEdges' }}
                >
                  <rect x="0" y="1" width="9" height="8" fill={SKIN_CONFIG[selectedSkin].head}/>
                  <rect x="1" y="0" width="7" height="10" fill={SKIN_CONFIG[selectedSkin].head}/>
                  <rect x="7" y="2" width="3" height="6" fill={SKIN_CONFIG[selectedSkin].head}/>
                  <rect x="6" y="2" width="1" height="2" fill="#0f172a"/>
                  <rect x="6" y="6" width="1" height="2" fill="#0f172a"/>
                  <g className="snake-tongue">
                    <rect x="10" y="4" width="1" height="2" fill="#ef4444"/>
                    <rect x="11" y="3" width="2" height="2" fill="#ef4444"/>
                    <rect x="11" y="5" width="2" height="2" fill="#ef4444"/>
                  </g>
                </svg>
              </div>
              <span className="text-xs text-green-400 animate-pulse">PRESS TO START</span>
            </button>
          </div>
        )}
        {/* 个性化面板 */}
        {showSettings && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/85 rounded-xl backdrop-blur-sm z-20">
            <div className="bg-slate-900 border border-slate-700 rounded-xl p-5 w-[88%] max-w-sm shadow-2xl">
              <div className="flex justify-between items-center mb-5">
                <div className="flex items-center gap-2 text-slate-200 text-sm">
                  <Palette size={14} /> 个性化
                </div>
                <button onClick={() => setShowSettings(false)} className="text-slate-500 hover:text-white transition-colors text-lg leading-none cursor-pointer">✕</button>
              </div>

              {/* 蛇皮肤 */}
              <div className="mb-5">
                <div className="text-[10px] text-slate-400 mb-3 tracking-widest">SNAKE SKIN</div>
                <div className="grid grid-cols-3 gap-2">
                  {(Object.entries(SKIN_CONFIG) as [SnakeSkin, typeof SKIN_CONFIG[SnakeSkin]][]).map(([key, cfg]) => (
                    <button key={key} onClick={() => updateSkin(key)} className={`py-2 px-1 rounded flex flex-col items-center gap-1.5 border transition-colors cursor-pointer ${selectedSkin === key ? 'border-white bg-slate-800' : 'border-slate-700 hover:border-slate-500'}`}>
                      <div className="flex gap-0.5">
                        <div style={{ width: 14, height: 14, backgroundColor: cfg.head }} />
                        <div style={{ width: 14, height: 14, backgroundColor: cfg.body }} />
                      </div>
                      <span className="text-[9px]" style={{ color: cfg.head }}>{cfg.label}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* 水果种类 */}
              <div>
                <div className="text-[10px] text-slate-400 mb-3 tracking-widest">FRUIT TYPE</div>
                <div className="grid grid-cols-3 gap-2">
                  {(Object.entries(FRUIT_CONFIG) as [FruitType, typeof FRUIT_CONFIG[FruitType]][]).map(([key, cfg]) => (
                    <button key={key} onClick={() => updateFruit(key)} className={`py-2 px-1 rounded flex flex-col items-center gap-1 border transition-colors cursor-pointer ${selectedFruit === key ? 'border-white bg-slate-800' : 'border-slate-700 hover:border-slate-500'}`}>
                      <span className="text-2xl leading-none">{cfg.emoji}</span>
                      <span className="text-[9px] text-slate-300">{cfg.label}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* 暂停 */}
        {isPaused && hasStarted && !gameOver && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/60 rounded-xl backdrop-blur-sm">
            <div className="text-xl text-yellow-400 mb-4 tracking-widest">PAUSED</div>
            <button
              onClick={() => setIsPaused(false)}
              className="px-4 py-2 bg-slate-800 border border-slate-700 rounded text-xs hover:bg-slate-700 transition-colors cursor-pointer"
            >
              RESUME
            </button>
          </div>
        )}

        {/* 游戏结束 */}
        {gameOver && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/80 rounded-xl backdrop-blur-sm">
            <div className="text-2xl text-red-500 mb-2 drop-shadow-[0_0_10px_rgba(239,68,68,0.8)]">GAME OVER</div>
            <div className="text-xs text-slate-300 mb-5">FINAL SCORE: {score}</div>
            <div className="mb-6 w-48 bg-slate-900/80 p-4 rounded-lg border border-slate-700 shadow-xl">
              <div className="text-yellow-400 text-[10px] mb-3 text-center flex items-center justify-center gap-2">
                <Trophy size={12} /> TOP 5 SCORES <Trophy size={12} />
              </div>
              {highScores.map((s, i) => {
                const isCurrentScore = s === score && score > 0;
                return (
                  <div key={i} className={`flex justify-between text-[10px] mb-2 last:mb-0 ${isCurrentScore ? 'text-green-400 animate-pulse' : i === 0 ? 'text-yellow-400' : 'text-slate-300'}`}>
                    <span>#{i + 1}</span>
                    <span>{s.toString().padStart(4, '0')}</span>
                  </div>
                );
              })}
            </div>
            <div className="flex gap-3">
              <button
                onClick={() => { setGameOver(false); setHasStarted(false); }}
                className="flex items-center gap-2 px-4 py-3 bg-slate-700 text-slate-200 rounded hover:bg-slate-600 transition-colors cursor-pointer"
              >
                <House size={16} />
                <span className="text-xs font-bold">HOME</span>
              </button>
              <button
                onClick={resetGame}
                className="group flex items-center gap-3 px-6 py-3 bg-green-500 text-slate-950 rounded hover:bg-green-400 transition-colors shadow-[0_0_15px_rgba(34,197,94,0.3)] cursor-pointer"
              >
                <RotateCcw size={18} className="group-hover:-rotate-180 transition-transform duration-500" />
                <span className="text-xs font-bold">PLAY AGAIN</span>
              </button>
            </div>
          </div>
        )}
      </div>

      {/* 移动端方向键 */}
      <div className="mt-6 grid grid-cols-3 gap-2 md:hidden w-full max-w-[240px]">
        <div />
        <button className="bg-slate-800 p-4 rounded-lg flex items-center justify-center active:bg-slate-700 active:scale-95 transition-all cursor-pointer" onClick={() => handleDirectionClick(0, -1)}>
          <ChevronUp size={24} />
        </button>
        <div />
        <button className="bg-slate-800 p-4 rounded-lg flex items-center justify-center active:bg-slate-700 active:scale-95 transition-all cursor-pointer" onClick={() => handleDirectionClick(-1, 0)}>
          <ChevronLeft size={24} />
        </button>
        <button className="bg-slate-800 p-4 rounded-lg flex items-center justify-center active:bg-slate-700 active:scale-95 transition-all text-yellow-500 cursor-pointer" onClick={() => hasStarted ? setIsPaused(!isPaused) : setHasStarted(true)}>
          {isPaused ? <Play size={20} fill="currentColor" /> : <Pause size={20} fill="currentColor" />}
        </button>
        <button className="bg-slate-800 p-4 rounded-lg flex items-center justify-center active:bg-slate-700 active:scale-95 transition-all cursor-pointer" onClick={() => handleDirectionClick(1, 0)}>
          <ChevronRight size={24} />
        </button>
        <div />
        <button className="bg-slate-800 p-4 rounded-lg flex items-center justify-center active:bg-slate-700 active:scale-95 transition-all cursor-pointer" onClick={() => handleDirectionClick(0, 1)}>
          <ChevronDown size={24} />
        </button>
        <div />
      </div>

      <div className="mt-6 text-[10px] text-slate-500 hidden md:block text-center leading-relaxed">
        USE ARROW KEYS OR WASD TO MOVE · SPACE TO PAUSE
      </div>
    </div>
  );
}
