// Input: keyboard + mouse (Pointer Lock on desktop; press-and-drag look where Pointer Lock is
// missing, e.g. iPadOS Safari with a trackpad) and on-screen touch controls. Everything goes
// through the `InputFrame` interface so more controllers can be added later.
import type { Settings } from '../quality';
import { isTouchDevice } from '../quality';

export type Action =
  | 'forward'
  | 'back'
  | 'left'
  | 'right'
  | 'sprint'
  | 'crouch'
  | 'sit'
  | 'interact'
  | 'nextVerb'
  | 'phone'
  | 'laptop'
  | 'switch'
  | 'content'
  | 'earbud'
  | 'leanLeft'
  | 'leanRight'
  | 'throw'
  | 'paper'
  | 'note'
  | 'raiseHand'
  | 'cheat'
  | 'notebook'
  | 'work'
  | 'peek'
  | 'pause'
  | 'debug'
  | 'freecam'
  | 'brightUp'
  | 'brightDown'
  | 'plane';

export interface InputFrame {
  /** Local move: x = strafe right, y = forward. */
  move: { x: number; y: number };
  look: { dx: number; dy: number };
  held: Set<Action>;
  pressed: Set<Action>;
  released: Set<Action>;
}

export interface Controller {
  poll(into: InputFrame): void;
  dispose(): void;
}

const FIXED: Record<string, Action> = {
  Escape: 'pause',
  F3: 'debug',
  Backquote: 'debug',
  F4: 'freecam',
  Period: 'brightUp',
  Comma: 'brightDown',
  KeyH: 'work',
  KeyY: 'peek',
  ArrowUp: 'forward',
  ArrowDown: 'back',
  ArrowLeft: 'left',
  ArrowRight: 'right',
};

const MOUSE_RAD_PER_PX = 0.0022;
const TOUCH_RAD_PER_PX = 0.005;

class KeyboardMouse implements Controller {
  private held = new Set<Action>();
  private pressed = new Set<Action>();
  private released = new Set<Action>();
  private dx = 0;
  private dy = 0;
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private keyMap = new Map<string, Action>();
  private el: HTMLElement;
  private settings: Settings;
  locked = false;
  /** Set by the app: when false, clicks don't grab the pointer (menus open). */
  wantLock = true;
  private readonly lockSupported: boolean;
  private off: (() => void)[] = [];
  onWheel: ((dir: number) => void) | null = null;

  constructor(el: HTMLElement, settings: Settings) {
    this.el = el;
    this.settings = settings;
    this.lockSupported =
      'requestPointerLock' in el &&
      !/iPad|iPhone/.test(navigator.userAgent) &&
      !(navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));
    this.rebind();
    const on = (
      t: string,
      f: (e: never) => void,
      target: Window | Document | HTMLElement = window,
    ) => {
      target.addEventListener(t, f as EventListener, { passive: false });
      this.off.push(() => target.removeEventListener(t, f as EventListener));
    };
    on('keydown', (e: KeyboardEvent) => {
      const a = this.keyMap.get(e.code) ?? FIXED[e.code];
      if (!a) return;
      if (
        (e.target as HTMLElement)?.tagName === 'INPUT' ||
        (e.target as HTMLElement)?.tagName === 'SELECT'
      )
        return;
      e.preventDefault();
      if (e.repeat) return;
      if (a === 'paper' && e.shiftKey) this.pressed.add('plane');
      else this.pressed.add(a);
      this.held.add(a);
    });
    on('keyup', (e: KeyboardEvent) => {
      const a = this.keyMap.get(e.code) ?? FIXED[e.code];
      if (!a) return;
      this.held.delete(a);
      this.released.add(a);
    });
    on('blur', () => {
      for (const a of this.held) this.released.add(a);
      this.held.clear();
    });
    on('mousedown', (e: MouseEvent) => {
      if ((e.target as HTMLElement) !== this.el) return;
      if (this.lockSupported && !this.locked && this.wantLock) {
        void (this.el.requestPointerLock as () => Promise<void> | void)?.call(this.el);
        return;
      }
      if (e.button === 0) {
        if (this.locked) this.held.add('work');
        else {
          this.dragging = true;
          this.lastX = e.clientX;
          this.lastY = e.clientY;
        }
      }
      if (e.button === 2) this.held.add('peek');
    });
    on('mouseup', (e: MouseEvent) => {
      if (e.button === 0) {
        this.held.delete('work');
        this.dragging = false;
      }
      if (e.button === 2) this.held.delete('peek');
    });
    on('mousemove', (e: MouseEvent) => {
      if (this.locked) {
        this.dx += e.movementX;
        this.dy += e.movementY;
      } else if (this.dragging) {
        this.dx += e.clientX - this.lastX;
        this.dy += e.clientY - this.lastY;
        this.lastX = e.clientX;
        this.lastY = e.clientY;
      }
    });
    on('contextmenu', (e: Event) => e.preventDefault(), this.el);
    on(
      'wheel',
      (e: WheelEvent) => {
        // Two-finger trackpad scroll on iPad also turns the view when not locked.
        if (!this.locked && Math.abs(e.deltaX) > Math.abs(e.deltaY) * 1.5) {
          this.dx += e.deltaX * 0.6;
          return;
        }
        this.onWheel?.(Math.sign(e.deltaY));
      },
      this.el,
    );
    on(
      'pointerlockchange',
      () => {
        this.locked = document.pointerLockElement === this.el;
      },
      document,
    );
  }

  rebind(): void {
    this.keyMap.clear();
    for (const [a, code] of Object.entries(this.settings.bindings))
      this.keyMap.set(code, a as Action);
  }

  unlock(): void {
    if (this.locked) document.exitPointerLock?.();
  }

  poll(f: InputFrame): void {
    const k = this.held;
    f.move.x += (k.has('right') ? 1 : 0) - (k.has('left') ? 1 : 0);
    f.move.y += (k.has('forward') ? 1 : 0) - (k.has('back') ? 1 : 0);
    f.look.dx += this.dx * MOUSE_RAD_PER_PX;
    f.look.dy += this.dy * MOUSE_RAD_PER_PX;
    this.dx = 0;
    this.dy = 0;
    for (const a of k) f.held.add(a);
    for (const a of this.pressed) f.pressed.add(a);
    for (const a of this.released) f.released.add(a);
    this.pressed.clear();
    this.released.clear();
  }

  dispose(): void {
    this.off.forEach((f) => f());
  }
}

const TOUCH_CSS = `
.tc{position:fixed;inset:0;pointer-events:none;z-index:15;user-select:none;-webkit-user-select:none;touch-action:none}
.tc.hidden{display:none}
.tc-left,.tc-right{position:absolute;top:0;bottom:0;pointer-events:auto;touch-action:none}
.tc-left{left:0;width:45%}.tc-right{right:0;width:55%}
.tc-base,.tc-knob{position:fixed;border-radius:50%;pointer-events:none;display:none;transform:translate(-50%,-50%)}
.tc-base{width:120px;height:120px;border:2px solid rgba(255,255,255,.45);background:rgba(255,255,255,.08)}
.tc-knob{width:52px;height:52px;background:rgba(255,255,255,.5)}
.tc-btns{position:absolute;right:calc(env(safe-area-inset-right,0px) + 14px);bottom:calc(env(safe-area-inset-bottom,0px) + 14px);display:grid;grid-template-columns:repeat(4,58px);gap:10px;pointer-events:none}
.tc-top{position:absolute;right:calc(env(safe-area-inset-right,0px) + 14px);top:calc(env(safe-area-inset-top,0px) + 56px);display:flex;gap:10px;pointer-events:none}
.tc-b{pointer-events:auto;touch-action:none;width:58px;height:58px;border-radius:29px;border:1px solid rgba(255,255,255,.55);background:rgba(20,22,26,.55);color:#fff;font:600 11px/1.1 system-ui,sans-serif;display:flex;align-items:center;justify-content:center;text-align:center;-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px)}
.tc-b.on{background:rgba(255,255,255,.45);color:#111}
`;

class Touch implements Controller {
  private root: HTMLDivElement;
  private held = new Set<Action>();
  private pressed = new Set<Action>();
  private released = new Set<Action>();
  private joy: { id: number; x: number; y: number; dx: number; dy: number } | null = null;
  private look: { id: number; x: number; y: number } | null = null;
  private dx = 0;
  private dy = 0;
  private base: HTMLDivElement;
  private knob: HTMLDivElement;
  private btns = new Map<Action, HTMLButtonElement>();

  constructor() {
    const style = document.createElement('style');
    style.textContent = TOUCH_CSS;
    document.head.appendChild(style);
    this.root = document.createElement('div');
    this.root.className = 'tc';
    const left = document.createElement('div');
    left.className = 'tc-left';
    const right = document.createElement('div');
    right.className = 'tc-right';
    this.base = document.createElement('div');
    this.base.className = 'tc-base';
    this.knob = document.createElement('div');
    this.knob.className = 'tc-knob';
    this.root.append(left, right, this.base, this.knob);
    const grid = document.createElement('div');
    grid.className = 'tc-btns';
    const top = document.createElement('div');
    top.className = 'tc-top';
    const mk = (parent: HTMLElement, a: Action, label: string, hold = false) => {
      const b = document.createElement('button');
      b.className = 'tc-b';
      b.textContent = label;
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.pressed.add(a);
        this.held.add(a);
        b.classList.add('on');
        if (!hold) setTimeout(() => b.classList.remove('on'), 120);
      });
      const up = (e: Event) => {
        e.preventDefault();
        if (this.held.delete(a)) this.released.add(a);
        b.classList.remove('on');
      };
      b.addEventListener('pointerup', up);
      b.addEventListener('pointercancel', up);
      b.addEventListener('pointerleave', up);
      parent.appendChild(b);
      this.btns.set(a, b);
    };
    mk(top, 'pause', '☰ Menu');
    mk(top, 'notebook', 'Note-\nbook');
    mk(top, 'raiseHand', '✋');
    mk(grid, 'note', 'Note');
    mk(grid, 'paper', 'Paper');
    mk(grid, 'throw', 'Throw\n(hold)', true);
    mk(grid, 'crouch', 'Crouch');
    mk(grid, 'phone', 'Phone');
    mk(grid, 'switch', 'Switch');
    mk(grid, 'work', 'Work\n(hold)', true);
    mk(grid, 'sit', 'Sit/\nStand');
    mk(grid, 'content', 'Game/\nVideo');
    mk(grid, 'earbud', '🎧');
    mk(grid, 'peek', 'Peek\n(hold)', true);
    mk(grid, 'interact', 'Use');
    this.root.append(grid, top);
    document.body.appendChild(this.root);

    left.addEventListener('pointerdown', (e) => {
      if (this.joy) return;
      left.setPointerCapture(e.pointerId);
      this.joy = { id: e.pointerId, x: e.clientX, y: e.clientY, dx: 0, dy: 0 };
      this.base.style.display = this.knob.style.display = 'block';
      this.base.style.left = this.knob.style.left = `${e.clientX}px`;
      this.base.style.top = this.knob.style.top = `${e.clientY}px`;
    });
    left.addEventListener('pointermove', (e) => {
      if (!this.joy || e.pointerId !== this.joy.id) return;
      let dx = e.clientX - this.joy.x;
      let dy = e.clientY - this.joy.y;
      const d = Math.hypot(dx, dy);
      if (d > 60) {
        dx = (dx / d) * 60;
        dy = (dy / d) * 60;
      }
      this.joy.dx = dx / 60;
      this.joy.dy = dy / 60;
      this.knob.style.left = `${this.joy.x + dx}px`;
      this.knob.style.top = `${this.joy.y + dy}px`;
    });
    const endJoy = (e: PointerEvent) => {
      if (this.joy && e.pointerId === this.joy.id) {
        this.joy = null;
        this.base.style.display = this.knob.style.display = 'none';
      }
    };
    left.addEventListener('pointerup', endJoy);
    left.addEventListener('pointercancel', endJoy);
    right.addEventListener('pointerdown', (e) => {
      if (this.look) return;
      right.setPointerCapture(e.pointerId);
      this.look = { id: e.pointerId, x: e.clientX, y: e.clientY };
    });
    right.addEventListener('pointermove', (e) => {
      if (!this.look || e.pointerId !== this.look.id) return;
      this.dx += e.clientX - this.look.x;
      this.dy += e.clientY - this.look.y;
      this.look.x = e.clientX;
      this.look.y = e.clientY;
    });
    const endLook = (e: PointerEvent) => {
      if (this.look && e.pointerId === this.look.id) this.look = null;
    };
    right.addEventListener('pointerup', endLook);
    right.addEventListener('pointercancel', endLook);
  }

  setVisible(v: boolean): void {
    this.root.classList.toggle('hidden', !v);
  }

  poll(f: InputFrame): void {
    if (this.joy) {
      f.move.x += this.joy.dx;
      f.move.y += -this.joy.dy;
      if (Math.hypot(this.joy.dx, this.joy.dy) > 0.95) f.held.add('sprint');
    }
    f.look.dx += this.dx * TOUCH_RAD_PER_PX;
    f.look.dy += this.dy * TOUCH_RAD_PER_PX;
    this.dx = this.dy = 0;
    for (const a of this.held) f.held.add(a);
    for (const a of this.pressed) f.pressed.add(a);
    for (const a of this.released) f.released.add(a);
    this.pressed.clear();
    this.released.clear();
  }

  dispose(): void {
    this.root.remove();
  }
}

export class InputManager {
  readonly km: KeyboardMouse;
  private touch: Touch | null = null;
  private settings: Settings;
  private frame: InputFrame = {
    move: { x: 0, y: 0 },
    look: { dx: 0, dy: 0 },
    held: new Set(),
    pressed: new Set(),
    released: new Set(),
  };

  constructor(el: HTMLElement, settings: Settings) {
    this.settings = settings;
    this.km = new KeyboardMouse(el, settings);
    this.applySettings(settings);
  }

  applySettings(s: Settings): void {
    this.settings = s;
    this.km.rebind();
    const want = s.touchControls === 'on' || (s.touchControls === 'auto' && isTouchDevice());
    if (want && !this.touch) this.touch = new Touch();
    this.touch?.setVisible(want);
  }

  setTouchVisible(v: boolean): void {
    this.touch?.setVisible(
      v &&
        (this.settings.touchControls === 'on' ||
          (this.settings.touchControls === 'auto' && isTouchDevice())),
    );
  }

  poll(): InputFrame {
    const f = this.frame;
    f.move.x = 0;
    f.move.y = 0;
    f.look.dx = 0;
    f.look.dy = 0;
    f.held.clear();
    f.pressed.clear();
    f.released.clear();
    this.km.poll(f);
    this.touch?.poll(f);
    const s = this.settings.sensitivity;
    f.look.dx *= s;
    f.look.dy *= s * (this.settings.invertY ? -1 : 1);
    const m = Math.hypot(f.move.x, f.move.y);
    if (m > 1) {
      f.move.x /= m;
      f.move.y /= m;
    }
    return f;
  }

  dispose(): void {
    this.km.dispose();
    this.touch?.dispose();
  }
}
