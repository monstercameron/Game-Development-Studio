// Model weight capacity section. The figures come from model-capacity.json, which
// tools/model-capacity.mjs writes. The same view code builds the static markup that the script
// stores in index.html (the no-JavaScript fallback) and the interactive markup shown in the
// browser, so the two cannot drift apart. Nothing here is measured in the browser.
(() => {
  const BYTES_PER_GIB = 1024 ** 3;
  const BYTES_PER_GB = 1000 ** 3;
  const BYTES_PER_MIB = 1024 ** 2;
  const twoDecimals = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const oneDecimal = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  const wholeNumber = new Intl.NumberFormat('en-US');

  const KIND_LABELS = {
    weights: 'Model weights',
    supporting: 'Supporting checkpoint',
    cache: 'Cache',
  };

  // Columns of the table. `type` decides the first sort direction: text ascending, size descending.
  const COLUMNS = [
    { key: 'name', label: 'Model', type: 'text' },
    { key: 'area', label: 'Area', type: 'text' },
    { key: 'bytes', label: 'Size on disk (GiB)', type: 'number' },
    { key: 'share', label: 'Share of total', type: 'number' },
    { key: 'kind', label: 'Kind', type: 'text' },
  ];
  const DEFAULT_SORT = { key: 'bytes', direction: 'descending' };

  const escapeHtml = (value) =>
    String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;');

  const formatGiB = (bytes) => twoDecimals.format(bytes / BYTES_PER_GIB);
  const formatGB = (bytes) => twoDecimals.format(bytes / BYTES_PER_GB);

  // Rows under 0.05% would round to "0.0%", which reads as empty, so they say "<0.1%".
  const formatShare = (fraction, bytes) => {
    if (bytes === 0) {
      return '0.0%';
    }
    const percent = fraction * 100;
    return percent < 0.05 ? '<0.1%' : `${oneDecimal.format(percent)}%`;
  };

  const isNonNegativeInteger = (value) => Number.isSafeInteger(value) && value >= 0;

  // Guards the browser against a truncated or foreign file; the build script checks far more.
  const isUsableData = (data) =>
    Boolean(data) &&
    Array.isArray(data.rows) &&
    data.rows.length > 0 &&
    typeof data.generatedAt === 'string' &&
    Boolean(data.machine) &&
    typeof data.machine.gpuName === 'string' &&
    isNonNegativeInteger(data.machine.gpuMemoryMiB) &&
    data.machine.gpuMemoryMiB > 0 &&
    Array.isArray(data.method) &&
    data.rows.every(
      (row) =>
        row &&
        typeof row.name === 'string' &&
        typeof row.area === 'string' &&
        typeof row.card === 'string' &&
        Object.hasOwn(KIND_LABELS, row.kind) &&
        isNonNegativeInteger(row.bytes),
    ) &&
    data.rows.reduce((sum, row) => sum + row.bytes, 0) > 0;

  // Everything shown is derived from the rows' byte counts and the GPU memory size.
  const summarize = (data) => {
    const rows = data.rows.map((row) => ({ ...row }));
    const totalBytes = rows.reduce((sum, row) => sum + row.bytes, 0);
    for (const row of rows) {
      row.fraction = row.bytes / totalBytes;
    }
    const modelRows = rows.filter((row) => row.kind === 'weights');
    const otherRows = rows.filter((row) => row.kind !== 'weights' && row.bytes > 0);
    const modelBytes = modelRows.reduce((sum, row) => sum + row.bytes, 0);
    const otherBytes = otherRows.reduce((sum, row) => sum + row.bytes, 0);
    const withWeights = modelRows.filter((row) => row.bytes > 0);
    const withoutWeights = modelRows.filter((row) => row.bytes === 0);
    const largest = withWeights.reduce(
      (best, row) => (best === null || row.bytes > best.bytes ? row : best),
      null,
    );
    const gpuMemoryBytes = data.machine.gpuMemoryMiB * BYTES_PER_MIB;
    return {
      rows,
      totalBytes,
      modelRows,
      modelBytes,
      otherRows,
      otherBytes,
      withWeights,
      withoutWeights,
      largest,
      gpuMemoryBytes,
      weightsToGpuRatio: modelBytes / gpuMemoryBytes,
    };
  };

  const gpuMemoryText = (data) => `${wholeNumber.format(data.machine.gpuMemoryMiB / 1024)} GiB`;

  const compareText = (data, summary) => {
    const ratio = oneDecimal.format(summary.weightsToGpuRatio);
    return (
      `The model weights alone (${formatGiB(summary.modelBytes)} GiB) are about ${ratio} times ` +
      `the ${gpuMemoryText(data)} of GPU memory, which is why Forge loads one model at a time. ` +
      'This compares file sizes on disk with memory capacity: it does not say how much GPU ' +
      'memory a loaded model uses, and Forge does not record loaded sizes here.'
    );
  };

  const tilesFor = (data, summary) => {
    const noWeightsNames = summary.withoutWeights.map((row) => row.name).join(', ');
    const modelsDetail =
      `${summary.withWeights.length} with weights on disk` +
      (noWeightsNames ? `; ${noWeightsNames} has none` : '');
    const largest = summary.largest;
    return [
      {
        label: 'Models counted',
        value: String(summary.modelRows.length),
        detail: modelsDetail,
      },
      {
        label: 'Total on disk',
        value: `${formatGiB(summary.totalBytes)} GiB`,
        detail: `${formatGB(summary.totalBytes)} GB in ${summary.rows.length} entries`,
      },
      {
        label: 'Model weights',
        value: `${formatGiB(summary.modelBytes)} GiB`,
        detail: `${formatGiB(summary.otherBytes)} GiB more in supporting checkpoints and caches`,
      },
      {
        label: 'Largest model',
        value: largest ? largest.name : 'None',
        detail: largest
          ? `${formatGiB(largest.bytes)} GiB, ${formatShare(largest.fraction, largest.bytes)} ` +
            'of the total'
          : 'No model has weights on disk',
      },
      {
        label: 'Weights vs GPU memory',
        value: `${oneDecimal.format(summary.weightsToGpuRatio)}×`,
        detail: `model weights on disk ÷ ${gpuMemoryText(data)} of GPU memory`,
      },
    ];
  };

  // An unknown sort key falls back to the size column (COLUMNS[2]). Share is a fixed fraction of
  // the total, so it sorts by bytes.
  const sortRows = (rows, sort) => {
    const column = COLUMNS.find((item) => item.key === sort.key) || COLUMNS[2];
    const factor = sort.direction === 'ascending' ? 1 : -1;
    const keyOf = (row) => (column.key === 'share' ? row.bytes : row[column.key]);
    return [...rows].sort((a, b) => {
      const left = keyOf(a);
      const right = keyOf(b);
      let result;
      if (column.type === 'number') {
        result = left - right;
      } else {
        result = String(left).localeCompare(String(right), 'en');
      }
      if (result !== 0) {
        return result * factor;
      }
      return a.name.localeCompare(b.name, 'en');
    });
  };

  const rowMarkup = (row) => {
    const share = formatShare(row.fraction, row.bytes);
    const percent = row.fraction * 100;
    // An empty row gets an empty bar rather than the 2 px minimum fill.
    const fill = row.bytes === 0 ? '' : `<span style="width:${percent.toFixed(2)}%"></span>`;
    const note = row.note ? `<span class="cap-row-note">${escapeHtml(row.note)}</span>` : '';
    return (
      '<tr>' +
      `<th scope="row"><a href="#${escapeHtml(row.card)}">${escapeHtml(row.name)}</a>${note}</th>` +
      `<td>${escapeHtml(row.area)}</td>` +
      `<td class="cap-num">${formatGiB(row.bytes)}</td>` +
      '<td class="cap-share">' +
      `<span class="cap-bar" aria-hidden="true">${fill}</span>` +
      `<span class="cap-share-text">${share}</span></td>` +
      `<td>${escapeHtml(KIND_LABELS[row.kind])}</td>` +
      '</tr>'
    );
  };

  const bodyMarkup = (summary, sort) =>
    sortRows(summary.rows, sort)
      .map((row) => `\n          ${rowMarkup(row)}`)
      .join('');

  const headerCell = (column, sort, isInteractive) => {
    const isSorted = column.key === sort.key;
    const direction = isSorted ? sort.direction : 'none';
    const label = escapeHtml(column.label);
    const content = isInteractive
      ? `<button type="button" class="cap-sort" data-sort="${column.key}">${label}` +
        '<span class="cap-sort-icon" aria-hidden="true"></span></button>'
      : label;
    const attributes = isInteractive ? ` aria-sort="${direction}"` : '';
    return `<th scope="col"${attributes}>${content}</th>`;
  };

  const footMarkup = (summary) =>
    '<tr>' +
    `<th scope="row">Total (${summary.rows.length} entries)</th>` +
    '<td></td>' +
    `<td class="cap-num">${formatGiB(summary.totalBytes)}</td>` +
    '<td class="cap-share"><span class="cap-share-text">100.0%</span></td>' +
    `<td>${formatGB(summary.totalBytes)} GB</td>` +
    '</tr>';

  const measuredDate = (data) => data.generatedAt.slice(0, 10);
  const shortGpuName = (data) => data.machine.gpuName.replace(/\s*\(.*\)\s*$/, '');

  const methodMarkup = (data) =>
    '<details class="cap-method">\n' +
    '        <summary>How this was measured</summary>\n' +
    data.method.map((paragraph) => `        <p>${escapeHtml(paragraph)}</p>\n`).join('') +
    '      </details>';

  /**
   * Builds the capacity section markup. With isInteractive false it is the no-JavaScript fallback
   * that tools/model-capacity.mjs writes into index.html; with true it adds the sort buttons and
   * the status region used in the browser. Callers must check data with isUsableData first.
   * @param {object} data Parsed model-capacity.json.
   * @param {{ sort?: { key: string, direction: string }, isInteractive?: boolean }} [options]
   * @returns {string} HTML for the section, without the wrapping element.
   */
  const sectionMarkup = (data, { sort = DEFAULT_SORT, isInteractive = false } = {}) => {
    const summary = summarize(data);
    const tiles = tilesFor(data, summary)
      .map(
        (tile) =>
          '\n        <li>' +
          `<span class="cap-tile-label">${escapeHtml(tile.label)}</span>` +
          `<strong class="cap-tile-value">${escapeHtml(tile.value)}</strong>` +
          `<span class="cap-tile-detail">${escapeHtml(tile.detail)}</span></li>`,
      )
      .join('');
    const headers = COLUMNS.map((column) => headerCell(column, sort, isInteractive)).join('');
    const gpu = escapeHtml(shortGpuName(data));
    const date = escapeHtml(measuredDate(data));
    const status = isInteractive
      ? '\n      <p class="sr-only" role="status" aria-live="polite" data-capacity-status></p>'
      : '';
    return (
      `<p class="cap-scope">Measured ${date}: the model weights and supporting files installed ` +
      `on the reference machine, an ${gpu} with ${gpuMemoryText(data)} of GPU memory, summed ` +
      'from the files in Forge’s models folder. This counts files and bytes. It is not a ' +
      'benchmark, a parameter count or a loaded-memory figure.</p>\n' +
      `      <ul class="cap-tiles" aria-label="Capacity totals">${tiles}\n      </ul>\n` +
      `      <p class="cap-compare">${escapeHtml(compareText(data, summary))}</p>\n` +
      `      <p class="cap-caption" id="capacity-caption">Size on disk of each model and its ` +
      `supporting files, measured ${date}</p>\n` +
      '      <div class="cap-scroll" role="region" aria-labelledby="capacity-caption" ' +
      'tabindex="0">\n' +
      '        <table class="cap-table" aria-labelledby="capacity-caption">\n' +
      `          <thead><tr>${headers}</tr></thead>\n` +
      `          <tbody>${bodyMarkup(summary, sort)}\n          </tbody>\n` +
      `          <tfoot>${footMarkup(summary)}</tfoot>\n` +
      '        </table>\n' +
      '      </div>\n' +
      `      <p class="cap-note">Measured ${date} on ${gpu}; sizes are on-disk bytes, not ` +
      'parameter counts. GiB = 1,024³ bytes; GB = 1,000³ bytes. Each row is rounded on its own, ' +
      'so the rows can differ from the total by a few hundredths of a GiB.</p>\n' +
      `      ${methodMarkup(data)}${status}`
    );
  };

  const api = {
    COLUMNS,
    DEFAULT_SORT,
    KIND_LABELS,
    isUsableData,
    summarize,
    tilesFor,
    compareText,
    sortRows,
    sectionMarkup,
    formatGiB,
    formatGB,
    formatShare,
  };
  globalThis.ForgeCapacity = api;

  // ---- Browser behaviour: runs only on the page ----
  if (typeof document === 'undefined') {
    return;
  }

  const mount = async (root, fetchJson) => {
    let data;
    try {
      data = await fetchJson(root.dataset.capacitySrc || 'model-capacity.json');
    } catch {
      // The pre-rendered table stays as the fallback; nothing else to do.
      root.dataset.capacityState = 'static';
      return;
    }
    if (!isUsableData(data)) {
      root.dataset.capacityState = 'static';
      return;
    }

    let sort = { ...DEFAULT_SORT };
    root.innerHTML = sectionMarkup(data, { sort, isInteractive: true });
    root.dataset.capacityState = 'interactive';

    const summary = summarize(data);
    const table = root.querySelector('table');
    const tbody = table.querySelector('tbody');
    const status = root.querySelector('[data-capacity-status]');
    const headers = [...table.querySelectorAll('thead th')];

    const applySort = () => {
      tbody.innerHTML = bodyMarkup(summary, sort);
      headers.forEach((header, index) => {
        const isSorted = COLUMNS[index].key === sort.key;
        header.setAttribute('aria-sort', isSorted ? sort.direction : 'none');
      });
    };

    table.querySelector('thead').addEventListener('click', (event) => {
      const button = event.target.closest('button[data-sort]');
      if (!button) {
        return;
      }
      const column = COLUMNS.find((item) => item.key === button.dataset.sort);
      if (sort.key === column.key) {
        sort = {
          key: column.key,
          direction: sort.direction === 'ascending' ? 'descending' : 'ascending',
        };
      } else {
        sort = {
          key: column.key,
          direction: column.type === 'number' ? 'descending' : 'ascending',
        };
      }
      applySort();
      status.textContent = `Sorted by ${column.label}, ${sort.direction}.`;
    });
  };

  const fetchJson = async (url) => {
    const response = await fetch(url, { cache: 'no-cache' });
    if (!response.ok) {
      throw new Error(`Capacity data request failed with status ${response.status}.`);
    }
    return response.json();
  };

  const start = () => {
    const root = document.getElementById('capacity-root');
    api.ready = root ? mount(root, fetchJson) : Promise.resolve();
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
