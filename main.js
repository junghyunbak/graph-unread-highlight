"use strict";

const { Plugin, PluginSettingTab, Setting, Notice } = require("obsidian");

const GRAPH_VIEW_TYPES = ["graph", "localgraph"];

const DEFAULT_SETTINGS = {
  seen: {},                  // path -> last-seen timestamp (ms)
  badgeColor: "#ff3399",     // vivid magenta — distinct from typical node colors
  ringGap: 4,                // extra radius beyond the node (local units)
  ringWidth: 4,              // ring thickness (local units) — bold enough to notice
};

module.exports = class GraphUnreadHighlight extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    if (!this.settings.seen) {
      this.settings.seen = {};
    }
    this.unread = new Set();
    this.layers = new Map();   // renderer -> { hanger, badges: Map(path -> Graphics) }
    this._raf = 0;

    this.addSettingTab(new GUHSettingTab(this.app, this));

    this.registerEvent(
      this.app.workspace.on("file-open", (file) => file && this.markRead(file.path))
    );
    const bump = () => this.recomputeUnread();
    this.registerEvent(this.app.vault.on("modify", bump));
    this.registerEvent(this.app.vault.on("create", bump));
    this.registerEvent(this.app.vault.on("rename", bump));
    this.registerEvent(this.app.vault.on("delete", bump));

    this.app.workspace.onLayoutReady(() => {
      this.recomputeUnread();
      this.patchAllGraphLeaves();
      this.startLoop();
    });
    this.registerEvent(
      this.app.workspace.on("layout-change", () => this.patchAllGraphLeaves())
    );
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => this.patchAllGraphLeaves())
    );

    this.addCommand({
      id: "mark-all-read",
      name: "Mark all notes as read",
      callback: () => this.markAllRead(),
    });
    this.addCommand({
      id: "mark-all-unread",
      name: "Mark all notes as unread",
      callback: () => {
        this.settings.seen = {};
        this.saveData(this.settings);
        this.recomputeUnread();
        new Notice(`Graph: ${this.unread.size} notes marked unread`);
      },
    });

    this.register(() => this.cleanupAll());
  }

  onunload() {
    this.cleanupAll();
  }

  cleanupAll() {
    this.stopLoop();
    for (const layer of this.layers.values()) {
      for (const g of layer.badges.values()) {
        if (layer.hanger) layer.hanger.removeChild(g);
        if (g.destroy) g.destroy();
      }
      layer.badges.clear();
      if (layer.renderer && layer.renderer.changed) layer.renderer.changed();
    }
    this.layers.clear();
    document.querySelectorAll(".guh-mark-read").forEach((b) => b.remove());
  }

  nodeList(r) {
    const raw = r && r.nodes;
    if (!raw) return [];
    return Array.isArray(raw) ? raw : Object.values(raw);
  }

  // ----- unread state -----

  recomputeUnread() {
    this.unread = new Set();
    for (const f of this.app.vault.getMarkdownFiles()) {
      if (f.stat && f.stat.mtime > (this.settings.seen[f.path] || 0)) {
        this.unread.add(f.path);
      }
    }
  }

  markRead(path) {
    this.settings.seen[path] = Date.now();
    this.unread.delete(path);
    this.saveData(this.settings);
  }

  markAllRead() {
    const now = Date.now();
    for (const f of this.app.vault.getMarkdownFiles()) {
      this.settings.seen[f.path] = now;
    }
    this.unread.clear();
    this.saveData(this.settings);
    new Notice("Graph: marked all notes as read");
  }

  // ----- graph hookup -----

  patchAllGraphLeaves() {
    const seen = new Set();
    for (const type of GRAPH_VIEW_TYPES) {
      for (const leaf of this.app.workspace.getLeavesOfType(type)) {
        const view = leaf.view;
        const renderer = view && view.renderer;
        const container = (renderer && renderer.containerEl) || (view && view.containerEl);
        if (!renderer || !renderer.hanger) {
          continue;
        }
        seen.add(renderer);
        if (!this.layers.has(renderer)) {
          this.layers.set(renderer, {
            renderer,
            hanger: renderer.hanger,
            badges: new Map(),
          });
          if (container) this.addButton(container);
        }
      }
    }
    for (const [renderer, layer] of this.layers) {
      if (!seen.has(renderer)) {
        for (const g of layer.badges.values()) {
          if (layer.hanger) layer.hanger.removeChild(g);
          if (g.destroy) g.destroy();
        }
        this.layers.delete(renderer);
      }
    }
  }

  addButton(container) {
    if (container.querySelector(".guh-mark-read")) {
      return;
    }
    const btn = container.createEl("button", {
      cls: "guh-mark-read",
      text: "✓ Mark all read",
    });
    btn.setAttribute("aria-label", "Mark all notes as read");
    btn.addEventListener("mousedown", (e) => e.stopPropagation());
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      this.markAllRead();
    });
    this.register(() => btn.remove());
  }

  // ----- PIXI badges (added into renderer.hanger; auto-tracks pan/zoom) -----

  // Hollow ring (no fill) so the node stays visible through it, sized just
  // outside the node so even tiny nodes are not covered.
  drawRing(g, R) {
    const color = parseInt(String(this.settings.badgeColor).replace("#", ""), 16) || 0xff4d4d;
    const w = this.settings.ringWidth;
    g.clear();
    if (this._hasV8) {
      g.circle(0, 0, R).stroke({ width: w, color, alpha: 1 });
    } else {
      g.lineStyle(w, color, 1);
      g.drawCircle(0, 0, R);
    }
  }

  nodeRadius(n) {
    const w = n && n.circle && n.circle.width;
    return w ? w / 2 : 8;
  }

  startLoop() {
    const step = () => {
      this.syncBadges();
      this._raf = requestAnimationFrame(step);
    };
    this._raf = requestAnimationFrame(step);
  }

  stopLoop() {
    if (this._raf) {
      cancelAnimationFrame(this._raf);
      this._raf = 0;
    }
  }

  syncBadges() {
    try {
      for (const layer of this.layers.values()) {
        const hanger = layer.hanger;
        if (!hanger) continue;
        const list = this.nodeList(layer.renderer);

        // Reuse the same Graphics class as existing node circles (matches the
        // app's exact PIXI build).
        if (!this._GfxClass) {
          const s = list.find((n) => n && n.circle && n.circle.constructor);
          if (s) {
            this._GfxClass = s.circle.constructor;
            this._hasV8 = typeof s.circle.circle === "function" && typeof s.circle.fill === "function";
            try { hanger.sortableChildren = true; } catch (e) {}
          } else {
            continue; // no node circle yet
          }
        }

        let changed = false;
        const active = new Set();
        for (const n of list) {
          if (!n || n.id == null || !this.unread.has(n.id)) continue;
          let g = layer.badges.get(n.id);
          if (!g) {
            g = new this._GfxClass();
            g.zIndex = 100000;
            g._r = -1;
            hanger.addChild(g);
            layer.badges.set(n.id, g);
            changed = true;
          }
          g.position.set(n.x, n.y);
          const R = this.nodeRadius(n) + this.settings.ringGap;
          if (g._r !== R) {
            this.drawRing(g, R);
            g._r = R;
          }
          active.add(n.id);
        }
        for (const [path, g] of layer.badges) {
          if (!active.has(path)) {
            hanger.removeChild(g);
            if (g.destroy) g.destroy();
            layer.badges.delete(path);
            changed = true;
          }
        }
        if (changed && layer.renderer.changed) layer.renderer.changed();
      }
    } catch (e) {
      if (!this._loggedErr) {
        console.error("[GUH] syncBadges error:", e);
        this._loggedErr = true;
      }
    }
  }

  redrawAll() {
    // Force a redraw on the next frame with current settings.
    for (const layer of this.layers.values()) {
      for (const g of layer.badges.values()) g._r = -1;
      if (layer.renderer.changed) layer.renderer.changed();
    }
  }
};

class GUHSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl)
      .setName("Badge color")
      .setDesc("Color of the unread marker on new / recently edited nodes.")
      .addColorPicker((c) =>
        c.setValue(this.plugin.settings.badgeColor).onChange(async (v) => {
          this.plugin.settings.badgeColor = v;
          await this.plugin.saveData(this.plugin.settings);
          this.plugin.redrawAll();
        })
      );
    new Setting(containerEl)
      .setName("Ring gap")
      .setDesc("How far the ring sits outside the node (graph units).")
      .addSlider((s) =>
        s.setLimits(0, 16, 1).setValue(this.plugin.settings.ringGap).setDynamicTooltip().onChange(async (v) => {
          this.plugin.settings.ringGap = v;
          await this.plugin.saveData(this.plugin.settings);
          this.plugin.redrawAll();
        })
      );

    new Setting(containerEl)
      .setName("Ring thickness")
      .setDesc("Width of the ring stroke (graph units).")
      .addSlider((s) =>
        s.setLimits(1, 10, 0.5).setValue(this.plugin.settings.ringWidth).setDynamicTooltip().onChange(async (v) => {
          this.plugin.settings.ringWidth = v;
          await this.plugin.saveData(this.plugin.settings);
          this.plugin.redrawAll();
        })
      );
    new Setting(containerEl)
      .setName("Mark all notes as read")
      .addButton((b) => b.setButtonText("Mark all read").onClick(() => this.plugin.markAllRead()));
  }
}
