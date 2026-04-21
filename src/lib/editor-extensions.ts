import { Decoration, DecorationSet, MatchDecorator, ViewPlugin, ViewUpdate, WidgetType, EditorView } from "@codemirror/view";

class ImageWidget extends WidgetType {
  constructor(readonly url: string, readonly alt: string, readonly width: string | null) {
    super();
  }

  eq(other: ImageWidget) {
    return other.url === this.url && other.alt === this.alt && other.width === this.width;
  }

  toDOM(view: EditorView) {
    const container = document.createElement("div");
    container.className = "cm-obsidian-image-container my-4 relative group inline-block max-w-full";
    
    const img = document.createElement("img");
    
    // Append token if hitting our internal API
    if (this.url.startsWith('/api/')) {
      const token = localStorage.getItem('jays_notes_token');
      const separator = this.url.includes('?') ? '&' : '?';
      img.src = token ? `${this.url}${separator}token=${token}` : this.url;
    } else {
      img.src = this.url;
    }
    
    img.alt = this.alt;
    img.referrerPolicy = "no-referrer";
    img.className = "rounded-lg shadow-sm border border-border-color transition-all cursor-default select-none";
    
    if (this.width) {
      img.style.width = `${this.width}px`;
    } else {
      img.style.maxWidth = "100%";
      img.style.height = "auto";
    }
    
    // Resize Handle (Bottom Right)
    const resizeHandle = document.createElement("div");
    resizeHandle.className = "absolute bottom-1 right-1 w-4 h-4 bg-interactive-accent/80 rounded-sm opacity-0 group-hover:opacity-100 cursor-nwse-resize flex items-center justify-center transition-opacity";
    resizeHandle.innerHTML = `<svg viewBox="0 0 24 24" width="10" height="10" stroke="white" stroke-width="3" fill="none"><path d="M15 19l4-4M10 19l9-9M5 19l14-14"/></svg>`;
    
    const startResize = (e: MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = img.clientWidth;
      
      const onMouseMove = (moveEvent: MouseEvent) => {
        const deltaX = moveEvent.clientX - startX;
        const newWidth = Math.max(50, startWidth + deltaX);
        img.style.width = `${newWidth}px`;
      };
      
      const onMouseUp = () => {
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        
        const finalWidth = Math.round(img.clientWidth);
        this.updateMarkdown(view, container, finalWidth);
      };
      
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    };
    
    resizeHandle.onmousedown = startResize;
    
    container.appendChild(img);
    container.appendChild(resizeHandle);
    return container;
  }

  updateMarkdown(view: EditorView, container: HTMLElement, newWidth: number) {
    const pos = view.posAtDOM(container);
    if (pos === null) return;
    
    const line = view.state.doc.lineAt(pos);
    const text = line.text;
    
    const regex = /!\[(.*?)\]\((.*?)\)/g;
    let match;
    while ((match = regex.exec(text)) !== null) {
      if (match[2] === this.url) {
        const start = line.from + match.index;
        const end = start + match[0].length;
        const newAlt = `${this.alt}|${newWidth}`;
        const newMarkdown = `![${newAlt}](${this.url})`;
        
        view.dispatch({
          changes: { from: start, to: end, insert: newMarkdown }
        });
        break;
      }
    }
  }
}

const imageDecorator = new MatchDecorator({
  regexp: /!\[(.*?)\]\((.*?)\)/g,
  decoration: (match, view, pos) => {
    const alt = match[1];
    const url = match[2];
    let width: string | null = null;
    let cleanAlt = alt;
    
    if (alt.includes('|')) {
      const parts = alt.split('|');
      cleanAlt = parts[0];
      width = parts[1];
    }
    
    return Decoration.replace({
      widget: new ImageWidget(url, cleanAlt, width),
    });
  }
});

export const imagePlugin = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view) {
    this.decorations = imageDecorator.createDeco(view);
  }
  update(update: ViewUpdate) {
    this.decorations = imageDecorator.updateDeco(update, this.decorations);
  }
}, {
  decorations: v => v.decorations
});

// Decorator for #tags
// Rules:
//  - Must NOT be at the very start of a line (that's a heading)
//  - Must be preceded by whitespace or start of content (not another #)
//  - The char after # must be a letter (not a digit or space)
const tagDecorator = new MatchDecorator({
  regexp: /(?<=[ \t,;(]|^[ \t]*)#([a-zA-Z][a-zA-Z0-9_-]*)/gm,
  decoration: () => Decoration.mark({ class: "cm-obsidian-tag" })
});

export const tagPlugin = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view) {
    this.decorations = tagDecorator.createDeco(view);
  }
  update(update: ViewUpdate) {
    this.decorations = tagDecorator.updateDeco(update, this.decorations);
  }
}, {
  decorations: v => v.decorations
});

// Decorator for [[WikiLinks]]
const linkDecorator = new MatchDecorator({
  regexp: /\[\[(.*?)\]\]/g,
  decoration: match => Decoration.mark({ class: "cm-obsidian-link" })
});

export const linkPlugin = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view) {
    this.decorations = linkDecorator.createDeco(view);
  }
  update(update: ViewUpdate) {
    this.decorations = linkDecorator.updateDeco(update, this.decorations);
  }
}, {
  decorations: v => v.decorations
});

// Decorator for > [!info] Callouts
const calloutDecorator = new MatchDecorator({
  regexp: />\s*\[!(.*?)\](.*)/g,
  decoration: match => {
    const type = match[1].toLowerCase();
    return Decoration.mark({ class: `cm-obsidian-callout cm-obsidian-callout-${type}` });
  }
});

export const calloutPlugin = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view) {
    this.decorations = calloutDecorator.createDeco(view);
  }
  update(update: ViewUpdate) {
    this.decorations = calloutDecorator.updateDeco(update, this.decorations);
  }
}, {
  decorations: v => v.decorations
});
