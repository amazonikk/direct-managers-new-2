(() => {
  "use strict";

  const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbydqj_VX4h7vxB3iHPJl7GScICmVTDuwVmIRdCqKhDgSYoXvK3Fu6goNp2UFVyoCiMFyw/exec;
  const FALLBACK_URL = "data/report.json";
  const AUTO_REFRESH_MS = 5 * 60 * 1000;

  const ACCOUNT_PALETTE = [
    "#4f46e5", "#ec4899", "#059669", "#d97706", "#0891b2", "#7c3aed",
    "#dc2626", "#2563eb", "#65a30d", "#c026d3", "#0f766e", "#ea580c",
    "#475569", "#9333ea", "#0284c7", "#be123c", "#15803d", "#a16207"
  ];

  const PLATFORM_ORDER = ["TikTok", "Instagram", "Facebook", "Telegram", "YouTube", "Email", "Інше"];

  const fmt = new Intl.NumberFormat("uk-UA", { maximumFractionDigits: 0 });
  const dateFmt = new Intl.DateTimeFormat("uk-UA", { day: "2-digit", month: "2-digit", year: "numeric" });
  const shortDateFmt = new Intl.DateTimeFormat("uk-UA", { day: "2-digit", month: "2-digit" });
  const monthFmt = new Intl.DateTimeFormat("uk-UA", { month: "long", year: "numeric" });
  const shortMonthFmt = new Intl.DateTimeFormat("uk-UA", { month: "short", year: "2-digit" });

  const state = {
    report: null,
    managerId: "all",
    granularity: "month",
    activeWeekId: null,
    focusValue: null,
    platform: "Усі",
    selectedAccounts: new Set(),
    accountSearch: "",
    accountSort: "numbers-desc",
    loading: false
  };

  const dom = {};

  document.addEventListener("DOMContentLoaded", init);

  function init() {
    cacheDom();
    bindEvents();
    showLoading();
    loadReport({ initial: true });
    window.setInterval(() => loadReport({ silent: true }), AUTO_REFRESH_MS);
  }

  function cacheDom() {
    [
      "syncStatus", "refreshButton", "managerTabs", "granularityTabs",
      "periodPrev", "periodNext", "periodSelectWrap", "platformChips",
      "accountFilter", "accountSelectionSummary", "accountSearch",
      "selectAll", "clearAll", "accountGroups", "dataNotice", "kpiGrid",
      "comparisonSubtitle", "comparisonGrid", "numbersChart", "chatsChart",
      "commentsChart", "conversionChart", "numbersChartSubtitle",
      "chatsChartSubtitle", "accountsTableBody", "mobileAccountCards",
      "accountSort", "monthWeeksSection", "monthWeeksGrid", "monthWeeksTitle",
      "weekDetailModal", "weekDetailBackdrop", "weekDetailClose",
      "weekDetailTitle", "weekDetailSubtitle", "weekDetailContent"
    ].forEach((id) => {
      dom[id] = document.getElementById(id);
    });
  }

  function bindEvents() {
    dom.refreshButton.addEventListener("click", () => loadReport());

    dom.granularityTabs.querySelectorAll("[data-granularity]").forEach((button) => {
      button.addEventListener("click", () => {
        const next = button.dataset.granularity;
        if (next === state.granularity) return;
        state.granularity = next;
        resetFocusToLatest();
        renderAll();
      });
    });

    dom.periodPrev.addEventListener("click", () => movePeriod(-1));
    dom.periodNext.addEventListener("click", () => movePeriod(1));

    dom.accountSearch.addEventListener("input", () => {
      state.accountSearch = dom.accountSearch.value.trim().toLocaleLowerCase();
      renderAccountFilter();
    });

    dom.selectAll.addEventListener("click", () => {
      getVisibleFilterEntries().forEach(({ account }) => state.selectedAccounts.add(account.id));
      renderAll();
    });

    dom.clearAll.addEventListener("click", () => {
      getVisibleFilterEntries().forEach(({ account }) => state.selectedAccounts.delete(account.id));
      renderAll();
    });

    dom.accountSort.addEventListener("change", () => {
      state.accountSort = dom.accountSort.value;
      renderAccountsAnalytics();
    });

    dom.weekDetailClose.addEventListener("click", closeWeekDetail);
    dom.weekDetailBackdrop.addEventListener("click", closeWeekDetail);
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && state.activeWeekId !== null) closeWeekDetail();
    });

    window.addEventListener("resize", debounce(() => {
      if (!state.report) return;
      renderCharts();
    }, 140));
  }

  async function loadReport({ initial = false, silent = false } = {}) {
    if (state.loading) return;
    state.loading = true;
    dom.refreshButton.disabled = true;

    if (!silent || initial) {
      setSyncStatus("loading", "Оновлюю дані…");
    }

    try {
      const report = await loadAppsScriptReport();
      normalizeReport(report);

      const previousManager = state.managerId;
      const previousSelection = new Set(state.selectedAccounts);
      state.report = report;

      if (previousManager !== "all" && !report.managers.some((manager) => manager.id === previousManager)) {
        state.managerId = "all";
      }

      const validIds = new Set(getEntriesForManagerScope().map(({ account }) => account.id));
      state.selectedAccounts = new Set([...previousSelection].filter((id) => validIds.has(id)));

      if (initial || state.selectedAccounts.size === 0) {
        selectAllInManagerScope();
      }

      ensurePlatformValid();
      resetFocusToLatest({ keepIfValid: !initial });
      renderAll();
      setSyncStatus("ok", `Оновлено · ${formatGeneratedAt(report.generatedAt)}`);
    } catch (error) {
      console.error(error);
      try {
        const response = await fetch(`${FALLBACK_URL}?v=${Date.now()}`, { cache: "no-store" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const report = await response.json();
        normalizeReport(report);
        state.report = report;
        selectAllInManagerScope();
        ensurePlatformValid();
        resetFocusToLatest();
        renderAll();
        setSyncStatus("error", "Живі дані недоступні — резервна копія");
        showNotice(`Apps Script недоступний: ${error.message || error}. Коментарі можуть бути відсутні у старій резервній копії.`, true);
      } catch (fallbackError) {
        console.error(fallbackError);
        setSyncStatus("error", "Не вдалося завантажити дані");
        showFatalError(error.message || "Не вдалося отримати дані.");
      }
    } finally {
      state.loading = false;
      dom.refreshButton.disabled = false;
    }
  }

  function loadAppsScriptReport() {
    return new Promise((resolve, reject) => {
      const callbackName = `__directManagersV2_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const script = document.createElement("script");
      let settled = false;

      const cleanup = () => {
        delete window[callbackName];
        script.remove();
      };

      const timeout = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error("Apps Script не відповів протягом 40 секунд."));
      }, 40000);

      window[callbackName] = (payload) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        cleanup();

        if (!payload || typeof payload !== "object") {
          reject(new Error("Apps Script повернув некоректну відповідь."));
          return;
        }
        if (payload.error) {
          reject(new Error(payload.error));
          return;
        }
        resolve(payload);
      };

      script.onerror = () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        cleanup();
        reject(new Error("Не вдалося відкрити Apps Script Web App."));
      };

      const separator = APPS_SCRIPT_URL.includes("?") ? "&" : "?";
      script.src = `${APPS_SCRIPT_URL}${separator}callback=${encodeURIComponent(callbackName)}&v=${Date.now()}`;
      script.async = true;
      document.head.appendChild(script);
    });
  }

  function normalizeReport(report) {
    if (!report || !Array.isArray(report.managers)) {
      throw new Error("Неправильна структура звіту.");
    }

    let colorIndex = 0;

    report.managers.forEach((manager) => {
      manager.accounts = Array.isArray(manager.accounts) ? manager.accounts : [];

      manager.accounts.forEach((account) => {
        account.managerId = manager.id;
        account.managerName = manager.name;
        account.platform = account.platform || "Інше";
        account.color = ACCOUNT_PALETTE[colorIndex % ACCOUNT_PALETTE.length];
        colorIndex += 1;

        account.records = Array.isArray(account.records) ? account.records : [];
        account.records = account.records
          .filter((record) => record && isIsoDate(record.date))
          .map((record) => ({
            date: record.date,
            chats: numeric(record.chats),
            numbers: numeric(record.numbers),
            comments: numeric(record.comments)
          }))
          .sort((a, b) => a.date.localeCompare(b.date));

        account.metrics = {
          chats: account.metrics ? Boolean(account.metrics.chats) : account.records.some((record) => Object.prototype.hasOwnProperty.call(record, "chats")),
          numbers: account.metrics ? Boolean(account.metrics.numbers) : account.records.some((record) => Object.prototype.hasOwnProperty.call(record, "numbers")),
          comments: account.metrics ? Boolean(account.metrics.comments) : false
        };
      });
    });
  }

  function renderAll() {
    if (!state.report) return;

    ensurePlatformValid();
    ensureFocusValid();

    renderManagerTabs();
    renderGranularityTabs();
    renderPeriodPicker();
    renderPlatformChips();
    renderAccountFilter();
    renderNotice();
    renderKpis();
    renderMonthlyWeeks();
    renderComparison();
    renderCharts();
    renderAccountsAnalytics();
    if (state.activeWeekId !== null) renderWeekDetail();
  }

  function renderManagerTabs() {
    const items = [{ id: "all", name: "Загалом" }, ...state.report.managers];
    dom.managerTabs.innerHTML = "";

    items.forEach((item) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `segment${state.managerId === item.id ? " active" : ""}`;
      button.textContent = item.name;
      button.addEventListener("click", () => {
        if (state.managerId === item.id) return;
        state.managerId = item.id;
        state.platform = "Усі";
        state.accountSearch = "";
        dom.accountSearch.value = "";
        selectAllInManagerScope();
        resetFocusToLatest();
        renderAll();
      });
      dom.managerTabs.appendChild(button);
    });
  }

  function renderGranularityTabs() {
    dom.granularityTabs.querySelectorAll("[data-granularity]").forEach((button) => {
      button.classList.toggle("active", button.dataset.granularity === state.granularity);
    });
  }

  function renderPeriodPicker() {
    const bounds = getDateBounds();
    if (!bounds) {
      dom.periodSelectWrap.innerHTML = '<select disabled><option>Немає даних</option></select>';
      dom.periodPrev.disabled = true;
      dom.periodNext.disabled = true;
      return;
    }

    if (state.granularity === "day") {
      dom.periodSelectWrap.innerHTML = `
        <input id="periodInput" type="date" min="${bounds.min}" max="${bounds.max}" value="${state.focusValue || bounds.max}">
      `;
      const input = document.getElementById("periodInput");
      input.addEventListener("change", () => {
        if (!isIsoDate(input.value)) return;
        state.focusValue = input.value;
        renderAll();
      });
    } else {
      const options = state.granularity === "week" ? getWeekOptions(bounds) : getMonthOptions(bounds);
      dom.periodSelectWrap.innerHTML = `
        <select id="periodSelect">
          ${options.map((option) => `
            <option value="${option.value}"${option.value === state.focusValue ? " selected" : ""}>${escapeHtml(option.label)}</option>
          `).join("")}
        </select>
      `;
      const select = document.getElementById("periodSelect");
      select.addEventListener("change", () => {
        state.focusValue = select.value;
        renderAll();
      });
    }

    const previousValue = adjacentFocusValue(-1);
    const nextValue = adjacentFocusValue(1);
    dom.periodPrev.disabled = !isFocusWithinBounds(previousValue, bounds);
    dom.periodNext.disabled = !isFocusWithinBounds(nextValue, bounds);
  }

  function renderPlatformChips() {
    const platforms = getAvailablePlatforms();
    dom.platformChips.innerHTML = "";

    ["Усі", ...platforms].forEach((platform) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `platform-chip${state.platform === platform ? " active" : ""}`;
      button.textContent = platform === "Усі" ? "Усі" : platform;
      button.addEventListener("click", () => {
        if (state.platform === platform) return;
        state.platform = platform;
        renderAll();
      });
      dom.platformChips.appendChild(button);
    });
  }

  function renderAccountFilter() {
    const entries = getVisibleFilterEntries();
    const activeEntries = getActiveEntries();
    const managerScopeEntries = getEntriesForManagerScope();
    const selectedInManagerScope = managerScopeEntries.filter(({ account }) => state.selectedAccounts.has(account.id)).length;

    dom.accountSelectionSummary.textContent = `${selectedInManagerScope} із ${managerScopeEntries.length} вибрано`;
    dom.accountGroups.innerHTML = "";

    if (!entries.length) {
      dom.accountGroups.innerHTML = '<div class="chart-empty">За цим пошуком акаунтів немає.</div>';
      return;
    }

    const groups = new Map();
    entries.forEach((entry) => {
      const key = entry.account.platform || "Інше";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(entry);
    });

    [...groups.entries()]
      .sort(([a], [b]) => platformRank(a) - platformRank(b) || a.localeCompare(b, "uk"))
      .forEach(([platform, platformEntries]) => {
        const group = document.createElement("div");
        group.className = "account-group";

        const title = document.createElement("div");
        title.className = "account-group-title";
        title.innerHTML = `<span>${escapeHtml(platform)}</span><span>${platformEntries.length}</span>`;
        group.appendChild(title);

        const list = document.createElement("div");
        list.className = "account-checkboxes";

        platformEntries
          .sort((a, b) => a.account.name.localeCompare(b.account.name, "uk"))
          .forEach(({ manager, account }) => {
            const label = document.createElement("label");
            label.className = "account-checkbox";

            const checkbox = document.createElement("input");
            checkbox.type = "checkbox";
            checkbox.checked = state.selectedAccounts.has(account.id);
            checkbox.addEventListener("change", () => {
              if (checkbox.checked) state.selectedAccounts.add(account.id);
              else state.selectedAccounts.delete(account.id);
              renderAll();
            });

            const name = document.createElement("span");
            name.title = account.name;
            name.textContent = state.managerId === "all"
              ? `${account.name} · ${manager.name}`
              : account.name;

            label.appendChild(checkbox);
            label.appendChild(name);
            list.appendChild(label);
          });

        group.appendChild(list);
        dom.accountGroups.appendChild(group);
      });

    // Якщо фільтр платформи не має жодного активного вибраного акаунта,
    // інтерфейс лишається валідним і показує нульові KPI.
    void activeEntries;
  }

  function renderNotice() {
    const active = getActiveEntries();
    const bounds = getDateBounds(active.length ? active : getEntriesForManagerScope());
    if (!bounds) {
      showNotice("Для вибраного набору акаунтів немає даних.", false);
      return;
    }

    const range = getFocusRange();
    showNotice(
      `<strong>${escapeHtml(periodLabel(range))}.</strong> Вибрано ${active.length} ${plural(active.length, "акаунт", "акаунти", "акаунтів")}. Остання дата з фактичною активністю: ${dateFmt.format(parseIsoDate(bounds.max))}.`,
      false,
      true
    );
  }

  function renderKpis() {
    const active = getActiveEntries();
    const currentRange = getFocusRange();
    const previousRange = getPreviousRange(currentRange);
    const current = aggregateEntries(active, currentRange);
    const previous = aggregateEntries(active, previousRange);

    const hasChats = active.some(({ account }) => account.metrics.chats);
    const hasNumbers = active.some(({ account }) => account.metrics.numbers);
    const hasComments = active.some(({ account }) => account.metrics.comments);

    const conversion = current.chats > 0 ? current.numbers / current.chats * 100 : 0;
    const previousConversion = previous.chats > 0 ? previous.numbers / previous.chats * 100 : 0;

    const cards = [
      {
        label: "Чати",
        value: hasChats ? fmt.format(current.chats) : "—",
        note: "за обраний період",
        delta: hasChats ? buildDelta(current.chats, previous.chats) : null
      },
      {
        label: "Отримані номери",
        value: hasNumbers ? fmt.format(current.numbers) : "—",
        note: "основний показник лідів",
        delta: hasNumbers ? buildDelta(current.numbers, previous.numbers) : null
      },
      {
        label: "Конверсія",
        value: hasChats && hasNumbers ? `${conversion.toFixed(1)}%` : "—",
        note: "номери ÷ чати",
        delta: hasChats && hasNumbers ? buildPointDelta(conversion, previousConversion) : null
      },
      {
        label: "Оброблено коментарів",
        value: hasComments ? fmt.format(current.comments) : "—",
        note: hasComments ? "RTO / YouTube та інші числові поля" : "у вибраних акаунтів немає цієї метрики",
        delta: hasComments ? buildDelta(current.comments, previous.comments) : null
      },
      {
        label: "Активні акаунти",
        value: fmt.format(active.length),
        note: `${state.platform === "Усі" ? "усі платформи" : state.platform}`,
        delta: null
      }
    ];

    dom.kpiGrid.innerHTML = cards.map((card) => `
      <article class="kpi panel">
        <span class="kpi-label">${escapeHtml(card.label)}</span>
        <strong class="kpi-value">${escapeHtml(card.value)}</strong>
        ${card.delta ? renderDeltaBadge(card.delta) : ""}
        <div class="kpi-note">${escapeHtml(card.note)}</div>
      </article>
    `).join("");
  }

  function renderMonthlyWeeks() {
    if (!dom.monthWeeksSection || !dom.monthWeeksGrid) return;

    if (state.granularity !== "month" || !state.focusValue) {
      dom.monthWeeksSection.hidden = true;
      return;
    }

    dom.monthWeeksSection.hidden = false;
    const active = getActiveEntries();
    const weeks = getMonthWeeks(state.focusValue);
    const activityBounds = getDateBounds(active.length ? active : getEntriesForManagerScope());
    dom.monthWeeksTitle.textContent = `${capitalize(monthFmt.format(parseIsoDate(`${state.focusValue}-01`)))} — по тижнях`;

    dom.monthWeeksGrid.innerHTML = weeks.map((week) => {
      const total = aggregateEntries(active, week);
      const conversion = total.chats ? total.numbers / total.chats * 100 : 0;
      const hasActivity = rangeHasActivity(active, week);
      const isFuture = activityBounds && week.start > activityBounds.max;
      const statusText = isFuture ? "ще немає даних" : hasActivity ? "є дані" : "0 активності";

      return `
        <button class="month-week-card${hasActivity ? " has-data" : " is-empty"}" type="button" data-month-week="${week.id}">
          <div class="month-week-top">
            <div>
              <span class="month-week-number">Тиждень ${week.id}</span>
              <strong>${escapeHtml(week.label)}</strong>
            </div>
            <span class="month-week-status">${escapeHtml(statusText)}</span>
          </div>
          <div class="month-week-flow">
            <div><span>Чати</span><strong>${fmt.format(total.chats)}</strong></div>
            <span class="flow-arrow">→</span>
            <div><span>Номери</span><strong>${fmt.format(total.numbers)}</strong></div>
          </div>
          <div class="month-week-bottom">
            <span>CR <strong>${conversion.toFixed(1)}%</strong></span>
            <span>Коментарі <strong>${fmt.format(total.comments)}</strong></span>
          </div>
          <span class="month-week-open">Відкрити тиждень →</span>
        </button>`;
    }).join("");

    dom.monthWeeksGrid.querySelectorAll("[data-month-week]").forEach((button) => {
      button.addEventListener("click", () => openWeekDetail(Number(button.dataset.monthWeek)));
    });
  }

  function openWeekDetail(weekId) {
    state.activeWeekId = weekId;
    renderWeekDetail();
    dom.weekDetailModal.hidden = false;
    document.body.classList.add("week-drilldown-open");
  }

  function closeWeekDetail() {
    state.activeWeekId = null;
    dom.weekDetailModal.hidden = true;
    document.body.classList.remove("week-drilldown-open");
  }

  function renderWeekDetail() {
    if (state.granularity !== "month" || !state.focusValue || state.activeWeekId === null) {
      if (state.activeWeekId !== null) closeWeekDetail();
      return;
    }

    const week = getMonthWeeks(state.focusValue).find((item) => item.id === state.activeWeekId);
    if (!week) {
      closeWeekDetail();
      return;
    }

    const active = getActiveEntries();
    const total = aggregateEntries(active, week);
    const conversion = total.chats ? total.numbers / total.chats * 100 : 0;

    dom.weekDetailTitle.textContent = `Тиждень ${week.id} · ${week.label}`;
    dom.weekDetailSubtitle.textContent = `${capitalize(monthFmt.format(parseIsoDate(`${state.focusValue}-01`)))} · ${active.length} ${plural(active.length, "акаунт", "акаунти", "акаунтів")}`;

    const dayRows = getDateRange(week.start, week.end).map((date) => {
      const range = { start: date, end: date };
      const day = aggregateEntries(active, range);
      const dayConversion = day.chats ? day.numbers / day.chats * 100 : 0;
      const hasActivity = rangeHasActivity(active, range);
      return { date, ...day, conversion: dayConversion, hasActivity };
    });

    const accountRows = active.map(({ manager, account }) => {
      const current = aggregateAccount(account, week);
      const previousRange = shiftRange(week, -7);
      const previous = aggregateAccount(account, previousRange);
      const accountConversion = current.chats ? current.numbers / current.chats * 100 : 0;
      const trend = account.metrics.numbers ? buildDelta(current.numbers, previous.numbers) : null;
      return { manager, account, current, previous, conversion: accountConversion, trend };
    }).sort((a, b) => b.current.numbers - a.current.numbers || b.current.chats - a.current.chats || a.account.name.localeCompare(b.account.name, "uk"));

    const weekday = new Intl.DateTimeFormat("uk-UA", { weekday: "long" });

    dom.weekDetailContent.innerHTML = `
      <div class="week-detail-kpis">
        <div><span>Чати</span><strong>${fmt.format(total.chats)}</strong></div>
        <div><span>Номери</span><strong>${fmt.format(total.numbers)}</strong></div>
        <div><span>Конверсія</span><strong>${conversion.toFixed(1)}%</strong></div>
        <div><span>Коментарі</span><strong>${fmt.format(total.comments)}</strong></div>
      </div>

      <section class="week-detail-section">
        <div class="week-detail-section-head">
          <div><h3>По днях цього тижня</h3><p>Понеділок → неділя з фактом кожного дня.</p></div>
        </div>
        <div class="week-days-grid">
          ${dayRows.map((day) => `
            <article class="week-day-card${day.hasActivity ? " has-data" : " is-empty"}">
              <div class="week-day-head">
                <div><strong>${escapeHtml(capitalize(weekday.format(parseIsoDate(day.date))))}</strong><span>${escapeHtml(shortDateFmt.format(parseIsoDate(day.date)))}</span></div>
                <button type="button" class="open-day-button" data-open-day="${day.date}">День →</button>
              </div>
              <div class="week-day-metrics">
                <div><span>Чати</span><strong>${fmt.format(day.chats)}</strong></div>
                <div><span>Номери</span><strong>${fmt.format(day.numbers)}</strong></div>
                <div><span>CR</span><strong>${day.conversion.toFixed(1)}%</strong></div>
                <div><span>Коментарі</span><strong>${fmt.format(day.comments)}</strong></div>
              </div>
            </article>`).join("")}
        </div>
      </section>

      <section class="week-detail-section">
        <div class="week-detail-section-head">
          <div><h3>Акаунти за цей тиждень</h3><p>Що конкретно дало номери, а що просіло.</p></div>
        </div>
        <div class="week-account-list">
          ${accountRows.map(({ manager, account, current, previous, conversion: accountConversion, trend }) => `
            <div class="week-account-row">
              <div class="week-account-name"><span class="account-dot" style="background:${account.color}"></span><span><strong>${escapeHtml(account.name)}</strong><small>${escapeHtml(manager.name)} · ${escapeHtml(account.platform)}</small></span></div>
              <div><span>Чати</span><strong>${account.metrics.chats ? fmt.format(current.chats) : "—"}</strong></div>
              <div><span>Номери</span><strong>${account.metrics.numbers ? fmt.format(current.numbers) : "—"}</strong></div>
              <div><span>CR</span><strong>${account.metrics.chats && account.metrics.numbers ? `${accountConversion.toFixed(1)}%` : "—"}</strong></div>
              <div><span>Тренд</span>${trend ? `${renderTrendBadge(trend)}<small>${fmt.format(previous.numbers)} → ${fmt.format(current.numbers)}</small>` : "—"}</div>
            </div>`).join("")}
        </div>
      </section>`;

    dom.weekDetailContent.querySelectorAll("[data-open-day]").forEach((button) => {
      button.addEventListener("click", () => {
        const date = button.dataset.openDay;
        closeWeekDetail();
        state.granularity = "day";
        state.focusValue = date;
        renderAll();
        window.scrollTo({ top: 0, behavior: "smooth" });
      });
    });
  }

  function getMonthWeeks(month) {
    const monthInfo = monthRange(month);
    const weeks = [];
    let start = monthInfo.start;
    let id = 1;

    while (start <= monthInfo.end && id <= 6) {
      const date = parseIsoDate(start);
      const day = date.getDay();
      const daysUntilSunday = day === 0 ? 0 : 7 - day;
      let end = addDays(start, daysUntilSunday);
      if (end > monthInfo.end) end = monthInfo.end;
      weeks.push({
        id,
        start,
        end,
        key: `${month}-w${id}`,
        label: `${shortDateFmt.format(parseIsoDate(start))} – ${shortDateFmt.format(parseIsoDate(end))}`,
        chartLabel: `Т${id}`
      });
      start = addDays(end, 1);
      id += 1;
    }
    return weeks;
  }

  function getDateRange(start, end) {
    const result = [];
    let cursor = start;
    let guard = 0;
    while (cursor <= end && guard < 40) {
      result.push(cursor);
      cursor = addDays(cursor, 1);
      guard += 1;
    }
    return result;
  }

  function shiftRange(range, days) {
    return { start: addDays(range.start, days), end: addDays(range.end, days) };
  }

  function rangeHasActivity(entries, range) {
    return entries.some(({ account }) => account.records.some((record) => (
      record.date >= range.start && record.date <= range.end && recordHasActivity(record)
    )));
  }

  function recordHasActivity(record) {
    return Math.abs(numeric(record.chats)) > 0 || Math.abs(numeric(record.numbers)) > 0 || Math.abs(numeric(record.comments)) > 0;
  }

  function renderComparison() {
    const active = getActiveEntries();
    const currentRange = getFocusRange();
    const previousRange = getPreviousRange(currentRange);
    const current = aggregateEntries(active, currentRange);
    const previous = aggregateEntries(active, previousRange);

    const currentConversion = current.chats ? current.numbers / current.chats * 100 : 0;
    const previousConversion = previous.chats ? previous.numbers / previous.chats * 100 : 0;

    dom.comparisonSubtitle.textContent = `${periodLabel(currentRange)} проти ${periodLabel(previousRange)}.`;

    const cards = [
      ["Номери", current.numbers, previous.numbers, buildDelta(current.numbers, previous.numbers), "number"],
      ["Чати", current.chats, previous.chats, buildDelta(current.chats, previous.chats), "number"],
      ["Коментарі", current.comments, previous.comments, buildDelta(current.comments, previous.comments), "number"],
      ["Конверсія", currentConversion, previousConversion, buildPointDelta(currentConversion, previousConversion), "percent"]
    ];

    dom.comparisonGrid.innerHTML = cards.map(([label, currentValue, previousValue, delta, type]) => `
      <article class="comparison-card">
        <div class="comparison-label">${escapeHtml(label)}</div>
        <div class="comparison-values">
          <strong class="comparison-current">${type === "percent" ? `${currentValue.toFixed(1)}%` : fmt.format(currentValue)}</strong>
          <span class="comparison-previous">було ${type === "percent" ? `${previousValue.toFixed(1)}%` : fmt.format(previousValue)}</span>
        </div>
        ${renderDeltaBadge(delta)}
      </article>
    `).join("");
  }

  function renderCharts() {
    const periods = getChartPeriods();
    const active = getActiveEntries();

    dom.numbersChartSubtitle.textContent = chartWindowDescription(periods);
    dom.chatsChartSubtitle.textContent = chartWindowDescription(periods);

    renderLineChart(dom.numbersChart, periods, active, "numbers");
    renderLineChart(dom.chatsChart, periods, active, "chats");
    renderLineChart(dom.commentsChart, periods, active, "comments");
    renderLineChart(dom.conversionChart, periods, active, "conversion");
  }

  function renderLineChart(container, periods, entries, metric) {
    const hasMetric = metric === "conversion"
      ? entries.some(({ account }) => account.metrics.chats && account.metrics.numbers)
      : entries.some(({ account }) => Boolean(account.metrics[metric]));

    if (!entries.length) {
      container.innerHTML = '<div class="chart-empty">Оберіть хоча б один акаунт.</div>';
      return;
    }

    if (!hasMetric) {
      container.innerHTML = '<div class="chart-empty">Для вибраних акаунтів ця метрика не ведеться.</div>';
      return;
    }

    const points = periods.map((period) => {
      const value = aggregateEntries(entries, period);
      let metricValue = value[metric];
      if (metric === "conversion") {
        metricValue = value.chats ? value.numbers / value.chats * 100 : 0;
      }
      return {
        ...period,
        value: numeric(metricValue)
      };
    });

    const width = Math.max(320, Math.floor(container.clientWidth || 620));
    const height = 300;
    const margin = {
      top: 24,
      right: 18,
      bottom: 48,
      left: width < 460 ? 42 : 50
    };
    const plotWidth = width - margin.left - margin.right;
    const plotHeight = height - margin.top - margin.bottom;
    const values = points.map((point) => point.value);
    const maxRaw = Math.max(...values, metric === "conversion" ? 10 : 1);
    const maxValue = niceMax(maxRaw, metric === "conversion");
    const minValue = 0;

    const xAt = (index) => points.length === 1
      ? margin.left + plotWidth / 2
      : margin.left + plotWidth * index / (points.length - 1);

    const yAt = (value) => {
      const ratio = (value - minValue) / Math.max(maxValue - minValue, 1);
      return margin.top + plotHeight * (1 - ratio);
    };

    const path = points.map((point, index) => {
      const command = index === 0 ? "M" : "L";
      return `${command}${xAt(index).toFixed(2)},${yAt(point.value).toFixed(2)}`;
    }).join(" ");

    const labelEvery = Math.max(1, Math.ceil(points.length / (width < 500 ? 4 : 7)));
    const color = metric === "comments" ? "#7c3aed" : metric === "chats" ? "#0891b2" : metric === "conversion" ? "#059669" : "#4f46e5";

    let svg = `
      <svg class="chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(metricLabel(metric))}">
        <rect x="0" y="0" width="${width}" height="${height}" rx="14" fill="#ffffff"></rect>
    `;

    for (let index = 0; index <= 4; index += 1) {
      const y = margin.top + plotHeight * index / 4;
      const value = maxValue * (1 - index / 4);
      svg += `
        <line x1="${margin.left}" x2="${width - margin.right}" y1="${y}" y2="${y}" stroke="#e8edf5" stroke-width="1"></line>
        <text x="${margin.left - 8}" y="${y + 4}" text-anchor="end" fill="#7b8495" font-size="10">${metric === "conversion" ? `${Math.round(value)}%` : fmt.format(Math.round(value))}</text>
      `;
    }

    points.forEach((point, index) => {
      if (index % labelEvery !== 0 && index !== points.length - 1) return;
      svg += `
        <text x="${xAt(index)}" y="${height - 18}" text-anchor="middle" fill="#7b8495" font-size="10">${escapeHtml(point.chartLabel)}</text>
      `;
    });

    svg += `
      <path d="${path}" fill="none" stroke="${color}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"></path>
    `;

    points.forEach((point, index) => {
      const isFocus = point.key === state.focusValue;
      const radius = isFocus ? 5 : 3.5;
      svg += `
        <circle cx="${xAt(index)}" cy="${yAt(point.value)}" r="${radius}" fill="#fff" stroke="${color}" stroke-width="${isFocus ? 3 : 2}">
          <title>${escapeHtml(point.label)}: ${metric === "conversion" ? `${point.value.toFixed(1)}%` : fmt.format(point.value)}</title>
        </circle>
      `;
    });

    svg += `</svg>`;
    container.innerHTML = svg;
  }

  function renderAccountsAnalytics() {
    const currentRange = getFocusRange();
    const previousRange = getPreviousRange(currentRange);

    let rows = getActiveEntries().map(({ manager, account }) => {
      const current = aggregateAccount(account, currentRange);
      const previous = aggregateAccount(account, previousRange);
      const conversion = current.chats ? current.numbers / current.chats * 100 : 0;
      const trend = account.metrics.numbers ? buildDelta(current.numbers, previous.numbers) : null;

      return {
        manager,
        account,
        current,
        previous,
        conversion,
        trend
      };
    });

    rows = sortAccountRows(rows, state.accountSort);

    if (!rows.length) {
      dom.accountsTableBody.innerHTML = '<tr><td colspan="6" class="metric-muted">Немає вибраних акаунтів.</td></tr>';
      dom.mobileAccountCards.innerHTML = '<div class="chart-empty">Немає вибраних акаунтів.</div>';
      return;
    }

    dom.accountsTableBody.innerHTML = rows.map((row) => {
      const { manager, account, current, previous, conversion, trend } = row;
      return `
        <tr>
          <td>
            <div class="account-name">
              <span class="account-dot" style="background:${account.color}"></span>
              <span>
                ${escapeHtml(account.name)}
                <small class="account-meta">${escapeHtml(manager.name)} · ${escapeHtml(account.platform)}</small>
              </span>
            </div>
          </td>
          <td>${account.metrics.chats ? fmt.format(current.chats) : '<span class="metric-muted">—</span>'}</td>
          <td><strong>${account.metrics.numbers ? fmt.format(current.numbers) : '<span class="metric-muted">—</span>'}</strong></td>
          <td>${account.metrics.chats && account.metrics.numbers ? `${conversion.toFixed(1)}%` : '<span class="metric-muted">—</span>'}</td>
          <td>${account.metrics.comments ? fmt.format(current.comments) : '<span class="metric-muted">—</span>'}</td>
          <td class="trend-cell">
            ${trend
              ? `${renderTrendBadge(trend)}<span class="trend-detail">${fmt.format(previous.numbers)} → ${fmt.format(current.numbers)}</span>`
              : '<span class="metric-muted">немає метрики лідів</span>'}
          </td>
        </tr>
      `;
    }).join("");

    dom.mobileAccountCards.innerHTML = rows.map((row) => {
      const { manager, account, current, previous, conversion, trend } = row;
      return `
        <article class="mobile-account-card">
          <div class="mobile-account-head">
            <div class="mobile-account-name">
              ${escapeHtml(account.name)}
              <small>${escapeHtml(manager.name)} · ${escapeHtml(account.platform)}</small>
            </div>
            ${trend ? renderTrendBadge(trend) : ""}
          </div>
          <div class="mobile-account-metrics">
            <div class="mobile-metric">
              <span>Номери</span>
              <strong>${account.metrics.numbers ? fmt.format(current.numbers) : "—"}</strong>
            </div>
            <div class="mobile-metric">
              <span>Чати</span>
              <strong>${account.metrics.chats ? fmt.format(current.chats) : "—"}</strong>
            </div>
            <div class="mobile-metric">
              <span>Коментарі</span>
              <strong>${account.metrics.comments ? fmt.format(current.comments) : "—"}</strong>
            </div>
          </div>
          <div class="mobile-trend">
            <span class="account-meta">CR: ${account.metrics.chats && account.metrics.numbers ? `${conversion.toFixed(1)}%` : "—"}</span>
            <span class="account-meta">${trend ? `ліди ${fmt.format(previous.numbers)} → ${fmt.format(current.numbers)}` : "тренд лідів недоступний"}</span>
          </div>
        </article>
      `;
    }).join("");
  }

  function sortAccountRows(rows, sort) {
    const copy = [...rows];

    copy.sort((a, b) => {
      if (sort === "trend-desc") return trendSortValue(b.trend) - trendSortValue(a.trend) || b.current.numbers - a.current.numbers;
      if (sort === "trend-asc") return trendSortValue(a.trend) - trendSortValue(b.trend) || a.current.numbers - b.current.numbers;
      if (sort === "chats-desc") return b.current.chats - a.current.chats || b.current.numbers - a.current.numbers;
      if (sort === "comments-desc") return b.current.comments - a.current.comments || b.current.numbers - a.current.numbers;
      if (sort === "name-asc") return a.account.name.localeCompare(b.account.name, "uk");
      return b.current.numbers - a.current.numbers || b.current.chats - a.current.chats;
    });

    return copy;
  }

  function trendSortValue(trend) {
    if (!trend) return -Infinity;
    if (trend.infinite && trend.status === "positive") return 100000;
    return Number.isFinite(trend.percent) ? trend.percent : 0;
  }

  function getEntriesForManagerScope() {
    if (!state.report) return [];
    const managers = state.managerId === "all"
      ? state.report.managers
      : state.report.managers.filter((manager) => manager.id === state.managerId);

    return managers.flatMap((manager) =>
      manager.accounts.map((account) => ({ manager, account }))
    );
  }

  function getVisibleFilterEntries() {
    return getEntriesForManagerScope().filter(({ manager, account }) => {
      if (state.platform !== "Усі" && account.platform !== state.platform) return false;
      if (!state.accountSearch) return true;
      const haystack = `${account.name} ${account.sheetName || ""} ${account.platform} ${manager.name}`.toLocaleLowerCase();
      return haystack.includes(state.accountSearch);
    });
  }

  function getActiveEntries() {
    return getEntriesForManagerScope().filter(({ account }) => {
      if (state.platform !== "Усі" && account.platform !== state.platform) return false;
      return state.selectedAccounts.has(account.id);
    });
  }

  function selectAllInManagerScope() {
    state.selectedAccounts = new Set(getEntriesForManagerScope().map(({ account }) => account.id));
  }

  function getAvailablePlatforms() {
    const unique = [...new Set(getEntriesForManagerScope().map(({ account }) => account.platform).filter(Boolean))];
    return unique.sort((a, b) => platformRank(a) - platformRank(b) || a.localeCompare(b, "uk"));
  }

  function ensurePlatformValid() {
    if (state.platform === "Усі") return;
    if (!getAvailablePlatforms().includes(state.platform)) state.platform = "Усі";
  }

  function platformRank(platform) {
    const index = PLATFORM_ORDER.indexOf(platform);
    return index === -1 ? PLATFORM_ORDER.length : index;
  }

  function getDateBounds(entries = null) {
    const source = entries || getEntriesForManagerScope();
    const activityDates = source.flatMap(({ account }) => account.records
      .filter(recordHasActivity)
      .map((record) => record.date));

    const dates = activityDates.length
      ? activityDates
      : source.flatMap(({ account }) => account.records.map((record) => record.date));

    if (!dates.length) return null;
    dates.sort();
    return { min: dates[0], max: dates[dates.length - 1] };
  }

  function resetFocusToLatest({ keepIfValid = false } = {}) {
    const bounds = getDateBounds();
    if (!bounds) {
      state.focusValue = null;
      return;
    }

    if (keepIfValid && state.focusValue && isFocusWithinBounds(state.focusValue, bounds)) {
      return;
    }

    if (state.granularity === "day") state.focusValue = bounds.max;
    else if (state.granularity === "week") state.focusValue = startOfWeek(bounds.max);
    else state.focusValue = bounds.max.slice(0, 7);
  }

  function ensureFocusValid() {
    const bounds = getDateBounds();
    if (!bounds) {
      state.focusValue = null;
      return;
    }

    if (!state.focusValue || !isFocusWithinBounds(state.focusValue, bounds)) {
      resetFocusToLatest();
    }
  }

  function movePeriod(direction) {
    const bounds = getDateBounds();
    if (!bounds || !state.focusValue) return;
    const next = adjacentFocusValue(direction);
    if (!isFocusWithinBounds(next, bounds)) return;
    state.focusValue = next;
    renderAll();
  }

  function adjacentFocusValue(direction) {
    if (!state.focusValue) return null;
    if (state.granularity === "day") return addDays(state.focusValue, direction);
    if (state.granularity === "week") return addDays(state.focusValue, direction * 7);
    return addMonths(state.focusValue, direction);
  }

  function isFocusWithinBounds(value, bounds) {
    if (!value || !bounds) return false;

    if (state.granularity === "day") {
      return value >= bounds.min && value <= bounds.max;
    }

    if (state.granularity === "week") {
      const start = value;
      const end = addDays(start, 6);
      return end >= bounds.min && start <= bounds.max;
    }

    const range = monthRange(value);
    return range.end >= bounds.min && range.start <= bounds.max;
  }

  function getWeekOptions(bounds) {
    let cursor = startOfWeek(bounds.min);
    const last = startOfWeek(bounds.max);
    const result = [];
    let guard = 0;

    while (cursor <= last && guard < 520) {
      const end = addDays(cursor, 6);
      result.push({
        value: cursor,
        label: `${shortDateFmt.format(parseIsoDate(cursor))} – ${shortDateFmt.format(parseIsoDate(end))}`
      });
      cursor = addDays(cursor, 7);
      guard += 1;
    }

    return result;
  }

  function getMonthOptions(bounds) {
    const result = [];
    let cursor = bounds.min.slice(0, 7);
    const last = bounds.max.slice(0, 7);
    let guard = 0;

    while (cursor <= last && guard < 120) {
      result.push({
        value: cursor,
        label: capitalize(monthFmt.format(parseIsoDate(`${cursor}-01`)))
      });
      cursor = addMonths(cursor, 1);
      guard += 1;
    }

    return result;
  }

  function getFocusRange() {
    if (!state.focusValue) return { start: "1970-01-01", end: "1970-01-01", key: "", label: "Немає даних" };

    if (state.granularity === "day") {
      return {
        start: state.focusValue,
        end: state.focusValue,
        key: state.focusValue,
        label: dateFmt.format(parseIsoDate(state.focusValue)),
        chartLabel: shortDateFmt.format(parseIsoDate(state.focusValue))
      };
    }

    if (state.granularity === "week") {
      const end = addDays(state.focusValue, 6);
      return {
        start: state.focusValue,
        end,
        key: state.focusValue,
        label: `${dateFmt.format(parseIsoDate(state.focusValue))} – ${dateFmt.format(parseIsoDate(end))}`,
        chartLabel: shortDateFmt.format(parseIsoDate(state.focusValue))
      };
    }

    const range = monthRange(state.focusValue);
    return {
      ...range,
      key: state.focusValue,
      label: capitalize(monthFmt.format(parseIsoDate(`${state.focusValue}-01`))),
      chartLabel: shortMonthFmt.format(parseIsoDate(`${state.focusValue}-01`))
    };
  }

  function getPreviousRange(currentRange) {
    if (state.granularity === "day") {
      const date = addDays(currentRange.start, -1);
      return {
        start: date,
        end: date,
        key: date,
        label: dateFmt.format(parseIsoDate(date)),
        chartLabel: shortDateFmt.format(parseIsoDate(date))
      };
    }

    if (state.granularity === "week") {
      const start = addDays(currentRange.start, -7);
      const end = addDays(start, 6);
      return {
        start,
        end,
        key: start,
        label: `${dateFmt.format(parseIsoDate(start))} – ${dateFmt.format(parseIsoDate(end))}`,
        chartLabel: shortDateFmt.format(parseIsoDate(start))
      };
    }

    const month = addMonths(currentRange.start.slice(0, 7), -1);
    const range = monthRange(month);
    return {
      ...range,
      key: month,
      label: capitalize(monthFmt.format(parseIsoDate(`${month}-01`))),
      chartLabel: shortMonthFmt.format(parseIsoDate(`${month}-01`))
    };
  }

  function getChartPeriods() {
    const current = getFocusRange();

    if (state.granularity === "month") {
      return getMonthWeeks(state.focusValue);
    }

    if (state.granularity === "week") {
      return getDateRange(current.start, current.end).map((date) => ({
        start: date,
        end: date,
        key: date,
        label: dateFmt.format(parseIsoDate(date)),
        chartLabel: shortDateFmt.format(parseIsoDate(date))
      }));
    }

    const periods = [];
    for (let offset = 13; offset >= 0; offset -= 1) {
      const date = addDays(current.start, -offset);
      periods.push({
        start: date,
        end: date,
        key: date,
        label: dateFmt.format(parseIsoDate(date)),
        chartLabel: shortDateFmt.format(parseIsoDate(date))
      });
    }
    return periods;
  }

  function aggregateEntries(entries, range) {
    return entries.reduce((total, { account }) => {
      const item = aggregateAccount(account, range);
      total.chats += item.chats;
      total.numbers += item.numbers;
      total.comments += item.comments;
      return total;
    }, { chats: 0, numbers: 0, comments: 0 });
  }

  function aggregateAccount(account, range) {
    return account.records.reduce((total, record) => {
      if (record.date < range.start || record.date > range.end) return total;
      total.chats += numeric(record.chats);
      total.numbers += numeric(record.numbers);
      total.comments += numeric(record.comments);
      return total;
    }, { chats: 0, numbers: 0, comments: 0 });
  }

  function buildDelta(current, previous) {
    if (previous === 0) {
      if (current === 0) return { status: "neutral", percent: 0, text: "0%", infinite: false };
      return { status: "positive", percent: Infinity, text: `+${fmt.format(current)} з нуля`, infinite: true };
    }

    const percent = (current - previous) / Math.abs(previous) * 100;
    const status = percent > 5 ? "positive" : percent < -5 ? "negative" : "neutral";
    const arrow = status === "positive" ? "↑" : status === "negative" ? "↓" : "→";
    const sign = percent > 0 ? "+" : "";
    return {
      status,
      percent,
      text: `${arrow} ${sign}${percent.toFixed(1)}%`,
      infinite: false
    };
  }

  function buildPointDelta(current, previous) {
    const difference = current - previous;
    const status = difference > 1 ? "positive" : difference < -1 ? "negative" : "neutral";
    const arrow = status === "positive" ? "↑" : status === "negative" ? "↓" : "→";
    const sign = difference > 0 ? "+" : "";
    return {
      status,
      percent: difference,
      text: `${arrow} ${sign}${difference.toFixed(1)} п.п.`,
      infinite: false
    };
  }

  function renderDeltaBadge(delta) {
    return `<span class="delta ${delta.status}">${escapeHtml(delta.text)}</span>`;
  }

  function renderTrendBadge(delta) {
    const label = delta.status === "positive" ? "Росте" : delta.status === "negative" ? "Просідає" : "Стабільно";
    return `<span class="trend-badge ${delta.status}">${escapeHtml(delta.text)} · ${label}</span>`;
  }

  function chartWindowDescription(periods) {
    if (!periods.length) return "Немає даних";
    return `${periods[0].label} → ${periods[periods.length - 1].label}`;
  }

  function periodLabel(range) {
    return range.label || `${range.start} – ${range.end}`;
  }

  function metricLabel(metric) {
    if (metric === "numbers") return "Отримані номери";
    if (metric === "chats") return "Чати";
    if (metric === "comments") return "Оброблені коментарі";
    return "Конверсія";
  }

  function monthRange(month) {
    const [year, monthNumber] = month.split("-").map(Number);
    const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
    return {
      start: `${year}-${pad(monthNumber)}-01`,
      end: `${year}-${pad(monthNumber)}-${pad(lastDay)}`
    };
  }

  function startOfWeek(isoDate) {
    const date = parseIsoDate(isoDate);
    const day = date.getDay();
    const diff = day === 0 ? -6 : 1 - day;
    date.setDate(date.getDate() + diff);
    return toIso(date);
  }

  function addDays(isoDate, amount) {
    const date = parseIsoDate(isoDate);
    date.setDate(date.getDate() + amount);
    return toIso(date);
  }

  function addMonths(monthOrIso, amount) {
    const month = monthOrIso.slice(0, 7);
    const [year, monthNumber] = month.split("-").map(Number);
    const date = new Date(Date.UTC(year, monthNumber - 1 + amount, 1));
    return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}`;
  }

  function parseIsoDate(value) {
    const [year, month, day] = value.split("-").map(Number);
    return new Date(year, month - 1, day);
  }

  function toIso(date) {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  function isIsoDate(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
  }

  function niceMax(value, isPercent = false) {
    if (isPercent) {
      if (value <= 10) return 10;
      return Math.ceil(value / 10) * 10;
    }
    if (value <= 5) return 5;
    const magnitude = 10 ** Math.floor(Math.log10(value));
    const normalized = value / magnitude;
    let nice;
    if (normalized <= 1) nice = 1;
    else if (normalized <= 2) nice = 2;
    else if (normalized <= 5) nice = 5;
    else nice = 10;
    return nice * magnitude;
  }

  function numeric(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  }

  function showLoading() {
    dom.kpiGrid.innerHTML = Array.from({ length: 5 }, () => '<article class="kpi panel loading-shell"></article>').join("");
    dom.comparisonGrid.innerHTML = Array.from({ length: 4 }, () => '<article class="comparison-card loading-shell"></article>').join("");
  }

  function setSyncStatus(type, text) {
    dom.syncStatus.className = `sync-status ${type === "ok" ? "ok" : type === "error" ? "error" : ""}`;
    dom.syncStatus.innerHTML = `<span class="sync-dot"></span><span>${escapeHtml(text)}</span>`;
  }

  function showNotice(message, isError = false, alreadyHtml = false) {
    dom.dataNotice.className = `notice visible${isError ? " error" : ""}`;
    dom.dataNotice.innerHTML = alreadyHtml
      ? `<span>ⓘ</span><span>${message}</span>`
      : `<span>${isError ? "⚠" : "ⓘ"}</span><span>${escapeHtml(message)}</span>`;
  }

  function showFatalError(message) {
    showNotice(message, true);
    const empty = `<div class="chart-empty">${escapeHtml(message)}</div>`;
    dom.kpiGrid.innerHTML = empty;
    dom.comparisonGrid.innerHTML = empty;
    dom.numbersChart.innerHTML = empty;
    dom.chatsChart.innerHTML = empty;
    dom.commentsChart.innerHTML = empty;
    dom.conversionChart.innerHTML = empty;
    dom.accountsTableBody.innerHTML = `<tr><td colspan="6">${escapeHtml(message)}</td></tr>`;
    dom.mobileAccountCards.innerHTML = empty;
  }

  function formatGeneratedAt(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "щойно";
    return new Intl.DateTimeFormat("uk-UA", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    }).format(date);
  }

  function capitalize(value) {
    return value ? value.charAt(0).toLocaleUpperCase() + value.slice(1) : value;
  }

  function plural(number, one, few, many) {
    const absolute = Math.abs(number) % 100;
    const last = absolute % 10;
    if (absolute > 10 && absolute < 20) return many;
    if (last > 1 && last < 5) return few;
    if (last === 1) return one;
    return many;
  }

  function pad(value) {
    return String(value).padStart(2, "0");
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function debounce(callback, wait) {
    let timeout;
    return (...args) => {
      window.clearTimeout(timeout);
      timeout = window.setTimeout(() => callback(...args), wait);
    };
  }
})();
