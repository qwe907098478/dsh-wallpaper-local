/**
 * dsh-wallpaper-local — Browser (client) half.
 *
 * 不依赖 Wallpaper Engine：用本地图片 / 视频（或内置 SVG 渐变）做 DSH 应用
 * 背景。图片走 html::before/::after 双伪元素交叉淡化；视频走一个固定在
 * 底层的 <video autoplay muted loop playsinline> 元素，切到图片时隐藏。
 *
 * 可读性：背景不透明度（主题令牌覆盖）、壁纸压暗、毛玻璃模糊、文字阴影。
 * 设置页经 settings.section 注册为「设置 → 本地壁纸」；配置持久化到
 * $DSH_HOME/wallpaper-local.json，重启后保留。
 *
 * 兼容性：所有 DOM/CSS 均由本插件私有 <style> 与 documentElement 内联变量
 * 承担，类名前缀 .dswpl-、主题覆盖 source 均为唯一；不影响其他插件。
 */
window.__ModuleLoader__.load({
  id: "dsh-wallpaper-local",
  factory: (require) => {
    "use strict";
    var module = { exports: {} };
    var exports = module.exports;

    const React = require("react");
    const h = React.createElement;

    /** Cordis 插件名（与 patch 行 id 一致）。 */
    const name = "wallpaper-local";
    /** 依赖的客户端服务。 */
    const inject = ["slots", "theme", "timer"];

    /** 本插件 Host 路由前缀。 */
    const API = "/plugins/wallpaper-local";

    const DEFAULTS = {
      folder: "",
      savedName: "",
      transitionMs: 1200,
      enabled: true,
      fullscreen: false,
      panelAlpha: 80,
      baseAlpha: 55,
      scrim: 30,
      blurPx: 10,
      textShadow: 1,
      videoMuted: true,
      videoVolume: 0.3
    };

    const BUILTIN_IMAGES = [
      { name: "内置壁纸 · 晨光", url: API + "/builtin/0.svg", kind: "image" },
      { name: "内置壁纸 · 海洋", url: API + "/builtin/1.svg", kind: "image" },
      { name: "内置壁纸 · 暮色", url: API + "/builtin/2.svg", kind: "image" },
      { name: "内置壁纸 · 林间", url: API + "/builtin/3.svg", kind: "image" }
    ];

    const TS = ["none", "0 1px 2px rgba(0,0,0,0.25)", "0 1px 3px rgba(0,0,0,0.5)"];

    function apply(ctx) {
      // ================= 小型内存 store =================
      const listeners = new Set();
      let state = Object.assign({}, DEFAULTS, { files: [], current: null, error: null, scanning: false });
      const store = {
        get: () => state,
        set(patch) { state = Object.assign({}, state, patch); for (const l of listeners) l(state); },
        subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; }
      };

      // ================= 私有样式 =================
      const styleEl = document.createElement("style");
      styleEl.setAttribute("data-wallpaper-local", "true");
      document.head.appendChild(styleEl);
      styleEl.textContent = `
        html::before, html::after {
          content: "";
          position: fixed;
          left: 0; top: 0;
          width: 100%; height: 100%;
          background-position: center;
          background-size: cover;
          background-repeat: no-repeat;
          pointer-events: none;
          z-index: -1;
          filter: var(--dswpl-blur, none);
        }
        html::before {
          background-image:
            linear-gradient(rgba(0,0,0,var(--wp-scrim, 0)), rgba(0,0,0,var(--wp-scrim, 0))),
            var(--wp-cur, none);
          opacity: var(--wp-cur-op, 1);
          transition: opacity var(--wp-dur, 1200ms) ease;
        }
        html::after {
          background-image:
            linear-gradient(rgba(0,0,0,var(--wp-scrim, 0)), rgba(0,0,0,var(--wp-scrim, 0))),
            var(--wp-next, none);
          opacity: var(--wp-next-op, 0);
          transition: opacity var(--wp-dur, 1200ms) ease;
        }
        .dswpl-video-layer {
          position: fixed;
          left: 0; top: 0;
          width: 100%; height: 100%;
          object-fit: cover;
          pointer-events: none;
          z-index: -1;
          /* 模糊 + 压暗：brightness(1-scrim) 等价于黑色蒙层，作用于视频画面本身 */
          filter: var(--dswpl-blur, none) brightness(var(--wp-bright, 1));
          opacity: 0;
          transition: opacity var(--wp-dur, 1200ms) ease;
          background: #000;
        }
        .dswpl-video-layer.dswpl-active { opacity: 1; }
        /* 对话区半透明背景（无模糊）；class 后缀匹配布局列（CSS Modules 类名
           [hash]_centerCol），不依赖具体 hash。明暗主题分色，透明度由
           --dswpl-glass-a 控制（= 主壁纸透明度 baseAlpha）。
           仅当 html[data-dswpl-glass] 存在时生效（插件启用时挂载该属性）。 */
        html[data-dswpl-glass] [class*="centerCol"] {
          background: rgba(255,255,255,var(--dswpl-glass-a, 0.55)) !important;
        }
        html[data-dswpl-glass] [data-ds-dark-theme] [class*="centerCol"] {
          background: rgba(28,30,38,var(--dswpl-glass-a, 0.55)) !important;
        }
        /* 侧边栏半透明背景：透明度 = 主壁纸透明度(baseAlpha) + 3%，
           由 --dswpl-glass-sidebar-a 单独控制。 */
        html[data-dswpl-glass] [class*="sidebarCol"] {
          background: rgba(255,255,255,var(--dswpl-glass-sidebar-a, 0.58)) !important;
        }
        html[data-dswpl-glass] [data-ds-dark-theme] [class*="sidebarCol"] {
          background: rgba(28,30,38,var(--dswpl-glass-sidebar-a, 0.58)) !important;
        }
        /* 全屏模式：侧边栏完全透明，壁纸完整透出 */
        html[data-dswpl-fullscreen][data-dswpl-glass] [class*="sidebarCol"] {
          background: transparent !important;
        }
        body * {
          text-shadow: var(--dswpl-ts, none);
        }
        @media (prefers-reduced-motion: reduce) {
          html::before, html::after, .dswpl-video-layer { transition: none; }
        }
        .dswpl-page { padding: 4px 20px 28px; max-width: 620px; display: flex; flex-direction: column; gap: 16px; }
        .dswpl-card {
          background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1);
          border-radius: 14px; padding: 16px; display: flex; flex-direction: column; gap: 12px;
        }
        .dswpl-title { font-size: 15px; line-height: 22px; font-weight: 600; color: var(--dsw-alias-label-primary); margin: 0; }
        .dswpl-row { display: flex; align-items: center; gap: 10px; min-width: 0; }
        .dswpl-row .dswpl-grow { flex: 1; min-width: 0; }
        .dswpl-label { font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-secondary); flex: none; width: 96px; }
        .dswpl-input, .dswpl-select {
          box-sizing: border-box; height: 32px; padding: 0 10px;
          background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary);
          border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px;
          font-family: inherit; font-size: 13px; line-height: 20px; outline: none; min-width: 0;
        }
        .dswpl-input:focus, .dswpl-select:focus { border-color: var(--dsw-alias-brand-primary); }
        .dswpl-input.dswpl-num { width: 84px; }
        .dswpl-btn {
          box-sizing: border-box; height: 32px; padding: 0 14px; cursor: pointer;
          background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary);
          border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px;
          font-family: inherit; font-size: 13px; line-height: 20px; flex: none;
        }
        .dswpl-btn:hover { background: var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-layer-2)); }
        .dswpl-btn-primary {
          background: var(--dsw-alias-brand-primary); border-color: transparent; color: #fff;
        }
        .dswpl-btn-primary:hover { opacity: 0.9; background: var(--dsw-alias-brand-primary); }
        .dswpl-hint { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
        .dswpl-error { font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-error-primary); }
        .dswpl-ok { font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-success-primary); }
        .dswpl-switch { position: relative; width: 40px; height: 22px; flex: none; cursor: pointer; display: inline-block; }
        .dswpl-switch input { position: absolute; opacity: 0; inset: 0; margin: 0; cursor: pointer; }
        .dswpl-switch .dswpl-track {
          position: absolute; inset: 0; border-radius: 11px;
          background: var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-layer-2));
          border: 1px solid var(--dsw-alias-border-l1); transition: background 0.15s ease;
        }
        .dswpl-switch .dswpl-thumb {
          position: absolute; top: 3px; left: 3px; width: 16px; height: 16px; border-radius: 50%;
          background: var(--dsw-alias-label-secondary); transition: transform 0.15s ease, background 0.15s ease;
        }
        .dswpl-switch input:checked ~ .dswpl-track { background: var(--dsw-alias-brand-primary); border-color: transparent; }
        .dswpl-switch input:checked ~ .dswpl-thumb { transform: translateX(18px); background: #fff; }
        .dswpl-slider { flex: 1; accent-color: var(--dsw-alias-brand-primary); }
        .dswpl-preview {
          width: 180px; height: 101px; border-radius: 10px; object-fit: cover; flex: none;
          border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2);
        }
        .dswpl-meta { min-width: 0; display: flex; flex-direction: column; gap: 6px; }
        .dswpl-name {
          font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-primary);
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        /* 快捷开关：常驻浮动按钮，一键关闭 / 开启壁纸。
           注意：挂在 document.body 下才能继承 DSH 主题变量；
           变量缺失时用兜底色保证文字始终可见。 */
        .dswpl-quick-toggle {
          position: fixed;
          right: 58px;
          bottom: 104px;
          z-index: 2147483000;
          display: inline-flex;
          align-items: center;
          gap: 6px;
          height: 32px;
          padding: 0 14px;
          border-radius: 16px;
          border: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.1));
          background: var(--dsw-alias-bg-layer-2, rgba(255, 255, 255, 0.85));
          color: var(--dsw-alias-label-primary, #111);
          font-family: inherit;
          font-size: 12px;
          line-height: 1;
          cursor: pointer;
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.22);
          backdrop-filter: blur(8px);
          -webkit-backdrop-filter: blur(8px);
        }
        .dswpl-quick-toggle:hover {
          background: var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-layer-2, rgba(255, 255, 255, 0.95)));
        }
        .dswpl-quick-toggle.dswpl-off {
          background: var(--dsw-alias-brand-primary, #3b5bdb);
          border-color: transparent;
          color: #fff;
        }
        .dswpl-quick-toggle.dswpl-off:hover { opacity: 0.9; }
        /* 独立电源开关：一键开/关壁纸（最快捷） */
        .dswpl-power-btn {
          position: fixed;
          right: 16px;
          bottom: 104px;
          z-index: 2147483000;
          width: 32px; height: 32px;
          border-radius: 50%;
          border: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.1));
          background: var(--dsw-alias-bg-layer-2, rgba(255, 255, 255, 0.85));
          color: var(--dsw-alias-label-primary, #111);
          font-size: 15px; line-height: 1;
          display: flex; align-items: center; justify-content: center;
          cursor: pointer;
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.22);
        }
        .dswpl-power-btn:hover { background: var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-layer-2, #fff)); }
        .dswpl-power-btn.dswpl-on {
          background: var(--dsw-alias-brand-primary, #3b5bdb);
          border-color: transparent;
          color: #fff;
        }
        .dswpl-power-btn.dswpl-off {
          background: var(--dsw-alias-bg-layer-2, rgba(255, 255, 255, 0.85));
          color: var(--dsw-alias-label-secondary, #888);
        }
        /* 设置页：壁纸选择列表 */
        .dswpl-file-row { padding: 6px 8px; border-radius: 8px; gap: 10px; }
        .dswpl-file-row:hover { background: var(--dsw-alias-bg-layer-3, rgba(128, 128, 128, 0.08)); }
        .dswpl-file-row.dswpl-active { background: var(--dsw-alias-bg-layer-3, rgba(128, 128, 128, 0.14)); }
        /* 壁纸控制弹层（点击胶囊展开） */
        .dswpl-popover {
          position: fixed;
          right: 16px;
          bottom: 148px;
          z-index: 2147483000;
          width: 234px;
          max-height: 480px;
          display: flex;
          flex-direction: column;
          border-radius: 12px;
          border: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.12));
          background: var(--dsw-alias-bg-layer-1, rgba(255, 255, 255, 0.96));
          color: var(--dsw-alias-label-primary, #111);
          box-shadow: 0 10px 32px rgba(0, 0, 0, 0.3);
          backdrop-filter: blur(14px);
          -webkit-backdrop-filter: blur(14px);
          overflow-y: auto;
        }
        .dswpl-popover[hidden] { display: none; }
        .dswpl-po-header {
          display: flex; align-items: center; justify-content: space-between; gap: 8px;
          padding: 10px 12px;
          border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.06));
        }
        .dswpl-po-title { flex: 1; font-size: 12px; font-weight: 600; }
        .dswpl-po-refresh {
          flex: none; border: none; background: transparent; cursor: pointer;
          color: var(--dsw-alias-label-secondary, #888);
          font-size: 13px; line-height: 1; padding: 3px 6px; border-radius: 6px;
        }
        .dswpl-po-refresh:hover { background: var(--dsw-alias-bg-layer-3, rgba(128, 128, 128, 0.12)); }
        .dswpl-po-list { overflow-y: auto; max-height: 160px; padding: 4px; }
        .dswpl-po-item {
          display: flex; align-items: center; gap: 8px; width: 100%;
          box-sizing: border-box; padding: 7px 8px;
          border: none; border-radius: 8px; background: transparent;
          color: inherit; font-family: inherit; font-size: 12px; line-height: 1.4;
          text-align: left; cursor: pointer;
        }
        .dswpl-po-item:hover { background: var(--dsw-alias-bg-layer-3, rgba(128, 128, 128, 0.1)); }
        .dswpl-po-item.dswpl-active {
          background: var(--dsw-alias-bg-layer-3, rgba(128, 128, 128, 0.16));
          color: var(--dsw-alias-brand-primary, #3b5bdb);
          font-weight: 600;
        }
        .dswpl-po-dot { flex: none; width: 12px; text-align: center; font-size: 10px; }
        .dswpl-po-name { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .dswpl-po-foot {
          padding: 8px 12px; font-size: 11px;
          color: var(--dsw-alias-label-secondary, #888);
          border-top: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.06));
        }
        /* 弹层内：背景与可读性快速调节 */
        .dswpl-po-read {
          display: flex; flex-direction: column; gap: 8px;
          padding: 10px 12px;
          border-top: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.06));
        }
        .dswpl-po-read-title { font-size: 12px; font-weight: 600; }
        .dswpl-po-read-row { display: flex; align-items: center; gap: 8px; }
        .dswpl-po-read-label { flex: none; width: 76px; font-size: 12px; color: var(--dsw-alias-label-secondary, #888); }
        .dswpl-po-read-row input[type="range"] { flex: 1; min-width: 0; accent-color: var(--dsw-alias-brand-primary, #3b5bdb); }
        .dswpl-po-read-val { flex: none; width: 40px; text-align: right; font-size: 11px; color: var(--dsw-alias-label-secondary, #888); }
        .dswpl-po-select {
          flex: 1; min-width: 0; height: 26px; box-sizing: border-box;
          background: var(--dsw-alias-bg-layer-2, rgba(255, 255, 255, 0.8));
          color: var(--dsw-alias-label-primary, #111);
          border: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.1));
          border-radius: 6px; font-family: inherit; font-size: 12px; padding: 0 6px;
        }
      `;

      const rootStyle = () => document.documentElement.style;
      const setVar = (name, value) => rootStyle().setProperty(name, value);
      setVar("--wp-cur", "none");
      setVar("--wp-cur-op", "1");
      setVar("--wp-next", "none");
      setVar("--wp-next-op", "0");
      setVar("--wp-dur", state.transitionMs + "ms");
      setVar("--wp-scrim", String(state.scrim / 100));
      setVar("--wp-bright", String(1 - state.scrim / 100));
      setVar("--dswpl-ts", TS[state.textShadow] || "none");
      setVar("--dswpl-blur", "blur(" + state.blurPx + "px)");

      // ================= 视频背景层（唯一，复用同一 <video>） =================
      const videoLayer = document.createElement("video");
      videoLayer.className = "dswpl-video-layer";
      videoLayer.setAttribute("autoplay", "");
      videoLayer.setAttribute("muted", "");
      videoLayer.setAttribute("loop", "");
      videoLayer.setAttribute("playsinline", "");
      videoLayer.setAttribute("aria-hidden", "true");
      document.documentElement.appendChild(videoLayer);

      function applyVideoState() {
        const muted = state.videoMuted;
        videoLayer.muted = muted;
        videoLayer.volume = Math.max(0, Math.min(1, state.videoVolume));
        if (muted && !videoLayer.hasAttribute("muted")) videoLayer.setAttribute("muted", "");
        if (!muted) videoLayer.removeAttribute("muted");
      }

      // ================= 主题覆盖：统一半透明基底 + 面板半透明 =================
      let disposeOverrides = null;
      function applyPanels() {
        if (disposeOverrides) { disposeOverrides(); disposeOverrides = null; }
        if (!state.enabled) {
          document.documentElement.removeAttribute("data-dswpl-glass");
          document.documentElement.removeAttribute("data-dswpl-fullscreen");
          rootStyle().removeProperty("--dswpl-glass-a");
          rootStyle().removeProperty("--dswpl-glass-sidebar-a");
          return;
        }
        document.documentElement.setAttribute("data-dswpl-glass", "");
        const a = Math.max(0, Math.min(1, state.panelAlpha / 100));
        const glass = Math.max(0, Math.min(1, state.baseAlpha / 100));
        const sidebarGlass = Math.max(0, Math.min(1, (state.baseAlpha + 3) / 100));
        const light = "rgba(255,255,255," + a + ")";
        const dark = "rgba(28,30,38," + a + ")";
        // 对话区透明度 = 主壁纸透明度（--dswpl-glass-a = baseAlpha），
        // 布局列背景由私有 CSS 承担。
        setVar("--dswpl-glass-a", String(glass));
        // 侧边栏透明度 = 主壁纸透明度 + 3%（--dswpl-glass-sidebar-a）。
        setVar("--dswpl-glass-sidebar-a", String(sidebarGlass));
        // 全屏模式：侧边栏完全透明，壁纸完整透出（html 属性驱动 CSS）
        document.documentElement.toggleAttribute("data-dswpl-fullscreen", state.fullscreen);
        // bg-base 覆盖为透明：布局 frame 与对话区根都透出壁纸，半透明背景由列 CSS 承载；
        // 卡片层 bg-layer-1/2 保持 panelAlpha 半透明以保证可读性。
        disposeOverrides = ctx.theme.overrideTokens("wallpaper-local", {
          "--dsw-alias-bg-base": { light: "transparent", dark: "transparent" },
          "--dsw-specific-sidebar-fill": { light: "transparent", dark: "transparent" },
          "--dsw-alias-bg-layer-1": { light, dark },
          "--dsw-alias-bg-layer-2": { light, dark }
        });
      }

      // ================= 壁纸应用 =================
      const layerOf = (layer) => layer === "next"
        ? { image: "--wp-next", opacity: "--wp-next-op" }
        : { image: "--wp-cur", opacity: "--wp-cur-op" };
      const setLayerImage = (layer, value) => setVar(layerOf(layer).image, value);
      const setLayerOpacity = (layer, value) => setVar(layerOf(layer).opacity, String(value));

      let currentUrl = null;
      let currentKind = null;
      let fadeToken = 0;
      let videoPlayToken = 0;

      function preload(url) {
        return new Promise((resolve) => {
          let done = false;
          const finish = () => { if (!done) { done = true; resolve(); } };
          try {
            const img = new Image();
            img.onload = finish;
            img.onerror = finish;
            img.src = url;
          } catch {
            finish();
          }
          ctx.timeout(finish, 10000);
        });
      }

      function hideVideo() {
        videoPlayToken += 1;
        videoLayer.classList.remove("dswpl-active");
        videoLayer.pause();
        videoLayer.removeAttribute("src");
        videoLayer.load();
      }

      function showVideo(url) {
        const token = ++videoPlayToken;
        // 同一个视频且仍在播放：不重置，直接保证可见
        if (videoLayer.getAttribute("src") === url && !videoLayer.paused) {
          videoLayer.classList.add("dswpl-active");
          return;
        }
        videoLayer.setAttribute("src", url);
        videoLayer.load();
        const play = () => {
          if (token !== videoPlayToken) return;
          videoLayer.classList.add("dswpl-active");
          const p = videoLayer.play();
          if (p && typeof p.catch === "function") p.catch(() => {});
        };
        videoLayer.play().then(play).catch(() => {
          // autoplay 被拦截时，静音兜底再试一次。
          videoLayer.muted = true;
          videoLayer.play().then(play).catch(() => {});
        });
      }

      async function applyWallpaper(entry, fadeIn) {
        const url = entry ? entry.url : null;
        const kind = entry ? entry.kind : null;
        const token = ++fadeToken;
        if (url === null) {
          hideVideo();
          setLayerImage("cur", "none");
          setLayerOpacity("cur", 0);
          setLayerImage("next", "none");
          setLayerOpacity("next", 0);
          currentUrl = null;
          currentKind = null;
          return;
        }
        // 当前已显示同一壁纸：幂等，不重置播放（修复展开/刷新导致的闪屏与重播）
        if (url === currentUrl && kind === currentKind) return;
        if (kind === "video") {
          // 图片层淡出，视频层淡入。
          hideVideo();
          setLayerImage("next", "none");
          setLayerOpacity("next", 0);
          setLayerOpacity("cur", 0);
          currentUrl = url;
          currentKind = kind;
          applyVideoState();
          showVideo(url);
          return;
        }
        // 图片：交叉淡化。
        await preload(url);
        if (token !== fadeToken) return;
        const quoted = 'url("' + url + '")';
        if (currentUrl === null || fadeIn || currentKind === "video") {
          hideVideo();
          setLayerImage("cur", quoted);
          setLayerOpacity("cur", 0);
          setLayerImage("next", "none");
          setLayerOpacity("next", 0);
          void document.documentElement.offsetHeight;
          setLayerOpacity("cur", 1);
          currentUrl = url;
          currentKind = "image";
          return;
        }
        setLayerImage("next", quoted);
        setLayerOpacity("next", 0);
        void document.documentElement.offsetHeight;
        setLayerOpacity("next", 1);
        currentUrl = url;
        currentKind = "image";
        ctx.timeout(() => {
          if (token !== fadeToken) return;
          setLayerImage("cur", quoted);
          setLayerOpacity("next", 0);
          ctx.timeout(() => {
            if (token !== fadeToken) return;
            setLayerImage("next", "none");
          }, state.transitionMs + 60);
        }, state.transitionMs + 80);
      }

      // ================= 数据通路 =================
      async function fetchJson(url, options) {
        const res = await fetch(url, options);
        const text = await res.text();
        try {
          return JSON.parse(text);
        } catch {
          return null;
        }
      }

      // ================= 扫描（空/无效/无图时回退内置壁纸集） =================
      function useBuiltin() {
        const wanted = state.savedName ? BUILTIN_IMAGES.find((f) => f.name === state.savedName) : null;
        const first = wanted || BUILTIN_IMAGES[0];
        store.set({ files: BUILTIN_IMAGES, current: first });
        applyWallpaper(first, true);
      }

      async function scan(folder) {
        const raw = (folder || "").trim();
        if (!raw) {
          store.set({ scanning: false, error: null });
          useBuiltin();
          return;
        }
        store.set({ scanning: true, error: null });
        try {
          const res = await fetchJson(API + "/list?folder=" + encodeURIComponent(raw));
          if (!res || !res.ok) {
            store.set({ scanning: false, error: (res && res.error) || "扫描失败" });
            useBuiltin();
            return;
          }
          const files = Array.isArray(res.files) ? res.files : [];
          if (files.length === 0) {
            store.set({ scanning: false, error: null });
            useBuiltin();
            return;
          }
          const wanted = state.savedName ? files.find((f) => f.name === state.savedName) : null;
          const first = wanted || files[0];
          const same = state.current !== null && state.current.name === first.name;
          store.set({ scanning: false, files, current: first, error: null });
          // 当前壁纸未变：只更新列表，不重新应用（避免视频重置/闪屏）
          if (!same) applyWallpaper(first, true);
        } catch (err) {
          store.set({ scanning: false, error: String((err && err.message) || err) });
          useBuiltin();
        }
      }

      // ================= 配置：内存态 + 持久化（防抖写回） =================
      const saveConfig = ctx.debounce(async () => {
        const cfg = {
          folder: state.folder,
          transitionMs: state.transitionMs,
          enabled: state.enabled,
          fullscreen: state.fullscreen,
          current: state.savedName || "",
          panelAlpha: state.panelAlpha,
          baseAlpha: state.baseAlpha,
          scrim: state.scrim,
          blurPx: state.blurPx,
          textShadow: state.textShadow,
          videoMuted: state.videoMuted,
          videoVolume: state.videoVolume
        };
        try {
          await fetchJson(API + "/config", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(cfg)
          });
        } catch (error) {
          /* 写入失败不阻断本地生效 */
        }
      }, 400);

      function applyConfig(patch) {
        const prev = state;
        store.set(patch);
        const next = state;
        setVar("--wp-dur", next.transitionMs + "ms");
        if (next.enabled !== prev.enabled) {
          if (next.enabled) {
            applyPanels();
            if (next.current) applyWallpaper(next.current, true);
          } else {
            applyPanels();
            applyWallpaper(null, false);
          }
          setVar("--wp-scrim", next.enabled ? String(Math.max(0, Math.min(0.9, next.scrim / 100))) : "0");
          setVar("--wp-bright", next.enabled ? String(Math.max(0.1, 1 - next.scrim / 100)) : "1");
          setVar("--dswpl-ts", next.enabled ? (TS[next.textShadow] || "none") : "none");
          setVar("--dswpl-blur", next.enabled ? "blur(" + next.blurPx + "px)" : "blur(0px)");
        } else {
          if (next.panelAlpha !== prev.panelAlpha || next.baseAlpha !== prev.baseAlpha) applyPanels();
          if (next.fullscreen !== prev.fullscreen) applyPanels();
          if (next.scrim !== prev.scrim) setVar("--wp-scrim", String(Math.max(0, Math.min(0.9, next.scrim / 100))));
          if (next.scrim !== prev.scrim) setVar("--wp-bright", String(Math.max(0.1, 1 - next.scrim / 100)));
          if (next.textShadow !== prev.textShadow) setVar("--dswpl-ts", TS[next.textShadow] || "none");
          if (next.blurPx !== prev.blurPx) setVar("--dswpl-blur", "blur(" + next.blurPx + "px)");
        }
        if (next.videoMuted !== prev.videoMuted || next.videoVolume !== prev.videoVolume) applyVideoState();
        if (next.folder !== prev.folder) {
          scan(next.folder);
        }
        saveConfig();
      }

      // ================= 壁纸控制胶囊 + 弹出面板 =================
      // 胶囊：显示当前壁纸名 + ▾，点击展开小面板（开关 + 壁纸列表）。
      // 面板和胶囊都挂 document.body，以继承 DSH 主题变量（html 上没有变量）。
      const quickBtn = document.createElement("button");
      quickBtn.type = "button";
      quickBtn.className = "dswpl-quick-toggle";
      quickBtn.setAttribute("aria-label", "壁纸快捷操作");
      document.body.appendChild(quickBtn);

      // 独立电源开关：一键开/关壁纸
      const powerBtn = document.createElement("button");
      powerBtn.type = "button";
      powerBtn.className = "dswpl-power-btn";
      powerBtn.textContent = "⏻";
      powerBtn.setAttribute("aria-label", "开启或关闭壁纸");
      document.body.appendChild(powerBtn);

      const popover = document.createElement("div");
      popover.className = "dswpl-popover";
      popover.hidden = true;
      document.body.appendChild(popover);

      function shortName(name) {
        const base = String(name || "").replace(/\.(mp4|webm|mov|m4v|ogv|png|jpe?g|webp|gif|bmp|avif|svg)$/i, "");
        return base.length > 10 ? base.slice(0, 10) + "…" : base;
      }

      function closePopover() {
        popover.hidden = true;
        quickBtn.classList.remove("dswpl-open");
      }
      function togglePopover() {
        const willOpen = popover.hidden;
        popover.hidden = !willOpen;
        quickBtn.classList.toggle("dswpl-open", willOpen);
        if (willOpen) {
          renderPopover();
          // 展开时自动重新扫描，新下载的壁纸立即出现
          if (store.get().folder) scan(store.get().folder);
        }
      }

      function renderPopover() {
        popover.replaceChildren();
        const s = store.get();

        // 头部：状态 + 刷新（开关由右下角独立电源按钮负责）
        const header = document.createElement("div");
        header.className = "dswpl-po-header";
        const title = document.createElement("span");
        title.className = "dswpl-po-title";
        title.textContent = s.scanning ? "正在扫描…" : (s.enabled ? "壁纸已开启" : "壁纸已关闭");
        header.appendChild(title);
        const refreshBtn = document.createElement("button");
        refreshBtn.type = "button";
        refreshBtn.className = "dswpl-po-refresh";
        refreshBtn.textContent = "⟳";
        refreshBtn.title = "重新读取壁纸文件夹";
        refreshBtn.setAttribute("aria-label", "刷新壁纸列表");
        refreshBtn.addEventListener("click", () => scan(store.get().folder));
        header.appendChild(refreshBtn);
        popover.appendChild(header);

        // 壁纸列表：点击切换并自动开启
        const list = document.createElement("div");
        list.className = "dswpl-po-list";
        for (const f of s.files || []) {
          const active = s.current && s.current.name === f.name;
          const item = document.createElement("button");
          item.type = "button";
          item.className = "dswpl-po-item" + (active ? " dswpl-active" : "");
          item.title = f.name;
          const dot = document.createElement("span");
          dot.className = "dswpl-po-dot";
          dot.textContent = active ? "●" : "○";
          const nm = document.createElement("span");
          nm.className = "dswpl-po-name";
          nm.textContent = f.name;
          item.append(dot, nm);
          item.addEventListener("click", () => {
            if (!store.get().enabled) applyConfig({ enabled: true });
            selectEntry(f);
            closePopover();
          });
          list.appendChild(item);
        }
        popover.appendChild(list);

        // 背景与可读性：快速调节（即时应用并持久化）
        const read = document.createElement("div");
        read.className = "dswpl-po-read";
        const readTitle = document.createElement("div");
        readTitle.className = "dswpl-po-read-title";
        readTitle.textContent = "背景与可读性";
        read.appendChild(readTitle);
        const mkRow = (label, ctrl, valText) => {
          const row = document.createElement("div");
          row.className = "dswpl-po-read-row";
          const lb = document.createElement("span");
          lb.className = "dswpl-po-read-label";
          lb.textContent = label;
          row.appendChild(lb);
          row.appendChild(ctrl);
          const v = document.createElement("span");
          v.className = "dswpl-po-read-val";
          v.textContent = valText;
          row.appendChild(v);
          return row;
        };
        const mkRange = (min, max, step, value, apply) => {
          const r = document.createElement("input");
          r.type = "range";
          r.min = min; r.max = max; r.step = step; r.value = value;
          r.addEventListener("change", () => apply(Number(r.value)));
          return r;
        };
        read.appendChild(mkRow("背景不透明度", mkRange(0, 100, 5, s.baseAlpha, (v) => applyConfig({ baseAlpha: v })), s.baseAlpha + "%"));
        read.appendChild(mkRow("壁纸压暗", mkRange(0, 90, 5, s.scrim, (v) => applyConfig({ scrim: v })), s.scrim + "%"));
        read.appendChild(mkRow("毛玻璃模糊", mkRange(0, 24, 1, s.blurPx, (v) => applyConfig({ blurPx: v })), (s.blurPx === 0 ? "关" : s.blurPx + "px")));
        const tsSel = document.createElement("select");
        tsSel.className = "dswpl-po-select";
        for (const [val, txt] of [["0", "关闭"], ["1", "轻微"], ["2", "明显"]]) {
          const o = document.createElement("option");
          o.value = val; o.textContent = txt;
          if (String(s.textShadow) === val) o.selected = true;
          tsSel.appendChild(o);
        }
        tsSel.addEventListener("change", () => applyConfig({ textShadow: Number(tsSel.value) }));
        read.appendChild(mkRow("文字阴影", tsSel, ""));
        // 全屏开关：侧边栏是否透出壁纸（即时应用并持久化）
        const fsWrap = document.createElement("label");
        fsWrap.className = "dswpl-po-read-row";
        fsWrap.style.cssText = "display:flex;align-items:center;gap:8px;cursor:pointer;";
        const fsLb = document.createElement("span");
        fsLb.className = "dswpl-po-read-label";
        fsLb.textContent = "侧边栏透出";
        const fsSwitch = document.createElement("input");
        fsSwitch.type = "checkbox";
        fsSwitch.checked = Boolean(s.fullscreen);
        fsSwitch.style.cssText = "accent-color:var(--dsw-alias-brand-primary,#3b5bdb);flex:none;";
        fsSwitch.addEventListener("change", () => applyConfig({ fullscreen: fsSwitch.checked }));
        const fsVal = document.createElement("span");
        fsVal.className = "dswpl-po-read-val";
        fsVal.style.cssText = "width:40px;text-align:right;font-size:11px;color:var(--dsw-alias-label-secondary,#888);";
        fsVal.textContent = s.fullscreen ? "开" : "关";
        fsWrap.append(fsLb, fsSwitch, fsVal);
        read.appendChild(fsWrap);
        popover.appendChild(read);

        // 底部提示
        const foot = document.createElement("div");
        foot.className = "dswpl-po-foot";
        foot.textContent = "高级设置见「设置 → 本地壁纸」";
        popover.appendChild(foot);
      }

      function renderQuick() {
        const s = store.get();
        const cur = s.current ? s.current.name : "";
        // 独立电源按钮状态
        powerBtn.classList.toggle("dswpl-on", s.enabled);
        powerBtn.classList.toggle("dswpl-off", !s.enabled);
        powerBtn.title = s.enabled ? "点击关闭壁纸" : "点击开启壁纸";
        if (!s.enabled) {
          quickBtn.textContent = "壁纸已关 ▾";
          quickBtn.classList.add("dswpl-off");
          quickBtn.title = "点击展开壁纸操作";
        } else {
          quickBtn.textContent = "🖼 " + shortName(cur || "内置壁纸") + " ▾";
          quickBtn.classList.remove("dswpl-off");
          quickBtn.title = "点击展开壁纸操作";
        }
        if (!popover.hidden) renderPopover();
      }

      powerBtn.addEventListener("click", () => {
        applyConfig({ enabled: !store.get().enabled });
      });
      quickBtn.addEventListener("click", togglePopover);
      document.addEventListener("click", (e) => {
        if (popover.hidden) return;
        // 目标被重渲染移除（如点击刷新/滑杆触发面板重建）时不当作“点外部”
        if (!e.target || !e.target.isConnected) return;
        if (popover.contains(e.target) || quickBtn.contains(e.target) || powerBtn.contains(e.target)) return;
        closePopover();
      });
      document.addEventListener("keydown", (e) => { if (e.key === "Escape") closePopover(); });
      store.subscribe(renderQuick);
      renderQuick();

      // ================= 手动选择壁纸：立即应用并持久化 =================
      function selectEntry(entry) {
        if (!entry) return;
        store.set({ current: entry, savedName: entry.name });
        applyWallpaper(entry, true);
        saveConfig();
      }

      // ================= 启动：加载持久化配置后开始 =================
      applyPanels();
      (async () => {
        try {
          const res = await fetchJson(API + "/config");
          if (res && res.ok && res.config && typeof res.config === "object") {
            store.set(Object.assign({}, res.config, { savedName: res.config.current || "" }));
            applyPanels();
            setVar("--wp-dur", state.transitionMs + "ms");
            setVar("--wp-scrim", String(Math.max(0, Math.min(0.9, state.scrim / 100))));
            setVar("--wp-bright", String(Math.max(0.1, 1 - state.scrim / 100)));
            setVar("--dswpl-ts", TS[state.textShadow] || "none");
            setVar("--dswpl-blur", "blur(" + state.blurPx + "px)");
            applyVideoState();
          }
        } catch (error) {
          /* 配置读取失败时使用默认值 */
        }
        scan(state.folder);
      })();

      // ================= 设置页 UI =================
      function SettingsView() {
        const [snap, setSnap] = React.useState(store.get());
        const [draft, setDraft] = React.useState(snap.folder);
        React.useEffect(() => store.subscribe(setSnap), []);
        React.useEffect(() => { setDraft(snap.folder); }, [snap.folder]);

        const [tr, setTr] = React.useState(Math.round(snap.transitionMs / 100) / 10);

        function commitTransition(sec) {
          const ms = Math.min(10000, Math.max(0, Math.round(Number(sec) * 1000)));
          applyConfig({ transitionMs: ms });
        }
        function commitFolder() { applyConfig({ folder: draft }); }
        async function pickFolder() {
          const ws = ctx.get("workspaces");
          if (!ws || typeof ws.pickDirectory !== "function") {
            store.set({ error: "当前环境不支持系统文件夹选择，请手动输入路径" });
            return;
          }
          try {
            const picked = await ws.pickDirectory();
            if (picked) { setDraft(picked); applyConfig({ folder: picked }); }
          } catch (err) {
            store.set({ error: String((err && err.message) || err) });
          }
        }

        const filesInfo = snap.scanning
          ? h("span", { className: "dswpl-hint" }, "正在扫描…")
          : snap.error
            ? h("span", { className: "dswpl-error" }, snap.error)
            : snap.folder === ""
              ? h("span", { className: "dswpl-hint" }, "未配置文件夹，使用内置壁纸集（" + snap.files.length + " 张）")
              : snap.files.length === 0
                ? h("span", { className: "dswpl-hint" }, "文件夹中没有找到图片或视频（已回退到内置壁纸集）")
                : h("span", { className: "dswpl-ok" }, "共 " + snap.files.length + " 个媒体文件（图片 + 视频）");

        const preview = snap.current && snap.current.kind === "video"
          ? h("video", { className: "dswpl-preview", src: snap.current.url, muted: true, autoPlay: true, loop: true, playsInline: true })
          : snap.current
            ? h("img", { className: "dswpl-preview", src: snap.current.url, alt: snap.current.name })
            : null;

        return h("div", { className: "dswpl-page" }, [
          h("div", { className: "dswpl-card" }, [
            h("div", { className: "dswpl-row" }, [
              h("div", { className: "dswpl-grow" }, [
                h("div", { className: "dswpl-title" }, "本地壁纸"),
                h("div", { className: "dswpl-hint" }, "用本地图片 / 视频做应用背景，无需 Wallpaper Engine；未配置时使用内置渐变壁纸")
              ]),
              h("label", { className: "dswpl-switch" }, [
                h("input", {
                  type: "checkbox",
                  checked: snap.enabled,
                  "aria-label": "启用本地壁纸",
                  onChange: (e) => applyConfig({ enabled: e.target.checked })
                }),
                h("span", { className: "dswpl-track" }),
                h("span", { className: "dswpl-thumb" })
              ])
            ])
          ]),
          h("div", { className: "dswpl-card" }, [
            h("div", { className: "dswpl-title" }, "媒体文件夹"),
            h("div", { className: "dswpl-row" }, [
              h("input", {
                className: "dswpl-input dswpl-grow",
                value: draft,
                placeholder: "留空使用内置壁纸集",
                spellCheck: false,
                onChange: (e) => setDraft(e.target.value),
                onKeyDown: (e) => { if (e.key === "Enter") commitFolder(); }
              }),
              h("button", { className: "dswpl-btn", onClick: pickFolder }, "浏览…"),
              h("button", { className: "dswpl-btn dswpl-btn-primary", onClick: commitFolder }, "应用")
            ]),
            h("div", { className: "dswpl-row" }, filesInfo),
            h("div", { className: "dswpl-hint" }, "支持格式：图片 png / jpg / webp / gif / bmp / avif / svg；视频 mp4 / webm / mov / m4v / ogv。视频会作为背景循环播放。")
          ]),
          h("div", { className: "dswpl-card" }, [
            h("div", { className: "dswpl-title" }, "选择壁纸"),
            ...(snap.files || []).map((f) =>
              h("div", {
                className: "dswpl-row dswpl-file-row" + (snap.current && snap.current.name === f.name ? " dswpl-active" : ""),
                key: f.name
              }, [
                h("div", { className: "dswpl-grow" }, [
                  h("div", { className: "dswpl-name" }, f.name),
                  h("div", { className: "dswpl-hint" }, f.kind === "video" ? "视频" : "图片")
                ]),
                h("button", {
                  className: "dswpl-btn" + (snap.current && snap.current.name === f.name ? " dswpl-btn-primary" : ""),
                  onClick: () => selectEntry(f)
                }, snap.current && snap.current.name === f.name ? "当前" : "设为背景")
              ])
            ),
            h("div", { className: "dswpl-hint" }, "点击「设为背景」立即切换并保存；刷新后保持该选择。")
          ]),
          h("div", { className: "dswpl-card" }, [
            h("div", { className: "dswpl-title" }, "全屏显示"),
            h("div", { className: "dswpl-row" }, [
              h("span", { className: "dswpl-label" }, "侧边栏透出壁纸"),
              h("label", { className: "dswpl-switch" }, [
                h("input", {
                  type: "checkbox",
                  checked: snap.fullscreen,
                  "aria-label": "侧边栏显示壁纸",
                  onChange: (e) => applyConfig({ fullscreen: e.target.checked })
                }),
                h("span", { className: "dswpl-track" }),
                h("span", { className: "dswpl-thumb" })
              ])
            ]),
            h("div", { className: "dswpl-hint" }, "开启：侧边栏完全透明，壁纸完整透出（纯全屏壁纸）；关闭：侧边栏与对话区同为统一的半透明背景，壁纸透出但保持可读性。")
          ]),
          h("div", { className: "dswpl-card" }, [
            h("div", { className: "dswpl-title" }, "切换效果"),
            h("div", { className: "dswpl-row" }, [
              h("span", { className: "dswpl-label" }, "过渡时长"),
              h("input", {
                className: "dswpl-input dswpl-num",
                type: "number", min: 0, max: 10, step: 0.1,
                value: tr,
                onChange: (e) => { const v = e.target.value; setTr(v); commitTransition(v); }
              }),
              h("span", { className: "dswpl-hint" }, "秒（切换壁纸时的交叉淡化动效）")
            ]),
            h("div", { className: "dswpl-hint" }, "壁纸不会自动轮换，请在「选择壁纸」里手动切换。")
          ]),
          h("div", { className: "dswpl-card" }, [
            h("div", { className: "dswpl-title" }, "视频声音"),
            h("div", { className: "dswpl-row" }, [
              h("span", { className: "dswpl-label" }, "静音播放"),
              h("label", { className: "dswpl-switch" }, [
                h("input", {
                  type: "checkbox",
                  checked: snap.videoMuted,
                  "aria-label": "视频静音",
                  onChange: (e) => applyConfig({ videoMuted: e.target.checked })
                }),
                h("span", { className: "dswpl-track" }),
                h("span", { className: "dswpl-thumb" })
              ])
            ]),
            h("div", { className: "dswpl-row" }, [
              h("span", { className: "dswpl-label" }, "音量"),
              h("input", {
                className: "dswpl-slider",
                type: "range", min: 0, max: 100, step: 5,
                value: Math.round(snap.videoVolume * 100),
                onChange: (e) => applyConfig({ videoVolume: Number(e.target.value) / 100 })
              }),
              h("span", { className: "dswpl-hint dswpl-num" }, Math.round(snap.videoVolume * 100) + "%")
            ]),
            h("div", { className: "dswpl-hint" }, "注意：浏览器通常拦截带声音的背景视频自动播放，建议保持静音以获得稳定背景。")
          ]),
          h("div", { className: "dswpl-card" }, [
            h("div", { className: "dswpl-title" }, "背景与可读性"),
            h("div", { className: "dswpl-row" }, [
              h("span", { className: "dswpl-label" }, "背景不透明度"),
              h("input", {
                className: "dswpl-slider",
                type: "range", min: 0, max: 100, step: 5,
                value: snap.baseAlpha,
                onChange: (e) => applyConfig({ baseAlpha: Number(e.target.value) })
              }),
              h("span", { className: "dswpl-hint dswpl-num" }, snap.baseAlpha + "%")
            ]),
            h("div", { className: "dswpl-row" }, [
              h("span", { className: "dswpl-label" }, "壁纸压暗"),
              h("input", {
                className: "dswpl-slider",
                type: "range", min: 0, max: 90, step: 5,
                value: snap.scrim,
                onChange: (e) => applyConfig({ scrim: Number(e.target.value) })
              }),
              h("span", { className: "dswpl-hint dswpl-num" }, snap.scrim + "%")
            ]),
            h("div", { className: "dswpl-row" }, [
              h("span", { className: "dswpl-label" }, "毛玻璃模糊"),
              h("input", {
                className: "dswpl-slider",
                type: "range", min: 0, max: 24, step: 1,
                value: snap.blurPx,
                onChange: (e) => applyConfig({ blurPx: Number(e.target.value) })
              }),
              h("span", { className: "dswpl-hint dswpl-num" }, snap.blurPx === 0 ? "关闭" : snap.blurPx + "px")
            ]),
            h("div", { className: "dswpl-row" }, [
              h("span", { className: "dswpl-label" }, "文字阴影"),
              h("select", {
                className: "dswpl-select",
                value: snap.textShadow,
                onChange: (e) => applyConfig({ textShadow: Number(e.target.value) })
              }, [
                h("option", { value: 0 }, "关闭"),
                h("option", { value: 1 }, "轻微"),
                h("option", { value: 2 }, "明显")
              ])
            ]),
            h("div", { className: "dswpl-hint" }, "背景不透明度统一控制侧边栏与对话区的半透明深浅（值越低壁纸越透出）；压暗随壁纸层内嵌，毛玻璃柔化壁纸，文字阴影提升对比度。")
          ]),
          h("div", { className: "dswpl-card" }, [
            h("div", { className: "dswpl-title" }, "当前背景"),
            snap.current
              ? h("div", { className: "dswpl-row" }, [
                  preview,
                  h("div", { className: "dswpl-meta" }, [
                    h("div", { className: "dswpl-name" }, snap.current.name),
                    h("div", { className: "dswpl-hint" }, snap.current.kind === "video" ? "视频" : "图片"),
                    h("div", { className: "dswpl-row" }, [
                      h("button", { className: "dswpl-btn", onClick: () => scan(snap.folder) }, "重新扫描")
                    ])
                  ])
                ])
              : h("div", { className: "dswpl-hint" }, "配置媒体文件夹后，背景将自动显示")
          ]),
          h("div", { className: "dswpl-hint" }, "配置持久化到 $DSH_HOME/wallpaper-local.json，重启后保留。")
        ]);
      }

      ctx.effect(() => ctx.slots.inject("settings.section", () => ctx.slots.register(
        { name: "settings.section", id: "wallpaper-local", order: 25, label: "本地壁纸" },
        () => h("div", { className: "dswpl-page" }, h(SettingsView))
      )), "wallpaper-local: settings section");

      // ================= 卸载清理 =================
      ctx.effect(() => () => {
        styleEl.remove();
        videoLayer.remove();
        quickBtn.remove();
        powerBtn.remove();
        popover.remove();
        document.documentElement.removeAttribute("data-dswpl-glass");
        document.documentElement.removeAttribute("data-dswpl-fullscreen");
        for (const v of ["--wp-cur", "--wp-cur-op", "--wp-next", "--wp-next-op", "--wp-dur", "--wp-scrim", "--wp-bright", "--dswpl-ts", "--dswpl-blur", "--dswpl-glass-a", "--dswpl-glass-sidebar-a"]) {
          rootStyle().removeProperty(v);
        }
      }, "wallpaper-local: styles");
    }

    exports.name = name;
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  }
});
