/*
Copyright (C) 1997-2001 Id Software, Inc.
Ported from ref_gl/qgl.h (GNU GPL v2 or later) plus linux/qgl_linux.c's
dlsym-based loading of the same table (also GPL v2 or later; win32/qgl_win.c
and irix/qgl_irix.c are the per-OS alternates for the same table and are not
separately ported, per PORTING.md's platform mapping -- one bun implementation
covers all three).

qgl.h declares one function-pointer variable per OpenGL 1.1 entry point plus
a handful of vendor extensions (~340 total: every overload of qglColor*,
qglVertex*, qglRasterPos*, etc, most never called by this game's renderer).
QGL below is narrowed to exactly the qgl* names the ref_gl/gl_*.c tree calls
(grepped across gl_draw.c, gl_image.c, gl_light.c, gl_mesh.c, gl_model.c,
gl_rmain.c, gl_rmisc.c, gl_rsurf.c, gl_warp.c: 59 entry points). A future unit
porting one of those .c files for real that turns out to need an additional
qgl* entry point extends this interface and both implementations below --
same shape as PORTING.md's "report the mismatch" idiom for header
placement, applied to an interface surface instead of a file.

`QGL_Init(dllname)` / `QGL_Shutdown()` (the two actual function prototypes
qgl.h declares, as opposed to the function-pointer table) become
`loadQGLFromSystem()` below; QGL_Shutdown below closes the dlopen handle (qgl_linux.c's dlclose).
nothing in this scaffold's reachable call graph invokes it yet (reported
gap -- add one alongside GLimp_Shutdown when gl_rmain.ts's real R_Shutdown
lands).
*/

import { dlopen, FFIType, linkSymbols, type Library, type Pointer } from "bun:ffi";

// GL entry points that take `const GLfloat *` / `const GLuint *` / `const
// GLvoid *` etc pass a small fixed-size C array in every call site this
// port will ever make (a color, a 4x4 matrix, a texture's pixel buffer) --
// never an opaque heap pointer manufactured elsewhere. bun:ffi accepts
// either a raw `Pointer` or the backing TypedArray directly for an
// `FFIType.ptr` parameter, so QGL's pointer-taking members accept either,
// matching this unit's brief ("pointers as `Pointer | TypedArray` where the
// C passes arrays").
export type GLArray = Float32Array | Uint8Array | Uint32Array | Int32Array | Uint16Array;
export type GLPointer = Pointer | GLArray | null;

// The typed function-pointer table qgl_linux.c/qgl_win.c populate at
// runtime. Every member name and parameter list matches qgl.h's extern
// declaration for that entry point exactly (GLenum/GLbitfield/GLint/
// GLsizei/GLuint -> number, GLboolean -> boolean, GLfloat/GLclampf/
// GLdouble/GLclampd -> number, pointers -> GLPointer).
export interface QGL {
  qglAlphaFunc(func: number, ref: number): void;
  qglArrayElement(i: number): void;
  qglBegin(mode: number): void;
  qglBindTexture(target: number, texture: number): void;
  qglBlendFunc(sfactor: number, dfactor: number): void;
  qglClear(mask: number): void;
  qglClearColor(red: number, green: number, blue: number, alpha: number): void;
  qglColor3f(red: number, green: number, blue: number): void;
  qglColor3fv(v: GLPointer): void;
  qglColor4f(red: number, green: number, blue: number, alpha: number): void;
  qglColor4fv(v: GLPointer): void;
  qglColor4ubv(v: GLPointer): void;
  qglColorPointer(size: number, type: number, stride: number, pointer: GLPointer): void;
  // C function pointer: NULL when the driver lacks the extension --
  // every caller must check, exactly like the C
  qglColorTableEXT: ((target: number, internalformat: number, width: number, format: number, type: number, table: GLPointer) => void) | null;
  qglCullFace(mode: number): void;
  qglDeleteTextures(n: number, textures: GLPointer): void;
  qglDepthFunc(func: number): void;
  qglDepthMask(flag: boolean): void;
  qglDepthRange(zNear: number, zFar: number): void;
  qglDisable(cap: number): void;
  qglDrawBuffer(mode: number): void;
  qglEnable(cap: number): void;
  qglEnableClientState(array: number): void;
  qglEnd(): void;
  qglFinish(): void;
  qglFrustum(left: number, right: number, bottom: number, top: number, zNear: number, zFar: number): void;
  qglGetError(): number;
  qglGetFloatv(pname: number, params: GLPointer): void;
  qglGetString(name: number): Pointer | null;
  qglLoadIdentity(): void;
  qglLoadMatrixf(m: GLPointer): void;
  // C function pointer: NULL when the driver lacks the extension --
  // every caller must check, exactly like the C
  qglLockArraysEXT: ((first: number, count: number) => void) | null;
  qglMatrixMode(mode: number): void;
  // C function pointer: NULL when the driver lacks the extension --
  // every caller must check, exactly like the C
  qglMTexCoord2fSGIS: ((target: number, s: number, t: number) => void) | null;
  qglOrtho(left: number, right: number, bottom: number, top: number, zNear: number, zFar: number): void;
  // C function pointer: NULL when the driver lacks the extension --
  // every caller must check, exactly like the C
  qglPointParameterfEXT: ((param: number, value: number) => void) | null;
  // C function pointer: NULL when the driver lacks the extension --
  // every caller must check, exactly like the C
  qglPointParameterfvEXT: ((param: number, value: GLPointer) => void) | null;
  qglPointSize(size: number): void;
  qglPolygonMode(face: number, mode: number): void;
  qglPopMatrix(): void;
  qglPushMatrix(): void;
  qglReadPixels(x: number, y: number, width: number, height: number, format: number, type: number, pixels: GLPointer): void;
  qglRotatef(angle: number, x: number, y: number, z: number): void;
  qglScalef(x: number, y: number, z: number): void;
  qglScissor(x: number, y: number, width: number, height: number): void;
  // C function pointer: NULL when the driver lacks the extension --
  // every caller must check, exactly like the C
  qglSelectTextureSGIS: ((target: number) => void) | null;
  qglShadeModel(mode: number): void;
  qglTexCoord2f(s: number, t: number): void;
  qglTexEnvf(target: number, pname: number, param: number): void;
  qglTexImage2D(target: number, level: number, internalformat: number, width: number, height: number, border: number, format: number, type: number, pixels: GLPointer): void;
  qglTexParameterf(target: number, pname: number, param: number): void;
  qglTexSubImage2D(target: number, level: number, xoffset: number, yoffset: number, width: number, height: number, format: number, type: number, pixels: GLPointer): void;
  qglTranslatef(x: number, y: number, z: number): void;
  // C function pointer: NULL when the driver lacks the extension --
  // every caller must check, exactly like the C
  qglUnlockArraysEXT: (() => void) | null;
  qglVertex2f(x: number, y: number): void;
  qglVertex3f(x: number, y: number, z: number): void;
  qglVertex3fv(v: GLPointer): void;
  qglVertexPointer(size: number, type: number, stride: number, pointer: GLPointer): void;
  qglViewport(x: number, y: number, width: number, height: number): void;
}

export interface QGLCall {
  readonly name: string;
  readonly args: readonly unknown[];
}

// The test seam this unit's brief asks for: a QGL implementation that does
// no real GL work and instead records every call, in order. Once a real
// gl_*.ts unit lands, its tests assert against `.calls` the same way a
// mocked import boundary would in a non-FFI codebase -- "GL correctness" for
// this renderer becomes "the recorded qgl* call sequence matches the
// sequence R_RenderView/R_DrawWorld/etc make in the original C".
export class QGLRecording implements QGL {
  readonly calls: QGLCall[] = [];

  clear(): void {
    this.calls.length = 0;
  }

  private record(name: string, args: readonly unknown[]): void {
    this.calls.push({ name, args });
  }

  qglAlphaFunc(func: number, ref: number): void {
    this.record("qglAlphaFunc", [func, ref]);
  }
  qglArrayElement(i: number): void {
    this.record("qglArrayElement", [i]);
  }
  qglBegin(mode: number): void {
    this.record("qglBegin", [mode]);
  }
  qglBindTexture(target: number, texture: number): void {
    this.record("qglBindTexture", [target, texture]);
  }
  qglBlendFunc(sfactor: number, dfactor: number): void {
    this.record("qglBlendFunc", [sfactor, dfactor]);
  }
  qglClear(mask: number): void {
    this.record("qglClear", [mask]);
  }
  qglClearColor(red: number, green: number, blue: number, alpha: number): void {
    this.record("qglClearColor", [red, green, blue, alpha]);
  }
  qglColor3f(red: number, green: number, blue: number): void {
    this.record("qglColor3f", [red, green, blue]);
  }
  qglColor3fv(v: GLPointer): void {
    this.record("qglColor3fv", [v]);
  }
  qglColor4f(red: number, green: number, blue: number, alpha: number): void {
    this.record("qglColor4f", [red, green, blue, alpha]);
  }
  qglColor4fv(v: GLPointer): void {
    this.record("qglColor4fv", [v]);
  }
  qglColor4ubv(v: GLPointer): void {
    this.record("qglColor4ubv", [v]);
  }
  qglColorPointer(size: number, type: number, stride: number, pointer: GLPointer): void {
    this.record("qglColorPointer", [size, type, stride, pointer]);
  }
  qglColorTableEXT = (target: number, internalformat: number, width: number, format: number, type: number, table: GLPointer): void => {
    this.record("qglColorTableEXT", [target, internalformat, width, format, type, table]);
  };
  qglCullFace(mode: number): void {
    this.record("qglCullFace", [mode]);
  }
  qglDeleteTextures(n: number, textures: GLPointer): void {
    this.record("qglDeleteTextures", [n, textures]);
  }
  qglDepthFunc(func: number): void {
    this.record("qglDepthFunc", [func]);
  }
  qglDepthMask(flag: boolean): void {
    this.record("qglDepthMask", [flag]);
  }
  qglDepthRange(zNear: number, zFar: number): void {
    this.record("qglDepthRange", [zNear, zFar]);
  }
  qglDisable(cap: number): void {
    this.record("qglDisable", [cap]);
  }
  qglDrawBuffer(mode: number): void {
    this.record("qglDrawBuffer", [mode]);
  }
  qglEnable(cap: number): void {
    this.record("qglEnable", [cap]);
  }
  qglEnableClientState(array: number): void {
    this.record("qglEnableClientState", [array]);
  }
  qglEnd(): void {
    this.record("qglEnd", []);
  }
  qglFinish(): void {
    this.record("qglFinish", []);
  }
  qglFrustum(left: number, right: number, bottom: number, top: number, zNear: number, zFar: number): void {
    this.record("qglFrustum", [left, right, bottom, top, zNear, zFar]);
  }
  qglGetError(): number {
    this.record("qglGetError", []);
    return 0; // GL_NO_ERROR
  }
  qglGetFloatv(pname: number, params: GLPointer): void {
    this.record("qglGetFloatv", [pname, params]);
  }
  qglGetString(name: number): Pointer | null {
    this.record("qglGetString", [name]);
    return null;
  }
  qglLoadIdentity(): void {
    this.record("qglLoadIdentity", []);
  }
  qglLoadMatrixf(m: GLPointer): void {
    this.record("qglLoadMatrixf", [m]);
  }
  qglLockArraysEXT = (first: number, count: number): void => {
    this.record("qglLockArraysEXT", [first, count]);
  };
  qglMatrixMode(mode: number): void {
    this.record("qglMatrixMode", [mode]);
  }
  qglMTexCoord2fSGIS = (target: number, s: number, t: number): void => {
    this.record("qglMTexCoord2fSGIS", [target, s, t]);
  };
  qglOrtho(left: number, right: number, bottom: number, top: number, zNear: number, zFar: number): void {
    this.record("qglOrtho", [left, right, bottom, top, zNear, zFar]);
  }
  qglPointParameterfEXT = (param: number, value: number): void => {
    this.record("qglPointParameterfEXT", [param, value]);
  };
  qglPointParameterfvEXT = (param: number, value: GLPointer): void => {
    this.record("qglPointParameterfvEXT", [param, value]);
  };
  qglPointSize(size: number): void {
    this.record("qglPointSize", [size]);
  }
  qglPolygonMode(face: number, mode: number): void {
    this.record("qglPolygonMode", [face, mode]);
  }
  qglPopMatrix(): void {
    this.record("qglPopMatrix", []);
  }
  qglPushMatrix(): void {
    this.record("qglPushMatrix", []);
  }
  qglReadPixels(x: number, y: number, width: number, height: number, format: number, type: number, pixels: GLPointer): void {
    this.record("qglReadPixels", [x, y, width, height, format, type, pixels]);
  }
  qglRotatef(angle: number, x: number, y: number, z: number): void {
    this.record("qglRotatef", [angle, x, y, z]);
  }
  qglScalef(x: number, y: number, z: number): void {
    this.record("qglScalef", [x, y, z]);
  }
  qglScissor(x: number, y: number, width: number, height: number): void {
    this.record("qglScissor", [x, y, width, height]);
  }
  // bound arrow properties (not methods): engine call sites capture these
  // like C function pointers, detaching them from the instance
  qglSelectTextureSGIS = (target: number): void => {
    this.record("qglSelectTextureSGIS", [target]);
  };
  qglShadeModel(mode: number): void {
    this.record("qglShadeModel", [mode]);
  }
  qglTexCoord2f(s: number, t: number): void {
    this.record("qglTexCoord2f", [s, t]);
  }
  qglTexEnvf(target: number, pname: number, param: number): void {
    this.record("qglTexEnvf", [target, pname, param]);
  }
  qglTexImage2D(target: number, level: number, internalformat: number, width: number, height: number, border: number, format: number, type: number, pixels: GLPointer): void {
    this.record("qglTexImage2D", [target, level, internalformat, width, height, border, format, type, pixels]);
  }
  qglTexParameterf(target: number, pname: number, param: number): void {
    this.record("qglTexParameterf", [target, pname, param]);
  }
  qglTexSubImage2D(target: number, level: number, xoffset: number, yoffset: number, width: number, height: number, format: number, type: number, pixels: GLPointer): void {
    this.record("qglTexSubImage2D", [target, level, xoffset, yoffset, width, height, format, type, pixels]);
  }
  qglTranslatef(x: number, y: number, z: number): void {
    this.record("qglTranslatef", [x, y, z]);
  }
  qglUnlockArraysEXT = (): void => {
    this.record("qglUnlockArraysEXT", []);
  };
  qglVertex2f(x: number, y: number): void {
    this.record("qglVertex2f", [x, y]);
  }
  qglVertex3f(x: number, y: number, z: number): void {
    this.record("qglVertex3f", [x, y, z]);
  }
  qglVertex3fv(v: GLPointer): void {
    this.record("qglVertex3fv", [v]);
  }
  qglVertexPointer(size: number, type: number, stride: number, pointer: GLPointer): void {
    this.record("qglVertexPointer", [size, type, stride, pointer]);
  }
  qglViewport(x: number, y: number, width: number, height: number): void {
    this.record("qglViewport", [x, y, width, height]);
  }
}

// linux/qgl_linux.c's QGL_Init() dlopen()s `gl_driver`'s value (cvar,
// default "libGL.so.1") and dlsym()s each table entry under its real GL name
// (the "q" prefix is stripped: qglAlphaFunc -> "glAlphaFunc"); qgl_win.c does
// the same against "opengl32.dll"; irix/qgl_irix.c against "libGL.so". This
// is that loader's portable bun:ffi equivalent, minus the per-OS branch (one
// path per PORTING.md's platform-mapping rule) -- the macOS OpenGL framework
// path is included too since Bun runs there, though the original engine
// never shipped a mac ref_gl.
function resolveSystemGLLibraryPath(): string {
  switch (process.platform) {
    case "win32":
      return "opengl32.dll";
    case "darwin":
      return "/System/Library/Frameworks/OpenGL.framework/OpenGL";
    default:
      return "libGL.so.1";
  }
}

const ptr = FFIType.ptr;
const f32 = FFIType.f32;
const f64 = FFIType.f64;
const i32 = FFIType.i32;
const u32 = FFIType.u32;
const bool = FFIType.bool;
const voidType = FFIType.void;

// FFIType symbol table for dlopen(), one entry per QGL core-1.1 member,
// keyed by the real (unprefixed) GL symbol name a dlsym() lookup expects.
// The seven *_EXT/*_SGIS vendor-extension members are deliberately not in
// this table -- see `glExtensionSymbols` below: bun:ffi's dlopen() rejects
// the whole call if even one requested symbol is missing (verified
// empirically), and unlike the ~59 core entries here, the extension
// entries are not guaranteed to be dlsym-able off the base library at all
// (confirmed on this host's Mesa libGL.so.1: glMTexCoord2fSGIS/
// glSelectTextureSGIS are absent from that dlsym namespace even though the
// rest resolve fine) -- the GLX/WGL spec only promises those through
// glXGetProcAddress/wglGetProcAddress once a context is current, which is
// what `getProcAddress` (SDL_GL_GetProcAddress, wired from glimp.ts through
// vid.ts) stands in for here.
const glSymbols = {
  glAlphaFunc: { args: [u32, f32], returns: voidType },
  glArrayElement: { args: [i32], returns: voidType },
  glBegin: { args: [u32], returns: voidType },
  glBindTexture: { args: [u32, u32], returns: voidType },
  glBlendFunc: { args: [u32, u32], returns: voidType },
  glClear: { args: [u32], returns: voidType },
  glClearColor: { args: [f32, f32, f32, f32], returns: voidType },
  glColor3f: { args: [f32, f32, f32], returns: voidType },
  glColor3fv: { args: [ptr], returns: voidType },
  glColor4f: { args: [f32, f32, f32, f32], returns: voidType },
  glColor4fv: { args: [ptr], returns: voidType },
  glColor4ubv: { args: [ptr], returns: voidType },
  glColorPointer: { args: [i32, u32, i32, ptr], returns: voidType },
  glCullFace: { args: [u32], returns: voidType },
  glDeleteTextures: { args: [i32, ptr], returns: voidType },
  glDepthFunc: { args: [u32], returns: voidType },
  glDepthMask: { args: [bool], returns: voidType },
  glDepthRange: { args: [f64, f64], returns: voidType },
  glDisable: { args: [u32], returns: voidType },
  glDrawBuffer: { args: [u32], returns: voidType },
  glEnable: { args: [u32], returns: voidType },
  glEnableClientState: { args: [u32], returns: voidType },
  glEnd: { args: [], returns: voidType },
  glFinish: { args: [], returns: voidType },
  glFrustum: { args: [f64, f64, f64, f64, f64, f64], returns: voidType },
  glGetError: { args: [], returns: u32 },
  glGetFloatv: { args: [u32, ptr], returns: voidType },
  glGetString: { args: [u32], returns: ptr },
  glLoadIdentity: { args: [], returns: voidType },
  glLoadMatrixf: { args: [ptr], returns: voidType },
  glMatrixMode: { args: [u32], returns: voidType },
  glOrtho: { args: [f64, f64, f64, f64, f64, f64], returns: voidType },
  glPointSize: { args: [f32], returns: voidType },
  glPolygonMode: { args: [u32, u32], returns: voidType },
  glPopMatrix: { args: [], returns: voidType },
  glPushMatrix: { args: [], returns: voidType },
  glReadPixels: { args: [i32, i32, i32, i32, u32, u32, ptr], returns: voidType },
  glRotatef: { args: [f32, f32, f32, f32], returns: voidType },
  glScalef: { args: [f32, f32, f32], returns: voidType },
  glScissor: { args: [i32, i32, i32, i32], returns: voidType },
  glShadeModel: { args: [u32], returns: voidType },
  glTexCoord2f: { args: [f32, f32], returns: voidType },
  glTexEnvf: { args: [u32, u32, f32], returns: voidType },
  glTexImage2D: { args: [u32, i32, i32, i32, i32, i32, u32, u32, ptr], returns: voidType },
  glTexParameterf: { args: [u32, u32, f32], returns: voidType },
  glTexSubImage2D: { args: [u32, i32, i32, i32, i32, i32, u32, u32, ptr], returns: voidType },
  glTranslatef: { args: [f32, f32, f32], returns: voidType },
  glVertex2f: { args: [f32, f32], returns: voidType },
  glVertex3f: { args: [f32, f32, f32], returns: voidType },
  glVertex3fv: { args: [ptr], returns: voidType },
  glVertexPointer: { args: [i32, u32, i32, ptr], returns: voidType },
  glViewport: { args: [i32, i32, i32, i32], returns: voidType },
} as const;

// A function that resolves a GL symbol name to its address without going
// through dlsym() against the base library -- SDL_GL_GetProcAddress's
// signature (see sdl.ts), passed in by vid.ts's VID_LoadRefresh. Optional:
// callers that never wire one up (this loader's own pre-existing zero-arg
// call site in gl_rmain.ts's R_Init) fall back to a per-symbol dlsym()
// attempt instead, see the seven `resolveGl*` functions below.
export type GLGetProcAddressFn = (name: string) => Pointer | bigint | null;

// Each of these resolves one *_EXT/*_SGIS symbol, either through
// `getProcAddress` (when supplied, via bun:ffi's linkSymbols against the
// resolved address) or a standalone per-symbol dlopen() against the same
// library (when not) -- deliberately never folded into the single
// `glSymbols` dlopen() above, since one missing symbol there would
// otherwise fail every core entry point too (verified empirically, see
// that table's header comment). Written out individually rather than
// through one generic helper: a generic keyed by a type parameter can't
// build the `{ [name]: sig }` object bun:ffi's dlopen()/linkSymbols expect
// without an `as` cast to widen the computed key, which PORTING.md's
// no-`as`-except-`as const` rule forbids.
function resolveGlLockArraysEXT(libraryPath: string, getProcAddress: GLGetProcAddressFn | undefined): ((first: number, count: number) => void) | null {
  if (getProcAddress) {
    const resolved = getProcAddress("glLockArraysEXT");
    if (resolved === null) return null;
    return linkSymbols({ glLockArraysEXT: { args: [i32, i32], returns: voidType, ptr: resolved } }).symbols.glLockArraysEXT;
  }
  try {
    return dlopen(libraryPath, { glLockArraysEXT: { args: [i32, i32], returns: voidType } }).symbols.glLockArraysEXT;
  } catch {
    return null;
  }
}

function resolveGlUnlockArraysEXT(libraryPath: string, getProcAddress: GLGetProcAddressFn | undefined): (() => void) | null {
  if (getProcAddress) {
    const resolved = getProcAddress("glUnlockArraysEXT");
    if (resolved === null) return null;
    return linkSymbols({ glUnlockArraysEXT: { args: [], returns: voidType, ptr: resolved } }).symbols.glUnlockArraysEXT;
  }
  try {
    return dlopen(libraryPath, { glUnlockArraysEXT: { args: [], returns: voidType } }).symbols.glUnlockArraysEXT;
  } catch {
    return null;
  }
}

function resolveGlPointParameterfEXT(libraryPath: string, getProcAddress: GLGetProcAddressFn | undefined): ((param: number, value: number) => void) | null {
  if (getProcAddress) {
    const resolved = getProcAddress("glPointParameterfEXT");
    if (resolved === null) return null;
    return linkSymbols({ glPointParameterfEXT: { args: [u32, f32], returns: voidType, ptr: resolved } }).symbols.glPointParameterfEXT;
  }
  try {
    return dlopen(libraryPath, { glPointParameterfEXT: { args: [u32, f32], returns: voidType } }).symbols.glPointParameterfEXT;
  } catch {
    return null;
  }
}

function resolveGlPointParameterfvEXT(libraryPath: string, getProcAddress: GLGetProcAddressFn | undefined): ((param: number, value: GLPointer) => void) | null {
  if (getProcAddress) {
    const resolved = getProcAddress("glPointParameterfvEXT");
    if (resolved === null) return null;
    return linkSymbols({ glPointParameterfvEXT: { args: [u32, ptr], returns: voidType, ptr: resolved } }).symbols.glPointParameterfvEXT;
  }
  try {
    return dlopen(libraryPath, { glPointParameterfvEXT: { args: [u32, ptr], returns: voidType } }).symbols.glPointParameterfvEXT;
  } catch {
    return null;
  }
}

function resolveGlColorTableEXT(
  libraryPath: string,
  getProcAddress: GLGetProcAddressFn | undefined,
): ((target: number, internalformat: number, width: number, format: number, type: number, table: GLPointer) => void) | null {
  if (getProcAddress) {
    const resolved = getProcAddress("glColorTableEXT");
    if (resolved === null) return null;
    return linkSymbols({ glColorTableEXT: { args: [i32, i32, i32, i32, i32, ptr], returns: voidType, ptr: resolved } }).symbols.glColorTableEXT;
  }
  try {
    return dlopen(libraryPath, { glColorTableEXT: { args: [i32, i32, i32, i32, i32, ptr], returns: voidType } }).symbols.glColorTableEXT;
  } catch {
    return null;
  }
}

function resolveGlMTexCoord2fSGIS(libraryPath: string, getProcAddress: GLGetProcAddressFn | undefined): ((target: number, s: number, t: number) => void) | null {
  if (getProcAddress) {
    const resolved = getProcAddress("glMTexCoord2fSGIS");
    if (resolved === null) return null;
    return linkSymbols({ glMTexCoord2fSGIS: { args: [u32, f32, f32], returns: voidType, ptr: resolved } }).symbols.glMTexCoord2fSGIS;
  }
  try {
    return dlopen(libraryPath, { glMTexCoord2fSGIS: { args: [u32, f32, f32], returns: voidType } }).symbols.glMTexCoord2fSGIS;
  } catch {
    return null;
  }
}

function resolveGlSelectTextureSGIS(libraryPath: string, getProcAddress: GLGetProcAddressFn | undefined): ((target: number) => void) | null {
  if (getProcAddress) {
    const resolved = getProcAddress("glSelectTextureSGIS");
    if (resolved === null) return null;
    return linkSymbols({ glSelectTextureSGIS: { args: [u32], returns: voidType, ptr: resolved } }).symbols.glSelectTextureSGIS;
  }
  try {
    return dlopen(libraryPath, { glSelectTextureSGIS: { args: [u32], returns: voidType } }).symbols.glSelectTextureSGIS;
  } catch {
    return null;
  }
}

// Binds QGL against the real system OpenGL library via bun:ffi's dlopen().
//
// This resolves every core GL 1.1 symbol with a plain dlsym() against the
// base library handle, exactly like qgl_linux.c. `getProcAddress` (when
// passed -- src/platform/sdl.ts's SDLGL_GetProcAddress, wired up by
// src/platform/vid.ts's VID_LoadRefresh once a GL context is current) is
// used for the seven `*_EXT`/`*_SGIS` vendor-extension members instead,
// since the GLX/WGL spec does not guarantee those resolve via plain dlsym()
// (confirmed on this host: two of the seven do not). Called with no
// argument at all (this loader's original zero-arg shape, still used by
// gl_rmain.ts's R_Init before a platform GLimp is wired in some build
// configurations), each extension falls back to its own per-symbol dlsym()
// attempt; if that also fails the member becomes a no-op rather than a
// missing property, matching QGL's "every member always exists" interface
// contract (see this file's own header note on why QGL can't express "this
// driver doesn't have it").
let loadedGlLibrary: Library<typeof glSymbols> | null = null;

/*
** QGL_Shutdown
**
** Unloads the specified DLL then nulls out all the proc pointers. The
** pointer-nulling half has no TS equivalent (the QGL interface object is
** replaced wholesale by SetQGL); the library-unload half closes the
** dlopen handle exactly like qgl_linux.c's dlclose(glw_state.OpenGLLib).
*/
export function QGL_Shutdown(): void {
  if (loadedGlLibrary) {
    loadedGlLibrary.close();
    loadedGlLibrary = null;
  }
}

export function loadQGLFromSystem(getProcAddress?: GLGetProcAddressFn): QGL {
  const libraryPath = resolveSystemGLLibraryPath();

  let lib: Library<typeof glSymbols>;
  try {
    lib = dlopen(libraryPath, glSymbols);
  } catch (err) {
    throw new Error(`loadQGLFromSystem: failed to load ${libraryPath}: ${err instanceof Error ? err.message : String(err)}`);
  }
  loadedGlLibrary = lib;

  const s = lib.symbols;

  const glLockArraysEXT = resolveGlLockArraysEXT(libraryPath, getProcAddress);
  const glUnlockArraysEXT = resolveGlUnlockArraysEXT(libraryPath, getProcAddress);
  const glPointParameterfEXT = resolveGlPointParameterfEXT(libraryPath, getProcAddress);
  const glPointParameterfvEXT = resolveGlPointParameterfvEXT(libraryPath, getProcAddress);
  const glColorTableEXT = resolveGlColorTableEXT(libraryPath, getProcAddress);
  const glMTexCoord2fSGIS = resolveGlMTexCoord2fSGIS(libraryPath, getProcAddress);
  const glSelectTextureSGIS = resolveGlSelectTextureSGIS(libraryPath, getProcAddress);
  return {
    qglAlphaFunc: (func, ref) => s.glAlphaFunc(func, ref),
    qglArrayElement: (i) => s.glArrayElement(i),
    qglBegin: (mode) => s.glBegin(mode),
    qglBindTexture: (target, texture) => s.glBindTexture(target, texture),
    qglBlendFunc: (sfactor, dfactor) => s.glBlendFunc(sfactor, dfactor),
    qglClear: (mask) => s.glClear(mask),
    qglClearColor: (red, green, blue, alpha) => s.glClearColor(red, green, blue, alpha),
    qglColor3f: (red, green, blue) => s.glColor3f(red, green, blue),
    qglColor3fv: (v) => s.glColor3fv(v),
    qglColor4f: (red, green, blue, alpha) => s.glColor4f(red, green, blue, alpha),
    qglColor4fv: (v) => s.glColor4fv(v),
    qglColor4ubv: (v) => s.glColor4ubv(v),
    qglColorPointer: (size, type, stride, pointer) => s.glColorPointer(size, type, stride, pointer),
    qglColorTableEXT: glColorTableEXT ? (target, internalformat, width, format, type, table) => glColorTableEXT(target, internalformat, width, format, type, table) : null,
    qglCullFace: (mode) => s.glCullFace(mode),
    qglDeleteTextures: (n, textures) => s.glDeleteTextures(n, textures),
    qglDepthFunc: (func) => s.glDepthFunc(func),
    qglDepthMask: (flag) => s.glDepthMask(flag),
    qglDepthRange: (zNear, zFar) => s.glDepthRange(zNear, zFar),
    qglDisable: (cap) => s.glDisable(cap),
    qglDrawBuffer: (mode) => s.glDrawBuffer(mode),
    qglEnable: (cap) => s.glEnable(cap),
    qglEnableClientState: (array) => s.glEnableClientState(array),
    qglEnd: () => s.glEnd(),
    qglFinish: () => s.glFinish(),
    qglFrustum: (left, right, bottom, top, zNear, zFar) => s.glFrustum(left, right, bottom, top, zNear, zFar),
    qglGetError: () => s.glGetError(),
    qglGetFloatv: (pname, params) => s.glGetFloatv(pname, params),
    qglGetString: (name) => {
      // FFIType.ptr's return type is `Pointer | bigint | null`; glGetString
      // never actually returns a bigint (bun:ffi only produces one for a
      // pointer value too large for a safe JS number, which cannot happen
      // for a real C string pointer on any platform Bun targets) -- narrowed
      // with typeof rather than cast, per PORTING.md's "no `as` casts" rule.
      const result = s.glGetString(name);
      return typeof result === "bigint" ? null : result;
    },
    qglLoadIdentity: () => s.glLoadIdentity(),
    qglLoadMatrixf: (m) => s.glLoadMatrixf(m),
    qglLockArraysEXT: glLockArraysEXT ? (first, count) => glLockArraysEXT(first, count) : null,
    qglMatrixMode: (mode) => s.glMatrixMode(mode),
    qglMTexCoord2fSGIS: glMTexCoord2fSGIS ? (target, sVal, tVal) => glMTexCoord2fSGIS(target, sVal, tVal) : null,
    qglOrtho: (left, right, bottom, top, zNear, zFar) => s.glOrtho(left, right, bottom, top, zNear, zFar),
    qglPointParameterfEXT: glPointParameterfEXT ? (param, value) => glPointParameterfEXT(param, value) : null,
    qglPointParameterfvEXT: glPointParameterfvEXT ? (param, value) => glPointParameterfvEXT(param, value) : null,
    qglPointSize: (size) => s.glPointSize(size),
    qglPolygonMode: (face, mode) => s.glPolygonMode(face, mode),
    qglPopMatrix: () => s.glPopMatrix(),
    qglPushMatrix: () => s.glPushMatrix(),
    qglReadPixels: (x, y, width, height, format, type, pixels) => s.glReadPixels(x, y, width, height, format, type, pixels),
    qglRotatef: (angle, x, y, z) => s.glRotatef(angle, x, y, z),
    qglScalef: (x, y, z) => s.glScalef(x, y, z),
    qglScissor: (x, y, width, height) => s.glScissor(x, y, width, height),
    qglSelectTextureSGIS: glSelectTextureSGIS ? (target) => glSelectTextureSGIS(target) : null,
    qglShadeModel: (mode) => s.glShadeModel(mode),
    qglTexCoord2f: (sVal, tVal) => s.glTexCoord2f(sVal, tVal),
    qglTexEnvf: (target, pname, param) => s.glTexEnvf(target, pname, param),
    qglTexImage2D: (target, level, internalformat, width, height, border, format, type, pixels) =>
      s.glTexImage2D(target, level, internalformat, width, height, border, format, type, pixels),
    qglTexParameterf: (target, pname, param) => s.glTexParameterf(target, pname, param),
    qglTexSubImage2D: (target, level, xoffset, yoffset, width, height, format, type, pixels) =>
      s.glTexSubImage2D(target, level, xoffset, yoffset, width, height, format, type, pixels),
    qglTranslatef: (x, y, z) => s.glTranslatef(x, y, z),
    qglUnlockArraysEXT: glUnlockArraysEXT ? () => glUnlockArraysEXT() : null,
    qglVertex2f: (x, y) => s.glVertex2f(x, y),
    qglVertex3f: (x, y, z) => s.glVertex3f(x, y, z),
    qglVertex3fv: (v) => s.glVertex3fv(v),
    qglVertexPointer: (size, type, stride, pointer) => s.glVertexPointer(size, type, stride, pointer),
    qglViewport: (x, y, width, height) => s.glViewport(x, y, width, height),
  };
}
