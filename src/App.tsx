/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Trophy, Play, RotateCcw, Pause, ChevronUp, ChevronDown, ChevronLeft, ChevronRight, Cloud } from 'lucide-react';
import { signInAnonymously, onAuthStateChanged } from 'firebase/auth';
import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore';
import { auth, db } from './firebase';

const GRID_SIZE = 20;
const CELL_SIZE = 20;
const CANVAS_SIZE = GRID_SIZE * CELL_SIZE;
const INITIAL_SPEED = 250;
const MIN_SPEED = 60;
const SPEED_DECREMENT = 2;

type Point = { x: number; y: number };

const INITIAL_SNAKE: Point[] = [
  { x: 10, y: 10 },
  { x: 10, y: 11 },
  { x: 10, y: 12 },
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

  // Initialize Firebase Auth
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      if (user) {
        setUserId(user.uid);
        // Fetch scores from cloud
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
            // Try to migrate local storage scores to cloud
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
            await setDoc(docRef, {
              highScores: localScores,
              updatedAt: serverTimestamp()
            });
          }
        } catch (error) {
          console.error("Error fetching scores:", error);
        } finally {
          setIsCloudSyncing(false);
        }
      } else {
        // Sign in anonymously if not logged in
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

  const generateFood = useCallback((snake: Point[]): Point => {
    let newFood: Point;
    while (true) {
      newFood = {
        x: Math.floor(Math.random() * GRID_SIZE),
        y: Math.floor(Math.random() * GRID_SIZE),
      };
      // eslint-disable-next-line no-loop-func
      if (!snake.some((segment) => segment.x === newFood.x && segment.y === newFood.y)) {
        break;
      }
    }
    return newFood;
  }, []);

  const handleGameOver = useCallback(() => {
    setGameOver(true);
    setHasStarted(false);
    setHighScores((prev) => {
      const newScores = [...prev, score].sort((a, b) => b - a).slice(0, 5);
      
      // Save to local storage as backup
      localStorage.setItem('snakeHighScores', JSON.stringify(newScores));
      
      // Save to cloud if authenticated
      if (userId) {
        setIsCloudSyncing(true);
        setDoc(doc(db, 'userScores', userId), {
          highScores: newScores,
          updatedAt: serverTimestamp()
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
    setScore(0);
    setGameOver(false);
    setHasStarted(true);
    setIsPaused(false);
    lastMoveTimeRef.current = performance.now();
  }, [generateFood]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Clear canvas
    ctx.fillStyle = '#020617'; // slate-950
    ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

    // Draw grid
    ctx.strokeStyle = '#0f172a'; // slate-900
    ctx.lineWidth = 1;
    for (let i = 0; i <= CANVAS_SIZE; i += CELL_SIZE) {
      ctx.beginPath();
      ctx.moveTo(i, 0);
      ctx.lineTo(i, CANVAS_SIZE);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, i);
      ctx.lineTo(CANVAS_SIZE, i);
      ctx.stroke();
    }

    // Draw food (apple)
    ctx.fillStyle = '#ef4444'; // red-500
    const fx = foodRef.current.x * CELL_SIZE;
    const fy = foodRef.current.y * CELL_SIZE;
    ctx.fillRect(fx + 2, fy + 2, CELL_SIZE - 4, CELL_SIZE - 4);
    // Apple stem
    ctx.fillStyle = '#22c55e'; // green-500
    ctx.fillRect(fx + CELL_SIZE / 2 - 2, fy, 4, 4);

    // Draw snake
    snakeRef.current.forEach((segment, index) => {
      const isHead = index === 0;
      const x = segment.x * CELL_SIZE;
      const y = segment.y * CELL_SIZE;

      ctx.fillStyle = isHead ? '#22c55e' : '#4ade80'; // green-500 : green-400
      ctx.fillRect(x + 1, y + 1, CELL_SIZE - 2, CELL_SIZE - 2);

      // Draw eyes for head
      if (isHead) {
        ctx.fillStyle = '#000000';
        const dir = directionRef.current;
        const eyeSize = 4;
        
        // Position eyes based on direction
        if (dir.x === 1) { // Right
          ctx.fillRect(x + CELL_SIZE - 6, y + 4, eyeSize, eyeSize);
          ctx.fillRect(x + CELL_SIZE - 6, y + CELL_SIZE - 8, eyeSize, eyeSize);
        } else if (dir.x === -1) { // Left
          ctx.fillRect(x + 2, y + 4, eyeSize, eyeSize);
          ctx.fillRect(x + 2, y + CELL_SIZE - 8, eyeSize, eyeSize);
        } else if (dir.y === 1) { // Down
          ctx.fillRect(x + 4, y + CELL_SIZE - 6, eyeSize, eyeSize);
          ctx.fillRect(x + CELL_SIZE - 8, y + CELL_SIZE - 6, eyeSize, eyeSize);
        } else { // Up
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

    if (time - lastMoveTimeRef.current >= speedRef.current) {
      const snake = [...snakeRef.current];
      const direction = nextDirectionRef.current;
      directionRef.current = direction;

      const head = { ...snake[0] };
      head.x += direction.x;
      head.y += direction.y;

      // Check collision with walls
      if (head.x < 0 || head.x >= GRID_SIZE || head.y < 0 || head.y >= GRID_SIZE) {
        handleGameOver();
        return;
      }

      // Check collision with self
      if (snake.some((segment) => segment.x === head.x && segment.y === head.y)) {
        handleGameOver();
        return;
      }

      snake.unshift(head);

      // Check food
      if (head.x === foodRef.current.x && head.y === foodRef.current.y) {
        setScore((s) => {
          const newScore = s + 10;
          // Increase speed slightly every 50 points
          if (newScore % 50 === 0) {
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
  }, [gameOver, isPaused, hasStarted, draw, handleGameOver, generateFood]);

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
        case 'ArrowUp':
        case 'w':
        case 'W':
          if (!hasStarted) setHasStarted(true);
          if (y !== 1) nextDirectionRef.current = { x: 0, y: -1 };
          break;
        case 'ArrowDown':
        case 's':
        case 'S':
          if (!hasStarted) setHasStarted(true);
          if (y !== -1) nextDirectionRef.current = { x: 0, y: 1 };
          break;
        case 'ArrowLeft':
        case 'a':
        case 'A':
          if (!hasStarted) setHasStarted(true);
          if (x !== 1) nextDirectionRef.current = { x: -1, y: 0 };
          break;
        case 'ArrowRight':
        case 'd':
        case 'D':
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

  // Touch swipe handling
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  
  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartRef.current = {
      x: e.touches[0].clientX,
      y: e.touches[0].clientY
    };
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (!touchStartRef.current || gameOver) return;
    
    const touchEndX = e.changedTouches[0].clientX;
    const touchEndY = e.changedTouches[0].clientY;
    
    const dx = touchEndX - touchStartRef.current.x;
    const dy = touchEndY - touchStartRef.current.y;
    
    // Minimum swipe distance
    if (Math.abs(dx) < 30 && Math.abs(dy) < 30) return;
    
    if (!hasStarted) setHasStarted(true);
    if (isPaused) setIsPaused(false);
    
    const { x, y } = directionRef.current;
    
    if (Math.abs(dx) > Math.abs(dy)) {
      // Horizontal swipe
      if (dx > 0 && x !== -1) nextDirectionRef.current = { x: 1, y: 0 };
      else if (dx < 0 && x !== 1) nextDirectionRef.current = { x: -1, y: 0 };
    } else {
      // Vertical swipe
      if (dy > 0 && y !== -1) nextDirectionRef.current = { x: 0, y: 1 };
      else if (dy < 0 && y !== 1) nextDirectionRef.current = { x: 0, y: -1 };
    }
    
    touchStartRef.current = null;
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-4 font-pixel bg-slate-900 text-slate-100 selection:bg-green-500/30">
      
      <div className="w-full max-w-md mb-6 flex justify-between items-end">
        <div>
          <h1 className="text-2xl md:text-3xl text-green-400 mb-2 drop-shadow-[0_0_8px_rgba(74,222,128,0.5)]">SNAKE</h1>
          <div className="text-xs text-slate-400">SCORE: <span className="text-white">{score.toString().padStart(4, '0')}</span></div>
        </div>
        <div className="text-right">
          <div className="flex items-center justify-end gap-2 text-yellow-400 text-xs mb-1">
            {isCloudSyncing ? <Cloud size={14} className="animate-pulse text-blue-400" /> : <Trophy size={14} />}
            <span>HI-SCORE</span>
          </div>
          <div className="text-sm">{highScores[0].toString().padStart(4, '0')}</div>
        </div>
      </div>

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
          style={{ 
            imageRendering: 'pixelated',
            width: '100%',
            maxWidth: '400px',
            aspectRatio: '1/1'
          }}
        />

        {/* Overlays */}
        {(!hasStarted && !gameOver) && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/70 rounded-xl backdrop-blur-sm">
            <div className="mb-8 w-48 bg-slate-900/80 p-4 rounded-lg border border-slate-700 shadow-xl">
              <div className="text-yellow-400 text-[10px] mb-3 text-center flex items-center justify-center gap-2">
                <Trophy size={12} /> TOP 5 SCORES <Trophy size={12} />
              </div>
              {highScores.map((s, i) => (
                <div key={i} className={`flex justify-between text-[10px] mb-2 last:mb-0 ${i === 0 ? 'text-yellow-400' : 'text-slate-300'}`}>
                  <span>#{i + 1}</span>
                  <span>{s.toString().padStart(4, '0')}</span>
                </div>
              ))}
            </div>

            <button 
              onClick={() => setHasStarted(true)}
              className="group flex flex-col items-center gap-4 hover:scale-105 transition-transform cursor-pointer"
            >
              <div className="w-16 h-16 bg-green-500 rounded-full flex items-center justify-center text-slate-950 shadow-[0_0_20px_rgba(34,197,94,0.4)] group-hover:shadow-[0_0_30px_rgba(34,197,94,0.6)]">
                <Play size={32} className="ml-2" fill="currentColor" />
              </div>
              <span className="text-xs text-green-400 animate-pulse">PRESS TO START</span>
            </button>
          </div>
        )}

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

        {gameOver && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/80 rounded-xl backdrop-blur-sm">
            <div className="text-2xl text-red-500 mb-2 drop-shadow-[0_0_10px_rgba(239,68,68,0.8)]">GAME OVER</div>
            <div className="text-xs text-slate-300 mb-6">FINAL SCORE: {score}</div>
            
            <div className="mb-8 w-48 bg-slate-900/80 p-4 rounded-lg border border-slate-700 shadow-xl">
              <div className="text-yellow-400 text-[10px] mb-3 text-center flex items-center justify-center gap-2">
                <Trophy size={12} /> TOP 5 SCORES <Trophy size={12} />
              </div>
              {highScores.map((s, i) => {
                const isCurrentScore = s === score && score > 0;
                return (
                  <div key={i} className={`flex justify-between text-[10px] mb-2 last:mb-0 ${isCurrentScore ? 'text-green-400 animate-pulse' : (i === 0 ? 'text-yellow-400' : 'text-slate-300')}`}>
                    <span>#{i + 1}</span>
                    <span>{s.toString().padStart(4, '0')}</span>
                  </div>
                );
              })}
            </div>

            <button 
              onClick={resetGame}
              className="group flex items-center gap-3 px-6 py-3 bg-green-500 text-slate-950 rounded hover:bg-green-400 transition-colors shadow-[0_0_15px_rgba(34,197,94,0.3)] cursor-pointer"
            >
              <RotateCcw size={18} className="group-hover:-rotate-180 transition-transform duration-500" />
              <span className="text-xs font-bold">PLAY AGAIN</span>
            </button>
          </div>
        )}
      </div>

      {/* Mobile Controls */}
      <div className="mt-8 grid grid-cols-3 gap-2 md:hidden w-full max-w-[240px]">
        <div />
        <button 
          className="bg-slate-800 p-4 rounded-lg flex items-center justify-center active:bg-slate-700 active:scale-95 transition-all cursor-pointer"
          onClick={() => handleDirectionClick(0, -1)}
        >
          <ChevronUp size={24} />
        </button>
        <div />
        <button 
          className="bg-slate-800 p-4 rounded-lg flex items-center justify-center active:bg-slate-700 active:scale-95 transition-all cursor-pointer"
          onClick={() => handleDirectionClick(-1, 0)}
        >
          <ChevronLeft size={24} />
        </button>
        <button 
          className="bg-slate-800 p-4 rounded-lg flex items-center justify-center active:bg-slate-700 active:scale-95 transition-all text-yellow-500 cursor-pointer"
          onClick={() => hasStarted ? setIsPaused(!isPaused) : setHasStarted(true)}
        >
          {isPaused ? <Play size={20} fill="currentColor" /> : <Pause size={20} fill="currentColor" />}
        </button>
        <button 
          className="bg-slate-800 p-4 rounded-lg flex items-center justify-center active:bg-slate-700 active:scale-95 transition-all cursor-pointer"
          onClick={() => handleDirectionClick(1, 0)}
        >
          <ChevronRight size={24} />
        </button>
        <div />
        <button 
          className="bg-slate-800 p-4 rounded-lg flex items-center justify-center active:bg-slate-700 active:scale-95 transition-all cursor-pointer"
          onClick={() => handleDirectionClick(0, 1)}
        >
          <ChevronDown size={24} />
        </button>
        <div />
      </div>

      <div className="mt-8 text-[10px] text-slate-500 hidden md:block text-center leading-relaxed">
        USE ARROW KEYS OR WASD TO MOVE<br/>
        SPACE TO PAUSE
      </div>
    </div>
  );
}
