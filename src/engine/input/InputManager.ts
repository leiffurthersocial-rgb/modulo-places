import type { EventBus } from '../core/events';
import { isLikelyIPad, isTouchDevice, type SettingsStore } from '../core/settings';
import type { Action, InputFrame, KeyBindings } from '../types';
import {
  MOUSE_RAD_PER_PX,
  TOUCH_RAD_PER_PX,
  WHEEL_RAD_PER_UNIT,
  clampSpike,
  clampToRadius,
  isTap,
  joystickVector,
  keyboardMove,
  pixelsToLook,
  toNdc,
} from './math';

export type InputMode = 'walk' | 'photo' | 'ui';

const JOY_RADIUS = 60;
const ALWAYS_ACTIONS: ReadonlySet<Action> = new Set<Action>(['menu', 'hideUI', 'debug']);

const CSS = `
.tc-root{position:fixed;inset:0;pointer-events:none;z-index:20;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;touch-action:none}
.tc-root.tc-hidden{display:none}
.tc-zone{position:absolute;top:0;bottom:0;pointer-events:auto;touch-action:none}
.tc-zone-left{left:0;width:50%}
.tc-zone-right{right:0;width:50%}
.tc-stick-base,.tc-stick-knob{position:fixed;border-radius:50%;pointer-events:none;display:none;transform:translate(-50%,-50%)}
.tc-stick-base{width:120px;height:120px;border:2px solid rgba(255,255,255,.45);background:rgba(255,255,255,.08)}
.tc-stick-knob{width:52px;height:52px;background:rgba(255,255,255,.5);border:1px solid rgba(255,255,255,.7)}
.tc-bar{position:absolute;display:flex;gap:12px;pointer-events:none}
.tc-bar-top{top:calc(env(safe-area-inset-top,0px) + 12px);right:calc(env(safe-area-inset-right,0px) + 12px);flex-direction:row}
.tc-bar-bottom{bottom:calc(env(safe-area-inset-bottom,0px) + 16px);right:calc(env(safe-area-inset-right,0px) + 16px);flex-direction:column-reverse;align-items:flex-end}
.tc-btn{pointer-events:auto;touch-action:none;min-width:52px;min-height:52px;padding:0 12px;border-radius:26px;border:1px solid rgba(255,255,255,.55);background:rgba(20,22,26,.5);color:#fff;font:600 13px/1 system-ui,-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);cursor:pointer;margin:0}
.tc-btn.tc-active{background:rgba(255,255,255,.4);color:#111}
.tc-btn-capture{width:84px;height:84px;border-radius:50%;border:3px solid #fff;background:rgba(255,255,255,.25);font-size:14px}
.tc-walk-only,.tc-photo-only{display:none}
.tc-root.tc-mode-walk .tc-walk-only{display:flex}
.tc-root.tc-mode-photo .tc-photo-only{display:flex}
`;

interface TapTrack {
  x: number;
  y: number;
  t: number;
  dist: number;
}

export class InputManager {
  private readonly element: HTMLElement;
  private readonly hudRoot: HTMLElement;
  private readonly settings: SettingsStore;
  private readonly events: EventBus;

  private _mode: InputMode = 'walk';
  private touchSeen = false;
  private lockFailed = false;
  private expectUnlock = false;
  private readonly lockSupported: boolean;

  private bindings: KeyBindings;
  private codeMap = new Map<string, Action[]>();
  private held = new Set<string>();
  private pressed = new Set<Action>();
  private lookX = 0;
  private lookY = 0;

  // touch state
  private joyId: number | null = null;
  private joyOx = 0;
  private joyOy = 0;
  private joyX = 0;
  private joyY = 0;
  private joySprint = false;
  private lookId: number | null = null;
  private lookLast = { x: 0, y: 0 };
  private lookTrack: TapTrack | null = null;
  private touchCrouch = false;
  private hudHeld = new Map<number, 'up' | 'down'>();

  // canvas pointer state (mouse/pen drag-look + tap)
  private canvasPtr = new Map<number, TapTrack>();
  private dragId: number | null = null;
  private dragLast = { x: 0, y: 0 };

  private tapCbs = new Set<(x: number, y: number) => void>();
  private removers: Array<() => void> = [];

  // DOM
  private styleEl: HTMLStyleElement;
  private hud: HTMLDivElement;
  private zoneLeft: HTMLDivElement;
  private zoneRight: HTMLDivElement;
  private stickBase: HTMLDivElement;
  private stickKnob: HTMLDivElement;
  private crouchBtn: HTMLButtonElement;
  private hudVisible = false;
  private disposed = false;

  constructor(opts: { element: HTMLElement; hudRoot: HTMLElement; settings: SettingsStore; events: EventBus }) {
    this.element = opts.element;
    this.hudRoot = opts.hudRoot;
    this.settings = opts.settings;
    this.events = opts.events;
    this.bindings = this.settings.get().bindings;
    this.rebuildCodeMap();
    this.lockSupported =
      typeof document !== 'undefined' &&
      'pointerLockElement' in document &&
      typeof this.element.requestPointerLock === 'function' &&
      !isLikelyIPad();

    // --- HUD DOM ---
    this.styleEl = document.createElement('style');
    this.styleEl.id = 'tc-style';
    this.styleEl.textContent = CSS;
    document.head.appendChild(this.styleEl);

    this.hud = document.createElement('div');
    this.hud.className = 'tc-root tc-hidden';
    this.zoneLeft = this.div('tc-zone tc-zone-left');
    this.zoneRight = this.div('tc-zone tc-zone-right');
    this.stickBase = this.div('tc-stick-base');
    this.stickKnob = this.div('tc-stick-knob');
    const top = this.div('tc-bar tc-bar-top');
    const bottom = this.div('tc-bar tc-bar-bottom');
    this.hud.append(this.zoneLeft, this.zoneRight, this.stickBase, this.stickKnob, top, bottom);

    top.append(
      this.pressButton('Photo', 'Toggle photo mode', 'photoMode'),
      this.pressButton('Mood', 'Cycle lighting mood', 'cycleMood'),
      this.pressButton('Menu', 'Open menu', 'menu'),
    );
    this.crouchBtn = this.makeButton('Crouch', 'Toggle crouch', 'tc-walk-only');
    this.on(this.crouchBtn, 'pointerdown', () => {
      this.touchCrouch = !this.touchCrouch;
      this.crouchBtn.classList.toggle('tc-active', this.touchCrouch);
    });
    const capture = this.pressButton('Capture', 'Take photo', 'capture', 'tc-btn-capture tc-photo-only');
    const up = this.holdButton('Up', 'Move up', 'up');
    const down = this.holdButton('Down', 'Move down', 'down');
    bottom.append(this.crouchBtn, capture, up, down);
    this.hudRoot.appendChild(this.hud);

    this.bindHudZones();
    this.bindGlobal();
    this.bindCanvas();
    this.updateHud();
  }

  // ------------------------------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------------------------------

  get mode(): InputMode {
    return this._mode;
  }

  get pointerLocked(): boolean {
    return document.pointerLockElement === this.element;
  }

  get usingTouch(): boolean {
    return this.touchSeen || this.settings.get().touchControls === 'on';
  }

  setMode(mode: InputMode): void {
    if (mode === this._mode) return;
    this._mode = mode;
    if (mode === 'ui') {
      this.releaseLock();
      this.held.clear();
      this.resetTouch();
      this.lookX = 0;
      this.lookY = 0;
    }
    if (mode === 'photo') {
      this.touchCrouch = false;
      this.crouchBtn.classList.remove('tc-active');
    }
    this.updateHud();
  }

  onCanvasTap(cb: (ndcX: number, ndcY: number) => void): () => void {
    this.tapCbs.add(cb);
    return () => {
      this.tapCbs.delete(cb);
    };
  }

  poll(dt: number): InputFrame {
    if (!(dt >= 0)) dt = 0; // dt is unused: look deltas are already per-frame radians
    const pressed = this.pressed;
    this.pressed = new Set<Action>();
    const lookX = this.lookX;
    const lookY = this.lookY;
    this.lookX = 0;
    this.lookY = 0;

    const frame: InputFrame = {
      move: { x: 0, y: 0 },
      lift: 0,
      look: { x: 0, y: 0 },
      sprint: false,
      slow: false,
      crouch: false,
      pressed,
    };
    if (this._mode === 'ui') return frame;

    frame.look.x = lookX;
    frame.look.y = lookY;

    const kb = keyboardMove(
      this.isDown('left'),
      this.isDown('right'),
      this.isDown('back'),
      this.isDown('forward'),
    );
    if (this.joyId !== null && (this.joyX !== 0 || this.joyY !== 0)) {
      frame.move.x = this.joyX;
      frame.move.y = this.joyY;
    } else {
      frame.move.x = kb.x;
      frame.move.y = kb.y;
    }
    frame.sprint = this.isDown('sprint') || this.joySprint;
    frame.slow = this.isDown('slow');
    frame.crouch = this._mode === 'walk' && (this.isDown('crouch') || this.touchCrouch);

    if (this._mode === 'photo') {
      let lift = (this.isDown('up') ? 1 : 0) - (this.isDown('down') ? 1 : 0);
      for (const dir of this.hudHeld.values()) lift += dir === 'up' ? 1 : -1;
      frame.lift = Math.max(-1, Math.min(1, lift));
    }
    return frame;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const r of this.removers) r();
    this.removers = [];
    this.releaseLock();
    this.tapCbs.clear();
    this.hud.remove();
    this.styleEl.remove();
  }

  // ------------------------------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------------------------------

  private div(cls: string): HTMLDivElement {
    const d = document.createElement('div');
    d.className = cls;
    return d;
  }

  private on<K extends keyof HTMLElementEventMap>(
    target: HTMLElement,
    type: K,
    fn: (e: HTMLElementEventMap[K]) => void,
    opts?: AddEventListenerOptions,
  ): void;
  private on(target: EventTarget, type: string, fn: (e: never) => void, opts?: AddEventListenerOptions): void;
  private on(target: EventTarget, type: string, fn: (e: never) => void, opts?: AddEventListenerOptions): void {
    target.addEventListener(type, fn as EventListener, opts);
    this.removers.push(() => target.removeEventListener(type, fn as EventListener, opts));
  }

  private rebuildCodeMap(): void {
    this.codeMap.clear();
    for (const action of Object.keys(this.bindings) as Action[]) {
      for (const code of this.bindings[action] ?? []) {
        const list = this.codeMap.get(code);
        if (list) list.push(action);
        else this.codeMap.set(code, [action]);
      }
    }
  }

  private isDown(action: Action): boolean {
    const codes = this.bindings[action];
    if (!codes) return false;
    for (const c of codes) if (this.held.has(c)) return true;
    return false;
  }

  private makeButton(label: string, aria: string, extraClass = ''): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `tc-btn ${extraClass}`.trim();
    b.textContent = label;
    b.setAttribute('aria-label', aria);
    b.tabIndex = -1;
    this.on(b, 'mousedown', (e) => e.preventDefault()); // keep focus off HUD buttons
    this.on(b, 'contextmenu', (e) => e.preventDefault());
    return b;
  }

  private pressButton(label: string, aria: string, action: Action, extraClass = ''): HTMLButtonElement {
    const b = this.makeButton(label, aria, extraClass);
    this.on(b, 'pointerdown', (e) => {
      e.preventDefault();
      if (this._mode === 'ui') return;
      this.pressed.add(action);
    });
    return b;
  }

  private holdButton(label: string, aria: string, dir: 'up' | 'down'): HTMLButtonElement {
    const b = this.makeButton(label, aria, 'tc-photo-only');
    this.on(b, 'pointerdown', (e) => {
      e.preventDefault();
      this.hudHeld.set(e.pointerId, dir);
      b.classList.add('tc-active');
      try {
        b.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    });
    const release = (e: PointerEvent): void => {
      this.hudHeld.delete(e.pointerId);
      if (![...this.hudHeld.values()].includes(dir)) b.classList.remove('tc-active');
    };
    this.on(b, 'pointerup', release);
    this.on(b, 'pointercancel', release);
    this.on(b, 'lostpointercapture', release);
    return b;
  }

  private shouldShowHud(): boolean {
    if (this._mode === 'ui') return false;
    if (document.body.classList.contains('ui-hidden')) return false;
    const t = this.settings.get().touchControls;
    if (t === 'off') return false;
    if (t === 'on') return true;
    return this.touchSeen || isTouchDevice();
  }

  private updateHud(): void {
    const show = this.shouldShowHud();
    this.hud.classList.toggle('tc-hidden', !show);
    this.hud.classList.toggle('tc-mode-walk', this._mode === 'walk');
    this.hud.classList.toggle('tc-mode-photo', this._mode === 'photo');
    if (!show && this.hudVisible) this.resetTouch();
    this.hudVisible = show;
  }

  private resetTouch(): void {
    this.joyId = null;
    this.joyX = 0;
    this.joyY = 0;
    this.joySprint = false;
    this.lookId = null;
    this.lookTrack = null;
    this.hudHeld.clear();
    this.stickBase.style.display = 'none';
    this.stickKnob.style.display = 'none';
    for (const b of this.hud.querySelectorAll('.tc-active')) {
      if (b !== this.crouchBtn) b.classList.remove('tc-active');
    }
  }

  private releaseLock(): void {
    if (this.pointerLocked) {
      this.expectUnlock = true;
      try {
        document.exitPointerLock();
      } catch {
        this.expectUnlock = false;
      }
    }
  }

  private emitTap(clientX: number, clientY: number): void {
    if (this._mode === 'ui' || this.tapCbs.size === 0) return;
    const n = this.pointerLocked ? { x: 0, y: 0 } : toNdc(clientX, clientY, this.element.getBoundingClientRect());
    for (const cb of [...this.tapCbs]) cb(n.x, n.y);
  }

  private addLook(px: number, py: number, radPerPx: number): void {
    const s = this.settings.get();
    const l = pixelsToLook(px, py, radPerPx, s.lookSensitivity, s.invertY);
    this.lookX += l.x;
    this.lookY += l.y;
  }

  private static isEditableTarget(t: EventTarget | null): boolean {
    if (!(t instanceof HTMLElement)) return false;
    const tag = t.tagName;
    return tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'BUTTON' || t.isContentEditable;
  }

  // ------------------------------------------------------------------------------------------
  // Global listeners: keyboard, focus, settings, lock, touch detection
  // ------------------------------------------------------------------------------------------

  private bindGlobal(): void {
    this.on(window, 'keydown', (e: KeyboardEvent) => {
      if (InputManager.isEditableTarget(e.target)) return;
      const actions = this.codeMap.get(e.code);
      if (!actions) return;
      if (this._mode !== 'ui') e.preventDefault();
      if (e.repeat) return;
      if (this._mode === 'ui') {
        for (const a of actions) if (ALWAYS_ACTIONS.has(a)) this.pressed.add(a);
        return;
      }
      this.held.add(e.code);
      for (const a of actions) this.pressed.add(a);
    });
    this.on(window, 'keyup', (e: KeyboardEvent) => {
      this.held.delete(e.code);
    });
    this.on(window, 'blur', () => {
      this.held.clear();
      this.resetTouch();
    });
    this.on(document, 'visibilitychange', () => {
      this.held.clear();
      this.resetTouch();
    });

    const offSettings = this.events.on('settings:changed', (s) => {
      this.bindings = s.bindings;
      this.rebuildCodeMap();
      this.updateHud();
    });
    this.removers.push(offSettings);

    // Any touch pointer anywhere marks the device as touch-driven.
    this.on(
      window,
      'pointerdown',
      (e: PointerEvent) => {
        if (e.pointerType === 'touch' && !this.touchSeen) {
          this.touchSeen = true;
          this.updateHud();
        }
      },
      { capture: true, passive: true },
    );

    this.on(document, 'pointerlockchange', () => {
      if (this.pointerLocked) {
        this.lockFailed = false;
        return;
      }
      const wasExpected = this.expectUnlock;
      this.expectUnlock = false;
      // Browsers swallow Escape while locked: surface it as a menu press.
      if (!wasExpected && this._mode !== 'ui') this.pressed.add('menu');
    });
    this.on(document, 'pointerlockerror', () => {
      this.lockFailed = true;
    });
    this.on(document, 'mousemove', (e: MouseEvent) => {
      if (!this.pointerLocked || this._mode === 'ui') return;
      this.addLook(clampSpike(e.movementX), clampSpike(e.movementY), MOUSE_RAD_PER_PX);
    });

    if (typeof MutationObserver !== 'undefined') {
      const mo = new MutationObserver(() => this.updateHud());
      mo.observe(document.body, { attributes: true, attributeFilter: ['class'] });
      this.removers.push(() => mo.disconnect());
    }
  }

  // ------------------------------------------------------------------------------------------
  // Canvas: mouse/pen drag-look, wheel-look, pointer lock request, taps
  // ------------------------------------------------------------------------------------------

  private bindCanvas(): void {
    const el = this.element;
    el.style.touchAction = 'none';

    this.on(el, 'pointerdown', (e: PointerEvent) => {
      if (this._mode === 'ui') return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      this.canvasPtr.set(e.pointerId, { x: e.clientX, y: e.clientY, t: performance.now(), dist: 0 });
      const wantsLock = e.pointerType === 'mouse' && this.lockSupported && !this.lockFailed;
      if (wantsLock) {
        if (!this.pointerLocked) {
          try {
            const r = el.requestPointerLock() as unknown;
            if (r instanceof Promise) r.catch(() => (this.lockFailed = true));
          } catch {
            this.lockFailed = true;
          }
        }
        return;
      }
      if (this.dragId === null) {
        this.dragId = e.pointerId;
        this.dragLast = { x: e.clientX, y: e.clientY };
        try {
          el.setPointerCapture(e.pointerId);
        } catch {
          /* ignore */
        }
      }
    });
    this.on(el, 'pointermove', (e: PointerEvent) => {
      const track = this.canvasPtr.get(e.pointerId);
      if (track) track.dist = Math.max(track.dist, Math.hypot(e.clientX - track.x, e.clientY - track.y));
      if (this.dragId !== e.pointerId || this._mode === 'ui' || this.pointerLocked) return;
      const dx = clampSpike(e.clientX - this.dragLast.x);
      const dy = clampSpike(e.clientY - this.dragLast.y);
      this.dragLast = { x: e.clientX, y: e.clientY };
      this.addLook(dx, dy, e.pointerType === 'touch' ? TOUCH_RAD_PER_PX : MOUSE_RAD_PER_PX);
    });
    const end = (e: PointerEvent, cancelled: boolean): void => {
      const track = this.canvasPtr.get(e.pointerId);
      this.canvasPtr.delete(e.pointerId);
      if (this.dragId === e.pointerId) this.dragId = null;
      if (track && !cancelled && isTap(track.dist, performance.now() - track.t)) this.emitTap(e.clientX, e.clientY);
    };
    this.on(el, 'pointerup', (e: PointerEvent) => end(e, false));
    this.on(el, 'pointercancel', (e: PointerEvent) => end(e, true));

    this.on(
      el,
      'wheel',
      (e: WheelEvent) => {
        if (this._mode === 'ui') return;
        e.preventDefault();
        if (this.pointerLocked) return;
        const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
        this.addLook(clampSpike(e.deltaX * k, 2000), clampSpike(e.deltaY * k, 2000), WHEEL_RAD_PER_UNIT);
      },
      { passive: false },
    );
    this.on(el, 'contextmenu', (e: Event) => e.preventDefault());
  }

  // ------------------------------------------------------------------------------------------
  // Touch HUD zones: floating joystick (left) and look area (right)
  // ------------------------------------------------------------------------------------------

  private bindHudZones(): void {
    const zl = this.zoneLeft;
    const zr = this.zoneRight;

    this.on(zl, 'pointerdown', (e: PointerEvent) => {
      if (this.joyId !== null) return;
      e.preventDefault();
      this.joyId = e.pointerId;
      this.joyOx = e.clientX;
      this.joyOy = e.clientY;
      this.joyX = 0;
      this.joyY = 0;
      this.joySprint = false;
      try {
        zl.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      for (const el of [this.stickBase, this.stickKnob]) {
        el.style.display = 'block';
        el.style.left = `${e.clientX}px`;
        el.style.top = `${e.clientY}px`;
      }
    });
    this.on(zl, 'pointermove', (e: PointerEvent) => {
      if (e.pointerId !== this.joyId) return;
      const dx = e.clientX - this.joyOx;
      const dy = e.clientY - this.joyOy;
      const j = joystickVector(dx, dy, JOY_RADIUS);
      this.joyX = j.x;
      this.joyY = j.y;
      this.joySprint = j.sprint;
      const k = clampToRadius(dx, dy, JOY_RADIUS);
      this.stickKnob.style.left = `${this.joyOx + k.x}px`;
      this.stickKnob.style.top = `${this.joyOy + k.y}px`;
    });
    const joyEnd = (e: PointerEvent): void => {
      if (e.pointerId !== this.joyId) return;
      this.joyId = null;
      this.joyX = 0;
      this.joyY = 0;
      this.joySprint = false;
      this.stickBase.style.display = 'none';
      this.stickKnob.style.display = 'none';
    };
    this.on(zl, 'pointerup', joyEnd);
    this.on(zl, 'pointercancel', joyEnd);
    this.on(zl, 'lostpointercapture', joyEnd);

    this.on(zr, 'pointerdown', (e: PointerEvent) => {
      if (this.lookId !== null) return;
      e.preventDefault();
      this.lookId = e.pointerId;
      this.lookLast = { x: e.clientX, y: e.clientY };
      this.lookTrack = { x: e.clientX, y: e.clientY, t: performance.now(), dist: 0 };
      try {
        zr.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    });
    this.on(zr, 'pointermove', (e: PointerEvent) => {
      if (e.pointerId !== this.lookId) return;
      const dx = e.clientX - this.lookLast.x;
      const dy = e.clientY - this.lookLast.y;
      this.lookLast = { x: e.clientX, y: e.clientY };
      const t = this.lookTrack;
      if (t) t.dist = Math.max(t.dist, Math.hypot(e.clientX - t.x, e.clientY - t.y));
      if (this._mode !== 'ui') this.addLook(dx, dy, TOUCH_RAD_PER_PX);
    });
    const lookEnd = (e: PointerEvent, cancelled: boolean): void => {
      if (e.pointerId !== this.lookId) return;
      const t = this.lookTrack;
      this.lookId = null;
      this.lookTrack = null;
      if (t && !cancelled && isTap(t.dist, performance.now() - t.t)) this.emitTap(e.clientX, e.clientY);
    };
    this.on(zr, 'pointerup', (e: PointerEvent) => lookEnd(e, false));
    this.on(zr, 'pointercancel', (e: PointerEvent) => lookEnd(e, true));
    this.on(zr, 'lostpointercapture', (e: PointerEvent) => lookEnd(e, true));
  }
}
