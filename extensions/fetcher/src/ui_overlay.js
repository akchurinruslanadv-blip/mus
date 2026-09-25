// extensions/fetcher/src/ui_overlay.js: Non-intrusive UI Extension for musik
(function () {
  console.log("[musik-addon] Initializing UI Overlay...");

  const API_BASE = "";

  function toast(msg) {
    const t = document.getElementById("toast");
    if (!t) {
      alert(msg);
      return;
    }
    t.textContent = msg;
    t.hidden = false;
    setTimeout(() => { t.hidden = true; }, 3500);
  }

  function escapeHtml(str) {
    if (!str) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  // ==========================================
  // Reusable Parameter Slider Component Class
  // ==========================================
  class CustomAudioSlider {
    constructor({ id, label, icon, min = 0, max = 100, step = 5, defaultValue = 50, formatFn, onChange }) {
      this.id = id;
      this.label = label;
      this.icon = icon || "";
      this.min = min;
      this.max = max;
      this.step = step;
      const saved = localStorage.getItem(`slider_${id}`);
      this.value = saved !== null ? parseFloat(saved) : defaultValue;
      this.formatFn = formatFn || ((v) => `${v}%`);
      this.onChange = onChange || (() => {});
      this.el = null;
    }

    render() {
      if (document.getElementById(`wrap-${this.id}`)) {
        return document.getElementById(`wrap-${this.id}`);
      }

      const wrapper = document.createElement("div");
      wrapper.className = "custom-audio-slider-wrap";
      wrapper.id = `wrap-${this.id}`;
      wrapper.style.cssText = "background: rgba(0,0,0,0.32); border: 1px solid rgba(224,122,58,0.25); border-radius: 12px; padding: 8px 12px; margin: 8px 0;";

      wrapper.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
          <span style="font-size: 0.82rem; font-weight: 600; color: var(--fg, #f7f0e8); display: flex; align-items: center; gap: 6px;">
            ${this.icon ? `<span>${this.icon}</span>` : ""} ${this.label}
          </span>
          <span id="val-${this.id}" style="font-size: 0.75rem; font-weight: 700; color: #e07a3a; background: rgba(224,122,58,0.15); border: 1px solid rgba(224,122,58,0.3); padding: 2px 8px; border-radius: 99px;">
            ${this.formatFn(this.value)}
          </span>
        </div>
        <div style="position: relative; display: flex; align-items: center;">
          <input type="range" id="${this.id}" min="${this.min}" max="${this.max}" step="${this.step}" value="${this.value}" 
                 style="width: 100%; height: 6px; border-radius: 3px; accent-color: #e07a3a; cursor: pointer; outline: none; background: rgba(255,255,255,0.15);" />
        </div>
      `;

      const input = wrapper.querySelector(`#${this.id}`);
      const valBadge = wrapper.querySelector(`#val-${this.id}`);

      input.oninput = (e) => {
        const val = parseFloat(e.target.value);
        this.value = val;
        localStorage.setItem(`slider_${this.id}`, String(val));
        if (valBadge) valBadge.textContent = this.formatFn(val);
        this.onChange(val);
      };

      this.el = wrapper;
      return wrapper;
    }

    setValue(val) {
      this.value = val;
      localStorage.setItem(`slider_${this.id}`, String(val));
      if (this.el) {
        const input = this.el.querySelector(`#${this.id}`);
        const valBadge = this.el.querySelector(`#val-${this.id}`);
        if (input) input.value = String(val);
        if (valBadge) valBadge.textContent = this.formatFn(val);
      }
      this.onChange(val);
    }

    getValue() {
      return this.value;
    }
  }
  if (typeof window !== "undefined") window.CustomAudioSlider = CustomAudioSlider;

  let sliderDebounceTimer = null;
  const getDeviceId = () => {
    try {
      let id = localStorage.getItem("musik_device_id");
      if (!id) {
        id = "dev_" + Math.random().toString(36).slice(2, 10);
        localStorage.setItem("musik_device_id", id);
      }
      return id;
    } catch {
      return "default";
    }
  };

  // Active Radio Discovery Balance Slider
  const discoveryBalanceSlider = new CustomAudioSlider({
    id: "slider-discovery-balance",
    label: "Баланс открытий (радио)",
    icon: "🎛️",
    min: 0,
    max: 100,
    step: 5,
    defaultValue: 50,
    formatFn: (v) => {
      if (v === 0) return "❤️ Только любимое (0%)";
      if (v <= 35) return `❤️ Больше любимого (${100 - v}%)`;
      if (v >= 40 && v <= 60) return `⚖️ Баланс 50 / 50`;
      if (v < 100) return `🚀 Больше открытий (${v}%)`;
      return "🚀 Только новые треки (100%)";
    },
    onChange: () => syncAcousticBiases()
  });

  // Acoustic Vector Biases Sliders (12D Vector Steering)
  let biasesDebounceTimer = null;

  async function playTrackNow(trackId) {
    if (!trackId) return;
    toast("Запуск трека...");
    if (typeof window.jumpTo === "function" && window.sessionId) {
      try {
        await window.jumpTo(trackId);
        return;
      } catch {}
    }
    if (typeof window.playFixed === "function") {
      try {
        await window.playFixed({ track_id: trackId });
        return;
      } catch {}
    }
    try {
      const res = await fetch(`${API_BASE}/api/play`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ track_id: trackId })
      });
      const data = await res.json();
      if (typeof window.applyPlayPayload === "function") {
        window.applyPlayPayload(data);
      }
    } catch (e) {
      toast("Ошибка воспроизведения: " + String(e));
    }
  }

  function syncAcousticBiases() {
    clearTimeout(biasesDebounceTimer);
    biasesDebounceTimer = setTimeout(async () => {
      try {
        const biases = {
          energy: energyBiasSlider.getValue() / 100,
          valence: valenceBiasSlider.getValue() / 100,
          acousticness: acousticBiasSlider.getValue() / 100,
          tempo: tempoBiasSlider.getValue() / 100
        };
        const discRatio = discoveryBalanceSlider.getValue() / 100;
        const res = await fetch(`${API_BASE}/api/v1/radio/settings`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ 
            biases, 
            discoveryRatio: discRatio,
            sessionId: getDeviceId() 
          })
        });
        const data = await res.json();
        if (data && Array.isArray(data.queue) && data.queue.length > 0) {
          const ol = document.getElementById("queue");

          // DOM diffing: only rebuild if track IDs actually changed to avoid strobe
          const newIds = data.queue.map(q => String(q.track_id || "")).join(",");
          const oldIds = ol ? Array.from(ol.querySelectorAll("li")).map(li => li.dataset.trackId || "").join(",") : "";
          const queueChanged = newIds !== oldIds;

          if (queueChanged) {
            if (typeof window.renderQueue === "function") {
              window.renderQueue(data.queue);
            }
            if (ol) {
              ol.innerHTML = "";
              data.queue.forEach((q) => {
                const li = document.createElement("li");
                if (q.track_id) {
                  li.dataset.trackId = String(q.track_id);
                  li.style.cursor = "pointer";
                  li.title = "▶ Нажмите, чтобы включить прямо сейчас";
                  li.onclick = () => playTrackNow(q.track_id);
                }
                const tags = [];
                if (q.explore) tags.push('<span class="tag">far</span>');
                if (q.new_boost) tags.push('<span class="tag">new</span>');
                li.innerHTML = `<strong>${escapeHtml(q.artist || "")}</strong> — ${escapeHtml(q.title || "")}${tags.join("")}<span class="why">${escapeHtml(q.explanation || "")}</span>`;
                ol.appendChild(li);
              });
              const qCount = document.getElementById("queue-count");
              if (qCount) qCount.textContent = String(data.queue.length);
              const addonQCnt = document.getElementById("addon-queue-cnt");
              if (addonQCnt) addonQCnt.textContent = String(data.queue.length);
              // Kick badge update only after actual DOM rebuild
              setTimeout(updateQueueOrigins, 60);
            }
          }
        }
        
        // Update summary badge
        const badge = document.getElementById("eq-summary-badge");
        if (badge) {
          const nonZero = [];
          if (discRatio === 0) nonZero.push("❤️ Любимое 100%");
          else if (discRatio === 1) nonZero.push("🚀 Новое 100%");
          else if (discRatio !== 0.5) nonZero.push(`⚖️ ${Math.round(discRatio * 100)}% открытий`);

          if (biases.energy !== 0) nonZero.push(biases.energy > 0 ? "⚡ Драйв" : "🌙 Чилл");
          if (biases.valence !== 0) nonZero.push(biases.valence > 0 ? "☀️ Позитив" : "🌧️ Грусть");
          if (biases.acousticness !== 0) nonZero.push(biases.acousticness > 0 ? "🎸 Акустика" : "🎹 Синтетика");
          if (biases.tempo !== 0) nonZero.push(biases.tempo > 0 ? "⏩ Быстрее" : "⏪ Медленнее");
          badge.textContent = nonZero.length > 0 ? nonZero.join(" • ") : "Нейтрально (50/50)";
          badge.style.color = nonZero.length > 0 ? "#38bdf8" : "#94a3b8";
        }
      } catch {}
    }, 120);
  }

  const energyBiasSlider = new CustomAudioSlider({
    id: "slider-bias-energy",
    label: "⚡ Драйв / Энергия",
    min: -50,
    max: 50,
    step: 5,
    defaultValue: 0,
    formatFn: (v) => v === 0 ? "Нейтрально" : v > 0 ? `+${v}% Драйв` : `${v}% Чилл`,
    onChange: () => syncAcousticBiases()
  });

  const valenceBiasSlider = new CustomAudioSlider({
    id: "slider-bias-valence",
    label: "🎭 Вайб / Настроение",
    min: -50,
    max: 50,
    step: 5,
    defaultValue: 0,
    formatFn: (v) => v === 0 ? "Нейтрально" : v > 0 ? `+${v}% Позитив` : `${v}% Грусть`,
    onChange: () => syncAcousticBiases()
  });

  const acousticBiasSlider = new CustomAudioSlider({
    id: "slider-bias-acoustic",
    label: "🎸 Звучание",
    min: -50,
    max: 50,
    step: 5,
    defaultValue: 0,
    formatFn: (v) => v === 0 ? "Нейтрально" : v > 0 ? `+${v}% Акустика` : `${v}% Синтетика`,
    onChange: () => syncAcousticBiases()
  });

  const tempoBiasSlider = new CustomAudioSlider({
    id: "slider-bias-tempo",
    label: "⏱️ Темп",
    min: -30,
    max: 30,
    step: 5,
    defaultValue: 0,
    formatFn: (v) => v === 0 ? "Нейтрально" : v > 0 ? `+${v}% Быстрее` : `${v}% Медленнее`,
    onChange: () => syncAcousticBiases()
  });

  // Load persisted settings from server on mount
  fetch(`${API_BASE}/api/v1/radio/settings?session_id=${getDeviceId()}`)
    .then(r => r.json())
    .then(data => {
      if (data && data.settings) {
        if (typeof data.settings.discoveryRatio === "number") {
          const pct = Math.round(data.settings.discoveryRatio * 100);
          discoveryBalanceSlider.setValue(pct);
        }
        if (data.settings.biases) {
          const b = data.settings.biases;
          if (typeof b.energy === "number") energyBiasSlider.setValue(Math.round(b.energy * 100));
          if (typeof b.valence === "number") valenceBiasSlider.setValue(Math.round(b.valence * 100));
          if (typeof b.acousticness === "number") acousticBiasSlider.setValue(Math.round(b.acousticness * 100));
          if (typeof b.tempo === "number") tempoBiasSlider.setValue(Math.round(b.tempo * 100));
        }
      }
    })
    .catch(() => {});


  // 1. Inject Pin Button 💾 in Transport Controls
  function injectPinButton() {
    const likeBtn = document.getElementById("btn-like");
    if (!likeBtn || document.getElementById("btn-pin")) return;

    const pinBtn = document.createElement("button");
    pinBtn.type = "button";
    pinBtn.className = "icon-btn";
    pinBtn.id = "btn-pin";
    pinBtn.title = "Сохранить навсегда на диск (💾)";
    pinBtn.innerHTML = "💾";
    pinBtn.style.fontSize = "1.2rem";
    pinBtn.style.marginLeft = "4px";

    pinBtn.onclick = async () => {
      const audioEl = document.getElementById("audio");
      const trackId = audioEl && audioEl.dataset && audioEl.dataset.trackId ? parseInt(audioEl.dataset.trackId, 10) : null;
      const titleEl = document.getElementById("title");
      const artistEl = document.getElementById("artist");
      const title = titleEl ? titleEl.textContent.trim() : "";
      const artist = artistEl ? artistEl.textContent.trim() : "";

      if ((!title || title === "Выбери микс") && !trackId) {
        toast("Сейчас ничего не играет");
        return;
      }

      pinBtn.style.opacity = "0.5";
      try {
        let success = false;
        if (trackId) {
          const res = await fetch(`${API_BASE}/api/v1/tracks/${trackId}/pin`, { method: "POST" });
          const data = await res.json();
          if (data.success) success = true;
        }

        if (!success && (artist || title)) {
          const res = await fetch(`${API_BASE}/api/v1/fetch`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query: `${artist} - ${title}`, mode: "pin" })
          });
          const data = await res.json();
          if (data.success) success = true;
        }

        if (success) {
          toast(`💾 Трек закреплён навсегда: ${artist || ""} - ${title || ""}`);
          pinBtn.style.filter = "drop-shadow(0 0 6px gold)";
          pinBtn.style.transform = "scale(1.15)";
        } else {
          toast("Не удалось закрепить трек");
        }
      } catch (e) {
        toast("Ошибка связи с сервером: " + e.message);
      } finally {
        pinBtn.style.opacity = "1";
      }
    };

    likeBtn.parentNode.insertBefore(pinBtn, likeBtn.nextSibling);
  }

  // 2. Inject Upload View Enhancements (Cache Monitor & Playlist Importer)
  function injectUploadSection() {
    const uploadView = document.getElementById("view-upload");
    if (!uploadView || document.getElementById("addon-upload-panel")) return;

    const panel = document.createElement("div");
    panel.id = "addon-upload-panel";
    panel.style.margin = "20px 0";
    panel.style.padding = "22px";
    panel.style.background = "var(--surface, rgba(27, 21, 17, 0.95))";
    panel.style.border = "1px solid rgba(224, 122, 58, 0.35)";
    panel.style.borderRadius = "18px";
    panel.style.boxShadow = "var(--shadow, 0 12px 36px rgba(0,0,0,0.35))";

    panel.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px; flex-wrap:wrap; gap:8px;">
        <h2 style="margin:0; font-size:1.3rem;">⚡ Умный кэш 3 ГБ и 512D База Знаний</h2>
        <div style="display:flex; gap:8px; align-items:center;">
          <span id="addon-512-badge" style="background:rgba(56, 189, 248, 0.2); color:#38bdf8; border:1px solid rgba(56, 189, 248, 0.4); padding:4px 10px; border-radius:12px; font-size:0.85rem; font-weight:700;">🧠 512D Векторов: Загрузка…</span>
          <span id="addon-catalog-badge" style="background:#22c55e22; color:#22c55e; padding:4px 10px; border-radius:12px; font-size:0.85rem; font-weight:600;">⚡ Каталог Открытий</span>
        </div>

      </div>

      <!-- Cache Meter -->
      <div style="background:rgba(0,0,0,0.2); padding:14px; border-radius:8px; margin-bottom:20px;">
        <div style="display:flex; justify-content:space-between; margin-bottom:8px; font-size:0.9rem;">
          <strong id="addon-cache-text">Кэш: загрузка...</strong>
          <span id="addon-cache-pct">0%</span>
        </div>
        <div style="height:8px; background:rgba(255,255,255,0.1); border-radius:4px; overflow:hidden; margin-bottom:10px;">
          <div id="addon-cache-bar" style="height:100%; width:0%; background:#3b82f6; transition:width 0.3s;"></div>
        </div>
        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;">
          <span style="font-size:0.8rem; opacity:0.85;" id="addon-cache-details">Загрузка статистики 512D…</span>
          <div style="display:flex; gap:8px; flex-wrap:wrap;">
            <button type="button" id="btn-addon-preindex-512" class="btn quiet" style="padding:4px 12px; font-size:0.85rem; border-color:#38bdf8; color:#38bdf8; font-weight:700;" title="Подобрать из каталога 250k+ треки под ваш вкус и оцифровать их нейросетью CLAP (512D) в фоне">🧠 Индексировать топ-рекомендации в 512D</button>
            <button type="button" id="btn-addon-clean-cache" class="btn quiet" style="padding:4px 12px; font-size:0.85rem;">Очистить временное аудио</button>
            <button type="button" id="btn-addon-update-ytdlp" class="btn quiet" style="padding:4px 12px; font-size:0.85rem;" title="Обновить инструмент загрузки аудио">⚡ Обновить yt-dlp</button>
          </div>
        </div>

      </div>

      <!-- Playlist Ingestion -->
      <div>
        <h3 style="margin:0 0 8px 0; font-size:1.1rem;">📥 Импорт плейлиста по названиям (512D анализ)</h3>
        <p style="margin:0 0 12px 0; font-size:0.85rem; opacity:0.75;">Вставьте список треков. Они моментально обогатят ваш профиль вкуса и станут кандидатами радио.</p>
        
        <textarea id="addon-import-text" rows="5" placeholder="The Weeknd - Blinding Lights&#10;Daft Punk - One More Time&#10;Кино - Группа крови" style="width:100%; box-sizing:border-box; padding:10px; border-radius:8px; background:rgba(0,0,0,0.3); border:1px solid rgba(255,255,255,0.15); color:#fff; font-family:monospace; margin-bottom:12px;"></textarea>

        <!-- Options Checkboxes -->
        <div style="display:flex; flex-wrap:wrap; gap:16px; margin-bottom:16px; font-size:0.9rem;">
          <label style="display:flex; align-items:center; gap:6px; cursor:pointer;">
            <input type="checkbox" id="addon-opt-fav" checked />
            <span>Добавить в Избранное ❤️</span>
          </label>
          <label style="display:flex; align-items:center; gap:6px; cursor:pointer;">
            <input type="checkbox" id="addon-opt-pin" />
            <span>Сохранить навсегда на диск 💾</span>
          </label>
          <label style="display:flex; align-items:center; gap:6px; cursor:pointer;">
            <input type="checkbox" id="addon-opt-512" checked />
            <span>Сразу запустить 512D векторизацию в фоне</span>
          </label>
        </div>

        <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
          <button type="button" class="btn primary" id="btn-addon-start-import">🚀 Начать импорт</button>
          <button type="button" class="btn quiet" id="btn-addon-pick-file">📁 Загрузить файл со списком (.txt, .m3u)</button>
          <input type="file" id="addon-file-picker" accept=".txt,.m3u,.m3u8,.csv,text/*" style="display:none;" />
          <button type="button" class="btn quiet" id="btn-addon-pause-import" style="display:none;">⏸️ Пауза</button>
          <button type="button" class="btn quiet" id="btn-addon-clear-queue" style="display:none;">✕ Очистить очередь</button>
          <button type="button" class="btn quiet" id="btn-addon-unfavorite-all" style="color:#f87171; border-color:rgba(239,68,68,0.3); font-size:0.8rem;">💔 Снять отметку ❤️ с импортированных треков</button>
        </div>

        <!-- Ingestion Progress Panel -->
        <div id="addon-ingest-progress" style="display:none; margin-top:16px; background:rgba(0,0,0,0.25); padding:14px; border-radius:12px; border:1px solid rgba(255,255,255,0.08);">
          <div style="display:flex; justify-content:space-between; font-size:0.9rem; margin-bottom:8px;">
            <strong id="addon-ingest-title">Обработка очереди…</strong>
            <span id="addon-ingest-count" style="font-weight:700; color:#10b981;">0 / 0</span>
          </div>
          <div style="height:8px; background:rgba(255,255,255,0.1); border-radius:4px; overflow:hidden; margin-bottom:10px;">
            <div id="addon-ingest-bar" style="height:100%; width:0%; background:#10b981; transition:width 0.3s;"></div>
          </div>
          <div style="font-size:0.82rem; opacity:0.85; margin-bottom:12px;" id="addon-ingest-current">Ожидание…</div>

          <!-- Interactive Items Explorer -->
          <div id="addon-ingest-table-box" style="margin-top:14px; border-top:1px solid rgba(255,255,255,0.08); padding-top:12px;">
            <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px; margin-bottom:10px;">
              <div style="display:flex; gap:6px; flex-wrap:wrap;" id="addon-ingest-filter-tabs">
                <button type="button" class="btn quiet sm active" data-filter="all" style="padding:2px 8px; font-size:0.75rem;">Все</button>
                <button type="button" class="btn quiet sm" data-filter="ready" style="padding:2px 8px; font-size:0.75rem; color:#22c55e;">✓ Готовы</button>
                <button type="button" class="btn quiet sm" data-filter="downloading" style="padding:2px 8px; font-size:0.75rem; color:#38bdf8;">⟳ В процессе</button>
                <button type="button" class="btn quiet sm" data-filter="pending" style="padding:2px 8px; font-size:0.75rem; color:#a89f91;">⏳ В очереди</button>
                <button type="button" class="btn quiet sm" data-filter="failed" style="padding:2px 8px; font-size:0.75rem; color:#f87171;">✕ Ошибки</button>
              </div>
              <input type="search" id="addon-ingest-search" placeholder="🔍 Найти в импорте..." style="padding:4px 8px; font-size:0.78rem; border-radius:6px; background:rgba(0,0,0,0.3); border:1px solid rgba(255,255,255,0.15); color:#fff; width:160px;" />
            </div>
            <div id="addon-ingest-items-list" style="max-height:220px; overflow-y:auto; font-size:0.8rem; background:rgba(0,0,0,0.2); border-radius:8px; padding:6px;">
              <div style="padding:10px; text-align:center; color:var(--muted,#a89f91);">Загрузка списка треков…</div>
            </div>
          </div>
        </div>
      </div>
    `;

    // Insert at top of upload view, right above dropzone
    const dropzone = uploadView.querySelector(".dropzone");
    if (dropzone) {
      uploadView.insertBefore(panel, dropzone);
    } else {
      uploadView.insertBefore(panel, uploadView.children[2] || uploadView.firstChild);
    }

    // Event Handlers
    const cleanBtn = document.getElementById("btn-addon-clean-cache");
    cleanBtn.onclick = async () => {
      cleanBtn.disabled = true;
      try {
        const res = await fetch(`${API_BASE}/api/v1/cache/clean`, { method: "POST" });
        const data = await res.json();
        toast(`Очищено ${(data.freedBytes / 1024 / 1024).toFixed(1)} МБ. 512D векторы сохранены.`);
        updateCacheStats();
      } catch (e) {
        toast("Ошибка очистки: " + e.message);
      } finally {
        cleanBtn.disabled = false;
      }
    };

    const updateYtdlpBtn = document.getElementById("btn-addon-update-ytdlp");
    if (updateYtdlpBtn) {
      updateYtdlpBtn.onclick = async () => {
        updateYtdlpBtn.disabled = true;
        toast("Проверка и обновление yt-dlp...");
        try {
          const res = await fetch(`${API_BASE}/api/v1/tools/update-ytdlp`, { method: "POST" });
          const data = await res.json();
          if (data.success) {
            toast(`yt-dlp v${data.version || 'актуален'}: ${data.output || 'Обновлено'}`);
          } else {
            toast("Ошибка обновления yt-dlp: " + (data.error || "Сбой"));
          }
        } catch (e) {
          toast("Сбой соединения: " + e.message);
        } finally {
          updateYtdlpBtn.disabled = false;
        }
      };
    }

    const preindexBtn = document.getElementById("btn-addon-preindex-512");
    if (preindexBtn) {
      preindexBtn.onclick = async () => {
        if (preindexBtn.dataset.loading === "1") return;
        preindexBtn.dataset.loading = "1";
        const origText = preindexBtn.innerHTML;
        preindexBtn.innerHTML = `⏳ Подбор лучших треков...`;
        preindexBtn.style.opacity = "0.75";

        try {
          const res = await fetch(`${API_BASE}/api/v1/catalog/preindex-512`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ count: 15 })
          });
          const data = await res.json();
          if (!data.success) {
            toast(data.message || "Не удалось подобрать треки");
            preindexBtn.innerHTML = origText;
            preindexBtn.dataset.loading = "0";
            preindexBtn.style.opacity = "1";
            return;
          }

          toast(`🚀 Запущен фоновый 512D-майнинг ${data.added} треков под ваш вкус!`);

          const pollTimer = setInterval(async () => {
            try {
              const sRes = await fetch(`${API_BASE}/api/v1/catalog/preindex-status`);
              const sData = await sRes.json();
              if (sData.active) {
                const ws = sData.workerStatus;
                const cur = ws.currentTrack ? `${ws.currentTrack.artist} - ${ws.currentTrack.title}` : "...";
                preindexBtn.innerHTML = `⚡ 512D: ${ws.completed} готово, ${ws.pending} в очереди (${cur.slice(0, 30)}…)`;
                updateCacheStats();
              } else {
                clearInterval(pollTimer);
                preindexBtn.innerHTML = `✅ Оцифровано! (Всего ${sData.total512} векторов)`;
                updateCacheStats();
                setTimeout(() => {
                  preindexBtn.innerHTML = origText;
                  preindexBtn.dataset.loading = "0";
                  preindexBtn.style.opacity = "1";
                }, 4000);
              }
            } catch {
              clearInterval(pollTimer);
              preindexBtn.innerHTML = origText;
              preindexBtn.dataset.loading = "0";
              preindexBtn.style.opacity = "1";
            }
          }, 3000);
        } catch (e) {
          toast("Ошибка запуска 512D-майнинга: " + e.message);
          preindexBtn.innerHTML = origText;
          preindexBtn.dataset.loading = "0";
          preindexBtn.style.opacity = "1";
        }
      };
    }


    const importBtn = document.getElementById("btn-addon-start-import");
    importBtn.onclick = async () => {
      const text = document.getElementById("addon-import-text").value.trim();
      if (!text) {
        toast("Введите хотя бы один трек для импорта");
        return;
      }
      const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
      const fav = document.getElementById("addon-opt-fav").checked;
      const pin = document.getElementById("addon-opt-pin").checked;
      const auto512 = document.getElementById("addon-opt-512").checked;

      importBtn.disabled = true;
      try {
        const res = await fetch(`${API_BASE}/api/v1/import/playlist`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            tracks: lines,
            addToFavorites: fav,
            pinForever: pin,
            autoEmbed512: auto512
          })
        });
        const data = await res.json();
        if (data.success) {
          toast(`Успешно добавлено ${data.addedCount} треков в фоновую очередь!`);
          document.getElementById("addon-import-text").value = "";
          updateIngestionStatus();
        } else {
          toast("Ошибка импорта: " + (data.error || "неизвестно"));
        }
      } catch (e) {
        toast("Ошибка отправки: " + e.message);
      } finally {
        importBtn.disabled = false;
      }
    };

    const pauseBtn = document.getElementById("btn-addon-pause-import");
    pauseBtn.onclick = async () => {
      const isPaused = pauseBtn.textContent.includes("Продолжить");
      const endpoint = isPaused ? "/api/v1/import/resume" : "/api/v1/import/pause";
      await fetch(`${API_BASE}${endpoint}`, { method: "POST" });
      updateIngestionStatus();
    };

    const clearBtn = document.getElementById("btn-addon-clear-queue");
    if (clearBtn) {
      clearBtn.onclick = async () => {
        if (confirm("Очистить оставшуюся очередь фонового импорта?")) {
          await fetch(`${API_BASE}/api/v1/import/clear`, { method: "POST" });
          updateIngestionStatus();
        }
      };
    }

    const pickFileBtn = document.getElementById("btn-addon-pick-file");
    const filePicker = document.getElementById("addon-file-picker");
    if (pickFileBtn && filePicker) {
      pickFileBtn.onclick = () => filePicker.click();
      filePicker.onchange = (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (evt) => {
          const content = evt.target.result;
          const textarea = document.getElementById("addon-import-text");
          if (textarea) {
            textarea.value = content;
            toast(`Файл "${file.name}" загружен (${content.split("\n").filter(Boolean).length} строк). Нажмите "Начать импорт"!`);
          }
        };
        reader.readAsText(file, "UTF-8");
      };
    }

    const unfavBtn = document.getElementById("btn-addon-unfavorite-all");
    if (unfavBtn) {
      unfavBtn.onclick = async () => {
        if (!confirm("Снять отметку «Избранное ❤️» со всех импортированных треков?\n\nОни останутся в каталоге, но радио перестанет играть только их.")) return;
        unfavBtn.disabled = true;
        try {
          const res = await fetch(`${API_BASE}/api/v1/import/unfavorite`, { method: "POST" });
          const data = await res.json();
          if (data.success) {
            toast(`✓ Снята отметка ❤️ с ${data.removedCount} треков! Радио теперь свободно.`);
          } else {
            toast("Ошибка: " + (data.error || "не удалось снять"));
          }
        } catch (e) {
          toast("Ошибка запроса: " + e.message);
        } finally {
          unfavBtn.disabled = false;
        }
      };
    }

    updateCacheStats();
    updateIngestionStatus();
  }

  // 0. Inject Global Header 512D Badge (visible in all views)
  function injectHeaderBadge() {
    const brandBlock = document.querySelector(".brand-block");
    if (!brandBlock || document.getElementById("addon-header-512-badge")) return;

    const badge = document.createElement("span");
    badge.id = "addon-header-512-badge";
    badge.title = "Количество треков с рассчитанными 512D CLAP векторами в локальной базе";
    badge.style.marginLeft = "12px";
    badge.style.padding = "3px 8px";
    badge.style.fontSize = "0.78rem";
    badge.style.fontWeight = "700";
    badge.style.color = "#38bdf8";
    badge.style.background = "rgba(56, 189, 248, 0.15)";
    badge.style.border = "1px solid rgba(56, 189, 248, 0.35)";
    badge.style.borderRadius = "10px";
    badge.style.display = "inline-flex";
    badge.style.alignItems = "center";
    badge.style.gap = "4px";
    badge.style.verticalAlign = "middle";
    badge.style.cursor = "pointer";
    badge.innerHTML = `🧠 <span id="addon-header-512-count">0</span> в 512D`;

    badge.onclick = () => {
      const uploadTab = document.querySelector('[data-view="upload"]');
      if (uploadTab) uploadTab.click();
    };

    const brand = brandBlock.querySelector(".brand");
    if (brand) {
      brand.style.display = "inline-flex";
      brand.style.alignItems = "center";
      brand.appendChild(badge);
    } else {
      brandBlock.appendChild(badge);
    }
  }

  async function updateCacheStats() {
    try {
      const res = await fetch(`${API_BASE}/api/v1/cache`);
      const s = await res.json();
      const txt = document.getElementById("addon-cache-text");
      const pct = document.getElementById("addon-cache-pct");
      const bar = document.getElementById("addon-cache-bar");
      const det = document.getElementById("addon-cache-details");
      const b512 = document.getElementById("addon-512-badge");
      const h512 = document.getElementById("addon-header-512-count");

      if (txt && pct && bar) {
        txt.textContent = `Кэш: ${s.totalMb} МБ / ${s.maxMb} МБ`;
        pct.textContent = `${s.usagePercent}%`;
        bar.style.width = `${Math.min(100, s.usagePercent)}%`;
        if (det) {
          det.textContent = `Оцифровано в 512D: ${s.embedded512Count || 0} треков · Файлов в кэше: ${s.trackCount} · Закреплено навсегда 💾: ${s.pinnedCount}`;
        }
      }

      if (b512) {
        b512.textContent = `🧠 512D Векторов: ${s.embedded512Count || 0}`;
      }

      if (h512) {
        h512.textContent = String(s.embedded512Count || 0);
      }

      const homeCache = document.getElementById("addon-home-cache");
      if (homeCache) {
        homeCache.textContent = `${s.totalMb} МБ / ${s.maxMb} МБ (${s.usagePercent}%)`;
      }

      const home512 = document.getElementById("addon-home-512");
      if (home512) {
        home512.textContent = `${s.embedded512Count || 0} треков`;
      }
    } catch {}
  }

  // 3. Inject Home Status Banner for instant visibility
  function injectHomeBanner() {
    const homeIntro = document.querySelector(".home-intro");
    if (!homeIntro || document.getElementById("addon-home-banner")) return;

    const banner = document.createElement("div");
    banner.id = "addon-home-banner";
    banner.style.gridColumn = "1 / -1";
    banner.style.marginTop = "14px";
    banner.style.padding = "10px 16px";
    banner.style.background = "rgba(0, 0, 0, 0.4)";
    banner.style.border = "1px solid rgba(224, 122, 58, 0.35)";
    banner.style.borderRadius = "14px";
    banner.style.display = "flex";
    banner.style.justifyContent = "space-between";
    banner.style.alignItems = "center";
    banner.style.flexWrap = "wrap";
    banner.style.gap = "10px";
    banner.style.fontSize = "0.88rem";

    banner.innerHTML = `
      <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
        <span style="color:#e07a3a; font-weight:700;">⚡ Кэш 3 ГБ:</span>
        <span id="addon-home-cache" style="color:#f7f0e8;">Загрузка…</span>
        <span style="opacity:0.4;">|</span>
        <span style="color:#38bdf8; font-weight:700;">🧠 512D Векторов:</span>
        <span id="addon-home-512" style="color:#38bdf8; font-weight:700; background:rgba(56,189,248,0.18); border:1px solid rgba(56,189,248,0.35); padding:2px 8px; border-radius:8px;">Загрузка…</span>
      <div style="display:flex; gap:8px; align-items:center;">
        <button type="button" class="btn quiet sm" id="btn-home-preindex-512" style="padding:4px 10px; font-size:0.82rem; border-color:#38bdf8; color:#38bdf8; font-weight:700; cursor:pointer;" title="Подобрать из каталога 250k+ треки под ваш вкус и оцифровать их нейросетью CLAP (512D) в фоне">
          🧠 512D Майнинг
        </button>
        <button type="button" class="btn quiet sm" id="btn-home-goto-upload" style="padding:4px 12px; font-size:0.82rem; border-color:rgba(224,122,58,0.5); cursor:pointer;">
          📥 Импорт плейлиста →
        </button>
      </div>
    `;


    homeIntro.appendChild(banner);

    const homePreindexBtn = document.getElementById("btn-home-preindex-512");
    if (homePreindexBtn) {
      homePreindexBtn.onclick = () => {
        const uploadTab = document.querySelector('[data-view="upload"]');
        if (uploadTab) uploadTab.click();
        setTimeout(() => {
          const mainPreindexBtn = document.getElementById("btn-addon-preindex-512");
          if (mainPreindexBtn) mainPreindexBtn.click();
        }, 150);
      };
    }

    const gotoBtn = document.getElementById("btn-home-goto-upload");
    if (gotoBtn) {
      gotoBtn.onclick = () => {
        const uploadTab = document.querySelector('[data-view="upload"]');
        if (uploadTab) uploadTab.click();
      };
    }
  }

  async function updateIngestionStatus() {
    try {
      const res = await fetch(`${API_BASE}/api/v1/import/status`);
      const st = await res.json();
      const progressBox = document.getElementById("addon-ingest-progress");
      const pauseBtn = document.getElementById("btn-addon-pause-import");
      const clearBtn = document.getElementById("btn-addon-clear-queue");

      if (!progressBox) return;

      if (st.total > 0 && (st.pending > 0 || st.processing > 0)) {
        progressBox.style.display = "block";
        pauseBtn.style.display = "inline-block";
        clearBtn.style.display = "inline-block";

        pauseBtn.textContent = st.isPaused ? "▶️ Продолжить" : "⏸️ Пауза";

        const processed = st.ready + st.failed;
        const pct = Math.round((processed / st.total) * 100);
        document.getElementById("addon-ingest-count").textContent = `${processed} / ${st.total} (${pct}%)`;
        document.getElementById("addon-ingest-bar").style.width = `${pct}%`;

        const curEl = document.getElementById("addon-ingest-current");
        if (st.currentTrack) {
          curEl.textContent = `Текущий [${st.currentTrack.status}]: ${st.currentTrack.artist} - ${st.currentTrack.title}`;
        } else {
          curEl.textContent = st.isPaused ? "Очередь на паузе" : "В обработке…";
        }
      } else {
        if (st.total > 0 && st.pending === 0 && st.processing === 0) {
          progressBox.style.display = "block";
          document.getElementById("addon-ingest-title").textContent = "Импорт завершён!";
          document.getElementById("addon-ingest-count").textContent = `${st.ready} готово, ${st.failed} ошибок`;
          document.getElementById("addon-ingest-bar").style.width = "100%";
          document.getElementById("addon-ingest-current").textContent = "Все 512D отпечатки рассчитаны и сохранены в базе.";
          pauseBtn.style.display = "none";
          clearBtn.style.display = "inline-block";
        } else {
          progressBox.style.display = "none";
          pauseBtn.style.display = "none";
          clearBtn.style.display = "none";
        }
      }

      // Render interactive items explorer
      const itemsListEl = document.getElementById("addon-ingest-items-list");
      if (itemsListEl && st.total > 0) {
        if (!window._ingestFilter) window._ingestFilter = "all";
        if (!window._ingestSearch) window._ingestSearch = "";

        const tabsBox = document.getElementById("addon-ingest-filter-tabs");
        if (tabsBox && !tabsBox.dataset.bound) {
          tabsBox.dataset.bound = "1";
          tabsBox.querySelectorAll("button").forEach(btn => {
            btn.onclick = () => {
              tabsBox.querySelectorAll("button").forEach(b => {
                b.style.background = "transparent";
                b.style.fontWeight = "normal";
              });
              btn.style.background = "rgba(224,122,58,0.25)";
              btn.style.fontWeight = "bold";
              window._ingestFilter = btn.dataset.filter || "all";
              loadIngestItems();
            };
          });
          const searchInp = document.getElementById("addon-ingest-search");
          if (searchInp) {
            searchInp.oninput = (e) => {
              window._ingestSearch = e.target.value.trim();
              loadIngestItems();
            };
          }
        }

        async function loadIngestItems() {
          try {
            const iRes = await fetch(`${API_BASE}/api/v1/import/items?status=${window._ingestFilter}&q=${encodeURIComponent(window._ingestSearch)}&limit=30`);
            const iData = await iRes.json();
            const items = iData.items || [];
            if (items.length === 0) {
              itemsListEl.innerHTML = `<div style="padding:10px; text-align:center; color:var(--muted,#a89f91);">Нет треков в этой категории.</div>`;
              return;
            }
            itemsListEl.innerHTML = items.map(it => {
              let badge = `<span style="color:#a89f91;">⏳ в очереди</span>`;
              if (it.status === "ready") badge = `<span style="color:#22c55e; font-weight:600;">✓ готов (512D)</span>`;
              else if (it.status === "downloading") badge = `<span style="color:#38bdf8; font-weight:600;">⟳ скачивается</span>`;
              else if (it.status === "embedding") badge = `<span style="color:#c084fc; font-weight:600;">🧠 векторизация</span>`;
              else if (it.status === "failed") badge = `<span style="color:#f87171;" title="${it.error || ''}">✕ ошибка</span>`;

              return `
                <div style="display:flex; justify-content:space-between; align-items:center; padding:4px 6px; border-bottom:1px solid rgba(255,255,255,0.05); gap:8px;">
                  <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:70%;">
                    <strong>${it.artist}</strong> — ${it.title}
                  </span>
                  <span style="font-size:0.72rem; white-space:nowrap;">${badge}</span>
                </div>
              `;
            }).join("");
          } catch {}
        }

        if (!window._lastIngestItemsLoad || Date.now() - window._lastIngestItemsLoad > 4000) {
          window._lastIngestItemsLoad = Date.now();
          loadIngestItems();
        }
      }
    } catch {}
  }

  // 3.5 Live Now-Playing Origin Badge & Queue Badges
  let lastCheckedNowPlayingId = null;
  async function updateNowPlayingOrigin(forcedTrackId) {
    const metaContainer = document.querySelector(".now-stage .now-meta");
    if (!metaContainer) return;

    let badgeContainer = document.getElementById("addon-now-playing-origin");
    if (!badgeContainer) {
      badgeContainer = document.createElement("div");
      badgeContainer.id = "addon-now-playing-origin";
      badgeContainer.style.cssText = "display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin: 4px 0 8px 0; min-height: 22px;";
      const artistEl = document.getElementById("artist");
      if (artistEl && artistEl.nextSibling) {
        metaContainer.insertBefore(badgeContainer, artistEl.nextSibling);
      } else {
        metaContainer.appendChild(badgeContainer);
      }
    }

    const audioEl = document.getElementById("audio");
    let trackId = forcedTrackId;
    if (!trackId && audioEl && audioEl.dataset && audioEl.dataset.trackId) {
      trackId = parseInt(audioEl.dataset.trackId, 10);
    }
    if (!trackId && audioEl && audioEl.src) {
      const m = audioEl.src.match(/\/api\/stream\/(\d+)/);
      if (m) trackId = parseInt(m[1], 10);
    }
    if (!trackId && window.current && window.current.id) {
      trackId = parseInt(window.current.id, 10);
    }

    if (!trackId) {
      badgeContainer.innerHTML = "";
      return;
    }

    if (trackId === lastCheckedNowPlayingId && badgeContainer.children.length > 0) return;
    lastCheckedNowPlayingId = trackId;

    try {
      const res = await fetch(`${API_BASE}/api/v1/tracks/${trackId}/origin`);
      const t = await res.json();
      if (!t || t.error) return;

      const badges = [];
      if (t.is_favorite) {
        badges.push(`<span class="addon-src-badge" title="Трек из вашего Избранного" style="background:rgba(239,68,68,0.18); color:#f87171; border:1px solid rgba(239,68,68,0.4); padding:2px 7px; border-radius:8px; font-size:0.75rem; font-weight:700;">❤️ Избранное</span>`);
      }
      if (t.is_pinned) {
        badges.push(`<span class="addon-src-badge" title="Закреплён на диске" style="background:rgba(234,179,8,0.18); color:#fbbf24; border:1px solid rgba(234,179,8,0.4); padding:2px 7px; border-radius:8px; font-size:0.75rem; font-weight:700;">💾 Закреплено</span>`);
      }
      if (t.has_512d) {
        badges.push(`<span class="addon-src-badge" title="Оцифрован нейросетью CLAP (512 параметров)" style="background:rgba(56,189,248,0.18); color:#38bdf8; border:1px solid rgba(56,189,248,0.4); padding:2px 7px; border-radius:8px; font-size:0.75rem; font-weight:700;">🧠 512D Вектор</span>`);
      }
      if (t.in_12d) {
        badges.push(`<span class="addon-src-badge" title="Подобран из каталога треков по 12 акустическим свойствам" style="background:rgba(234,179,8,0.18); color:#eab308; border:1px solid rgba(234,179,8,0.4); padding:2px 7px; border-radius:8px; font-size:0.75rem; font-weight:700;">⚡ 12D Каталог</span>`);
      }

      if (t.playlist_name) {
        badges.push(`<span class="addon-src-badge" title="Из плейлиста: ${t.playlist_name}" style="background:rgba(168,85,247,0.18); color:#c084fc; border:1px solid rgba(168,85,247,0.4); padding:2px 7px; border-radius:8px; font-size:0.75rem; font-weight:700;">📁 ${t.playlist_name}</span>`);
      }
      if (t.is_imported) {
        badges.push(`<span class="addon-src-badge" title="Импортирован из файла плейлиста" style="background:rgba(99,102,241,0.18); color:#818cf8; border:1px solid rgba(99,102,241,0.4); padding:2px 7px; border-radius:8px; font-size:0.75rem; font-weight:700;">📥 Импорт</span>`);
      }
      if (t.is_local) {
        badges.push(`<span class="addon-src-badge" title="Локальный файл коллекции" style="background:rgba(34,197,94,0.18); color:#22c55e; border:1px solid rgba(34,197,94,0.4); padding:2px 7px; border-radius:8px; font-size:0.75rem; font-weight:700;">💿 Локальный</span>`);
      }

      badgeContainer.innerHTML = `<span style="font-size:0.75rem; opacity:0.7; color:var(--muted,#a89f91);">Источник:</span> ` + (badges.join(" ") || `<span style="font-size:0.75rem; opacity:0.6;">Библиотека</span>`);
    } catch {}
  }

  async function updateQueueOrigins() {
    const playlistEl = document.getElementById("playlist");
    const queueEl = document.getElementById("queue");
    const items = [];
    if (playlistEl && !playlistEl.hidden) {
      items.push(...playlistEl.querySelectorAll("li"));
    }
    if (queueEl && !queueEl.hidden) {
      items.push(...queueEl.querySelectorAll("li"));
    }
    if (items.length === 0) return;

    const trackIds = [];
    const queries = [];
    const itemMap = [];

    items.forEach(li => {
      if (li.querySelector(".addon-queue-origin-badge")) return;

      let id = null;
      if (li.dataset.trackId) {
        id = parseInt(li.dataset.trackId, 10);
      }
      if (!id) {
        const btn = li.querySelector("[data-id], [data-track-id]");
        if (btn) id = parseInt(btn.dataset.id || btn.dataset.trackId, 10);
      }

      let artist = "";
      let title = "";
      const strong = li.querySelector("strong");
      if (strong) {
        artist = strong.textContent.trim();
        const fullText = li.textContent || "";
        if (fullText.includes("—")) {
          const parts = fullText.split("—");
          title = parts[1].replace(/far|new|плейлист|radio discovery.*/gi, "").trim();
        }
      }

      if (id) {
        trackIds.push(id);
      } else if (artist || title) {
        queries.push({ artist, title });
      }

      itemMap.push({ li, id, artist, title });
    });

    if (trackIds.length === 0 && queries.length === 0) return;

    try {
      const res = await fetch(`${API_BASE}/api/v1/tracks/origins`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: trackIds, queries: queries })
      });
      const data = await res.json();
      const origins = data.origins || {};
      const originsByQuery = data.originsByQuery || {};

      itemMap.forEach(({ li, id, artist, title }) => {
        let meta = null;
        if (id && origins[id]) meta = origins[id];
        if (!meta && (artist || title)) {
          const k = `${artist}|||${title}`.toLowerCase();
          meta = originsByQuery[k] || originsByQuery[`|||${title}`.toLowerCase()];
        }
        if (!meta) return;

        let badgeHtml = "";
        if (meta.is_favorite) badgeHtml += `<span style="color:#f87171; font-size:0.72rem; margin-left:4px;" title="Избранное">♥</span>`;
        if (meta.has_512d) badgeHtml += `<span style="color:#38bdf8; font-size:0.68rem; margin-left:4px;" title="512D Вектор">🧠 512D</span>`;
        else if (meta.in_12d) badgeHtml += `<span style="color:#eab308; font-size:0.68rem; margin-left:4px;" title="12D Каталог">⚡ 12D</span>`;
        if (meta.playlist_name) badgeHtml += `<span style="color:#c084fc; font-size:0.68rem; margin-left:4px;" title="Плейлист: ${meta.playlist_name}">📁</span>`;
        if (meta.is_imported) badgeHtml += `<span style="color:#818cf8; font-size:0.68rem; margin-left:4px;" title="Импорт">📥</span>`;

        if (!badgeHtml) return;

        const target = li.querySelector("strong") || li.querySelector(".title") || li;
        if (target && !li.querySelector(".addon-queue-origin-badge")) {
          const span = document.createElement("span");
          span.className = "addon-queue-origin-badge";
          span.innerHTML = badgeHtml;
          target.appendChild(span);
        }
      });
    } catch {}
  }

  // 3.6 Inject Custom Audio Sliders & Acoustic Equalizer into Queue Panel
  function injectRadioSliders() {
    const queuePanel = document.querySelector(".queue-panel");
    if (!queuePanel || document.getElementById("addon-sliders-block")) return;

    const sliderEl = discoveryBalanceSlider.render();

    // Create unified collapsible 12D Acoustic Equalizer & Discovery Settings
    let eqWrap = document.getElementById("wrap-acoustic-equalizer");
    if (!eqWrap) {
      eqWrap = document.createElement("details");
      eqWrap.id = "wrap-acoustic-equalizer";
      eqWrap.open = localStorage.getItem("eq_open") !== "false"; // Open by default!
      eqWrap.ontoggle = () => {
        localStorage.setItem("eq_open", String(eqWrap.open));
      };
      eqWrap.style.cssText = "background: rgba(0,0,0,0.32); border: 1px solid rgba(56,189,248,0.25); border-radius: 12px; padding: 6px 10px; margin: 6px 0;";
      eqWrap.innerHTML = `
        <summary style="cursor: pointer; font-size: 0.82rem; font-weight: 700; color: #38bdf8; display: flex; justify-content: space-between; align-items: center; user-select: none;">
          <span style="display: flex; align-items: center; gap: 6px;">🎛️ Настройки настроения и открытий (12D)</span>
          <span id="eq-summary-badge" style="font-size: 0.72rem; opacity: 0.85; background: rgba(56,189,248,0.15); border: 1px solid rgba(56,189,248,0.3); padding: 1px 6px; border-radius: 6px; color: #94a3b8;">Нейтрально (50/50)</span>
        </summary>
        <div id="eq-sliders-container" style="margin-top: 6px; display: flex; flex-direction: column; gap: 4px;">
          <!-- 5 Sliders: Discovery Balance + 4 Mood Biases -->
          <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 6px;">
            <button type="button" id="btn-play-vibe-now" class="btn primary sm" style="font-size: 0.75rem; padding: 4px 10px; background: #e07a3a; color: #fff; border: none; border-radius: 6px; font-weight: 700; cursor: pointer;">
              ▶ Включить этот вайб сейчас
            </button>
            <button type="button" id="btn-reset-eq" class="btn quiet sm" style="font-size: 0.75rem; padding: 2px 8px; color: #94a3b8; border-color: rgba(255,255,255,0.2); cursor: pointer;">
              ↺ Сбросить (50/50)
            </button>
          </div>
        </div>
      `;

      const eqContainer = eqWrap.querySelector("#eq-sliders-container");
      eqContainer.insertBefore(sliderEl, eqContainer.firstChild); // 1. Баланс открытий
      eqContainer.insertBefore(energyBiasSlider.render(), eqContainer.children[1]); // 2. Энергия
      eqContainer.insertBefore(valenceBiasSlider.render(), eqContainer.children[2]); // 3. Настроение
      eqContainer.insertBefore(acousticBiasSlider.render(), eqContainer.children[3]); // 4. Акустика
      eqContainer.insertBefore(tempoBiasSlider.render(), eqContainer.children[4]); // 5. Темп

      const playVibeBtn = eqWrap.querySelector("#btn-play-vibe-now");
      if (playVibeBtn) {
        playVibeBtn.onclick = async () => {
          playVibeBtn.textContent = "⏳ Применяем...";
          try {
            await syncAcousticBiases();
            if (typeof window.postEvent === "function") {
              await window.postEvent("skip");
            } else {
              const firstLi = document.querySelector("#queue li");
              if (firstLi && firstLi.dataset.trackId) {
                await playTrackNow(parseInt(firstLi.dataset.trackId, 10));
              }
            }
            toast("▶ Радио переключено на выбранный вайб!");
          } catch (e) {
            toast("Ошибка: " + String(e));
          } finally {
            playVibeBtn.textContent = "▶ Включить этот вайб сейчас";
          }
        };
      }

      const resetBtn = eqWrap.querySelector("#btn-reset-eq");
      if (resetBtn) {
        resetBtn.onclick = () => {
          discoveryBalanceSlider.setValue(50);
          energyBiasSlider.setValue(0);
          valenceBiasSlider.setValue(0);
          acousticBiasSlider.setValue(0);
          tempoBiasSlider.setValue(0);
          syncAcousticBiases();
          toast("↺ Настройки сброшены в нейтральный баланс 50/50");
        };
      }
    }

    const container = document.createElement("div");
    container.id = "addon-sliders-block";
    container.appendChild(eqWrap);

    const tabBar = document.getElementById("addon-queue-tab-bar");
    if (tabBar) {
      queuePanel.insertBefore(container, tabBar);
    } else {
      const queueHead = queuePanel.querySelector(".queue-head");
      if (queueHead && queueHead.nextSibling) {
        queuePanel.insertBefore(container, queueHead.nextSibling);
      } else {
        queuePanel.prepend(container);
      }
    }
  }

  // Hook Go Player frontend functions for reactive updates
  function hookPlayerFunctions() {
    if (typeof window.renderQueue === "function" && !window.renderQueue._hooked) {
      const orig = window.renderQueue;
      window.renderQueue = function(queue) {
        orig.apply(this, arguments);
        try {
          const ol = document.getElementById("queue");
          if (ol && Array.isArray(queue)) {
            const lis = ol.querySelectorAll("li");
            queue.forEach((q, idx) => {
              if (lis[idx] && q && q.track_id) {
                lis[idx].dataset.trackId = String(q.track_id);
              }
            });
            setTimeout(updateQueueOrigins, 50);
          }
        } catch {}
      };
      window.renderQueue._hooked = true;
    }

    if (typeof window.renderPlaylist === "function" && !window.renderPlaylist._hooked) {
      const orig = window.renderPlaylist;
      window.renderPlaylist = function(tracks, currentIndex) {
        orig.apply(this, arguments);
        try {
          const ol = document.getElementById("playlist");
          if (ol && Array.isArray(tracks)) {
            const lis = ol.querySelectorAll("li");
            tracks.forEach((t, idx) => {
              const id = t.id || t.track_id;
              if (lis[idx] && id) {
                lis[idx].dataset.trackId = String(id);
                const btn = lis[idx].querySelector(".playlist-item");
                if (btn) btn.dataset.trackId = String(id);
              }
            });
            setTimeout(updateQueueOrigins, 50);
          }
        } catch {}
      };
      window.renderPlaylist._hooked = true;
    }

    if (typeof window.renderNow === "function" && !window.renderNow._hooked) {
      const orig = window.renderNow;
      window.renderNow = function(track) {
        orig.apply(this, arguments);
        try {
          if (track && track.id) {
            setTimeout(() => updateNowPlayingOrigin(track.id), 50);
          }
        } catch {}
      };
      window.renderNow._hooked = true;
    }
  }

  // 4. Inject Radio Listening History Tab & Panel (Unlimited, Lightweight, Source-Badged)
  let activeQueueTab = "queue"; // "queue" or "history"
  let cachedFullHistory = [];
  let displayedHistoryCount = 50;
  const HISTORY_BATCH = 50;
  let historySearchQuery = "";

  function cleanTrackMeta(artist, title) {
    let a = (artist || "").replace(/[\uFFFD\u0080-\u009F]/g, "").trim();
    let t = (title || "").replace(/[\uFFFD\u0080-\u009F]/g, "").trim();
    if (/^[A-Za-z0-9_-]{11}$/.test(t) && a.includes(" - ")) {
      const parts = a.split(" - ");
      a = parts[0].trim();
      t = parts.slice(1).join(" - ").trim();
    }
    // Clean up typical YouTube tags
    t = t.replace(/\s*[\(\[](?:Official\s*(?:Music\s*)?Video|Audio|Lyrics|Official\s*Audio|Official|Lyric\s*Video)[\)\]]/gi, "").trim();
    return { artist: a || "Неизвестный артист", title: t || a || "Без названия" };
  }

  function fmtTime(sec) {
    if (!Number.isFinite(sec) || sec <= 0) return "0:00";
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  function timeAgo(dateStr) {
    if (!dateStr) return "";
    const diff = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
    if (diff < 60) return "сейчас";
    if (diff < 3600) return `${Math.floor(diff / 60)} м`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} ч`;
    const d = new Date(dateStr);
    return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
  }

  function getSourceBadges(t) {
    const badges = [];
    if (t.is_favorite) {
      badges.push(`<span class="addon-src-badge" title="Из списка Избранного" style="background:rgba(239,68,68,0.15); color:#f87171; border:1px solid rgba(239,68,68,0.3); padding:1px 5px; border-radius:6px; font-size:0.68rem; font-weight:600;">❤️ Избранное</span>`);
    }
    if (t.is_pinned) {
      badges.push(`<span class="addon-src-badge" title="Закреплён на диске (не удаляется при очистке)" style="background:rgba(234,179,8,0.15); color:#fbbf24; border:1px solid rgba(234,179,8,0.3); padding:1px 5px; border-radius:6px; font-size:0.68rem; font-weight:600;">💾 Закреплено</span>`);
    }
    if (t.has_512d) {
      badges.push(`<span class="addon-src-badge" title="Оцифрован нейросетью CLAP (512 параметров)" style="background:rgba(56,189,248,0.15); color:#38bdf8; border:1px solid rgba(56,189,248,0.3); padding:1px 5px; border-radius:6px; font-size:0.68rem; font-weight:700;">🧠 512D</span>`);
    }
    if (t.in_12d) {
      badges.push(`<span class="addon-src-badge" title="Подобран из каталога треков по 12 акустическим свойствам" style="background:rgba(234,179,8,0.15); color:#eab308; border:1px solid rgba(234,179,8,0.3); padding:1px 5px; border-radius:6px; font-size:0.68rem; font-weight:600;">⚡ 12D</span>`);
    }

    if (t.playlist_name) {
      badges.push(`<span class="addon-src-badge" title="Из плейлиста: ${t.playlist_name}" style="background:rgba(168,85,247,0.15); color:#c084fc; border:1px solid rgba(168,85,247,0.3); padding:1px 5px; border-radius:6px; font-size:0.68rem; font-weight:600;">📁 ${t.playlist_name}</span>`);
    }
    if (t.is_imported) {
      badges.push(`<span class="addon-src-badge" title="Импортирован из текстового плейлиста" style="background:rgba(99,102,241,0.15); color:#818cf8; border:1px solid rgba(99,102,241,0.3); padding:1px 5px; border-radius:6px; font-size:0.68rem; font-weight:600;">📥 Импорт</span>`);
    }
    if (t.is_local) {
      badges.push(`<span class="addon-src-badge" title="Файл из локальной коллекции" style="background:rgba(34,197,94,0.15); color:#22c55e; border:1px solid rgba(34,197,94,0.3); padding:1px 5px; border-radius:6px; font-size:0.68rem; font-weight:600;">💿 Локальный</span>`);
    }
    return badges.join(" ");
  }

  async function playHistoryTrack(trackId, title) {
    try {
      toast(`▶ Воспроизведение: ${title || "#" + trackId}`);
      const res = await fetch(`${API_BASE}/api/play`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ track_id: trackId, name: title || "" })
      });
      const data = await res.json();
      if (typeof window.applyPlayPayload === "function") {
        window.applyPlayPayload(data);
      } else {
        const audio = document.getElementById("audio");
        if (audio) {
          audio.dataset.trackId = String(trackId);
          audio.src = `/api/stream/${trackId}`;
          audio.play().catch(() => {});
        }
      }
      setTimeout(loadRadioHistory, 600);
    } catch (e) {
      toast("Ошибка запуска: " + e.message);
    }
  }

  async function toggleFavInHistory(trackId, btnEl) {
    btnEl.style.opacity = "0.5";
    try {
      const res = await fetch(`${API_BASE}/api/favorites/toggle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "track", track_id: trackId })
      });
      const data = await res.json();
      if (data.favorited) {
        btnEl.style.color = "#e07a3a";
        toast("♥ Добавлено в любимые");
      } else {
        btnEl.style.color = "rgba(255,255,255,0.25)";
        toast("Убрано из любимых");
      }
    } catch (e) {
      toast("Ошибка: " + e.message);
    } finally {
      btnEl.style.opacity = "1";
    }
  }

  async function togglePinInHistory(trackId, btnEl, isCurrentlyPinned) {
    btnEl.style.opacity = "0.5";
    try {
      const method = isCurrentlyPinned ? "DELETE" : "POST";
      const res = await fetch(`${API_BASE}/api/v1/tracks/${trackId}/pin`, { method });
      const data = await res.json();
      if (data.success) {
        if (!isCurrentlyPinned) {
          btnEl.style.opacity = "1";
          btnEl.style.filter = "drop-shadow(0 0 5px gold)";
          btnEl.dataset.pinned = "1";
          toast("💾 Сохранено навсегда на диск!");
        } else {
          btnEl.style.opacity = "0.4";
          btnEl.style.filter = "none";
          btnEl.dataset.pinned = "0";
          toast("Откреплено от диска");
        }
      }
    } catch (e) {
      toast("Ошибка: " + e.message);
    } finally {
      btnEl.style.opacity = btnEl.dataset.pinned === "1" ? "1" : "0.4";
    }
  }

  async function loadRadioHistory() {
    try {
      const res = await fetch(`${API_BASE}/api/v1/radio/history`);
      const data = await res.json();
      cachedFullHistory = data.history || [];

      const histCntEl = document.getElementById("addon-hist-cnt");
      if (histCntEl) {
        histCntEl.textContent = String(cachedFullHistory.length);
      }

      // Update queue count badge
      const qCntEl = document.getElementById("addon-queue-cnt");
      const nativeQueueCount = document.getElementById("queue-count");
      if (qCntEl) {
        const qCount = nativeQueueCount ? nativeQueueCount.textContent.trim() : "";
        qCntEl.textContent = qCount || "0";
      }

      if (activeQueueTab === "history") {
        renderHistoryList();
      }
    } catch {}
  }

  function renderHistoryList() {
    const listEl = document.getElementById("addon-history-list");
    if (!listEl) return;

    let items = cachedFullHistory;
    if (historySearchQuery) {
      const q = historySearchQuery.toLowerCase();
      items = cachedFullHistory.filter(t => {
        const meta = cleanTrackMeta(t.artist, t.title);
        const text = `${meta.artist} ${meta.title} ${t.playlist_name || ""}`.toLowerCase();
        if (q === "512" || q === "512d") return t.has_512d;
        if (q === "12" || q === "12d") return t.in_12d;
        if (q === "избранное" || q === "любимое" || q === "лайк") return t.is_favorite;
        if (q === "сохранено" || q === "диск" || q === "пин") return t.is_pinned;
        if (q === "импорт") return t.is_imported;
        if (q === "локальное") return t.is_local;
        return text.includes(q);
      });
    }

    if (items.length === 0) {
      listEl.innerHTML = `
        <li style="padding: 24px 16px; text-align: center; color: var(--muted, #a89f91); font-size: 0.85rem;">
          ${historySearchQuery ? "Ничего не найдено по запросу." : "Пока нет прослушанных треков.<br>Включите радио, и треки появятся здесь!"}
        </li>`;
      return;
    }

    const audioEl = document.getElementById("audio");
    const currentTrackId = audioEl && audioEl.dataset && audioEl.dataset.trackId ? parseInt(audioEl.dataset.trackId, 10) : null;

    const slice = items.slice(0, displayedHistoryCount);

    const itemsHtml = slice.map((t, idx) => {
      const meta = cleanTrackMeta(t.artist, t.title);
      const isCurrent = currentTrackId === t.id;
      const pinned = !!t.is_pinned;
      const fav = !!t.is_favorite;
      const sourceBadges = getSourceBadges(t);

      let actionBadge = "";
      if (t.action === "track_end") {
        actionBadge = `<span title="Прослушан полностью" style="color: #22c55e; font-size: 0.7rem; opacity: 0.9;">✓ сыграл</span>`;
      } else if (t.action === "skip") {
        actionBadge = `<span title="Пропущен" style="color: #94a3b8; font-size: 0.7rem; opacity: 0.8;">⏭ скип</span>`;
      } else if (t.action === "start") {
        actionBadge = `<span title="В процессе" style="color: #38bdf8; font-size: 0.7rem;">▶ запущен</span>`;
      }

      const bgStyle = isCurrent
        ? "background: rgba(224, 122, 58, 0.18); border-left: 3px solid #e07a3a;"
        : "background: transparent; border-left: 3px solid transparent;";

      return `
        <li style="margin: 0; padding: 0; border: 0;" data-idx="${idx}">
          <div class="playlist-item addon-history-item" data-track-id="${t.id}" style="${bgStyle} display: grid; grid-template-columns: 40px 1fr auto; gap: 8px; align-items: center; padding: 6px 8px; border-bottom: 1px solid rgba(44,36,28,0.55); cursor: pointer; border-radius: 6px; transition: background 0.15s;">
            <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center;">
              <span class="addon-play-icon" style="font-size: 0.82rem; color: ${isCurrent ? '#e07a3a' : 'inherit'}; opacity: 0.85; transition: transform 0.15s;">${isCurrent ? '❚❚' : '▶'}</span>
              <span style="font-size: 0.65rem; color: var(--muted, #a89f91); white-space: nowrap; margin-top: 1px;">${timeAgo(t.played_at)}</span>
            </div>
            <div style="min-width: 0; overflow: hidden;">
              <div style="font-weight: 600; font-size: 0.88rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: ${isCurrent ? '#e07a3a' : 'var(--fg, #f7f0e8)'};">
                ${meta.title}
              </div>
              <div style="font-size: 0.76rem; color: var(--muted, #a89f91); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: flex; align-items: center; gap: 6px; margin-top: 2px;">
                <span style="overflow:hidden; text-overflow:ellipsis;">${meta.artist}</span>
                ${actionBadge}
                ${sourceBadges}
              </div>
            </div>
            <div style="display: flex; align-items: center; gap: 6px;" class="addon-hist-actions">
              <span style="font-size: 0.75rem; color: var(--muted, #a89f91); font-variant-numeric: tabular-nums;">${fmtTime(t.duration)}</span>
              <button type="button" class="addon-btn-hist-fav" title="В избранное" style="background:transparent; border:none; cursor:pointer; font-size:1.02rem; padding:2px; color:${fav ? '#e07a3a' : 'rgba(255,255,255,0.25)'}; line-height:1; transition:transform 0.15s;">♥</button>
              <button type="button" class="addon-btn-hist-pin" data-pinned="${pinned ? '1' : '0'}" title="Сохранить навсегда (💾)" style="background:transparent; border:none; cursor:pointer; font-size:0.92rem; padding:2px; opacity:${pinned ? '1' : '0.4'}; filter:${pinned ? 'drop-shadow(0 0 4px gold)' : 'none'}; line-height:1; transition:transform 0.15s;">💾</button>
            </div>
          </div>
        </li>
      `;
    }).join("");

    let footerHtml = "";
    if (displayedHistoryCount < items.length) {
      footerHtml = `
        <li style="padding: 10px; text-align: center; border:none; list-style:none;">
          <button type="button" class="btn quiet sm" id="btn-addon-load-more" style="padding: 4px 14px; font-size: 0.78rem; border-radius: 99px; cursor: pointer;">
            Показать ещё (+${Math.min(HISTORY_BATCH, items.length - displayedHistoryCount)}) · Всего ${items.length} ↓
          </button>
        </li>`;
    }

    listEl.innerHTML = itemsHtml + footerHtml;

    // Attach listeners
    const moreBtn = document.getElementById("btn-addon-load-more");
    if (moreBtn) {
      moreBtn.onclick = () => {
        displayedHistoryCount += HISTORY_BATCH;
        renderHistoryList();
      };
    }

    listEl.querySelectorAll(".addon-history-item").forEach(itemEl => {
      const trackId = parseInt(itemEl.dataset.trackId, 10);
      const titleEl = itemEl.querySelector("div[style*='font-weight: 600']");
      const title = titleEl ? titleEl.textContent.trim() : "";

      itemEl.onclick = (e) => {
        if (e.target.closest(".addon-hist-actions")) return;
        playHistoryTrack(trackId, title);
      };

      const favBtn = itemEl.querySelector(".addon-btn-hist-fav");
      if (favBtn) {
        favBtn.onclick = (e) => {
          e.stopPropagation();
          toggleFavInHistory(trackId, favBtn);
        };
      }

      const pinBtn = itemEl.querySelector(".addon-btn-hist-pin");
      if (pinBtn) {
        pinBtn.onclick = (e) => {
          e.stopPropagation();
          const isPinned = pinBtn.dataset.pinned === "1";
          togglePinInHistory(trackId, pinBtn, isPinned);
        };
      }
    });
  }

  function injectRadioHistory() {
    const queuePanel = document.querySelector(".queue-panel");
    if (!queuePanel || document.getElementById("addon-queue-tab-bar")) return;

    // Inject history hover styles once
    if (!document.getElementById("addon-history-style-tag")) {
      const st = document.createElement("style");
      st.id = "addon-history-style-tag";
      st.textContent = `
        .addon-history-item:hover { background: rgba(255,255,255,0.06) !important; }
        .addon-history-item:hover .addon-play-icon { color: var(--accent, #e07a3a) !important; transform: scale(1.18); }
        .addon-btn-hist-fav:hover { transform: scale(1.22); }
        .addon-btn-hist-pin:hover { transform: scale(1.22); }
        .addon-src-badge { white-space: nowrap; line-height: 1.2; vertical-align: middle; }
      `;
      document.head.appendChild(st);
    }

    const queueHead = queuePanel.querySelector(".queue-head");
    const playlistEl = document.getElementById("playlist");
    const queueEl = document.getElementById("queue");

    // 1. Create Tab Bar (Queue, History, 3.2M Catalog)
    const tabBar = document.createElement("div");
    tabBar.id = "addon-queue-tab-bar";
    tabBar.style.cssText = "display:flex; gap:5px; margin:4px 0 10px 0; background:rgba(0,0,0,0.28); padding:3px; border-radius:12px; border:1px solid rgba(255,255,255,0.08);";

    tabBar.innerHTML = `
      <button type="button" id="addon-tab-queue" style="flex:1; padding:6px 6px; border:none; border-radius:9px; background:rgba(224,122,58,0.22); color:#f7f0e8; font-size:0.80rem; font-weight:600; cursor:pointer; display:flex; align-items:center; justify-content:center; gap:4px; transition:all 0.2s;">
        <span>⏭ Очередь</span>
        <span id="addon-queue-cnt" style="background:rgba(224,122,58,0.35); color:#fff; padding:1px 5px; border-radius:10px; font-size:0.70rem;">0</span>
      </button>
      <button type="button" id="addon-tab-history" style="flex:1; padding:6px 6px; border:none; border-radius:9px; background:transparent; color:var(--muted,#a89f91); font-size:0.80rem; font-weight:600; cursor:pointer; display:flex; align-items:center; justify-content:center; gap:4px; transition:all 0.2s;">
        <span>⏮ История</span>
        <span id="addon-hist-cnt" style="background:rgba(56,189,248,0.2); color:#38bdf8; padding:1px 5px; border-radius:10px; font-size:0.70rem;">0</span>
      </button>
      <button type="button" id="addon-tab-catalog" style="flex:1.15; padding:6px 6px; border:none; border-radius:9px; background:transparent; color:var(--muted,#a89f91); font-size:0.80rem; font-weight:600; cursor:pointer; display:flex; align-items:center; justify-content:center; gap:4px; transition:all 0.2s;" title="Поиск по 3.27 млн треков с моментальным стримингом">
        <span>🔍 Каталог 3.2M</span>
      </button>
    `;

    // 2. Create History Search Box & List
    const searchWrap = document.createElement("div");
    searchWrap.id = "addon-hist-search-wrap";
    searchWrap.style.cssText = "display:none; margin: 4px 0 8px 0;";
    searchWrap.innerHTML = `
      <input type="search" id="addon-hist-search" placeholder="🔍 Найти в истории (артист, трек, 512D, 12D)..." style="width:100%; box-sizing:border-box; padding:6px 12px; border-radius:10px; background:rgba(0,0,0,0.35); border:1px solid rgba(255,255,255,0.12); color:#f7f0e8; font-size:0.82rem; outline:none;" />
    `;

    const searchInput = searchWrap.querySelector("#addon-hist-search");
    if (searchInput) {
      searchInput.oninput = (e) => {
        historySearchQuery = e.target.value.trim();
        displayedHistoryCount = 50;
        renderHistoryList();
      };
    }

    const historyList = document.createElement("ol");
    historyList.id = "addon-history-list";
    historyList.className = "playlist";
    historyList.style.display = "none";

    historyList.onscroll = () => {
      if (historyList.scrollTop + historyList.clientHeight >= historyList.scrollHeight - 80) {
        if (displayedHistoryCount < cachedFullHistory.length) {
          displayedHistoryCount += HISTORY_BATCH;
          renderHistoryList();
        }
      }
    };

    // 3. Create 3.2M Catalog Search Box & List
    const catalogWrap = document.createElement("div");
    catalogWrap.id = "addon-cat-search-wrap";
    catalogWrap.style.cssText = "display:none; margin: 4px 0 8px 0;";
    catalogWrap.innerHTML = `
      <div style="position:relative; display:flex; align-items:center;">
        <input type="search" id="addon-cat-search-input" placeholder="🔍 Поиск трека или артиста (Queen, Hans Zimmer, Rock)..." style="width:100%; box-sizing:border-box; padding:7px 30px 7px 12px; border-radius:10px; background:rgba(0,0,0,0.45); border:1px solid rgba(234,179,8,0.35); color:#f7f0e8; font-size:0.82rem; outline:none;" />
        <span id="addon-cat-spinner" style="position:absolute; right:10px; font-size:0.75rem; display:none;">⚡</span>
      </div>
      <div style="display:flex; justify-content:space-between; align-items:center; margin:5px 2px 2px 2px; font-size:0.72rem; color:var(--muted,#a89f91);">
        <span>⚡ 3,277,692 трека · Поиск ~2 мс</span>
        <button type="button" id="btn-trigger-online-search" class="btn quiet sm" style="font-size:0.70rem; padding:1px 8px; border-radius:6px; color:#38bdf8; background:rgba(56,189,248,0.12); border:1px solid rgba(56,189,248,0.25); cursor:pointer;" title="Искать в Google & YouTube Music">🌐 Google Music</button>
      </div>
      <div id="addon-cat-chips" style="display:flex; flex-wrap:wrap; gap:4px; margin-top:6px;">
        <span style="font-size:0.70rem; color:var(--muted,#a89f91); padding:2px 0;">Примеры:</span>
        <button type="button" class="btn quiet sm addon-cat-chip" data-q="Queen" style="padding:1px 6px; font-size:0.70rem; border-radius:6px; cursor:pointer;">Queen</button>
        <button type="button" class="btn quiet sm addon-cat-chip" data-q="Hans Zimmer" style="padding:1px 6px; font-size:0.70rem; border-radius:6px; cursor:pointer;">Hans Zimmer</button>
        <button type="button" class="btn quiet sm addon-cat-chip" data-q="Metallica" style="padding:1px 6px; font-size:0.70rem; border-radius:6px; cursor:pointer;">Metallica</button>
        <button type="button" class="btn quiet sm addon-cat-chip" data-q="Daft Punk" style="padding:1px 6px; font-size:0.70rem; border-radius:6px; cursor:pointer;">Daft Punk</button>
        <button type="button" class="btn quiet sm addon-cat-chip" data-q="Chopin" style="padding:1px 6px; font-size:0.70rem; border-radius:6px; cursor:pointer;">Chopin</button>
      </div>
    `;

    const catalogList = document.createElement("ol");
    catalogList.id = "addon-catalog-list";
    catalogList.className = "playlist";
    catalogList.style.display = "none";

    let catDebounceTimer = null;
    const catInput = catalogWrap.querySelector("#addon-cat-search-input");
    const catSpinner = catalogWrap.querySelector("#addon-cat-spinner");
    const catStat = catalogWrap.querySelector("#addon-cat-stat");
    const chipsWrap = catalogWrap.querySelector("#addon-cat-chips");
    const triggerOnlineBtn = catalogWrap.querySelector("#btn-trigger-online-search");

    if (triggerOnlineBtn) {
      triggerOnlineBtn.onclick = () => {
        const val = catInput ? catInput.value.trim() : "";
        if (val) performOnlineSearch(val);
        else toast("Введите запрос для поиска в Google Music");
      };
    }

    async function performOnlineSearch(q) {
      q = (q || (catInput ? catInput.value : "")).trim();
      if (!q) return;
      if (catSpinner) catSpinner.style.display = "inline";
      if (catStat) catStat.textContent = `🌐 Поиск в Google / YouTube Music...`;
      try {
        const res = await fetch(`${API_BASE}/api/v1/catalog/search-online?q=${encodeURIComponent(q)}&limit=10`);
        const data = await res.json();
        if (catSpinner) catSpinner.style.display = "none";
        if (catStat) catStat.textContent = `Google Music: ${data.count || 0} треков`;

        if (!data.tracks || data.tracks.length === 0) {
          catalogList.innerHTML = `<li style="padding:18px 10px; text-align:center; color:var(--muted,#a89f91); font-size:0.82rem; list-style:none;">В Google Music ничего не найдено по «${escapeHtml(q)}».</li>`;
          return;
        }

        renderCatalogList(data.tracks.map(t => ({
          ...t,
          genre: "Google / YT Music",
          is_online: true
        })));
      } catch (err) {
        if (catSpinner) catSpinner.style.display = "none";
        catalogList.innerHTML = `<li style="padding:12px 10px; text-align:center; color:#f87171; font-size:0.80rem; list-style:none;">Ошибка онлайн-поиска: ${err.message}</li>`;
      }
    }

    async function performCatalogSearch(q) {
      q = (q || "").trim();
      if (!q) {
        catalogList.innerHTML = `<li style="padding:16px 10px; text-align:center; color:var(--muted,#a89f91); font-size:0.80rem; list-style:none;">Введите название трека или артиста для мгновенного поиска по базе 3.27 млн треков или нажмите кнопку 🌐 Google Music.</li>`;
        if (catStat) catStat.textContent = "";
        return;
      }
      if (catSpinner) catSpinner.style.display = "inline";

      const startTime = performance.now();
      try {
        const res = await fetch(`${API_BASE}/api/v1/catalog/search?q=${encodeURIComponent(q)}&limit=50`);
        const data = await res.json();
        const duration = Math.round(performance.now() - startTime);

        if (catSpinner) catSpinner.style.display = "none";
        const count = data.count || 0;
        if (catStat) catStat.textContent = `Найдено: ${count} (${duration} мс)`;

        if (!data.tracks || data.tracks.length === 0) {
          catalogList.innerHTML = `
            <li style="padding:18px 10px; text-align:center; color:var(--muted,#a89f91); font-size:0.82rem; list-style:none;">
              <div>В локальной базе 3.27M ничего не найдено по «${escapeHtml(q)}».</div>
              <div style="margin-top:12px;">
                <button type="button" id="btn-empty-online-search" class="btn quiet sm" style="padding:6px 14px; border-radius:99px; background:rgba(56,189,248,0.18); border:1px solid rgba(56,189,248,0.4); color:#38bdf8; font-weight:700; cursor:pointer;">
                  🌐 Искать в Google / YouTube Music
                </button>
              </div>
            </li>
          `;
          const emptyBtn = catalogList.querySelector("#btn-empty-online-search");
          if (emptyBtn) emptyBtn.onclick = () => performOnlineSearch(q);
          return;
        }

        renderCatalogList(data.tracks);
      } catch (err) {
        if (catSpinner) catSpinner.style.display = "none";
        catalogList.innerHTML = `<li style="padding:12px 10px; text-align:center; color:#f87171; font-size:0.80rem; list-style:none;">Ошибка поиска: ${err.message}</li>`;
      }
    }

    function renderCatalogList(tracks) {
      catalogList.innerHTML = tracks.map(t => {
        let genreBadge = t.is_online 
          ? `<span style="background:rgba(56,189,248,0.18); color:#38bdf8; border:1px solid rgba(56,189,248,0.3); padding:1px 5px; border-radius:5px; font-size:0.68rem; font-weight:600;">🌐 Google Music</span>`
          : (t.genre ? `<span style="background:rgba(255,255,255,0.08); padding:1px 5px; border-radius:5px; font-size:0.68rem; color:#cbd5e1;">${escapeHtml(t.genre)}</span>` : "");
        let acousticBadge = typeof t.energy === "number" ? `<span style="color:#fbbf24; font-size:0.68rem;" title="Энергия: ${t.energy}%, Темп: ${t.tempo || 'н/д'} BPM">⚡ ${t.energy}%</span>` : "";
        let localBadge = t.is_local ? `<span style="background:rgba(34,197,94,0.15); color:#22c55e; border:1px solid rgba(34,197,94,0.3); padding:1px 5px; border-radius:5px; font-size:0.68rem; font-weight:600;" title="Трек уже в локальной коллекции">💿 В коллекции</span>` : "";

        return `
          <li class="addon-catalog-item" data-id="${t.id}" data-artist="${escapeHtml(t.artist)}" data-title="${escapeHtml(t.title)}" data-album="${escapeHtml(t.album)}" data-duration="${t.duration_sec}" style="display:flex; align-items:center; gap:8px; padding:7px 10px; border-radius:8px; margin-bottom:3px; cursor:pointer; transition:background 0.15s; background:rgba(255,255,255,0.02); border-bottom:1px solid rgba(255,255,255,0.04);">
            <div class="addon-play-icon" style="color:var(--muted,#a89f91); font-size:0.88rem; width:18px; text-align:center; flex-shrink:0; transition:transform 0.15s, color 0.15s;" title="Слушать сейчас">
              ▶
            </div>
            <div style="flex:1; min-width:0; display:flex; flex-direction:column; gap:2px;">
              <div style="font-weight:600; font-size:0.86rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; color:var(--fg,#f7f0e8);">
                ${escapeHtml(t.title)}
              </div>
              <div style="font-size:0.75rem; color:var(--muted,#a89f91); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; display:flex; align-items:center; gap:6px;">
                <span style="overflow:hidden; text-overflow:ellipsis;">${escapeHtml(t.artist)}</span>
                ${genreBadge}
                ${acousticBadge}
                ${localBadge}
              </div>
            </div>
            <div style="display:flex; align-items:center; gap:6px;" class="addon-cat-actions">
              <span style="font-size:0.74rem; color:var(--muted,#a89f91); font-variant-numeric:tabular-nums;">${fmtTime(t.duration_sec)}</span>
              <button type="button" class="addon-btn-cat-queue" title="Добавить в очередь" style="background:transparent; border:none; cursor:pointer; font-size:1.05rem; padding:2px 4px; color:rgba(255,255,255,0.4); line-height:1; transition:all 0.15s;">＋</button>
            </div>
          </li>
        `;
      }).join("");

      // Bind play and queue clicks
      catalogList.querySelectorAll(".addon-catalog-item").forEach(itemEl => {
        const artist = itemEl.dataset.artist || "";
        const title = itemEl.dataset.title || "";
        const album = itemEl.dataset.album || "";
        const duration_sec = parseInt(itemEl.dataset.duration || "180", 10);
        const id = parseInt(itemEl.dataset.id || "0", 10);

        itemEl.onclick = async (e) => {
          if (e.target.closest(".addon-cat-actions")) return;
          try {
            toast(`⚡ Запуск из базы 3.2M: ${artist} - ${title}...`);
            const res = await fetch(`${API_BASE}/api/v1/catalog/play`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ artist, title, album, duration_sec, id })
            });
            const data = await res.json();
            if (data.success && data.track_id) {
              playHistoryTrack(data.track_id, `${artist} - ${title}`);
            } else {
              toast("Ошибка запуска: " + (data.error || "не удалось запустить"));
            }
          } catch (err) {
            toast("Ошибка: " + err.message);
          }
        };

        const qBtn = itemEl.querySelector(".addon-btn-cat-queue");
        if (qBtn) {
          qBtn.onclick = async (e) => {
            e.stopPropagation();
            qBtn.style.opacity = "0.5";
            try {
              const res = await fetch(`${API_BASE}/api/v1/catalog/queue`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ artist, title, album, duration_sec, id })
              });
              const data = await res.json();
              if (data.success) {
                qBtn.textContent = "✓";
                qBtn.style.color = "#22c55e";
                toast(`+ Добавлено в очередь: ${title}`);
                if (typeof window.renderQueue === "function" && Array.isArray(data.queue)) {
                  window.renderQueue(data.queue);
                }
                setTimeout(() => {
                  qBtn.textContent = "＋";
                  qBtn.style.color = "rgba(255,255,255,0.4)";
                  qBtn.style.opacity = "1";
                }, 2000);
              }
            } catch (err) {
              toast("Ошибка: " + err.message);
              qBtn.style.opacity = "1";
            }
          };
        }
      });
    }

    if (catInput) {
      catInput.oninput = (e) => {
        clearTimeout(catDebounceTimer);
        const val = e.target.value.trim();
        catDebounceTimer = setTimeout(() => performCatalogSearch(val), 200);
      };
    }

    if (chipsWrap) {
      chipsWrap.querySelectorAll(".addon-cat-chip").forEach(btn => {
        btn.onclick = () => {
          const q = btn.dataset.q || btn.textContent.trim();
          if (catInput) {
            catInput.value = q;
            performCatalogSearch(q);
          }
        };
      });
    }

    // Insert Elements into queuePanel
    if (queueHead && queueHead.nextSibling) {
      queuePanel.insertBefore(tabBar, queueHead.nextSibling);
    } else {
      queuePanel.prepend(tabBar);
    }

    queuePanel.insertBefore(searchWrap, queueEl ? queueEl.nextSibling : null);
    queuePanel.insertBefore(historyList, searchWrap.nextSibling);
    queuePanel.insertBefore(catalogWrap, historyList.nextSibling);
    queuePanel.insertBefore(catalogList, catalogWrap.nextSibling);

    // Tab switcher actions
    const tabQ = document.getElementById("addon-tab-queue");
    const tabH = document.getElementById("addon-tab-history");
    const tabC = document.getElementById("addon-tab-catalog");

    tabQ.onclick = () => {
      activeQueueTab = "queue";
      tabQ.style.background = "rgba(224,122,58,0.22)";
      tabQ.style.color = "#f7f0e8";
      tabH.style.background = "transparent";
      tabH.style.color = "var(--muted,#a89f91)";
      if (tabC) {
        tabC.style.background = "transparent";
        tabC.style.color = "var(--muted,#a89f91)";
      }

      searchWrap.style.display = "none";
      historyList.style.display = "none";
      catalogWrap.style.display = "none";
      catalogList.style.display = "none";
      if (playlistEl) playlistEl.style.removeProperty("display");
      if (queueEl) queueEl.style.removeProperty("display");
    };

    tabH.onclick = () => {
      activeQueueTab = "history";
      tabH.style.background = "rgba(56,189,248,0.22)";
      tabH.style.color = "#38bdf8";
      tabQ.style.background = "transparent";
      tabQ.style.color = "var(--muted,#a89f91)";
      if (tabC) {
        tabC.style.background = "transparent";
        tabC.style.color = "var(--muted,#a89f91)";
      }

      if (playlistEl) playlistEl.style.display = "none";
      if (queueEl) queueEl.style.display = "none";
      catalogWrap.style.display = "none";
      catalogList.style.display = "none";
      searchWrap.style.display = "block";
      historyList.style.display = "block";

      loadRadioHistory();
    };

    if (tabC) {
      tabC.onclick = () => {
        activeQueueTab = "catalog";
        tabC.style.background = "rgba(234,179,8,0.22)";
        tabC.style.color = "#fbbf24";
        tabQ.style.background = "transparent";
        tabQ.style.color = "var(--muted,#a89f91)";
        tabH.style.background = "transparent";
        tabH.style.color = "var(--muted,#a89f91)";

        if (playlistEl) playlistEl.style.display = "none";
        if (queueEl) queueEl.style.display = "none";
        searchWrap.style.display = "none";
        historyList.style.display = "none";
        catalogWrap.style.display = "block";
        catalogList.style.display = "block";

        if (catInput && !catInput.value.trim()) {
          catInput.focus();
          performCatalogSearch("");
        }
      };
    }

    // Auto-refresh history, origin badges, and queue on track events
    const audioEl = document.getElementById("audio");
    if (audioEl) {
      audioEl.addEventListener("ended", () => {
        setTimeout(loadRadioHistory, 800);
        setTimeout(updateNowPlayingOrigin, 800);
        setTimeout(updateQueueOrigins, 1000);
      });
      audioEl.addEventListener("loadedmetadata", () => {
        setTimeout(loadRadioHistory, 600);
        setTimeout(updateNowPlayingOrigin, 200);
        setTimeout(updateQueueOrigins, 600);
      });
      audioEl.addEventListener("play", () => {
        setTimeout(updateNowPlayingOrigin, 100);
        setTimeout(updateQueueOrigins, 500);
      });
    }
    const skipBtn = document.getElementById("btn-skip");
    if (skipBtn) {
      skipBtn.addEventListener("click", () => {
        setTimeout(loadRadioHistory, 800);
        setTimeout(updateNowPlayingOrigin, 800);
        setTimeout(updateQueueOrigins, 1000);
      });
    }

    loadRadioHistory();
  }

  // Periodic polling for non-queue UI elements only
  // NOTE: updateQueueOrigins is intentionally NOT here — it runs reactively
  //       after each real queue DOM rebuild to prevent 2-second strobe flicker.
  setInterval(() => {
    hookPlayerFunctions();
    injectHeaderBadge();
    injectPinButton();
    injectHomeBanner();
    injectUploadSection();
    injectRadioHistory();
    injectRadioSliders();
    updateCacheStats();
    updateIngestionStatus();
    updateNowPlayingOrigin();

    // Keep active tab state consistent
    if (activeQueueTab === "history") {
      const p = document.getElementById("playlist");
      const q = document.getElementById("queue");
      if (p) p.style.display = "none";
      if (q) q.style.display = "none";
    } else if (activeQueueTab === "catalog") {
      const p = document.getElementById("playlist");
      const q = document.getElementById("queue");
      if (p) p.style.display = "none";
      if (q) q.style.display = "none";
      const hWrap = document.getElementById("addon-hist-search-wrap");
      const hList = document.getElementById("addon-history-list");
      if (hWrap) hWrap.style.display = "none";
      if (hList) hList.style.display = "none";
    }
    loadRadioHistory();
  }, 2000);

  // Initial attempt
  setTimeout(() => {
    hookPlayerFunctions();
    injectHeaderBadge();
    injectPinButton();
    injectHomeBanner();
    injectUploadSection();
    injectRadioHistory();
    injectRadioSliders();
    updateCacheStats();
    updateNowPlayingOrigin();
    updateQueueOrigins();
  }, 300);

})();
