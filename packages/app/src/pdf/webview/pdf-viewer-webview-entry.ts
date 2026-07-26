import * as pdfjs from "pdfjs-dist";
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from "pdfjs-dist";
import {
  PDF_VIEWER_RECEIVE_GLOBAL,
  type PdfViewerInboundMessage,
  type PdfViewerOutboundMessage,
  type PdfViewerTheme,
} from "@/pdf/pdf-viewer-protocol";

/**
 * The pdf.js worker bundle, inlined at build time by
 * scripts/build-pdf-webview-html.mjs. The viewer document has no network
 * access to fetch it from, so it travels in the bundle and becomes a worker
 * through a blob URL.
 *
 * It is carried as base64 rather than as a source string: pdf.js is full of
 * non-ASCII characters, and a raw string literal costs six bytes per one of
 * them in escapes — about a megabyte over the whole worker.
 */
declare const __PDF_WORKER_SOURCE_BASE64__: string;

declare global {
  interface Window {
    ReactNativeWebView?: { postMessage?: (data: string) => void };
    [PDF_VIEWER_RECEIVE_GLOBAL]?: (message: PdfViewerInboundMessage) => void;
  }
}

/** Pages this far outside the viewport (in viewport heights) are rendered ahead of a scroll. */
const RENDER_MARGIN_SCREENS = 1;
/** Rendered canvases retained at once. Past this the farthest page reverts to a placeholder. */
const MAX_RENDERED_PAGES = 8;
/** Canvas backing-store scale ceiling: retina is worth it, 3x on a large page is not. */
const MAX_PIXEL_RATIO = 2;
const PAGE_GAP_PX = 12;
const RESIZE_DEBOUNCE_MS = 150;

function post(message: PdfViewerOutboundMessage): void {
  const serialized = JSON.stringify(message);
  if (window.ReactNativeWebView?.postMessage) {
    // react-native-webview's bridge takes the payload only; it is not the DOM
    // postMessage this rule is written for.
    // oxlint-disable-next-line unicorn/require-post-message-target-origin
    window.ReactNativeWebView.postMessage(serialized);
    return;
  }
  window.parent?.postMessage(serialized, "*");
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return typeof error === "string" ? error : "Failed to render the PDF.";
}

function setupWorker(): void {
  const source = decodeBase64(__PDF_WORKER_SOURCE_BASE64__);
  try {
    const blob = new Blob([source], { type: "text/javascript" });
    const worker = new Worker(URL.createObjectURL(blob));
    worker.addEventListener("error", () => {
      post({ type: "error", message: "The PDF worker failed to start." });
    });
    pdfjs.GlobalWorkerOptions.workerPort = worker;
  } catch {
    // Some embeddings refuse blob workers. Evaluating the same bundle here
    // registers globalThis.pdfjsWorker, which pdf.js picks up as its
    // main-thread handler.
    new Function(new TextDecoder().decode(source))();
  }
}

function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.byteLength;
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

interface PageSlot {
  index: number;
  element: HTMLDivElement;
  canvas: HTMLCanvasElement | null;
  task: RenderTask | null;
  page: PDFPageProxy | null;
  /**
   * Set synchronously when a render starts. The observer and the initial paint
   * can both reach for the first page; without a synchronous claim they would
   * each get past an `await` before the other saw a task in flight.
   */
  claimed: boolean;
  /** Bumped on every layout pass so a late render can tell it is stale. */
  generation: number;
}

class PdfViewer {
  private readonly container: HTMLDivElement;
  private readonly status: HTMLDivElement;
  private document: PDFDocumentProxy | null = null;
  private slots: PageSlot[] = [];
  private observer: IntersectionObserver | null = null;
  private renderOrder: number[] = [];
  private generation = 0;
  private resizeTimer: number | null = null;
  private lastWidth = 0;
  private theme: PdfViewerTheme = {
    background: "#1b1b1b",
    pageBackground: "#ffffff",
    foreground: "#f5f5f5",
  };

  constructor() {
    this.container = document.createElement("div");
    this.container.className = "pdf-pages";
    this.status = document.createElement("div");
    this.status.className = "pdf-status";
    document.body.append(this.status, this.container);

    const resizeObserver = new ResizeObserver(() => this.onResize());
    resizeObserver.observe(document.body);
  }

  applyTheme(theme: PdfViewerTheme): void {
    this.theme = theme;
    document.body.style.backgroundColor = theme.background;
    this.status.style.color = theme.foreground;
    for (const slot of this.slots) {
      slot.element.style.backgroundColor = theme.pageBackground;
    }
  }

  async open(bytes: Uint8Array): Promise<void> {
    await this.reset();
    this.setStatus("");
    try {
      this.document = await pdfjs.getDocument({
        data: bytes,
        // Nothing to fetch from: the viewer document is inlined, so pdf.js's
        // optional assets (cmaps, standard fonts, wasm decoders) are not
        // reachable. It falls back to system fonts and its pure-JS decoders.
        useWorkerFetch: false,
        useSystemFonts: true,
        enableXfa: false,
      }).promise;
      await this.layout();
      // Paint the first page before reporting: the shell drops its loading
      // state on this message, and empty page boxes are not a preview. A page
      // that fails has already reported its own error — don't overwrite it
      // with a success.
      const first = this.slots[0];
      if (first && !(await this.renderSlot(first))) return;
      post({ type: "rendered", pageCount: this.document.numPages });
    } catch (error) {
      this.setStatus(errorMessage(error));
      post({ type: "error", message: errorMessage(error) });
    }
  }

  private setStatus(text: string): void {
    this.status.textContent = text;
    this.status.style.display = text ? "flex" : "none";
  }

  private async reset(): Promise<void> {
    this.generation += 1;
    this.observer?.disconnect();
    this.observer = null;
    for (const slot of this.slots) {
      slot.task?.cancel();
      slot.page?.cleanup();
    }
    this.slots = [];
    this.renderOrder = [];
    this.container.replaceChildren();
    const previous = this.document;
    this.document = null;
    // Teardown lives on the loading task, which also shuts down the worker's
    // state for this document.
    await previous?.loadingTask.destroy();
  }

  /**
   * Page boxes are laid out from the first page's aspect ratio so a long
   * document gets a scrollbar immediately; each page corrects its own height
   * when it renders.
   */
  private async layout(): Promise<void> {
    const doc = this.document;
    if (!doc) return;

    const generation = this.generation;
    const width = this.pageWidth();
    this.lastWidth = width;
    const first = await doc.getPage(1);
    if (generation !== this.generation) return;
    const firstViewport = first.getViewport({ scale: 1 });
    const aspectRatio = firstViewport.height / firstViewport.width;

    const slots: PageSlot[] = [];
    for (let index = 1; index <= doc.numPages; index += 1) {
      const element = document.createElement("div");
      element.className = "pdf-page";
      element.style.width = `${width}px`;
      element.style.height = `${Math.round(width * aspectRatio)}px`;
      element.style.backgroundColor = this.theme.pageBackground;
      element.dataset.pageIndex = String(index);
      slots.push({
        index,
        element,
        canvas: null,
        task: null,
        page: null,
        claimed: false,
        generation,
      });
      this.container.append(element);
    }
    this.slots = slots;

    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const index = Number((entry.target as HTMLElement).dataset.pageIndex);
          const slot = this.slots.find((candidate) => candidate.index === index);
          if (!slot || !entry.isIntersecting) continue;
          void this.renderSlot(slot);
        }
      },
      { root: null, rootMargin: `${RENDER_MARGIN_SCREENS * 100}% 0px` },
    );
    for (const slot of slots) this.observer.observe(slot.element);
  }

  private pageWidth(): number {
    const available = document.body.clientWidth - PAGE_GAP_PX * 2;
    return Math.max(1, Math.floor(available));
  }

  /** Resolves false only when this page could not be painted for this document. */
  private async renderSlot(slot: PageSlot): Promise<boolean> {
    const doc = this.document;
    if (!doc || slot.generation !== this.generation) return false;
    // Already painted or in flight from the observer: nothing to do, and not a
    // failure for the caller waiting on a first paint.
    if (slot.claimed) return true;
    slot.claimed = true;

    try {
      const page = slot.page ?? (await doc.getPage(slot.index));
      if (slot.generation !== this.generation) return false;
      slot.page = page;

      const width = this.pageWidth();
      const unscaled = page.getViewport({ scale: 1 });
      const cssScale = width / unscaled.width;
      const pixelRatio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
      const viewport = page.getViewport({ scale: cssScale * pixelRatio });

      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${Math.floor(viewport.height / pixelRatio)}px`;

      slot.element.style.height = `${Math.floor(viewport.height / pixelRatio)}px`;
      slot.canvas = canvas;

      const task = page.render({ canvas, viewport });
      slot.task = task;
      await task.promise;
      if (slot.generation !== this.generation) {
        slot.canvas = null;
        slot.claimed = false;
        return false;
      }
      slot.element.replaceChildren(canvas);
      slot.task = null;
      this.trackRendered(slot.index);
      return true;
    } catch (error) {
      slot.task = null;
      slot.canvas = null;
      slot.claimed = false;
      if (error instanceof Error && error.name === "RenderingCancelledException") return false;
      post({ type: "error", message: errorMessage(error) });
      return false;
    }
  }

  /** Keeps the rendered-canvas count bounded: a 600-page file must not become 600 bitmaps. */
  private trackRendered(index: number): void {
    this.renderOrder = this.renderOrder.filter((candidate) => candidate !== index);
    this.renderOrder.push(index);
    while (this.renderOrder.length > MAX_RENDERED_PAGES) {
      const evicted = this.renderOrder.shift();
      const slot = this.slots.find((candidate) => candidate.index === evicted);
      if (!slot) continue;
      slot.task?.cancel();
      slot.task = null;
      slot.canvas = null;
      slot.claimed = false;
      slot.element.replaceChildren();
    }
  }

  private onResize(): void {
    if (this.resizeTimer !== null) window.clearTimeout(this.resizeTimer);
    this.resizeTimer = window.setTimeout(() => {
      this.resizeTimer = null;
      if (!this.document || this.pageWidth() === this.lastWidth) return;
      void this.relayout();
    }, RESIZE_DEBOUNCE_MS);
  }

  /** A width change invalidates every rendered bitmap; re-lay-out and let the observer refill. */
  private async relayout(): Promise<void> {
    const doc = this.document;
    if (!doc) return;
    this.generation += 1;
    this.observer?.disconnect();
    this.observer = null;
    for (const slot of this.slots) {
      slot.task?.cancel();
      slot.page?.cleanup();
    }
    this.slots = [];
    this.renderOrder = [];
    this.container.replaceChildren();
    await this.layout();
  }
}

function bootstrap(): void {
  setupWorker();

  const style = document.createElement("style");
  style.textContent = `
    html, body { margin: 0; padding: 0; height: 100%; background: #1b1b1b; }
    body { overflow-y: auto; overflow-x: hidden; -webkit-text-size-adjust: 100%; }
    .pdf-pages { display: flex; flex-direction: column; align-items: center; gap: ${PAGE_GAP_PX}px; padding: ${PAGE_GAP_PX}px; box-sizing: border-box; }
    .pdf-page { box-shadow: 0 1px 6px rgba(0, 0, 0, 0.35); overflow: hidden; }
    .pdf-page canvas { display: block; }
    .pdf-status { display: none; align-items: center; justify-content: center; padding: 24px 16px; font: 14px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; text-align: center; }
  `;
  document.head.append(style);

  const viewer = new PdfViewer();
  let chunks: Uint8Array[] = [];

  window[PDF_VIEWER_RECEIVE_GLOBAL] = (message: PdfViewerInboundMessage) => {
    switch (message.type) {
      case "open":
        chunks = [];
        viewer.applyTheme(message.theme);
        break;
      case "chunk":
        chunks.push(
          message.encoding === "base64" ? decodeBase64(message.data) : new Uint8Array(message.data),
        );
        break;
      case "commit": {
        const bytes = concatChunks(chunks);
        chunks = [];
        void viewer.open(bytes);
        break;
      }
      case "theme":
        viewer.applyTheme(message.theme);
        break;
    }
  };

  // The web shell posts structured-clone messages; native injects a call to the
  // global above.
  window.addEventListener("message", (event: MessageEvent) => {
    const data = event.data as PdfViewerInboundMessage | undefined;
    if (!data || typeof data !== "object" || typeof data.type !== "string") return;
    window[PDF_VIEWER_RECEIVE_GLOBAL]?.(data);
  });

  post({ type: "ready" });
}

bootstrap();
